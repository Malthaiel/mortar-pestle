//! Broadcast SP1 SF5 — engine carriage gate.
//!
//! Resolves the `mortar-pestle-broadcast` engine binary at runtime. Coupling to
//! the engine is the resolved **path** only — there is no compile-time
//! dependency on the (GPL) engine crate. A runtime presence-check is the gate:
//! present in Studio bundles / dev trees, absent elsewhere.
//!
//! Faithful clone of `stt::carriage` (bundled-resource-first, dev-tree
//! fallback, env override); only the engine-specific knobs are renamed. The
//! resolution ORDER is identical.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// The engine binary's filename — per-OS suffix (a `.exe` on Windows, bare on
/// Unix). Used for BOTH the bundled-resource resolve and the dev-tree basename.
#[cfg(windows)]
const ENGINE_BIN_FILE: &str = "mortar-pestle-broadcast.exe";
#[cfg(not(windows))]
const ENGINE_BIN_FILE: &str = "mortar-pestle-broadcast";

/// Resolve the Broadcast engine binary, first-existing-wins:
///
/// 1. **Bundled** — `BaseDirectory::Resource` / `mortar-pestle-broadcast[.exe]`
///    (Studio bundle; NSIS payload carriage lands in a later sub-plan).
/// 2. **Dev tree** — `<home>/Code/mortar-pestle/mortar-pestle-broadcast/target/`
///    `{release,debug}/mortar-pestle-broadcast[.exe]`.
/// 3. **Override** — the `MORTAR_PESTLE_BROADCAST_BIN` env var (explicit path).
///
/// Returns `None` when none exist. **This function logs nothing** — the single
/// "broadcast disabled" log lives at the caller (`supervise`), which owns the
/// spawn-vs-inert decision.
pub fn resolve_engine_binary(app: &AppHandle) -> Option<PathBuf> {
    // 1. Bundled resource.
    if let Ok(p) = app.path().resolve(ENGINE_BIN_FILE, tauri::path::BaseDirectory::Resource) {
        if p.exists() {
            return Some(p);
        }
    }

    // 2. Dev-tree fallback: release first, then debug.
    #[cfg(windows)]
    let dev_home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let dev_home = std::env::var_os("HOME");
    if let Some(home) = dev_home {
        let base = PathBuf::from(home).join("Code/mortar-pestle/mortar-pestle-broadcast/target");
        for profile in ["release", "debug"] {
            let dev = base.join(profile).join(ENGINE_BIN_FILE);
            if dev.exists() {
                return Some(dev);
            }
        }
    }

    // 3. Explicit override.
    if let Some(p) = std::env::var_os("MORTAR_PESTLE_BROADCAST_BIN").map(PathBuf::from) {
        if p.exists() {
            return Some(p);
        }
    }

    None
}
