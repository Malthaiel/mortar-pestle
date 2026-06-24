//! The daemon's Unix-socket NDJSON control server (sub-plan 5 SF1b).
//!
//! tokio (multi-thread) `UnixListener` at `$XDG_RUNTIME_DIR/iskariel/capture.sock`.
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
use std::os::unix::fs::DirBuilderExt;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use serde_json::json;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::daemon::engine::{ControlContext, EngineCmd};
#[cfg(unix)]
use crate::daemon::protocol::Event;
use crate::daemon::protocol::{ProtoError, Request, Response};

/// `$XDG_RUNTIME_DIR/iskariel/capture.sock` (falls back to `/tmp` if the env
/// var is unset, matching tokio/portal conventions for a session-scoped socket).
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime.join("iskariel").join("capture.sock")
}

/// `\\.\pipe\iskariel-capture` — the Windows named-pipe analogue of the Unix socket
/// path. The kernel owns the `\\.\pipe\` namespace, so there is no parent dir to
/// create and no stale endpoint to unlink (a pipe instance is a kernel object that
/// vanishes when its owning process exits). Mirrors the host
/// `src-tauri/src/capture/client.rs::PIPE_NAME` (the two crates are decoupled by
/// design — this name string is the coupling, exactly as the socket path is on Unix).
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\iskariel-capture";

/// Bind the control socket, single-instance. Returns the bound listener, or `None`
/// when a live daemon already owns the socket — in which case the caller should
/// exit cleanly (already handled inside `serve`).
///
/// Order: ensure parent dir (0700) → try bind. On `AddrInUse`, probe the existing
/// socket with `hello`; a valid snapshot reply ⇒ live daemon (return `None`); any
/// connect/parse failure ⇒ stale socket ⇒ unlink + rebind.
#[cfg(unix)]
async fn bind_or_probe(path: &PathBuf) -> io::Result<Option<UnixListener>> {
    if let Some(parent) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }

    match UnixListener::bind(path) {
        Ok(listener) => Ok(Some(listener)),
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            if probe_live_daemon(path).await {
                log::info!("iskariel-capture daemon already running at {}", path.display());
                Ok(None)
            } else {
                log::warn!("stale capture socket at {} — unlinking + rebinding", path.display());
                let _ = std::fs::remove_file(path);
                match UnixListener::bind(path) {
                    Ok(listener) => Ok(Some(listener)),
                    // A lost cold-start race: another instance re-created the socket
                    // file between our unlink and bind. Retry the unlink+bind ONCE
                    // more before giving up (the live-probe path above is untouched).
                    Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                        log::warn!("rebind raced at {} — unlinking + retrying once", path.display());
                        let _ = std::fs::remove_file(path);
                        UnixListener::bind(path).map(Some)
                    }
                    Err(e) => Err(e),
                }
            }
        }
        Err(e) => Err(e),
    }
}

/// Connect to an existing socket and send `hello`; `true` iff a live daemon
/// answers with a valid snapshot (`ok:true` + a `data.state` field). Any connect,
/// write, read, or parse failure (and a short timeout) ⇒ `false` ⇒ treat as stale.
#[cfg(unix)]
async fn probe_live_daemon(path: &PathBuf) -> bool {
    let probe = async {
        let mut stream = UnixStream::connect(path).await.ok()?;
        let hello = serde_json::to_string(&Request {
            op: "hello".into(),
            id: "probe".into(),
            args: json!({ "version": 1 }),
        })
        .ok()?;
        stream.write_all(hello.as_bytes()).await.ok()?;
        stream.write_all(b"\n").await.ok()?;
        stream.flush().await.ok()?;

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.ok()?;
        if n == 0 {
            return None;
        }
        let resp: Response = serde_json::from_str(line.trim()).ok()?;
        // A valid snapshot reply: ok + a `state` field in data.
        let has_state = resp
            .data
            .as_ref()
            .and_then(|d| d.get("state"))
            .is_some();
        if resp.ok && has_state {
            Some(())
        } else {
            None
        }
    };

    matches!(
        tokio::time::timeout(Duration::from_secs(2), probe).await,
        Ok(Some(()))
    )
}

/// Build + run the control server. Binds (single-instance), then accepts clients
/// until the process is killed. On "already running" it prints one line and exits
/// the process (0) — the single-instance probe path. Errors propagate to the
/// caller (a bind failure that is NOT "already running").
#[cfg(unix)]
pub async fn serve(ctx: ControlContext) -> io::Result<()> {
    let path = socket_path();
    let listener = match bind_or_probe(&path).await? {
        Some(l) => l,
        None => {
            // Live daemon already owns the socket — single-instance contract.
            println!("iskariel-capture: daemon already running ({})", path.display());
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

/// Windows control server over a named pipe — the `\\.\pipe\iskariel-capture`
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
    let mut server = match ServerOptions::new().first_pipe_instance(true).create(PIPE_NAME) {
        Ok(s) => s,
        // ERROR_ACCESS_DENIED (5) / PermissionDenied ⇒ another daemon owns the name.
        Err(e) if e.raw_os_error() == Some(5) || e.kind() == io::ErrorKind::PermissionDenied => {
            println!("iskariel-capture: daemon already running ({PIPE_NAME})");
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
                    // The connected instance IS the connection. Pre-create the next
                    // listening instance BEFORE serving this one (NOT first_pipe_instance —
                    // only the first create claims the name), so the pipe is always
                    // attachable for the next client.
                    let connected = server;
                    server = ServerOptions::new().create(PIPE_NAME)?;
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
                    server = ServerOptions::new().create(PIPE_NAME)?;
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
                            if write_line(&mut write_half, &line).await.is_err() {
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
                                if write_line(&mut write_half, &line).await.is_err() {
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
    let mut lines = BufReader::new(read_half).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Request>(&line) {
            Ok(req) => dispatch(&ctx, req),
            // Malformed line: bad_request, NO panic, keep the connection alive.
            Err(e) => Response {
                id: extract_id(&line),
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

/// Write one NDJSON line (`line` + `\n`) and flush.
async fn write_line<W>(w: &mut W, line: &str) -> io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await
}

/// Best-effort `id` recovery from a malformed line so the error response still
/// correlates. Falls back to empty when the line is not even partial JSON.
fn extract_id(line: &str) -> String {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_owned))
        .unwrap_or_default()
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
        #[cfg(windows)]
        "screenshot" => err_response(
            req.id,
            ProtoError::new("not_implemented", "screenshot not implemented on Windows yet (SF9)"),
        ),

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

/// Current `CLOCK_MONOTONIC` in ns — the same clock domain `Engine::snapshot`
/// expects for `elapsed_ns`. (Wraps `clock_gettime`; falls back to 0.)
#[cfg(unix)]
pub fn now_mono_ns() -> u64 {
    let mut ts = libc_timespec();
    // SAFETY: `ts` is a valid, owned `timespec`; CLOCK_MONOTONIC is always valid.
    let rc = unsafe { clock_gettime(CLOCK_MONOTONIC, &mut ts) };
    if rc != 0 {
        return 0;
    }
    (ts.tv_sec as u64).saturating_mul(1_000_000_000).saturating_add(ts.tv_nsec as u64)
}

/// Current monotonic time in ns via `QueryPerformanceCounter` — the Windows analog of
/// the Linux `CLOCK_MONOTONIC` source, the same clock domain the pacer stamps PTS in
/// (so `Engine::snapshot`'s `elapsed_ns` matches the recorded timestamps). i128 math
/// avoids the `counter * 1e9` i64 overflow (~920 s at a 10 MHz QPC frequency). A
/// self-contained sibling of the pacer's `now_mono_ns` (`engine.rs` mod win) — both
/// read the one QPC clock, so the domains never diverge.
#[cfg(windows)]
pub fn now_mono_ns() -> u64 {
    use std::sync::OnceLock;
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
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

// Minimal libc binding for CLOCK_MONOTONIC — the crate has no `libc` dep and the
// capture clock-domain stamp (capture/mod.rs:215) is STEP-6 owned, so this stays
// local + tiny. Matches the glibc `struct timespec` layout (two c_long).
#[cfg(unix)]
#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}
#[cfg(unix)]
fn libc_timespec() -> Timespec {
    Timespec { tv_sec: 0, tv_nsec: 0 }
}
#[cfg(unix)]
const CLOCK_MONOTONIC: i32 = 1;
#[cfg(unix)]
extern "C" {
    fn clock_gettime(clk_id: i32, tp: *mut Timespec) -> i32;
}
