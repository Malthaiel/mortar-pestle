//! Official Docs page — `docs_get_manifest` command.
//!
//! Reads `Iskariel/Docs/docs-manifest.json` from the App vault, validates each
//! entry's `path` canonicalizes under vault root, and expands the
//! `{ source: "decisions-folder" }` sentinel into ordered Decision records
//! (mtime desc). Body rendering reuses `vault_render_reference` — this command
//! returns only nav structure.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::commands::vault::{app_vault_root, VaultError};

const MANIFEST_REL: &str = "Iskariel/Docs/docs-manifest.json";
const DECISIONS_REL: &str = "Iskariel/Decisions";

#[derive(Debug, Deserialize)]
struct RawManifest {
    categories: Vec<RawCategory>,
}

#[derive(Debug, Deserialize)]
struct RawCategory {
    id: String,
    label: String,
    #[serde(default)]
    entries: Vec<RawEntry>,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    id: String,
    title: String,
    path: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DocsManifest {
    pub categories: Vec<DocsCategory>,
}

#[derive(Debug, Serialize)]
pub struct DocsCategory {
    pub id: String,
    pub label: String,
    pub entries: Vec<DocsEntry>,
}

#[derive(Debug, Serialize)]
pub struct DocsEntry {
    pub id: String,
    pub title: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// File mtime (epoch millis) for the Docs sidebar's by-date sort. None when
    /// the entry's file can't be stat'd (e.g. pre-authored pages shipped later).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u128>,
}

/// Docs subsystem resolves against the **App Vault** (multi-mount). Falls back
/// to the content vault until the App Vault is registered (SF4) and in tests
/// (which set `AGENTIC_VAULT_ROOT` but not `AGENTIC_APP_VAULT_ROOT`).
fn canonical_vault_root() -> PathBuf {
    let v = app_vault_root();
    fs::canonicalize(&v).unwrap_or_else(|_| PathBuf::from(v))
}

fn assert_under_vault(rel_path: &str) -> Result<(), VaultError> {
    let root = canonical_vault_root();
    let joined = root.join(rel_path);
    // For non-existent paths (intentional — manifest may list pre-authored
    // pages that ship in the same release), fall back to parent containment.
    let target = fs::canonicalize(&joined).unwrap_or_else(|_| joined.clone());
    if !target.starts_with(&root) {
        return Err(VaultError::Invalid(format!(
            "docs entry path escapes vault root: {rel_path}"
        )));
    }
    Ok(())
}

/// File mtime (epoch millis) for a vault-relative docs entry, for by-date sort.
fn entry_mtime(root: &std::path::Path, rel_path: &str) -> Option<u128> {
    fs::metadata(root.join(rel_path))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
}

fn expand_decisions_folder() -> Result<Vec<DocsEntry>, VaultError> {
    let root = canonical_vault_root();
    let dir = root.join(DECISIONS_REL);
    let mut items: Vec<(String, String, u128)> = Vec::new();
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    for ent in read.flatten() {
        let p = ent.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match p.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mtime = ent
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let rel = format!("{DECISIONS_REL}/{stem}.md");
        items.push((stem, rel, mtime));
    }
    items.sort_by(|a, b| b.2.cmp(&a.2));
    Ok(items
        .into_iter()
        .map(|(stem, rel, mtime)| DocsEntry {
            id: stem.clone(),
            title: stem,
            path: rel,
            description: None,
            mtime: Some(mtime),
        })
        .collect())
}

// Async wrapper: run the (blocking) manifest read off the main-thread command
// path via spawn_blocking, so a future main-thread stall can't starve content
// loads (resilience hardening after the 2026-06-24 Windows browser deadlock).
#[tauri::command]
pub async fn docs_get_manifest() -> Result<DocsManifest, VaultError> {
    tauri::async_runtime::spawn_blocking(docs_get_manifest_inner)
        .await
        .map_err(|e| VaultError::Io(e.to_string()))?
}

fn docs_get_manifest_inner() -> Result<DocsManifest, VaultError> {
    let root = canonical_vault_root();
    let manifest_path = root.join(MANIFEST_REL);
    let raw_text = fs::read_to_string(&manifest_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            VaultError::NotFound(format!("docs manifest missing at {MANIFEST_REL}"))
        } else {
            VaultError::Io(e.to_string())
        }
    })?;
    let raw: RawManifest = serde_json::from_str(&raw_text)
        .map_err(|e| VaultError::Invalid(format!("docs-manifest.json parse error: {e}")))?;

    let mut categories = Vec::with_capacity(raw.categories.len());
    for cat in raw.categories {
        let entries = if cat.source.as_deref() == Some("decisions-folder") {
            expand_decisions_folder()?
        } else {
            let mut out = Vec::with_capacity(cat.entries.len());
            for e in cat.entries {
                assert_under_vault(&e.path)?;
                let mtime = entry_mtime(&root, &e.path);
                out.push(DocsEntry {
                    id: e.id,
                    title: e.title,
                    path: e.path,
                    description: e.description,
                    mtime,
                });
            }
            out
        };
        categories.push(DocsCategory {
            id: cat.id,
            label: cat.label,
            entries,
        });
    }
    Ok(DocsManifest { categories })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn write_fixture(dir: &std::path::Path, manifest_body: &str) {
        let docs_dir = dir.join("Iskariel/Docs");
        fs::create_dir_all(&docs_dir).unwrap();
        fs::write(docs_dir.join("docs-manifest.json"), manifest_body).unwrap();
        // Make a real file referenced by tests
        let know_dir = dir.join("Knowledge");
        fs::create_dir_all(&know_dir).unwrap();
        fs::write(know_dir.join("Sample.md"), "# Sample\n").unwrap();
    }

    #[test]
    fn valid_manifest_roundtrip() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        write_fixture(
            tmp.path(),
            r#"{"categories":[{"id":"welcome","label":"Welcome","entries":[{"id":"sample","title":"Sample","path":"Knowledge/Sample.md"}]}]}"#,
        );
        std::env::set_var("AGENTIC_VAULT_ROOT", tmp.path());
        let m = docs_get_manifest_inner().unwrap();
        assert_eq!(m.categories.len(), 1);
        assert_eq!(m.categories[0].entries.len(), 1);
        assert_eq!(m.categories[0].entries[0].id, "sample");
        std::env::remove_var("AGENTIC_VAULT_ROOT");
    }

    #[test]
    fn missing_file_returns_not_found() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("AGENTIC_VAULT_ROOT", tmp.path());
        let err = docs_get_manifest_inner().unwrap_err();
        let s = serde_json::to_string(&err).unwrap();
        assert!(s.contains("NOT_FOUND"), "got: {s}");
        std::env::remove_var("AGENTIC_VAULT_ROOT");
    }

    #[test]
    fn malformed_json_returns_invalid() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        write_fixture(tmp.path(), "{ this is not json");
        std::env::set_var("AGENTIC_VAULT_ROOT", tmp.path());
        let err = docs_get_manifest_inner().unwrap_err();
        let s = serde_json::to_string(&err).unwrap();
        assert!(s.contains("INVALID"), "got: {s}");
        std::env::remove_var("AGENTIC_VAULT_ROOT");
    }

    #[test]
    fn path_escape_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        write_fixture(
            tmp.path(),
            r#"{"categories":[{"id":"x","label":"X","entries":[{"id":"esc","title":"Escape","path":"../../../etc/passwd"}]}]}"#,
        );
        std::env::set_var("AGENTIC_VAULT_ROOT", tmp.path());
        let err = docs_get_manifest_inner().unwrap_err();
        let s = serde_json::to_string(&err).unwrap();
        assert!(s.contains("INVALID"), "got: {s}");
        std::env::remove_var("AGENTIC_VAULT_ROOT");
    }

    #[test]
    fn decisions_folder_sentinel_expands() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        write_fixture(tmp.path(), r#"{"categories":[{"id":"dec","label":"Decisions","source":"decisions-folder","entries":[]}]}"#);
        let dec_dir = tmp.path().join(DECISIONS_REL);
        fs::create_dir_all(&dec_dir).unwrap();
        fs::write(dec_dir.join("Alpha.md"), "alpha").unwrap();
        fs::write(dec_dir.join("Beta.md"), "beta").unwrap();
        std::env::set_var("AGENTIC_VAULT_ROOT", tmp.path());
        let m = docs_get_manifest_inner().unwrap();
        assert_eq!(m.categories[0].entries.len(), 2);
        std::env::remove_var("AGENTIC_VAULT_ROOT");
    }
}
