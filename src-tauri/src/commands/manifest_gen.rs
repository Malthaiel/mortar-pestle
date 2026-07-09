//! Per-vault manifest generator.
//!
//! Walks a vault's `*.md` files and writes a `{path,title,aliases,mtime}`
//! manifest that `render::manifest` consumes — the app's built-in replacement
//! for Citadel's Python-built manifest, so wikilink/graph resolution works on
//! arbitrary Obsidian vaults. Exclusions mirror
//! `Infrastructure/Scripts/manifest_rebuild.py` (dot-path components, `Raw/`,
//! OCR `*.{png,jpg,jpeg,webp}.md` sidecars). The reader only reads those four
//! fields, so the richer body-graph fields the Python builder emits are not
//! reproduced here.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use walkdir::WalkDir;

use crate::commands::vault::{atomic_write, VaultError};

#[derive(Serialize)]
struct GenEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime: Option<String>,
}

#[derive(Serialize)]
struct ManifestOut {
    schema_version: u32,
    vault_file_count: usize,
    /// Max file mtime (ms since epoch) across all indexed entries — the
    /// on-disk freshness key. `manifest_is_fresh` compares this + the count
    /// against a metadata-only re-walk to skip a no-op regen on boot.
    max_mtime_ms: f64,
    entries: Vec<GenEntry>,
}

/// Walk `vault_path`, build the manifest, write it atomically to `out_path`.
/// Returns the number of indexed entries.
pub fn generate_for(vault_path: &str, out_path: &Path) -> Result<usize, VaultError> {
    let root = fs::canonicalize(vault_path)
        .map_err(|e| VaultError::Io(format!("canonicalize {vault_path}: {e}")))?;

    let mut entries: Vec<GenEntry> = Vec::new();
    let mut max_mtime = 0.0_f64;
    for (rel, dirent) in md_files(&root) {
        // Read only the frontmatter head (8KB) — `parse_title_aliases` uses
        // just the leading `---`…`---` block, never the body.
        let content = crate::parsers::frontmatter_cache::read_head(dirent.path()).unwrap_or_default();
        let name = dirent.file_name().to_str().unwrap_or("");
        let stem = name.strip_suffix(".md").unwrap_or(name);
        let (title, aliases) = parse_title_aliases(&content, stem);
        let meta = dirent.metadata().ok();
        let mtime = meta.as_ref().and_then(mtime_iso);
        if let Some(mm) = meta.as_ref().and_then(mtime_ms) {
            if mm > max_mtime {
                max_mtime = mm;
            }
        }
        entries.push(GenEntry { path: rel, title, aliases, mtime });
    }

    let count = entries.len();
    let out = ManifestOut { schema_version: 2, vault_file_count: count, max_mtime_ms: max_mtime, entries };
    let text = serde_json::to_string(&out)
        .map_err(|e| VaultError::Io(format!("serialize manifest: {e}")))?;
    atomic_write(out_path, text.as_bytes())?;
    Ok(count)
}

/// Iterator over a vault's indexable `*.md` files (post-exclusion), yielding
/// `(relative_path, DirEntry)`. Shared by `generate_for` and `manifest_is_fresh`
/// so both apply identical exclusion rules.
fn md_files(root: &Path) -> impl Iterator<Item = (String, walkdir::DirEntry)> + '_ {
    // Prune traversal into hidden dirs (.obsidian/.git/.trash) and Raw/ for
    // speed; the per-file `is_excluded` still guards hidden files + OCR sidecars.
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() > 0 && e.file_type().is_dir() {
                let n = e.file_name().to_str().unwrap_or("");
                if n.starts_with('.') || n == "Raw" {
                    return false;
                }
            }
            true
        })
        .filter_map(|e| e.ok())
        .filter_map(move |dirent| {
            if !dirent.file_type().is_file() {
                return None;
            }
            let name = dirent.file_name().to_str()?;
            if !name.ends_with(".md") {
                return None;
            }
            let rel = dirent
                .path()
                .strip_prefix(root)
                .ok()
                .and_then(|r| r.to_str())?
                .replace('\\', "/");
            if is_excluded(&rel, name) {
                return None;
            }
            Some((rel, dirent))
        })
}

/// True iff the manifest at `out_path` already reflects the current vault
/// contents — a metadata-only walk (no file bodies read) whose (count, max
/// mtime) matches the manifest's stored `vault_file_count` + `max_mtime_ms`.
/// Any structural change (add/delete → count) or edit (→ max mtime) misses.
/// False when the manifest is absent or written by a pre-`max_mtime_ms` build.
pub fn manifest_is_fresh(vault_path: &str, out_path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(out_path) else { return false; };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else { return false; };
    let (Some(stored_count), Some(stored_max)) = (
        doc.get("vault_file_count").and_then(|v| v.as_u64()),
        doc.get("max_mtime_ms").and_then(|v| v.as_f64()),
    ) else { return false; };

    let Ok(root) = fs::canonicalize(vault_path) else { return false; };
    let mut count: u64 = 0;
    let mut max_mtime = 0.0_f64;
    for (_rel, dirent) in md_files(&root) {
        count += 1;
        if let Some(mm) = dirent.metadata().ok().as_ref().and_then(mtime_ms) {
            if mm > max_mtime {
                max_mtime = mm;
            }
        }
    }
    count == stored_count && (max_mtime - stored_max).abs() < 0.5
}

fn is_excluded(rel: &str, file_name: &str) -> bool {
    if rel.split('/').any(|p| p.starts_with('.')) {
        return true;
    }
    if rel.split('/').any(|p| p == "Raw") {
        return true;
    }
    let lower = file_name.to_ascii_lowercase();
    [".png.md", ".jpg.md", ".jpeg.md", ".webp.md"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn mtime_iso(meta: &fs::Metadata) -> Option<String> {
    use chrono::{TimeZone, Utc};
    let dur = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Utc.timestamp_opt(dur.as_secs() as i64, dur.subsec_nanos())
        .single()
        .map(|dt| dt.to_rfc3339())
}

fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
    let dur = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(dur.as_secs_f64() * 1000.0)
}

/// Extract `title` + `aliases` from YAML frontmatter. Title falls back to the
/// file stem. Aliases accept a YAML list or a single string.
fn parse_title_aliases(content: &str, stem: &str) -> (Option<String>, Vec<String>) {
    let mut title: Option<String> = None;
    let mut aliases: Vec<String> = Vec::new();
    if let Some(fm) = extract_frontmatter(content) {
        if let Ok(map) = serde_yml::from_str::<HashMap<String, serde_yml::Value>>(fm) {
            // Case-insensitive keys: Citadel uses `Aliases`, native Obsidian
            // uses `aliases`. Accept both (plus `alias`/`Title`).
            for (k, v) in &map {
                match k.to_ascii_lowercase().as_str() {
                    "title" => {
                        if let Some(t) = v.as_str() {
                            if !t.is_empty() {
                                title = Some(t.to_string());
                            }
                        }
                    }
                    "aliases" | "alias" => aliases = yaml_strings(v),
                    _ => {}
                }
            }
        }
    }
    if title.is_none() {
        title = Some(stem.to_string());
    }
    (title, aliases)
}

fn extract_frontmatter(content: &str) -> Option<&str> {
    if !content.starts_with("---") {
        return None;
    }
    let rest = &content[3..];
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn yaml_strings(v: &serde_yml::Value) -> Vec<String> {
    match v {
        serde_yml::Value::String(s) if !s.is_empty() => vec![s.clone()],
        serde_yml::Value::Sequence(seq) => seq
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

// ── Targeted content-manifest patches (in-session freshness) ────────────────
//
// The CONTENT vault's `Infrastructure/.cache/vault_manifest.json` is built by
// Citadel's Python `manifest_rebuild.py` (SessionStart hook) and carries rich
// graph fields (type, domain, headings, outbound_links, …) that vault tooling
// depends on — the app must NEVER regenerate that file wholesale. But an
// in-app markdown write/delete/rename would otherwise leave it stale all
// session (manifest-derived UI: stats, backlink resolution). These helpers
// patch only the affected entries in place, preserving every field they don't
// own (path/title/aliases/mtime are app-maintained; a new file's entry
// carries just those until the next full rebuild fills the rest). Best-effort
// by design: every failure logs and returns — the next rebuild reconciles.
// The vault watcher sees the JSON change and emits `manifest`, which live
// consumers (web/src/lib/manifestReader.js and friends) re-fetch on.

fn content_manifest_file() -> std::path::PathBuf {
    Path::new(&crate::commands::vault::vault_root())
        .join("Infrastructure/.cache/vault_manifest.json")
}

/// Read-modify-write the manifest. `mutate` returns the entry-count delta
/// (`vault_file_count` is adjusted by it), or `None` to abort without writing.
fn patch_manifest_doc(mutate: impl FnOnce(&mut Vec<serde_json::Value>) -> Option<i64>) {
    let path = content_manifest_file();
    let Ok(text) = fs::read_to_string(&path) else { return };
    let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        log::warn!("manifest patch: unparseable {}; skipping", path.display());
        return;
    };
    let Some(entries) = doc.get_mut("entries").and_then(|e| e.as_array_mut()) else {
        return;
    };
    let Some(delta) = mutate(entries) else { return };
    if delta != 0 {
        if let Some(n) = doc.get("vault_file_count").and_then(|v| v.as_i64()) {
            doc["vault_file_count"] = serde_json::Value::from((n + delta).max(0));
        }
    }
    match serde_json::to_string(&doc) {
        Ok(out) => {
            if let Err(e) = atomic_write(&path, out.as_bytes()) {
                log::warn!("manifest patch: write failed: {e:?}");
            }
        }
        Err(e) => log::warn!("manifest patch: serialize failed: {e}"),
    }
}

fn manifest_tracks(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.ends_with(".md") && !is_excluded(rel, name)
}

/// Upsert (`removed = false`) or drop (`removed = true`) one file's entry.
pub fn patch_content_manifest(rel: &str, removed: bool) {
    if !manifest_tracks(rel) {
        return;
    }
    let rel = rel.to_string();
    patch_manifest_doc(move |entries| {
        let idx = entries
            .iter()
            .position(|e| e.get("path").and_then(|p| p.as_str()) == Some(rel.as_str()));
        if removed {
            let i = idx?; // already absent → manifest consistent, skip the write
            entries.remove(i);
            return Some(-1);
        }
        let abs = Path::new(&crate::commands::vault::vault_root()).join(&rel);
        let content = fs::read_to_string(&abs).unwrap_or_default();
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        let stem = name.strip_suffix(".md").unwrap_or(name);
        let (title, aliases) = parse_title_aliases(&content, stem);
        let mtime = fs::metadata(&abs).ok().as_ref().and_then(mtime_iso);
        match idx {
            Some(i) => {
                if let Some(obj) = entries[i].as_object_mut() {
                    obj.insert("title".into(), serde_json::json!(title));
                    obj.insert("aliases".into(), serde_json::json!(aliases));
                    obj.insert("mtime".into(), serde_json::json!(mtime));
                }
                Some(0)
            }
            None => {
                entries.push(serde_json::json!({
                    "path": rel, "title": title, "aliases": aliases, "mtime": mtime,
                }));
                Some(1)
            }
        }
    });
}

/// Repath after a rename/move. A file rename re-derives its entry (the title
/// fallback follows the new stem); a folder rename rewrites the `path` prefix
/// on every entry beneath it, keeping all rich fields.
pub fn patch_content_manifest_rename(from_rel: &str, to_rel: &str, is_dir: bool) {
    if !is_dir {
        patch_content_manifest(from_rel, true);
        patch_content_manifest(to_rel, false);
        return;
    }
    let from_prefix = format!("{}/", from_rel.trim_end_matches('/'));
    let to_prefix = format!("{}/", to_rel.trim_end_matches('/'));
    patch_manifest_doc(move |entries| {
        let mut touched = false;
        for e in entries.iter_mut() {
            let Some(p) = e.get("path").and_then(|p| p.as_str()) else { continue };
            if let Some(rest) = p.strip_prefix(&from_prefix) {
                let np = format!("{to_prefix}{rest}");
                if let Some(obj) = e.as_object_mut() {
                    obj.insert("path".into(), serde_json::Value::from(np));
                    touched = true;
                }
            }
        }
        touched.then_some(0)
    });
}

/// Drop every entry under a deleted folder.
pub fn patch_content_manifest_remove_prefix(rel: &str) {
    let prefix = format!("{}/", rel.trim_end_matches('/'));
    patch_manifest_doc(move |entries| {
        let before = entries.len();
        entries.retain(|e| {
            e.get("path")
                .and_then(|p| p.as_str())
                .map(|p| !p.starts_with(&prefix))
                .unwrap_or(true)
        });
        let removed = (before - entries.len()) as i64;
        (removed != 0).then_some(-removed)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Unique temp vault dir + a sibling manifest path, cleaned up on drop.
    struct TempVault {
        dir: std::path::PathBuf,
        out: std::path::PathBuf,
    }
    impl TempVault {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let base = std::env::temp_dir()
                .join(format!("mp_manifest_gen_test_{}_{}", std::process::id(), n));
            let dir = base.join("vault");
            fs::create_dir_all(&dir).unwrap();
            let out = base.join("manifest.json");
            TempVault { dir, out }
        }
        fn write(&self, name: &str, body: &str) {
            fs::write(self.dir.join(name), body).unwrap();
        }
        fn path(&self) -> &str {
            self.dir.to_str().unwrap()
        }
    }
    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.dir.parent().unwrap());
        }
    }

    fn card(title: &str) -> String {
        format!("---\nTitle: {title}\n---\n\nbody\n")
    }

    #[test]
    fn fresh_after_generate() {
        let v = TempVault::new();
        v.write("a.md", &card("A"));
        v.write("b.md", &card("B"));
        generate_for(v.path(), &v.out).unwrap();
        assert!(manifest_is_fresh(v.path(), &v.out));
    }

    #[test]
    fn stale_on_new_file() {
        let v = TempVault::new();
        v.write("a.md", &card("A"));
        v.write("b.md", &card("B"));
        generate_for(v.path(), &v.out).unwrap();
        v.write("c.md", &card("C"));
        assert!(!manifest_is_fresh(v.path(), &v.out));
    }

    #[test]
    fn stale_on_edit() {
        let v = TempVault::new();
        v.write("a.md", &card("A"));
        v.write("b.md", &card("B"));
        generate_for(v.path(), &v.out).unwrap();
        // Advance mtime past the filesystem's second-resolution floor.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        v.write("a.md", &card("A2"));
        assert!(!manifest_is_fresh(v.path(), &v.out));
    }

    #[test]
    fn stale_when_missing() {
        let v = TempVault::new();
        v.write("a.md", &card("A"));
        assert!(!manifest_is_fresh(v.path(), &v.dir.join("nope.json")));
    }

    #[test]
    fn head_read_extracts_title_aliases() {
        let v = TempVault::new();
        v.write(
            "song.md",
            "---\nTitle: My Title\nAliases:\n  - Alt One\n  - Alt Two\n---\n\nbody\n",
        );
        generate_for(v.path(), &v.out).unwrap();
        let text = fs::read_to_string(&v.out).unwrap();
        assert!(text.contains("My Title"), "title missing: {text}");
        assert!(text.contains("Alt One"), "alias missing: {text}");
    }
}
