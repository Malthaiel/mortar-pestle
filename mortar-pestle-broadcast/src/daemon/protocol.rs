//! Frozen NDJSON wire protocol — the repo's obs-websocket-shaped envelope
//! (capture/stt precedent). The app side keeps its own MIT mirror of these
//! shapes in `src-tauri/src/broadcast/client.rs`; changes are made twice,
//! never shared (license boundary — see README).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub op: String,
    pub id: u64,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtoError>,
}

impl Response {
    pub fn ok(id: u64, data: Value) -> Self {
        Response { id, ok: true, data: Some(data), error: None }
    }
    pub fn err(id: u64, error: ProtoError) -> Self {
        Response { id, ok: false, data: None, error: Some(error) }
    }
}

/// Unsolicited: `state_changed` (data = StateSnapshot), `saved` (data =
/// {path}), `error` (data = ProtoError).
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub event: String,
    pub data: Value,
}

/// code ∈ {not_implemented, bad_request, busy, internal} (capture precedent).
#[derive(Debug, Clone, Serialize)]
pub struct ProtoError {
    pub code: String,
    pub message: String,
}

impl ProtoError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        ProtoError { code: "bad_request".into(), message: msg.into() }
    }
    pub fn busy(msg: impl Into<String>) -> Self {
        ProtoError { code: "busy".into(), message: msg.into() }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        ProtoError { code: "internal".into(), message: msg.into() }
    }
}

/// The sole UI truth (Overview cross-cutting contract #1).
#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct SceneInfo {
    pub name: String,
    pub sources: Vec<SourceInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub name: String,
    /// libobs source type id (e.g. "monitor_capture").
    pub id: String,
    /// Live source dimensions — 0×0 until the source delivers its first frame
    /// (the "has it ever produced a frame" diagnostic).
    pub width: u32,
    pub height: u32,
    /// Activation diagnostics: `showing` gates every capture source's init
    /// (duplicator tick returns early when false), `active` = on program.
    pub showing: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingInfo {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub elapsed_ns: u64,
}

pub const PROTO_VERSION: u32 = 1;
