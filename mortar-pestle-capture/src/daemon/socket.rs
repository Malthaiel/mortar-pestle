//! The daemon's Unix-socket NDJSON control server (sub-plan 5 SF1b).
//!
//! tokio (multi-thread) `UnixListener` at `$XDG_RUNTIME_DIR/mortar-pestle/capture.sock`.
//! One JSON `Request` per line in, one `Response` line out, plus unsolicited wire
//! `Event`s interleaved onto every connected client. Single-instance: bind, or —
//! if the socket is already bound — probe it with `hello`; a live daemon answers,
//! a stale socket gets unlinked + rebound.
//!
//! This layer is autonomously testable: it never touches PipeWire/EGL/NVENC. It
//! reads the shared `Engine` for snapshots and forwards mutating verbs to the
//! capture thread via `ControlContext::send_cmd`.
#![allow(dead_code)] // 5-SF1a swaps the placeholder capture behind this unchanged.

use std::io;
#[cfg(unix)]
use std::path::PathBuf;

use serde_json::json;
#[cfg(unix)]
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(windows)]
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::mpsc;

use mortar_pestle_daemon::framing;
#[cfg(windows)]
use mortar_pestle_daemon::pipe;
#[cfg(unix)]
use mortar_pestle_daemon::sock;

use crate::daemon::engine::{ControlContext, EngineCmd};
use crate::daemon::protocol::Event;
use crate::daemon::protocol::{ProtoError, Request, Response};

/// `$XDG_RUNTIME_DIR/mortar-pestle/capture.sock` (falls back to `/tmp` if the env
/// var is unset, matching tokio/portal conventions for a session-scoped socket).
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    sock::socket_path("capture.sock")
}

/// `\\.\pipe\mortar-pestle-capture` — the Windows named-pipe analogue of the Unix socket
/// path. The kernel owns the `\\.\pipe\` namespace, so there is no parent dir to
/// create and no stale endpoint to unlink (a pipe instance is a kernel object that
/// vanishes when its owning process exits). Mirrors the host
/// `src-tauri/src/capture/client.rs::PIPE_NAME` (the two crates are decoupled by
/// design — this name string is the coupling, exactly as the socket path is on Unix).
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\mortar-pestle-capture";

/// Build + run the control server. Binds (single-instance) via the shared
/// `sock::bind_or_probe` (probe: `hello`, live = `ok:true` + `data.state`
/// present), then accepts clients until the process is killed. On "already
/// running" it prints one line and exits the process (0) — the single-instance
/// probe path. Errors propagate to the caller (a bind failure that is NOT
/// "already running").
#[cfg(unix)]
pub async fn serve(ctx: ControlContext) -> io::Result<()> {
    let path = socket_path();
    let live: sock::Liveness = Box::new(|v: &Value| {
        let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let has_state = v.get("data").and_then(|d| d.get("state")).is_some();
        ok && has_state
    });
    let listener = match sock::bind_or_probe(&path, "hello", json!({ "version": 1 }), live).await? {
        Some(l) => l,
        None => {
            // Live daemon already owns the socket — single-instance contract.
            println!("mortar-pestle-capture: daemon already running ({})", path.display());
            std::process::exit(0);
        }
    };
    log::info!("capture control socket listening at {}", path.display());

    // Accept clients until the `shutdown` op wakes this signal — then `serve`
    // returns so `daemon::run` can join the capture thread and the process exits.
    let shutdown = ctx.shutdown_handle();
    let on_shutdown = async move { shutdown.notified().await };
    tokio::pin!(on_shutdown);
    loop {
        tokio::select! {
            _ = &mut on_shutdown => {
                log::info!("control socket: shutdown requested — stopping accept loop");
                break;
            }
            accepted = listener.accept() => match accepted {
                Ok((stream, _addr)) => {
                    let ctx = ctx.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_client(stream, ctx).await {
                            log::debug!("client connection ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::warn!("accept failed: {e}");
                }
            }
        }
    }
    Ok(())
}

/// Windows control server over a named pipe — the `\\.\pipe\mortar-pestle-capture`
/// analogue of the Unix `serve`. Single-instance is structural:
/// `first_pipe_instance(true)` makes a second daemon's `create()` fail with
/// `ERROR_ACCESS_DENIED` (raw OS 5), which IS the "already running" signal — no
/// `AddrInUse` probe, no stale-file unlink (a pipe instance is a kernel object
/// reclaimed when its process exits).
///
/// A `NamedPipeServer` instance is BOTH the listener and (once a client attaches) the
/// connection: `connect().await` resolves when a client opens this instance. So the
/// accept loop must pre-create the NEXT listening instance BEFORE handing the connected
/// one to its serve task, or a fast second client races a connect gap (`ERROR_PIPE_BUSY`).
#[cfg(windows)]
pub async fn serve(ctx: ControlContext) -> io::Result<()> {
    let mut server = match pipe::bind_first(PIPE_NAME) {
        Ok(s) => s,
        // ERROR_ACCESS_DENIED (5) / PermissionDenied ⇒ another daemon owns the name.
        Err(e) if pipe::already_running(&e) || e.kind() == io::ErrorKind::PermissionDenied => {
            println!("mortar-pestle-capture: daemon already running ({PIPE_NAME})");
            std::process::exit(0);
        }
        Err(e) => return Err(e),
    };
    log::info!("capture control pipe listening at {PIPE_NAME}");

    // Accept clients until the `shutdown` op wakes this signal — then `serve` returns
    // so `daemon::run` can join the pacer and the process exits.
    let shutdown = ctx.shutdown_handle();
    let on_shutdown = async move { shutdown.notified().await };
    tokio::pin!(on_shutdown);
    loop {
        tokio::select! {
            _ = &mut on_shutdown => {
                log::info!("control pipe: shutdown requested — stopping accept loop");
                break;
            }
            res = server.connect() => match res {
                Ok(()) => {
                    // The connected instance IS the connection. `pipe::accept_next`
                    // pre-creates the next listening instance BEFORE serving this one
                    // (NOT first_pipe_instance — only the first create claims the
                    // name), so the pipe is always attachable for the next client.
                    let (connected, next) = pipe::accept_next(PIPE_NAME, server)?;
                    server = next;
                    let ctx = ctx.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_client(connected, ctx).await {
                            log::debug!("client connection ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    // Connect failed on this instance — recreate the listener + continue.
                    log::warn!("pipe connect failed: {e}");
                    server = pipe::create_next(PIPE_NAME)?;
                }
            }
        }
    }
    Ok(())
}

/// Per-OS client entry: split the endpoint into owned read/write halves, then serve.
/// Unix uses `UnixStream::into_split`; Windows splits the `NamedPipeServer` via
/// `tokio::io::split` (named pipes have no `into_split`). Both yield `Send + 'static`
/// halves so the writer half can move into its task.
#[cfg(unix)]
async fn handle_client(stream: UnixStream, ctx: ControlContext) -> io::Result<()> {
    let (read_half, write_half) = stream.into_split();
    serve_conn(read_half, write_half, ctx).await
}

#[cfg(windows)]
async fn handle_client(stream: NamedPipeServer, ctx: ControlContext) -> io::Result<()> {
    let (read_half, write_half) = tokio::io::split(stream);
    serve_conn(read_half, write_half, ctx).await
}

/// Serve one client: read `Request`s line-by-line, dispatch each to a `Response`,
/// and interleave broadcast `Event`s onto the same stream. A single writer task
/// owns the write half and merges responses (via an mpsc) with the broadcast bus,
/// so responses and events never interleave mid-line. Generic over the split halves
/// so one body serves both the Unix socket and the Windows named pipe.
async fn serve_conn<R, W>(read_half: R, mut write_half: W, ctx: ControlContext) -> io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    // Per-client response channel (reader → writer) + a subscription to the bus.
    let (resp_tx, mut resp_rx) = mpsc::unbounded_channel::<String>();
    let mut events = ctx.events.subscribe();

    // Writer task: merge responses + broadcast events into one ordered stream.
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Responses to this client's requests.
                maybe = resp_rx.recv() => {
                    match maybe {
                        Some(line) => {
                            if framing::write_line(&mut write_half, &line).await.is_err() {
                                break;
                            }
                        }
                        // Reader gone (client closed / EOF) → finish writing.
                        None => break,
                    }
                }
                // Unsolicited engine events, broadcast to every client.
                ev = events.recv() => {
                    match ev {
                        Ok(event) => {
                            if let Ok(line) = serde_json::to_string(&event) {
                                if framing::write_line(&mut write_half, &line).await.is_err() {
                                    break;
                                }
                            }
                        }
                        // Lagged: drop the gap, keep streaming (snapshot is truth).
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("client lagged {n} events");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    // Reader: one JSON Request per line → dispatch → push the Response line.
    // `.take()` + per-line `set_limit` caps a hostile unterminated line at
    // MAX_LINE_BYTES (the shared framing / broadcast idiom) instead of wedging
    // an unbounded `lines()` reader.
    let mut reader = BufReader::new(read_half).take(framing::MAX_LINE_BYTES as u64);
    let mut line = String::new();
    loop {
        line.clear();
        reader.set_limit(framing::MAX_LINE_BYTES as u64);
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => dispatch(&ctx, req),
            // Malformed line: bad_request, NO panic, keep the connection alive.
            Err(e) => Response {
                id: framing::extract_id::<String>(trimmed),
                ok: false,
                data: None,
                error: Some(ProtoError::new("bad_request", format!("invalid JSON request: {e}"))),
            },
        };
        if let Ok(out) = serde_json::to_string(&resp) {
            // Writer gone ⇒ client dropped; stop reading.
            if resp_tx.send(out).is_err() {
                break;
            }
        }
    }

    // Reader done: drop the response sender so the writer task finishes.
    drop(resp_tx);
    let _ = writer.await;
    Ok(())
}

/// Map a parsed `Request` to a `Response` using the frozen protocol types.
///
/// - `hello` / `get_state` → read-only `Engine::snapshot`.
/// - `start_clip` / `stop_clip` / `set_config` / `rebind_hotkeys` / `shutdown`
///   → forward an `EngineCmd` to the capture thread (mutations).
/// - `arm` / `disarm` / `save_replay` → forward a ring `EngineCmd` (mutations).
/// - `screenshot` → spawn the XDG Screenshot portal off-thread, ack with a
///   snapshot now, deliver the saved PNG path via the `screenshot_saved` event.
/// - anything else → `bad_request`.
fn dispatch(ctx: &ControlContext, req: Request) -> Response {
    match req.op.as_str() {
        "hello" | "get_state" => snapshot_response(ctx, req.id),

        "start_clip" => {
            let game = req
                .args
                .get("game")
                .and_then(|g| g.as_str())
                .map(str::to_owned);
            forward_then_snapshot(ctx, req.id, EngineCmd::StartClip { game })
        }
        "stop_clip" => forward_then_snapshot(ctx, req.id, EngineCmd::StopClip),
        "set_config" => match serde_json::from_value(req.args.clone()) {
            Ok(cfg) => forward_then_snapshot(ctx, req.id, EngineCmd::SetConfig(cfg)),
            Err(e) => err_response(
                req.id,
                ProtoError::new("bad_request", format!("invalid config: {e}")),
            ),
        },
        // Hotkey rebinding routes to the hotkeys portal task (NOT the capture
        // thread): it opens KDE's ConfigureShortcuts UI. Best-effort — ack with a
        // fresh snapshot regardless (the UI reads `hotkeys.can_configure`/triggers).
        // On Windows the chords are fixed (SF6 winhook, `can_configure:false`), so the
        // verb stays in the contract but answers `not_implemented`.
        #[cfg(unix)]
        "rebind_hotkeys" => {
            if let Err(e) = ctx.rebind() {
                log::warn!("rebind_hotkeys: {e}");
            }
            snapshot_response(ctx, req.id)
        }
        #[cfg(windows)]
        "rebind_hotkeys" => err_response(
            req.id,
            ProtoError::new("not_implemented", "hotkey rebinding is fixed on Windows (SF6)"),
        ),
        "shutdown" => {
            // Tear the capture thread down, then wake `serve`'s accept loop so the
            // process actually exits. Reply with a final snapshot ack first
            // (best-effort flush before the runtime winds down).
            let _ = ctx.send_cmd(EngineCmd::Shutdown);
            let resp = snapshot_response(ctx, req.id);
            ctx.signal_shutdown();
            resp
        }

        "arm" => forward_then_snapshot(ctx, req.id, EngineCmd::Arm),
        "disarm" => forward_then_snapshot(ctx, req.id, EngineCmd::Disarm),
        "save_replay" => {
            // `windowSecs` (camelCase, like the config wire): omitted → full window;
            // e.g. 30 → last-30s quick-save. The ring supports any sub-window.
            let window_secs = req
                .args
                .get("windowSecs")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            forward_then_snapshot(ctx, req.id, EngineCmd::SaveReplay { window_secs })
        }

        // Screenshot — the portal call is async + may prompt, so spawn it off the
        // sync dispatch path: ack immediately with a snapshot, then broadcast the
        // saved PNG path via `screenshot_saved` (mirrors save_replay → `saved`).
        // Windows screenshot lands with the overlay-capture HUD (SF9); until then the
        // verb stays in the contract but answers `not_implemented` (below).
        #[cfg(unix)]
        "screenshot" => {
            let events = ctx.events.clone();
            tokio::spawn(async move {
                match take_screenshot().await {
                    Ok(path) => {
                        log::info!("screenshot saved: {path}");
                        let _ = events.send(Event {
                            event: "screenshot_saved".into(),
                            data: json!({ "path": path }),
                        });
                    }
                    Err(e) => {
                        log::warn!("screenshot failed: {e}");
                        let _ = events.send(Event {
                            event: "error".into(),
                            data: json!({ "code": "screenshot_failed", "message": e, "fatal": false }),
                        });
                    }
                }
            });
            snapshot_response(ctx, req.id)
        }
        // Windows twin (SF9): WGC one-frame monitor grab + PNG, on its own
        // COM-initialized thread (WGC/D3D11 must never run on the dispatch task).
        // Same contract as the portal arm: ack now, `screenshot_saved` later.
        #[cfg(windows)]
        "screenshot" => {
            let events = ctx.events.clone();
            std::thread::spawn(move || {
                match crate::capture::screenshot::take_screenshot() {
                    Ok(path) => {
                        log::info!("screenshot saved: {path}");
                        let _ = events.send(Event {
                            event: "screenshot_saved".into(),
                            data: json!({ "path": path }),
                        });
                    }
                    Err(e) => {
                        log::warn!("screenshot failed: {e}");
                        let _ = events.send(Event {
                            event: "error".into(),
                            data: json!({ "code": "screenshot_failed", "message": e, "fatal": false }),
                        });
                    }
                }
            });
            snapshot_response(ctx, req.id)
        }

        other => err_response(
            req.id,
            ProtoError::new("bad_request", format!("unknown op `{other}`")),
        ),
    }
}

/// Read the shared engine + project a snapshot into a success `Response`.
fn snapshot_response(ctx: &ControlContext, id: String) -> Response {
    let snap = {
        let engine = ctx.engine.lock().expect("engine mutex poisoned");
        engine.snapshot(now_mono_ns())
    };
    match serde_json::to_value(&snap) {
        Ok(data) => Response { id, ok: true, data: Some(data), error: None },
        Err(e) => err_response(id, ProtoError::new("internal", format!("snapshot encode: {e}"))),
    }
}

/// Forward a mutating command, then reply with the current snapshot (the UI-truth
/// contract: every mutation returns a snapshot). A send failure ⇒ `internal`.
fn forward_then_snapshot(ctx: &ControlContext, id: String, cmd: EngineCmd) -> Response {
    match ctx.send_cmd(cmd) {
        Ok(()) => snapshot_response(ctx, id),
        Err(e) => err_response(id, ProtoError::new("internal", e)),
    }
}

fn err_response(id: String, error: ProtoError) -> Response {
    Response { id, ok: false, data: None, error: Some(error) }
}

/// Capture a full-screen screenshot via the XDG Screenshot portal
/// (`interactive=false`, `modal=false` → a silent full-screen grab; KDE may prompt
/// on first use, after which the user's choice persists). Returns the saved PNG's
/// filesystem path (the `file://` URI scheme stripped). The path is stored verbatim
/// downstream (never copied), matching the clip "never copy" doctrine. Portal
/// filenames are ASCII-safe, so no percent-decoding is needed.
#[cfg(unix)]
async fn take_screenshot() -> Result<String, String> {
    use ashpd::desktop::screenshot::Screenshot;
    let response = Screenshot::request()
        .interactive(false)
        .modal(false)
        .send()
        .await
        .map_err(|e| format!("screenshot portal request: {e}"))?
        .response()
        .map_err(|e| format!("screenshot portal response: {e}"))?;
    let uri = response.uri().to_string();
    Ok(uri.strip_prefix("file://").unwrap_or(&uri).to_string())
}

/// Monotonic-ns clock, re-exported from the shared daemon crate (D5-WI-1) so
/// existing `crate::daemon::socket::now_mono_ns` imports (engine, pacer, audio,
/// capture/mod) keep working. Same `QueryPerformanceCounter` / `CLOCK_MONOTONIC`
/// math — the snapshot `elapsed_ns` clock domain is unchanged.
pub use mortar_pestle_daemon::clock::now_mono_ns;
