//! The GlobalShortcuts portal flow (sub-plan 5 SF3): host-app registration →
//! CreateSession → BindShortcuts → ListShortcuts → a forever loop over the
//! Activated / ShortcutsChanged signals + the in-app rebind channel.
//!
//! Runs as a spawned task on the process-persistent `capture::portal::portal_runtime`
//! (whose zbus connection driver must outlive every clip — see that module). The
//! `record` activation drives the SAME `EngineCmd` path as the `start_clip`/
//! `stop_clip` socket verbs, so a hotkey and the in-app button are byte-identical
//! downstream. Best-effort throughout: host registration failing is non-fatal (the
//! shortcuts still bind + fire); only a missing session/proxy aborts the task.

use std::sync::{Arc, Mutex};

use ashpd::desktop::global_shortcuts::GlobalShortcuts;
use futures_util::StreamExt;
use tokio::sync::{broadcast, mpsc};

use crate::daemon::engine::{EngineCmd, EngineEvent};
use crate::daemon::hotkeys::state;
use crate::daemon::protocol::{Event, HotkeysSnapshot, Shortcut};
use crate::daemon::state::{Engine, EngineState};

type CmdTx = pipewire::channel::Sender<EngineCmd>;
type EventTx = mpsc::UnboundedSender<EngineEvent>;

/// The whole hotkeys lifecycle. Returns on a fatal setup error (logged + recorded
/// in the snapshot) or when the daemon shuts down (the rebind channel closes).
pub async fn run(
    engine: Arc<Mutex<Engine>>,
    cmd_tx: CmdTx,
    event_tx: EventTx,
    events_tx: broadcast::Sender<Event>,
    mut rebind_rx: mpsc::UnboundedReceiver<()>,
) {
    // One shared session-bus connection: host registration + the GlobalShortcuts
    // session MUST ride the same D-Bus peer for the registration to take effect.
    let conn = match ashpd::zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => return fail(&engine, &event_tx, format!("session bus: {e}")),
    };

    // Best-effort host-app registration (a stable app-id ⇒ bindings persist across
    // restarts without re-prompting). The dash-free APP_ID passes ashpd's typed
    // `AppID`; a non-sandboxed binary is registered by its live D-Bus peer.
    match state::APP_ID.parse::<ashpd::AppID>() {
        Ok(app_id) => match ashpd::register_host_app_with_connection(conn.clone(), app_id).await {
            Ok(()) => log::info!("hotkeys: registered host app-id {}", state::APP_ID),
            Err(e) => log::warn!("hotkeys: host registration failed (non-fatal): {e:?}"),
        },
        Err(e) => log::warn!("hotkeys: APP_ID rejected by ashpd (non-fatal): {e:?}"),
    }

    let gs = match GlobalShortcuts::with_connection(conn).await {
        Ok(g) => g,
        Err(e) => return fail(&engine, &event_tx, format!("GlobalShortcuts proxy: {e:?}")),
    };
    let version = gs.version();
    let can_configure = version >= 2;

    let session = match gs.create_session(Default::default()).await {
        Ok(s) => s,
        Err(e) => return fail(&engine, &event_tx, format!("CreateSession: {e:?}")),
    };

    // BindShortcuts: KDE shows ONE consent dialog on first run (the user approves /
    // customises); later runs reuse the stored triggers under the app-id.
    let shortcuts = state::new_shortcuts();
    match gs.bind_shortcuts(&session, &shortcuts, None, Default::default()).await {
        Ok(req) => {
            if let Err(e) = req.response() {
                log::warn!("hotkeys: BindShortcuts response error (continuing): {e:?}");
            }
        }
        Err(e) => return fail(&engine, &event_tx, format!("BindShortcuts: {e:?}")),
    }

    // ListShortcuts is the post-bind truth (KDE's actual triggers, possibly
    // user-customised). Populate the snapshot from it.
    match gs.list_shortcuts(&session, Default::default()).await {
        Ok(req) => match req.response() {
            Ok(listed) => publish(&engine, &event_tx, version, can_configure, state::to_protocol(listed.shortcuts()), None),
            Err(e) => publish(&engine, &event_tx, version, can_configure, Vec::new(), Some(format!("ListShortcuts response: {e:?}"))),
        },
        Err(e) => publish(&engine, &event_tx, version, can_configure, Vec::new(), Some(format!("ListShortcuts: {e:?}"))),
    }

    // The forever multiplexer: shortcut activations, KDE-side trigger changes, and
    // in-app rebind requests. Any stream/channel close cleanly ends the loop.
    let mut activated = match gs.receive_activated().await {
        Ok(s) => s,
        Err(e) => return fail(&engine, &event_tx, format!("receive_activated: {e:?}")),
    };
    // Hold-to-show overlay needs the release edge too (mirrors STT push-to-talk).
    let mut deactivated = match gs.receive_deactivated().await {
        Ok(s) => s,
        Err(e) => return fail(&engine, &event_tx, format!("receive_deactivated: {e:?}")),
    };
    let mut changed = match gs.receive_shortcuts_changed().await {
        Ok(s) => s,
        Err(e) => return fail(&engine, &event_tx, format!("receive_shortcuts_changed: {e:?}")),
    };

    log::info!("hotkeys: bound + listening (portal v{version}, can_configure={can_configure})");
    loop {
        tokio::select! {
            ev = activated.next() => match ev {
                Some(act) => handle_activated(&engine, &cmd_tx, &events_tx, act.shortcut_id()),
                None => { log::warn!("hotkeys: Activated stream ended"); break; }
            },
            ev = deactivated.next() => match ev {
                Some(deact) => handle_deactivated(&events_tx, deact.shortcut_id()),
                None => { log::warn!("hotkeys: Deactivated stream ended"); break; }
            },
            ev = changed.next() => match ev {
                Some(chg) => publish(&engine, &event_tx, version, can_configure, state::to_protocol(chg.shortcuts()), None),
                None => { log::warn!("hotkeys: ShortcutsChanged stream ended"); break; }
            },
            msg = rebind_rx.recv() => match msg {
                Some(()) if can_configure => {
                    if let Err(e) = gs.configure_shortcuts(&session, None, Default::default()).await {
                        log::warn!("hotkeys: ConfigureShortcuts failed: {e:?}");
                    }
                }
                Some(()) => log::info!("hotkeys: rebind requested but portal v{version} < 2 (no ConfigureShortcuts)"),
                None => break, // all rebind senders dropped → daemon shutting down
            },
        }
    }
    log::info!("hotkeys: listener loop ended");
}

/// PRESS dispatch. `record` toggles recording via the SAME `EngineCmd` path as
/// the socket verbs (the capture thread emits the state/saved events). `overlay`
/// shows the in-game capture HUD by broadcasting an `overlay` wire event the host
/// bridges to `overlay-capture.show()`. Reserved shortcuts are inert.
fn handle_activated(
    engine: &Arc<Mutex<Engine>>,
    cmd_tx: &CmdTx,
    events_tx: &broadcast::Sender<Event>,
    shortcut_id: &str,
) {
    match shortcut_id {
        "record" => {
            // Toggle on the AUTHORITATIVE state (mirrors the in-app button).
            let recording = {
                let e = engine.lock().expect("engine mutex poisoned");
                matches!(e.state, EngineState::Recording { .. })
            };
            let cmd = if recording { EngineCmd::StopClip } else { EngineCmd::StartClip { game: None } };
            log::info!("hotkeys: record → {}", if recording { "StopClip" } else { "StartClip" });
            if let Err(cmd) = cmd_tx.send(cmd) {
                log::error!("hotkeys: failed to forward record command {cmd:?} — capture thread gone");
            }
        }
        "overlay" => emit_overlay(events_tx, true),
        other => log::info!("hotkeys: '{other}' activated — reserved/no-op in this slice"),
    }
}

/// RELEASE dispatch. `overlay` release hides the capture HUD; `record` is a
/// press-toggle (no release action); all others are ignored.
fn handle_deactivated(events_tx: &broadcast::Sender<Event>, shortcut_id: &str) {
    if shortcut_id == "overlay" {
        emit_overlay(events_tx, false);
    }
}

/// Broadcast the `overlay` wire event (`{"show": bool}`). Overlay visibility is
/// NOT engine state, so it bypasses `EngineEvent` (which re-snapshots the engine)
/// and rides the wire bus straight to the host bridge, which shows/hides the
/// always-on-top `overlay-capture` window. The socket forwards it verbatim.
fn emit_overlay(events_tx: &broadcast::Sender<Event>, show: bool) {
    log::info!("hotkeys: overlay {} (Shift+C)", if show { "show" } else { "hide" });
    let _ = events_tx.send(Event {
        event: "overlay".to_string(),
        data: serde_json::json!({ "show": show }),
    });
}

/// Overwrite the engine's `HotkeysSnapshot` (`bound:true`) + emit `StateChanged` so
/// every client re-renders the live triggers. `last_error` carries a soft failure
/// (e.g. ListShortcuts) while the shortcuts themselves are bound.
fn publish(
    engine: &Arc<Mutex<Engine>>,
    event_tx: &EventTx,
    version: u32,
    can_configure: bool,
    shortcuts: Vec<Shortcut>,
    last_error: Option<String>,
) {
    {
        let mut e = engine.lock().expect("engine mutex poisoned");
        e.hotkeys = HotkeysSnapshot { bound: true, portal_version: version, can_configure, shortcuts, last_error };
    }
    let _ = event_tx.send(EngineEvent::StateChanged);
}

/// A fatal SETUP failure (no bus/proxy/session): `bound:false` + the error, emit
/// `StateChanged`, and let `run` return. GlobalShortcuts is simply unavailable; the
/// in-app button still works over the socket.
fn fail(engine: &Arc<Mutex<Engine>>, event_tx: &EventTx, msg: String) {
    log::error!("hotkeys: setup failed: {msg}");
    {
        let mut e = engine.lock().expect("engine mutex poisoned");
        let portal_version = e.hotkeys.portal_version;
        e.hotkeys = HotkeysSnapshot {
            bound: false,
            portal_version,
            can_configure: false,
            shortcuts: Vec::new(),
            last_error: Some(msg),
        };
    }
    let _ = event_tx.send(EngineEvent::StateChanged);
}
