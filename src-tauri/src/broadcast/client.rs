//! Broadcast SP1 SF5 — the sole owner of the mortar-pestle-broadcast engine's
//! control pipe.
//!
//! An async tokio NDJSON client speaking the **frozen** protocol. One
//! [`BroadcastClient`] owns the pipe; callers interact through it via
//! request/response (correlated by `id` through a pending-`oneshot` map) and a
//! broadcast bus for unsolicited engine events. On disconnect it reconnects
//! with a bounded backoff. Malformed pipe lines are logged-and-skipped.
//!
//! # Frozen protocol — hand-mirrored, never shared
//!
//! The structs below mirror `mortar-pestle-broadcast/src/daemon/protocol.rs`
//! **byte-for-byte** (same field names, types, serde attributes). That crate
//! is GPL-2.0; this file is the app-side (non-GPL) mirror — per the license
//! boundary, protocol changes are made twice, once on each side, and no crate
//! crosses the boundary. Broadcast ids are **u64** (unlike stt's string ids).
//!
//! ## Op / event vocabulary
//! SP1 requests: `hello`, `get_state`, `create_scene`, `remove_scene`,
//! `set_current_scene`, `create_source`, `remove_source`,
//! `set_source_settings`, `start_record`, `stop_record`, `shutdown`.
//! SP2 requests: `display_create` {id, hwnd:u64, width, height},
//! `display_resize` {id, width, height}, `display_destroy` {id}
//! (idempotent; display verbs are ephemeral — no autosave, no state push,
//! displays never appear in [`StateSnapshot`]).
//! Events: `state_changed` (data = [`StateSnapshot`]), `saved` ({path}),
//! `error` ([`ProtoError`]).
//!
//! Transport machinery (connection loop, capped line reader, route table) is a
//! faithful clone of `stt::client`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::{broadcast, mpsc, oneshot};

// ===========================================================================
// Frozen protocol structs — mirror of mortar-pestle-broadcast/.../protocol.rs.
// ===========================================================================

/// Client→engine request frame: `{"op": <verb>, "id": <u64>, "args": {...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub op: String,
    pub id: u64,
    #[serde(default)]
    pub args: Value,
}

/// Engine→client response frame, correlated by `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtoError>,
}

/// Unsolicited async event frame: `{"event": <name>, "data": {...}}`.
/// `event ∈ { state_changed, saved, error }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub event: String,
    pub data: Value,
}

/// `error.code ∈ { not_implemented, bad_request, busy, internal }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtoError {
    pub code: String,
    pub message: String,
}

impl ProtoError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

/// The sole UI truth (Overview cross-cutting contract #1) — mirror of the
/// engine's `StateSnapshot`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshot {
    /// Protocol version, bumped on breaking wire changes.
    pub version: u32,
    /// idle | recording | finalizing | error
    pub state: String,
    pub current_scene: Option<String>,
    pub scenes: Vec<SceneInfo>,
    pub recording: RecordingInfo,
    pub obs_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ProtoError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneInfo {
    pub name: String,
    pub sources: Vec<SourceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceInfo {
    pub name: String,
    /// libobs source type id (e.g. "monitor_capture").
    pub id: String,
    /// Live source dimensions — 0×0 until the source delivers its first frame.
    pub width: u32,
    pub height: u32,
    /// Activation diagnostics: `showing` gates capture-source init; `active` =
    /// on program.
    pub showing: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingInfo {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub elapsed_ns: u64,
}

// ===========================================================================
// Async NDJSON client — transport cloned from stt::client.
// ===========================================================================

/// `$XDG_RUNTIME_DIR/mortar-pestle/broadcast.sock` (Linux port slot; unused on
/// Windows v1).
#[cfg(unix)]
pub fn socket_path() -> std::path::PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    runtime.join("mortar-pestle").join("broadcast.sock")
}

/// `\\.\pipe\mortar-pestle-broadcast` — the Windows named-pipe endpoint.
/// Mirrors `mortar-pestle-broadcast/src/daemon/socket.rs::PIPE_NAME` (this
/// name string is the coupling, exactly as with capture/stt).
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\mortar-pestle-broadcast";

/// Open the control pipe, retrying only the transient `ERROR_PIPE_BUSY` (231).
/// Every other error — including `ERROR_FILE_NOT_FOUND` (2, no daemon yet) —
/// propagates to `connection_loop`'s backoff + queued-request drain.
#[cfg(windows)]
async fn connect_pipe() -> std::io::Result<NamedPipeClient> {
    loop {
        match ClientOptions::new().open(PIPE_NAME) {
            Ok(client) => return Ok(client),
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(unix)]
async fn connect_and_split(
) -> std::io::Result<(tokio::net::unix::OwnedReadHalf, tokio::net::unix::OwnedWriteHalf)> {
    let stream = UnixStream::connect(&socket_path()).await?;
    Ok(stream.into_split())
}

#[cfg(windows)]
async fn connect_and_split(
) -> std::io::Result<(tokio::io::ReadHalf<NamedPipeClient>, tokio::io::WriteHalf<NamedPipeClient>)> {
    let stream = connect_pipe().await?;
    Ok(tokio::io::split(stream))
}

/// Reconnect backoff bounds (fixed-step, capped).
const RECONNECT_MIN: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(5);
/// One in-flight request's wait before it gives up. Record stop can take
/// several seconds to finalize the muxer — comfortably above the 5s default.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Event fan-out depth. Lagged receivers drop the gap and keep going.
const EVENT_BUS_CAP: usize = 256;
/// Hard ceiling on a single inbound NDJSON line.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Errors surfaced to callers (stringified at the command boundary).
#[derive(Debug)]
pub enum BroadcastError {
    /// The pipe is not currently connected (engine down / not yet up).
    Disconnected,
    /// A request timed out waiting for its correlated response.
    Timeout,
    /// The engine answered with `ok:false` — carries its [`ProtoError`].
    Engine(ProtoError),
    /// Local (de)serialization or response-shape error.
    Protocol(String),
}

impl std::fmt::Display for BroadcastError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BroadcastError::Disconnected => write!(f, "broadcast engine not connected"),
            BroadcastError::Timeout => write!(f, "broadcast request timed out"),
            BroadcastError::Engine(e) => {
                write!(f, "broadcast engine error [{}]: {}", e.code, e.message)
            }
            BroadcastError::Protocol(m) => write!(f, "broadcast protocol error: {m}"),
        }
    }
}

impl std::error::Error for BroadcastError {}

/// What the read loop hands the writer: a line to send + the oneshot to fulfil
/// when its correlated `Response` arrives.
struct Outgoing {
    line: String,
    id: u64,
    reply: oneshot::Sender<Response>,
}

/// The shared, reconnect-surviving handle. Cheap to clone (everything behind
/// `Arc`). The connection itself is owned by a background task spawned by
/// [`BroadcastClient::connect`]; this handle just enqueues requests and
/// exposes the event bus.
#[derive(Clone)]
pub struct BroadcastClient {
    tx: mpsc::UnboundedSender<Outgoing>,
    events: broadcast::Sender<Event>,
    seq: Arc<AtomicU64>,
}

impl BroadcastClient {
    /// Spawn the connection task and return a handle. The task runs forever:
    /// connect → serve until disconnect → backoff → reconnect. Requests
    /// enqueued while disconnected fail fast with
    /// [`BroadcastError::Disconnected`].
    pub fn connect() -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<Outgoing>();
        let (events, _) = broadcast::channel::<Event>(EVENT_BUS_CAP);
        let client =
            BroadcastClient { tx, events: events.clone(), seq: Arc::new(AtomicU64::new(1)) };

        tauri::async_runtime::spawn(connection_loop(rx, events));
        client
    }

    /// Allocate the next request id. Process-unique, monotonic; never reused.
    fn next_id(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    /// Subscribe to the unsolicited engine event bus (`state_changed`, `saved`,
    /// `error`). Lagged receivers drop the gap.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Send one request and await its correlated response. Returns the
    /// response's `data` on `ok:true`; maps `ok:false` to
    /// [`BroadcastError::Engine`].
    pub async fn request(&self, op: &str, args: Value) -> Result<Option<Value>, BroadcastError> {
        let id = self.next_id();
        let req = Request { op: op.to_string(), id, args };
        let line = serde_json::to_string(&req)
            .map_err(|e| BroadcastError::Protocol(format!("encode request: {e}")))?;

        let (reply_tx, reply_rx) = oneshot::channel::<Response>();
        self.tx
            .send(Outgoing { line, id, reply: reply_tx })
            .map_err(|_| BroadcastError::Disconnected)?;

        let resp = match tokio::time::timeout(REQUEST_TIMEOUT, reply_rx).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(_)) => return Err(BroadcastError::Disconnected),
            Err(_) => return Err(BroadcastError::Timeout),
        };

        if resp.ok {
            Ok(resp.data)
        } else {
            Err(BroadcastError::Engine(resp.error.unwrap_or_else(|| {
                ProtoError::new("internal", "engine returned ok:false with no error body")
            })))
        }
    }

    /// `get_state` → the TYPED engine snapshot (also the adopt-probe call —
    /// `socket_alive` only cares that it answers).
    pub async fn get_state(&self) -> Result<StateSnapshot, BroadcastError> {
        let data = self
            .request("get_state", Value::Null)
            .await?
            .ok_or_else(|| BroadcastError::Protocol("get_state returned no data".into()))?;
        serde_json::from_value(data)
            .map_err(|e| BroadcastError::Protocol(format!("snapshot decode: {e}")))
    }
}

/// The forever-running connection task: connect → serve → backoff → reconnect.
async fn connection_loop(
    mut rx: mpsc::UnboundedReceiver<Outgoing>,
    events: broadcast::Sender<Event>,
) {
    let mut backoff = RECONNECT_MIN;

    loop {
        match connect_and_split().await {
            Ok((read_half, write_half)) => {
                #[cfg(unix)]
                log::info!("broadcast client connected to {}", socket_path().display());
                #[cfg(windows)]
                log::info!("broadcast client connected to {PIPE_NAME}");
                backoff = RECONNECT_MIN;
                match serve_connection(read_half, write_half, &mut rx, &events).await {
                    ServeEnd::CallerGone => {
                        log::debug!("broadcast client: all handles dropped — connection task ending");
                        return;
                    }
                    ServeEnd::SocketClosed => {
                        log::warn!("broadcast client disconnected — will reconnect");
                    }
                }
            }
            Err(e) => {
                log::debug!("broadcast client connect failed: {e}");
                // Fail-fast any request that queued while we were down.
                while let Ok(_dropped) = rx.try_recv() {}
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

/// Why [`serve_connection`] returned.
enum ServeEnd {
    /// The pipe EOF'd / errored / a write failed — reconnect.
    SocketClosed,
    /// Every `BroadcastClient` handle dropped — end the task (no reconnect).
    CallerGone,
}

/// Serve one live connection until it disconnects. A single `select!` loop owns
/// both halves: it pulls the next caller request from `rx` (registering its
/// oneshot + writing the line) and reads inbound lines (routing Responses to
/// their oneshot, Events to the bus).
async fn serve_connection<R, W>(
    read_half: R,
    mut write_half: W,
    rx: &mut mpsc::UnboundedReceiver<Outgoing>,
    events: &broadcast::Sender<Event>,
) -> ServeEnd
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(read_half);
    let mut line_acc: Vec<u8> = Vec::with_capacity(4096);
    let mut pending: HashMap<u64, oneshot::Sender<Response>> = HashMap::new();

    loop {
        tokio::select! {
            maybe = rx.recv() => {
                let Some(out) = maybe else {
                    return ServeEnd::CallerGone;
                };
                if out.reply.is_closed() {
                    continue;
                }
                pending.insert(out.id, out.reply);
                if write_line(&mut write_half, &out.line).await.is_err() {
                    pending.remove(&out.id);
                    return ServeEnd::SocketClosed;
                }
            }
            read = read_capped_line(&mut reader, &mut line_acc) => {
                match read {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            route_line(trimmed, &mut pending, events);
                        }
                    }
                    Ok(None) => return ServeEnd::SocketClosed, // clean EOF
                    Err(e) => {
                        log::warn!("broadcast client read error: {e}");
                        return ServeEnd::SocketClosed;
                    }
                }
            }
        }
    }
}

/// Classify + route one non-empty pipe line. A `Response` (has an `id`) goes to
/// its pending oneshot; an `Event` goes to the bus; anything else is
/// logged-and-skipped. Never panics.
fn route_line(
    line: &str,
    pending: &mut HashMap<u64, oneshot::Sender<Response>>,
    events: &broadcast::Sender<Event>,
) {
    if let Ok(resp) = serde_json::from_str::<Response>(line) {
        match pending.remove(&resp.id) {
            Some(tx) => {
                let _ = tx.send(resp);
            }
            None => {
                log::debug!("broadcast client: unmatched response id {:?}", resp.id);
            }
        }
        return;
    }

    if let Ok(event) = serde_json::from_str::<Event>(line) {
        let _ = events.send(event);
        return;
    }

    log::warn!("broadcast client: skipping malformed pipe line: {line}");
}

/// Read one `\n`-terminated line from `reader` into the persistent `acc`,
/// capped at [`MAX_LINE_BYTES`]. Cancellation-safe (fill_buf/consume; the
/// partial line persists in `acc` across `select!` cancellations).
async fn read_capped_line<R>(reader: &mut R, acc: &mut Vec<u8>) -> std::io::Result<Option<String>>
where
    R: AsyncBufRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(None);
        }
        if let Some(nl) = available.iter().position(|&b| b == b'\n') {
            acc.extend_from_slice(&available[..nl]);
            reader.consume(nl + 1);
            let line = String::from_utf8_lossy(acc.as_slice()).into_owned();
            acc.clear();
            return Ok(Some(line));
        }
        let n = available.len();
        acc.extend_from_slice(available);
        reader.consume(n);
        if acc.len() > MAX_LINE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("inbound line exceeded {MAX_LINE_BYTES} bytes without a newline"),
            ));
        }
    }
}

/// Write one NDJSON line (`line` + `\n`) and flush.
async fn write_line<W>(w: &mut W, line: &str) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await
}
