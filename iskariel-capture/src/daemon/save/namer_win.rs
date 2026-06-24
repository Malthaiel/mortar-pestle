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
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
};

/// Detect the current game for clip attribution from the foreground window title.
/// Always returns a non-empty, sanitized folder component (worst case `"Desktop"`).
pub fn detect_game() -> String {
    foreground_title()
        .map(|t| sanitize_folder(&t))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

/// The foreground window's title via Win32, or `None` when there is no foreground
/// window / it has no title text. Never panics.
fn foreground_title() -> Option<String> {
    let hwnd: HWND = unsafe { GetForegroundWindow() };
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
