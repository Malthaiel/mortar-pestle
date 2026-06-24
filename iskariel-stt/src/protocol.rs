//! Frozen NDJSON control protocol for the speech-to-text engine daemon.
//!
//! Single source of truth for the Unix-socket wire format (Voice Transcription
//! epic). obs-websocket-v5 *shape* (correlated request/response by `id` +
//! unsolicited async events) over a **flat verb form** — NOT the literal obs
//! integer opcodes. The src-tauri client structs (the STT analogue of
//! `src-tauri/src/capture/client.rs`) MUST mirror these byte-for-byte; a
//! cross-crate round-trip test is the drift gate before any client code lands.
//!
//! Casing: the four envelope types + every SF1 payload are plain snake_case (no
//! serde `rename_all`). Matches the iskariel-capture envelope byte-for-byte.
#![allow(dead_code)] // SF1 emits `echo` + dictation `vu`; the rest land in SF2/SF3.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Envelope (byte-for-byte identical to the iskariel-capture wire format) ─────

/// Client→engine request frame: `{"op": <verb>, "id": <string>, "args": {...}}`.
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

// ── SF1 STT payloads ─────────────────────────────────────────────────────────
//
// Request `args` shapes (app → sidecar) and Event `data` shapes (sidecar → app).
// snake_case on the wire, matching the envelope. Only `echo` is FUNCTIONAL in
// SF1; `load_model`/`transcribe_file`/`cancel`/`unload` are STUBBED at dispatch
// (`not_implemented`) and their args/payloads are defined here for the SF2/SF3
// implementations + the host client mirror.

/// `echo` request args / `echo` event data — the SF1 handshake payload. The
/// daemon echoes this straight back (as a `Response.data` value, and optionally
/// as an `echo` event).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EchoArgs {
    pub text: String,
}

/// `load_model` request args. `name` is a Whisper model identifier; `use_gpu`
/// (Phase 5 Force-CPU) picks the backend — absent/`None` = auto (GPU-first, CPU
/// fallback), `Some(false)` = force CPU, `Some(true)` = force the compiled GPU.
/// `skip_serializing_if` keeps an omitted optional absent on the wire (not `null`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadModelArgs {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_gpu: Option<bool>,
}

/// `transcribe_file` request args (SF3). `path` is an absolute audio-file path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeFileArgs {
    pub path: String,
}

/// `start_dictation` request args (Phase 2 SF1 mic capture). `model` /
/// `vad_threshold` / `hangover_ms` are PARSED but UNUSED this SF — forward-compat
/// for SF2 (VAD) and SF3 (transcription). SF1 only opens the mic, resamples to
/// 16 kHz mono f32, and streams `vu` events; it never loads a model or gates on
/// voice activity. The two `Option` fields use `skip_serializing_if` (the file's
/// only `Option` precedent — `Response.data`/`.error`), so an omitted optional
/// is absent on the wire, not `null`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartDictationArgs {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vad_threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hangover_ms: Option<u32>,
    /// Phase 5 Force-CPU — see [`LoadModelArgs::use_gpu`]. Picks the dictation
    /// speech-context backend (None = auto, Some(false) = force CPU).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_gpu: Option<bool>,
}

/// `stop_dictation` request args — none. Stops the mic and emits a terminal
/// `final {text:""}` (SF1 has no transcription). A field-less marker struct kept
/// for the host mirror + the round-trip gate (serializes to `{}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopDictationArgs {}

/// `model_loaded` event data (SF2): the loaded model's identity + backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelLoaded {
    pub name: String,
    pub sha: String,
    pub backend: String,
}

/// `segment` event data (SF3): one transcribed span with millisecond bounds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub text: String,
    pub t0_ms: u64,
    pub t1_ms: u64,
}

/// `final` event data (SF3): the complete transcript for a `transcribe_file`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Final {
    pub text: String,
}

/// `progress` event data (SF3): transcription completion percentage `0..=100`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    pub pct: f64,
}

/// `vu` event data (Phase 2 SF1 dictation): the current input level — RMS
/// amplitude of the resampled 16 kHz mono f32 buffer, emitted at ~20–30 Hz while
/// the mic is open. `f64` to match this module's float convention (`Progress.pct`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vu {
    pub rms: f64,
}

// ── Phase 5 model-management payloads ─────────────────────────────────────────
//
// `list_models` (sync) → `Response.data = { "models": [CachedModelInfo, ...] }`;
// `delete_model {name}` (sync) → ok/err; `download_model {name}` (streaming) → a
// download-only fetch that streams `progress` then a terminal `download_complete`
// (it does NOT load/swap the resident model — download ≠ activate). All snake_case,
// matching the envelope.

/// One registry model's identity + cache status for the Settings model picker
/// (`list_models`). `cached` is a cheap presence+size check (NOT a re-hash); the
/// load path re-verifies SHA256 before trusting a file. The VAD model is excluded
/// from the listing (an internal dependency, never a user-selectable speech model).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedModelInfo {
    pub name: String,
    pub multilingual: bool,
    pub size_bytes: u64,
    pub cached: bool,
}

/// `delete_model` request args — the registry name to evict from the cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteModelArgs {
    pub name: String,
}

/// `download_model` request args — the registry name to fetch (download-only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadModelArgs {
    pub name: String,
}

/// `download_complete` event data — the terminal event of a successful
/// `download_model` (the download-only analog of `model_loaded`; no `backend`
/// because nothing was loaded).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadComplete {
    pub name: String,
}

// ── Phase 5 push-to-talk (SF5) ────────────────────────────────────────────────
//
// Global hold-to-talk hotkey via the XDG GlobalShortcuts portal. HotkeysSnapshot +
// Shortcut mirror iskariel-capture's wire structs byte-for-byte. The daemon pushes
// the snapshot as a `hotkeys` event + answers it inside `get_state`. Dictation
// lifecycle events carry the source so the host routes a HOTKEY transcript to the
// daily log (`dictation_committed`), while UI-driven dictation uses its per-call
// Channel.

/// The bound global-shortcut state (mirrors iskariel-capture's `HotkeysSnapshot`).
/// `bound:false` + `last_error` when the portal is unavailable.
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

/// `dictation_started` event — a dictation began. `source ∈ { hotkey, client }`
/// lets the host distinguish global push-to-talk from a UI-initiated session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationStarted {
    pub source: String,
}

/// `dictation_committed` event — the terminal transcript of a HOTKEY-driven
/// dictation (the daily-log sink trigger; UI-driven dictation never emits it — its
/// per-call Channel owns the `final`). Carries the full transcript text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationCommitted {
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_roundtrips_flat_verb_form() {
        // The exact wire bytes the host STT client must produce.
        let line = r#"{"op":"echo","id":"7","args":{"text":"hi"}}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        assert_eq!(req.op, "echo");
        assert_eq!(req.id, "7");
        let s = serde_json::to_string(&req).unwrap();
        let back: Request = serde_json::from_str(&s).unwrap();
        assert_eq!(back.op, "echo");
        assert_eq!(back.id, "7");
    }

    #[test]
    fn request_args_defaults_when_missing() {
        // `args` is #[serde(default)] — a request with no `args` key parses.
        let req: Request = serde_json::from_str(r#"{"op":"cancel","id":"3"}"#).unwrap();
        assert_eq!(req.op, "cancel");
        assert!(req.args.is_null());
    }

    #[test]
    fn response_omits_none_fields() {
        let ok = Response { id: "1".into(), ok: true, data: None, error: None };
        let s = serde_json::to_string(&ok).unwrap();
        assert_eq!(s, r#"{"id":"1","ok":true}"#);
    }

    #[test]
    fn echo_response_round_trips_payload() {
        // The SF1 handshake: an `echo` reply carries the echoed args as data.
        let resp = Response {
            id: "1".into(),
            ok: true,
            data: Some(json!({ "text": "hello" })),
            error: None,
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert_eq!(s, r#"{"id":"1","ok":true,"data":{"text":"hello"}}"#);
    }

    #[test]
    fn protoerror_uses_snake_case_codes() {
        let err = ProtoError::new("not_implemented", "`unload` is not available in SF1");
        let s = serde_json::to_string(&err).unwrap();
        assert_eq!(
            s,
            r#"{"code":"not_implemented","message":"`unload` is not available in SF1"}"#
        );
    }

    #[test]
    fn event_is_flat_event_data_shape() {
        let ev = Event {
            event: "segment".into(),
            data: json!({ "text": "x", "t0_ms": 0, "t1_ms": 500 }),
        };
        let s = serde_json::to_string(&ev).unwrap();
        // Assert the flat {event, data} SHAPE via parsed-Value equality, not raw byte
        // order: serde_json (no `preserve_order` feature) serializes `Value::Object`
        // keys alphabetically, so a string-equality assert on insertion order is wrong.
        // The wire contract is the flat shape, not the key ordering. (Struct-based
        // payloads below keep declaration order and are byte-asserted as before.)
        let got: serde_json::Value = serde_json::from_str(&s).unwrap();
        let want = json!({ "event": "segment", "data": { "text": "x", "t0_ms": 0, "t1_ms": 500 } });
        assert_eq!(got, want);
    }

    #[test]
    fn stt_payloads_use_snake_case_on_the_wire() {
        let seg = Segment { text: "hi".into(), t0_ms: 10, t1_ms: 20 };
        let s = serde_json::to_string(&seg).unwrap();
        assert_eq!(s, r#"{"text":"hi","t0_ms":10,"t1_ms":20}"#);

        let ml = ModelLoaded { name: "base.en".into(), sha: "abc".into(), backend: "cpu".into() };
        let s = serde_json::to_string(&ml).unwrap();
        assert_eq!(s, r#"{"name":"base.en","sha":"abc","backend":"cpu"}"#);
    }

    #[test]
    fn cached_model_info_wire_shape() {
        // Declaration order name, multilingual, size_bytes, cached; size_bytes u64
        // → bare int, cached/multilingual → bare bools.
        let m = CachedModelInfo {
            name: "base.en".into(),
            multilingual: false,
            size_bytes: 147_964_211,
            cached: true,
        };
        let s = serde_json::to_string(&m).unwrap();
        assert_eq!(s, r#"{"name":"base.en","multilingual":false,"size_bytes":147964211,"cached":true}"#);
    }

    #[test]
    fn model_mgmt_args_and_terminal_wire_shape() {
        let d = DeleteModelArgs { name: "small".into() };
        assert_eq!(serde_json::to_string(&d).unwrap(), r#"{"name":"small"}"#);
        let dl = DownloadModelArgs { name: "small".into() };
        assert_eq!(serde_json::to_string(&dl).unwrap(), r#"{"name":"small"}"#);
        let dc = DownloadComplete { name: "small".into() };
        assert_eq!(serde_json::to_string(&dc).unwrap(), r#"{"name":"small"}"#);
    }

    #[test]
    fn hotkeys_wire_shapes() {
        let s = Shortcut {
            id: "dictate".into(),
            description: "Push-to-talk dictation".into(),
            trigger_description: "Ctrl+Shift+Space".into(),
            reserved: false,
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"id":"dictate","description":"Push-to-talk dictation","trigger_description":"Ctrl+Shift+Space","reserved":false}"#
        );
        // last_error has NO skip_serializing_if (mirrors capture) → None emits null.
        let snap = HotkeysSnapshot { bound: true, portal_version: 1, can_configure: false, shortcuts: vec![], last_error: None };
        assert_eq!(
            serde_json::to_string(&snap).unwrap(),
            r#"{"bound":true,"portal_version":1,"can_configure":false,"shortcuts":[],"last_error":null}"#
        );
        let ds = DictationStarted { source: "hotkey".into() };
        assert_eq!(serde_json::to_string(&ds).unwrap(), r#"{"source":"hotkey"}"#);
        let dc = DictationCommitted { text: "hello world".into() };
        assert_eq!(serde_json::to_string(&dc).unwrap(), r#"{"text":"hello world"}"#);
    }
}

