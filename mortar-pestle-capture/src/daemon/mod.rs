//! The Game Capture engine daemon (sub-plan 5 SF1; Complete Phase 1).
//!
//! Long-running, windowless. A tokio control thread owns the Unix-socket NDJSON
//! server, the broadcast event bus, the long-lived ashpd/zbus connection, and
//! the authoritative `EngineState`; a dedicated thread-affine capture/encode
//! thread owns the `!Send` PipeWire + EGL/GL + NVENC state. They bridge via a
//! `pipewire::channel` (Send + eventfd-woken). Session lifecycle is BUILD-PER-CLIP
//! on a persistent outer mainloop (plan §3.1 / §3.2).
//!
//! This increment lands the autonomously-testable socket layer (`socket`, 5-SF1b)
//! over the frozen protocol (`protocol`) + state machine (`state`), plus the
//! control↔capture seam (`engine`) with a PLACEHOLDER capture task. 5-SF1a swaps
//! that placeholder for the real persistent-outer-loop capture thread WITHOUT
//! touching `socket.rs` — the swap is hidden behind `ControlContext::send_cmd`.

pub mod engine;
// Global capture hotkeys: ashpd GlobalShortcuts on Linux, a WH_KEYBOARD_LL hook on
// Windows (SF6), cfg-dispatched inside `hotkeys/mod.rs`.
#[cfg(any(target_os = "linux", windows))]
pub mod hotkeys;
pub mod protocol;
pub mod save;
// The control server is cfg-split inside `socket.rs`: a Unix-domain-socket arm on
// Linux, a `\\.\pipe\mortar-pestle-capture` named-pipe arm on Windows (SF4). The generic
// `serve_conn`/`dispatch`/framing body is shared.
#[cfg(any(target_os = "linux", windows))]
pub mod socket;
pub mod state;

use std::process::ExitCode;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};

#[cfg(target_os = "linux")]
use tokio::sync::{broadcast, mpsc};

#[cfg(target_os = "linux")]
use crate::daemon::engine::{spawn_capture, ControlContext, EngineEvent};
#[cfg(target_os = "linux")]
use crate::daemon::protocol::{CaptureConfig, Event};
#[cfg(target_os = "linux")]
use crate::daemon::state::Engine;

/// Broadcast bus capacity. Events are snapshots/notifications, not a durable log;
/// a slow client that lags just drops the gap (the snapshot is the truth).
#[cfg(any(target_os = "linux", windows))]
const EVENT_BUS_CAPACITY: usize = 256;

/// `mortar-pestle-capture daemon` (Windows, Game Capture SF4). The named-pipe control
/// transport: builds the multi-thread tokio runtime, the shared engine + broadcast
/// bus + the control→capture (`std::sync::mpsc`) channel, spawns the SF3 pacer
/// (`spawn_capture`) + the event drain, then serves `\\.\pipe\mortar-pestle-capture` over
/// the same generic `serve_conn` the Unix arm uses. Blocks until a `shutdown` op (or
/// a second daemon's single-instance reject) ends the accept loop.
#[cfg(windows)]
pub fn run(_args: &[String]) -> ExitCode {
    use std::sync::{Arc, Mutex};
    use tokio::sync::{broadcast, mpsc};

    use crate::daemon::engine::{new_cmd_channel, spawn_capture, ControlContext, EngineEvent};
    use crate::daemon::protocol::{CaptureConfig, Event};
    use crate::daemon::state::Engine;

    let _ = env_logger::Builder::from_default_env().try_init();

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("mortar-pestle-capture daemon: failed to build tokio runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(async move {
        // Authoritative engine state (the pipe loop locks it for snapshots, the pacer
        // for transitions).
        let engine = Arc::new(Mutex::new(Engine::new(CaptureConfig::default())));
        // Wire-event bus: every connected client subscribes a receiver.
        let (events_tx, _events_rx) = broadcast::channel::<Event>(EVENT_BUS_CAPACITY);
        // Control → capture commands: a `std::sync::mpsc` the pacer drains via
        // `try_recv` each tick (the Windows arm of `new_cmd_channel`).
        let (cmd_tx, cmd_rx) = new_cmd_channel();
        // Capture → control event back-channel (re-broadcast below).
        let (event_tx, event_rx) = mpsc::unbounded_channel::<EngineEvent>();

        // Clones for the SF6 hotkeys task, taken BEFORE the originals move into
        // spawn_capture / ControlContext: the hook forwards a `record` chord as an
        // EngineCmd, reports its binding state via EngineEvent, and reads engine state
        // for the start/stop toggle. `_rebind_tx` is held for the daemon's life so the
        // hook drain's rebind branch never closes (the Windows ControlContext, unlike
        // Linux, carries no rebind channel — chords are fixed).
        let hk_engine = engine.clone();
        let hk_cmd_tx = cmd_tx.clone();
        let hk_event_tx = event_tx.clone();
        let (_rebind_tx, rebind_rx) = mpsc::unbounded_channel::<()>();

        // The SF3 Windows pacer thread (owns the !Send WGC/D3D11/NVENC state).
        let capture = spawn_capture(engine.clone(), cmd_rx, event_tx);
        // Drain the back-channel + re-broadcast each EngineEvent as a wire Event.
        spawn_event_drain_win(engine.clone(), events_tx.clone(), event_rx);

        // SF6: the WH_KEYBOARD_LL keyboard hook — Ctrl+Alt+R toggles recording, Shift+C
        // (hold) emits the overlay show/hide wire event (SF9 consumes it).
        crate::daemon::hotkeys::spawn(hk_engine, hk_cmd_tx, hk_event_tx, events_tx.clone(), rebind_rx);

        let ctx = ControlContext::new(engine, events_tx, cmd_tx);
        match socket::serve(ctx).await {
            Ok(()) => {
                // `serve` returned on a `shutdown` op — the `EngineCmd::Shutdown` was
                // already sent, so join the pacer for a clean NVENC/D3D11 release.
                let _ = tokio::task::spawn_blocking(move || capture.join()).await;
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("mortar-pestle-capture daemon: control pipe error: {e}");
                ExitCode::FAILURE
            }
        }
    })
}

/// Drain the capture thread's `EngineEvent` back-channel and project each into a wire
/// `Event` on the broadcast bus (Windows). The Linux [`spawn_event_drain`]
/// additionally fires `notify-send` toasts + a `pw-play` save chime; both are
/// Linux-only, so the Windows arm just re-broadcasts (toast/chime is a later SF).
#[cfg(windows)]
fn spawn_event_drain_win(
    engine: std::sync::Arc<std::sync::Mutex<crate::daemon::state::Engine>>,
    events: tokio::sync::broadcast::Sender<crate::daemon::protocol::Event>,
    mut event_rx: tokio::sync::mpsc::UnboundedReceiver<crate::daemon::engine::EngineEvent>,
) {
    use crate::daemon::engine::EngineEvent;
    use crate::daemon::protocol::Event;
    tokio::spawn(async move {
        while let Some(ev) = event_rx.recv().await {
            let wire = match ev {
                EngineEvent::StateChanged => {
                    let snap = {
                        let e = engine.lock().expect("engine mutex poisoned");
                        e.snapshot(socket::now_mono_ns())
                    };
                    serde_json::to_value(&snap)
                        .map(|data| Event { event: "state_changed".into(), data })
                }
                EngineEvent::Saved { clip } => {
                    serde_json::to_value(&clip).map(|data| Event { event: "saved".into(), data })
                }
                EngineEvent::Error { error } => {
                    serde_json::to_value(&error).map(|data| Event { event: "error".into(), data })
                }
            };
            match wire {
                // Err only means zero subscribers — fine, drop it.
                Ok(event) => {
                    let _ = events.send(event);
                }
                Err(e) => log::warn!("event drain: failed to encode engine event: {e}"),
            }
        }
        log::info!("event drain: capture back-channel closed");
    });
}

/// `mortar-pestle-capture daemon` entry. Builds the multi-thread tokio runtime, the
/// shared engine state, the broadcast bus, and the control↔capture channels;
/// spawns the socket server + the placeholder capture; and drains the capture
/// back-channel, re-broadcasting each `EngineEvent` as a wire `Event`. Blocks on
/// the socket server until the process is killed.
#[cfg(target_os = "linux")]
pub fn run(_args: &[String]) -> ExitCode {
    let _ = env_logger::Builder::from_default_env().try_init();

    // Synthesize the save chime once at start (6-SF1 audio half) to a WAV under
    // $XDG_RUNTIME_DIR. None on failure → saves stay silent (never fatal).
    let chime_path = materialize_chime();

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("mortar-pestle-capture daemon: failed to build tokio runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(async move {
        // Authoritative engine state (control thread owns it; the socket loop
        // locks it for snapshots, the capture thread for transitions).
        let engine = Arc::new(Mutex::new(Engine::new(CaptureConfig::default())));

        // Wire-event bus: every connected client subscribes a receiver.
        let (events_tx, _events_rx) = broadcast::channel::<Event>(EVENT_BUS_CAPACITY);

        // Control → capture command channel: a pipewire::channel (Send +
        // eventfd-woken). Its Receiver is attached ONCE to the capture thread's
        // persistent mainloop; the Sender lives behind ControlContext::send_cmd.
        let (cmd_tx, cmd_rx) = engine::new_cmd_channel();
        // Capture → control event back-channel. tokio unbounded: its `send` is
        // non-blocking + sync-callable, so the (std::thread) capture thread can
        // push to it directly while this async drain re-broadcasts unchanged.
        let (event_tx, event_rx) = mpsc::unbounded_channel::<EngineEvent>();
        // Rebind channel: the `rebind_hotkeys` socket verb → the hotkeys portal task
        // (opens KDE's ConfigureShortcuts UI). Separate from the capture command path.
        let (rebind_tx, rebind_rx) = mpsc::unbounded_channel::<()>();

        // Clone the control→capture sender, the event back-channel, and the engine
        // handle BEFORE they move into spawn_capture / ControlContext: the hotkeys
        // task forwards a `record` press as an EngineCmd, reports binding state via
        // EngineEvent, and reads authoritative state for the start/stop toggle.
        let hk_cmd_tx = cmd_tx.clone();
        let hk_event_tx = event_tx.clone();
        let hk_engine = engine.clone();

        // The real persistent-outer-loop capture thread (5-SF1a). Owns all !Send
        // PipeWire/EGL/NVENC state; updates `engine` on every transition. Keep its
        // JoinHandle so a `shutdown` op can join it for a clean teardown.
        let capture = spawn_capture(engine.clone(), cmd_rx, event_tx);

        // Drain the capture back-channel and re-broadcast as wire events.
        spawn_event_drain(engine.clone(), events_tx.clone(), event_rx, chime_path);

        // Engine-owned GlobalShortcuts (5-SF3): self-install the .desktop + run the
        // portal listener on the persistent portal runtime. A `record` hotkey drives
        // the SAME EngineCmd path as the socket verbs.
        hotkeys::spawn(hk_engine, hk_cmd_tx, hk_event_tx, events_tx.clone(), rebind_rx);

        let ctx = ControlContext::new(engine, events_tx, cmd_tx, rebind_tx);

        match socket::serve(ctx).await {
            Ok(()) => {
                // `serve` returned because a `shutdown` op broke the accept loop.
                // The `EngineCmd::Shutdown` was already sent, so the capture thread
                // is quitting its loop + tearing down any in-flight clip — join it
                // for a clean NVENC/portal release before the process exits.
                let _ = tokio::task::spawn_blocking(move || capture.join()).await;
                ExitCode::SUCCESS
            }
            Err(e) => {
                // Early bind failure (before the accept loop): abort. Process exit
                // reaps the capture thread (it was never told to shut down).
                eprintln!("mortar-pestle-capture daemon: socket server error: {e}");
                ExitCode::FAILURE
            }
        }
    })
}

/// Drain the capture thread's `EngineEvent` back-channel and project each into a
/// wire `Event` on the broadcast bus. `StateChanged` re-snapshots the (already
/// mutated) engine; `Saved`/`Error` carry their payloads straight through.
#[cfg(target_os = "linux")]
fn spawn_event_drain(
    engine: Arc<Mutex<Engine>>,
    events: broadcast::Sender<Event>,
    mut event_rx: mpsc::UnboundedReceiver<EngineEvent>,
    chime_path: Option<PathBuf>,
) {
    tokio::spawn(async move {
        // Track the previous state label so we fire the "recording started"
        // notification exactly once, on the transition INTO `recording` (the stop
        // side is covered by the richer `Saved` notification — no double toast).
        let mut prev_state = String::new();
        while let Some(ev) = event_rx.recv().await {
            let wire = match ev {
                EngineEvent::StateChanged => {
                    let snap = {
                        let e = engine.lock().expect("engine mutex poisoned");
                        e.snapshot(socket::now_mono_ns())
                    };
                    if snap.state == "recording" && prev_state != "recording" {
                        let game = snap.game.clone().unwrap_or_else(|| "Desktop".into());
                        notify_critical(format!("Recording — {game}"), "Ctrl+Alt+R to stop".into());
                    }
                    prev_state = snap.state.clone();
                    serde_json::to_value(&snap)
                        .map(|data| Event { event: "state_changed".into(), data })
                }
                EngineEvent::Saved { clip } => {
                    notify_critical(
                        format!("Clip saved — {}", clip.game),
                        format!("{:.1}s · {}×{}", clip.duration_s, clip.width, clip.height),
                    );
                    if let Some(p) = &chime_path {
                        play_chime(p);
                    }
                    serde_json::to_value(&clip).map(|data| Event { event: "saved".into(), data })
                }
                EngineEvent::Error { error } => {
                    notify_critical("Capture failed".into(), error.message.clone());
                    serde_json::to_value(&error).map(|data| Event { event: "error".into(), data })
                }
            };
            match wire {
                Ok(event) => {
                    // Err only means zero subscribers — fine, drop it.
                    let _ = events.send(event);
                }
                Err(e) => log::warn!("event drain: failed to encode engine event: {e}"),
            }
        }
        log::info!("event drain: capture back-channel closed");
    });
}

/// Fire a DND-piercing desktop notification (6-SF1 half). `notify-send -u critical`
/// genuinely raises urgency, so it surfaces over a fullscreen game's Do-Not-Disturb
/// — the reason this path was chosen over the portal's Priority::Urgent (which can't
/// guarantee it). Fire-and-forget: the spawn + reap run on a detached thread so the
/// event drain never blocks and no zombie `notify-send` accumulates. If `notify-send`
/// is absent (`.spawn()` errs), it's silently a no-op — never fatal.
#[cfg(target_os = "linux")]
fn notify_critical(summary: String, body: String) {
    std::thread::spawn(move || {
        if let Ok(mut child) = std::process::Command::new("notify-send")
            .args([
                "-u", "critical",
                "-a", "Iskariel Capture",
                "-i", "dev.malthaiel.iskariel",
                &summary, &body,
            ])
            .spawn()
        {
            let _ = child.wait();
        }
    });
}

/// Synthesize the save chime to `$XDG_RUNTIME_DIR/iskariel/save-chime.wav` once
/// at daemon start; returns the path on success. The PCM is generated in-process
/// (16-bit mono 48 kHz WAV) — no bundled asset, no `include_bytes!`, achieving the
/// same "embedded, no external file dependency" end with less machinery. A failed
/// write returns `None` → the save is simply silent.
#[cfg(target_os = "linux")]
fn materialize_chime() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?).join("mortar-pestle");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("save-chime.wav");
    std::fs::write(&path, synth_chime_wav()).ok()?;
    Some(path)
}

/// A short, pleasant two-note rising chime (A5 → D6) as a 16-bit mono 48 kHz WAV.
/// Each note has a raised-cosine fade in/out to kill clicks.
#[cfg(target_os = "linux")]
fn synth_chime_wav() -> Vec<u8> {
    const SR: u32 = 48_000;
    // (frequency Hz, duration s) — A5 then D6.
    const NOTES: [(f32, f32); 2] = [(880.0, 0.11), (1174.66, 0.13)];
    let fade = (SR as f32 * 0.006) as usize; // 6 ms ramp
    let mut samples: Vec<i16> = Vec::new();
    for (freq, dur) in NOTES {
        let n = (SR as f32 * dur) as usize;
        for i in 0..n {
            let t = i as f32 / SR as f32;
            let mut a = (2.0 * std::f32::consts::PI * freq * t).sin() * 0.28;
            if i < fade {
                a *= 0.5 - 0.5 * (std::f32::consts::PI * i as f32 / fade as f32).cos();
            }
            if i >= n - fade {
                let k = (n - i) as f32;
                a *= 0.5 - 0.5 * (std::f32::consts::PI * k / fade as f32).cos();
            }
            samples.push((a * i16::MAX as f32) as i16);
        }
    }
    wav_pcm16_mono(&samples, SR)
}

/// Wrap signed-16 mono PCM in a canonical 44-byte WAV header.
#[cfg(target_os = "linux")]
fn wav_pcm16_mono(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // channels = mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Fire-and-forget the save chime via `pw-play` (PipeWire). Mirrors
/// [`notify_critical`]: a detached thread spawns + reaps the child so the drain
/// never blocks and no zombie accrues; a missing `pw-play` (`.spawn()` errs) is a
/// silent no-op (never fatal).
#[cfg(target_os = "linux")]
fn play_chime(path: &Path) {
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        if let Ok(mut child) = std::process::Command::new("pw-play").arg(&path).spawn() {
            let _ = child.wait();
        }
    });
}
