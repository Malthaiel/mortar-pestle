//! Sub-feature 6 — Sidebar order persistence in Tauri AppConfig.
//!
//! Single JSON map (`{ [key: string]: string[] }`) at
//! `<app_config>/sidebar.json`. Migrated once at startup from the legacy
//! vault location `<vault>/Infrastructure/.cache/sidebar_order.json`
//! (see `lib.rs::migrate_sidebar_to_app_config`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use crate::commands::vault::{atomic_write, VaultError};

/// Serializes load→mutate→persist across rapid concurrent drags. Without
/// this, two near-simultaneous `sidebar_set_order` calls for different keys
/// could interleave and lose an update. `Mutex::new` is const since 1.63 so
/// no Lazy/OnceLock wrapper is needed.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// AppConfig root, overridable for tests via `AGENTIC_APP_CONFIG_ROOT`.
/// Re-reads on every call so per-test tempdirs work — config root changes
/// between calls in a single process. Mirrors the `AGENTIC_VAULT_ROOT`
/// convention from `commands/vault.rs`.
pub fn app_config_root(app: &AppHandle) -> Result<PathBuf, VaultError> {
    if let Ok(v) = std::env::var("AGENTIC_APP_CONFIG_ROOT") {
        return Ok(PathBuf::from(v));
    }
    app.path()
        .app_config_dir()
        .map_err(|e| VaultError::Io(format!("app_config_dir unavailable: {e}")))
}

pub fn sidebar_file(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(app_config_root(app)?.join("sidebar.json"))
}

fn load_map(path: &Path) -> Map<String, Value> {
    let Ok(text) = fs::read_to_string(path) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => m,
        Ok(_) => {
            log::warn!("sidebar.json is not a JSON object — treating as empty");
            Map::new()
        }
        Err(e) => {
            log::warn!("sidebar.json parse failed ({e}) — treating as empty; next set auto-heals");
            Map::new()
        }
    }
}

fn persist_map(path: &Path, map: &Map<String, Value>) -> Result<(), VaultError> {
    let val = Value::Object(map.clone());
    let mut text = serde_json::to_string_pretty(&val)
        .map_err(|e| VaultError::Io(format!("serialize sidebar.json: {e}")))?;
    text.push('\n');
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| VaultError::Io(format!("mkdir {parent:?}: {e}")))?;
    }
    atomic_write(path, text.as_bytes())
}

/// Read the order for `key`. Returns `None` if file missing, key absent,
/// value not an array, or file corrupt (load_map already logged the warning).
/// `pub` (not `pub(crate)`) so integration tests can call without `AppHandle`.
pub fn get_order_inner(path: &Path, key: &str) -> Option<Vec<String>> {
    let map = load_map(path);
    map.get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect()
    })
}

/// Set the order for `key`. Empty array deletes the key (preserves Node
/// invariant at `server/src/vault/sidebar_order.js:48`). Non-string entries
/// in `order` are silently filtered (preserves Node behavior at line 46).
/// Returns the persisted order (None when key was deleted).
/// `pub` (not `pub(crate)`) so integration tests can call without `AppHandle`.
pub fn set_order_inner(
    path: &Path,
    key: &str,
    order: &[Value],
) -> Result<Option<Vec<String>>, VaultError> {
    if key.is_empty() {
        return Err(VaultError::Invalid("key required".into()));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_map(path);
    let clean: Vec<String> = order
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    if clean.is_empty() {
        map.remove(key);
    } else {
        map.insert(
            key.to_string(),
            Value::Array(clean.iter().cloned().map(Value::String).collect()),
        );
    }
    persist_map(path, &map)?;
    Ok(map.get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect()
    }))
}

#[derive(Serialize)]
pub struct SidebarOrderOut {
    pub order: Option<Vec<String>>,
}

#[tauri::command]
pub fn sidebar_get_order(app: AppHandle, key: String) -> Result<SidebarOrderOut, VaultError> {
    let path = sidebar_file(&app)?;
    Ok(SidebarOrderOut {
        order: get_order_inner(&path, &key),
    })
}

#[tauri::command]
pub fn sidebar_set_order(
    app: AppHandle,
    key: String,
    order: Vec<Value>,
) -> Result<SidebarOrderOut, VaultError> {
    let path = sidebar_file(&app)?;
    let order = set_order_inner(&path, &key, &order)?;
    Ok(SidebarOrderOut { order })
}

/// One-shot byte-faithful migration from legacy vault location to AppConfig.
/// Returns `Ok(true)` when bytes were copied, `Ok(false)` when no-op (dest
/// already present, or src missing). Errors propagate so the caller can log.
/// Idempotent: re-running after a successful migration is `Ok(false)`.
/// `pub` (not `pub(crate)`) so integration tests can exercise without `AppHandle`.
pub fn migrate_inner(src: &Path, dest: &Path) -> Result<bool, VaultError> {
    if dest.exists() {
        return Ok(false);
    }
    if !src.exists() {
        return Ok(false);
    }
    let bytes = fs::read(src).map_err(|e| VaultError::Io(format!("read old: {e}")))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| VaultError::Io(format!("mkdir: {e}")))?;
    }
    // Byte-for-byte preserves Node's `\n` trailing — no parse/serialize round-trip.
    atomic_write(dest, &bytes)?;
    // Orphan harmless: next launch's `dest.exists()` gate makes the migration
    // a no-op even if cleanup fails.
    let _ = fs::remove_file(src);
    Ok(true)
}

/// One-time pomodoro → planner rename (Planner Overhaul epic): rewrites the
/// "pomodoro" widget id inside `widgets:order` so the persisted right-sidebar
/// widget order survives the module rename, and scrubs the dead
/// `plugins:right-sidebar` / `plugins:dock` keys (no readers since Phase 2b).
/// Idempotent — presence of the old id/keys is the trigger, no flag needed.
/// Returns `Ok(true)` when the file was rewritten.
/// `pub` (not `pub(crate)`) so integration tests can exercise without `AppHandle`.
pub fn migrate_planner_rename(path: &Path) -> Result<bool, VaultError> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !path.exists() {
        return Ok(false);
    }
    let mut map = load_map(path);
    let mut dirty = false;
    if let Some(Value::Array(order)) = map.get_mut("widgets:order") {
        for v in order.iter_mut() {
            if v.as_str() == Some("pomodoro") {
                *v = Value::String("planner".into());
                dirty = true;
            }
        }
    }
    for key in ["plugins:right-sidebar", "plugins:dock"] {
        if map.remove(key).is_some() {
            dirty = true;
        }
    }
    if dirty {
        persist_map(path, &map)?;
    }
    Ok(dirty)
}
