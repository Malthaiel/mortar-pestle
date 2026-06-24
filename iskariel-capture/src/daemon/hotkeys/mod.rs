//! Engine-owned GlobalShortcuts hotkeys (sub-plan 5 SF3).
//!
//! Installs the host `.desktop`, then spawns the portal flow (`portal`) on the
//! process-persistent portal runtime. The portal task holds a clone of the
//! control→capture command sender, so a `record` hotkey drives the EXACT same
//! `EngineCmd` path as the `start_clip`/`stop_clip` socket verbs — one capture
//! code path, two front-ends (hotkey + in-app button).

#[cfg(target_os = "linux")]
mod portal;
#[cfg(target_os = "linux")]
pub mod state;
#[cfg(windows)]
mod winhook;

use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc};

use crate::daemon::engine::{EngineCmd, EngineEvent};
use crate::daemon::protocol::Event;
use crate::daemon::state::Engine;

#[cfg(target_os = "linux")]
type CmdTx = pipewire::channel::Sender<EngineCmd>;

/// Install the `.desktop` + launch the hotkeys portal task on the persistent portal
/// runtime (Linux). Non-blocking: returns immediately; the task runs for the daemon's
/// life. `rebind_rx` is driven by the `rebind_hotkeys` socket verb (`ControlContext::rebind`).
#[cfg(target_os = "linux")]
pub fn spawn(
    engine: Arc<Mutex<Engine>>,
    cmd_tx: CmdTx,
    event_tx: mpsc::UnboundedSender<EngineEvent>,
    events_tx: broadcast::Sender<Event>,
    rebind_rx: mpsc::UnboundedReceiver<()>,
) {
    state::install_desktop_file();
    crate::capture::portal::portal_runtime().spawn(portal::run(engine, cmd_tx, event_tx, events_tx, rebind_rx));
}

/// Install the WH_KEYBOARD_LL global-hotkey hook (Windows, SF6). `cmd_tx` is the
/// `std::sync::mpsc::Sender` the pacer drains; the hook toggles recording + emits the
/// overlay wire event. Mirrors the Linux signature (only the cmd transport differs).
#[cfg(windows)]
pub fn spawn(
    engine: Arc<Mutex<Engine>>,
    cmd_tx: std::sync::mpsc::Sender<EngineCmd>,
    event_tx: mpsc::UnboundedSender<EngineEvent>,
    events_tx: broadcast::Sender<Event>,
    rebind_rx: mpsc::UnboundedReceiver<()>,
) {
    winhook::spawn(engine, cmd_tx, event_tx, events_tx, rebind_rx);
}
