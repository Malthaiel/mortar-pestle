//! Windows global capture hotkeys via a WH_KEYBOARD_LL low-level keyboard hook — the
//! Windows arm of `hotkeys` (Game Capture SF6), replacing the Linux ashpd
//! GlobalShortcuts portal. Reuses the STT winhook threading model
//! ([[project-iskariel-winhook-hold-to-talk]]): a captureless `extern "system"`
//! callback the OS invokes under a hard ~300 ms budget does the MINIMUM (debounce the
//! held-key auto-repeat, post an edge to a channel). It passes keys through via
//! `CallNextHookEx`, EXCEPT it swallows the held `C` while the overlay is shown so the
//! Shift+C peek never leaks into the focused window/game (Ctrl+Alt+R still passes
//! through). A dedicated
//! `std::thread` owns the hook + a `GetMessage` pump (an LL hook only fires while its
//! installing thread pumps messages); a tokio task drains the edges onto the SAME
//! `EngineCmd` path the socket verbs use, exactly like the Linux `portal.rs`.
//!
//! Extended from STT's single F8 to capture's modifier chords (FIXED in v1,
//! `can_configure:false`):
//!   - **record** (Ctrl+Alt+R): toggle StartClip/StopClip on the authoritative state.
//!   - **overlay** (Shift+C, hold): emit the `overlay` wire event (press = show,
//!     release = hide) the host bridges to `overlay-capture` (SF9 consumes it).
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

/// Install the hook (dedicated thread + message pump) + the async edge drainer. Called
/// once from `daemon::run` (within the tokio runtime).
pub fn spawn(
    engine: Arc<Mutex<Engine>>,
    cmd_tx: std::sync::mpsc::Sender<EngineCmd>,
    event_tx: mpsc::UnboundedSender<EngineEvent>,
    events_tx: broadcast::Sender<Event>,
    rebind_rx: mpsc::UnboundedReceiver<()>,
) {
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
                } else if vk == VK_C {
                    if !C_DOWN.swap(true, Ordering::AcqRel) && key_down(VK_SHIFT) {
                        // Shift+C down → show the overlay (held).
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
                } else if vk == VK_C
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
                // No in-app remap on Windows v1 — the chords are fixed.
                Some(()) => log::info!("winhook: rebind requested but Windows chords are fixed (Ctrl+Alt+R / Shift+C)"),
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
    log::info!("winhook: overlay {} (Shift+C)", if show { "show" } else { "hide" });
    let _ = events_tx.send(Event {
        event: "overlay".to_string(),
        data: serde_json::json!({ "show": show }),
    });
}

/// Overwrite the engine's `HotkeysSnapshot` (`bound:true`, the two active chords +
/// the two reserved slots) so `get_state` reflects the live binds; emit `StateChanged`
/// so every client re-renders. `can_configure:false` surfaces that Windows v1 cannot
/// remap (not hidden), mirroring the STT winhook.
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
                    trigger_description: "Shift+C (hold)".to_owned(),
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
