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
//!
//! SP4 (proto v3) — recording & replay. Output config's persistence-of-record
//! is the engine-side OBS-format profile (`profiles/Default/basic.ini`); the
//! app never parses the INI, it goes through these ops:
//! `get_output_settings` → `{profile: {section: {key: value}}}` (strings,
//! disk truth); `set_output_settings` {patch: same shape} — `[Video]` keys
//! apply via obs_reset_video ONLY when fully idle (else `busy`);
//! `list_encoders` → {encoders: [{id, display_name, codec}]};
//! `get_encoder_properties` {encoder_id} → {props, settings} (PropSpec wire
//! shape, same renderer as source properties); `set_encoder_settings`
//! {encoder_id, settings} → merged into recordEncoder.json.
//! `pause_record` {paused}, `split_record` (manual split; muxer proc),
//! `start_replay` / `stop_replay` (arm/disarm the replay_buffer output),
//! `save_replay` (proc "save"; completion arrives as the `replay_saved`
//! {path} event). New events: `replay_saved` {path}; `saved` gains
//! `auto_remux: bool`. Snapshot: `recording.paused`, `replay.armed`,
//! `caps.encoders` (boot-enumerated video encoder types).
//!
//! SP5 (proto v4) — streaming. The service is persisted engine-side in OBS's
//! own `service.json` beside `basic.ini`, and the engine keeps its body
//! OPAQUE (`{type, settings}`) so new destination types are additive:
//! `get_stream_services` → the raw rtmp-services catalog;
//! `get_stream_service` → `{type, settings}` or `null` when unconfigured;
//! `set_stream_service` {service}. Snapshot gains `stream: StreamInfo` — a
//! SUB-STRUCT, because streaming is concurrent with recording and the
//! top-level `state` enum cannot express two activities at once. Every later
//! SP5 addition is additive (new fields, serde defaults) — no second bump.

//! SP6 (proto v5) — audio mixer. Snapshot gains `audio: AudioInfo`, a third
//! orthogonal sub-struct (audio state is concurrent with recording AND
//! streaming). Mutating ops: `set_volume` {source, deflection}, `set_mute`,
//! `set_monitoring`, `set_balance`, `set_mono`, `set_sync_offset`,
//! `set_tracks` {source, mask}, `set_global_slot` {channel, device_id},
//! `set_monitoring_device`, `add_filter`, `remove_filter`, `reorder_filter`,
//! `set_filter_enabled`. Ephemeral: `subscribe_meters` {on},
//! `list_audio_devices` {kind}, `list_filter_types` {kind},
//! `get_filter_properties`, `set_filter_settings`.
//!
//! New event `meters` — the ONLY high-rate frame on the wire. One event per
//! tick carrying EVERY subscribed source (never one event per source per
//! volmeter callback), 30 Hz, and nothing at all while unsubscribed. Values
//! are dB, already mapped by libobs's volmeter.
//!
//! Fader travel is libobs's own `obs_fader_t` on OBS_FADER_CUBIC — deflection
//! is computed engine-side by the same code OBS's own UI uses, so "matches
//! OBS's curve" is true by construction rather than by a ported formula.

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
    pub replay: ReplayInfo,
    pub stream: StreamInfo,
    pub audio: AudioInfo,
    pub caps: CapsInfo,
    pub obs_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ProtoError>,
}

/// Replay-buffer arm state — orthogonal to `state` (a replay can be armed
/// while idle OR recording; the shared encoder session serves both).
#[derive(Debug, Clone, Serialize)]
pub struct ReplayInfo {
    pub armed: bool,
}

/// Boot-enumerated engine capabilities (SF1 accept: caps reflect in
/// get_state). Video encoder types only; audio is ffmpeg_aac by decision.
#[derive(Debug, Clone, Serialize)]
pub struct CapsInfo {
    pub encoders: Vec<EncoderInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EncoderInfo {
    /// libobs encoder type id (e.g. "obs_x264", "jim_nvenc").
    pub id: String,
    pub display_name: String,
    /// Codec name as libobs reports it (h264 / hevc / av1).
    pub codec: String,
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

/// Streaming status (SP5) — orthogonal to BOTH `state` and `recording`. A
/// stream runs concurrently with a recording, so this is a sub-struct and the
/// top-level `state` enum is deliberately untouched: one enum cannot hold two
/// simultaneous activities.
#[derive(Debug, Clone, Serialize)]
pub struct StreamInfo {
    /// idle | connecting | live | reconnecting | stopping | error
    pub status: String,
    pub elapsed_ns: u64,
    /// Human-mapped `OBS_OUTPUT_*` stop code, when the stream died badly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Successful reconnects this session (uptime does NOT reset across one).
    pub reconnects: u32,
}

impl StreamInfo {
    pub fn idle() -> Self {
        StreamInfo { status: "idle".into(), elapsed_ns: 0, error: None, reconnects: 0 }
    }
}

/// Audio half of the snapshot (SP6) — orthogonal to `state`, `recording` AND
/// `stream`: levels and routing are live regardless of what is running.
#[derive(Debug, Clone, Serialize)]
pub struct AudioInfo {
    /// Global monitoring output device (obs_get_audio_monitoring_device).
    /// `None` = "Default".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitoring_device: Option<DeviceRef>,
    /// libobs's six global output channels, ALWAYS six entries (channel 1..6),
    /// empty `source` where the slot is unassigned. Fixed length so the UI
    /// renders six rows without inventing placeholders.
    pub globals: Vec<GlobalSlot>,
    /// Mixer rows: the assigned globals (which survive scene switches) plus
    /// every audio-capable source in the CURRENT scene. OBS parity.
    pub sources: Vec<AudioSourceInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlobalSlot {
    /// 1..=6, matching obs_set_output_source's channel argument.
    pub channel: u32,
    /// Assigned source name, or `None` for an empty slot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// libobs input type id backing the slot (wasapi_output_capture etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
}

/// One mixer row. Name-addressed like scenes (audio sources are unique by
/// name in libobs), NOT item-addressed — the same source can appear in many
/// scenes but has exactly ONE set of audio settings.
#[derive(Debug, Clone, Serialize)]
pub struct AudioSourceInfo {
    pub name: String,
    /// libobs source type id.
    pub id: String,
    /// True for channels 1..6 — pinned in the mixer across scene switches.
    pub is_global: bool,
    pub volume_db: f32,
    /// 0..1 fader position from libobs's own cubic fader. The UI never
    /// computes the curve.
    pub deflection: f32,
    pub muted: bool,
    /// none | monitor_only | monitor_and_output
    pub monitoring: String,
    /// 0..1, 0.5 = centre.
    pub balance: f32,
    pub mono: bool,
    pub sync_offset_ms: i64,
    /// 6-bit mixer mask (bit 0 = track 1).
    pub tracks: u32,
    /// 1 = mono, 2 = stereo — how many meter bars the row draws.
    pub channels: u32,
    /// Ordered; engine order IS signal order.
    pub filters: Vec<FilterInfo>,
    /// Push-to-talk / push-to-mute, when bound.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ptt: Option<PttInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilterInfo {
    pub name: String,
    /// libobs filter type id (e.g. "noise_suppress_filter").
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PttInfo {
    /// ptt | ptm
    pub mode: String,
    /// Human bind string, e.g. "Ctrl+Alt+V" (the winhook's own format).
    pub bind: String,
    pub press_delay_ms: u32,
    pub release_delay_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingInfo {
    pub active: bool,
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Pause-adjusted: wall time minus accumulated pause spans.
    pub elapsed_ns: u64,
}

pub const PROTO_VERSION: u32 = 5;
