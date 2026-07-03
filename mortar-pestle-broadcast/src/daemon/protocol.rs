//! Frozen NDJSON wire protocol — the repo's obs-websocket-shaped envelope
//! (capture/stt precedent). The app side keeps its own MIT mirror of these
//! shapes in `src-tauri/src/broadcast/client.rs`; changes are made twice,
//! never shared (license boundary — see README).
//!
//! Op vocabulary: SP1 — `hello`, `get_state`, `create_scene`, `remove_scene`,
//! `set_current_scene`, `create_source`, `remove_source`,
//! `set_source_settings`, `start_record`, `stop_record`, `shutdown`.
//! SP2 — `display_create` {id, hwnd:u64, width, height},
//! `display_resize` {id, width, height}, `display_destroy` {id} (idempotent).
//! Display verbs are ephemeral: no collection autosave, no state_changed push,
//! and displays never appear in [`StateSnapshot`].
//!
//! SP3 (proto v2). Scenes stay name-addressed; scene items are id-addressed
//! (`{scene, item:i64}` — ids persist in the collection JSON, so they survive
//! respawn). Wire order of `SceneInfo.sources` = obs_scene_enum_items order,
//! i.e. BOTTOM→TOP of the render stack; group children nest under `children`.
//! Mutating (finish: autosave + state push): `rename_scene`, `rename_item`,
//! `duplicate_scene`, `reorder_scenes`, `remove_item`, `set_item_visible`,
//! `set_item_locked`, `reorder_items`, `create_group`, `ungroup`,
//! `create_source` (extended: transform/crop/visible/locked; auto-suffixes
//! colliding names, replies {item,name}), `add_existing`, `transform_commit`,
//! `set_source_settings` (extended: replace flag).
//! Ephemeral (no save/push): `set_transform` (pointer-rate), `select_item`,
//! `hover_item`, `set_snap_guides`, `get_source_settings`, `get_properties`,
//! `click_property_button`, `list_input_types`, `screenshot` (base64 PNG,
//! width clamped ≤ 640 to stay under the 1 MiB line caps), `picker_open` /
//! `picker_close` (temp monitor sources for live thumbs),
//! `load_browser_module` (CEF late-load, idempotent).

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
    /// Base compositing canvas — the coordinate space of every transform,
    /// crop, and corner below. The UI's px↔canvas mapper reads this instead
    /// of hardcoding 1920×1080.
    pub canvas: CanvasInfo,
    pub scenes: Vec<SceneInfo>,
    pub recording: RecordingInfo,
    pub obs_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ProtoError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CanvasInfo {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SceneInfo {
    pub name: String,
    /// obs_scene_enum_items order = BOTTOM→TOP of the render stack. The UI
    /// reverses for top-first display in exactly one adapter.
    pub sources: Vec<SourceInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    /// Scene-item id — stable per scene, persists in the collection JSON.
    /// The addressing key for every item verb.
    pub item_id: i64,
    pub name: String,
    /// libobs source type id (e.g. "monitor_capture").
    pub id: String,
    /// Live source dimensions — 0×0 until the source delivers its first frame
    /// (the "has it ever produced a frame" diagnostic; the UI derives the
    /// game-capture hooked/waiting badge from this).
    pub width: u32,
    pub height: u32,
    /// Activation diagnostics: `showing` gates every capture source's init
    /// (duplicator tick returns early when false), `active` = on program.
    pub showing: bool,
    pub active: bool,
    /// Scene-item flags (v2). `selected` mirrors obs_sceneitem_selected so a
    /// respawned engine reconciles the UI selection for free.
    pub visible: bool,
    pub locked: bool,
    pub selected: bool,
    pub is_group: bool,
    pub is_scene: bool,
    pub transform: Transform,
    pub crop: Crop,
    /// Item box corners in canvas units (TL, TR, BR, BL) — engine-computed
    /// via obs_sceneitem_get_box_transform so all OBS-derived geometry stays
    /// GPL-side; app hit-testing is generic point-in-quad.
    pub corners: [[f32; 2]; 4],
    /// Group children (empty unless is_group).
    pub children: Vec<SourceInfo>,
}

/// Mirror of obs_transform_info (flattened vec2s).
#[derive(Debug, Clone, Serialize)]
pub struct Transform {
    pub pos_x: f32,
    pub pos_y: f32,
    pub rot: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub alignment: u32,
    pub bounds_type: i32,
    pub bounds_alignment: u32,
    pub bounds_x: f32,
    pub bounds_y: f32,
    pub crop_to_bounds: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Crop {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingInfo {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub elapsed_ns: u64,
}

pub const PROTO_VERSION: u32 = 2;
