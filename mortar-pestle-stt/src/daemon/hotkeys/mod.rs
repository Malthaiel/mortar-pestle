//! Engine-owned GlobalShortcuts push-to-talk (Voice Transcription Phase 5 SF5).
//!
//! Installs the host `.desktop`, then spawns the portal flow (`portal`) on the
//! daemon's own tokio runtime. The portal task holds a `ControlContext`, so a
//! `dictate` hold drives the SAME `dictation::start`/`stop` path as the
//! `start_dictation`/`stop_dictation` socket verbs — one dictation code path, two
//! front-ends (global hotkey + in-app button). Cloned from mortar-pestle-capture's
//! `daemon::hotkeys`, diverging on: the STT app-id, a single hold-to-talk shortcut,
//! `Deactivated` (release) handling, and running on the daemon runtime (no separate
//! portal runtime — the daemon already is one).

#[cfg(target_os = "linux")]
mod portal;
#[cfg(target_os = "linux")]
pub mod state;
#[cfg(target_os = "windows")]
mod winhook;

use tokio::sync::mpsc;

use crate::daemon::engine::ControlContext;

/// Launch the global push-to-talk listener on the daemon's tokio runtime. MUST be
/// called from within the runtime (`daemon::run`'s `block_on`). `rebind_rx` is driven
/// by the `rebind_hotkeys` socket verb. Per-OS: Linux installs the `.desktop` + runs
/// the GlobalShortcuts portal flow; Windows installs a WH_KEYBOARD_LL low-level hook.
#[cfg(target_os = "linux")]
pub fn spawn(ctx: ControlContext, rebind_rx: mpsc::UnboundedReceiver<()>) {
    state::install_desktop_file();
    tokio::spawn(portal::run(ctx, rebind_rx));
}

#[cfg(target_os = "windows")]
pub fn spawn(ctx: ControlContext, rebind_rx: mpsc::UnboundedReceiver<()>) {
    winhook::spawn(ctx, rebind_rx);
}

/// Other platforms have no global push-to-talk backend — a no-op keeps `daemon::run`'s
/// unconditional call site compiling.
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub fn spawn(_ctx: ControlContext, _rebind_rx: mpsc::UnboundedReceiver<()>) {}
