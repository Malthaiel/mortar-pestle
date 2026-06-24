//! STT SF1 — the sole owner of the iskariel-stt engine's Unix control socket.
//!
//! An async tokio NDJSON client speaking the **frozen** protocol (see below).
//! One [`SttClient`] owns the socket; callers interact through it via
//! request/response (correlated by `id` through a pending-`oneshot` map) and a
//! broadcast bus for unsolicited engine events. On disconnect it reconnects with
//! a bounded backoff (never a tight loop). Malformed socket lines are
//! logged-and-skipped: no `panic`, no `unwrap`/`expect` on any socket-derived
//! bytes.
//!
//! # Frozen protocol — byte-identical mirror
//!
//! The structs below mirror `iskariel-stt/src/daemon/protocol.rs`
//! **byte-for-byte** (same field names, same types, same serde attributes, same
//! snake_case-vs-camelCase boundary). The two crates are decoupled by design (no
//! shared dependency); `tests/stt_roundtrip.rs` is the cross-crate round-trip
//! gate that holds them in sync. **Do not edit these to "fix" a mismatch — fix
//! the side that drifted and re-run the gate.**
//!
//! ## Envelope — copied verbatim from `capture::client`
//! [`Request`] / [`Response`] / [`Event`] / [`ProtoError`] are the
//! engine-agnostic NDJSON envelope, byte-identical to the capture protocol. STT
//! reuses the frame shape unchanged; only the `op` verb set and `event` name set
//! differ (engine vocabulary, carried in `args` / `data` as JSON).
//!
//! ## SF1 op / event vocabulary
//! Requests (app→sidecar): `echo`, `load_model`, `transcribe_file`, `cancel`,
//! `unload`, `start_dictation`, `stop_dictation`. `echo` (handshake) +
//! `start_dictation`/`stop_dictation` (the Phase 2 SF1 mic loop) are FUNCTIONAL;
//! the model/file verbs answer `error.code:"not_implemented"` until SF2/SF3.
//! Events (sidecar→app): `echo`, `model_loaded`, `segment`, `final`, `progress`,
//! `vu`, `error` — the typed payloads below.

use std::collections::HashMap;
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
// Frozen protocol structs — byte-identical mirror of iskariel-stt/.../protocol.rs.
// ===========================================================================
//
// Envelope (snake_case, NO `rename_all`) — identical to capture's envelope.

/// Client→engine request frame: `{"op": <verb>, "id": <string>, "args": {...}}`.
/// `op ∈ {echo, load_model, transcribe_file, cancel, unload}` (only `echo` is
/// functional in SF1; the rest answer `error.code:"not_implemented"`).
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
/// `event ∈ { echo, model_loaded, segment, final, progress, vu, error }`.
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

// ---------------------------------------------------------------------------
// STT payload structs (snake_case, NO `rename_all`). These are the typed
// bodies carried in `Request.args` / `Event.data` / `Response.data`. They
// mirror iskariel-stt's protocol module exactly; the drift gate pins them.
// ---------------------------------------------------------------------------

/// `echo` payload — both the request `args` and the `echo` event `data`. The SF1
/// handshake: the daemon echoes `text` straight back unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EchoPayload {
    pub text: String,
}

/// `load_model` request `args`. `use_gpu` (Phase 5 Force-CPU): absent/None = auto
/// (GPU-first, CPU fallback), Some(false) = force CPU, Some(true) = force GPU.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadModelArgs {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_gpu: Option<bool>,
}

/// `model_loaded` event `data` (emitted once SF2 implements `load_model`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLoaded {
    pub name: String,
    pub sha: String,
    pub backend: String,
}

/// `transcribe_file` request `args` (STUB in SF1 → `not_implemented`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeFileArgs {
    pub path: String,
}

/// `start_dictation` request `args` — byte-identical mirror of the engine struct.
/// `model` / `vad_threshold` / `hangover_ms` are parsed but UNUSED in Phase 2 SF1
/// (forward-compat for SF2 VAD + SF3 transcription); SF1 just opens the mic and
/// streams `vu`. The two `Option` fields use `skip_serializing_if` (engine mirror),
/// so an omitted optional is absent on the wire, not `null`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartDictationArgs {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vad_threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hangover_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_gpu: Option<bool>,
}

/// `stop_dictation` request `args` — none (field-less marker, serializes to `{}`).
/// Stops the mic; the engine answers + emits a terminal `final {text:""}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopDictationArgs {}

/// `segment` event `data` — one transcribed span (emitted by SF3 transcription).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub text: String,
    pub t0_ms: u64,
    pub t1_ms: u64,
}

/// `final` event `data` — the completed transcript text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Final {
    pub text: String,
}

/// `progress` event `data` — transcription progress percent (0..=100).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    pub pct: f64,
}

/// `vu` event `data` — input RMS level (Phase 2 SF1 dictation), ~20–30 Hz while
/// the mic is open. `f64` to match this module's float convention (`Progress.pct`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vu {
    pub rms: f64,
}

// ---------------------------------------------------------------------------
// Phase 5 model-management payloads — byte-identical mirror of iskariel-stt's
// protocol.rs (list_models / delete_model / download_model). The drift gate
// (tests/stt_roundtrip.rs) pins these.
// ---------------------------------------------------------------------------

/// `list_models` response element — a registry model's identity + cache status
/// (the Settings model picker). Mirror of the engine `CachedModelInfo`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedModelInfo {
    pub name: String,
    pub multilingual: bool,
    pub size_bytes: u64,
    pub cached: bool,
}

/// `delete_model` request `args`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteModelArgs {
    pub name: String,
}

/// `download_model` request `args` (download-only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadModelArgs {
    pub name: String,
}

/// `download_complete` event `data` — the terminal event of a successful download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadComplete {
    pub name: String,
}

// ---------------------------------------------------------------------------
// Phase 5 push-to-talk (SF5) — byte-identical mirror of iskariel-stt's protocol.rs
// hotkeys structs. The daemon pushes the snapshot as a `hotkeys` event + answers it
// inside `get_state` / `rebind_hotkeys` (both under `data.hotkeys`); dictation
// lifecycle events carry the source so the host routes a HOTKEY transcript to the
// daily log. The drift gate (tests/stt_roundtrip.rs) pins these.
// ---------------------------------------------------------------------------

/// The bound global-shortcut state (mirrors iskariel-capture's `HotkeysSnapshot`).
/// `bound:false` + `last_error` when the portal is unavailable. `last_error` has
/// NO `skip_serializing_if` (mirrors capture) → `None` serializes as `null`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeysSnapshot {
    pub bound: bool,
    pub portal_version: u32,
    pub can_configure: bool,
    pub shortcuts: Vec<Shortcut>,
    pub last_error: Option<String>,
}

/// One bound shortcut. `trigger_description` is what KDE ACTUALLY bound (may differ
/// from the requested default — the rebindability rule).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shortcut {
    pub id: String,
    pub description: String,
    pub trigger_description: String,
    pub reserved: bool,
}

/// `dictation_started` event `data` — `source ∈ { hotkey, client }` lets the host
/// distinguish global push-to-talk from a UI-initiated session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationStarted {
    pub source: String,
}

/// `dictation_committed` event `data` — the terminal transcript of a HOTKEY-driven
/// dictation (the daily-log sink trigger; UI-driven dictation never emits it — its
/// per-call Channel owns the `final`). Carries the full transcript text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationCommitted {
    pub text: String,
}

// ===========================================================================
// Async NDJSON client.
// ===========================================================================

/// `$XDG_RUNTIME_DIR/iskariel/stt.sock` (falls back to `/tmp` when the env var
/// is unset). Mirrors `iskariel-stt/src/daemon/socket.rs::socket_path`.
pub fn socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime.join("iskariel").join("stt.sock")
}

/// `\\.\pipe\iskariel-stt` — the Windows named-pipe endpoint. Mirrors
/// `iskariel-stt/src/daemon/socket.rs::PIPE_NAME` (the two crates are decoupled by
/// design; this name string is the coupling, exactly as the socket path is on Unix).
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\iskariel-stt";

/// Open the control pipe, retrying only the transient `ERROR_PIPE_BUSY` (231 — all
/// server instances momentarily busy, the `WaitNamedPipe` pattern). Every other
/// error — including `ERROR_FILE_NOT_FOUND` (2, no daemon yet) — propagates to
/// `connection_loop`'s backoff + queued-request drain, preserving the Unix
/// "fail-fast Disconnected while the engine is down" contract.
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

/// Connect to the engine + split into owned read/write halves. Per-OS: Unix
/// `UnixStream::into_split` (independent owned halves); Windows `tokio::io::split`
/// over the named-pipe client (named pipes have no `into_split`). Only one arm
/// compiles per target; both feed the generic [`serve_connection`].
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

/// Reconnect backoff bounds (fixed-step, capped — NOT exponential, NOT a tight
/// loop).
const RECONNECT_MIN: Duration = Duration::from_millis(250);
const RECONNECT_MAX: Duration = Duration::from_secs(5);
/// One in-flight request's wait before it gives up.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Event fan-out depth. Lagged receivers drop the gap and keep going.
const EVENT_BUS_CAP: usize = 256;
/// Hard ceiling on a single inbound NDJSON line. Stops a wedged or hostile peer
/// that never sends a newline from growing the read buffer without limit — over
/// it the read errors and the connection resets (then reconnects).
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Errors surfaced to callers. The crate has no `anyhow`/`thiserror`; this is a
/// tiny local enum stringified at the boundary (matches `VaultError` house style).
#[derive(Debug)]
pub enum SttError {
    /// The socket is not currently connected (engine down / not yet up).
    Disconnected,
    /// A request timed out waiting for its correlated response.
    Timeout,
    /// The engine answered with `ok:false` — carries its [`ProtoError`].
    Engine(ProtoError),
    /// Local (de)serialization or response-shape error.
    Protocol(String),
}

impl std::fmt::Display for SttError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SttError::Disconnected => write!(f, "stt engine not connected"),
            SttError::Timeout => write!(f, "stt request timed out"),
            SttError::Engine(e) => write!(f, "stt engine error [{}]: {}", e.code, e.message),
            SttError::Protocol(m) => write!(f, "stt protocol error: {m}"),
        }
    }
}

impl std::error::Error for SttError {}

/// What the read loop hands the writer: a line to send + the oneshot to fulfil
/// when its correlated `Response` arrives.
struct Outgoing {
    line: String,
    id: String,
    reply: oneshot::Sender<Response>,
}

/// The shared, reconnect-surviving handle. Cheap to clone (everything behind
/// `Arc`). The connection itself is owned by a background task spawned by
/// [`SttClient::connect`]; this handle just enqueues requests and exposes the
/// event bus. Outlives any single socket connection.
#[derive(Clone)]
pub struct SttClient {
    tx: mpsc::UnboundedSender<Outgoing>,
    events: broadcast::Sender<Event>,
    seq: Arc<AtomicU64>,
}

impl SttClient {
    /// Spawn the connection task and return a handle. The task runs forever:
    /// connect → serve until disconnect → backoff → reconnect. Spawned on the
    /// Tauri async runtime so it shares the app's reactor.
    ///
    /// Requests enqueued while disconnected fail fast with
    /// [`SttError::Disconnected`] (the writer side of the channel is dropped
    /// between connections), so callers never block on a dead engine.
    pub fn connect() -> Self {
        // ONE stable caller→loop channel for the whole client lifetime. Callers
        // always enqueue onto `tx`; the connection loop owns `rx` and hands each
        // request to the currently-live connection, or fails it fast (drops the
        // reply oneshot ⇒ caller sees Disconnected) while there is no connection.
        let (tx, rx) = mpsc::unbounded_channel::<Outgoing>();
        let (events, _) = broadcast::channel::<Event>(EVENT_BUS_CAP);
        let client = SttClient { tx, events: events.clone(), seq: Arc::new(AtomicU64::new(1)) };

        tauri::async_runtime::spawn(connection_loop(rx, events));
        client
    }

    /// Allocate the next request id. Process-unique, monotonic; never reused, so
    /// a dropped caller's id can't collide with a live one.
    fn next_id(&self) -> String {
        self.seq.fetch_add(1, Ordering::Relaxed).to_string()
    }

    /// Subscribe to the unsolicited engine event bus (`echo`, `model_loaded`,
    /// `segment`, `final`, `progress`, `error`). Lagged receivers drop the gap.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Send one request and await its correlated response. Returns the response's
    /// `data` on `ok:true`; maps `ok:false` to [`SttError::Engine`]. A dropped
    /// caller drops its `oneshot` receiver — the read loop notices the closed
    /// channel and evicts the pending entry, so **no id leaks**.
    pub async fn request(&self, op: &str, args: Value) -> Result<Option<Value>, SttError> {
        let id = self.next_id();
        let req = Request { op: op.to_string(), id: id.clone(), args };
        let line = serde_json::to_string(&req)
            .map_err(|e| SttError::Protocol(format!("encode request: {e}")))?;

        let (reply_tx, reply_rx) = oneshot::channel::<Response>();
        // Enqueue onto the current connection. A send error ⇒ no live connection.
        self.tx
            .send(Outgoing { line, id, reply: reply_tx })
            .map_err(|_| SttError::Disconnected)?;

        // Await the correlated response, bounded. The read loop fulfils `reply_tx`;
        // a dropped `reply_rx` (timeout/caller-drop) signals the loop to evict.
        let resp = match tokio::time::timeout(REQUEST_TIMEOUT, reply_rx).await {
            Ok(Ok(resp)) => resp,
            // Sender dropped without replying ⇒ the connection died mid-flight.
            Ok(Err(_)) => return Err(SttError::Disconnected),
            Err(_) => return Err(SttError::Timeout),
        };

        if resp.ok {
            Ok(resp.data)
        } else {
            Err(SttError::Engine(resp.error.unwrap_or_else(|| {
                ProtoError::new("internal", "engine returned ok:false with no error body")
            })))
        }
    }

    /// `get_state` → the engine's liveness probe call (the adopt-probe
    /// `socket_alive` uses). The SF1 daemon answers `ok:true` so a live socket is
    /// adoptable; the returned `data` is opaque at this layer (no typed snapshot
    /// yet — SF2/SF3 add one).
    pub async fn get_state(&self) -> Result<Value, SttError> {
        self.request("get_state", Value::Null)
            .await?
            .ok_or_else(|| SttError::Protocol("get_state returned no data".into()))
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
                #[cfg(unix)]
                log::info!("stt client connected to {}", socket_path().display());
                #[cfg(windows)]
                log::info!("stt client connected to {PIPE_NAME}");
                backoff = RECONNECT_MIN; // reset on a successful connect
                match serve_connection(read_half, write_half, &mut rx, &events).await {
                    // All `SttClient` handles dropped — the client is being torn
                    // down. Exit the task (no zombie reconnect loop).
                    ServeEnd::CallerGone => {
                        log::debug!("stt client: all handles dropped — connection task ending");
                        return;
                    }
                    // The socket died under us — reconnect after backoff.
                    ServeEnd::SocketClosed => {
                        log::warn!("stt client disconnected — will reconnect");
                    }
                }
            }
            Err(e) => {
                // Engine not up yet (common at boot) — debug, not warn, to avoid
                // log spam while the supervisor is still bringing it up.
                log::debug!("stt client connect failed: {e}");
                // Fail-fast any request that queued while we were down: drain
                // without blocking; dropping each `Outgoing.reply` unblocks the
                // caller with Disconnected (the timeout never has to fire).
                while let Ok(_dropped) = rx.try_recv() {}
            }
        }

        // Fixed-step backoff, capped (never a tight loop).
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX);
    }
}

/// Why [`serve_connection`] returned — drives the [`connection_loop`]'s
/// reconnect-vs-terminate decision.
enum ServeEnd {
    /// The socket EOF'd / errored / a write failed — reconnect.
    SocketClosed,
    /// Every `SttClient` handle dropped (the caller channel closed) — the client
    /// is being torn down; the connection task should end (no reconnect).
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
                    // All callers (and the SttClient handle) dropped.
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
                        log::warn!("stt client read error: {e}");
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
                log::debug!("stt client: unmatched response id {:?}", resp.id);
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
    log::warn!("stt client: skipping malformed socket line: {line}");
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

