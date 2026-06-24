//! Cross-window live-target state for the in-game scrim-notes overlay (B).
//!
//! The "active scrim/match" the live overlay captures into is set from the
//! ScrimViewer's **Go Live** button and read by the `overlay-scrim` window and
//! the host-side STT dictation reroute (`lib.rs`). `localStorage` is per-webview
//! on WebKitGTK, so cross-window state CANNOT live there — it lives here in Rust
//! behind a process-lifetime `OnceLock<Mutex<…>>` (mirrors
//! `capture::supervisor::cell()`), and is pushed to the overlay window via the
//! `overlay-live-target` Tauri event (a freshly-shown window re-pulls it with
//! `overlay_get_live_target`, covering the show-before-listen race).

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::vault::VaultError;

/// The active scrim + match the live overlay captures into. camelCase on the
/// wire (the JS Go Live button authors it; the overlay view + the
/// `overlay-live-target` event read it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTarget {
    /// Vault-relative path of the scrim `.md` (root `gamewiki`).
    pub scrim_path: String,
    /// 1-based match number within the scrim.
    pub match_n: u32,
    /// The coached team name (notes attach under it); `None` when unset.
    #[serde(default)]
    pub coached_team: Option<String>,
}

/// Process-lifetime live-target slot. `None` ⇒ no scrim is live (dictation +
/// notes fall back to the normal Quick-Notes path).
fn cell() -> &'static Mutex<Option<LiveTarget>> {
    static CELL: OnceLock<Mutex<Option<LiveTarget>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Lock the slot, recovering a poisoned mutex (house `into_inner` idiom).
fn lock() -> std::sync::MutexGuard<'static, Option<LiveTarget>> {
    cell().lock().unwrap_or_else(|p| p.into_inner())
}

/// The current live target (a clone), or `None` when no scrim is live. Read by
/// the STT dictation reroute in `lib.rs::run` (`dictation_committed` arm).
pub fn current_live_target() -> Option<LiveTarget> {
    lock().clone()
}

/// `overlay_go_live` — mark a scrim/match live: store the target, show the
/// scrim overlay window, and push `overlay-live-target` so an already-mounted
/// overlay updates immediately. A window shown for the first time re-pulls via
/// `overlay_get_live_target` on mount, so the emit-before-listen race is covered.
#[tauri::command]
pub fn overlay_go_live(app: AppHandle, target: LiveTarget) -> Result<(), VaultError> {
    *lock() = Some(target.clone());
    if let Some(win) = app.get_webview_window("overlay-scrim") {
        let _ = win.show();
        // SF4 — float over the game: click-through (the scrim is a read-only
        // transcript/notes display, so clicks pass through to the focused game) +
        // topmost. `set_ignore_cursor_events` is the cross-platform input-passthrough
        // and the Windows keep-above mechanic; on Linux/Wayland keep-above still comes
        // from the KWin rule (the always-on-top hint is ignored there, so this is a
        // harmless no-op). Exclusive-fullscreen games hide all overlays — borderless-
        // windowed is required (documented limit; SF4 detect-warn is a refinement).
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_always_on_top(true);
    }
    let _ = app.emit("overlay-live-target", Some(&target));
    Ok(())
}

/// `overlay_go_offline` — clear the live target, hide the scrim overlay, and
/// push a null `overlay-live-target` (the overlay returns to its idle state).
#[tauri::command]
pub fn overlay_go_offline(app: AppHandle) -> Result<(), VaultError> {
    *lock() = None;
    if let Some(win) = app.get_webview_window("overlay-scrim") {
        let _ = win.hide();
    }
    let _ = app.emit("overlay-live-target", Option::<LiveTarget>::None);
    Ok(())
}

/// `overlay_get_live_target` — the current live target. The overlay view pulls
/// this on mount to cover the show-before-listen race.
#[tauri::command]
pub fn overlay_get_live_target() -> Result<Option<LiveTarget>, VaultError> {
    Ok(current_live_target())
}

/// SF9 (Game Capture) — harden the in-game **capture** HUD (`overlay-capture`)
/// for floating over a game. Called from the `lib.rs` capture event-bridge each
/// time the daemon's Shift+C `overlay` event shows the window; idempotent (the
/// ex-style + display-affinity persist on the HWND, so re-asserting on each show
/// is harmless).
///
/// Unlike the read-only scrim overlay (`overlay_go_live`, which is fully
/// click-through), the capture HUD's Clip/Record/Shot buttons are **interactive**
/// — so `set_ignore_cursor_events` is deliberately NOT called. Instead:
/// - `set_always_on_top(true)` keeps it topmost (the config flag too — belt-and-
///   suspenders; on Linux/Wayland the real keep-above is the KWin rule, so this
///   is a harmless no-op there);
/// - `WS_EX_NOACTIVATE` (Windows) makes button clicks **non-activating** — they
///   hit the buttons but never pull the borderless game out of foreground/focus;
/// - `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (Windows) excludes the
///   HUD from the capture stream as belt-and-suspenders for the monitor-capture
///   fallback (per-window WGC already excludes a separate HUD window).
pub fn harden_capture_overlay(win: &tauri::WebviewWindow) {
    let _ = win.set_always_on_top(true);
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowDisplayAffinity, SetWindowLongPtrW, GWL_EXSTYLE,
            WDA_EXCLUDEFROMCAPTURE, WS_EX_NOACTIVATE,
        };
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                // Absent from the recording (monitor-fallback path).
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                // Clicks fire the buttons without stealing the game's focus.
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
            }
        }
    }
}
