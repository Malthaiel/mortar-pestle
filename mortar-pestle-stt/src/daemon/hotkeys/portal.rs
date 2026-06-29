//! The GlobalShortcuts portal flow for STT push-to-talk (Phase 5 SF5). Adapted from
//! mortar-pestle-capture's hotkeys/portal: host registration → CreateSession →
//! BindShortcuts → ListShortcuts → a forever loop over Activated / Deactivated /
//! ShortcutsChanged + the in-app rebind channel.
//!
//! Runs as a spawned task on the daemon's OWN (process-persistent) tokio runtime —
//! unlike capture (whose main thread is the PipeWire mainloop, needing a dedicated
//! portal runtime), the STT daemon IS a multi-thread tokio runtime, so the ashpd
//! zbus connection rides it and outlives every press (the persistent-runtime
//! landmine is satisfied). HOLD-to-talk: `Activated` → start dictation, `Deactivated`
//! → stop. Best-effort throughout; only a missing session/proxy aborts the task.

use ashpd::desktop::global_shortcuts::GlobalShortcuts;
use futures_util::StreamExt;
use tokio::sync::mpsc;

use crate::daemon::dictation::{self, DictationSource};
use crate::daemon::engine::ControlContext;
use crate::daemon::hotkeys::state;
use crate::models::DEFAULT_MODEL;
use crate::protocol::{Event, HotkeysSnapshot, Shortcut};

/// Reserved connection id for hotkey-driven dictation (real clients start at 1, so 0
/// can never collide). Lets the source-tagging treat a hotkey session distinctly.
const HOTKEY_CONN_ID: u64 = 0;

/// The whole hotkeys lifecycle. Returns on a fatal setup error (logged + recorded in
/// the snapshot) or when the daemon shuts down (the rebind channel closes).
pub async fn run(ctx: ControlContext, mut rebind_rx: mpsc::UnboundedReceiver<()>) {
    let conn = match ashpd::zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => return fail(&ctx, format!("session bus: {e}")),
    };

    // Best-effort host-app registration (a stable app-id ⇒ the binding persists
    // across restarts without re-prompting). The dash-free APP_ID passes ashpd's
    // typed `AppID`; a non-sandboxed binary is registered by its live D-Bus peer.
    match state::APP_ID.parse::<ashpd::AppID>() {
        Ok(app_id) => match ashpd::register_host_app_with_connection(conn.clone(), app_id).await {
            Ok(()) => log::info!("hotkeys: registered host app-id {}", state::APP_ID),
            Err(e) => log::warn!("hotkeys: host registration failed (non-fatal): {e:?}"),
        },
        Err(e) => log::warn!("hotkeys: APP_ID rejected by ashpd (non-fatal): {e:?}"),
    }

    let gs = match GlobalShortcuts::with_connection(conn).await {
        Ok(g) => g,
        Err(e) => return fail(&ctx, format!("GlobalShortcuts proxy: {e:?}")),
    };
    let version = gs.version();
    let can_configure = version >= 2;

    let session = match gs.create_session(Default::default()).await {
        Ok(s) => s,
        Err(e) => return fail(&ctx, format!("CreateSession: {e:?}")),
    };

    // BindShortcuts: KDE shows ONE consent dialog on first run; later runs reuse the
    // stored trigger under the app-id.
    let shortcuts = state::new_shortcuts();
    match gs.bind_shortcuts(&session, &shortcuts, None, Default::default()).await {
        Ok(req) => {
            if let Err(e) = req.response() {
                log::warn!("hotkeys: BindShortcuts response error (continuing): {e:?}");
            }
        }
        Err(e) => return fail(&ctx, format!("BindShortcuts: {e:?}")),
    }

    // ListShortcuts is the post-bind truth (KDE's actual trigger, possibly
    // user-customised). Populate the snapshot from it.
    match gs.list_shortcuts(&session, Default::default()).await {
        Ok(req) => match req.response() {
            Ok(listed) => publish(&ctx, version, can_configure, state::to_protocol(listed.shortcuts()), None),
            Err(e) => publish(&ctx, version, can_configure, Vec::new(), Some(format!("ListShortcuts response: {e:?}"))),
        },
        Err(e) => publish(&ctx, version, can_configure, Vec::new(), Some(format!("ListShortcuts: {e:?}"))),
    }

    let mut activated = match gs.receive_activated().await {
        Ok(s) => s,
        Err(e) => return fail(&ctx, format!("receive_activated: {e:?}")),
    };
    let mut deactivated = match gs.receive_deactivated().await {
        Ok(s) => s,
        Err(e) => return fail(&ctx, format!("receive_deactivated: {e:?}")),
    };
    let mut changed = match gs.receive_shortcuts_changed().await {
        Ok(s) => s,
        Err(e) => return fail(&ctx, format!("receive_shortcuts_changed: {e:?}")),
    };

    log::info!("hotkeys: bound + listening (portal v{version}, can_configure={can_configure})");
    loop {
        tokio::select! {
            ev = activated.next() => match ev {
                Some(act) => handle_press(&ctx, act.shortcut_id()),
                None => { log::warn!("hotkeys: Activated stream ended"); break; }
            },
            ev = deactivated.next() => match ev {
                Some(deact) => handle_release(&ctx, deact.shortcut_id()),
                None => { log::warn!("hotkeys: Deactivated stream ended"); break; }
            },
            ev = changed.next() => match ev {
                Some(chg) => publish(&ctx, version, can_configure, state::to_protocol(chg.shortcuts()), None),
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

/// `dictate` PRESS → start a hotkey-sourced dictation with the last-loaded model
/// (config-less daemon: it dictates with whatever model the app last activated,
/// falling back to the registry default). `busy` (already dictating) is logged +
/// ignored — a hotkey cannot error-respond.
fn handle_press(ctx: &ControlContext, shortcut_id: &str) {
    if shortcut_id != state::DICTATE_ID {
        return;
    }
    if ctx.is_dictating() {
        log::info!("hotkeys: dictate press ignored — already dictating");
        return;
    }
    let model = ctx.last_model().unwrap_or_else(|| DEFAULT_MODEL.to_string());
    log::info!("hotkeys: dictate press → start_dictation (model={model})");
    // Hotkey dictation uses the engine's default VAD tuning + auto backend (the app's
    // settings.stt sliders / force-cpu apply to UI-driven dictation; the daemon stays
    // config-less). Source::Hotkey tags the terminal `dictation_committed` for the
    // host's daily-log sink.
    if let Err(e) = dictation::start(ctx, HOTKEY_CONN_ID, model, None, None, None, DictationSource::Hotkey) {
        log::warn!("hotkeys: dictate start failed: [{}] {}", e.code, e.message);
    }
}

/// `dictate` RELEASE → stop the live dictation; the consumer flushes + transcribes
/// the tail and emits the terminal `final` (+ `dictation_committed` for a hotkey
/// session → the host appends it to today's Quick Notes). Idempotent.
fn handle_release(ctx: &ControlContext, shortcut_id: &str) {
    if shortcut_id != state::DICTATE_ID {
        return;
    }
    log::info!("hotkeys: dictate release → stop_dictation");
    dictation::stop(ctx);
}

/// Overwrite the engine's `HotkeysSnapshot` (`bound:true`) + emit a `hotkeys` wire
/// event so the host re-renders the live trigger. `last_error` carries a soft failure
/// while the shortcut itself is bound.
fn publish(ctx: &ControlContext, version: u32, can_configure: bool, shortcuts: Vec<Shortcut>, last_error: Option<String>) {
    let snap = HotkeysSnapshot { bound: true, portal_version: version, can_configure, shortcuts, last_error };
    ctx.set_hotkeys(snap.clone());
    emit_hotkeys(ctx, &snap);
}

/// A fatal SETUP failure (no bus/proxy/session): `bound:false` + the error, emit
/// `hotkeys`, return. The in-app record path still works over the socket; only global
/// push-to-talk is lost.
fn fail(ctx: &ControlContext, msg: String) {
    log::error!("hotkeys: setup failed: {msg}");
    let snap = HotkeysSnapshot {
        bound: false,
        portal_version: ctx.hotkeys_snapshot().portal_version,
        can_configure: false,
        shortcuts: Vec::new(),
        last_error: Some(msg),
    };
    ctx.set_hotkeys(snap.clone());
    emit_hotkeys(ctx, &snap);
}

fn emit_hotkeys(ctx: &ControlContext, snap: &HotkeysSnapshot) {
    if let Ok(data) = serde_json::to_value(snap) {
        let _ = ctx.events.send(Event { event: "hotkeys".to_string(), data });
    }
}
