//! Frozen NDJSON control protocol for the Game Capture engine daemon.
//!
//! Single source of truth for the Unix-socket wire format (Complete Phase 1
//! plan, §3.3 / §4.1). obs-websocket-v5 *shape* (correlated request/response by
//! `id` + unsolicited async events) over a **flat verb form** — NOT the literal
//! obs integer opcodes. The src-tauri client structs (`src-tauri/src/capture/
//! client.rs`) MUST mirror these byte-for-byte; a cross-crate round-trip test is
//! the gate before any socket code lands (plan §10 risk 1).
#![allow(dead_code)] // in-progress scaffold: the socket loop (5-SF1b) consumes these next.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// True while the replay ring is armed (Phase 2). `#[serde(default)]` keeps the
    /// src-tauri client mirror forward-compatible until it adds the field.
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

/// `id ∈ { record, save_replay, screenshot }`; `trigger_description` is what KDE
/// actually bound (may differ from the requested default — rebindability rule).
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

/// Engine-relevant settings persisted to `iskariel-capture.json` and pushed via
/// `set_config`. camelCase on the wire (the JS side authors the file). Phase-1
/// fields except `replay_length_min` are engine-locked.
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

/// The `saved` event payload (unified contract, plan §4.1). `path` is ALWAYS the
/// final `.mp4`; `started_monotonic_pts_ns` = T0, `last_monotonic_pts_ns` = T_end
/// (bounds the audio cut tail).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrips_flat_verb_form() {
        // The exact wire bytes the src-tauri client must produce.
        let line = r#"{"op":"start_clip","id":"7","args":{}}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        assert_eq!(req.op, "start_clip");
        assert_eq!(req.id, "7");
        let s = serde_json::to_string(&req).unwrap();
        let back: Request = serde_json::from_str(&s).unwrap();
        assert_eq!(back.op, "start_clip");
        assert_eq!(back.id, "7");
    }

    #[test]
    fn response_omits_none_fields() {
        let ok = Response { id: "1".into(), ok: true, data: None, error: None };
        let s = serde_json::to_string(&ok).unwrap();
        assert_eq!(s, r#"{"id":"1","ok":true}"#);
    }

    #[test]
    fn config_uses_camelcase_on_the_wire() {
        let cfg = CaptureConfig::default();
        let s = serde_json::to_string(&cfg).unwrap();
        assert!(s.contains(r#""replayLengthMin":5"#));
        assert!(s.contains(r#""bitrateMbps":50"#));
        assert!(s.contains(r#""sampleRate":48000"#));
        let back: CaptureConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.replay_length_min, 5);
        assert_eq!(back.audio.sample_rate, 48_000);
    }
}
