//! Cross-window live-target state for the in-game scrim-notes overlay (B).
//!
//! The "active scrim/match" the live overlay captures into is set from the
//! ScrimViewer's **Go Live** button and read by the Scrim overlay panel and
//! the host-side STT dictation reroute (`lib.rs`). `localStorage` is per-webview
//! on WebKitGTK, so cross-window state CANNOT live there — it lives here in Rust
//! behind a process-lifetime `OnceLock<Mutex<…>>` (mirrors
//! `capture::supervisor::cell()`), and is pushed to the overlay window via the
//! `overlay-live-target` Tauri event (a freshly-shown window re-pulls it with
//! `overlay_get_live_target`, covering the show-before-listen race).

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition};

use crate::commands::vault::VaultError;

/// The active scrim + match the live overlay captures into. camelCase on the
/// wire (the JS Go Live button authors it; the overlay view + the
/// `overlay-live-target` event read it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTarget {
    /// Vault-relative path of the scrim `.md` (root `deadlock`).
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

/// Pending toast text stashed by `overlay_note_toast` for `OverlayToastView` to
/// re-pull on mount — the show-before-listen cure (mirrors `overlay_get_live_target`
/// for the host). The `overlay-toast` webview is `visible:false` at boot; if its
/// `listen()` isn't attached when Rust emits `overlay-note-toast` (or the webview
/// only wakes on first show), the event is lost. The view pulls this on mount so
/// the note still shows. Cleared on read and on `overlay_toast_done`.
fn pending_cell() -> &'static Mutex<Option<String>> {
    static CELL: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn lock_pending() -> std::sync::MutexGuard<'static, Option<String>> {
    pending_cell().lock().unwrap_or_else(|p| p.into_inner())
}

/// The monitor the in-game overlay (`overlay-host`) renders on, chosen from the
/// overlay's monitor picker chip, the Settings row, or the cycle shortcut. Like
/// `LiveTarget` it lives in a process-lifetime `OnceLock<Mutex<…>>` cell — the
/// overlay-host webview has its own localStorage (unreadable by the main Settings
/// webview), so a cross-window choice can't live in either localStorage; Rust is the
/// single source of truth both webviews reach. Persisted to `overlay_monitor.json`
/// in app-data so it survives restarts. Matched by name first, then by position
/// (a monitor's `name()` can be `None`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPref {
    /// The monitor's device name (`Monitor::name()`); `None` when the platform
    /// didn't expose one (position-match is the fallback).
    #[serde(default)]
    pub name: Option<String>,
    /// Physical top-left position (physical px) — the position-match fallback.
    pub pos: (i32, i32),
    /// Physical size — stored for completeness; `show_overlay_host` re-sizes to the
    /// resolved monitor's live `size()` anyway, so a stale size never sticks.
    pub size: (u32, u32),
}

struct MonitorState {
    /// Whether the pref has been read off disk yet (distinguishes "loaded, no pref"
    /// from "not loaded" so a deliberately-cleared pref isn't re-read every call).
    loaded: bool,
    pref: Option<MonitorPref>,
}

fn monitor_cell() -> &'static Mutex<MonitorState> {
    static CELL: OnceLock<Mutex<MonitorState>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(MonitorState { loaded: false, pref: None }))
}

fn lock_monitor() -> std::sync::MutexGuard<'static, MonitorState> {
    monitor_cell().lock().unwrap_or_else(|p| p.into_inner())
}

/// The chosen monitor (a clone), lazily loaded from `overlay_monitor.json` on the
/// first call. Read by `show_overlay_host` (so Shift+C re-shows on the chosen
/// monitor) and by `overlay_list_monitors` (to mark the current selection).
fn current_monitor_pref(app: &AppHandle) -> Option<MonitorPref> {
    let mut g = lock_monitor();
    if !g.loaded {
        g.pref = read_pref_file(app);
        g.loaded = true;
    }
    g.pref.clone()
}

/// Store the choice in the cell and persist it to `overlay_monitor.json`.
fn set_monitor_pref(app: &AppHandle, pref: Option<MonitorPref>) {
    {
        let mut g = lock_monitor();
        g.loaded = true;
        g.pref = pref.clone();
    }
    write_pref_file(app, &pref);
}

fn pref_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("overlay_monitor.json"))
}

fn read_pref_file(app: &AppHandle) -> Option<MonitorPref> {
    let path = pref_path(app)?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_pref_file(app: &AppHandle, pref: &Option<MonitorPref>) {
    let Some(path) = pref_path(app) else { return };
    match pref {
        Some(p) => {
            if let Ok(json) = serde_json::to_string_pretty(p) {
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(path, json);
            }
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Find the chosen monitor among `app.available_monitors()` by name first, then by
/// position. Returns the live `Monitor` — its `size()` is re-read, so a stored
/// stale size never sticks.
fn resolve_monitor(app: &AppHandle, pref: &MonitorPref) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if let Some(name) = &pref.name {
        if let Some(m) = monitors
            .iter()
            .find(|m| m.name().map(|s| s.as_str()) == Some(name.as_str()))
        {
            return Some(m.clone());
        }
    }
    monitors
        .iter()
        .find(|m| *m.position() == PhysicalPosition::new(pref.pos.0, pref.pos.1))
        .cloned()
}

/// `overlay_list_monitors` — every available monitor with a friendly label, its
/// physical resolution, and which one is currently chosen. Drives the overlay chip
/// dropdown and the Settings row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub name: Option<String>,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub is_selected: bool,
}

#[tauri::command]
pub fn overlay_list_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, VaultError> {
    let pref = current_monitor_pref(&app);
    let monitors = app.available_monitors().unwrap_or_default();
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let name_ref = m.name();
            let name: Option<String> = name_ref.cloned();
            let label = name
                .clone()
                .unwrap_or_else(|| format!("Display {}", i + 1));
            let size = m.size();
            let is_selected = pref
                .as_ref()
                .map(|p| match (p.name.as_deref(), name_ref) {
                    (Some(pn), Some(n)) => pn == n.as_str(),
                    _ => *m.position() == PhysicalPosition::new(p.pos.0, p.pos.1),
                })
                .unwrap_or(false);
            MonitorInfo {
                name,
                label,
                width: size.width,
                height: size.height,
                is_selected,
            }
        })
        .collect())
}

/// `overlay_set_monitor` — choose a monitor by its `name` (from
/// `overlay_list_monitors`): store + persist the pref, and if the overlay-host is
/// visible, reposition + re-size it immediately. An unmatched/unset name is a no-op
/// (the stored pref is left as-is — there's no clear path today).
#[tauri::command]
pub fn overlay_set_monitor(app: AppHandle, name: Option<String>) -> Result<(), VaultError> {
    let monitors = app.available_monitors().unwrap_or_default();
    let Some(m) = name
        .as_deref()
        .and_then(|n| monitors.iter().find(|m| m.name().map(|s| s.as_str()) == Some(n)))
    else {
        return Ok(());
    };
    let pos = m.position();
    let size = m.size();
    let pref = MonitorPref {
        name: m.name().cloned(),
        pos: (pos.x, pos.y),
        size: (size.width, size.height),
    };
    set_monitor_pref(&app, Some(pref));
    if let Some(win) = app.get_webview_window("overlay-host") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.set_position(*m.position());
            let _ = win.set_size(*m.size());
        }
    }
    Ok(())
}

/// `overlay_go_live` — mark a scrim/match live: store the target and push
/// `overlay-live-target` so an already-mounted panel updates immediately.
/// Deliberately does NOT show the host window — Shift+C owns host visibility
/// (mirrors `overlay_go_offline`). Its only JS caller is the overlay webview's
/// own ScrimViewer republishing the focused match, and a show-if-hidden branch
/// here made the DEV reload-after-hide (`hide_overlay_host`) pop the window
/// right back up: reload → panel remounts hidden → republishes → re-show.
#[tauri::command]
pub fn overlay_go_live(app: AppHandle, target: LiveTarget) -> Result<(), VaultError> {
    *lock() = Some(target.clone());
    let _ = app.emit("overlay-live-target", Some(&target));
    Ok(())
}

/// `overlay_go_offline` — clear the live target and push a null
/// `overlay-live-target`; the Scrim panel unmounts on the cleared target. The host
/// window is deliberately NOT hidden here — Shift+C (the capture `overlay` chord)
/// owns host visibility, and the Studio panel may still be in use.
#[tauri::command]
pub fn overlay_go_offline(app: AppHandle) -> Result<(), VaultError> {
    *lock() = None;
    let _ = app.emit("overlay-live-target", Option::<LiveTarget>::None);
    Ok(())
}

/// `overlay_get_live_target` — the current live target. The overlay view pulls
/// this on mount to cover the show-before-listen race.
#[tauri::command]
pub fn overlay_get_live_target() -> Result<Option<LiveTarget>, VaultError> {
    Ok(current_live_target())
}

/// Show the overlay-host window hardened for floating over a game: topmost +
/// non-activating + capture-excluded (`harden_capture_overlay`), sized to the
/// current monitor (a transparent *fullscreen* window renders opaque grey on the
/// Windows DWM, so a borderless monitor-sized window is used instead), then shown.
/// DEV code-freshness (Vite HMR doesn't reach the occluded overlay webview) is
/// handled by `hide_overlay_host` reloading AFTER each hide — reloading here made
/// every open eat a full webview boot (seconds), and it also auto-opened devtools.
/// The capture `overlay` hotkey bridge in `lib.rs` is its ONLY caller — Shift+C is
/// the only thing that shows this window. `overlay_go_live` deliberately does not
/// (see its own comment above for why), and nothing invokable from the frontend
/// does either: the handler registers `hide_overlay_host` and no show, and the
/// frontend holds no `core:window:allow-show`. Said plainly because this comment
/// used to claim Go-Live shared it, which sends a reader hunting for a show path
/// that was removed on purpose.
pub fn show_overlay_host(win: &tauri::WebviewWindow) {
    harden_capture_overlay(win);
    // Size to the chosen monitor when a pref is set; else preserve the prior
    // behavior (current monitor → primary). A transparent *fullscreen* window
    // renders opaque grey on the Windows DWM, so a borderless monitor-sized window
    // is used instead. If the chosen monitor was unplugged, fall back to primary
    // (silent — the stored pref is kept so it resumes on reconnect). Best-effort — a
    // monitor lookup miss just shows it at its previous geometry.
    let mon = match current_monitor_pref(&win.app_handle()) {
        Some(p) => resolve_monitor(&win.app_handle(), &p)
            .or_else(|| win.primary_monitor().ok().flatten()),
        None => win
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| win.primary_monitor().ok().flatten()),
    };
    if let Some(mon) = mon {
        let _ = win.set_position(*mon.position());
        let _ = win.set_size(*mon.size());
    }
    let _ = win.show();
}

/// `overlay_note_toast` — confirm a dictated scrim note saved. Invoked
/// unconditionally by the overlay ScrimViewer after every dictated-note save, and
/// fires the toast whether the overlay host is hidden OR open (user call
/// 2026-07-17: the confirmation is wanted even when the note lands in a visible
/// panel). The tiny `overlay-toast` window is hardened (topmost + non-activating +
/// capture-excluded, like the host) + made fully click-through, parked bottom-right
/// of the overlay monitor (same pref/fallback chain as `show_overlay_host`), shown,
/// and handed the text via the `overlay-note-toast` event. The toast webview owns
/// the dwell + fade-out, then calls `overlay_toast_done` to hide — the
/// `hide_overlay_host` animate-then-hide pattern.
#[tauri::command]
pub fn overlay_note_toast(app: AppHandle, text: String) -> Result<(), VaultError> {
    // Stash for the mount-time re-pull BEFORE show/emit — covers the show-before-
    // listen race (the emit can land before the hidden webview's listener attaches).
    *lock_pending() = Some(text.clone());
    if let Some(win) = app.get_webview_window("overlay-toast") {
        harden_capture_overlay(&win);
        let _ = win.set_ignore_cursor_events(true); // pure passive strip — never eats a click
        let mon = match current_monitor_pref(&app) {
            Some(p) => resolve_monitor(&app, &p).or_else(|| win.primary_monitor().ok().flatten()),
            None => win.primary_monitor().ok().flatten(),
        };
        // Park bottom-right of the monitor's WORK AREA (excludes the taskbar) so the
        // chip never tucks under it. `work_area` position/size are physical px.
        if let (Some(mon), Ok(sz)) = (mon, win.outer_size()) {
            let wa = mon.work_area();
            let margin = (16.0 * mon.scale_factor()) as i32;
            let _ = win.set_position(PhysicalPosition::new(
                wa.position.x + wa.size.width as i32 - sz.width as i32 - margin,
                wa.position.y + wa.size.height as i32 - sz.height as i32 - margin,
            ));
        }
        let _ = win.show();
        let _ = win.emit("overlay-note-toast", serde_json::json!({ "text": text }));
    }
    Ok(())
}

/// `overlay_toast_pending` — the `OverlayToastView` pulls this on mount to cover
/// the show-before-listen race (the `overlay-note-toast` emit can land before the
/// hidden webview's listener attaches). Returns + clears any stashed note text.
#[tauri::command]
pub fn overlay_toast_pending() -> Result<Option<String>, VaultError> {
    Ok(lock_pending().take())
}

/// `overlay_toast_done` — hide the toast window after its webview finished the
/// dwell + fade-out (mirrors `hide_overlay_host`). No-op if already hidden.
#[tauri::command]
pub fn overlay_toast_done(app: AppHandle) -> Result<(), VaultError> {
    *lock_pending() = None;
    if let Some(win) = app.get_webview_window("overlay-toast") {
        let _ = win.hide();
    }
    Ok(())
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
/// SF9 "include overlay" screenshot toggle — set every overlay window's display
/// affinity for one screenshot. `include=true` lifts the capture exclusion
/// (WDA_NONE) so the shot shows the panels; `include=false` asserts
/// WDA_EXCLUDEFROMCAPTURE so the shot is clean EVEN IN DEV (dev builds skip the
/// exclusion by default so the overlay stays Snipping-Tool-able for UI work —
/// per-shot both-ways keeps the toggle testable in dev without losing that).
/// [`reset_overlay_shot_affinity`] restores the build default after the shot;
/// `harden_capture_overlay`'s re-assert on each Shift+C show is the backstop.
#[cfg(windows)]
pub fn set_overlay_shot_affinity(app: &AppHandle, include: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };
    let affinity = if include { WDA_NONE } else { WDA_EXCLUDEFROMCAPTURE };
    for (label, win) in app.webview_windows() {
        if !label.starts_with("overlay") {
            continue;
        }
        if let Ok(hwnd) = win.hwnd() {
            // SAFETY: plain FFI on our own window's HWND.
            unsafe {
                let _ = SetWindowDisplayAffinity(hwnd, affinity);
            }
        }
    }
}
#[cfg(not(windows))]
pub fn set_overlay_shot_affinity(_app: &AppHandle, _include: bool) {}

/// Restore the build-default capture affinity after a screenshot: release =
/// excluded, dev = capturable (the Snipping Tool dev-skip).
pub fn reset_overlay_shot_affinity(app: &AppHandle) {
    set_overlay_shot_affinity(app, cfg!(debug_assertions));
}

pub fn harden_capture_overlay(win: &tauri::WebviewWindow) {
    let _ = win.set_always_on_top(true);
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
        };
        // Release-only: exclude the HUD from the capture stream. DEV skips it so the
        // overlay stays screenshot-able (Snipping Tool / PrintScreen) for UI work.
        #[cfg(not(debug_assertions))]
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
        if let Ok(hwnd) = win.hwnd() {
            unsafe {
                #[cfg(not(debug_assertions))]
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                // Clicks fire the buttons without stealing the game's focus.
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
            }
        }
    }
}
