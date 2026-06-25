//! GameNamer (Windows) — attribute a clip to the foreground window.
//!
//! The Windows counterpart of `namer.rs`'s Linux Steam/`/proc` detection. WGC
//! captures the foreground window, so a clip is attributed to that window's title:
//! `GetForegroundWindow` → `GetWindowTextW` → a sanitized folder component,
//! falling back to `"Desktop"` when there is no foreground window or no title.
//! Window-title only — Steam-AppID resolution is a deferred enrichment.
//!
//! Selected per-OS by `save/mod.rs` via `#[cfg(windows)] #[path = "namer_win.rs"]
//! pub mod namer;`, so `namer.rs` stays Linux-only and byte-identical (no in-place
//! gating). `sanitize_folder` is duplicated from `namer.rs` (kept in sync) rather
//! than shared — `namer.rs` doesn't exist on Windows to import from.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindow, GetWindowTextLengthW, GetWindowTextW,
    IsWindowVisible, GW_HWNDNEXT,
};

/// Detect the current game for clip attribution from the capture-target window's
/// title. Always returns a non-empty, sanitized folder component (worst case
/// `"Desktop"`). Uses the SAME target as the capture, so a clip recorded from the
/// Shift+C HUD is named after the window behind it — not the HUD.
pub fn detect_game() -> String {
    title_for(capture_target_hwnd())
        .map(|t| sanitize_folder(&t))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

/// The window WGC should capture: the foreground window, unless it is one of our own
/// capture-excluded overlays (the Shift+C HUD / scrim, hardened `WDA_EXCLUDEFROMCAPTURE`).
/// Those are invisible to WGC — capturing one delivers zero frames and the start
/// aborts — so walk down the Z-order to the first visible, non-excluded top-level
/// window the overlay is floating over (the game / desktop app). Returns null only if
/// nothing eligible is found. This is the 5-WI3 fix: an overlay-triggered record must
/// capture the content behind the HUD, not the HUD itself.
pub fn capture_target_hwnd() -> HWND {
    let mut hwnd = unsafe { GetForegroundWindow() };
    for _ in 0..32 {
        if hwnd.0.is_null() {
            break;
        }
        if is_visible(hwnd) && !is_skippable_target(hwnd) {
            return hwnd;
        }
        hwnd = unsafe { GetWindow(hwnd, GW_HWNDNEXT) }.unwrap_or_default();
    }
    hwnd
}

/// A window we must never capture: our own overlays (the Shift+C HUD / scrim), which
/// are hardened `WDA_EXCLUDEFROMCAPTURE` — invisible to WGC, so capturing one yields
/// zero frames. Matched by the "Iskariel Overlay" window title (their tauri.conf
/// titles); the main app window keeps its own title, so in-app capture is unaffected.
fn is_skippable_target(hwnd: HWND) -> bool {
    match title_for(hwnd) {
        Some(t) => t.starts_with("Iskariel Overlay"),
        None => false,
    }
}

fn is_visible(hwnd: HWND) -> bool {
    unsafe { IsWindowVisible(hwnd) }.as_bool()
}

/// `hwnd`'s title via Win32, or `None` when it has no title text. Never panics.
fn title_for(hwnd: HWND) -> Option<String> {
    if hwnd == HWND::default() {
        return None;
    }
    // GetWindowTextLengthW excludes the trailing NUL; size the buffer with room for it.
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n as usize]))
}

/// Sanitize a game name into one safe path component: replace separators/control
/// chars with spaces, trim surrounding whitespace + dots, collapse runs, cap to 80.
/// Byte-identical to `namer.rs::sanitize_folder` (kept in sync; see module docs).
fn sanitize_folder(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' || c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches('.').trim();
    trimmed.chars().take(80).collect::<String>().trim().to_string()
}
