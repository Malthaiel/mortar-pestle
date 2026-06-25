//! Control-thread ↔ capture-thread seam (sub-plan 5 + Phase 2 ring).
//!
//! `EngineCmd` / `EngineEvent` are the INTERNAL bridge enums — never serialized
//! to the wire (that's `protocol.rs`, which is frozen). The tokio control thread
//! pushes `EngineCmd`s to the thread-affine capture/encode thread and drains
//! `EngineEvent`s back; `mod.rs` re-broadcasts those as wire `Event`s.
//!
//! `ControlContext::send_cmd` deliberately HIDES the command-transport type: the
//! socket layer only ever says `ctx.send_cmd(cmd)` and never names the sender, so
//! swapping the placeholder `tokio::mpsc` for the `pipewire::channel::Sender`
//! (Send + eventfd-woken — the locked control→capture bridge) needed no change to
//! `socket.rs`.
//!
//! **Phase 2 (encode-on-arm + the tee).** One persistent `Session` owns the single
//! NVENC encode + a [`TeeSink`] that fans each packet to the in-RAM replay ring
//! (while armed) and/or the live-recording [`Recorder`] (while recording). The
//! session is built on the first consumer (Arm or StartClip) and torn down when
//! the last detaches, so a manual recording and the replay ring run off ONE encode.

use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use std::cell::Cell;
#[cfg(target_os = "linux")]
use pipewire as pw;
use tokio::sync::mpsc;
#[cfg(any(target_os = "linux", windows))]
use tokio::sync::{broadcast, Notify};

use crate::capture::replay_ring::ReplayRing;
#[cfg(target_os = "linux")]
use crate::capture::{self, Clip, EncodeParams};
#[cfg(windows)]
use crate::capture::EncodeParams;
use crate::daemon::protocol::{CaptureConfig, ProtoError, SavedClip};
#[cfg(any(target_os = "linux", windows))]
use crate::daemon::protocol::Event;
use crate::daemon::save;
#[cfg(target_os = "linux")]
use crate::daemon::socket::now_mono_ns;
use crate::daemon::state::{Engine, EngineState};
use crate::run::{Recorder, TeeSink};

/// Control-thread → capture-thread commands. Internal; mirrors the mutating wire
/// verbs. NOT a wire type.
#[derive(Debug, Clone)]
pub enum EngineCmd {
    StartClip { game: Option<String> },
    StopClip,
    /// Phase 2: start the encode + replay ring (no file written).
    Arm,
    /// Phase 2: stop + free the replay ring (teardown if nothing else consumes).
    Disarm,
    /// Phase 2: save the last `window_secs` (or the whole ring if `None`).
    SaveReplay { window_secs: Option<u32> },
    SetConfig(CaptureConfig),
    Shutdown,
}

/// Capture-thread → control-thread events. Internal back-channel; `mod.rs`
/// projects each into a wire `Event` (`state_changed` / `saved` / `error`).
/// NOT a wire type.
#[derive(Debug, Clone)]
pub enum EngineEvent {
    /// The engine state moved; the control thread re-snapshots + broadcasts.
    StateChanged,
    /// A clip finalized; carries the unified `SavedClip` contract.
    Saved { clip: SavedClip },
    /// A capture-side failure; carries the wire-shaped error to surface.
    Error { error: ProtoError },
}

/// The command transport behind `ControlContext::send_cmd` (Linux).
///
/// A `pipewire::channel::Sender<EngineCmd>` (cloneable, `Send`, eventfd-woken):
/// the receiver is attached to the capture thread's persistent mainloop, so a
/// `send` here wakes that loop and the command runs on the capture thread. The
/// sender is sync/non-blocking, so the async socket dispatch can call it directly.
#[cfg(target_os = "linux")]
type CmdTx = pw::channel::Sender<EngineCmd>;

/// Build the control→capture command channel. The transport is cfg-split: Linux
/// uses a `pipewire::channel` (attached to the capture mainloop, eventfd-woken);
/// Windows uses a plain `std::sync::mpsc` the pacer thread drains each tick. Both
/// senders are `Send` + sync, so any caller (socket dispatch / the CLI gate) drives
/// the engine the same way. The concrete pair types are returned (the `CmdTx` alias
/// is Linux-only, behind `ControlContext`).
#[cfg(target_os = "linux")]
pub fn new_cmd_channel() -> (pw::channel::Sender<EngineCmd>, pw::channel::Receiver<EngineCmd>) {
    pw::channel::channel::<EngineCmd>()
}

/// See [`new_cmd_channel`] (Linux). Windows: a `std::sync::mpsc` pair.
#[cfg(windows)]
pub fn new_cmd_channel(
) -> (std::sync::mpsc::Sender<EngineCmd>, std::sync::mpsc::Receiver<EngineCmd>) {
    std::sync::mpsc::channel::<EngineCmd>()
}

/// Shared handle the socket loop uses to read state + drive the engine. Cheap to
/// clone (Arc + channel senders); one per accepted client read task.
#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct ControlContext {
    /// Authoritative engine state — locked for `snapshot` + transitions.
    pub engine: Arc<Mutex<Engine>>,
    /// Wire-event bus; every connected client subscribes a receiver.
    pub events: broadcast::Sender<Event>,
    /// Command transport — type intentionally NOT exposed (see `send_cmd`).
    cmd_tx: CmdTx,
    /// Rebind transport to the hotkeys portal task (`daemon::hotkeys`). A SEPARATE
    /// channel, not an `EngineCmd`: rebinding is a control-thread/ashpd concern, so
    /// routing it through the capture thread would mis-target it.
    rebind_tx: mpsc::UnboundedSender<()>,
    /// Wakes `serve`'s accept loop on the `shutdown` op so the process can exit.
    shutdown: Arc<Notify>,
}

#[cfg(target_os = "linux")]
impl ControlContext {
    pub fn new(
        engine: Arc<Mutex<Engine>>,
        events: broadcast::Sender<Event>,
        cmd_tx: CmdTx,
        rebind_tx: mpsc::UnboundedSender<()>,
    ) -> Self {
        Self { engine, events, cmd_tx, rebind_tx, shutdown: Arc::new(Notify::new()) }
    }

    /// Ask the hotkeys task to open KDE's shortcut-configuration UI
    /// (`ConfigureShortcuts`, portal v2+). Errs only if the hotkeys task is gone.
    pub fn rebind(&self) -> Result<(), String> {
        self.rebind_tx
            .send(())
            .map_err(|_| "hotkeys task unreachable: rebind channel closed".to_string())
    }

    /// A handle to the shutdown signal — `serve`'s accept loop awaits it.
    pub fn shutdown_handle(&self) -> Arc<Notify> {
        self.shutdown.clone()
    }

    /// Signal the accept loop to stop (the `shutdown` op): `serve` then returns and
    /// the process exits. Paired with an `EngineCmd::Shutdown` that tears the
    /// capture thread down.
    pub fn signal_shutdown(&self) {
        self.shutdown.notify_one();
    }

    /// Forward an `EngineCmd` to the capture thread. Errs only if the capture
    /// thread is gone (the pw channel `send` hands the message back on failure).
    pub fn send_cmd(&self, cmd: EngineCmd) -> Result<(), String> {
        self.cmd_tx
            .send(cmd)
            .map_err(|_| "capture thread unreachable: pipewire channel closed".to_string())
    }
}

/// Windows control context — the named-pipe `serve` analog of the Linux
/// [`ControlContext`]. Holds the same authoritative engine + wire-event bus +
/// shutdown signal; the command transport is the `std::sync::mpsc::Sender` the pacer
/// thread drains each tick (the Windows arm of [`new_cmd_channel`]). There is NO
/// `rebind_tx`: Windows hotkeys are a fixed WH_KEYBOARD_LL hook (SF6,
/// `can_configure:false`), so the `rebind_hotkeys` verb answers `not_implemented`
/// rather than routing anywhere.
#[cfg(windows)]
#[derive(Clone)]
pub struct ControlContext {
    /// Authoritative engine state — locked for `snapshot` + transitions.
    pub engine: Arc<Mutex<Engine>>,
    /// Wire-event bus; every connected pipe client subscribes a receiver.
    pub events: broadcast::Sender<Event>,
    /// Command transport — type intentionally NOT exposed (see `send_cmd`).
    cmd_tx: std::sync::mpsc::Sender<EngineCmd>,
    /// Wakes `serve`'s accept loop on the `shutdown` op so the process can exit.
    shutdown: Arc<Notify>,
}

#[cfg(windows)]
impl ControlContext {
    pub fn new(
        engine: Arc<Mutex<Engine>>,
        events: broadcast::Sender<Event>,
        cmd_tx: std::sync::mpsc::Sender<EngineCmd>,
    ) -> Self {
        Self { engine, events, cmd_tx, shutdown: Arc::new(Notify::new()) }
    }

    /// A handle to the shutdown signal — `serve`'s accept loop awaits it.
    pub fn shutdown_handle(&self) -> Arc<Notify> {
        self.shutdown.clone()
    }

    /// Signal the accept loop to stop (the `shutdown` op): `serve` then returns and
    /// the process exits. Paired with an `EngineCmd::Shutdown` that tears the pacer down.
    pub fn signal_shutdown(&self) {
        self.shutdown.notify_one();
    }

    /// Forward an `EngineCmd` to the pacer thread. Errs only if the pacer is gone
    /// (the `std::sync::mpsc` send hands the message back on a closed channel).
    pub fn send_cmd(&self, cmd: EngineCmd) -> Result<(), String> {
        self.cmd_tx
            .send(cmd)
            .map_err(|_| "capture thread unreachable: command channel closed".to_string())
    }
}

/// The single capture/encode session (Phase 2). Built on the first consumer (Arm
/// or StartClip), torn down when the last detaches. The `TeeSink` fans the one
/// NVENC encode to the replay ring (while armed) and/or the live recorder (while
/// recording). All fields are `!Send`, thread-local to the capture thread.
#[cfg(target_os = "linux")]
struct Session {
    clip: Clip<'static>,
    tee: Rc<RefCell<TeeSink>>,
    params: EncodeParams,
    codec: String,
    /// The replay ring (Some while armed). Shared with the `TeeSink`.
    ring: Option<Rc<RefCell<ReplayRing>>>,
    /// Continuous system-audio tap (present while the session lives). Phase 2 keeps
    /// it UNBOUNDED while armed (the video ring is the RAM hog); the audio ring
    /// bound is a fast-follow. Read non-destructively via `snapshot_window`.
    audio: Option<capture::audio::AudioCapture>,
    /// The armed game label (for replay clip naming). "" until armed.
    game: String,
    armed_since_unix_ms: u64,
    armed_since_mono_ns: u64,
    /// Some while a manual recording is teed alongside the ring (the full tee).
    record: Option<RecordJob>,
}

/// One in-flight manual recording teed off the session's encode.
#[cfg(target_os = "linux")]
struct RecordJob {
    recorder: Rc<RefCell<Recorder>>,
    mux: save::ClipMux,
    game: String,
    started_at_unix_ms: u64,
    started_at_mono_ns: u64,
}

/// Spawn the REAL capture/encode thread. Returns the thread's `JoinHandle`; the
/// thread runs for the daemon's life (the caller joins it on `Shutdown`).
///
/// On the thread: `pw::init()` → ONE persistent outer `pw::MainLoop` (leaked for a
/// `&'static`) → attach the `EngineCmd` Receiver + a self-notify "reap" Receiver
/// ONCE → `mainloop.run()`. The single [`Session`] is built/torn down as sources
/// on the running loop per command; the loop is only quit on `Shutdown`.
#[cfg(target_os = "linux")]
pub fn spawn_capture(
    engine: Arc<Mutex<Engine>>,
    cmd_rx: pw::channel::Receiver<EngineCmd>,
    event_tx: mpsc::UnboundedSender<EngineEvent>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("iskariel-capture".into())
        .spawn(move || {
            pw::init();

            let mainloop = match pw::main_loop::MainLoopRc::new(None) {
                Ok(ml) => ml,
                Err(e) => {
                    log::error!("capture: failed to create persistent mainloop: {e}");
                    let _ = event_tx.send(EngineEvent::Error {
                        error: ProtoError::new("internal", format!("pw mainloop: {e}")),
                    });
                    return;
                }
            };
            let mainloop: &'static pw::main_loop::MainLoopRc = Box::leak(Box::new(mainloop));

            // The single capture session (None when idle). Shared (same thread →
            // `Rc`) into both the command callback and the reap callback below.
            let active: Rc<RefCell<Option<Session>>> = Rc::new(RefCell::new(None));
            // Guards a single in-flight replay save (the save runs on its own thread).
            let save_in_flight = Arc::new(AtomicBool::new(false));

            // Self-notify channel: the pacer's `on_end` (which fires INSIDE the tick)
            // can't drop its own clip. On a FATAL it signals here; the reap receiver
            // runs on the NEXT loop iteration, OFF the tick, and tears the session down.
            let (reap_tx, reap_rx) = pw::channel::channel::<()>();

            let _reap_recv = reap_rx.attach(mainloop.loop_(), {
                let engine = engine.clone();
                let event_tx = event_tx.clone();
                let active = active.clone();
                move |()| reap_fatal(&engine, &event_tx, &active)
            });

            let _cmd_recv = cmd_rx.attach(mainloop.loop_(), {
                let engine = engine.clone();
                let event_tx = event_tx.clone();
                let active = active.clone();
                let reap_tx = reap_tx.clone();
                let save_in_flight = save_in_flight.clone();
                move |cmd| {
                    handle_cmd(
                        mainloop, &engine, &event_tx, &active, &reap_tx, &save_in_flight, cmd,
                    );
                }
            });

            log::info!("capture: persistent mainloop ready — awaiting EngineCmd");
            mainloop.run();
            log::info!("capture: mainloop returned (shutdown) — capture thread exiting");
        })
        .expect("spawn iskariel-capture thread")
}

/// Handle one `EngineCmd` on the capture thread (inside the command-receiver
/// callback). All session state lives on this thread; the engine `Arc<Mutex>` is
/// updated on every transition so snapshots stay truthful.
#[allow(clippy::too_many_arguments)]
#[cfg(target_os = "linux")]
fn handle_cmd(
    mainloop: &'static pw::main_loop::MainLoopRc,
    engine: &Arc<Mutex<Engine>>,
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
    reap_tx: &pw::channel::Sender<()>,
    save_in_flight: &Arc<AtomicBool>,
    cmd: EngineCmd,
) {
    match cmd {
        EngineCmd::Arm => handle_arm(mainloop, engine, event_tx, active, reap_tx),
        EngineCmd::Disarm => handle_disarm(engine, event_tx, active),
        EngineCmd::StartClip { game } => {
            handle_start_clip(mainloop, engine, event_tx, active, reap_tx, game)
        }
        EngineCmd::StopClip => handle_stop_clip(engine, event_tx, active),
        EngineCmd::SaveReplay { window_secs } => {
            handle_save_replay(event_tx, active, save_in_flight, window_secs)
        }
        EngineCmd::SetConfig(cfg) => {
            engine.lock().expect("engine mutex poisoned").config = cfg;
            let _ = event_tx.send(EngineEvent::StateChanged);
            log::info!("capture: config updated (applies to the next session)");
        }
        EngineCmd::Shutdown => {
            if let Some(session) = active.borrow_mut().take() {
                let Session { clip, record, .. } = session;
                let _ = clip.stop();
                if let Some(job) = record {
                    let mp4 = job.mux.mp4_path.clone();
                    job.mux.abort();
                    log::info!("capture: shutdown — discarded in-flight recording {mp4}");
                }
            }
            set_state(engine, EngineState::Idle);
            log::info!("capture: Shutdown — quitting persistent mainloop");
            mainloop.quit();
        }
    }
}

/// Build a fresh capture session (encode + tee + audio tap) with NO consumers
/// attached yet. Blocks on the portal handshake (own short-lived runtime), like
/// the old `StartClip`. The caller attaches the ring and/or recorder + sets state.
#[cfg(target_os = "linux")]
fn build_session(
    mainloop: &'static pw::main_loop::MainLoopRc,
    engine: &Arc<Mutex<Engine>>,
    reap_tx: &pw::channel::Sender<()>,
) -> Result<Session, String> {
    let (params, codec, want_audio) = {
        let e = engine.lock().expect("engine mutex poisoned");
        (
            params_from_config(&e.config),
            e.config.codec.clone(),
            e.config.audio.track != "none",
        )
    };
    let tee = Rc::new(RefCell::new(TeeSink::new()));
    // Best-effort audio tap (a silent clip beats no clip). Continuous for the
    // session's life; dropped at teardown disconnects it.
    let audio = if want_audio {
        match capture::audio::start() {
            Ok(a) => Some(a),
            Err(e) => {
                log::warn!("capture: audio unavailable, session is video-only: {e}");
                None
            }
        }
    } else {
        None
    };
    // `on_end` must NOT quit the persistent loop; on a fatal it signals reap, which
    // tears the session down off the pacer tick. Fires once.
    let on_end = {
        let reap_tx = reap_tx.clone();
        move || {
            let _ = reap_tx.send(());
        }
    };
    // `stop` is consumed by `build_clip` (cloned into the pacer); the session tears
    // down by dropping the clip directly, so it never needs to flip the cell.
    let stop = Rc::new(Cell::new(false));
    let clip = capture::build_clip(mainloop, &params, tee.clone(), stop, || false, on_end)?;
    Ok(Session {
        clip,
        tee,
        params,
        codec,
        ring: None,
        audio,
        game: String::new(),
        armed_since_unix_ms: 0,
        armed_since_mono_ns: 0,
        record: None,
    })
}

/// Tear a session down cleanly off the pacer tick: drop the audio tap / ring / tee
/// (the `..` fields), then `clip.stop()` disconnects the stream + removes the pacer.
#[cfg(target_os = "linux")]
fn teardown_session(session: Session) {
    let Session { clip, .. } = session;
    if let Err(e) = clip.stop() {
        log::warn!("capture: session teardown surfaced a fatal: {e}");
    }
}

/// `Arm` — start (or attach a ring to) the capture session so the replay ring fills.
#[cfg(target_os = "linux")]
fn handle_arm(
    mainloop: &'static pw::main_loop::MainLoopRc,
    engine: &Arc<Mutex<Engine>>,
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
    reap_tx: &pw::channel::Sender<()>,
) {
    let replay_secs = engine
        .lock()
        .expect("engine mutex poisoned")
        .config
        .replay_length_min
        .clamp(1, REPLAY_LEN_MAX_MIN)
        * 60;

    if active.borrow().as_ref().map_or(false, |s| s.ring.is_some()) {
        log::warn!("capture: Arm ignored — already armed");
        return;
    }

    // Build a session if there isn't one (Arm from idle); else attach a ring to the
    // already-running encode (Arm while a record-without-arm is in flight).
    if active.borrow().is_none() {
        match build_session(mainloop, engine, reap_tx) {
            Ok(s) => *active.borrow_mut() = Some(s),
            Err(e) => return start_failed(engine, event_tx, e),
        }
    }

    let game = save::namer::detect_game();
    let unix = unix_now_ms();
    let mono = now_mono_ns();
    let recording = {
        let mut slot = active.borrow_mut();
        let sess = slot.as_mut().expect("session present");
        let cap_bytes = ring_cap_bytes(sess.params.bitrate_bps, replay_secs);
        let ring = Rc::new(RefCell::new(ReplayRing::new(cap_bytes, replay_secs)));
        sess.tee.borrow_mut().attach_ring(ring.clone());
        sess.ring = Some(ring);
        sess.game = game.clone();
        sess.armed_since_unix_ms = unix;
        sess.armed_since_mono_ns = mono;
        sess.record.is_some()
    };
    set_state(
        engine,
        EngineState::Armed { game, since_unix_ms: unix, since_mono_ns: mono, recording },
    );
    let _ = event_tx.send(EngineEvent::StateChanged);
    log::info!("capture: armed — replay ring filling ({replay_secs}s window)");
}

/// `Disarm` — drop the replay ring; tear the session down if nothing else consumes.
#[cfg(target_os = "linux")]
fn handle_disarm(
    engine: &Arc<Mutex<Engine>>,
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
) {
    // Detach the ring under a short borrow; decide teardown vs keep-recording after.
    let outcome = {
        let mut slot = active.borrow_mut();
        let Some(sess) = slot.as_mut() else {
            log::warn!("capture: Disarm ignored — no session");
            return;
        };
        if sess.ring.is_none() {
            log::warn!("capture: Disarm ignored — not armed");
            return;
        }
        sess.tee.borrow_mut().detach_ring();
        sess.ring = None;
        match &sess.record {
            // Still recording → keep the session, drop to plain Recording state.
            Some(job) => Some((job.game.clone(), job.started_at_unix_ms, job.started_at_mono_ns)),
            None => None,
        }
    };
    match outcome {
        Some((game, su, sm)) => {
            set_state(
                engine,
                EngineState::Recording {
                    game,
                    started_at_unix_ms: su,
                    started_at_mono_ns: sm,
                    clip_tmp_path: String::new(),
                },
            );
            log::info!("capture: disarmed (recording continues)");
        }
        None => {
            if let Some(s) = active.borrow_mut().take() {
                teardown_session(s);
            }
            set_state(engine, EngineState::Idle);
            log::info!("capture: disarmed — session torn down");
        }
    }
    let _ = event_tx.send(EngineEvent::StateChanged);
}

/// `StartClip` — start a manual recording, teed alongside the ring if armed.
#[cfg(target_os = "linux")]
fn handle_start_clip(
    mainloop: &'static pw::main_loop::MainLoopRc,
    engine: &Arc<Mutex<Engine>>,
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
    reap_tx: &pw::channel::Sender<()>,
    game_opt: Option<String>,
) {
    if active.borrow().as_ref().map_or(false, |s| s.record.is_some()) {
        log::warn!("capture: StartClip ignored — already recording");
        return;
    }
    let game = game_opt.unwrap_or_else(save::namer::detect_game);

    // Build a session if recording without arming (no ring); else tee onto the
    // running armed encode.
    let built_fresh = active.borrow().is_none();
    if built_fresh {
        set_state(engine, EngineState::Starting);
        let _ = event_tx.send(EngineEvent::StateChanged);
        match build_session(mainloop, engine, reap_tx) {
            Ok(s) => *active.borrow_mut() = Some(s),
            Err(e) => return start_failed(engine, event_tx, e),
        }
    }

    // Start the live mux (mkfifo + ffmpeg + FIFO writer), tee the Recorder onto it.
    let mp4_path = match save::clip_mp4_path(&game) {
        Ok(p) => p,
        Err(e) => return abort_fresh_start(engine, event_tx, active, built_fresh, e),
    };
    let (mux, writer) = match save::ClipMux::start(&mp4_path) {
        Ok(m) => m,
        Err(e) => return abort_fresh_start(engine, event_tx, active, built_fresh, e),
    };
    let recorder = Rc::new(RefCell::new(Recorder::with_writer(writer)));
    let started_at_unix_ms = unix_now_ms();
    let started_at_mono_ns = now_mono_ns();

    let armed_state = {
        let mut slot = active.borrow_mut();
        let sess = slot.as_mut().expect("session present");
        sess.tee.borrow_mut().attach_recorder(recorder.clone());
        sess.record = Some(RecordJob {
            recorder,
            mux,
            game: game.clone(),
            started_at_unix_ms,
            started_at_mono_ns,
        });
        sess.ring.is_some().then(|| {
            (sess.game.clone(), sess.armed_since_unix_ms, sess.armed_since_mono_ns)
        })
    };
    match armed_state {
        Some((agame, su, sm)) => set_state(
            engine,
            EngineState::Armed { game: agame, since_unix_ms: su, since_mono_ns: sm, recording: true },
        ),
        None => set_state(
            engine,
            EngineState::Recording {
                game,
                started_at_unix_ms,
                started_at_mono_ns,
                clip_tmp_path: mp4_path.clone(),
            },
        ),
    }
    let _ = event_tx.send(EngineEvent::StateChanged);
    log::info!("capture: recording → {mp4_path}");
}

/// Roll back a session we built *for this StartClip* when the mux fails (an armed
/// session that pre-existed is left intact).
#[cfg(target_os = "linux")]
fn abort_fresh_start(
    engine: &Arc<Mutex<Engine>>,
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
    built_fresh: bool,
    err: String,
) {
    if built_fresh {
        if let Some(s) = active.borrow_mut().take() {
            teardown_session(s);
        }
    }
    start_failed(engine, event_tx, err);
}

/// `StopClip` — detach + finalize the manual recording. Blocks the capture thread
/// briefly during the ffmpeg finalize (a record-while-armed save leaves a few-second
/// ring gap; off-thread finalize is a fast-follow). Session lives on iff still armed.
#[cfg(target_os = "linux")]
fn handle_stop_clip(
    engine: &Arc<Mutex<Engine>>,
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
) {
    let extracted = {
        let mut slot = active.borrow_mut();
        let Some(sess) = slot.as_mut() else {
            log::warn!("capture: StopClip ignored — no session");
            return;
        };
        let Some(job) = sess.record.take() else {
            log::warn!("capture: StopClip ignored — not recording");
            return;
        };
        sess.tee.borrow_mut().detach_recorder();
        let (width, height) = sess.clip.dimensions();
        // Close the FIFO writer → ffmpeg EOF; read this clip's pts window + packets.
        job.recorder.borrow_mut().finish();
        let (first, last, packets) = {
            let r = job.recorder.borrow();
            (r.first_packet_pts_ns(), r.last_packet_pts_ns(), r.packet_count())
        };
        let t0 = first.unwrap_or(0).max(0);
        let t_end = last.unwrap_or(0).max(0);
        // Audio cut from the continuous tap (non-destructive — the session may stay
        // armed). `None` ⇒ video-only.
        let audio_pcm = sess.audio.as_ref().map(|a| {
            let (cap_ns, span_ns) = a.stats_window();
            log::info!(
                "record audio: {:.2}s samples / {:.2}s span",
                cap_ns as f64 / 1e9,
                span_ns as f64 / 1e9
            );
            a.snapshot_window(t0, t_end)
        });
        let still_armed = sess.ring.is_some();
        (job, width, height, t0, t_end, packets, audio_pcm, still_armed)
    };
    let (job, width, height, t0, t_end, packets, audio_pcm, still_armed) = extracted;
    let RecordJob { mux, game, .. } = job;
    let codec = active.borrow().as_ref().map(|s| s.codec.clone()).unwrap_or_default();
    let atempo = compute_atempo(t0, t_end, packets);
    let mp4_path = mux.mp4_path.clone();

    set_state(engine, EngineState::Finalizing);
    let _ = event_tx.send(EngineEvent::StateChanged);

    let saved = match mux.finalize(audio_pcm, atempo) {
        Ok(()) => {
            let poster = save::mux::extract_poster(&mp4_path);
            let duration_s = (t_end - t0).max(0) as f64 / 1e9;
            log::info!(
                "capture: saved {mp4_path} ({packets} packets, {duration_s:.2}s, {width}x{height})"
            );
            Some(SavedClip {
                path: mp4_path.clone(),
                game,
                duration_s,
                started_monotonic_pts_ns: t0 as u64,
                last_monotonic_pts_ns: t_end as u64,
                poster,
                width,
                height,
                codec,
            })
        }
        Err(e) => {
            log::error!("capture: mux finalize failed for {mp4_path}: {e}");
            let _ = event_tx.send(EngineEvent::Error { error: ProtoError::new("internal", e) });
            None
        }
    };

    // Restore state: still armed → back to Armed (recording false); else Idle + teardown.
    if still_armed {
        let (g, su, sm) = active
            .borrow()
            .as_ref()
            .map(|s| (s.game.clone(), s.armed_since_unix_ms, s.armed_since_mono_ns))
            .unwrap_or_default();
        set_state(engine, EngineState::Armed { game: g, since_unix_ms: su, since_mono_ns: sm, recording: false });
    } else {
        if let Some(s) = active.borrow_mut().take() {
            teardown_session(s);
        }
        set_state(engine, EngineState::Idle);
    }
    let _ = event_tx.send(EngineEvent::StateChanged);
    if let Some(clip) = saved {
        let _ = event_tx.send(EngineEvent::Saved { clip });
    }
}

/// `SaveReplay` — snapshot the ring on the capture thread (refcount clone, no
/// stall), then stream it through ffmpeg on a dedicated save thread.
#[cfg(target_os = "linux")]
fn handle_save_replay(
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
    save_in_flight: &Arc<AtomicBool>,
    window_secs: Option<u32>,
) {
    let prepared = {
        let slot = active.borrow();
        let Some(sess) = slot.as_ref() else {
            return emit_err(event_tx, "bad_request", "not armed");
        };
        let Some(ring) = sess.ring.as_ref() else {
            return emit_err(event_tx, "bad_request", "not armed");
        };
        let Some(snapshot) = ring.borrow().snapshot(window_secs) else {
            return emit_err(event_tx, "bad_request", "replay ring is empty");
        };
        let audio_pcm = sess
            .audio
            .as_ref()
            .map(|a| a.snapshot_window(snapshot.t0_ns, snapshot.t_end_ns));
        let (width, height) = sess.clip.dimensions();
        let game = if sess.game.is_empty() {
            save::namer::detect_game()
        } else {
            sess.game.clone()
        };
        (snapshot, audio_pcm, width, height, game, sess.codec.clone())
    };
    if save_in_flight.swap(true, Ordering::SeqCst) {
        return emit_err(event_tx, "busy", "a replay save is already in progress");
    }
    let (snapshot, audio_pcm, width, height, game, codec) = prepared;
    let atempo = compute_atempo(snapshot.t0_ns, snapshot.t_end_ns, snapshot.packets.len() as u64);
    let event_tx = event_tx.clone();
    let flag = save_in_flight.clone();
    let span_s = (snapshot.t_end_ns - snapshot.t0_ns).max(0) as f64 / 1e9;
    log::info!("capture: save_replay — {:.1}s, {} packets", span_s, snapshot.packets.len());

    std::thread::Builder::new()
        .name("iskariel-capture-save".into())
        .spawn(move || {
            let result = save_replay_clip(
                &game, &codec, width, height, snapshot.t0_ns, snapshot.t_end_ns,
                snapshot.packets, audio_pcm, atempo,
            );
            match result {
                Ok(clip) => {
                    log::info!("capture: replay saved {}", clip.path);
                    let _ = event_tx.send(EngineEvent::Saved { clip });
                }
                Err(e) => {
                    log::error!("capture: replay save failed: {e}");
                    let _ = event_tx.send(EngineEvent::Error { error: ProtoError::new("internal", e) });
                }
            }
            flag.store(false, Ordering::SeqCst);
        })
        .expect("spawn iskariel-capture-save thread");
}

/// Stream a refcounted ring snapshot through `ClipMux` into a finished `.mp4`.
/// Runs on the save thread (opens its own `ClipMux`, so nothing `!Send` crosses).
#[allow(clippy::too_many_arguments)]
fn save_replay_clip(
    game: &str,
    codec: &str,
    width: u32,
    height: u32,
    t0: i64,
    t_end: i64,
    packets: Vec<Arc<Vec<u8>>>,
    audio_pcm: Option<Vec<u8>>,
    atempo: f64,
) -> Result<SavedClip, String> {
    let mp4_path = save::clip_replay_path(game)?;
    let (mux, mut writer) = save::ClipMux::start(&mp4_path)?;
    for p in &packets {
        let bytes: &[u8] = p; // Arc<Vec<u8>> → &[u8] via deref coercion.
        writer
            .write_all(bytes)
            .map_err(|e| format!("write replay packet to mux FIFO: {e}"))?;
    }
    let _ = writer.flush();
    drop(writer); // close the FIFO write end → ffmpeg sees EOF and finalizes.
    mux.finalize(audio_pcm, atempo)?;

    let poster = save::mux::extract_poster(&mp4_path);
    let duration_s = (t_end - t0).max(0) as f64 / 1e9;
    Ok(SavedClip {
        path: mp4_path,
        game: game.to_string(),
        duration_s,
        started_monotonic_pts_ns: t0.max(0) as u64,
        last_monotonic_pts_ns: t_end.max(0) as u64,
        poster,
        width,
        height,
        codec: codec.to_string(),
    })
}

/// Reap a session that ended on a FATAL capture/encode error (the pacer's `on_end`
/// signalled the reap channel). Abort any in-flight recording, surface the error.
#[cfg(target_os = "linux")]
fn reap_fatal(
    engine: &Arc<Mutex<Engine>>,
    event_tx: &mpsc::UnboundedSender<EngineEvent>,
    active: &Rc<RefCell<Option<Session>>>,
) {
    let Some(session) = active.borrow_mut().take() else {
        return; // spurious/duplicate wake — nothing left.
    };
    let Session { clip, record, .. } = session;
    let fatal = clip.stop().err();
    if let Some(job) = record {
        job.mux.abort(); // discard the partial recording.
    }
    let msg = fatal.unwrap_or_else(|| "capture session ended unexpectedly".to_string());
    log::error!("capture: session fatal — {msg}");
    set_state(engine, EngineState::Error(ProtoError::new("internal", msg.clone())));
    let _ = event_tx.send(EngineEvent::StateChanged);
    let _ = event_tx.send(EngineEvent::Error { error: ProtoError::new("internal", msg) });
}

/// Atomically replace the engine state under the lock.
fn set_state(engine: &Arc<Mutex<Engine>>, state: EngineState) {
    engine.lock().expect("engine mutex poisoned").state = state;
}

/// Set `Error` + emit the wire error/state events for a failed start.
fn start_failed(engine: &Arc<Mutex<Engine>>, event_tx: &mpsc::UnboundedSender<EngineEvent>, e: String) {
    log::error!("capture: start failed: {e}");
    set_state(engine, EngineState::Error(ProtoError::new("internal", e.clone())));
    let _ = event_tx.send(EngineEvent::Error { error: ProtoError::new("internal", e) });
    let _ = event_tx.send(EngineEvent::StateChanged);
}

/// Emit a wire error event (used for non-fatal command rejections, e.g. an unarmed
/// `save_replay`); the session state is untouched.
fn emit_err(event_tx: &mpsc::UnboundedSender<EngineEvent>, code: &str, msg: &str) {
    log::warn!("capture: {code} — {msg}");
    let _ = event_tx.send(EngineEvent::Error { error: ProtoError::new(code, msg) });
}

/// CFR-60-vs-real-rate atempo for the audio cut (pitch-preserving; no-op when there
/// is no skew, guarded against degenerate sub-2s clips). Matches the recording path.
fn compute_atempo(t0: i64, t_end: i64, packets: u64) -> f64 {
    let real_ns = (t_end - t0).max(0) as f64;
    let cfr_ns = packets as f64 * 1e9 / 60.0;
    if packets > 120 && cfr_ns > 0.0 {
        let r = real_ns / cfr_ns;
        if (0.95..=1.05).contains(&r) {
            r
        } else {
            1.0
        }
    } else {
        1.0
    }
}

/// Hard ceiling on the replay-ring length, in minutes. Decision: the slider is
/// hard-capped at 10 min so arming can't allocate a multi-GB ring (10-min Ultra
/// ≈ 4.9 GB, inside the free-RAM budget; 30-min ≈ 14.6 GB is not). The UI caps the
/// slider, but this clamp enforces it authoritatively for any stale/over-cap
/// persisted config (the slider used to allow 1–30).
const REPLAY_LEN_MAX_MIN: u32 = 10;

/// RAM ceiling for the replay ring: `bitrate/8 × secs`, +25% safety (the seconds
/// cap is the effective bound; bytes guards a bitrate spike).
fn ring_cap_bytes(bitrate_bps: u32, secs: u32) -> usize {
    ((bitrate_bps as u64 / 8) * secs as u64 * 5 / 4) as usize
}

/// Derive the encoder params from the engine config (bitrate mbps→bps, GOP =
/// keyint_sec × 60, 60/1 fps).
fn params_from_config(cfg: &CaptureConfig) -> EncodeParams {
    EncodeParams {
        bitrate_bps: cfg.bitrate_mbps.saturating_mul(1_000_000),
        gop_len: cfg.keyint_sec.saturating_mul(60),
        fps_num: 60,
        fps_den: 1,
    }
}

/// Current wall-clock time in unix milliseconds (saturates to 0 before the epoch).
fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===========================================================================
// Windows transport + capture/pacer thread (Game Capture SF3)
// ===========================================================================
//
// No PipeWire mainloop and no `Clip<'static>` loop-borrow on Windows: a single
// `std::thread` owns every COM/NVENC object (all `!Send`, never crossing the
// channel — the same discipline as the Linux `Clip`). It drains `EngineCmd`s from a
// `std::sync::mpsc` at the top of each tick (≤ one-frame command latency) and paces
// frames to 60 fps CFR with a high-resolution waitable timer on ABSOLUTE deadlines
// (a slow encode steals from the next slice instead of sliding the clock). Only
// `EngineCmd`/`EngineEvent`/`RingSnapshot` (all `Send`) cross the channel; the
// `WinSession` + COM interfaces stay thread-local. Shares the engine's state machine,
// `TeeSink`/`Recorder`/`ReplayRing`, `save::ClipMux`, and `save_replay_clip` verbatim.

#[cfg(windows)]
pub use win::spawn_capture;

#[cfg(windows)]
mod win {
    use super::*;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    use windows::Win32::System::Threading::{
        CreateWaitableTimerExW, SetWaitableTimer, WaitForSingleObject,
        CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE,
    };

    use crate::capture::encode::D3d11Encode;
    use crate::capture::wgc::WgcCapture;
    // `TeeSink`/`Recorder` implement this; bring it into scope so `tee.on_packet` resolves.
    use crate::run::FrameSink;

    /// 60 fps CFR tick period in nanoseconds (the pacer clock).
    const FRAME_PERIOD_NS: u64 = 16_666_667;
    /// Per-tick blocking wait for a fresh WGC frame before falling back to a CFR hold
    /// (re-encode the last staged frame). Short so a missing frame never blows the
    /// 16.6 ms budget.
    const FRAME_WAIT: Duration = Duration::from_millis(4);
    /// SF10 — startup grace for the FIRST WGC frame. If none arrives within this
    /// window the target can't be captured (exclusive fullscreen / a protected
    /// window) → warn-and-bail instead of muxing an empty clip. The happy path
    /// returns as soon as the first frame lands (typically <200 ms), so this only
    /// bounds the warn case.
    const WIN_STARTUP_FRAME_WAIT: Duration = Duration::from_millis(1500);
    /// `TIMER_ALL_ACCESS` (STANDARD_RIGHTS_REQUIRED | SYNCHRONIZE | 0x3) as a `u32` —
    /// the `CreateWaitableTimerExW` desired-access arg.
    const TIMER_ALL_ACCESS: u32 = 0x001F_0003;

    /// The single Windows capture/encode session — the `Clip`-less analog of the
    /// Linux [`Session`]. All fields are `!Send`, thread-local to the pacer thread.
    struct WinSession {
        cap: WgcCapture,
        enc: D3d11Encode,
        /// The shared device kept alive for the session's life.
        _device: ID3D11Device,
        /// The immediate context the staging `CopyResource` is issued on (the SF2
        /// dropped-context bug fixed here: we KEEP it, on the pacer thread).
        context: ID3D11DeviceContext,
        tee: TeeSink,
        codec: String,
        ring: Option<Rc<RefCell<ReplayRing>>>,
        params: EncodeParams,
        game: String,
        armed_since_unix_ms: u64,
        armed_since_mono_ns: u64,
        record: Option<WinRecordJob>,
        /// Continuous WASAPI loopback tap (Some while audio is live for the session).
        /// Read non-destructively via `snapshot_window` at stop/save; dropped (which
        /// stops the capture thread) when the session tears down. SF5.
        audio: Option<crate::capture::audio::AudioCapture>,
        /// Monotonic schedule base + CFR counter (also the NVENC input timestamp).
        /// Both advance once per active tick; reset per fresh session.
        sched_base: Instant,
        cfr_index: u64,
        /// True once at least one frame has been staged — before that a tick is a
        /// no-op (never encode an uninitialized texture).
        have_staged: bool,
        enc_w: u32,
        enc_h: u32,
    }

    /// One in-flight manual recording teed off the session's encode (Windows).
    struct WinRecordJob {
        recorder: Rc<RefCell<Recorder>>,
        mux: save::ClipMux,
        game: String,
        started_at_unix_ms: u64,
        started_at_mono_ns: u64,
    }

    /// Owns a waitable-timer `HANDLE`, closing it on drop. Created + used + dropped
    /// entirely on the pacer thread (never shared), so no `Send` impl is needed.
    struct TimerHandle(HANDLE);
    impl Drop for TimerHandle {
        fn drop(&mut self) {
            // SAFETY: a live timer handle from CreateWaitableTimerExW, closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Current monotonic time in ns via `QueryPerformanceCounter` — the Windows
    /// `now_mono_ns` (same role as the Linux `CLOCK_MONOTONIC` source). i128 math
    /// avoids the `counter * 1e9` i64 overflow (~920 s at a 10 MHz QPC frequency).
    fn now_mono_ns() -> u64 {
        use std::sync::OnceLock;
        static FREQ: OnceLock<i64> = OnceLock::new();
        let freq = *FREQ.get_or_init(|| {
            let mut f: i64 = 0;
            // SAFETY: `f` is a valid out-param; QPF never fails on supported hardware.
            unsafe {
                let _ = QueryPerformanceFrequency(&mut f);
            }
            if f <= 0 {
                1
            } else {
                f
            }
        });
        let mut c: i64 = 0;
        // SAFETY: `c` is a valid out-param.
        unsafe {
            let _ = QueryPerformanceCounter(&mut c);
        }
        if c <= 0 {
            0
        } else {
            ((c as i128 * 1_000_000_000) / freq as i128) as u64
        }
    }

    /// Spawn the Windows capture/encode/pacer thread. Mirrors the Linux
    /// [`super::spawn_capture`] signature (the `EngineEvent` back-channel is the same
    /// tokio sender) so `daemon::run`/the CLI gate drive it the same way.
    pub fn spawn_capture(
        engine: Arc<Mutex<Engine>>,
        cmd_rx: std::sync::mpsc::Receiver<EngineCmd>,
        event_tx: mpsc::UnboundedSender<EngineEvent>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::Builder::new()
            .name("iskariel-capture".into())
            .spawn(move || {
                // The WGC free-threaded pool needs an initialized MTA apartment on
                // THIS thread (no message pump). S_FALSE / RPC_E_CHANGED_MODE are fine.
                // SAFETY: standard COM init; never uninitialized (the thread runs to exit).
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }

                let timer = match create_timer() {
                    Ok(t) => t,
                    Err(e) => {
                        log::error!("capture: failed to create the waitable timer: {e}");
                        let _ = event_tx
                            .send(EngineEvent::Error { error: ProtoError::new("internal", e) });
                        return;
                    }
                };

                let save_in_flight = Arc::new(AtomicBool::new(false));
                let mut sess: Option<WinSession> = None;
                log::info!("capture: Windows pacer thread ready — awaiting EngineCmd");

                'main: loop {
                    // 1. Drain every pending command (non-blocking). Session state is
                    //    mutated only here, on this thread.
                    loop {
                        match cmd_rx.try_recv() {
                            Ok(cmd) => {
                                if handle_win_cmd(&engine, &event_tx, &save_in_flight, &mut sess, cmd) {
                                    break 'main; // Shutdown
                                }
                            }
                            Err(std::sync::mpsc::TryRecvError::Empty) => break,
                            Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'main,
                        }
                    }

                    // 2. Idle (no session / no consumers) → block for the next command.
                    let active = sess.as_ref().map_or(false, |s| s.tee.has_consumers());
                    if !active {
                        match cmd_rx.recv() {
                            Ok(cmd) => {
                                if handle_win_cmd(&engine, &event_tx, &save_in_flight, &mut sess, cmd) {
                                    break 'main;
                                }
                            }
                            Err(_) => break 'main, // all senders dropped
                        }
                        continue;
                    }

                    // 3. Active → pace to this tick's deadline, then encode one frame.
                    wait_next_deadline(&timer, sess.as_ref().unwrap());
                    if let Err(e) = encode_tick(sess.as_mut().unwrap()) {
                        if let Some(s) = sess.take() {
                            teardown_win_session(s);
                        }
                        set_state(&engine, EngineState::Error(ProtoError::new("internal", e.clone())));
                        let _ = event_tx.send(EngineEvent::StateChanged);
                        let _ = event_tx
                            .send(EngineEvent::Error { error: ProtoError::new("internal", e) });
                    }
                }

                if let Some(s) = sess.take() {
                    teardown_win_session(s);
                }
                set_state(&engine, EngineState::Idle);
                log::info!("capture: Windows pacer thread exiting (shutdown)");
            })
            .expect("spawn iskariel-capture thread")
    }

    /// Handle one `EngineCmd` on the pacer thread. Returns `true` on `Shutdown`
    /// (the caller breaks the loop). Mirrors the Linux `handle_cmd` dispatch.
    fn handle_win_cmd(
        engine: &Arc<Mutex<Engine>>,
        event_tx: &mpsc::UnboundedSender<EngineEvent>,
        save_in_flight: &Arc<AtomicBool>,
        sess: &mut Option<WinSession>,
        cmd: EngineCmd,
    ) -> bool {
        match cmd {
            EngineCmd::Arm => win_arm(engine, event_tx, sess),
            EngineCmd::Disarm => win_disarm(engine, event_tx, sess),
            EngineCmd::StartClip { game } => win_start_clip(engine, event_tx, sess, game),
            EngineCmd::StopClip => win_stop_clip(engine, event_tx, sess),
            EngineCmd::SaveReplay { window_secs } => {
                win_save_replay(event_tx, save_in_flight, sess, window_secs)
            }
            EngineCmd::SetConfig(cfg) => {
                engine.lock().expect("engine mutex poisoned").config = cfg;
                let _ = event_tx.send(EngineEvent::StateChanged);
                log::info!("capture: config updated (applies to the next session)");
            }
            EngineCmd::Shutdown => {
                log::info!("capture: Shutdown — stopping the pacer thread");
                return true;
            }
        }
        false
    }

    /// SF10 — classify a Windows capture-start probe into an optional user-facing
    /// warning (the message `start_failed` surfaces via the `capture-state` error
    /// fold, shown on the Capture page). Pure (no FFI) so it's unit-testable;
    /// `build_win_session` feeds it the live `SHQueryUserNotificationState` result
    /// and whether WGC delivered a first frame. `None` ⇒ capture can proceed.
    ///
    /// Exclusive-fullscreen and protected/no-frame windows are both invisible to WGC
    /// (OBS/Discord hit the same wall); the user fix is identical — borderless
    /// windowed — so both branches say so. `exclusive_fs` wins (the instant pre-check
    /// fires before a frame is ever probed).
    fn fullscreen_warning(game: &str, exclusive_fs: bool, got_first_frame: bool) -> Option<String> {
        if exclusive_fs {
            Some(format!(
                "{game} appears to be in exclusive fullscreen — switch to borderless \
                 windowed to capture (exclusive fullscreen is invisible to the capture API)"
            ))
        } else if !got_first_frame {
            Some(format!(
                "{game} produced no frames — likely exclusive fullscreen or a protected \
                 window; switch to borderless windowed to capture"
            ))
        } else {
            None
        }
    }

    #[cfg(test)]
    mod fullscreen_warning_tests {
        use super::fullscreen_warning;

        #[test]
        fn exclusive_fullscreen_warns() {
            let w = fullscreen_warning("Deadlock", true, false).expect("warns");
            assert!(w.contains("Deadlock") && w.contains("exclusive fullscreen"));
        }

        #[test]
        fn no_frames_warns() {
            let w = fullscreen_warning("Deadlock", false, false).expect("warns");
            assert!(w.contains("Deadlock") && w.contains("no frames"));
        }

        #[test]
        fn windowed_with_frames_ok() {
            assert!(fullscreen_warning("Deadlock", false, true).is_none());
        }

        #[test]
        fn exclusive_takes_precedence_over_frame_signal() {
            // exclusive_fs wins even when a frame happened to arrive.
            let w = fullscreen_warning("Game", true, true).expect("warns");
            assert!(w.contains("exclusive fullscreen"));
        }
    }

    /// Build a fresh Windows capture session (WGC + the D3D11 encoder) with NO
    /// consumers attached. The caller attaches the ring and/or recorder + sets state.
    fn build_win_session(engine: &Arc<Mutex<Engine>>) -> Result<WinSession, String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

        let (params, codec, audio_track) = {
            let e = engine.lock().expect("engine mutex poisoned");
            (params_from_config(&e.config), e.config.codec.clone(), e.config.audio.track.clone())
        };
        // SAFETY: a plain FFI read of the current foreground window handle.
        let hwnd: HWND = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return Err("no foreground window to capture (focus a window first)".into());
        }
        // SF10 — exclusive-fullscreen pre-check (instant): a D3D exclusive-fullscreen
        // app is invisible to WGC, so warn (and skip building the session) instead of
        // recording a black clip. The no-first-frame check below is authoritative.
        let game = save::namer::detect_game();
        if let Some(msg) = fullscreen_warning(&game, crate::capture::is_exclusive_fullscreen(), true) {
            return Err(msg);
        }
        let (device, context) = crate::capture::d3d11::create_device()?;
        let winrt = crate::capture::d3d11::wrap_for_winrt(&device)?;
        let mut cap = WgcCapture::start(hwnd, &winrt)?;
        let (w, h) = cap.size();
        if w == 0 || h == 0 {
            return Err(format!("capture target has a zero size ({w}x{h})"));
        }
        // SF10 — no-first-frame ground truth: if WGC delivers no frame within the
        // startup window, the target can't be captured (exclusive fullscreen / a
        // protected window). Warn instead of muxing an empty clip; the discarded probe
        // frame costs ~one frame at session start (negligible at 60 fps CFR).
        if let Some(msg) =
            fullscreen_warning(&game, false, cap.next_frame(WIN_STARTUP_FRAME_WAIT).is_ok())
        {
            return Err(msg);
        }
        let enc = D3d11Encode::open(&device, w, h, &params)?;
        // SF5: start the per-process WASAPI loopback tap on the captured window's PID
        // (best-effort, default ON unless `audio.track == "none"`). On failure the
        // session records video-only — a silent clip beats no clip.
        let pid = {
            let mut pid: u32 = 0;
            // SAFETY: plain FFI read of the capture target's owning process id.
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            pid
        };
        let audio = if audio_track != "none" {
            match crate::capture::audio::start(pid) {
                Ok(a) => Some(a),
                Err(e) => {
                    log::warn!("capture: audio unavailable ({e}) — recording video-only");
                    None
                }
            }
        } else {
            None
        };
        Ok(WinSession {
            cap,
            enc,
            _device: device,
            context,
            tee: TeeSink::new(),
            codec,
            ring: None,
            params,
            game: String::new(),
            armed_since_unix_ms: 0,
            armed_since_mono_ns: 0,
            record: None,
            audio,
            sched_base: Instant::now(),
            cfr_index: 0,
            have_staged: false,
            enc_w: w,
            enc_h: h,
        })
    }

    /// Tear a Windows session down: abort any in-flight recording, then drop the
    /// COM/NVENC objects (`WgcCapture::drop` closes the session/pool; `D3d11Encode`
    /// releases the encoder).
    fn teardown_win_session(sess: WinSession) {
        if let Some(job) = sess.record {
            let mp4 = job.mux.mp4_path.clone();
            job.mux.abort();
            log::info!("capture: discarded in-flight recording {mp4}");
        }
    }

    /// `Arm` — start (or attach a ring to) the session so the replay ring fills.
    fn win_arm(
        engine: &Arc<Mutex<Engine>>,
        event_tx: &mpsc::UnboundedSender<EngineEvent>,
        sess: &mut Option<WinSession>,
    ) {
        let replay_secs = engine
            .lock()
            .expect("engine mutex poisoned")
            .config
            .replay_length_min
            .clamp(1, REPLAY_LEN_MAX_MIN)
            * 60;

        if sess.as_ref().map_or(false, |s| s.ring.is_some()) {
            log::warn!("capture: Arm ignored — already armed");
            return;
        }
        if sess.is_none() {
            match build_win_session(engine) {
                Ok(s) => *sess = Some(s),
                Err(e) => return start_failed(engine, event_tx, e),
            }
        }
        let unix = unix_now_ms();
        let mono = now_mono_ns();
        let (game, recording) = {
            let s = sess.as_mut().expect("session present");
            let cap_bytes = ring_cap_bytes(s.params.bitrate_bps, replay_secs);
            let ring = Rc::new(RefCell::new(ReplayRing::new(cap_bytes, replay_secs)));
            s.tee.attach_ring(ring.clone());
            s.ring = Some(ring);
            if s.game.is_empty() {
                s.game = save::namer::detect_game();
            }
            s.armed_since_unix_ms = unix;
            s.armed_since_mono_ns = mono;
            (s.game.clone(), s.record.is_some())
        };
        set_state(
            engine,
            EngineState::Armed { game, since_unix_ms: unix, since_mono_ns: mono, recording },
        );
        let _ = event_tx.send(EngineEvent::StateChanged);
        log::info!("capture: armed — replay ring filling ({replay_secs}s window)");
    }

    /// `Disarm` — drop the ring; tear the session down if nothing else consumes.
    fn win_disarm(
        engine: &Arc<Mutex<Engine>>,
        event_tx: &mpsc::UnboundedSender<EngineEvent>,
        sess: &mut Option<WinSession>,
    ) {
        let still_recording = {
            let Some(s) = sess.as_mut() else {
                log::warn!("capture: Disarm ignored — no session");
                return;
            };
            if s.ring.is_none() {
                log::warn!("capture: Disarm ignored — not armed");
                return;
            }
            s.tee.detach_ring();
            s.ring = None;
            s.record
                .as_ref()
                .map(|j| (j.game.clone(), j.started_at_unix_ms, j.started_at_mono_ns))
        };
        match still_recording {
            Some((game, su, sm)) => {
                set_state(
                    engine,
                    EngineState::Recording {
                        game,
                        started_at_unix_ms: su,
                        started_at_mono_ns: sm,
                        clip_tmp_path: String::new(),
                    },
                );
                log::info!("capture: disarmed (recording continues)");
            }
            None => {
                if let Some(s) = sess.take() {
                    teardown_win_session(s);
                }
                set_state(engine, EngineState::Idle);
                log::info!("capture: disarmed — session torn down");
            }
        }
        let _ = event_tx.send(EngineEvent::StateChanged);
    }

    /// `StartClip` — start a manual recording, teed alongside the ring if armed.
    fn win_start_clip(
        engine: &Arc<Mutex<Engine>>,
        event_tx: &mpsc::UnboundedSender<EngineEvent>,
        sess: &mut Option<WinSession>,
        game_opt: Option<String>,
    ) {
        if sess.as_ref().map_or(false, |s| s.record.is_some()) {
            log::warn!("capture: StartClip ignored — already recording");
            return;
        }
        let game = game_opt.unwrap_or_else(save::namer::detect_game);
        let built_fresh = sess.is_none();
        if built_fresh {
            set_state(engine, EngineState::Starting);
            let _ = event_tx.send(EngineEvent::StateChanged);
            match build_win_session(engine) {
                Ok(s) => *sess = Some(s),
                Err(e) => return start_failed(engine, event_tx, e),
            }
        }
        let mp4_path = match save::clip_mp4_path(&game) {
            Ok(p) => p,
            Err(e) => return win_abort_fresh(engine, event_tx, sess, built_fresh, e),
        };
        let (mux, writer) = match save::ClipMux::start(&mp4_path) {
            Ok(m) => m,
            Err(e) => return win_abort_fresh(engine, event_tx, sess, built_fresh, e),
        };
        let recorder = Rc::new(RefCell::new(Recorder::with_writer(writer)));
        let started_at_unix_ms = unix_now_ms();
        let started_at_mono_ns = now_mono_ns();
        let armed = {
            let s = sess.as_mut().expect("session present");
            s.tee.attach_recorder(recorder.clone());
            s.record = Some(WinRecordJob {
                recorder,
                mux,
                game: game.clone(),
                started_at_unix_ms,
                started_at_mono_ns,
            });
            s.ring
                .is_some()
                .then(|| (s.game.clone(), s.armed_since_unix_ms, s.armed_since_mono_ns))
        };
        match armed {
            Some((agame, su, sm)) => set_state(
                engine,
                EngineState::Armed { game: agame, since_unix_ms: su, since_mono_ns: sm, recording: true },
            ),
            None => set_state(
                engine,
                EngineState::Recording {
                    game,
                    started_at_unix_ms,
                    started_at_mono_ns,
                    clip_tmp_path: mp4_path.clone(),
                },
            ),
        }
        let _ = event_tx.send(EngineEvent::StateChanged);
        log::info!("capture: recording -> {mp4_path}");
    }

    /// Roll back a session built for THIS StartClip when the mux fails.
    fn win_abort_fresh(
        engine: &Arc<Mutex<Engine>>,
        event_tx: &mpsc::UnboundedSender<EngineEvent>,
        sess: &mut Option<WinSession>,
        built_fresh: bool,
        err: String,
    ) {
        if built_fresh {
            if let Some(s) = sess.take() {
                teardown_win_session(s);
            }
        }
        start_failed(engine, event_tx, err);
    }

    /// `StopClip` — detach + finalize the manual recording (video-only; SF5 adds
    /// audio). Blocks the pacer briefly during the ffmpeg finalize. Session lives on
    /// iff still armed.
    fn win_stop_clip(
        engine: &Arc<Mutex<Engine>>,
        event_tx: &mpsc::UnboundedSender<EngineEvent>,
        sess: &mut Option<WinSession>,
    ) {
        let (mux, game, codec, width, height, t0, t_end, packets, still_armed, audio_pcm) = {
            let Some(s) = sess.as_mut() else {
                log::warn!("capture: StopClip ignored — no session");
                return;
            };
            let Some(job) = s.record.take() else {
                log::warn!("capture: StopClip ignored — not recording");
                return;
            };
            s.tee.detach_recorder();
            // Close the writer → ffmpeg EOF; read this clip's pts window + count.
            job.recorder.borrow_mut().finish();
            let (first, last, packets) = {
                let r = job.recorder.borrow();
                (r.first_packet_pts_ns(), r.last_packet_pts_ns(), r.packet_count())
            };
            let t0 = first.unwrap_or(0).max(0);
            let t_end = last.unwrap_or(0).max(0);
            // SF5: cut the continuous audio tap to this clip's [t0, t_end] window (the
            // same QPC clock domain as the video PTS, so lip-sync holds). None → no tap.
            let audio_pcm = s.audio.as_ref().map(|a| a.snapshot_window(t0, t_end));
            if let Some(a) = s.audio.as_ref() {
                let (cap, span) = a.stats_window();
                log::info!(
                    "capture audio: {:.2}s samples / {:.2}s span",
                    cap as f64 / 1e9,
                    span as f64 / 1e9
                );
            }
            let WinRecordJob { mux, game, .. } = job;
            (
                mux,
                game,
                s.codec.clone(),
                s.enc_w,
                s.enc_h,
                t0,
                t_end,
                packets,
                s.ring.is_some(),
                audio_pcm,
            )
        };
        let atempo = compute_atempo(t0, t_end, packets);
        let mp4_path = mux.mp4_path.clone();

        set_state(engine, EngineState::Finalizing);
        let _ = event_tx.send(EngineEvent::StateChanged);

        // SF5: finalize with the per-process WASAPI audio window (None records video-only).
        let saved = match mux.finalize(audio_pcm, atempo) {
            Ok(()) => {
                let poster = save::mux::extract_poster(&mp4_path);
                let duration_s = (t_end - t0).max(0) as f64 / 1e9;
                log::info!(
                    "capture: saved {mp4_path} ({packets} packets, {duration_s:.2}s, {width}x{height})"
                );
                Some(SavedClip {
                    path: mp4_path.clone(),
                    game,
                    duration_s,
                    started_monotonic_pts_ns: t0 as u64,
                    last_monotonic_pts_ns: t_end as u64,
                    poster,
                    width,
                    height,
                    codec,
                })
            }
            Err(e) => {
                // WI-3 Step A: log frame count + duration next to ffmpeg's stderr so
                // a failed save reveals zero-frames vs a headerless/mid-GOP stream.
                let duration_s = (t_end - t0).max(0) as f64 / 1e9;
                log::error!(
                    "capture: mux finalize failed for {mp4_path} ({packets} packets, {duration_s:.2}s, {width}x{height}): {e}"
                );
                let _ = event_tx.send(EngineEvent::Error { error: ProtoError::new("internal", e) });
                None
            }
        };

        if still_armed {
            let (g, su, sm) = sess
                .as_ref()
                .map(|s| (s.game.clone(), s.armed_since_unix_ms, s.armed_since_mono_ns))
                .unwrap_or_default();
            set_state(
                engine,
                EngineState::Armed { game: g, since_unix_ms: su, since_mono_ns: sm, recording: false },
            );
        } else {
            if let Some(s) = sess.take() {
                teardown_win_session(s);
            }
            set_state(engine, EngineState::Idle);
        }
        let _ = event_tx.send(EngineEvent::StateChanged);
        if let Some(clip) = saved {
            let _ = event_tx.send(EngineEvent::Saved { clip });
        }
    }

    /// `SaveReplay` — snapshot the ring on the pacer thread, stream it through ffmpeg
    /// on a dedicated save thread (the shared [`super::save_replay_clip`]).
    fn win_save_replay(
        event_tx: &mpsc::UnboundedSender<EngineEvent>,
        save_in_flight: &Arc<AtomicBool>,
        sess: &Option<WinSession>,
        window_secs: Option<u32>,
    ) {
        let prepared = {
            let Some(s) = sess.as_ref() else {
                return emit_err(event_tx, "bad_request", "not armed");
            };
            let Some(ring) = s.ring.as_ref() else {
                return emit_err(event_tx, "bad_request", "not armed");
            };
            let Some(snapshot) = ring.borrow().snapshot(window_secs) else {
                return emit_err(event_tx, "bad_request", "replay ring is empty");
            };
            let game = if s.game.is_empty() { save::namer::detect_game() } else { s.game.clone() };
            // SF5: cut the audio tap to the ring window (same QPC domain as video PTS).
            let audio_pcm =
                s.audio.as_ref().map(|a| a.snapshot_window(snapshot.t0_ns, snapshot.t_end_ns));
            (snapshot, s.enc_w, s.enc_h, game, s.codec.clone(), audio_pcm)
        };
        if save_in_flight.swap(true, Ordering::SeqCst) {
            return emit_err(event_tx, "busy", "a replay save is already in progress");
        }
        let (snapshot, width, height, game, codec, audio_pcm) = prepared;
        let atempo =
            compute_atempo(snapshot.t0_ns, snapshot.t_end_ns, snapshot.packets.len() as u64);
        let event_tx = event_tx.clone();
        let flag = save_in_flight.clone();
        let span_s = (snapshot.t_end_ns - snapshot.t0_ns).max(0) as f64 / 1e9;
        log::info!("capture: save_replay — {:.1}s, {} packets", span_s, snapshot.packets.len());

        std::thread::Builder::new()
            .name("iskariel-capture-save".into())
            .spawn(move || {
                let result = save_replay_clip(
                    &game, &codec, width, height, snapshot.t0_ns, snapshot.t_end_ns,
                    snapshot.packets, audio_pcm, atempo,
                );
                match result {
                    Ok(clip) => {
                        log::info!("capture: replay saved {}", clip.path);
                        let _ = event_tx.send(EngineEvent::Saved { clip });
                    }
                    Err(e) => {
                        log::error!("capture: replay save failed: {e}");
                        let _ = event_tx
                            .send(EngineEvent::Error { error: ProtoError::new("internal", e) });
                    }
                }
                flag.store(false, Ordering::SeqCst);
            })
            .expect("spawn iskariel-capture-save thread");
    }

    /// Pull the latest WGC frame (drain-to-newest to bound latency), stage it via
    /// `CopyResource`, then encode one CFR frame. On a frame-timeout, re-encode the
    /// last staged frame (a CFR hold = a correct duplicate). Always advances
    /// `cfr_index` so the pacer schedule keeps moving. `Err` on a fatal encode.
    fn encode_tick(s: &mut WinSession) -> Result<(), String> {
        // Drain every queued frame, keeping only the newest (avoids latency buildup
        // when WGC over-delivers on a high-refresh display).
        let mut latest = None;
        while let Some(frame) = s.cap.try_next_frame()? {
            latest = Some(frame);
        }
        if latest.is_none() {
            // Nothing queued — block briefly for one fresh frame.
            if let Ok(f) = s.cap.next_frame(FRAME_WAIT) {
                latest = Some(f);
            }
        }
        match latest {
            Some(frame) => {
                s.enc.stage(&s.context, &frame);
                s.have_staged = true;
            }
            None if !s.have_staged => {
                // No frame ever staged → nothing to encode yet; advance the schedule.
                s.cfr_index += 1;
                return Ok(());
            }
            None => { /* CFR hold: re-encode the last staged frame */ }
        }
        let pts = now_mono_ns() as i64;
        let packets = s.enc.encode(s.cfr_index)?;
        for p in &packets {
            s.tee.on_packet(&p.data, p.keyframe, s.cfr_index, pts, 0);
        }
        s.cfr_index += 1;
        Ok(())
    }

    /// Create a high-resolution waitable timer (sub-ms accuracy WITHOUT a
    /// process-global `timeBeginPeriod`).
    fn create_timer() -> Result<TimerHandle, String> {
        // SAFETY: standard timer creation; the returned HANDLE is owned by TimerHandle.
        let h = unsafe {
            CreateWaitableTimerExW(
                None,
                windows::core::PCWSTR::null(),
                CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                TIMER_ALL_ACCESS,
            )
        }
        .map_err(|e| format!("CreateWaitableTimerExW: {e}"))?;
        Ok(TimerHandle(h))
    }

    /// Sleep until this tick's absolute 60 fps deadline (`sched_base + cfr_index ×
    /// period`). Absolute scheduling means a slow encode steals from the next slice
    /// instead of sliding the clock. If already past the deadline, don't sleep.
    fn wait_next_deadline(timer: &TimerHandle, s: &WinSession) {
        let target =
            s.sched_base + Duration::from_nanos(FRAME_PERIOD_NS.saturating_mul(s.cfr_index));
        let Some(delay) = target.checked_duration_since(Instant::now()) else {
            return; // behind schedule — encode immediately
        };
        // Relative due time in negative 100 ns units (the waitable-timer convention).
        let due: i64 = -((delay.as_nanos() / 100) as i64);
        // SAFETY: `timer` is a live handle; `due` is a valid relative due time.
        unsafe {
            if SetWaitableTimer(timer.0, &due, 0, None, None, false).is_ok() {
                let _ = WaitForSingleObject(timer.0, INFINITE);
            }
        }
    }
}
