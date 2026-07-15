//! 2-WAY shared NDJSON wire envelope (capture + stt ONLY — broadcast EXCLUDED).
//! Byte-identical to `mortar-pestle-capture/src/daemon/protocol.rs:16-53` and
//! `mortar-pestle-stt/src/protocol.rs:23-58` (same derives, fields, serde attrs,
//! String id). Re-exported by each sidecar's `protocol.rs` via
//! `pub use mortar_pestle_daemon::envelope::{Request, Response, Event, ProtoError};`
//! — wire bytes are unchanged (serde derive macros generate code from the struct
//! definition, not the crate location). Payload structs stay per-sidecar.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub op: String,
    pub id: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtoError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub event: String,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtoError {
    pub code: String,
    pub message: String,
}

impl ProtoError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        ProtoError {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}