//! 5-SF2e — the sole owner of the capture engine's control transport (a Unix socket
//! on Linux; the `\\.\pipe\mortar-pestle-capture` named pipe on Windows, SF4).
//!
//! An async tokio NDJSON client speaking the **frozen** protocol (see below).
//! One [`CaptureClient`] owns the socket; callers interact through it via
//! request/response (correlated by `id` through a pending-`oneshot` map) and a
//! broadcast bus for unsolicited engine events. On disconnect it reconnects with
//! a bounded backoff (mirroring the `dev_service` poll idiom — never a tight
//! loop). Malformed socket lines are logged-and-skipped: no `panic`, no
//! `unwrap`/`expect` on any socket-derived bytes.
//!
//! # Frozen protocol — byte-identical mirror
//!
//! The structs below mirror `mortar-pestle-capture/src/daemon/protocol.rs`
//! **byte-for-byte** (same field names, same types, same serde attributes, same
//! snake_case-vs-camelCase boundary). The two crates are decoupled by design
//! (no shared dependency); `tests/capture_roundtrip.rs` is the cross-crate
//! round-trip gate that holds them in sync (plan §10 Risk #1). **Do not edit
//! these to "fix" a mismatch — fix the side that drifted and re-run the gate.**
//!
//! snake_case (NO `rename_all`): [`Request`], [`Response`], [`Event`],
//! [`ProtoError`], [`StateSnapshot`] (top level), [`HotkeysSnapshot`],
//! [`Shortcut`], [`Capabilities`], [`SavedClip`].
//! camelCase (`rename_all = "camelCase"`): [`CaptureConfig`] and [`AudioConfig`]
//! ONLY — nested under `StateSnapshot.config`, so within an otherwise-snake_case
//! snapshot the `config` object's keys flip to camelCase.

use std::collections::HashMap;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::{broadcast, mpsc, oneshot};

// ===========================================================================
// Frozen protocol structs — byte-identical mirror of daemon/protocol.rs.
// ===========================================================================

/// Client→engine request frame: `{"op": <verb>, "id": <string>, "args": {...}}`.
/// `op ∈ {hello, get_state, start_clip, stop_clip, set_config, rebind_hotkeys,
/// shutdown, screenshot, save_replay, arm, disarm}` (last four reserved →
/// `error.code:"not_implemented"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub op: String,
    pub id: String,
    #[serde(default)]
    pub args: Value,
}

/// Engine→client response frame, correlated by `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: String,
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

/// The authoritative state snapshot — the sole source of UI truth. Returned by
/// `hello`/`get_state`/all mutations and carried by the `state_changed` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshot {
    pub version: u32,
    pub recording: bool,
    /// `idle|starting|recording|finalizing|error`.
    pub state: String,
    pub game: Option<String>,
    pub started_at_unix_ms: u64,
    pub elapsed_ns: u64,
    pub codec: String,
    pub bitrate_bps: u64,
    pub gop_len: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub hotkeys: HotkeysSnapshot,
    pub config: CaptureConfig,
    pub last_error: Option<ProtoError>,
    pub capabilities: Capabilities,
    /// True while the replay ring is armed (Phase 2). `#[serde(default)]` tolerates
    /// an older engine that doesn't emit it.
    #[serde(default)]
    pub armed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeysSnapshot {
    pub bound: bool,
    pub portal_version: u32,
    pub can_configure: bool,
    pub shortcuts: Vec<Shortcut>,
    pub last_error: Option<String>,
}

/// `id ∈ { record, save_replay, screenshot }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shortcut {
    pub id: String,
    pub description: String,
    pub trigger_description: String,
    pub reserved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub screenshot: bool,
    pub save_replay: bool,
    pub arm: bool,
}

/// Engine-relevant settings. **camelCase on the wire** (the JS side authors the
/// file). Nested under `StateSnapshot.config` + carried by `set_config`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConfig {
    pub schema: u32,
    pub replay_length_min: u32,
    pub codec: String,
    pub bitrate_mbps: u32,
    pub rate_control: String,
    pub keyint_sec: u32,
    pub container: String,
    pub audio: AudioConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfig {
    pub track: String,
    pub sample_rate: u32,
    pub channels: u32,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            schema: 1,
            replay_length_min: 5,
            codec: "h264".into(),
            bitrate_mbps: 50,
            rate_control: "cbr".into(),
            keyint_sec: 2,
            container: "mp4".into(),
            audio: AudioConfig { track: "system".into(), sample_rate: 48_000, channels: 2 },
        }
    }
}

/// The `saved` event payload (unified contract). `path` is ALWAYS the final
/// `.mp4` once Step 5 lands; the SF1a-interim payload carries a `.h264` `path`,
/// `0×0` dims, and a null `poster` — callers MUST tolerate that without treating
/// it as a regression (plan Step 3 note).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedClip {
    pub path: String,
    pub game: String,
    pub duration_s: f64,
    pub started_monotonic_pts_ns: u64,
    pub last_monotonic_pts_ns: u64,
    pub poster: Option<String>,
    pub width: u32,
    pub height: u32,
    pub codec: String,
}

// ===========================================================================
// Async NDJSON client.
// ===========================================================================

/// `$XDG_RUNTIME_DIR/mortar-pestle/capture.sock` (falls back to `/tmp` when the env
/// var is unset). Mirrors `mortar-pestle-capture/src/daemon/socket.rs::socket_path`.
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime.join("mortar-pestle").join("capture.sock")
}

/// `\\.\pipe\mortar-pestle-capture` — the Windows named-pipe endpoint (SF4), mirroring the
/// daemon's `mortar-pestle-capture/src/daemon/socket.rs::PIPE_NAME`. This name string is
/// the cross-crate coupling, exactly as the socket path is on Unix.
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\mortar-pestle-capture";

/// Connect to the daemon's named pipe, retrying only on `ERROR_PIPE_BUSY` (231) — all
/// server instances momentarily occupied. Any other error (incl. `ERROR_FILE_NOT_FOUND`
/// when the daemon is down) propagates to the backoff loop.
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

/// Connect to the control endpoint + split into owned read/write halves. Unix uses
/// `UnixStream::into_split`; Windows opens the named pipe + `tokio::io::split` (named
/// pipes have no `into_split`). Both yield `Send + 'static` halves.
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

/// A human label for the control endpoint (logging only).
#[cfg(unix)]
fn endpoint_label() -> String {
    socket_path().display().to_string()
}

#[cfg(windows)]
fn endpoint_label() -> String {
    PIPE_NAME.to_string()
}

/// Reconnect backoff bounds (fixed-step, capped — mirrors the `dev_service`
/// poll-until-ready idiom, NOT exponential, NOT a tight loop).
const RECONNECT_MIN: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(5);
/// One in-flight request's wait before it gives up (the engine answers every op
/// synchronously, so this only fires if the socket died mid-request).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Event fan-out depth. Lagged receivers drop the gap and keep going (the
/// snapshot is always re-fetchable, so a dropped event is never fatal).
const EVENT_BUS_CAP: usize = 256;
/// Hard ceiling on a single inbound NDJSON line. The engine emits compact
/// single-line JSON (a full `StateSnapshot` is well under 4 KiB), so 1 MiB is a
/// generous bound that still stops a wedged or hostile peer that never sends a
/// newline from growing the read buffer without limit — over it the read errors
/// and the connection resets (then reconnects) like any other socket close.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Errors surfaced to callers. The crate has no `anyhow`/`thiserror`; this is a
/// tiny local enum stringified at the boundary (matches `VaultError` house style).
#[derive(Debug)]
pub enum CaptureError {
    /// The socket is not currently connected (engine down / not yet up).
    Disconnected,
    /// A request timed out waiting for its correlated response.
    Timeout,
    /// The engine answered with `ok:false` — carries its [`ProtoError`].
    Engine(ProtoError),
    /// Local (de)serialization or response-shape error.
    Protocol(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Disconnected => write!(f, "capture engine not connected"),
            CaptureError::Timeout => write!(f, "capture request timed out"),
            CaptureError::Engine(e) => write!(f, "capture engine error [{}]: {}", e.code, e.message),
            CaptureError::Protocol(m) => write!(f, "capture protocol error: {m}"),
        }
    }
}

impl std::error::Error for CaptureError {}

/// What the read loop hands the writer: a line to send + the oneshot to fulfil
/// when its correlated `Response` arrives.
struct Outgoing {
    line: String,
    id: String,
    reply: oneshot::Sender<Response>,
}

/// The shared, reconnect-surviving handle. Cheap to clone (everything behind
/// `Arc`). The connection itself is owned by a background task spawned by
/// [`CaptureClient::connect`]; this handle just enqueues requests and exposes
/// the event bus. Outlives any single socket connection.
#[derive(Clone)]
pub struct CaptureClient {
    tx: mpsc::UnboundedSender<Outgoing>,
    events: broadcast::Sender<Event>,
    seq: Arc<AtomicU64>,
}

impl CaptureClient {
    /// Spawn the connection task and return a handle. The task runs forever:
    /// connect → serve until disconnect → backoff → reconnect. Spawned on the
    /// Tauri async runtime so it shares the app's reactor.
    ///
    /// Requests enqueued while disconnected fail fast with
    /// [`CaptureError::Disconnected`] (the writer side of the channel is dropped
    /// between connections), so callers never block on a dead engine.
    pub fn connect() -> Self {
        // ONE stable caller→loop channel for the whole client lifetime. Callers
        // always enqueue onto `tx`; the connection loop owns `rx` and hands each
        // request to the currently-live connection, or fails it fast (drops the
        // reply oneshot ⇒ caller sees Disconnected) while there is no connection.
        let (tx, rx) = mpsc::unbounded_channel::<Outgoing>();
        let (events, _) = broadcast::channel::<Event>(EVENT_BUS_CAP);
        let client = CaptureClient { tx, events: events.clone(), seq: Arc::new(AtomicU64::new(1)) };

        tauri::async_runtime::spawn(connection_loop(rx, events));
        client
    }

    /// Allocate the next request id. Process-unique, monotonic; never reused, so
    /// a dropped caller's id can't collide with a live one.
    fn next_id(&self) -> String {
        self.seq.fetch_add(1, Ordering::Relaxed).to_string()
    }

    /// Subscribe to the unsolicited engine event bus (`state_changed`, `saved`,
    /// `error`). Lagged receivers drop the gap (snapshot is always re-fetchable).
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Send one request and await its correlated response. Returns the response's
    /// `data` on `ok:true`; maps `ok:false` to [`CaptureError::Engine`]. A
    /// dropped caller drops its `oneshot` receiver — the read loop notices the
    /// closed channel and evicts the pending entry, so **no id leaks**.
    pub async fn request(&self, op: &str, args: Value) -> Result<Option<Value>, CaptureError> {
        let id = self.next_id();
        let req = Request { op: op.to_string(), id: id.clone(), args };
        let line = serde_json::to_string(&req)
            .map_err(|e| CaptureError::Protocol(format!("encode request: {e}")))?;

        let (reply_tx, reply_rx) = oneshot::channel::<Response>();
        // Enqueue onto the current connection. A send error ⇒ no live connection.
        self.tx
            .send(Outgoing { line, id, reply: reply_tx })
            .map_err(|_| CaptureError::Disconnected)?;

        // Await the correlated response, bounded. The read loop fulfils `reply_tx`;
        // a dropped `reply_rx` (timeout/caller-drop) signals the loop to evict.
        let resp = match tokio::time::timeout(REQUEST_TIMEOUT, reply_rx).await {
            Ok(Ok(resp)) => resp,
            // Sender dropped without replying ⇒ the connection died mid-flight.
            Ok(Err(_)) => return Err(CaptureError::Disconnected),
            Err(_) => return Err(CaptureError::Timeout),
        };

        if resp.ok {
            Ok(resp.data)
        } else {
            Err(CaptureError::Engine(resp.error.unwrap_or_else(|| {
                ProtoError::new("internal", "engine returned ok:false with no error body")
            })))
        }
    }

    /// `get_state` → the authoritative [`StateSnapshot`]. The primary read path
    /// and the Step-2 smoke probe's call.
    pub async fn get_state(&self) -> Result<StateSnapshot, CaptureError> {
        let data = self
            .request("get_state", Value::Null)
            .await?
            .ok_or_else(|| CaptureError::Protocol("get_state returned no data".into()))?;
        serde_json::from_value(data)
            .map_err(|e| CaptureError::Protocol(format!("decode StateSnapshot: {e}")))
    }
}

/// The forever-running connection task: connect → serve → backoff → reconnect.
/// Owns the single caller→loop `rx` for the whole client lifetime, lending it to
/// each [`serve_connection`] by mutable reference (ownership returns when the
/// connection ends, ready for the next one).
async fn connection_loop(
    mut rx: mpsc::UnboundedReceiver<Outgoing>,
    events: broadcast::Sender<Event>,
) {
    let mut backoff = RECONNECT_MIN;

    loop {
        match connect_and_split().await {
            Ok((read_half, write_half)) => {
                log::info!("capture client connected to {}", endpoint_label());
                backoff = RECONNECT_MIN; // reset on a successful connect
                match serve_connection(read_half, write_half, &mut rx, &events).await {
                    // All `CaptureClient` handles dropped — the client is being
                    // torn down. Exit the task (no zombie reconnect loop).
                    ServeEnd::CallerGone => {
                        log::debug!("capture client: all handles dropped — connection task ending");
                        return;
                    }
                    // The socket died under us — reconnect after backoff.
                    ServeEnd::SocketClosed => {
                        log::warn!("capture client disconnected — will reconnect");
                    }
                }
            }
            Err(e) => {
                // Engine not up yet (common at boot) — debug, not warn, to avoid
                // log spam while the supervisor (Step 4) is still bringing it up.
                log::debug!("capture client connect failed ({}): {e}", endpoint_label());
                // Fail-fast any request that queued while we were down: drain
                // without blocking; dropping each `Outgoing.reply` unblocks the
                // caller with Disconnected (the timeout never has to fire).
                while let Ok(_dropped) = rx.try_recv() {}
            }
        }

        // Fixed-step backoff, capped (dev_service idiom — never a tight loop).
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

/// Why [`serve_connection`] returned — drives the [`connection_loop`]'s
/// reconnect-vs-terminate decision.
enum ServeEnd {
    /// The socket EOF'd / errored / a write failed — reconnect.
    SocketClosed,
    /// Every `CaptureClient` handle dropped (the caller channel closed) — the
    /// client is being torn down; the connection task should end (no reconnect).
    CallerGone,
}

/// Serve one live connection until it disconnects. A single `select!` loop owns
/// both halves: it pulls the next caller request from `rx` (registering its
/// oneshot + writing the line) and reads inbound lines (routing Responses to
/// their oneshot, Events to the bus). Returns [`ServeEnd`] describing why. `rx`
/// is borrowed, not moved, so the caller→loop channel survives across reconnects.
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
    // Manual newline framing (capped) instead of `BufReader::lines()`: the line
    // accumulator is bounded by MAX_LINE_BYTES, so a peer that never sends `\n`
    // can't grow it without limit. `reader` + `line_acc` persist across select!
    // iterations, so a cancelled read (the other branch won) loses nothing —
    // unconsumed bytes stay in the BufReader and the partial line in line_acc.
    let mut reader = BufReader::new(read_half);
    let mut line_acc: Vec<u8> = Vec::with_capacity(4096);
    // id → the caller's oneshot, awaiting that id's Response. Dropped on return,
    // which closes every still-waiting oneshot ⇒ in-flight callers unblock with
    // Disconnected.
    let mut pending: HashMap<String, oneshot::Sender<Response>> = HashMap::new();

    loop {
        tokio::select! {
            // A caller request: register its oneshot, write the line.
            maybe = rx.recv() => {
                let Some(out) = maybe else {
                    // All callers (and the CaptureClient handle) dropped.
                    return ServeEnd::CallerGone;
                };
                // Caller already dropped its receiver (timed out): skip entirely —
                // no id registered, no wasted socket traffic, no id leak.
                if out.reply.is_closed() {
                    continue;
                }
                pending.insert(out.id.clone(), out.reply);
                if write_line(&mut write_half, &out.line).await.is_err() {
                    // Write failed ⇒ connection gone. Drop the just-registered
                    // entry (caller unblocks with Disconnected) and reconnect.
                    pending.remove(&out.id);
                    return ServeEnd::SocketClosed;
                }
            }
            // An inbound line: Response → its oneshot; Event → the bus; malformed
            // → logged-and-skipped (NO panic, NO unwrap on socket bytes).
            read = read_capped_line(&mut reader, &mut line_acc) => {
                match read {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            route_line(trimmed, &mut pending, events);
                        }
                    }
                    Ok(None) => return ServeEnd::SocketClosed, // clean EOF
                    // Read error OR an over-cap line (MAX_LINE_BYTES): log and
                    // reset the connection — reconnect with backoff, partial dropped.
                    Err(e) => {
                        log::warn!("capture client read error: {e}");
                        return ServeEnd::SocketClosed;
                    }
                }
            }
        }
    }
}

/// Classify + route one non-empty socket line. A `Response` (has an `id`) goes to
/// its pending oneshot; an `Event` (has `event` + `data`) goes to the bus;
/// anything else is logged-and-skipped. Never panics.
fn route_line(
    line: &str,
    pending: &mut HashMap<String, oneshot::Sender<Response>>,
    events: &broadcast::Sender<Event>,
) {
    // Try Response first (the common case; correlated by `id`).
    if let Ok(resp) = serde_json::from_str::<Response>(line) {
        match pending.remove(&resp.id) {
            Some(tx) => {
                // Caller may have dropped the receiver (timeout) — ignore the send
                // error; the entry is already removed, so no id leaks.
                let _ = tx.send(resp);
            }
            None => {
                // A response with no waiter: caller timed out / dropped, or the
                // engine echoed an id we never sent. Benign; log at debug.
                log::debug!("capture client: unmatched response id {:?}", resp.id);
            }
        }
        return;
    }

    // Otherwise an unsolicited Event.
    if let Ok(event) = serde_json::from_str::<Event>(line) {
        // No subscribers is fine (send returns Err) — don't treat it as an error.
        let _ = events.send(event);
        return;
    }

    // Neither shape parsed: malformed line. Log-and-skip, keep the connection.
    log::warn!("capture client: skipping malformed socket line: {line}");
}

/// Read one `\n`-terminated line from `reader` into the persistent `acc`, capped
/// at [`MAX_LINE_BYTES`]. Returns the line (newline stripped), `Ok(None)` on EOF,
/// or an `InvalidData` error if one line exceeds the cap (the caller then resets
/// the connection). Cancellation-safe: `fill_buf`/`consume` leave unconsumed
/// bytes in the `BufReader` and `acc` persists across calls, so a `select!`
/// cancellation never drops committed data.
async fn read_capped_line<R>(reader: &mut R, acc: &mut Vec<u8>) -> std::io::Result<Option<String>>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            // EOF: a trailing newline-less partial is dropped (the engine always
            // newline-terminates, so treat this as a clean close).
            return Ok(None);
        }
        if let Some(nl) = available.iter().position(|&b| b == b'\n') {
            acc.extend_from_slice(&available[..nl]);
            reader.consume(nl + 1); // consume through the newline
            let line = String::from_utf8_lossy(acc.as_slice()).into_owned();
            acc.clear();
            return Ok(Some(line));
        }
        // No newline in this chunk: take it all, then enforce the cap.
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

/// Write one NDJSON line (`line` + `\n`) and flush. Mirrors the engine's
/// `socket.rs::write_line`.
async fn write_line<W>(w: &mut W, line: &str) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await
}
