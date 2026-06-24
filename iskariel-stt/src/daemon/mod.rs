//! The speech-to-text engine daemon (Voice Transcription epic, SF2).
//!
//! Long-running, windowless. A tokio control thread owns the Unix-socket NDJSON
//! server (`socket`) over the frozen protocol (`crate::protocol`), plus a broadcast
//! event bus. SF2 adds the resident whisper worker — a blocking `std::thread` (see
//! `crate::whisper`) that owns the loaded model; `run` wires the control→worker command
//! channel + the shared cancel flag into `ControlContext` and joins the worker on
//! shutdown. The socket layer is unchanged behind this seam.

pub mod dictation;
pub mod engine;
pub mod hotkeys;
pub mod socket;

use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};

use crate::daemon::engine::{ControlContext, EngineCmd};
use crate::protocol::Event;

/// Broadcast bus capacity. Events are notifications, not a durable log; a slow client
/// that lags just drops the gap. Every client subscribes a receiver in `handle_client`.
const EVENT_BUS_CAPACITY: usize = 256;

/// `iskariel-stt daemon` entry. Builds the multi-thread tokio runtime + the
/// broadcast bus, constructs the (SF1, engine-less) `ControlContext`, and blocks
/// on the socket server until a `shutdown` op breaks the accept loop.
pub fn run(_args: &[String]) -> ExitCode {
    let _ = env_logger::Builder::from_default_env().try_init();

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("iskariel-stt daemon: failed to build tokio runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(async move {
        // Wire-event bus: every connected client subscribes a receiver; the whisper
        // worker publishes model_loaded/segment/final/progress/error onto it. The
        // `_events_rx` underscore-binding keeps the channel alive (a dropped sole
        // receiver would close it).
        let (events_tx, _events_rx) = broadcast::channel::<Event>(EVENT_BUS_CAPACITY);

        // Control → whisper-worker command channel (std::sync::mpsc — the worker is a
        // blocking std::thread that recv()s on the Receiver) + the shared cancel flag.
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<EngineCmd>();
        let cancel = Arc::new(AtomicBool::new(false));

        // The resident whisper worker thread (SF2). Owns the loaded WhisperContext;
        // keep its JoinHandle so a `shutdown` op can join it for a clean model drop.
        let worker = crate::whisper::spawn_worker(cmd_rx, events_tx.clone(), cancel.clone());

        // Rebind channel for the global-hotkey portal task (Phase 5 SF5). The
        // `rebind_hotkeys` socket verb sends () → the portal opens ConfigureShortcuts.
        let (rebind_tx, rebind_rx) = mpsc::unbounded_channel::<()>();

        let ctx = ControlContext::new(events_tx, cmd_tx, cancel, rebind_tx);

        // Push-to-talk: spawn the global hotkey listener on THIS runtime — Linux via the
        // XDG GlobalShortcuts portal, Windows via a WH_KEYBOARD_LL low-level hook. Either
        // way a hold drives the same dictation::start/stop path as the socket verbs.
        // Best-effort: an unavailable backend just disables global PTT.
        hotkeys::spawn(ctx.clone(), rebind_rx);

        match socket::serve(ctx).await {
            Ok(()) => {
                // `serve` returned because a `shutdown` op broke the accept loop; that
                // op already sent EngineCmd::Shutdown, so the worker is exiting — join
                // it (off the async thread) for a clean model teardown before exit.
                let _ = tokio::task::spawn_blocking(move || worker.join()).await;
                ExitCode::SUCCESS
            }
            Err(e) => {
                // Early bind failure (before the accept loop): abort. Process exit
                // reaps the worker thread (it was never told to shut down).
                eprintln!("iskariel-stt daemon: socket server error: {e}");
                ExitCode::FAILURE
            }
        }
    })
}

