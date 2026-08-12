//! Windows global capture hotkeys via a WH_KEYBOARD_LL low-level keyboard hook — the
//! Windows arm of `hotkeys` (Game Capture SF6), replacing the Linux ashpd
//! GlobalShortcuts portal. Reuses the STT winhook threading model
//! ([[project-mortar-pestle-winhook-hold-to-talk]]): a captureless `extern "system"`
//! callback the OS invokes under a hard ~300 ms budget does the MINIMUM (debounce the
//! held-key auto-repeat, post an edge to a channel). It passes keys through via
//! `CallNextHookEx`, EXCEPT it swallows the held `C` while the overlay is shown so the
//! Shift+C peek never leaks into the focused window/game (Ctrl+Alt+R still passes
//! through). A dedicated
//! `std::thread` owns the hook + a `GetMessage` pump (an LL hook only fires while its
//! installing thread pumps messages); a tokio task drains the edges onto the SAME
//! `EngineCmd` path the socket verbs use, exactly like the Linux `portal.rs`.
//!
//! Extended from STT's single F8 to capture's modifier chords:
//!   - **record** (Ctrl+Alt+R): toggle StartClip/StopClip on the authoritative state.
//!     FIXED.
//!   - **overlay** (Shift+C by default, hold): emit the `overlay` wire event (press =
//!     show, release = hide) the host bridges to `overlay-capture` (SF9 consumes it).
//!     REBINDABLE — the host pushes the user's chord via the `set_overlay_key` socket
//!     verb (Settings ▸ Keybinds ▸ Capture), held in memory only, so the push repeats
//!     on every (re)connect exactly like the STT scrim key.
//! Modifier state is read in the callback via `GetAsyncKeyState` on the R/C keydown.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc};

use crate::daemon::engine::{EngineCmd, EngineEvent};
use crate::daemon::protocol::{Event, HotkeysSnapshot, Shortcut};
use crate::daemon::state::{Engine, EngineState};

use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
    WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

// Virtual-key codes (hardcoded to avoid windows-sys VK newtype churn). `key_down` takes
// the i32 form GetAsyncKeyState wants; the keydown match compares the u32 `vkCode`.
const VK_SHIFT: i32 = 0x10;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12; // Alt
const VK_C: u32 = 0x43;
const VK_R: u32 = 0x52;

/// Modifier bits for the overlay chord (wire contract with `set_overlay_key`).
const MOD_CTRL: u32 = 1;
const MOD_ALT: u32 = 2;
const MOD_SHIFT: u32 = 4;

/// An edge posted from the captureless hook callback to the async drainer.
#[derive(Clone, Copy)]
enum HotkeyEdge {
    /// Ctrl+Alt+R pressed — toggle recording on the authoritative state.
    RecordToggle,
    /// Shift+C pressed — show the capture overlay.
    OverlayShow,
    /// C released after a show — hide the capture overlay.
    OverlayHide,
}

/// Edges from the captureless callback to the async drainer (set once before the hook
/// thread starts, so the callback never sees an empty cell).
static EDGE_TX: OnceLock<mpsc::UnboundedSender<HotkeyEdge>> = OnceLock::new();
/// Per-chord debounce against the held-key WM_KEYDOWN auto-repeat storm — only the
/// rising/falling edges of R and C cross these gates.
static R_DOWN: AtomicBool = AtomicBool::new(false);
static C_DOWN: AtomicBool = AtomicBool::new(false);
/// Tracks whether the overlay is currently shown, so a C-up only emits a hide if the
/// matching C-down actually showed it (Shift was held).
static OVERLAY_SHOWN: AtomicBool = AtomicBool::new(false);
/// The hook thread's Win32 thread id — lets the drainer `PostThreadMessageW(WM_QUIT)`
/// to break the message pump for a clean unhook on shutdown. 0 until the thread is up.
static HOOK_TID: AtomicU32 = AtomicU32::new(0);
/// The LIVE overlay chord, read by the hook callback on every keydown so a rebind
/// takes effect without reinstalling the hook. Defaults to the historical Shift+C;
/// the host pushes the user's binding via the `set_overlay_key` socket verb on every
/// (re)connect (Settings ▸ Keybinds ▸ Capture is the source of truth, mirroring the
/// STT scrim key). Record (Ctrl+Alt+R) stays fixed.
static OVERLAY_VK: AtomicU32 = AtomicU32::new(VK_C);
static OVERLAY_MODS: AtomicU32 = AtomicU32::new(MOD_SHIFT);
/// Engine + event sender, kept so a rebind can re-publish the hotkeys snapshot (the
/// settings readout shows the LIVE chord, never a restated constant).
static SNAP: OnceLock<(Arc<Mutex<Engine>>, mpsc::UnboundedSender<EngineEvent>)> = OnceLock::new();

/// Rebind the overlay chord (socket verb `set_overlay_key`). `mods` is the MOD_* mask;
/// a `vk` of 0 is rejected by the caller. Re-publishes the snapshot so every client
/// re-renders with the new trigger text.
pub fn set_overlay_key(vk: u32, mods: u32) {
    OVERLAY_VK.store(vk, Ordering::Release);
    OVERLAY_MODS.store(mods, Ordering::Release);
    log::info!("winhook: overlay chord rebound to {}", chord_label());
    if let Some((engine, event_tx)) = SNAP.get() {
        publish_snapshot(engine, event_tx);
    }
}

/// Human-readable form of the live overlay chord, e.g. `Shift+C (hold)`.
fn chord_label() -> String {
    let mods = OVERLAY_MODS.load(Ordering::Acquire);
    let mut s = String::new();
    if mods & MOD_CTRL != 0 {
        s.push_str("Ctrl+");
    }
    if mods & MOD_ALT != 0 {
        s.push_str("Alt+");
    }
    if mods & MOD_SHIFT != 0 {
        s.push_str("Shift+");
    }
    let vk = OVERLAY_VK.load(Ordering::Acquire);
    match vk {
        0x70..=0x87 => s.push_str(&format!("F{}", vk - 0x6F)),
        0x30..=0x5A => s.push(vk as u8 as char), // digits + letters are their ASCII code
        other => s.push_str(&format!("VK_{other:#04X}")),
    }
    s.push_str(" (hold)");
    s
}

/// Install the hook (dedicated thread + message pump) + the async edge drainer. Called
/// once from `daemon::run` (within the tokio runtime).
pub fn spawn(
    engine: Arc<Mutex<Engine>>,
    cmd_tx: std::sync::mpsc::Sender<EngineCmd>,
    event_tx: mpsc::UnboundedSender<EngineEvent>,
    events_tx: broadcast::Sender<Event>,
    rebind_rx: mpsc::UnboundedReceiver<()>,
) {
    // First-wins, like EDGE_TX: lets `set_overlay_key` re-publish after a rebind.
    let _ = SNAP.set((Arc::clone(&engine), event_tx.clone()));
    publish_snapshot(&engine, &event_tx);

    let (edge_tx, edge_rx) = mpsc::unbounded_channel::<HotkeyEdge>();
    // First-wins: the daemon spawns hotkeys exactly once. Set BEFORE the hook thread.
    let _ = EDGE_TX.set(edge_tx);

    std::thread::Builder::new()
        .name("capture-winhook".to_owned())
        .spawn(hook_thread)
        .expect("spawn WH_KEYBOARD_LL hook thread");

    tokio::spawn(drain(engine, cmd_tx, events_tx, edge_rx, rebind_rx));
}

/// The dedicated hook thread: install WH_KEYBOARD_LL, then pump messages until a posted
/// `WM_QUIT` (shutdown). The pump is what services the hook callback.
fn hook_thread() {
    // SAFETY: a standard Win32 LL-hook install. `hook_proc` is a valid captureless
    // `extern "system"` fn; the module handle is this process's base image.
    let hook = unsafe {
        let hmod = GetModuleHandleW(std::ptr::null());
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hmod, 0)
    };
    if hook.is_null() {
        log::error!("winhook: SetWindowsHookExW(WH_KEYBOARD_LL) failed — capture hotkeys disabled");
        return;
    }
    HOOK_TID.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
    log::info!(
        "winhook: WH_KEYBOARD_LL installed (Ctrl+Alt+R record, Shift+C overlay); message pump running"
    );

    // Message pump — required for the LL hook to fire. GetMessageW returns 0 on
    // WM_QUIT, >0 for a message, -1 on error; any non-positive result ends the pump.
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        loop {
            let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
            if r <= 0 {
                break;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        UnhookWindowsHookEx(hook);
    }
    log::info!("winhook: message pump ended, hook removed");
}

/// `true` iff `vk` is currently down (GetAsyncKeyState high bit 0x8000).
#[inline]
fn key_down(vk: i32) -> bool {
    (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
}

/// `true` iff every modifier the live overlay chord requires is currently held.
/// Extra modifiers are tolerated, exactly as the fixed Shift+C gate was.
#[inline]
fn overlay_mods_down() -> bool {
    let mods = OVERLAY_MODS.load(Ordering::Acquire);
    (mods & MOD_CTRL == 0 || key_down(VK_CONTROL))
        && (mods & MOD_ALT == 0 || key_down(VK_MENU))
        && (mods & MOD_SHIFT == 0 || key_down(VK_SHIFT))
}

#[inline]
fn post(edge: HotkeyEdge) {
    if let Some(tx) = EDGE_TX.get() {
        let _ = tx.send(edge);
    }
}

/// The low-level keyboard callback. Captureless, near-zero-work: on the rising/falling
/// edges of R / C, check the chord's modifiers + post an edge. Passes keys through via
/// `CallNextHookEx`, EXCEPT the held `C` is swallowed while the overlay is shown (so the
/// Shift+C peek never leaks into the focused window/game); Ctrl+Alt+R always passes through.
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        let vk = kb.vkCode;
        match wparam as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                if vk == VK_R {
                    // Rising edge only (debounce). Record toggles on Ctrl+Alt+R.
                    if !R_DOWN.swap(true, Ordering::AcqRel) && key_down(VK_CONTROL) && key_down(VK_MENU) {
                        post(HotkeyEdge::RecordToggle);
                    }
                } else if vk == OVERLAY_VK.load(Ordering::Acquire) {
                    if !C_DOWN.swap(true, Ordering::AcqRel) && overlay_mods_down() {
                        // Overlay chord down → show the overlay (held).
                        OVERLAY_SHOWN.store(true, Ordering::Release);
                        post(HotkeyEdge::OverlayShow);
                    }
                    // Overlay session active → swallow C (down + auto-repeat) so the
                    // held key never leaks into the focused window/game.
                    if OVERLAY_SHOWN.load(Ordering::Acquire) {
                        return 1;
                    }
                }
            }
            WM_KEYUP | WM_SYSKEYUP => {
                if vk == VK_R {
                    R_DOWN.store(false, Ordering::Release);
                } else if vk == OVERLAY_VK.load(Ordering::Acquire)
                    && C_DOWN.swap(false, Ordering::AcqRel)
                    && OVERLAY_SHOWN.swap(false, Ordering::AcqRel)
                {
                    // C up after a show → hide the overlay, and swallow the matching
                    // key-up so the focused window/game never sees a stray C release.
                    post(HotkeyEdge::OverlayHide);
                    return 1;
                }
            }
            _ => {}
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// Drain hotkey edges onto the capture command path; on shutdown (rebind channel
/// closed) post WM_QUIT to the hook thread for a clean unhook.
async fn drain(
    engine: Arc<Mutex<Engine>>,
    cmd_tx: std::sync::mpsc::Sender<EngineCmd>,
    events_tx: broadcast::Sender<Event>,
    mut edge_rx: mpsc::UnboundedReceiver<HotkeyEdge>,
    mut rebind_rx: mpsc::UnboundedReceiver<()>,
) {
    loop {
        tokio::select! {
            edge = edge_rx.recv() => match edge {
                Some(HotkeyEdge::RecordToggle) => handle_record(&engine, &cmd_tx),
                Some(HotkeyEdge::OverlayShow) => emit_overlay(&events_tx, true),
                Some(HotkeyEdge::OverlayHide) => emit_overlay(&events_tx, false),
                None => break, // hook thread / sender gone
            },
            msg = rebind_rx.recv() => match msg {
                // No KDE-style portal UI on Windows — the overlay chord is rebound
                // through `set_overlay_key`, and record is fixed.
                Some(()) => log::info!("winhook: portal rebind N/A on Windows (overlay uses set_overlay_key; record is fixed)"),
                None => break, // all rebind senders dropped → daemon shutting down
            },
        }
    }
    // Best-effort clean unhook (the OS also reclaims the hook on process exit).
    let tid = HOOK_TID.load(Ordering::Acquire);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, 0, 0);
        }
    }
}

/// Toggle recording on the AUTHORITATIVE state via the SAME `EngineCmd` path as the
/// socket verbs + the in-app button — one capture code path, three front-ends.
fn handle_record(engine: &Arc<Mutex<Engine>>, cmd_tx: &std::sync::mpsc::Sender<EngineCmd>) {
    let recording = {
        let e = engine.lock().expect("engine mutex poisoned");
        matches!(e.state, EngineState::Recording { .. })
    };
    let cmd = if recording { EngineCmd::StopClip } else { EngineCmd::StartClip { game: None } };
    log::info!("winhook: record → {}", if recording { "StopClip" } else { "StartClip" });
    if cmd_tx.send(cmd).is_err() {
        log::error!("winhook: capture thread unreachable — record command dropped");
    }
}

/// Broadcast the `overlay` wire event (`{"show": bool}`). Overlay visibility is NOT
/// engine state, so it bypasses `EngineEvent` and rides the wire bus straight to the
/// host bridge (SF9), which shows/hides the always-on-top `overlay-capture` window.
fn emit_overlay(events_tx: &broadcast::Sender<Event>, show: bool) {
    log::info!("winhook: overlay {} ({})", if show { "show" } else { "hide" }, chord_label());
    let _ = events_tx.send(Event {
        event: "overlay".to_string(),
        data: serde_json::json!({ "show": show }),
    });
}

/// Overwrite the engine's `HotkeysSnapshot` (`bound:true`, the two active chords +
/// the two reserved slots) so `get_state` reflects the live binds; emit `StateChanged`
/// so every client re-renders. `can_configure:false` means "no PORTAL rebind UI" (a
/// KDE concept); the overlay chord is rebound from Settings ▸ Keybinds via
/// `set_overlay_key`, and this re-publishes so the readout shows the live trigger.
fn publish_snapshot(engine: &Arc<Mutex<Engine>>, event_tx: &mpsc::UnboundedSender<EngineEvent>) {
    {
        let mut e = engine.lock().expect("engine mutex poisoned");
        e.hotkeys = HotkeysSnapshot {
            bound: true,
            portal_version: 0, // no portal on Windows
            can_configure: false,
            shortcuts: vec![
                Shortcut {
                    id: "record".to_owned(),
                    description: "Start or stop recording".to_owned(),
                    trigger_description: "Ctrl+Alt+R".to_owned(),
                    reserved: false,
                },
                Shortcut {
                    id: "overlay".to_owned(),
                    description: "Show the in-game capture overlay (hold)".to_owned(),
                    trigger_description: chord_label(),
                    reserved: false,
                },
                Shortcut {
                    id: "save_replay".to_owned(),
                    description: "Save instant replay".to_owned(),
                    trigger_description: "—".to_owned(),
                    reserved: true,
                },
                Shortcut {
                    id: "screenshot".to_owned(),
                    description: "Capture a screenshot".to_owned(),
                    trigger_description: "—".to_owned(),
                    reserved: true,
                },
            ],
            last_error: None,
        };
    }
    let _ = event_tx.send(EngineEvent::StateChanged);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The chord label is what the settings readout shows, so a rebind that renders
    /// wrong is a silent lie about which key is live. Covers the three vk ranges.
    #[test]
    fn chord_label_renders_the_live_binding() {
        // Serialized within one test: the atomics are process-global.
        OVERLAY_VK.store(VK_C, Ordering::Release);
        OVERLAY_MODS.store(MOD_SHIFT, Ordering::Release);
        assert_eq!(chord_label(), "Shift+C (hold)");

        OVERLAY_VK.store(0x78, Ordering::Release); // VK_F9
        OVERLAY_MODS.store(0, Ordering::Release);
        assert_eq!(chord_label(), "F9 (hold)");

        OVERLAY_VK.store(0x58, Ordering::Release); // 'X'
        OVERLAY_MODS.store(MOD_CTRL | MOD_ALT, Ordering::Release);
        assert_eq!(chord_label(), "Ctrl+Alt+X (hold)");

        // Restore the shipped default so no other test sees the mutation.
        OVERLAY_VK.store(VK_C, Ordering::Release);
        OVERLAY_MODS.store(MOD_SHIFT, Ordering::Release);
    }
}
