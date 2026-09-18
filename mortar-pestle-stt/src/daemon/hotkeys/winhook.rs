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
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
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

/// The wire id for the SCRIM-note push-to-talk shortcut — the configurable second
/// bind. Unlike `dictate` this one is remappable (`can_configure: true`).
const DICTATE_SCRIM_ID: &str = "dictate_scrim";

/// The scrim-note virtual-key, remappable via the host's `set_scrim_key` op
/// (`0` unbinds it entirely). Defaults to F9 (`VK_F9 = 0x78`), the neighbour of the
/// fixed F8 dictate bind: nothing in the host called `set_scrim_key`, so a `0`
/// default left scrim dictation dead out of the box with no way to reach it.
///
/// An atomic, NOT a channel: the hook callback reads it on every keystroke and the
/// socket handler writes it, so a lock-free load is both the simplest wiring and
/// the only one safe inside a low-level hook callback.
static SCRIM_VK: AtomicU32 = AtomicU32::new(0x78);

// Modifier mask for the scrim chord — the same MOD_* values and the same
// GetAsyncKeyState gate the capture daemon's overlay chord already uses
// (mortar-pestle-capture winhook.rs). Mirrored rather than reinvented so the two
// hooks agree on what "Alt+X" means.
const MOD_CTRL: u32 = 1;
const MOD_ALT: u32 = 2;
const MOD_SHIFT: u32 = 4;

const VK_SHIFT: i32 = 0x10;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12; // Alt

/// Modifiers the scrim chord requires (MOD_* mask; 0 = a bare key, the old
/// behaviour). Without this a chord bind degraded to its bare key — Alt+Space
/// would have fired on every jump.
static SCRIM_MODS: AtomicU32 = AtomicU32::new(0);

/// Set the scrim-note chord (a Win32 virtual-key code; `0` unbinds) plus the
/// modifiers it requires. Called from the socket `set_scrim_key` handler.
pub fn set_scrim_vk(vk: u32, mods: u32) {
    SCRIM_VK.store(vk, Ordering::Release);
    SCRIM_MODS.store(mods, Ordering::Release);
    log::info!("winhook: scrim key set to {}", scrim_label());
}

/// The current scrim-note key (`0` = unbound) — read by `publish_snapshot`.
pub fn scrim_vk() -> u32 {
    SCRIM_VK.load(Ordering::Acquire)
}

/// `true` iff `vk` is currently down (GetAsyncKeyState high bit 0x8000).
#[inline]
fn key_down(vk: i32) -> bool {
    (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
}

/// `true` iff every modifier the live scrim chord requires is held. Extra
/// modifiers are tolerated, matching the capture daemon's gate.
#[inline]
fn scrim_mods_down() -> bool {
    let mods = SCRIM_MODS.load(Ordering::Acquire);
    (mods & MOD_CTRL == 0 || key_down(VK_CONTROL))
        && (mods & MOD_ALT == 0 || key_down(VK_MENU))
        && (mods & MOD_SHIFT == 0 || key_down(VK_SHIFT))
}

/// The live chord as text (`Alt+Space (hold)`), for the settings readout — never a
/// restated constant.
fn scrim_label() -> String {
    let vk = scrim_vk();
    if vk == 0 {
        return "unbound".to_owned();
    }
    let mods = SCRIM_MODS.load(Ordering::Acquire);
    let mut out = String::new();
    if mods & MOD_CTRL != 0 {
        out.push_str("Ctrl+");
    }
    if mods & MOD_ALT != 0 {
        out.push_str("Alt+");
    }
    if mods & MOD_SHIFT != 0 {
        out.push_str("Shift+");
    }
    out.push_str(&vk_label(vk));
    out
}

/// Which bind produced an edge — the drainer starts the matching dictation source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bind {
    Dictate,
    Scrim,
}

/// Press/release edges posted from the captureless hook callback to the async drainer.
/// `(bind, true)` = press, `(bind, false)` = release.
static EDGE_TX: OnceLock<mpsc::UnboundedSender<(Bind, bool)>> = OnceLock::new();

/// Debounce: a held key produces a WM_KEYDOWN storm; only the rising/falling edges
/// cross this gate, so dictation starts/stops exactly once per physical hold. One
/// flag PER BIND — they're independent holds and must not share a latch.
static KEY_DOWN: AtomicBool = AtomicBool::new(false);
static SCRIM_KEY_DOWN: AtomicBool = AtomicBool::new(false);

/// The hook thread's Win32 thread id — lets the drainer `PostThreadMessageW(WM_QUIT)`
/// to break the message pump for a clean unhook on shutdown. 0 until the thread is up.
static HOOK_TID: AtomicU32 = AtomicU32::new(0);

/// Install the hook (dedicated thread + message pump) and the async edge drainer.
/// Called once from `daemon::run` (within the tokio runtime).
pub fn spawn(ctx: ControlContext, rebind_rx: mpsc::UnboundedReceiver<()>) {
    publish_snapshot(&ctx);

    let (edge_tx, edge_rx) = mpsc::unbounded_channel::<(Bind, bool)>();
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
    log::info!(
        "winhook: WH_KEYBOARD_LL installed (dictate VK={DICTATE_VK:#x}, scrim VK={:#x}); message pump running",
        scrim_vk()
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

/// The low-level keyboard callback. Captureless, near-zero-work: debounce + post an
/// edge, then ALWAYS `CallNextHookEx` (never swallow the key → hold-over-game works).
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        // Resolve which bind this key is. The scrim VK is checked SECOND so that a
        // scrim key mistakenly set to F8 can never shadow the fixed dictate bind.
        let scrim_vk = SCRIM_VK.load(Ordering::Acquire);
        let bind = if kb.vkCode == DICTATE_VK {
            Some((Bind::Dictate, &KEY_DOWN))
        } else if scrim_vk != 0 && kb.vkCode == scrim_vk {
            // The modifier gate is checked on the PRESS branch only (below): a
            // release must fire even if the modifier was let go first, or the
            // latch strands and the mic never stops.
            Some((Bind::Scrim, &SCRIM_KEY_DOWN))
        } else {
            None
        };
        if let Some((bind, latch)) = bind {
            match wparam as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => {
                    // A chord bind only opens the mic while its modifiers are
                    // held; a bare bind (mask 0) passes this unconditionally.
                    if matches!(bind, Bind::Scrim) && !scrim_mods_down() {
                        // fall through to CallNextHookEx — not our press
                    } else if !latch.swap(true, Ordering::AcqRel) {
                        if let Some(tx) = EDGE_TX.get() {
                            let _ = tx.send((bind, true));
                        }
                    }
                }
                WM_KEYUP | WM_SYSKEYUP => {
                    if latch.swap(false, Ordering::AcqRel) {
                        if let Some(tx) = EDGE_TX.get() {
                            let _ = tx.send((bind, false));
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
    mut edge_rx: mpsc::UnboundedReceiver<(Bind, bool)>,
    mut rebind_rx: mpsc::UnboundedReceiver<()>,
) {
    loop {
        tokio::select! {
            edge = edge_rx.recv() => match edge {
                Some((bind, true)) => handle_press(&ctx, bind),
                Some((_, false)) => handle_release(&ctx),
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
fn handle_press(ctx: &ControlContext, bind: Bind) {
    // The bind chosen at PRESS decides the source for the whole hold — release is
    // just `stop`, so a session can never change its destination mid-utterance.
    let source = match bind {
        Bind::Dictate => DictationSource::Hotkey,
        Bind::Scrim => DictationSource::HotkeyScrim,
    };
    if ctx.is_dictating() {
        log::info!("winhook: {} press ignored — already dictating", source.as_str());
        return;
    }
    let model = ctx.last_model().unwrap_or_else(|| DEFAULT_MODEL.to_string());
    log::info!("winhook: {} press → start_dictation (model={model})", source.as_str());
    if let Err(e) = dictation::start(ctx, HOTKEY_CONN_ID, model, None, None, source) {
        log::warn!("winhook: dictate start failed: [{}] {}", e.code, e.message);
    }
}

/// RELEASE → stop the live dictation (flush + final). Idempotent. Mirrors
/// portal.rs::handle_release.
fn handle_release(ctx: &ControlContext) {
    log::info!("winhook: dictate release → stop_dictation");
    dictation::stop(ctx);
}

/// Human label for a Win32 virtual-key, for the snapshot's `trigger_description`.
/// Covers F1-F24 (the realistic push-to-talk range) and printable ASCII; anything
/// else falls back to hex, which is still unambiguous in the UI.
fn vk_label(vk: u32) -> String {
    match vk {
        0x70..=0x87 => format!("F{}", vk - 0x6F), // VK_F1 = 0x70 … VK_F24 = 0x87
        0x30..=0x39 | 0x41..=0x5A => ((vk as u8) as char).to_string(), // 0-9, A-Z
        0x20 => "Space".to_owned(),
        other => format!("VK {other:#04x}"),
    }
}

/// Re-publish the snapshot after the scrim bind changes, so the Settings row
/// reflects the new key without a daemon restart.
pub fn republish(ctx: &ControlContext) {
    publish_snapshot(ctx);
}

/// Publish the trigger snapshot so the host renders the push-to-talk rows.
/// `can_configure:true` — the scrim bind is remappable; `dictate` stays fixed at F8.
fn publish_snapshot(ctx: &ControlContext) {
    let snap = HotkeysSnapshot {
        bound: true,
        portal_version: 0, // no portal on Windows
        can_configure: true, // the SCRIM bind is remappable (dictate stays fixed)
        shortcuts: vec![
            Shortcut {
                id: DICTATE_ID.to_owned(),
                description: "Push-to-talk dictation".to_owned(),
                trigger_description: "F8 (hold)".to_owned(),
                reserved: false,
            },
            Shortcut {
                id: DICTATE_SCRIM_ID.to_owned(),
                description: "Push-to-talk scrim note".to_owned(),
                trigger_description: match scrim_vk() {
                    0 => "unbound".to_owned(),
                    _ => format!("{} (hold)", scrim_label()),
                },
                reserved: false,
            },
        ],
        last_error: None,
    };
    ctx.set_hotkeys(snap.clone());
    if let Ok(data) = serde_json::to_value(&snap) {
        let _ = ctx.events.send(Event { event: "hotkeys".to_string(), data });
    }
}
