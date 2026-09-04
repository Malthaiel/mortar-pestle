//! Personal VODs — the three OS-level match-timer hotkeys.
//!
//! WHY THIS IS NOT A KEYBIND-REGISTRY ROW: `useKeybindAction` listens on the
//! focused webview's `window`, so an in-app chord is deaf the moment Deadlock
//! takes focus — which is the only moment these keys matter. The registry rows
//! (`vod.timer-start` / `-pause` / `-end`) still exist for EDITING; this module
//! is what enforces them, exactly as the STT daemon's `WH_KEYBOARD_LL` hook
//! enforces `stt.scrim-note`.
//!
//! Every press emits ONE global `vod-timer-key` event carrying the action. The
//! overlay host owns the clock (`vodTimer.js`) — nothing about elapsed time
//! lives here, so a webview reload can't desync from a Rust copy of the truth.

use serde::Deserialize;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::commands::vault::VaultError;

/// What we currently hold, as parallel vectors (shortcut, action). A rebind
/// unregisters exactly these — never `unregister_all`, which would also tear
/// down any other consumer of the plugin added later.
fn bound() -> &'static Mutex<Vec<(Shortcut, String)>> {
    static CELL: OnceLock<Mutex<Vec<(Shortcut, String)>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(Vec::new()))
}

/// One row from the frontend: the action name plus the accelerator string
/// (`"F6"`, `"Shift+F6"`, …). An EMPTY accelerator means the user cleared the
/// row to Unbound — skipped, not an error.
#[derive(Debug, Deserialize)]
pub struct TimerKey {
    pub action: String,
    pub accelerator: String,
}

/// Install the plugin. Called once from `run()`'s builder chain.
///
/// PRESSED ONLY: `RegisterHotKey` reports both edges, and acting on the release
/// too would start-then-immediately-pause on a single tap.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, sc, ev| {
            if ev.state() != ShortcutState::Pressed {
                return;
            }
            // Map the shortcut back to an action rather than assuming it is
            // ours — the handler fires for every shortcut the plugin owns.
            let action = bound()
                .lock()
                .unwrap()
                .iter()
                .find(|(s, _)| s == sc)
                .map(|(_, a)| a.clone());
            let Some(action) = action else { return };
            log::info!("vod-timer: hotkey {action}");
            let _ = app.emit("vod-timer-key", serde_json::json!({ "action": action }));
        })
        .build()
}

/// `vod_set_timer_keys` — replace the registered match-timer hotkeys.
///
/// Called by `VodTimerBridge` on mount AND on every keybind change, mirroring
/// `CaptureHotkeyBridge`: the registration lives in process memory only, so a
/// re-push on mount is what survives an app or webview restart.
///
/// Returns the accelerators it actually registered, so the caller can tell a
/// silently-refused bind (another app already owns the key — `RegisterHotKey`
/// fails rather than stealing it) from a working one.
#[tauri::command]
pub fn vod_set_timer_keys(app: AppHandle, keys: Vec<TimerKey>) -> Result<Vec<String>, VaultError> {
    let gs = app.global_shortcut();

    {
        let mut held = bound().lock().unwrap();
        for (sc, _) in held.iter() {
            let _ = gs.unregister(*sc);
        }
        held.clear();
    }

    let mut ok = Vec::new();
    for k in keys {
        if k.accelerator.trim().is_empty() {
            continue; // Unbound row.
        }
        let Ok(sc) = Shortcut::from_str(&k.accelerator) else {
            log::warn!("vod-timer: unparseable accelerator {:?}", k.accelerator);
            continue;
        };
        match gs.register(sc) {
            Ok(_) => {
                bound().lock().unwrap().push((sc, k.action.clone()));
                ok.push(k.accelerator.clone());
                log::info!("vod-timer: bound {} -> {}", k.accelerator, k.action);
            }
            // Another process owns the key. Report it by ABSENCE from the
            // returned list rather than failing the whole call — one taken key
            // must not cost the other two their binds.
            Err(e) => log::warn!("vod-timer: {} refused ({e})", k.accelerator),
        }
    }
    Ok(ok)
}
