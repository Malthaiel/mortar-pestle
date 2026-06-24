//! Game Capture Phase 1 — Step 2 cross-crate round-trip GATE (plan §10 Risk #1).
//!
//! The src-tauri NDJSON client structs (`app_lib::capture::client`) are a
//! **byte-identical mirror** of the engine's frozen `iskariel-capture/src/daemon/
//! protocol.rs`. The two crates are decoupled by design (no shared dependency),
//! so this test is what holds them in sync: for each wire type it pins the
//! **golden JSON exactly as the engine emits it** (derived from the engine's
//! serde attributes — exact field names + case + order), then asserts BOTH
//! directions:
//!
//!   1. deserialize the engine-shaped golden into the client struct (succeeds,
//!      expected values), then re-serialize → **byte-equal** to the golden;
//!   2. a client-produced JSON (for `Request` / `CaptureConfig`) equals the
//!      engine-expected golden.
//!
//! Run (NEVER `cargo test --lib` — it SIGTERMs the dev sandbox):
//! ```bash
//! cargo test --test capture_roundtrip
//! ```
//!
//! Golden-derivation rules baked in below (the frozen contract):
//! - snake_case (no `rename_all`): Request, Response, Event, ProtoError,
//!   StateSnapshot (top level), HotkeysSnapshot, Shortcut, Capabilities, SavedClip.
//! - camelCase (`rename_all = "camelCase"`): CaptureConfig + AudioConfig ONLY.
//! - `Response.data`/`Response.error`: `skip_serializing_if = "Option::is_none"`.
//! - `StateSnapshot.last_error`: NOT skipped → emitted as `null` when None.
//! - serde serializes struct fields in **declaration order**; the golden field
//!   order below matches each struct's declaration order so re-serialize is
//!   byte-equal regardless of serde_json's `preserve_order` feature.

use app_lib::capture::client::{
    AudioConfig, Capabilities, CaptureConfig, Event, HotkeysSnapshot, ProtoError, Request, Response,
    SavedClip, Shortcut, StateSnapshot,
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
    const GOLDEN: &str = r#"{"op":"start_clip","id":"7","args":{}}"#;

    let req: Request = assert_byte_roundtrip(GOLDEN);
    assert_eq!(req.op, "start_clip");
    assert_eq!(req.id, "7");

    // Direction 2: a client-PRODUCED request equals the engine golden.
    let produced = Request {
        op: "start_clip".into(),
        id: "7".into(),
        args: serde_json::json!({}),
    };
    assert_eq!(serde_json::to_string(&produced).unwrap(), GOLDEN);
}

#[test]
fn request_default_args_deserializes_to_null() {
    // `args` is `#[serde(default)]`: a missing `args` becomes `Value::Null`.
    let req: Request = serde_json::from_str(r#"{"op":"get_state","id":"1"}"#).unwrap();
    assert_eq!(req.op, "get_state");
    assert!(req.args.is_null());
    // Re-serializing then surfaces `args:null` (default only affects DEserialize).
    assert_eq!(
        serde_json::to_string(&req).unwrap(),
        r#"{"op":"get_state","id":"1","args":null}"#
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
    // A reserved verb's error response: `error` present, `data` omitted.
    const GOLDEN: &str =
        r#"{"id":"4","ok":false,"error":{"code":"not_implemented","message":"`arm` is not available in Phase 1"}}"#;
    let resp: Response = assert_byte_roundtrip(GOLDEN);
    assert!(!resp.ok);
    let err = resp.error.expect("error present");
    assert_eq!(err.code, "not_implemented");
    assert_eq!(err.message, "`arm` is not available in Phase 1");
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
    // `event ∈ {state_changed, saved, error}`; `data` is a plain Value.
    const GOLDEN: &str = r#"{"event":"state_changed","data":{"state":"recording"}}"#;
    let ev: Event = assert_byte_roundtrip(GOLDEN);
    assert_eq!(ev.event, "state_changed");
    assert_eq!(ev.data.get("state").and_then(|v| v.as_str()), Some("recording"));
}

#[test]
fn capture_config_camelcase_golden_roundtrips_and_default_produces_it() {
    // camelCase on the wire, field order = struct declaration order. This is the
    // `CaptureConfig::default()` value (the engine's `config_uses_camelcase...`
    // test pins replayLengthMin/bitrateMbps/sampleRate).
    const GOLDEN: &str = concat!(
        r#"{"schema":1,"replayLengthMin":5,"codec":"h264","bitrateMbps":50,"#,
        r#""rateControl":"cbr","keyintSec":2,"container":"mp4","#,
        r#""audio":{"track":"system","sampleRate":48000,"channels":2}}"#
    );

    let cfg: CaptureConfig = assert_byte_roundtrip(GOLDEN);
    assert_eq!(cfg.replay_length_min, 5);
    assert_eq!(cfg.bitrate_mbps, 50);
    assert_eq!(cfg.rate_control, "cbr");
    assert_eq!(cfg.keyint_sec, 2);
    assert_eq!(cfg.audio.sample_rate, 48_000);
    assert_eq!(cfg.audio.channels, 2);

    // Direction 2: the client's own Default must serialize to the engine golden
    // (Default values are pinned byte-for-byte against the engine's Default impl).
    assert_eq!(serde_json::to_string(&CaptureConfig::default()).unwrap(), GOLDEN);
}

#[test]
fn audio_config_camelcase_golden_roundtrips() {
    const GOLDEN: &str = r#"{"track":"system","sampleRate":48000,"channels":2}"#;
    let a: AudioConfig = assert_byte_roundtrip(GOLDEN);
    assert_eq!(a.sample_rate, 48_000);
    // Direction 2.
    let made = AudioConfig { track: "system".into(), sample_rate: 48_000, channels: 2 };
    assert_eq!(serde_json::to_string(&made).unwrap(), GOLDEN);
}

#[test]
fn hotkeys_and_shortcut_snake_case_golden_roundtrips() {
    // snake_case (`trigger_description`, `portal_version`, `can_configure`,
    // `last_error`); `last_error` is NOT skipped → emitted as null when None.
    const GOLDEN: &str = concat!(
        r#"{"bound":true,"portal_version":2,"can_configure":true,"shortcuts":["#,
        r#"{"id":"record","description":"Start/stop recording","#,
        r#""trigger_description":"Ctrl+Alt+R","reserved":false}],"last_error":null}"#
    );
    let hk: HotkeysSnapshot = assert_byte_roundtrip(GOLDEN);
    assert!(hk.bound);
    assert_eq!(hk.portal_version, 2);
    assert_eq!(hk.shortcuts.len(), 1);
    assert_eq!(hk.shortcuts[0].id, "record");
    assert_eq!(hk.shortcuts[0].trigger_description, "Ctrl+Alt+R");
    assert!(hk.last_error.is_none());
}

#[test]
fn shortcut_standalone_golden_roundtrips() {
    const GOLDEN: &str =
        r#"{"id":"save_replay","description":"Save replay","trigger_description":"","reserved":true}"#;
    let s: Shortcut = assert_byte_roundtrip(GOLDEN);
    assert_eq!(s.id, "save_replay");
    assert!(s.reserved);
}

#[test]
fn capabilities_snake_case_golden_roundtrips() {
    // `save_replay` is snake_case (no rename_all on Capabilities).
    const GOLDEN: &str = r#"{"screenshot":false,"save_replay":false,"arm":false}"#;
    let c: Capabilities = assert_byte_roundtrip(GOLDEN);
    assert!(!c.screenshot);
    assert!(!c.save_replay);
    assert!(!c.arm);
}

#[test]
fn saved_clip_snake_case_golden_roundtrips() {
    // `duration_s` (f64), `started_monotonic_pts_ns`/`last_monotonic_pts_ns`
    // (u64), `poster` (Option, NOT skipped → null when None). Note f64 `12.5`.
    const GOLDEN: &str = concat!(
        r#"{"path":"/home/u/.local/share/Library/Captures/Deadlock/clip.mp4","#,
        r#""game":"Deadlock","duration_s":12.5,"started_monotonic_pts_ns":1000,"#,
        r#""last_monotonic_pts_ns":13500000000,"poster":null,"width":1920,"#,
        r#""height":1080,"codec":"h264"}"#
    );
    let clip: SavedClip = assert_byte_roundtrip(GOLDEN);
    assert_eq!(clip.game, "Deadlock");
    assert_eq!(clip.duration_s, 12.5);
    assert_eq!(clip.width, 1920);
    assert!(clip.poster.is_none());
    assert!(clip.path.ends_with(".mp4"));
}

#[test]
fn saved_clip_interim_step3_payload_is_tolerated() {
    // Plan Step-3 note: the SF1a-interim `saved` carries a `.h264` path, 0×0
    // dims, and null poster. The client MUST deserialize it WITHOUT error (it is
    // not a regression — the unified `.mp4`-only contract only fully holds after
    // Step 5). This guards the cross-step constraint binding SF2e.
    const GOLDEN: &str = concat!(
        r#"{"path":"/tmp/iskariel/clip.h264","game":"Deadlock","duration_s":3.0,"#,
        r#""started_monotonic_pts_ns":0,"last_monotonic_pts_ns":3000000000,"#,
        r#""poster":null,"width":0,"height":0,"codec":"h264"}"#
    );
    let clip: SavedClip = assert_byte_roundtrip(GOLDEN);
    assert!(clip.path.ends_with(".h264"));
    assert_eq!(clip.width, 0);
    assert_eq!(clip.height, 0);
    assert!(clip.poster.is_none());
}

#[test]
fn state_snapshot_full_golden_roundtrips() {
    // The whole snapshot: top-level snake_case in declaration order, nested
    // `config` flips to camelCase, `game`/`last_error` are Options emitted as
    // null when None (NOT skipped). Field order below = StateSnapshot declaration
    // order; nested config = CaptureConfig declaration order.
    const GOLDEN: &str = concat!(
        r#"{"version":1,"recording":false,"state":"idle","game":null,"#,
        r#""started_at_unix_ms":0,"elapsed_ns":0,"codec":"h264","bitrate_bps":50000000,"#,
        r#""gop_len":120,"fps_num":60,"fps_den":1,"#,
        r#""hotkeys":{"bound":false,"portal_version":0,"can_configure":false,"shortcuts":[],"last_error":null},"#,
        r#""config":{"schema":1,"replayLengthMin":5,"codec":"h264","bitrateMbps":50,"#,
        r#""rateControl":"cbr","keyintSec":2,"container":"mp4","#,
        r#""audio":{"track":"system","sampleRate":48000,"channels":2}},"#,
        r#""last_error":null,"#,
        r#""capabilities":{"screenshot":false,"save_replay":false,"arm":false}}"#
    );

    let snap: StateSnapshot = assert_byte_roundtrip(GOLDEN);
    assert_eq!(snap.version, 1);
    assert_eq!(snap.state, "idle");
    assert!(snap.game.is_none());
    assert!(snap.last_error.is_none());
    assert_eq!(snap.bitrate_bps, 50_000_000);
    assert_eq!(snap.gop_len, 120);
    assert_eq!(snap.fps_num, 60);
    // Nested camelCase config survived the snake_case envelope.
    assert_eq!(snap.config.replay_length_min, 5);
    assert_eq!(snap.config.audio.sample_rate, 48_000);
    assert!(snap.hotkeys.shortcuts.is_empty());
    assert!(!snap.capabilities.arm);
}
