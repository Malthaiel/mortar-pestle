//! 5-SF2a — studio-artifact-only carriage gate.
//!
//! Resolves the optional `iskariel-capture` engine binary at runtime. Coupling to
//! the engine is the resolved **path** only — there is no compile-time dependency
//! on the engine crate and no `studio` cargo feature on src-tauri (the binary is
//! present in studio bundles and absent in stable ones, so a runtime
//! presence-check is the only correct gate).
//!
//! Mirrors `commands::music_download::resolve_script` (bundled-resource-first,
//! dev-tree fallback) with the engine's two extra knobs: a release→debug dev
//! search and an `ISKARIEL_CAPTURE_BIN` override.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// The engine binary's filename — per-OS suffix (`windows_cmd_vs_exe_path`: a `.exe`
/// on Windows, bare on Unix). Used for BOTH the bundled-resource resolve and the
/// dev-tree artifact basename.
#[cfg(windows)]
const ENGINE_BIN_FILE: &str = "iskariel-capture.exe";
#[cfg(not(windows))]
const ENGINE_BIN_FILE: &str = "iskariel-capture";

/// Resolve the capture engine binary, first-existing-wins:
///
/// 1. **Bundled** — `BaseDirectory::Resource` / `iskariel-capture[.exe]` (studio bundle).
/// 2. **Dev tree** — `<home>/Code/iskariel/iskariel-capture/target/{release,debug}/`
///    `iskariel-capture[.exe]` (home is `%USERPROFILE%` on Windows, `$HOME` on Unix;
///    dev runs from source, not the bundle; a `cargo build` lands either profile).
/// 3. **Override** — the `ISKARIEL_CAPTURE_BIN` env var (explicit path).
///
/// Returns `None` when none exist. **This function logs nothing** — neither on
/// success nor on the `None` path. The single "capture disabled" log lives at
/// the caller (`lib.rs` setup), which owns the spawn-vs-inert decision; logging
/// here would either double-log or fire on every benign resolve.
pub fn resolve_engine_binary(app: &AppHandle) -> Option<PathBuf> {
    // 1. Bundled resource (studio bundle ships the binary in `bundle.resources`).
    if let Ok(p) = app.path().resolve(ENGINE_BIN_FILE, tauri::path::BaseDirectory::Resource) {
        if p.exists() {
            return Some(p);
        }
    }

    // 2. Dev-tree fallback: release first, then debug. The dev home is per-OS
    //    (Windows `%USERPROFILE%`, Unix `$HOME`); `cargo build` lands either profile.
    #[cfg(windows)]
    let dev_home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let dev_home = std::env::var_os("HOME");
    if let Some(home) = dev_home {
        let base = PathBuf::from(home).join("Code/iskariel/iskariel-capture/target");
        for profile in ["release", "debug"] {
            let dev = base.join(profile).join(ENGINE_BIN_FILE);
            if dev.exists() {
                return Some(dev);
            }
        }
    }

    // 3. Explicit override.
    if let Some(p) = std::env::var_os("ISKARIEL_CAPTURE_BIN").map(PathBuf::from) {
        if p.exists() {
            return Some(p);
        }
    }

    None
}
