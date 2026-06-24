//! `iskariel-capture` — the Game Capture engine.
//!
//! Scaffold (Game Capture Engine Scaffolding, 2026-06-13). A windowless capture
//! + encode engine: xdg-desktop-portal ScreenCast + PipeWire dmabuf -> NVENC.
//! The Phase-0 spikes seed this binary as `spike <name>` subcommands; `run` is
//! the Phase-1 capture->encode loop. `daemon` is the long-running control surface
//! (Complete Phase 1, sub-plan 5): a Unix-socket NDJSON protocol drives start/stop.

// Linux capture backend (PipeWire/EGL/portal) — the whole capture/daemon/run
// surface is Linux-only today; the Windows port lands per-SF (Game Capture SF0+).
#[cfg(target_os = "linux")]
mod capture;
// Windows capture backend (WGC + D3D11) — a DIFFERENT file from the Linux
// capture/mod.rs, cfg-selected as `crate::capture`; the two never compile
// together, so neither is gated internally (Game Capture SF2).
#[cfg(windows)]
#[path = "capture/windows/mod.rs"]
mod capture;
// The daemon engine + `run` (Recorder/TeeSink/FrameSink) compile on both OSes now
// (Game Capture SF3): the Linux-only CLI/socket/portal bits are cfg-gated within.
#[cfg(any(target_os = "linux", windows))]
mod daemon;
#[cfg(any(target_os = "linux", windows))]
mod run;
mod spike;

use std::process::ExitCode;

const USAGE: &str = "\
usage: iskariel-capture <command>

commands:
  spike d3d11wgc  (Windows) SF0 gate: WGC->D3D11->NVENC DirectX->ffmpeg-decode; eyeball the PNG
  capture probe   (Windows) SF2 gate: WGC frame source — grab N frames + test pool Recreate on resize
  capture record  (Windows) SF3 gate: record the foreground window to a playable MP4: record <out.mp4|dir> [secs]
  capture replay  (Windows) SF3 gate: arm the replay ring + save a clip: replay <dir> [secs]
  capture probe-pipe  (Windows) SF4 gate: connect to the daemon control pipe + a get_state round-trip
  spike interop   (Linux) Encode B1 dmabuf->EGL->GL->NVENC->ffmpeg-decode; GL-vs-CUDA verdict
  spike color     Encode B2  ARGB color-matrix probe (subsumed: eyeball decode-proof MP4)
  spike tear      Capture B3 explicit-sync tear check (subsumed: eyeball decode-proof MP4)
  spike pacing    Capture B4 maxFramerate delivery check (subsumed: 'run' delivered-fps stat)
  run             Phase-1 capture->encode loop: --dump-es <path.h264> [--duration <secs>]
  daemon          Long-running control daemon (Unix-socket NDJSON); start/stop clips on command
  decode-proof    Remux a captured ES to a viewable MP4: decode-proof <in.h264> <out.mp4>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match (args.first().map(String::as_str), args.get(1).map(String::as_str)) {
        // B1 interop spike (Stage B, Linux): the GL-vs-CUDA fork. Implemented.
        #[cfg(target_os = "linux")]
        (Some("spike"), Some("interop")) => spike::interop::run(),
        // SF0 feasibility spike (Windows): WGC -> D3D11 -> NVENC DirectX. THE GATE.
        #[cfg(windows)]
        (Some("spike"), Some("d3d11wgc")) => spike::d3d11wgc::run(),
        // SF2 capture-module gate (Windows): the WGC frame source + pool Recreate.
        #[cfg(windows)]
        (Some("capture"), Some("probe")) => {
            let frames = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(120);
            match capture::probe(frames) {
                Ok(n) => {
                    eprintln!(
                        "\nVERDICT: SF2 — captured {n} frames on the shared device (see the log for \
                         sizes + the Recreate count). Resize the window mid-run to exercise Recreate."
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("\nVERDICT: SF2 FAILED — {e}");
                    ExitCode::from(1)
                }
            }
        }
        // SF3 gate (Windows): record the foreground window to a playable MP4, driving
        // the engine in-process via `send_cmd` (no socket — that's SF4).
        #[cfg(windows)]
        (Some("capture"), Some("record")) => capture_record(&args[2..]),
        // SF3 gate (Windows): arm the replay ring, fill it, then save a clip from it.
        #[cfg(windows)]
        (Some("capture"), Some("replay")) => capture_replay(&args[2..]),
        // SF4 gate (Windows): connect to the daemon control pipe + a get_state round-trip.
        #[cfg(windows)]
        (Some("capture"), Some("probe-pipe")) => capture_probe_pipe(&args[2..]),
        (Some("spike"), Some(name @ ("color" | "tear" | "pacing"))) => {
            eprintln!("iskariel-capture: spike '{name}' not yet implemented (Stage B)");
            ExitCode::from(2)
        }
        (Some("spike"), other) => {
            eprintln!("iskariel-capture: unknown spike {other:?}");
            ExitCode::from(2)
        }
        #[cfg(target_os = "linux")]
        (Some("run"), _) => run::run(&args[1..]),
        // Complete Phase 1 (sub-plan 5): the long-running control daemon.
        #[cfg(target_os = "linux")]
        (Some("daemon"), _) => daemon::run(&args[1..]),
        // Windows: a stub that points at the SF3 `capture record`/`replay` gates
        // (the named-pipe control transport is SF4).
        #[cfg(windows)]
        (Some("daemon"), _) => daemon::run(&args[1..]),
        #[cfg(target_os = "linux")]
        (Some("decode-proof"), _) => run::decode_proof(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// SF3 gate (Windows): record the foreground window to a playable MP4 by driving the
/// engine in-process — no socket (SF4 owns transport). Proves arm→capture→encode→mux
/// end to end: a non-empty MP4 that ffmpeg can decode, plus a decode-proof PNG.
#[cfg(windows)]
fn capture_record(args: &[String]) -> ExitCode {
    use crate::daemon::engine::{new_cmd_channel, spawn_capture, EngineCmd, EngineEvent};
    use crate::daemon::protocol::CaptureConfig;
    use crate::daemon::state::Engine;
    use std::time::{Duration, Instant};

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let Some(out) = args.first() else {
        eprintln!("usage: iskariel-capture capture record <out.mp4|dir> [secs]");
        return ExitCode::from(2);
    };
    let secs: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8);
    let dir = gate_dir(out);
    let _ = std::fs::create_dir_all(&dir);
    std::env::set_var("ISKARIEL_CAPTURES_DIR", &dir);

    let engine = std::sync::Arc::new(std::sync::Mutex::new(Engine::new(CaptureConfig::default())));
    let (cmd_tx, cmd_rx) = new_cmd_channel();
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
    let handle = spawn_capture(engine.clone(), cmd_rx, event_tx);

    if cmd_tx.send(EngineCmd::StartClip { game: Some("Gate".into()) }).is_err() {
        eprintln!("\nVERDICT: SF3 FAILED — the capture thread is unreachable");
        return ExitCode::from(1);
    }
    log::info!("recording the foreground window for {secs}s…");
    std::thread::sleep(Duration::from_secs(secs));
    let _ = cmd_tx.send(EngineCmd::StopClip);

    let saved = wait_for_saved(&mut event_rx, Instant::now() + Duration::from_secs(30));
    let _ = cmd_tx.send(EngineCmd::Shutdown);
    let _ = handle.join();
    finish_gate(saved)
}

/// SF3 gate (Windows): arm the replay ring, let it fill, then save a clip from it —
/// exercises the ring→snapshot→mux path (vs the live `record` path).
#[cfg(windows)]
fn capture_replay(args: &[String]) -> ExitCode {
    use crate::daemon::engine::{new_cmd_channel, spawn_capture, EngineCmd, EngineEvent};
    use crate::daemon::protocol::CaptureConfig;
    use crate::daemon::state::Engine;
    use std::time::{Duration, Instant};

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let Some(out) = args.first() else {
        eprintln!("usage: iskariel-capture capture replay <dir> [secs]");
        return ExitCode::from(2);
    };
    let secs: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8);
    let dir = gate_dir(out);
    let _ = std::fs::create_dir_all(&dir);
    std::env::set_var("ISKARIEL_CAPTURES_DIR", &dir);

    let engine = std::sync::Arc::new(std::sync::Mutex::new(Engine::new(CaptureConfig::default())));
    let (cmd_tx, cmd_rx) = new_cmd_channel();
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
    let handle = spawn_capture(engine.clone(), cmd_rx, event_tx);

    if cmd_tx.send(EngineCmd::Arm).is_err() {
        eprintln!("\nVERDICT: SF3 FAILED — the capture thread is unreachable");
        return ExitCode::from(1);
    }
    log::info!("armed; filling the replay ring for {secs}s…");
    std::thread::sleep(Duration::from_secs(secs));
    let _ = cmd_tx.send(EngineCmd::SaveReplay { window_secs: None });

    let saved = wait_for_saved(&mut event_rx, Instant::now() + Duration::from_secs(30));
    let _ = cmd_tx.send(EngineCmd::Disarm);
    let _ = cmd_tx.send(EngineCmd::Shutdown);
    let _ = handle.join();
    finish_gate(saved)
}

/// SF4 gate (Windows): connect to the daemon's control pipe (`\\.\pipe\iskariel-capture`)
/// and run a `get_state` round-trip, printing the snapshot. Proves the named-pipe
/// transport end to end — the host adopt-probe path (SF7) mirrors this connect+request.
/// Launch the daemon first (`iskariel-capture daemon`), then run this in a 2nd process;
/// a 2nd `daemon` should instead print "already running" (the single-instance reject).
#[cfg(windows)]
fn capture_probe_pipe(_args: &[String]) -> ExitCode {
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ClientOptions;

    const PIPE_NAME: &str = r"\\.\pipe\iskariel-capture";

    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("\nVERDICT: SF4 FAILED — tokio runtime: {e}");
            return ExitCode::from(1);
        }
    };

    runtime.block_on(async move {
        // Connect, retrying on ERROR_PIPE_BUSY (231) — mirrors the host client.
        let connect = async {
            loop {
                match ClientOptions::new().open(PIPE_NAME) {
                    Ok(c) => return Ok(c),
                    Err(e) if e.raw_os_error() == Some(231) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(e) => return Err(e),
                }
            }
        };
        let client = match tokio::time::timeout(Duration::from_secs(3), connect).await {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                eprintln!(
                    "\nVERDICT: SF4 FAILED — could not open {PIPE_NAME}: {e}\n  \
                     (is the daemon running? `iskariel-capture daemon`)"
                );
                return ExitCode::from(1);
            }
            Err(_) => {
                eprintln!("\nVERDICT: SF4 FAILED — timed out opening {PIPE_NAME} (no daemon?)");
                return ExitCode::from(1);
            }
        };

        let (read_half, mut write_half) = tokio::io::split(client);
        // Send one get_state request line.
        let wrote = async {
            write_half.write_all(br#"{"op":"get_state","id":"1"}"#).await?;
            write_half.write_all(b"\n").await?;
            write_half.flush().await
        }
        .await;
        if let Err(e) = wrote {
            eprintln!("\nVERDICT: SF4 FAILED — write get_state: {e}");
            return ExitCode::from(1);
        }

        // Read one response line (timeout-bounded so a wedged daemon can't hang the gate).
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        match tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await {
            Ok(Ok(n)) if n > 0 => {
                let ok = serde_json::from_str::<serde_json::Value>(line.trim())
                    .ok()
                    .and_then(|v| v.get("ok").and_then(|b| b.as_bool()))
                    .unwrap_or(false);
                if ok {
                    println!("get_state OK — {}", line.trim());
                    eprintln!("\nVERDICT: SF4 GO — pipe round-trip succeeded over {PIPE_NAME}");
                    ExitCode::SUCCESS
                } else {
                    eprintln!("get_state response: {}", line.trim());
                    eprintln!("\nVERDICT: SF4 FAILED — the daemon answered ok:false");
                    ExitCode::from(1)
                }
            }
            Ok(Ok(_)) => {
                eprintln!("\nVERDICT: SF4 FAILED — the daemon closed the pipe with no response");
                ExitCode::from(1)
            }
            Ok(Err(e)) => {
                eprintln!("\nVERDICT: SF4 FAILED — read response: {e}");
                ExitCode::from(1)
            }
            Err(_) => {
                eprintln!("\nVERDICT: SF4 FAILED — timed out waiting for the get_state response");
                ExitCode::from(1)
            }
        }
    })
}

/// Resolve the gate's output dir: a path with an extension → its parent dir; else the
/// path itself (treated as a directory).
#[cfg(windows)]
fn gate_dir(out: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(out);
    if p.extension().is_some() {
        p.parent().map(|d| d.to_path_buf()).unwrap_or_else(std::env::temp_dir)
    } else {
        p.to_path_buf()
    }
}

/// Poll the engine's `EngineEvent` back-channel until a clip is `Saved` (returns its
/// path), an `Error` arrives, or the deadline passes. Non-blocking `try_recv` + a
/// short sleep so a wedged finalize can't hang the gate forever.
#[cfg(windows)]
fn wait_for_saved(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<crate::daemon::engine::EngineEvent>,
    deadline: std::time::Instant,
) -> Option<String> {
    use crate::daemon::engine::EngineEvent;
    use tokio::sync::mpsc::error::TryRecvError;
    loop {
        match rx.try_recv() {
            Ok(EngineEvent::Saved { clip }) => return Some(clip.path),
            Ok(EngineEvent::Error { error }) => {
                eprintln!("capture error: {} — {}", error.code, error.message);
                return None;
            }
            Ok(_) => {}
            Err(TryRecvError::Disconnected) => return None,
            Err(TryRecvError::Empty) => {
                if std::time::Instant::now() >= deadline {
                    eprintln!("timed out waiting for the clip to finalize");
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// Verdict for the SF3 gate: assert a non-empty MP4 + an ffmpeg decode-proof PNG.
#[cfg(windows)]
fn finish_gate(saved: Option<String>) -> ExitCode {
    let Some(path) = saved else {
        eprintln!("\nVERDICT: SF3 FAILED — no clip was saved");
        return ExitCode::from(1);
    };
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size < 64 * 1024 {
        eprintln!("\nVERDICT: SF3 FAILED — clip {path} is too small ({size} bytes)");
        return ExitCode::from(1);
    }
    let png = std::path::Path::new(&path).with_extension("png");
    let decoded = std::process::Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(&path)
        .args(["-frames:v", "1"])
        .arg(&png)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
        && std::fs::metadata(&png).map(|m| m.len() > 0).unwrap_or(false);
    if !decoded {
        eprintln!("\nVERDICT: SF3 FAILED — ffmpeg could not decode {path}");
        return ExitCode::from(1);
    }
    eprintln!(
        "\nVERDICT: SF3 GO — recorded a playable MP4 ({size} bytes): {path}\n  \
         decode-proof PNG: {} — open it and eyeball the captured window.",
        png.display()
    );
    ExitCode::SUCCESS
}
