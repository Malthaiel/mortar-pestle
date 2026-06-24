//! Voice Transcription SF1 — STT cross-crate round-trip GATE.
//!
//! The src-tauri NDJSON client structs (`app_lib::stt::client`) are a
//! **byte-identical mirror** of the engine's frozen `iskariel-stt/src/
//! protocol.rs`. The two crates are decoupled by design (no shared dependency),
//! so this test is what holds them in sync: for each wire type it pins the
//! **golden JSON exactly as the engine emits it** (derived from the engine's
//! serde attributes — exact field names + case + order), then asserts BOTH
//! directions:
//!
//!   1. deserialize the engine-shaped golden into the client struct (succeeds,
//!      expected values), then re-serialize → **byte-equal** to the golden;
//!   2. a client-produced JSON (for the types the client builds — `Request`,
//!      `EchoPayload`, the SF2/SF3 arg + payload structs) equals the
//!      engine-expected golden.
//!
//! Run (NEVER `cargo test --lib` — it SIGTERMs the dev sandbox):
//! ```bash
//! cargo test --test stt_roundtrip
//! ```
//!
//! Golden-derivation rules baked in below (the frozen contract):
//! - ALL STT types are plain snake_case — there is NO `rename_all` anywhere and
//!   NO camelCase boundary (the single biggest divergence from the capture
//!   gate). Envelope: Request, Response, Event, ProtoError. SF1/SF2/SF3
//!   payloads: EchoPayload, LoadModelArgs, TranscribeFileArgs, ModelLoaded,
//!   Segment, Final, Progress.
//! - `Response.data`/`Response.error`: `skip_serializing_if = "Option::is_none"`.
//! - `Request.args` is `#[serde(default)]` (a missing `args` deserializes to
//!   `Value::Null`; default affects DEserialize only — re-serialize emits
//!   `args:null`).
//! - serde serializes struct fields in **declaration order**; the golden field
//!   order below matches each struct's declaration order so re-serialize is
//!   byte-equal regardless of serde_json's `preserve_order` feature.
//!
//! Naming note: the engine's `echo` payload is `EchoArgs`; the client mirror is
//! `EchoPayload`. The rename is invisible on the wire (`{"text":"..."}`), so the
//! gate imports the client `EchoPayload` and the golden bytes still hold.

use app_lib::stt::client::{
    CachedModelInfo, DeleteModelArgs, DictationCommitted, DictationStarted, DownloadComplete,
    DownloadModelArgs, EchoPayload, Event, Final, HotkeysSnapshot, LoadModelArgs, ModelLoaded,
    Progress, ProtoError, Request, Response, Segment, Shortcut, StartDictationArgs,
    StopDictationArgs, TranscribeFileArgs, Vu,
};
use serde::{de::DeserializeOwned, Serialize};

/// Deserialize the golden into `T`, then re-serialize and assert byte-equality.
/// Returns the deserialized value for further field assertions.
fn assert_byte_roundtrip<T>(golden: &str) -> T
where
    T: Serialize + DeserializeOwned,
{
    let value: T = serde_json::from_str(golden)
        .unwrap_or_else(|e| panic!("deserialize golden failed: {e}\n  golden: {golden}"));
    let reserialized = serde_json::to_string(&value).expect("re-serialize failed");
    assert_eq!(
        reserialized, golden,
        "re-serialized bytes must equal the engine golden"
    );
    value
}

#[test]
fn request_golden_roundtrips_and_client_produces_it() {
    // The exact wire bytes the engine's `request_roundtrips_flat_verb_form` test
    // pins: flat verb form, `args` always present (it is a `Value`, no skip).
    const GOLDEN: &str = r#"{"op":"echo","id":"7","args":{"text":"hi"}}"#;

    let req: Request = assert_byte_roundtrip(GOLDEN);
    assert_eq!(req.op, "echo");
    assert_eq!(req.id, "7");

    // Direction 2: a client-PRODUCED request equals the engine golden.
    let produced = Request {
        op: "echo".into(),
        id: "7".into(),
        args: serde_json::json!({ "text": "hi" }),
    };
    assert_eq!(serde_json::to_string(&produced).unwrap(), GOLDEN);
}

#[test]
fn request_default_args_deserializes_to_null() {
    // `args` is `#[serde(default)]`: a missing `args` becomes `Value::Null`.
    // Mirrors the engine's `request_args_defaults_when_missing` (verb `cancel`).
    let req: Request = serde_json::from_str(r#"{"op":"cancel","id":"3"}"#).unwrap();
    assert_eq!(req.op, "cancel");
    assert!(req.args.is_null());
    // Re-serializing then surfaces `args:null` (default only affects DEserialize).
    assert_eq!(
        serde_json::to_string(&req).unwrap(),
        r#"{"op":"cancel","id":"3","args":null}"#
    );
}

#[test]
fn response_ok_omits_none_fields() {
    // The engine's `response_omits_none_fields` test: both Option fields omitted.
    const GOLDEN: &str = r#"{"id":"1","ok":true}"#;
    let resp: Response = assert_byte_roundtrip(GOLDEN);
    assert_eq!(resp.id, "1");
    assert!(resp.ok);
    assert!(resp.data.is_none());
    assert!(resp.error.is_none());
}

#[test]
fn response_error_serializes_protoerror() {
    // A stubbed verb's error response: `error` present, `data` omitted. Mirrors
    // the engine's `not_implemented` SF1 reply for the stubbed STT verbs.
    const GOLDEN: &str =
        r#"{"id":"4","ok":false,"error":{"code":"not_implemented","message":"`load_model` is not available in SF1"}}"#;
    let resp: Response = assert_byte_roundtrip(GOLDEN);
    assert!(!resp.ok);
    let err = resp.error.expect("error present");
    assert_eq!(err.code, "not_implemented");
    assert_eq!(err.message, "`load_model` is not available in SF1");
}

#[test]
fn protoerror_golden_roundtrips() {
    const GOLDEN: &str = r#"{"code":"bad_request","message":"unknown op `frobnicate`"}"#;
    let e: ProtoError = assert_byte_roundtrip(GOLDEN);
    assert_eq!(e.code, "bad_request");
    // The convenience ctor must produce the same shape.
    let made = ProtoError::new("bad_request", "unknown op `frobnicate`");
    assert_eq!(made.code, "bad_request");
}

#[test]
fn event_golden_roundtrips() {
    // `event ∈ {echo, model_loaded, segment, final, progress, error}`; `data` is
    // a plain Value.
    const GOLDEN: &str = r#"{"event":"model_loaded","data":{"backend":"cpu"}}"#;
    let ev: Event = assert_byte_roundtrip(GOLDEN);
    assert_eq!(ev.event, "model_loaded");
    assert_eq!(ev.data.get("backend").and_then(|v| v.as_str()), Some("cpu"));
}

#[test]
fn echo_payload_golden_roundtrips() {
    // The SF1 handshake payload — request `args` and `echo` event `data`.
    const GOLDEN: &str = r#"{"text":"hello"}"#;
    let p: EchoPayload = assert_byte_roundtrip(GOLDEN);
    assert_eq!(p.text, "hello");
    // Direction 2: the client-built payload equals the engine golden.
    let made = EchoPayload { text: "hello".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn load_model_args_golden_roundtrips() {
    const GOLDEN: &str = r#"{"name":"base.en"}"#;
    let a: LoadModelArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.name, "base.en");
    // Direction 2.
    let made = LoadModelArgs { name: "base.en".into(), use_gpu: None };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn model_loaded_golden_roundtrips() {
    // Lifted from the engine's `stt_payloads_use_snake_case_on_the_wire` test.
    const GOLDEN: &str = r#"{"name":"base.en","sha":"abc","backend":"cpu"}"#;
    let ml: ModelLoaded = assert_byte_roundtrip(GOLDEN);
    assert_eq!(ml.name, "base.en");
    assert_eq!(ml.sha, "abc");
    assert_eq!(ml.backend, "cpu");
    // Direction 2.
    let made = ModelLoaded { name: "base.en".into(), sha: "abc".into(), backend: "cpu".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn transcribe_file_args_golden_roundtrips() {
    const GOLDEN: &str = r#"{"path":"/tmp/audio.wav"}"#;
    let a: TranscribeFileArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.path, "/tmp/audio.wav");
    // Direction 2.
    let made = TranscribeFileArgs { path: "/tmp/audio.wav".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn segment_golden_roundtrips() {
    // Lifted from the engine's `stt_payloads_use_snake_case_on_the_wire` test.
    // `t0_ms`/`t1_ms` are u64 → emitted as bare integers (no quotes).
    const GOLDEN: &str = r#"{"text":"hi","t0_ms":10,"t1_ms":20}"#;
    let seg: Segment = assert_byte_roundtrip(GOLDEN);
    assert_eq!(seg.text, "hi");
    assert_eq!(seg.t0_ms, 10);
    assert_eq!(seg.t1_ms, 20);
    // Direction 2.
    let made = Segment { text: "hi".into(), t0_ms: 10, t1_ms: 20 };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn final_golden_roundtrips() {
    const GOLDEN: &str = r#"{"text":"done"}"#;
    let f: Final = assert_byte_roundtrip(GOLDEN);
    assert_eq!(f.text, "done");
    // Direction 2.
    let made = Final { text: "done".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn progress_golden_roundtrips() {
    // `pct` is f64 → serde_json emits `50.0` (the trailing `.0`), mirroring the
    // capture gate's `12.5` f64 precedent.
    const GOLDEN: &str = r#"{"pct":50.0}"#;
    let p: Progress = assert_byte_roundtrip(GOLDEN);
    assert_eq!(p.pct, 50.0);
    // Direction 2.
    let made = Progress { pct: 50.0 };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn start_dictation_args_golden_roundtrips() {
    // Phase 2 SF1 dictation kickoff args. Declaration order is model, vad_threshold,
    // hangover_ms. With both options PRESENT the golden carries all three keys;
    // `vad_threshold` is f32 → `0.5` (trailing-`.0` float, mirroring `Progress.pct`),
    // `hangover_ms` is u32 → bare int.
    const GOLDEN: &str = r#"{"model":"base.en","vad_threshold":0.5,"hangover_ms":300}"#;
    let a: StartDictationArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.model, "base.en");
    assert_eq!(a.vad_threshold, Some(0.5));
    assert_eq!(a.hangover_ms, Some(300));
    // Direction 2: the client-built args equal the engine golden.
    let made = StartDictationArgs {
        model: "base.en".into(),
        vad_threshold: Some(0.5),
        hangover_ms: Some(300),
        use_gpu: None,
    };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn start_dictation_args_omits_none_options() {
    // Both Option fields are `skip_serializing_if = "Option::is_none"`, so an args
    // value with neither set serializes to just `{"model":...}` — the forward-compat
    // fields are absent on the wire when unused (the SF1 norm).
    const GOLDEN: &str = r#"{"model":"base.en"}"#;
    let a: StartDictationArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.model, "base.en");
    assert!(a.vad_threshold.is_none());
    assert!(a.hangover_ms.is_none());
    // Direction 2.
    let made = StartDictationArgs { model: "base.en".into(), vad_threshold: None, hangover_ms: None, use_gpu: None };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn stop_dictation_args_golden_roundtrips() {
    // `stop_dictation` takes no args — a field-less marker struct serializes to the
    // empty object `{}` (NOT `null`; that path is the envelope's `Request.args`
    // default, covered by `request_default_args_deserializes_to_null`).
    const GOLDEN: &str = r#"{}"#;
    let _a: StopDictationArgs = assert_byte_roundtrip(GOLDEN);
    // Direction 2.
    let made = StopDictationArgs {};
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn vu_golden_roundtrips() {
    // `vu` event data — `rms` is f64 → serde_json emits `0.5` (trailing-`.0` float),
    // mirroring the `Progress` (`{"pct":50.0}`) precedent.
    const GOLDEN: &str = r#"{"rms":0.5}"#;
    let v: Vu = assert_byte_roundtrip(GOLDEN);
    assert_eq!(v.rms, 0.5);
    // Direction 2.
    let made = Vu { rms: 0.5 };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

// ── Phase 5 model-management payloads ────────────────────────────────────────

#[test]
fn cached_model_info_golden_roundtrips() {
    // `list_models` element. Declaration order: name, multilingual, size_bytes, cached.
    // size_bytes u64 → bare int; multilingual/cached → bare bools.
    const GOLDEN: &str =
        r#"{"name":"base.en","multilingual":false,"size_bytes":147964211,"cached":true}"#;
    let m: CachedModelInfo = assert_byte_roundtrip(GOLDEN);
    assert_eq!(m.name, "base.en");
    assert!(!m.multilingual);
    assert_eq!(m.size_bytes, 147_964_211);
    assert!(m.cached);
    // Direction 2.
    let made = CachedModelInfo {
        name: "base.en".into(),
        multilingual: false,
        size_bytes: 147_964_211,
        cached: true,
    };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn delete_model_args_golden_roundtrips() {
    const GOLDEN: &str = r#"{"name":"small"}"#;
    let a: DeleteModelArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.name, "small");
    let made = DeleteModelArgs { name: "small".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn download_model_args_golden_roundtrips() {
    const GOLDEN: &str = r#"{"name":"small"}"#;
    let a: DownloadModelArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.name, "small");
    let made = DownloadModelArgs { name: "small".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn download_complete_golden_roundtrips() {
    const GOLDEN: &str = r#"{"name":"small"}"#;
    let d: DownloadComplete = assert_byte_roundtrip(GOLDEN);
    assert_eq!(d.name, "small");
    let made = DownloadComplete { name: "small".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

// ── Phase 5 Force-CPU (use_gpu) present-case goldens ─────────────────────────

#[test]
fn load_model_args_with_use_gpu_golden() {
    // Force-CPU on the wire: use_gpu present. Declaration order name, use_gpu.
    const GOLDEN: &str = r#"{"name":"base.en","use_gpu":false}"#;
    let a: LoadModelArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.name, "base.en");
    assert_eq!(a.use_gpu, Some(false));
    let made = LoadModelArgs { name: "base.en".into(), use_gpu: Some(false) };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn start_dictation_args_with_use_gpu_golden() {
    // All four keys present; use_gpu last in declaration order (after hangover_ms).
    const GOLDEN: &str =
        r#"{"model":"base.en","vad_threshold":0.5,"hangover_ms":300,"use_gpu":false}"#;
    let a: StartDictationArgs = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.use_gpu, Some(false));
    let made = StartDictationArgs {
        model: "base.en".into(),
        vad_threshold: Some(0.5),
        hangover_ms: Some(300),
        use_gpu: Some(false),
    };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

// ── Phase 5 push-to-talk (SF5) hotkeys payloads ──────────────────────────────
// Goldens lifted from the engine's `protocol::tests::hotkeys_wire_shapes`.

#[test]
fn shortcut_golden_roundtrips() {
    // Declaration order: id, description, trigger_description, reserved. reserved → bare bool.
    const GOLDEN: &str =
        r#"{"id":"dictate","description":"Push-to-talk dictation","trigger_description":"Ctrl+Shift+Space","reserved":false}"#;
    let s: Shortcut = assert_byte_roundtrip(GOLDEN);
    assert_eq!(s.id, "dictate");
    assert_eq!(s.trigger_description, "Ctrl+Shift+Space");
    assert!(!s.reserved);
    let made = Shortcut {
        id: "dictate".into(),
        description: "Push-to-talk dictation".into(),
        trigger_description: "Ctrl+Shift+Space".into(),
        reserved: false,
    };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn hotkeys_snapshot_golden_roundtrips() {
    // `last_error` has NO skip_serializing_if (mirrors capture) → None emits `null`.
    // Declaration order: bound, portal_version, can_configure, shortcuts, last_error.
    const GOLDEN: &str =
        r#"{"bound":true,"portal_version":1,"can_configure":false,"shortcuts":[],"last_error":null}"#;
    let snap: HotkeysSnapshot = assert_byte_roundtrip(GOLDEN);
    assert!(snap.bound);
    assert_eq!(snap.portal_version, 1);
    assert!(snap.shortcuts.is_empty());
    assert!(snap.last_error.is_none());
    let made = HotkeysSnapshot {
        bound: true,
        portal_version: 1,
        can_configure: false,
        shortcuts: vec![],
        last_error: None,
    };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);

    // Nested case: a populated `shortcuts` Vec<Shortcut> + a present `last_error`
    // (proves the nested struct serializes in declaration order and `last_error`
    // carries a string, not null, when Some).
    const NESTED: &str = r#"{"bound":false,"portal_version":2,"can_configure":true,"shortcuts":[{"id":"dictate","description":"Push-to-talk dictation","trigger_description":"Ctrl+Shift+Space","reserved":false}],"last_error":"portal unavailable"}"#;
    let n: HotkeysSnapshot = assert_byte_roundtrip(NESTED);
    assert_eq!(n.shortcuts.len(), 1);
    assert_eq!(n.last_error.as_deref(), Some("portal unavailable"));
}

#[test]
fn dictation_started_golden_roundtrips() {
    const GOLDEN: &str = r#"{"source":"hotkey"}"#;
    let d: DictationStarted = assert_byte_roundtrip(GOLDEN);
    assert_eq!(d.source, "hotkey");
    let made = DictationStarted { source: "hotkey".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn dictation_committed_golden_roundtrips() {
    const GOLDEN: &str = r#"{"text":"hello world"}"#;
    let d: DictationCommitted = assert_byte_roundtrip(GOLDEN);
    assert_eq!(d.text, "hello world");
    let made = DictationCommitted { text: "hello world".into() };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}
