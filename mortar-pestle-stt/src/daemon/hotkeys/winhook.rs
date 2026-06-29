//! Windows push-to-talk via a WH_KEYBOARD_LL low-level keyboard hook — the Windows
//! arm of `hotkeys` (STT Windows port SF5). Mirrors portal.rs's hold-to-talk
//! contract (press → dictation::start, release → dictation::stop; ONE dictation code
//! path shared with the socket verbs) but sourced from a global Win32 hook instead of
//! the XDG GlobalShortcuts portal — no D-Bus, no `.desktop`.
//!
//! Threading model (the careful part): a WH_KEYBOARD_LL callback is a captureless
//! `extern "system"` C function the OS invokes on the installing thread under a hard
//! ~300 ms budget, so it does the MINIMUM — debounce the held-key auto-repeat, post a
//! press/release edge to a channel — and ALWAYS returns `CallNextHookEx` (default
//! passthrough: the key still reaches the focused game). A dedicated `std::thread`
//! owns the hook plus a `GetMessage` pump (an LL hook only fires while its installing
//! thread pumps messages); a tokio task drains the edges and drives dictation on the
//! daemon runtime, exactly like portal.rs's `handle_press`/`handle_release`.
//!
//! Windows v1 binds a FIXED trigger (F8) — there is no in-app remap yet (the snapshot
//! reports `can_configure:false`); remapping is a follow-up. Surfaced, not hidden.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;

use tokio::sync::mpsc;

use crate::daemon::dictation::{self, DictationSource};
use crate::daemon::engine::ControlContext;
use crate::models::DEFAULT_MODEL;
use crate::protocol::{Event, HotkeysSnapshot, Shortcut};

use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
    WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// Reserved connection id for hotkey-driven dictation (real socket clients start at 1,
/// so 0 can never collide) — mirrors portal.rs.
const HOTKEY_CONN_ID: u64 = 0;

/// The push-to-talk virtual-key: F8 (`VK_F8 = 0x77`). A default that rarely collides
/// with game binds; FIXED on Windows v1 (no in-app remap yet).
const DICTATE_VK: u32 = 0x77;

/// The wire id for the single push-to-talk shortcut (matches the Linux `DICTATE_ID` so
/// the host UI keys the snapshot identically across platforms).
const DICTATE_ID: &str = "dictate";

/// Press/release edges posted from the captureless hook callback to the async drainer.
/// `true` = press, `false` = release.
static EDGE_TX: OnceLock<mpsc::UnboundedSender<bool>> = OnceLock::new();

/// Debounce: a held key produces a WM_KEYDOWN storm; only the rising/falling edges
/// cross this gate, so dictation starts/stops exactly once per physical hold.
static KEY_DOWN: AtomicBool = AtomicBool::new(false);

/// The hook thread's Win32 thread id — lets the drainer `PostThreadMessageW(WM_QUIT)`
/// to break the message pump for a clean unhook on shutdown. 0 until the thread is up.
static HOOK_TID: AtomicU32 = AtomicU32::new(0);

/// Install the hook (dedicated thread + message pump) and the async edge drainer.
/// Called once from `daemon::run` (within the tokio runtime).
pub fn spawn(ctx: ControlContext, rebind_rx: mpsc::UnboundedReceiver<()>) {
    publish_snapshot(&ctx);

    let (edge_tx, edge_rx) = mpsc::unbounded_channel::<bool>();
    // First-wins: the daemon spawns hotkeys exactly once, so set() always succeeds.
    // Set BEFORE the hook thread starts so the callback never sees an empty cell.
    let _ = EDGE_TX.set(edge_tx);

    std::thread::Builder::new()
        .name("stt-winhook".to_owned())
        .spawn(hook_thread)
        .expect("spawn WH_KEYBOARD_LL hook thread");

    tokio::spawn(drain(ctx, edge_rx, rebind_rx));
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
        log::error!("winhook: SetWindowsHookExW(WH_KEYBOARD_LL) failed — push-to-talk disabled");
        return;
    }
    HOOK_TID.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
    log::info!("winhook: WH_KEYBOARD_LL installed (VK={DICTATE_VK:#x}); message pump running");

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

/// The low-level keyboard callback. Captureless, near-zero-work: debounce + post an
/// edge, then ALWAYS `CallNextHookEx` (never swallow the key → hold-over-game works).
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        if kb.vkCode == DICTATE_VK {
            match wparam as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => {
                    if !KEY_DOWN.swap(true, Ordering::AcqRel) {
                        if let Some(tx) = EDGE_TX.get() {
                            let _ = tx.send(true);
                        }
                    }
                }
                WM_KEYUP | WM_SYSKEYUP => {
                    if KEY_DOWN.swap(false, Ordering::AcqRel) {
                        if let Some(tx) = EDGE_TX.get() {
                            let _ = tx.send(false);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// Drain press/release edges onto the shared dictation path; on shutdown (rebind
/// channel closed) post WM_QUIT to the hook thread for a clean unhook.
async fn drain(
    ctx: ControlContext,
    mut edge_rx: mpsc::UnboundedReceiver<bool>,
    mut rebind_rx: mpsc::UnboundedReceiver<()>,
) {
    loop {
        tokio::select! {
            edge = edge_rx.recv() => match edge {
                Some(true) => handle_press(&ctx),
                Some(false) => handle_release(&ctx),
                None => break, // hook thread / sender gone
            },
            msg = rebind_rx.recv() => match msg {
                // No in-app remap on Windows v1 — the trigger is fixed (F8).
                Some(()) => log::info!("winhook: rebind requested but Windows v1 trigger is fixed (F8)"),
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

/// PRESS → start a hotkey-sourced dictation with the last-loaded model (config-less
/// daemon; falls back to the registry default). `busy` is logged + ignored — a hotkey
/// cannot error-respond. Mirrors portal.rs::handle_press.
fn handle_press(ctx: &ControlContext) {
    if ctx.is_dictating() {
        log::info!("winhook: dictate press ignored — already dictating");
        return;
    }
    let model = ctx.last_model().unwrap_or_else(|| DEFAULT_MODEL.to_string());
    log::info!("winhook: dictate press → start_dictation (model={model})");
    if let Err(e) = dictation::start(ctx, HOTKEY_CONN_ID, model, None, None, None, DictationSource::Hotkey) {
        log::warn!("winhook: dictate start failed: [{}] {}", e.code, e.message);
    }
}

/// RELEASE → stop the live dictation (flush + final). Idempotent. Mirrors
/// portal.rs::handle_release.
fn handle_release(ctx: &ControlContext) {
    log::info!("winhook: dictate release → stop_dictation");
    dictation::stop(ctx);
}

/// Publish the fixed-trigger snapshot so the host renders the push-to-talk row.
/// `can_configure:false` surfaces that Windows v1 cannot remap (not hidden).
fn publish_snapshot(ctx: &ControlContext) {
    let snap = HotkeysSnapshot {
        bound: true,
        portal_version: 0, // no portal on Windows
        can_configure: false,
        shortcuts: vec![Shortcut {
            id: DICTATE_ID.to_owned(),
            description: "Push-to-talk dictation".to_owned(),
            trigger_description: "F8 (hold)".to_owned(),
            reserved: false,
        }],
        last_error: None,
    };
    ctx.set_hotkeys(snap.clone());
    if let Ok(data) = serde_json::to_value(&snap) {
        let _ = ctx.events.send(Event { event: "hotkeys".to_string(), data });
    }
}
