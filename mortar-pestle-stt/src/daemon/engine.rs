//! The control context for the STT daemon (Voice Transcription, SF2).
//!
//! Threads the broadcast event bus, a shutdown `Notify`, the control→worker command
//! transport, and the shared cancel flag to every client connection. The command
//! transport type is intentionally HIDDEN behind `send_cmd` (matching mortar-pestle-capture)
//! so the worker's channel implementation can change without touching `socket.rs`.
//!
//! SF1 was engine-less (echo only). SF2 adds the resident whisper worker — a blocking
//! `std::thread` (see `crate::whisper`); the worker receives `EngineCmd`s from here and
//! emits wire events straight onto `events`.
#![allow(dead_code)] // some accessors land for SF3/SF4 host wiring.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc, Notify};

use crate::mic::MicHandle;
use crate::protocol::{Event, HotkeysSnapshot};

/// Control-thread → whisper-worker commands. Internal bridge enum — NEVER serialized
/// to the wire (that's `protocol.rs`, frozen). Mirrors the mutating verbs; note
/// `cancel` is NOT here — it rides the shared flag, because the worker is busy inside
/// `whisper_full` (not at `recv()`) exactly when a cancel needs to land.
#[derive(Debug, Clone)]
pub enum EngineCmd {
    LoadModel { name: String, use_gpu: Option<bool> },
    TranscribeFile { path: String },
    /// Phase 5 download-only fetch — verify + cache a model WITHOUT loading it
    /// (download ≠ activate). Routed through the worker (not a side thread) so it
    /// serializes against load/transcribe: no temp-file race, no `progress` event
    /// cross-talk on the shared bus.
    DownloadModel { name: String },
    Unload,
    Shutdown,
}

/// The command transport behind `ControlContext::send_cmd`. A `std::sync::mpsc`
/// Sender: the worker is a blocking `std::thread` that `recv()`s on the paired
/// Receiver, so a sync channel (not a tokio one) is the natural fit. Cloneable +
/// `Send`, so the async socket dispatch calls `send` directly. (The capture daemon
/// uses a `pipewire::channel` here for the same role — the alias is the only seam.)
type CmdTx = Sender<EngineCmd>;

/// A live dictation session's `Send` control handles (Phase 2). NOT routed through
/// `EngineCmd`/the whisper worker — dictation is open-ended + non-blocking, so it owns
/// a dedicated mic + consumer thread instead of occupying the single blocking whisper
/// thread. The `!Send` `cpal::Stream` is confined inside `mic`'s owner thread (so this
/// struct stays `Send`, storable on the cloneable context); `mic.stop()` drops it on
/// that thread, which closes the capture channel and lets the consumer thread drain →
/// transcribe the trailing segment → emit the terminal `final`.
pub struct DictationHandle {
    /// Live mic capture; `stop()` (also on Drop) ends capture + closes the channel.
    pub mic: MicHandle,
    /// The resample/`vu`/transcription consumer thread. Detached on stop (it tears
    /// itself down + emits `final` as the channel closes); kept for hygiene, not joined.
    pub consumer: std::thread::JoinHandle<()>,
}

/// Shared, cloneable control handle threaded to every client connection. Cheap to
/// clone (channel sender + Arcs); one clone per accepted client read task.
#[derive(Clone)]
pub struct ControlContext {
    /// Wire-event bus; every connected client subscribes a receiver. The whisper
    /// worker publishes `model_loaded`/`segment`/`final`/`progress`/`error` onto it.
    pub events: broadcast::Sender<Event>,
    /// Command transport — type intentionally hidden (see `send_cmd`).
    cmd_tx: CmdTx,
    /// Shared cancel flag — `cancel` raises it; the worker polls it (finish-then-discard:
    /// the in-flight run completes, its output is dropped — there is NO abort callback,
    /// which would wedge GGML globally).
    cancel: Arc<AtomicBool>,
    /// Woken by the `shutdown` op so `socket::serve`'s accept loop ends.
    shutdown: Arc<Notify>,
    /// The single live dictation session as `(owning_conn_id, handle)`, or `None` when
    /// idle (Phase 2). One shared cell across every per-client context clone (hence
    /// `Arc<Mutex<_>>`), so a `stop_dictation` on any connection reaches the session a
    /// `start_dictation` on any (same or other) connection created. The `conn_id` records
    /// the connection that started it, so a socket disconnect releases ONLY its own
    /// session (`take_dictation_if_owner`). Type hidden behind the accessors.
    dictation: Arc<Mutex<Option<(u64, DictationHandle)>>>,
    /// The live global-hotkey snapshot (Phase 5 SF5). The portal task writes it on
    /// bind/change; `get_state` / `rebind_hotkeys` read it.
    hotkeys: Arc<Mutex<HotkeysSnapshot>>,
    /// The last model the app loaded/dictated with — hotkey-driven dictation reuses
    /// it (keeps the daemon config-less: no persisted default model).
    last_model: Arc<Mutex<Option<String>>>,
    /// Rebind transport to the hotkeys portal task (`daemon::hotkeys`). A SEPARATE
    /// channel (not an `EngineCmd`): rebinding is an ashpd/portal concern.
    rebind_tx: mpsc::UnboundedSender<()>,
}

impl ControlContext {
    pub fn new(
        events: broadcast::Sender<Event>,
        cmd_tx: CmdTx,
        cancel: Arc<AtomicBool>,
        rebind_tx: mpsc::UnboundedSender<()>,
    ) -> Self {
        Self {
            events,
            cmd_tx,
            cancel,
            shutdown: Arc::new(Notify::new()),
            dictation: Arc::new(Mutex::new(None)),
            hotkeys: Arc::new(Mutex::new(unbound_hotkeys())),
            last_model: Arc::new(Mutex::new(None)),
            rebind_tx,
        }
    }

    /// A handle the accept loop awaits; `signal_shutdown` wakes it.
    pub fn shutdown_handle(&self) -> Arc<Notify> {
        self.shutdown.clone()
    }

    /// Wake the accept loop so `serve` returns and the process exits.
    pub fn signal_shutdown(&self) {
        self.shutdown.notify_one();
    }

    /// Forward an `EngineCmd` to the whisper worker. The command transport is hidden:
    /// callers handle only `Result<(), String>`. Errs only if the worker thread is
    /// gone (the channel `send` fails when the Receiver is dropped).
    pub fn send_cmd(&self, cmd: EngineCmd) -> Result<(), String> {
        self.cmd_tx
            .send(cmd)
            .map_err(|_| "whisper worker unreachable: command channel closed".to_string())
    }

    /// Raise the shared cancel flag — the in-flight `whisper_full` run FINISHES, then the
    /// worker drops its output and reports `cancelled` (finish-then-discard; no abort,
    /// which would wedge GGML globally). A no-op against an idle worker (it clears the
    /// flag at the start of each transcription, so a stale cancel never discards the next run).
    pub fn signal_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Whether a dictation session is currently live (Phase 2 SF1). `start_dictation`
    /// uses this to reject a second concurrent start with `busy`.
    pub fn is_dictating(&self) -> bool {
        self.dictation.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Stash the live dictation session under its owning `conn_id` (Phase 2). Returns the
    /// PREVIOUS handle if one was somehow still present (the caller should already have
    /// rejected via `is_dictating`; this is defensive — drop the old to stop its mic). A
    /// poisoned lock is treated as "no session" (returns `None`); the new handle is
    /// dropped by the caller's error path.
    pub fn set_dictation(&self, conn_id: u64, handle: DictationHandle) -> Option<DictationHandle> {
        self.dictation
            .lock()
            .ok()
            .and_then(|mut g| g.replace((conn_id, handle)))
            .map(|(_, h)| h)
    }

    /// Take the live dictation session, leaving the slot empty (Phase 2). `stop_dictation`
    /// takes it then `mic.stop()`s — which closes the capture channel so the consumer
    /// thread drains, transcribes the trailing segment, and emits the terminal `final`.
    /// Idempotent: `None` when nothing is running.
    pub fn take_dictation(&self) -> Option<DictationHandle> {
        self.dictation.lock().ok().and_then(|mut g| g.take()).map(|(_, h)| h)
    }

    /// Take the live dictation session ONLY if `conn_id` started it — the socket-
    /// disconnect hook (`socket::handle_client`), so a dropped client releases its own
    /// mic without tearing down a session another connection owns. `None` if idle, owned
    /// by a different connection, or the lock is poisoned.
    pub fn take_dictation_if_owner(&self, conn_id: u64) -> Option<DictationHandle> {
        let mut g = self.dictation.lock().ok()?;
        match g.as_ref() {
            Some((owner, _)) if *owner == conn_id => g.take().map(|(_, h)| h),
            _ => None,
        }
    }

    // ── Phase 5 SF5: global hotkeys + last-model ──────────────────────────────

    /// Ask the hotkeys task to open KDE's shortcut-configuration UI
    /// (`ConfigureShortcuts`, portal v2+). Errs only if the hotkeys task is gone.
    pub fn rebind(&self) -> Result<(), String> {
        self.rebind_tx
            .send(())
            .map_err(|_| "hotkeys task unreachable: rebind channel closed".to_string())
    }

    /// Overwrite the live hotkeys snapshot (the portal task, on bind/change).
    pub fn set_hotkeys(&self, snap: HotkeysSnapshot) {
        if let Ok(mut g) = self.hotkeys.lock() {
            *g = snap;
        }
    }

    /// A clone of the current hotkeys snapshot (for `get_state` / `rebind_hotkeys`).
    /// Returns the unbound default if the lock is poisoned.
    pub fn hotkeys_snapshot(&self) -> HotkeysSnapshot {
        self.hotkeys.lock().map(|g| g.clone()).unwrap_or_else(|_| unbound_hotkeys())
    }

    /// Record the last model the app loaded/dictated with (hotkey dictation reuses it).
    pub fn set_last_model(&self, name: &str) {
        if let Ok(mut g) = self.last_model.lock() {
            *g = Some(name.to_string());
        }
    }

    /// The last model name, if any (the hotkey-driven dictation's model).
    pub fn last_model(&self) -> Option<String> {
        self.last_model.lock().ok().and_then(|g| g.clone())
    }
}

/// The initial / poison-fallback hotkeys snapshot (nothing bound yet).
fn unbound_hotkeys() -> HotkeysSnapshot {
    HotkeysSnapshot {
        bound: false,
        portal_version: 0,
        can_configure: false,
        shortcuts: Vec::new(),
        last_error: None,
    }
}
