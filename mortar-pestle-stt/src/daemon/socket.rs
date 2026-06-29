//! The daemon's Unix-socket NDJSON control server (Voice Transcription, SF1).
//!
//! tokio (multi-thread) `UnixListener` at `$XDG_RUNTIME_DIR/mortar-pestle/stt.sock`.
//! One JSON `Request` per line in, one `Response` line out, plus unsolicited wire
//! `Event`s interleaved onto every connected client. Single-instance: bind, or —
//! if the socket is already bound — probe it with `echo`; a live daemon answers
//! `ok:true`, a stale socket gets unlinked + rebound.
//!
//! SF2: `echo`/`hello`/`ping` round-trip the request args straight back; `get_state`
//! answers a minimal snapshot; `load_model`/`transcribe_file`/`cancel`/`unload` forward
//! to the resident whisper worker (`crate::whisper`) and ack, with results streamed
//! back as async wire events. This layer never blocks on inference itself.
#![allow(dead_code)]

use std::io;
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::daemon::engine::{ControlContext, EngineCmd};
use crate::daemon::dictation::{self, DictationSource};
use crate::protocol::{
    DeleteModelArgs, DownloadModelArgs, LoadModelArgs, ProtoError, Request, Response,
    StartDictationArgs, TranscribeFileArgs,
};

/// Monotonic per-connection id, assigned in [`handle_client`]. Records which connection
/// owns the live dictation session, so a socket disconnect releases ONLY that session's
/// mic ([`dictation::release_owned`]).
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// `$XDG_RUNTIME_DIR/mortar-pestle/stt.sock` (falls back to `/tmp` if the env var is
/// unset, matching tokio conventions for a session-scoped socket). The
/// `mortar-pestle` parent dir is SHARED across sidecars; only the filename differs
/// from the capture daemon's `capture.sock`.
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime.join("mortar-pestle").join("stt.sock")
}

/// `\\.\pipe\mortar-pestle-stt` — the Windows named-pipe analogue of the Unix socket
/// path. The kernel owns the `\\.\pipe\` namespace, so there is no parent dir to
/// create and no stale endpoint to unlink (a pipe instance is a kernel object that
/// vanishes when its owning process exits). Mirrors the host
/// `src-tauri/src/stt/client.rs::PIPE_NAME` (the two crates are decoupled by design —
/// this name string is the coupling, exactly as the socket path is on Unix).
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\mortar-pestle-stt";

/// Bind the control socket, single-instance. Returns the bound listener, or `None`
/// when a live daemon already owns the socket — in which case the caller should
/// exit cleanly (already handled inside `serve`).
///
/// Order: ensure parent dir (0700) → try bind. On `AddrInUse`, probe the existing
/// socket with `echo`; an `ok:true` reply ⇒ live daemon (return `None`); any
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
                log::info!("mortar-pestle-stt daemon already running at {}", path.display());
                Ok(None)
            } else {
                log::warn!("stale stt socket at {} — unlinking + rebinding", path.display());
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

/// Connect to an existing socket and send `echo`; `true` iff a live daemon
/// answers with `ok:true`. Any connect, write, read, or parse failure (and a
/// short timeout) ⇒ `false` ⇒ treat as stale.
///
/// NOTE: unlike the capture daemon (which checks for a `data.state` field), the
/// SF1 echo daemon has NO snapshot — `ok:true` alone is the liveness predicate.
#[cfg(unix)]
async fn probe_live_daemon(path: &PathBuf) -> bool {
    let probe = async {
        let mut stream = UnixStream::connect(path).await.ok()?;
        let hello = serde_json::to_string(&Request {
            op: "echo".into(),
            id: "probe".into(),
            args: json!({ "text": "probe" }),
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
        // A live SF1 echo daemon answers ok:true (no snapshot/state field exists).
        if resp.ok {
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
            println!("mortar-pestle-stt: daemon already running ({})", path.display());
            std::process::exit(0);
        }
    };
    log::info!("stt control socket listening at {}", path.display());

    // Accept clients until the `shutdown` op wakes this signal — then `serve`
    // returns so `daemon::run` can exit the process cleanly.
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

/// Windows control server over a named pipe — the `\\.\pipe\mortar-pestle-stt` analogue of
/// the Unix `serve`. Single-instance is structural: `first_pipe_instance(true)` makes
/// a second daemon's `create()` fail with `ERROR_ACCESS_DENIED` (raw OS 5), which IS
/// the "already running" signal — no `AddrInUse` probe, no stale-file unlink (a pipe
/// instance is a kernel object reclaimed when its process exits).
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
            println!("mortar-pestle-stt: daemon already running ({PIPE_NAME})");
            std::process::exit(0);
        }
        Err(e) => return Err(e),
    };
    log::info!("stt control pipe listening at {PIPE_NAME}");

    // Accept clients until the `shutdown` op wakes this signal — then `serve`
    // returns so `daemon::run` can exit the process cleanly.
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
/// Unix uses `UnixStream::into_split` (independent owned halves); Windows splits the
/// `NamedPipeServer` via `tokio::io::split` (named pipes have no `into_split`). Both
/// yield `Send + 'static` halves so the writer half can move into its task.
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
    // Per-connection id — records which connection owns the dictation session so a
    // disconnect releases ONLY that session's mic (`dictation::release_owned`).
    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);

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
                // Unsolicited engine events, broadcast to every client. (SF1
                // never sends any, but the subscription must exist to compile.)
                ev = events.recv() => {
                    match ev {
                        Ok(event) => {
                            if let Ok(line) = serde_json::to_string(&event) {
                                if write_line(&mut write_half, &line).await.is_err() {
                                    break;
                                }
                            }
                        }
                        // Lagged: drop the gap, keep streaming.
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
            Ok(req) => dispatch(&ctx, conn_id, req),
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

    // Reader done (client disconnected). Release the mic IFF this connection owns the
    // dictation session, so a client that drops without `stop_dictation` never leaks the
    // input stream (a transient probe / other client can't tear down a session it didn't
    // start). The consumer still emits its terminal `final` as the channel closes.
    dictation::release_owned(&ctx, conn_id);

    // Drop the response sender so the writer task finishes.
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

/// Map a parsed `Request` to a `Response`. Mutating verbs forward an `EngineCmd` to the
/// whisper worker and ACK immediately; the real result arrives later as an async wire
/// event (`model_loaded` / `segment` / `final` / `progress` / `error`) on the same
/// connection.
///
/// - `echo` / `hello` / `ping` → echo the request `args` straight back as `data`
///   (also the sidecar's own single-instance bind-probe verb).
/// - `get_state` → ok + a minimal `{ "state": "idle" }` snapshot. The host supervisor's
///   adopt-probe (`socket_alive`) calls `get_state`; a live daemon MUST answer ok:true
///   with a `data` body so it is adopted, not crash-looped.
/// - `load_model {name}` / `transcribe_file {path}` / `unload` → forward to the worker,
///   then ack. `cancel` → raise the shared cancel flag, then ack.
/// - `shutdown` → tell the worker to exit, ack, then wake the accept loop.
/// - anything else → `bad_request`.
fn dispatch(ctx: &ControlContext, conn_id: u64, req: Request) -> Response {
    match req.op.as_str() {
        "echo" | "hello" | "ping" => Response {
            id: req.id,
            ok: true,
            data: Some(req.args),
            error: None,
        },

        // Liveness / status probe. SF2 keeps the minimal snapshot (the host adopt-check
        // only needs a `data` body); model/transcription status enrichment is SF4's.
        "get_state" => {
            // Enriched with the live hotkeys snapshot (Phase 5 SF5) so the host reads
            // the bound trigger on mount; `hotkeys` events push later changes.
            let hotkeys = serde_json::to_value(ctx.hotkeys_snapshot()).unwrap_or(Value::Null);
            Response {
                id: req.id,
                ok: true,
                data: Some(json!({ "state": "idle", "hotkeys": hotkeys })),
                error: None,
            }
        }

        "load_model" => match serde_json::from_value::<LoadModelArgs>(req.args.clone()) {
            Ok(args) => {
                // Track the last model so hotkey-driven dictation reuses it (SF5).
                ctx.set_last_model(&args.name);
                forward(ctx, req.id, EngineCmd::LoadModel { name: args.name, use_gpu: args.use_gpu })
            }
            Err(e) => err_response(
                req.id,
                ProtoError::new("bad_request", format!("invalid load_model args: {e}")),
            ),
        },

        "transcribe_file" => match serde_json::from_value::<TranscribeFileArgs>(req.args.clone()) {
            Ok(args) => forward(ctx, req.id, EngineCmd::TranscribeFile { path: args.path }),
            Err(e) => err_response(
                req.id,
                ProtoError::new("bad_request", format!("invalid transcribe_file args: {e}")),
            ),
        },

        // Phase 5 model management. `list_models` + `delete_model` are SYNC (answer in
        // `Response.data`); `download_model` is STREAMING — forwarded to the worker, which
        // streams `progress` then a terminal `download_complete`. Download ≠ activate, so a
        // download never swaps the resident model (that stays a `load_model`/`Use now`).
        "list_models" => {
            let models =
                serde_json::to_value(crate::models::list_cached_models()).unwrap_or(Value::Null);
            Response { id: req.id, ok: true, data: Some(json!({ "models": models })), error: None }
        }

        "delete_model" => match serde_json::from_value::<DeleteModelArgs>(req.args.clone()) {
            Ok(args) => match crate::models::delete_cached_model(&args.name) {
                Ok(()) => Response {
                    id: req.id,
                    ok: true,
                    data: Some(json!({ "deleted": true })),
                    error: None,
                },
                Err(crate::models::ModelError::UnknownModel(n)) => err_response(
                    req.id,
                    ProtoError::new("bad_request", format!("unknown model `{n}` (not in the registry)")),
                ),
                Err(crate::models::ModelError::Download(msg)) => {
                    err_response(req.id, ProtoError::new("internal", msg))
                }
            },
            Err(e) => err_response(
                req.id,
                ProtoError::new("bad_request", format!("invalid delete_model args: {e}")),
            ),
        },

        "download_model" => match serde_json::from_value::<DownloadModelArgs>(req.args.clone()) {
            Ok(args) => forward(ctx, req.id, EngineCmd::DownloadModel { name: args.name }),
            Err(e) => err_response(
                req.id,
                ProtoError::new("bad_request", format!("invalid download_model args: {e}")),
            ),
        },

        // Phase 2 mic dictation. NON-BLOCKING + open-ended, so it does NOT ride
        // `EngineCmd`/the whisper worker — `dictation::start` opens the mic on its own
        // thread, loads the speech model, streams `vu` + transcribed VAD `segment`s, and
        // returns at once (SF3). Parse-and-validate the args, forwarding `model` (the
        // speech model) + `vad_threshold`/`hangover_ms`, plus `conn_id` (so a disconnect
        // releases this session's mic), then ack. A mic-open failure is reported as an
        // `error` EVENT (the handler still returns Ok), so it acks here; only `busy`
        // (already dictating) error-responds.
        "start_dictation" => match serde_json::from_value::<StartDictationArgs>(req.args.clone()) {
            Ok(args) => {
                // Track the last model (hotkey dictation reuses it, SF5); UI-driven →
                // DictationSource::Client (its per-call Channel owns the `final`).
                ctx.set_last_model(&args.model);
                match dictation::start(ctx, conn_id, args.model, args.vad_threshold, args.hangover_ms, args.use_gpu, DictationSource::Client) {
                    Ok(()) => ack(req.id),
                    Err(e) => err_response(req.id, e),
                }
            }
            Err(e) => err_response(
                req.id,
                ProtoError::new("bad_request", format!("invalid start_dictation args: {e}")),
            ),
        },

        // Stop the live mic; the consumer thread drains, transcribes the trailing
        // segment, and emits a terminal `final {text}` (SF3). Idempotent — a stop with
        // nothing running still acks. No args.
        "stop_dictation" => {
            dictation::stop(ctx);
            ack(req.id)
        }

        // Cancel raises the worker's finish-then-discard flag (the worker is busy inside
        // `whisper_full`, not at `recv()`; NO abort callback — that would wedge GGML
        // globally) AND, if a dictation session is live, releases the mic (box 4 resource
        // hygiene: `stop` closes the capture channel so the consumer finalizes + emits its
        // terminal `final`). Then ack. Idempotent: a no-op when fully idle.
        "cancel" => {
            ctx.signal_cancel();
            dictation::stop(ctx);
            ack(req.id)
        }

        "unload" => forward(ctx, req.id, EngineCmd::Unload),

        // Phase 5 SF5: ask the hotkeys portal task to open KDE's ConfigureShortcuts
        // (portal v2+). Echoes the CURRENT snapshot; the post-rebind triggers arrive
        // later as a `hotkeys` event (ShortcutsChanged). Errs only if the task is gone.
        "rebind_hotkeys" => match ctx.rebind() {
            Ok(()) => {
                let hotkeys = serde_json::to_value(ctx.hotkeys_snapshot()).unwrap_or(Value::Null);
                Response { id: req.id, ok: true, data: Some(json!({ "hotkeys": hotkeys })), error: None }
            }
            Err(e) => err_response(req.id, ProtoError::new("internal", e)),
        },

        "shutdown" => {
            // Tell the worker to drop its model + exit, then wake `serve`'s accept loop
            // so the process exits (and `daemon::run` joins the worker).
            let _ = ctx.send_cmd(EngineCmd::Shutdown);
            let resp = Response { id: req.id.clone(), ok: true, data: None, error: None };
            ctx.signal_shutdown();
            resp
        }

        other => err_response(
            req.id,
            ProtoError::new("bad_request", format!("unknown op `{other}`")),
        ),
    }
}

/// Forward a command to the whisper worker, then ack. The real result arrives later as
/// an async event; the ack only confirms the verb was queued. A send failure ⇒ the
/// worker thread is gone ⇒ `internal`.
fn forward(ctx: &ControlContext, id: String, cmd: EngineCmd) -> Response {
    match ctx.send_cmd(cmd) {
        Ok(()) => ack(id),
        Err(e) => err_response(id, ProtoError::new("internal", e)),
    }
}

/// A bare success ack (`ok:true` + `{ "accepted": true }`) for a queued async verb.
fn ack(id: String) -> Response {
    Response { id, ok: true, data: Some(json!({ "accepted": true })), error: None }
}

fn err_response(id: String, error: ProtoError) -> Response {
    Response { id, ok: false, data: None, error: Some(error) }
}

