//! Vault manifest loader with mtime-keyed hot reload.
//!
//! Mirrors the JS `loadManifest` + `reloadManifest` behavior in
//! `server/src/render/markdown.js`. Indices are rebuilt whenever the manifest
//! file's mtime changes — checked on every render call. Sub-feature 5's
//! `watcher` module only emits a `manifest` event to the frontend; the
//! mtime-keyed self-reload here is sufficient and intentional (no eager
//! invalidation hook needed).

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::commands::vault::vault_root;

#[derive(Clone, Debug, Deserialize)]
pub struct Entry {
    pub path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub mtime: Option<String>,
}

#[derive(Deserialize)]
struct ManifestFile {
    entries: Vec<Entry>,
}

#[derive(Default)]
pub struct ManifestState {
    pub path_index: HashMap<String, Entry>,
    pub basename_index: HashMap<String, Vec<Entry>>,
    pub alias_index: HashMap<String, Vec<Entry>>,
    pub all: Vec<Entry>,
    loaded_mtime_ms: f64,
}

fn state() -> &'static RwLock<ManifestState> {
    static S: OnceLock<RwLock<ManifestState>> = OnceLock::new();
    S.get_or_init(|| RwLock::new(ManifestState::default()))
}

fn manifest_path() -> String {
    // Runtime: the active vault's app-data manifest (commands::vaults sets this
    // at startup + on switch). Falls back to the legacy in-vault path before
    // init and in tests (which set AGENTIC_VAULT_ROOT but not the registry).
    if let Some(p) = crate::commands::vaults::active_manifest_path() {
        return p;
    }
    format!("{}/Infrastructure/.cache/vault_manifest.json", vault_root())
}

fn current_mtime_ms() -> Option<f64> {
    let meta = fs::metadata(manifest_path()).ok()?;
    let dur = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(dur.as_secs_f64() * 1000.0)
}

fn push(map: &mut HashMap<String, Vec<Entry>>, key: String, entry: Entry) {
    map.entry(key).or_default().push(entry);
}

fn rebuild(entries: Vec<Entry>) -> ManifestState {
    let mut s = ManifestState::default();
    for entry in entries {
        let path_key = entry.path.trim_end_matches(".md").to_string();
        s.path_index.insert(path_key.clone(), entry.clone());
        let basename = Path::new(&path_key)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !basename.is_empty() {
            push(&mut s.basename_index, basename, entry.clone());
        }
        for alias in &entry.aliases {
            push(&mut s.alias_index, alias.to_lowercase(), entry.clone());
        }
        s.all.push(entry);
    }
    s
}

/// Snapshot of every manifest entry. Empty when the manifest hasn't loaded.
/// Mirrors Node's `getManifestEntries()` shape.
pub fn all_entries() -> Vec<Entry> {
    with_state(|s| s.all.clone())
}

/// Current manifest mtime (ms since epoch). Useful as a cache key. 0.0 if
/// the file is missing.
pub fn current_mtime() -> f64 {
    ensure_loaded();
    state().read().unwrap().loaded_mtime_ms
}

/// Ensure the manifest indices are loaded and up-to-date.
pub fn ensure_loaded() {
    let cur_mtime = current_mtime_ms().unwrap_or(0.0);
    {
        let s = state().read().unwrap();
        if (s.loaded_mtime_ms - cur_mtime).abs() < 0.5 && cur_mtime > 0.0 {
            return;
        }
    }
    let text = match fs::read_to_string(manifest_path()) {
        Ok(t) => t,
        Err(_) => return,
    };
    let parsed: ManifestFile = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[manifest] parse failed: {e}");
            return;
        }
    };
    let mut next = rebuild(parsed.entries);
    next.loaded_mtime_ms = cur_mtime;
    *state().write().unwrap() = next;
}

pub fn with_state<R>(f: impl FnOnce(&ManifestState) -> R) -> R {
    ensure_loaded();
    let s = state().read().unwrap();
    f(&*s)
}

/// Initialize once at app boot to avoid lazy load cost on first render.
#[allow(dead_code)]
pub fn init() {
    ensure_loaded();
}

/// Reset the loaded indices so the next access reloads from the current
/// `manifest_path()`. Called on vault switch — the manifest path changes per
/// active vault, so the mtime-keyed reload alone could miss the swap.
pub fn invalidate() {
    *state().write().unwrap() = ManifestState::default();
}

// Re-export for tests
#[cfg(test)]
pub fn reset_for_tests() {
    *state().write().unwrap() = ManifestState::default();
}

// Helper for SystemTime → ms (kept for symmetry with vault.rs)
#[allow(dead_code)]
pub fn ms(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}
