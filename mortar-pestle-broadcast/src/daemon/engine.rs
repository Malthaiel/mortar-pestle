//! The engine thread: owns every libobs object and is the ONLY thread that
//! calls `obs_*` after init. Socket tasks send [`Cmd`]s over a std mpsc and
//! await tokio oneshot replies; state pushes go out on the tokio broadcast
//! bus as `state_changed` events (capture daemon architecture, third
//! instance).
//!
//! GPL corpus â€” record-pipeline semantics ported from the OBS frontend's
//! basic output handler (reference clone, tag 32.1.2).

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};

use crate::bindings as ffi;
use crate::daemon::meters;
use crate::daemon::namer;
use crate::daemon::profile::{record_encoder_path, service_path, Profile};
use crate::daemon::protocol::{
    AudioInfo, AudioSourceInfo, CanvasInfo, CapsInfo, Crop, DeviceRef, EncoderInfo, Event,
    FilterInfo, GlobalSlot, ProtoError, RecordingInfo, ReplayInfo, SceneInfo, SourceInfo,
    StateSnapshot, StreamInfo, Transform, PROTO_VERSION,
};
use crate::obs::overlay::{self, M4};
use crate::obs::{app_config_dir, screenshot, ObsCore, VideoCfg};

pub type Reply = oneshot::Sender<Result<Value, ProtoError>>;

pub enum Cmd {
    GetState(Reply),
    CreateScene { name: String, reply: Reply },
    RemoveScene { name: String, reply: Reply },
    SetCurrentScene { name: String, reply: Reply },
    CreateSource {
        scene: String,
        id: String,
        name: String,
        settings: Value,
        transform: Value,
        crop: Value,
        visible: Option<bool>,
        locked: Option<bool>,
        reply: Reply,
    },
    RemoveSource { scene: String, name: String, reply: Reply },
    SetSourceSettings { scene: String, name: String, settings: Value, replace: bool, reply: Reply },
    StartRecord { dir: Option<String>, stem: Option<String>, reply: Reply },
    StopRecord { reply: Reply },
    DisplayCreate { id: String, hwnd: u64, width: u32, height: u32, reply: Reply },
    DisplayResize { id: String, width: u32, height: u32, reply: Reply },
    DisplayDestroy { id: String, reply: Reply },
    // --- SP3 mutating (finish) ---
    RenameScene { name: String, new_name: String, reply: Reply },
    RenameItem { scene: String, item: i64, new_name: String, reply: Reply },
    DuplicateScene { name: String, reply: Reply },
    ReorderScenes { order: Vec<String>, reply: Reply },
    RemoveItem { scene: String, item: i64, reply: Reply },
    SetItemVisible { scene: String, item: i64, visible: bool, reply: Reply },
    SetItemLocked { scene: String, item: i64, locked: bool, reply: Reply },
    ReorderItems { scene: String, order: Vec<(i64, Option<i64>)>, reply: Reply },
    CreateGroup { scene: String, name: String, reply: Reply },
    Ungroup { scene: String, item: i64, reply: Reply },
    AddExisting { scene: String, source_name: String, reply: Reply },
    TransformCommit { scene: String, item: i64, transform: Value, crop: Value, reply: Reply },
    // --- SP3 ephemeral (finish_ephemeral) ---
    SetTransform { scene: String, item: i64, transform: Value, crop: Value, reply: Reply },
    SelectItem { scene: String, item: Option<i64>, reply: Reply },
    HoverItem { scene: Option<String>, item: Option<i64>, reply: Reply },
    SetSnapGuides { guides: Vec<(u8, f32)>, reply: Reply },
    GetSourceSettings { scene: String, item: i64, reply: Reply },
    GetProperties { scene: String, item: i64, reply: Reply },
    ClickPropertyButton { scene: String, item: i64, prop: String, reply: Reply },
    ListInputTypes { reply: Reply },
    /// SP6 SF3 â€” device choices for a global-slot or monitoring picker.
    ListAudioDevices { kind: String, reply: Reply },
    // --- SP4 output config (ephemeral reads; set_output_settings pushes state) ---
    ListEncoders { reply: Reply },
    GetOutputSettings { reply: Reply },
    SetOutputSettings { patch: Value, reply: Reply },
    GetEncoderProperties { encoder_id: String, reply: Reply },
    SetEncoderSettings { settings: Value, reply: Reply },
    Screenshot { scene: Option<String>, item: Option<i64>, picker: Option<String>, width: u32, reply: Reply },
    PickerOpen { kind: String, reply: Reply },
    PickerClose { reply: Reply },
    LoadBrowserModule { reply: Reply },
    // --- SP4 record/replay verbs ---
    PauseRecord { paused: bool, reply: Reply },
    SplitRecord { reply: Reply },
    /// INTERNAL: posted by the muxer's file_changed signal callback (split
    /// rollover) â€” never arrives from the socket, carries no reply.
    FileChanged { path: String },
    // --- SP4 replay-buffer verbs (S3) ---
    StartReplay { reply: Reply },
    StopReplay { reply: Reply },
    SaveReplay { reply: Reply },
    /// INTERNAL: posted by the replay output's `saved` signal callback â€” never
    /// arrives from the socket, carries no reply.
    ReplaySaved,
    // --- SP5 streaming: service model (SF1) ---
    GetStreamServices { reply: Reply },
    GetStreamService { reply: Reply },
    SetStreamService { service: Value, reply: Reply },
    // --- SP5 streaming: go live (SF2) ---
    StartStream { reply: Reply },
    StopStream { reply: Reply },
    GetStreamStats { reply: Reply },
    /// INTERNAL: posted by the stream output's signal callbacks â€” never
    /// arrives from the socket, carries no reply. `code` is meaningful only
    /// for `stop`, where it is an `OBS_OUTPUT_*` value.
    StreamSignal { kind: &'static str, code: i64 },
    // --- SP6 audio mixer ---
    SetVolume { source: String, level: VolumeLevel, reply: Reply },
    SetMute { source: String, muted: bool, reply: Reply },
    SetMonitoring { source: String, kind: String, reply: Reply },
    SetBalance { source: String, balance: f32, reply: Reply },
    SetMono { source: String, mono: bool, reply: Reply },
    SetSyncOffset { source: String, ms: i64, reply: Reply },
    SetTracks { source: String, mask: u32, reply: Reply },
    SetGlobalSlot { channel: u32, input_id: String, device_id: String, reply: Reply },
    SetMonitoringDevice { id: String, name: String, reply: Reply },
    /// Ephemeral: gates the high-rate `meters` event. Not persisted - a
    /// respawned engine starts unsubscribed and the app re-subscribes on its
    /// alive edge, exactly like displays.
    SubscribeMeters { on: bool, reply: Reply },
    // --- SP6 SF4 filter stack ---
    AddFilter { source: String, id: String, name: String, reply: Reply },
    RemoveFilter { source: String, name: String, reply: Reply },
    ReorderFilter { source: String, name: String, index: usize, reply: Reply },
    SetFilterEnabled { source: String, name: String, on: bool, reply: Reply },
    /// Ephemeral: the add-picker's menu. Types are fixed for the process life,
    /// but cheap enough to enumerate on demand rather than cache.
    ListFilterTypes { kind: String, reply: Reply },
    GetFilterProperties { source: String, name: String, reply: Reply },
    SetFilterSettings { source: String, name: String, settings: Value, replace: bool, reply: Reply },
    Shutdown { reply: Reply },
}

/// Signal-callback context: libobs signals fire on output/muxer threads,
/// which may ONLY post back to the engine thread â€” never call obs_* there.
struct SignalCtx {
    tx: mpsc::Sender<Cmd>,
}

/// `file_changed(string next_file)` â€” ffmpeg_muxer mux.c:104, mp4_output
/// mp4-output.c:333 (verified both, OBS 32.1.2).
unsafe extern "C" fn on_file_changed(param: *mut std::ffi::c_void, cd: *mut ffi::calldata_t) {
    unsafe {
        let ctx = &*(param as *const SignalCtx);
        let key = c"next_file";
        let mut s: *const std::os::raw::c_char = std::ptr::null();
        if ffi::calldata_get_string(cd, key.as_ptr(), &mut s) && !s.is_null() {
            let path = CStr::from_ptr(s).to_string_lossy().into_owned();
            let _ = ctx.tx.send(Cmd::FileChanged { path });
        }
    }
}

/// `saved()` (no params) â€” the replay_buffer output emits it after a buffer
/// write completes. The path is fetched via the `get_last_replay` proc back
/// on the engine thread (post a Cmd; never call obs_* on the signal thread).
unsafe extern "C" fn on_replay_saved(param: *mut std::ffi::c_void, _cd: *mut ffi::calldata_t) {
    unsafe {
        let ctx = &*(param as *const SignalCtx);
        let _ = ctx.tx.send(Cmd::ReplaySaved);
    }
}

/// The stream output's six lifecycle signals. All share one [`SignalCtx`] and
/// do nothing but post the kind back to the engine thread, which owns every
/// transition â€” libobs fires these on the output/network thread.
unsafe fn post_stream(param: *mut std::ffi::c_void, kind: &'static str, code: i64) {
    unsafe {
        let ctx = &*(param as *const SignalCtx);
        let _ = ctx.tx.send(Cmd::StreamSignal { kind, code });
    }
}

unsafe extern "C" fn on_stream_starting(p: *mut std::ffi::c_void, _cd: *mut ffi::calldata_t) {
    unsafe { post_stream(p, "starting", 0) }
}
unsafe extern "C" fn on_stream_start(p: *mut std::ffi::c_void, _cd: *mut ffi::calldata_t) {
    unsafe { post_stream(p, "start", 0) }
}
unsafe extern "C" fn on_stream_stopping(p: *mut std::ffi::c_void, _cd: *mut ffi::calldata_t) {
    unsafe { post_stream(p, "stopping", 0) }
}
unsafe extern "C" fn on_stream_reconnect(p: *mut std::ffi::c_void, _cd: *mut ffi::calldata_t) {
    unsafe { post_stream(p, "reconnect", 0) }
}
unsafe extern "C" fn on_stream_reconnect_success(p: *mut std::ffi::c_void, _cd: *mut ffi::calldata_t) {
    unsafe { post_stream(p, "reconnect_success", 0) }
}

/// `stop(ptr output, int code)` â€” obs.h:6827. `calldata_get_int` is a static
/// inline bindgen skips; it is exactly this read of the `long long` slot.
unsafe extern "C" fn on_stream_stop(p: *mut std::ffi::c_void, cd: *mut ffi::calldata_t) {
    unsafe {
        let mut code: i64 = 0;
        ffi::calldata_get_data(
            cd,
            c"code".as_ptr(),
            &mut code as *mut i64 as *mut std::ffi::c_void,
            std::mem::size_of::<i64>(),
        );
        post_stream(p, "stop", code);
    }
}

/// (signal name, callback) â€” connected in `start_stream`, disconnected in
/// `release_stream`. One table so the two loops can never drift apart.
const STREAM_SIGNALS: [(&CStr, ffi::signal_callback_t); 6] = [
    (c"starting", Some(on_stream_starting)),
    (c"start", Some(on_stream_start)),
    (c"stopping", Some(on_stream_stopping)),
    (c"stop", Some(on_stream_stop)),
    (c"reconnect", Some(on_stream_reconnect)),
    (c"reconnect_success", Some(on_stream_reconnect_success)),
];

/// Disconnect the signals, then drop every libobs handle the run owns. A free
/// function, not a method, so it can be called while `self.stream` is taken.
///
/// SAFETY: the output must already be inactive (or never started).
unsafe fn release_stream(run: StreamRun) {
    unsafe {
        if !run.sig_ctx.is_null() {
            let sh = ffi::obs_output_get_signal_handler(run.output);
            if !sh.is_null() {
                for (name, cb) in STREAM_SIGNALS {
                    ffi::signal_handler_disconnect(sh, name.as_ptr(), cb, run.sig_ctx as *mut std::ffi::c_void);
                }
            }
            drop(Box::from_raw(run.sig_ctx));
        }
        ffi::obs_output_release(run.output);
        ffi::obs_service_release(run.service);
        ffi::obs_encoder_release(run.venc);
        ffi::obs_encoder_release(run.aenc);
    }
}

/// `OBS_OUTPUT_*` stop codes â†’ something a human can act on. `SUCCESS` is a
/// clean stop and carries no message.
fn stop_code_message(code: i64) -> Option<String> {
    let msg = match code as i32 {
        0 => return None,
        ffi::OBS_OUTPUT_BAD_PATH => "Bad stream URL or path.",
        ffi::OBS_OUTPUT_CONNECT_FAILED => "Could not reach the streaming server.",
        ffi::OBS_OUTPUT_INVALID_STREAM => "The server rejected the stream key.",
        ffi::OBS_OUTPUT_DISCONNECTED => "Disconnected from the streaming server.",
        ffi::OBS_OUTPUT_UNSUPPORTED => "The server does not support this codec or format.",
        ffi::OBS_OUTPUT_NO_SPACE => "Out of disk space.",
        ffi::OBS_OUTPUT_ENCODE_ERROR => "The encoder failed.",
        ffi::OBS_OUTPUT_HDR_DISABLED => "HDR is not supported by this service.",
        _ => "The stream stopped unexpectedly.",
    };
    Some(format!("{msg} (code {code})"))
}

struct RecordingRun {
    output: *mut ffi::obs_output,
    path: String,
    started: Instant,
    paused_at: Option<Instant>,
    paused_total: Duration,
    /// file_changed signal context (Box::into_raw) â€” disconnected + reboxed
    /// in stop_record. Null if the connect was skipped.
    sig_ctx: *mut SignalCtx,
}

impl RecordingRun {
    /// Wall time minus accumulated (and in-flight) pause spans.
    fn elapsed(&self) -> Duration {
        let gross = self.started.elapsed();
        let paused = self.paused_total + self.paused_at.map_or(Duration::ZERO, |t| t.elapsed());
        gross.saturating_sub(paused)
    }
}

/// One encode session shared by every output (record + replay) â€” the OBS
/// SimpleOutput model. Doubling a 1080p60 encode for a second output is the
/// failure this prevents; the honest consequence (surfaced in the UI) is that
/// encoder/video settings are locked while ANY consumer is active.
struct EncoderSet {
    venc: *mut ffi::obs_encoder,
    /// (mixer/track index, encoder) â€” one ffmpeg_aac per enabled RecTracks bit.
    aencs: Vec<(u32, *mut ffi::obs_encoder)>,
}

/// The armed replay buffer (S3): a `replay_buffer` output feeding the shared
/// [`EncoderSet`]. Present â‡’ `replay_armed()`; dropped on stop_replay/teardown.
struct ReplayRun {
    output: *mut ffi::obs_output,
    /// `saved` signal context (Box::into_raw) â€” disconnected + reboxed in
    /// stop_replay. Null if the connect was skipped.
    sig_ctx: *mut SignalCtx,
}

/// A connecting/live stream (SP5 SF2). Route A: it owns its OWN CBR encoder
/// pair, deliberately outside the shared record [`EncoderSet`], so a recording
/// keeps its CRF quality while the stream runs at the service's bitrate. The
/// cost â€” two encode sessions when both run â€” is the accepted trade (Ledger L7).
struct StreamRun {
    output: *mut ffi::obs_output,
    service: *mut ffi::obs_service,
    venc: *mut ffi::obs_encoder,
    aenc: *mut ffi::obs_encoder,
    /// Set on the `start` signal â€” uptime counts from when libobs said live,
    /// and is deliberately NOT reset by a reconnect.
    started: Option<Instant>,
    /// connecting | live | reconnecting | stopping
    status: &'static str,
    reconnects: u32,
    /// Shared by all six signal connects (Box::into_raw) â€” disconnected and
    /// reboxed exactly once, in `release_stream`.
    sig_ctx: *mut SignalCtx,
}

struct Engine {
    core: ObsCore,
    /// (name, owned scene ref)
    scenes: Vec<(String, *mut ffi::obs_scene)>,
    current: Option<String>,
    /// (id, display) â€” ephemeral preview swapchains on app-owned HWNDs.
    /// Never persisted, never in StateSnapshot: a respawned engine starts
    /// with zero displays and the app re-creates them on its alive edge.
    displays: Vec<(String, *mut ffi::obs_display_t)>,
    /// Monitor-picker temp sources: (monitor id, label, PRIVATE source ptr).
    /// Private â†’ never saved by obs_save_sources, so the autosave path can't
    /// leak them into the collection. inc_showing held while open (WGC gate).
    picker: Vec<(String, String, *mut ffi::obs_source)>,
    recording: Option<RecordingRun>,
    /// Armed replay buffer, if any (S3). Shares the EncoderSet with recording.
    replay: Option<ReplayRun>,
    /// The live stream (SP5 SF2) â€” concurrent with recording, never folded
    /// into the top-level `state` enum.
    stream: Option<StreamRun>,
    /// Why the last stream died, kept AFTER the run is torn down so an
    /// unsolicited death still surfaces instead of silently reading idle.
    /// Cleared by the next start_stream.
    stream_error: Option<String>,
    finalizing: bool,
    last_error: Option<ProtoError>,
    events: broadcast::Sender<Event>,
    // --- SP4 ---
    profile: Profile,
    encoders: Option<EncoderSet>,
    /// Boot-enumerated video encoder types (h264/hevc/av1) for snapshot caps.
    caps_encoders: Vec<EncoderInfo>,
    /// Self-sender for libobs signal callbacks (they post Cmds, never call obs).
    cmd_tx: mpsc::Sender<Cmd>,
    // --- SP6 audio ---
    /// ONE reusable cubic fader, attached → read/written → detached per source.
    /// libobs's own fader means "matches OBS's curve" holds by construction;
    /// a fader can only hold one source at a time, hence a scratch object
    /// rather than a per-source map.
    scratch_fader: *mut ffi::obs_fader_t,
    /// Live volmeters while subscribed: (source name, volmeter, leaked slot).
    volmeters: Vec<(String, *mut ffi::obs_volmeter_t, *mut meters::Slot)>,
    /// Latest dB frame per source, written by OBS audio threads.
    meter_sink: meters::Sink,
    /// Gate for the ticker thread — false means zero pipe traffic.
    meters_on: Arc<AtomicBool>,
}

fn cstring(s: &str) -> CString {
    // Interior NULs can arrive via protocol JSON; strip them rather than blanking
    // the whole name (unwrap_or_default would) â€” the daemon must never panic.
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

fn collection_path() -> PathBuf {
    app_config_dir().join("scenes").join("default.json")
}

fn scene_order_path() -> PathBuf {
    app_config_dir().join("scenes").join("scene_order.json")
}

fn captures_dir() -> PathBuf {
    if let Ok(d) = std::env::var("MORTAR_PESTLE_CAPTURES_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Videos").join("Mortar & Pestle")
}

#[cfg(windows)]
fn local_timestamp_stem() -> String {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    let mut st = unsafe { std::mem::zeroed::<windows_sys::Win32::Foundation::SYSTEMTIME>() };
    unsafe { GetLocalTime(&mut st) };
    format!(
        "{:04}-{:02}-{:02} {:02}-{:02}-{:02}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
    )
}

/// Spawn the engine thread. Replies with Err(String) via the init channel if
/// libobs fails to come up (the daemon then exits nonzero).
pub fn spawn(
    payload_root: PathBuf,
    cmd_tx: mpsc::Sender<Cmd>,
    cmd_rx: mpsc::Receiver<Cmd>,
    events: broadcast::Sender<Event>,
    init_done: oneshot::Sender<Result<(), String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("obs-engine".into())
        .spawn(move || {
            // Profile before libobs: obs_reset_video geometry comes from it.
            let profile = Profile::load();
            let core = match ObsCore::init(&payload_root, &video_cfg_from(&profile)) {
                Ok(c) => c,
                Err(e) => {
                    let _ = init_done.send(Err(e));
                    return;
                }
            };
            let mut eng = Engine {
                core,
                scenes: Vec::new(),
                current: None,
                displays: Vec::new(),
                picker: Vec::new(),
                recording: None,
                replay: None,
                stream: None,
                stream_error: None,
                finalizing: false,
                last_error: None,
                events,
                profile,
                encoders: None,
                caps_encoders: Vec::new(),
                cmd_tx,
                scratch_fader: unsafe {
                    ffi::obs_fader_create(ffi::obs_fader_type_OBS_FADER_CUBIC)
                },
                volmeters: Vec::new(),
                meter_sink: Arc::new(Mutex::new(HashMap::new())),
                meters_on: Arc::new(AtomicBool::new(false)),
            };
            meters::spawn_ticker(
                eng.meter_sink.clone(),
                eng.meters_on.clone(),
                eng.events.clone(),
            );
            eng.caps_encoders = unsafe { enumerate_encoder_types() };
            eng.load_collection();
            eng.ensure_default_scene();
            eng.restore_global_slots();
            let _ = init_done.send(Ok(()));
            eng.push_state();

            while let Ok(cmd) = cmd_rx.recv() {
                if eng.handle(cmd) {
                    break; // Shutdown
                }
            }
            eng.teardown();
        })
        .expect("spawn obs-engine thread")
}

impl Engine {
    /// Returns true on Shutdown.
    fn handle(&mut self, cmd: Cmd) -> bool {
        match cmd {
            Cmd::GetState(reply) => {
                let _ = reply.send(Ok(serde_json::to_value(self.snapshot()).unwrap()));
            }
            Cmd::CreateScene { name, reply } => {
                let r = self.create_scene(&name);
                self.finish(reply, r);
            }
            Cmd::RemoveScene { name, reply } => {
                let r = self.remove_scene(&name);
                self.finish(reply, r);
            }
            Cmd::SetCurrentScene { name, reply } => {
                let r = self.set_current_scene(&name);
                self.finish(reply, r);
            }
            Cmd::CreateSource { scene, id, name, settings, transform, crop, visible, locked, reply } => {
                let r = self.create_source(&scene, &id, &name, &settings, &transform, &crop, visible, locked);
                self.finish(reply, r);
            }
            Cmd::RemoveSource { scene, name, reply } => {
                let r = self.remove_source(&scene, &name);
                self.finish(reply, r);
            }
            Cmd::SetSourceSettings { scene, name, settings, replace, reply } => {
                let r = self.set_source_settings(&scene, &name, &settings, replace);
                self.finish(reply, r);
            }
            Cmd::RenameScene { name, new_name, reply } => {
                let r = self.rename_scene(&name, &new_name);
                self.finish(reply, r);
            }
            Cmd::RenameItem { scene, item, new_name, reply } => {
                let r = self.rename_item(&scene, item, &new_name);
                self.finish(reply, r);
            }
            Cmd::DuplicateScene { name, reply } => {
                let r = self.duplicate_scene(&name);
                self.finish(reply, r);
            }
            Cmd::ReorderScenes { order, reply } => {
                let r = self.reorder_scenes(&order);
                self.finish(reply, r);
            }
            Cmd::RemoveItem { scene, item, reply } => {
                let r = self.with_item(&scene, item, |it| {
                    unsafe { ffi::obs_sceneitem_remove(it) };
                    Ok(json!({}))
                });
                self.finish(reply, r);
            }
            Cmd::SetItemVisible { scene, item, visible, reply } => {
                let r = self.with_item(&scene, item, |it| {
                    unsafe { ffi::obs_sceneitem_set_visible(it, visible) };
                    Ok(json!({}))
                });
                self.finish(reply, r);
            }
            Cmd::SetItemLocked { scene, item, locked, reply } => {
                let r = self.with_item(&scene, item, |it| {
                    unsafe { ffi::obs_sceneitem_set_locked(it, locked) };
                    Ok(json!({}))
                });
                self.finish(reply, r);
            }
            Cmd::ReorderItems { scene, order, reply } => {
                let r = self.reorder_items(&scene, &order);
                self.finish(reply, r);
            }
            Cmd::CreateGroup { scene, name, reply } => {
                let r = self.create_group(&scene, &name);
                self.finish(reply, r);
            }
            Cmd::Ungroup { scene, item, reply } => {
                let r = self.with_item(&scene, item, |it| unsafe {
                    if !ffi::obs_sceneitem_is_group(it) {
                        return Err(ProtoError::bad_request("item is not a group"));
                    }
                    ffi::obs_sceneitem_group_ungroup(it);
                    Ok(json!({}))
                });
                self.finish(reply, r);
            }
            Cmd::AddExisting { scene, source_name, reply } => {
                let r = self.add_existing(&scene, &source_name);
                self.finish(reply, r);
            }
            Cmd::TransformCommit { scene, item, transform, crop, reply } => {
                let r = self.with_item(&scene, item, |it| {
                    unsafe { apply_transform_patch(it, &transform, &crop) };
                    Ok(json!({}))
                });
                self.finish(reply, r);
            }
            Cmd::SetTransform { scene, item, transform, crop, reply } => {
                let r = self.with_item(&scene, item, |it| {
                    unsafe { apply_transform_patch(it, &transform, &crop) };
                    Ok(json!({}))
                });
                self.finish_ephemeral(reply, r);
            }
            Cmd::SelectItem { scene, item, reply } => {
                let r = self.select_item(&scene, item);
                self.finish_ephemeral(reply, r);
            }
            Cmd::HoverItem { scene, item, reply } => {
                if let Ok(mut st) = overlay::OVERLAY.lock() {
                    st.hover = match (scene, item) {
                        (Some(s), Some(i)) => Some((s, i)),
                        _ => None,
                    };
                }
                self.finish_ephemeral(reply, Ok(json!({})));
            }
            Cmd::SetSnapGuides { guides, reply } => {
                if let Ok(mut st) = overlay::OVERLAY.lock() {
                    st.guides = guides;
                }
                self.finish_ephemeral(reply, Ok(json!({})));
            }
            Cmd::GetSourceSettings { scene, item, reply } => {
                let r = self.get_source_settings(&scene, item);
                self.finish_ephemeral(reply, r);
            }
            Cmd::GetProperties { scene, item, reply } => {
                let r = self.get_properties(&scene, item);
                self.finish_ephemeral(reply, r);
            }
            Cmd::ClickPropertyButton { scene, item, prop, reply } => {
                let r = self.click_property_button(&scene, item, &prop);
                self.finish_ephemeral(reply, r);
            }
            Cmd::ListInputTypes { reply } => {
                let r = self.list_input_types();
                self.finish_ephemeral(reply, r);
            }
            Cmd::ListAudioDevices { kind, reply } => {
                let r = self.list_audio_devices(&kind);
                self.finish_ephemeral(reply, r);
            }
            Cmd::ListEncoders { reply } => {
                let r = Ok(json!({ "encoders": self.caps_encoders }));
                self.finish_ephemeral(reply, r);
            }
            Cmd::GetOutputSettings { reply } => {
                let r = Ok(json!({ "profile": self.profile.to_json() }));
                self.finish_ephemeral(reply, r);
            }
            Cmd::SetOutputSettings { patch, reply } => {
                let r = self.set_output_settings(&patch);
                let ok = r.is_ok();
                self.finish_ephemeral(reply, r);
                if ok {
                    // Video geometry may have moved the canvas â€” full push.
                    self.push_state();
                }
            }
            Cmd::GetEncoderProperties { encoder_id, reply } => {
                let r = self.get_encoder_properties(&encoder_id);
                self.finish_ephemeral(reply, r);
            }
            Cmd::SetEncoderSettings { settings, reply } => {
                let r = self.set_encoder_settings(&settings);
                self.finish_ephemeral(reply, r);
            }
            Cmd::Screenshot { scene, item, picker, width, reply } => {
                let r = self.screenshot(scene.as_deref(), item, picker.as_deref(), width);
                self.finish_ephemeral(reply, r);
            }
            Cmd::PickerOpen { kind, reply } => {
                let r = self.picker_open(&kind);
                self.finish_ephemeral(reply, r);
            }
            Cmd::PickerClose { reply } => {
                self.picker_close();
                self.finish_ephemeral(reply, Ok(json!({})));
            }
            Cmd::LoadBrowserModule { reply } => {
                let r = match self.core.load_browser_module() {
                    Ok(()) => Ok(json!({ "loaded": true })),
                    Err(e) => Ok(json!({ "loaded": false, "error": e })),
                };
                self.finish_ephemeral(reply, r);
            }
            Cmd::StartRecord { dir, stem, reply } => {
                let r = self.start_record(dir.as_deref(), stem.as_deref());
                self.finish(reply, r);
            }
            Cmd::StopRecord { reply } => {
                let r = self.stop_record();
                self.finish(reply, r);
            }
            Cmd::PauseRecord { paused, reply } => {
                let r = self.pause_record(paused);
                let ok = r.is_ok();
                self.finish_ephemeral(reply, r);
                if ok {
                    // Both edges must reach the UI (paused flag + frozen elapsed);
                    // no collection state changed, so skip the autosave.
                    self.push_state();
                }
            }
            Cmd::SplitRecord { reply } => {
                let r = self.split_record();
                self.finish_ephemeral(reply, r);
            }
            Cmd::FileChanged { path } => {
                // Split rollover (muxer thread â†’ posted here). The finished
                // segment is a complete file â€” announce it like a save.
                if let Some(run) = self.recording.as_mut() {
                    let finished = std::mem::replace(&mut run.path, path);
                    let auto_remux = self.profile.get_bool("Video", "AutoRemux", false);
                    let _ = self.events.send(Event {
                        event: "saved".into(),
                        data: json!({ "path": finished, "auto_remux": auto_remux }),
                    });
                    self.push_state();
                }
            }
            Cmd::StartReplay { reply } => {
                let r = self.start_replay();
                let ok = r.is_ok();
                self.finish_ephemeral(reply, r);
                if ok {
                    self.push_state();
                }
            }
            Cmd::StopReplay { reply } => {
                let r = self.stop_replay();
                let ok = r.is_ok();
                self.finish_ephemeral(reply, r);
                if ok {
                    self.push_state();
                }
            }
            Cmd::SaveReplay { reply } => {
                let r = self.save_replay();
                self.finish_ephemeral(reply, r);
            }
            Cmd::ReplaySaved => {
                self.replay_saved();
            }
            Cmd::GetStreamServices { reply } => {
                let r = self.get_stream_services();
                self.finish_ephemeral(reply, r);
            }
            Cmd::GetStreamService { reply } => {
                let r = self.get_stream_service();
                self.finish_ephemeral(reply, r);
            }
            Cmd::SetStreamService { service, reply } => {
                let r = self.set_stream_service(&service);
                self.finish_ephemeral(reply, r);
            }
            Cmd::StartStream { reply } => {
                let r = self.start_stream();
                let ok = r.is_ok();
                self.finish_ephemeral(reply, r);
                if ok {
                    self.push_state();
                }
            }
            Cmd::StopStream { reply } => {
                let r = self.stop_stream();
                self.finish_ephemeral(reply, r);
                self.push_state();
            }
            Cmd::GetStreamStats { reply } => {
                let r = self.get_stream_stats();
                self.finish_ephemeral(reply, r);
            }
            Cmd::StreamSignal { kind, code } => {
                self.on_stream_signal(kind, code);
            }
            Cmd::DisplayCreate { id, hwnd, width, height, reply } => {
                let r = self.display_create(&id, hwnd, width, height);
                self.finish_ephemeral(reply, r);
            }
            Cmd::DisplayResize { id, width, height, reply } => {
                let r = self.display_resize(&id, width, height);
                self.finish_ephemeral(reply, r);
            }
            Cmd::DisplayDestroy { id, reply } => {
                let r = self.display_destroy(&id);
                self.finish_ephemeral(reply, r);
            }
            // --- SP6 audio mixer ---
            Cmd::SetVolume { source, level, reply } => {
                let r = self.set_volume(&source, level);
                self.finish(reply, r);
            }
            Cmd::SetMute { source, muted, reply } => {
                let r = self.set_mute(&source, muted);
                self.finish(reply, r);
            }
            Cmd::SetMonitoring { source, kind, reply } => {
                let r = self.set_monitoring(&source, &kind);
                self.finish(reply, r);
            }
            Cmd::SetBalance { source, balance, reply } => {
                let r = self.set_balance(&source, balance);
                self.finish(reply, r);
            }
            Cmd::SetMono { source, mono, reply } => {
                let r = self.set_mono(&source, mono);
                self.finish(reply, r);
            }
            Cmd::SetSyncOffset { source, ms, reply } => {
                let r = self.set_sync_offset(&source, ms);
                self.finish(reply, r);
            }
            Cmd::SetTracks { source, mask, reply } => {
                let r = self.set_tracks(&source, mask);
                self.finish(reply, r);
            }
            Cmd::SetGlobalSlot { channel, input_id, device_id, reply } => {
                let r = self.set_global_slot(channel, &input_id, &device_id);
                self.finish(reply, r);
            }
            Cmd::SetMonitoringDevice { id, name, reply } => {
                let r = self.set_monitoring_device(&id, &name);
                self.finish(reply, r);
            }
            Cmd::SubscribeMeters { on, reply } => {
                let r = self.subscribe_meters(on);
                self.finish_ephemeral(reply, r);
            }
            Cmd::AddFilter { source, id, name, reply } => {
                let r = self.add_filter(&source, &id, &name);
                self.finish(reply, r);
            }
            Cmd::RemoveFilter { source, name, reply } => {
                let r = self.remove_filter(&source, &name);
                self.finish(reply, r);
            }
            Cmd::ReorderFilter { source, name, index, reply } => {
                let r = self.reorder_filter(&source, &name, index);
                self.finish(reply, r);
            }
            Cmd::SetFilterEnabled { source, name, on, reply } => {
                let r = self.set_filter_enabled(&source, &name, on);
                self.finish(reply, r);
            }
            Cmd::ListFilterTypes { kind, reply } => {
                let r = self.list_filter_types(&kind);
                self.finish_ephemeral(reply, r);
            }
            Cmd::GetFilterProperties { source, name, reply } => {
                let r = self.get_filter_properties(&source, &name);
                self.finish_ephemeral(reply, r);
            }
            Cmd::SetFilterSettings { source, name, settings, replace, reply } => {
                let r = self.set_filter_settings(&source, &name, &settings, replace);
                self.finish(reply, r);
            }
            Cmd::Shutdown { reply } => {
                let _ = reply.send(Ok(json!({})));
                return true;
            }
        }
        false
    }

    /// Reply + autosave + state push for mutating verbs.
    fn finish(&mut self, reply: Reply, r: Result<Value, ProtoError>) {
        if let Err(e) = &r {
            self.last_error = Some(e.clone());
            let _ = self.events.send(Event {
                event: "error".into(),
                data: serde_json::to_value(e).unwrap(),
            });
        }
        let _ = reply.send(r);
        self.save_collection();
        self.push_state();
    }

    /// `finish` minus autosave/state-push, for verbs that touch no collection
    /// state â€” display_resize arrives at rAF rate during layout drags; the
    /// full path would rewrite the collection JSON and spam identical
    /// state_changed events dozens of times per second.
    fn finish_ephemeral(&mut self, reply: Reply, r: Result<Value, ProtoError>) {
        if let Err(e) = &r {
            self.last_error = Some(e.clone());
            let _ = self.events.send(Event {
                event: "error".into(),
                data: serde_json::to_value(e).unwrap(),
            });
        }
        let _ = reply.send(r);
    }

    fn push_state(&self) {
        let _ = self.events.send(Event {
            event: "state_changed".into(),
            data: serde_json::to_value(self.snapshot()).unwrap(),
        });
    }

    fn snapshot(&self) -> StateSnapshot {
        let scenes = self
            .scenes
            .iter()
            .map(|(name, scene)| SceneInfo {
                name: name.clone(),
                sources: unsafe { enum_scene_sources(*scene) },
            })
            .collect();
        let idle_rec = || RecordingInfo { active: false, paused: false, path: None, elapsed_ns: 0 };
        let (state, rec) = match (&self.recording, self.finalizing) {
            (Some(run), _) => (
                "recording",
                RecordingInfo {
                    active: true,
                    paused: run.paused_at.is_some(),
                    path: Some(run.path.clone()),
                    elapsed_ns: run.elapsed().as_nanos() as u64,
                },
            ),
            (None, true) => ("finalizing", idle_rec()),
            (None, false) => (
                if self.last_error.is_some() { "error" } else { "idle" },
                idle_rec(),
            ),
        };
        let (cw, ch) = self.canvas_size();
        StateSnapshot {
            version: PROTO_VERSION,
            state: state.into(),
            current_scene: self.current.clone(),
            canvas: CanvasInfo { width: cw, height: ch },
            scenes,
            recording: rec,
            replay: ReplayInfo { armed: self.replay_armed() },
            stream: self.stream_info(),
            audio: self.audio_info(),
            caps: CapsInfo { encoders: self.caps_encoders.clone() },
            obs_version: self.core.version_string(),
            last_error: self.last_error.clone(),
        }
    }

    /// Armed â‡” a live `replay_buffer` output exists. Gates the shared-encoder
    /// idle drop and the output-settings lock.
    // --- audio (SP6) --------------------------------------------------------

    /// Mixer rows, OBS parity: the six global channels (which survive scene
    /// switches) followed by every audio-capable source in the CURRENT scene.
    /// Name-addressed - one source has exactly ONE set of audio settings no
    /// matter how many scenes hold it.
    fn audio_source_names(&self) -> Vec<(String, bool)> {
        let mut out: Vec<(String, bool)> = Vec::new();
        unsafe {
            for ch in 1..=6u32 {
                let src = ffi::obs_get_output_source(ch);
                if src.is_null() {
                    continue;
                }
                if let Some(n) = source_name(src) {
                    if !out.iter().any(|(e, _)| *e == n) {
                        out.push((n, true));
                    }
                }
                ffi::obs_source_release(src);
            }
            if let Some(scene) = self.current_scene_ptr() {
                for name in scene_audio_source_names(scene) {
                    if !out.iter().any(|(e, _)| *e == name) {
                        out.push((name, false));
                    }
                }
            }
        }
        out
    }

    fn current_scene_ptr(&self) -> Option<*mut ffi::obs_scene> {
        let cur = self.current.as_ref()?;
        self.scenes.iter().find(|(n, _)| n == cur).map(|(_, s)| *s)
    }

    fn audio_info(&self) -> AudioInfo {
        let globals = (1..=6u32)
            .map(|channel| unsafe {
                let src = ffi::obs_get_output_source(channel);
                if src.is_null() {
                    return GlobalSlot {
                        channel,
                        source: None,
                        input_id: None,
                        device_id: String::new(),
                    };
                }
                let settings = ffi::obs_source_get_settings(src);
                let key = cstring("device_id");
                let device_id = cstr_owned(ffi::obs_data_get_string(settings, key.as_ptr()));
                ffi::obs_data_release(settings);
                let slot = GlobalSlot {
                    channel,
                    source: source_name(src),
                    input_id: source_type_id(src),
                    device_id,
                };
                ffi::obs_source_release(src);
                slot
            })
            .collect();
        let sources = self
            .audio_source_names()
            .into_iter()
            .filter_map(|(name, is_global)| self.audio_source_info(&name, is_global))
            .collect();
        AudioInfo { monitoring_device: monitoring_device(), globals, sources }
    }

    fn audio_source_info(&self, name: &str, is_global: bool) -> Option<AudioSourceInfo> {
        unsafe {
            let c = cstring(name);
            let src = ffi::obs_get_source_by_name(c.as_ptr());
            if src.is_null() {
                return None;
            }
            // Deflection comes from libobs's OWN cubic fader, not a formula of
            // ours - attach, read, detach (one scratch fader serves every row).
            let deflection = if self.scratch_fader.is_null() {
                0.0
            } else {
                ffi::obs_fader_attach_source(self.scratch_fader, src);
                let d = ffi::obs_fader_get_deflection(self.scratch_fader);
                ffi::obs_fader_detach_source(self.scratch_fader);
                d
            };
            let flags = ffi::obs_source_get_flags(src);
            let mono = flags & ffi::OBS_SOURCE_FLAG_FORCE_MONO != 0;
            let info = AudioSourceInfo {
                name: name.to_string(),
                id: source_type_id(src).unwrap_or_default(),
                is_global,
                volume_db: ffi::obs_mul_to_db(ffi::obs_source_get_volume(src)),
                deflection,
                muted: ffi::obs_source_muted(src),
                monitoring: monitoring_name(ffi::obs_source_get_monitoring_type(src)).to_string(),
                balance: ffi::obs_source_get_balance_value(src),
                mono,
                // libobs stores nanoseconds; the wire is ms because that is the
                // unit the OBS dialog shows and the user types.
                sync_offset_ms: ffi::obs_source_get_sync_offset(src) / 1_000_000,
                tracks: ffi::obs_source_get_audio_mixers(src),
                // Bar count only. A force-mono source draws one bar; everything
                // else draws two. ponytail: the true per-source layout needs a
                // live volmeter, and the meter event already carries the real
                // channel count in its array length.
                channels: if mono { 1 } else { 2 },
                filters: enum_filters(src),
                ptt: None, // SF6
            };
            ffi::obs_source_release(src);
            Some(info)
        }
    }

    /// Run `f` against a named source, releasing the ref either way. Every
    /// audio setter routes through here so the release cannot be forgotten in
    /// one of a dozen near-identical bodies.
    fn with_source<F>(&mut self, name: &str, f: F) -> Result<Value, ProtoError>
    where
        F: FnOnce(*mut ffi::obs_source),
    {
        self.with_source_val(name, |src| {
            f(src);
            Ok(json!({}))
        })
    }

    /// `with_source` for ops that answer with DATA rather than an empty ack
    /// (SF4's filter property reads). The resolve-and-release contract lives
    /// here once; `with_source` is the ack-only wrapper over it.
    fn with_source_val<F>(&mut self, name: &str, f: F) -> Result<Value, ProtoError>
    where
        F: FnOnce(*mut ffi::obs_source) -> Result<Value, ProtoError>,
    {
        unsafe {
            let c = cstring(name);
            let src = ffi::obs_get_source_by_name(c.as_ptr());
            if src.is_null() {
                return Err(ProtoError::bad_request(format!("no such source: {name}")));
            }
            let r = f(src);
            ffi::obs_source_release(src);
            r
        }
    }

    /// Run `f` against one filter ON a named source. Every SF4 filter verb
    /// resolves through here. `obs_source_get_filter_by_name` returns an
    /// INCREMENTED ref, so the filter needs its own release on top of the
    /// parent's — forgetting it leaks the filter, not the source.
    fn with_filter<F>(&mut self, source: &str, filter: &str, f: F) -> Result<Value, ProtoError>
    where
        F: FnOnce(*mut ffi::obs_source, *mut ffi::obs_source) -> Result<Value, ProtoError>,
    {
        let fname = filter.to_string();
        self.with_source_val(source, move |src| unsafe {
            let c = cstring(&fname);
            let flt = ffi::obs_source_get_filter_by_name(src, c.as_ptr());
            if flt.is_null() {
                return Err(ProtoError::bad_request(format!("no such filter: {fname}")));
            }
            let r = f(src, flt);
            ffi::obs_source_release(flt);
            r
        })
    }

    /// `level` is either a 0..1 fader deflection (the mixer strip) or an exact
    /// dB value (SF3's numeric field). Both go through the SAME fader object,
    /// so the cubic curve stays defined in exactly one place — a dB set and a
    /// deflection set of the same level land on the identical gain.
    fn set_volume(&mut self, name: &str, level: VolumeLevel) -> Result<Value, ProtoError> {
        if self.scratch_fader.is_null() {
            return Err(ProtoError::internal("fader unavailable"));
        }
        let fader = self.scratch_fader;
        self.with_source(name, |src| unsafe {
            ffi::obs_fader_attach_source(fader, src);
            match level {
                VolumeLevel::Deflection(d) => {
                    ffi::obs_fader_set_deflection(fader, d.clamp(0.0, 1.0));
                }
                // OBS's own range: -INF..+26 dB. Below the floor is silence.
                VolumeLevel::Db(db) => {
                    ffi::obs_fader_set_db(fader, db.min(26.0));
                }
            }
            ffi::obs_fader_detach_source(fader);
        })
    }

    fn set_mute(&mut self, name: &str, muted: bool) -> Result<Value, ProtoError> {
        self.with_source(name, |src| unsafe { ffi::obs_source_set_muted(src, muted) })
    }

    fn set_monitoring(&mut self, name: &str, kind: &str) -> Result<Value, ProtoError> {
        let t = match kind {
            "none" => ffi::obs_monitoring_type_OBS_MONITORING_TYPE_NONE,
            "monitor_only" => ffi::obs_monitoring_type_OBS_MONITORING_TYPE_MONITOR_ONLY,
            "monitor_and_output" => ffi::obs_monitoring_type_OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT,
            other => {
                return Err(ProtoError::bad_request(format!("unknown monitoring type: {other}")))
            }
        };
        self.with_source(name, |src| unsafe { ffi::obs_source_set_monitoring_type(src, t) })
    }

    fn set_balance(&mut self, name: &str, balance: f32) -> Result<Value, ProtoError> {
        self.with_source(name, |src| unsafe {
            ffi::obs_source_set_balance_value(src, balance.clamp(0.0, 1.0))
        })
    }

    fn set_mono(&mut self, name: &str, mono: bool) -> Result<Value, ProtoError> {
        self.with_source(name, |src| unsafe {
            let flags = ffi::obs_source_get_flags(src);
            let next = if mono {
                flags | ffi::OBS_SOURCE_FLAG_FORCE_MONO
            } else {
                flags & !ffi::OBS_SOURCE_FLAG_FORCE_MONO
            };
            ffi::obs_source_set_flags(src, next);
        })
    }

    fn set_sync_offset(&mut self, name: &str, ms: i64) -> Result<Value, ProtoError> {
        self.with_source(name, |src| unsafe {
            ffi::obs_source_set_sync_offset(src, ms * 1_000_000)
        })
    }

    fn set_tracks(&mut self, name: &str, mask: u32) -> Result<Value, ProtoError> {
        // Six tracks; a wider mask would silently route nowhere.
        if mask > 0b111111 {
            return Err(ProtoError::bad_request("track mask exceeds 6 tracks"));
        }
        self.with_source(name, |src| unsafe { ffi::obs_source_set_audio_mixers(src, mask) })
    }

    // --- SF4 filter stack -----------------------------------------------------
    //
    // The READ side already shipped: `enum_filters` populates
    // `AudioSourceInfo.filters` on every snapshot, so nothing below has to
    // report the chain back — these are writes plus the two property verbs.

    fn add_filter(&mut self, source: &str, id: &str, name: &str) -> Result<Value, ProtoError> {
        let (type_id, fname) = (id.to_string(), name.to_string());
        self.with_source_val(source, move |src| unsafe {
            // The filter NAME is the addressing key for every other verb here,
            // so a duplicate would make remove/get_properties hit whichever
            // instance libobs happens to find first.
            let c = cstring(&fname);
            let existing = ffi::obs_source_get_filter_by_name(src, c.as_ptr());
            if !existing.is_null() {
                ffi::obs_source_release(existing);
                return Err(ProtoError::bad_request(format!("filter already exists: {fname}")));
            }
            // Validate the type BEFORE creating. `obs_source_create` does NOT
            // return null for an unknown id — it builds an unknown-type
            // placeholder, which is how OBS survives loading a collection whose
            // plugin is missing. Verified by probe 2026-08-07: an id of
            // "not_a_filter" attached happily and reported ok. So a null check
            // is not a guard at all; the registry walk is.
            if !filter_type_exists(&type_id) {
                return Err(ProtoError::bad_request(format!("unknown filter type: {type_id}")));
            }
            // NULL settings is deliberate: libobs then fills the type's OWN
            // defaults, which are the values OBS ships. We keep no defaults
            // table of our own to drift out of date.
            let cid = cstring(&type_id);
            let flt = ffi::obs_source_create(
                cid.as_ptr(),
                c.as_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if flt.is_null() {
                return Err(ProtoError::internal(format!("could not create filter: {type_id}")));
            }
            ffi::obs_source_filter_add(src, flt);
            // filter_add takes its own ref; the create ref is spent.
            ffi::obs_source_release(flt);
            Ok(json!({}))
        })
    }

    fn remove_filter(&mut self, source: &str, name: &str) -> Result<Value, ProtoError> {
        self.with_filter(source, name, |src, flt| unsafe {
            ffi::obs_source_filter_remove(src, flt);
            Ok(json!({}))
        })
    }

    fn set_filter_enabled(
        &mut self,
        source: &str,
        name: &str,
        on: bool,
    ) -> Result<Value, ProtoError> {
        self.with_filter(source, name, |_src, flt| unsafe {
            ffi::obs_source_set_enabled(flt, on);
            Ok(json!({}))
        })
    }

    /// libobs moves a filter ONE STEP at a time (up/down/top/bottom); the UI
    /// hands back an absolute index. Walk the movement until the position
    /// matches, bounded by the chain length so a libobs no-op cannot spin.
    fn reorder_filter(
        &mut self,
        source: &str,
        name: &str,
        index: usize,
    ) -> Result<Value, ProtoError> {
        let fname = name.to_string();
        self.with_source_val(source, move |src| unsafe {
            let chain = enum_filters(src);
            let len = chain.len();
            if index >= len {
                return Err(ProtoError::bad_request(format!(
                    "index {index} out of range for {len} filters"
                )));
            }
            let c = cstring(&fname);
            let flt = ffi::obs_source_get_filter_by_name(src, c.as_ptr());
            if flt.is_null() {
                return Err(ProtoError::bad_request(format!("no such filter: {fname}")));
            }
            let pos_of = |chain: &[FilterInfo]| chain.iter().position(|f| f.name == fname);
            let mut cur = match pos_of(&chain) {
                Some(p) => p,
                None => {
                    ffi::obs_source_release(flt);
                    return Err(ProtoError::internal(format!("filter not in chain: {fname}")));
                }
            };
            for _ in 0..len {
                if cur == index {
                    break;
                }
                let movement = if cur > index {
                    ffi::obs_order_movement_OBS_ORDER_MOVE_UP
                } else {
                    ffi::obs_order_movement_OBS_ORDER_MOVE_DOWN
                };
                ffi::obs_source_filter_set_order(src, flt, movement);
                match pos_of(&enum_filters(src)) {
                    Some(p) if p != cur => cur = p,
                    // libobs refused to move it — stop rather than spin.
                    _ => break,
                }
            }
            ffi::obs_source_release(flt);
            Ok(json!({ "index": cur }))
        })
    }

    fn get_filter_properties(&mut self, source: &str, name: &str) -> Result<Value, ProtoError> {
        self.with_filter(source, name, |_src, flt| unsafe {
            // Same marshaling pair the scene-item `get_properties` uses — a
            // filter is an ordinary source once it is resolved.
            let props = ffi::obs_source_properties(flt);
            let list = if props.is_null() {
                Vec::new()
            } else {
                let l = props_to_json(props);
                ffi::obs_properties_destroy(props);
                l
            };
            Ok(json!({ "props": list, "settings": source_settings_json(flt) }))
        })
    }

    fn set_filter_settings(
        &mut self,
        source: &str,
        name: &str,
        settings: &Value,
        replace: bool,
    ) -> Result<Value, ProtoError> {
        let settings = settings.clone();
        self.with_filter(source, name, move |_src, flt| unsafe {
            let data = data_from_value(&settings);
            if replace {
                // Whole-settings restore (PropertiesForm's undo path): replace,
                // don't merge, or ghost keys from the undone edit survive.
                ffi::obs_source_reset_settings(flt, data);
            } else {
                ffi::obs_source_update(flt, data);
            }
            ffi::obs_data_release(data);
            Ok(json!({}))
        })
    }

    /// Filter TYPES available to add, split by what they process. Mirrors
    /// `list_input_types`; `obs_enum_filter_types` has one out-param instead of
    /// two because filters carry no unversioned id.
    fn list_filter_types(&self, kind: &str) -> Result<Value, ProtoError> {
        let want = match kind {
            "audio" => ffi::OBS_SOURCE_AUDIO,
            "video" => ffi::OBS_SOURCE_VIDEO,
            other => {
                return Err(ProtoError::bad_request(format!("unknown filter kind: {other}")))
            }
        };
        let mut types = Vec::new();
        unsafe {
            let mut idx = 0usize;
            loop {
                let mut id: *const std::os::raw::c_char = std::ptr::null();
                if !ffi::obs_enum_filter_types(idx, &mut id) {
                    break;
                }
                idx += 1;
                if id.is_null() {
                    continue;
                }
                let caps = ffi::obs_get_source_output_flags(id);
                if caps & ffi::OBS_SOURCE_CAP_DISABLED != 0 || caps & want == 0 {
                    continue;
                }
                let display = ffi::obs_source_get_display_name(id);
                types.push(json!({
                    "id": cstr_owned(id),
                    "display_name": if display.is_null() { cstr_owned(id) } else { cstr_owned(display) },
                    "caps": caps,
                }));
            }
        }
        Ok(json!({ "types": types }))
    }

    /// Assign (or clear, with an empty device id) one of libobs's six global
    /// audio channels. Adopt-don't-duplicate, exactly like
    /// the boot restore: a source of the same name is reused rather than
    /// recreated, because obs_save_sources/obs_load_sources round-trip these
    /// and a blind create duplicates the source on every boot.
    fn set_global_slot(
        &mut self,
        channel: u32,
        input_id: &str,
        device_id: &str,
    ) -> Result<Value, ProtoError> {
        let r = self.assign_global_slot(channel, input_id, device_id)?;
        // Persist AFTER the assignment succeeds — a rejected slot must not be
        // written, or the failure comes back on every subsequent boot.
        self.save_slot_profile();
        self.resync_meters();
        Ok(r)
    }

    /// The libobs half of `set_global_slot`, without persistence or a meter
    /// resync. Split out so the boot-time restore can reuse it before the
    /// meter machinery is up.
    fn assign_global_slot(
        &mut self,
        channel: u32,
        input_id: &str,
        device_id: &str,
    ) -> Result<Value, ProtoError> {
        if !(1..=6).contains(&channel) {
            return Err(ProtoError::bad_request("channel must be 1..6"));
        }
        if input_id.is_empty() {
            unsafe { ffi::obs_set_output_source(channel, std::ptr::null_mut()) };
            return Ok(json!({}));
        }
        unsafe {
            let name = global_slot_name(channel);
            let cname = cstring(&name);
            let mut src = ffi::obs_get_source_by_name(cname.as_ptr());
            if src.is_null() {
                let cid = cstring(input_id);
                src = ffi::obs_source_create(
                    cid.as_ptr(),
                    cname.as_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
                if src.is_null() {
                    return Err(ProtoError::internal(format!(
                        "could not create {input_id} for channel {channel}"
                    )));
                }
            }
            // An empty device_id means "whatever libobs defaults to" — writing
            // it through would pin the source to a device literally named "",
            // which captures silence.
            if !device_id.is_empty() {
                let settings = ffi::obs_data_create();
                let k = cstring("device_id");
                let v = cstring(device_id);
                ffi::obs_data_set_string(settings, k.as_ptr(), v.as_ptr());
                ffi::obs_source_update(src, settings);
                ffi::obs_data_release(settings);
            }
            ffi::obs_set_output_source(channel, src);
            ffi::obs_source_release(src);
        }
        Ok(json!({}))
    }

    fn set_monitoring_device(&mut self, id: &str, name: &str) -> Result<Value, ProtoError> {
        unsafe {
            let cn = cstring(if name.is_empty() { "Default" } else { name });
            let ci = cstring(if id.is_empty() { "default" } else { id });
            if !ffi::obs_set_audio_monitoring_device(cn.as_ptr(), ci.as_ptr()) {
                return Err(ProtoError::internal("monitoring device rejected"));
            }
        }
        Ok(json!({}))
    }

    /// Turn the meter stream on or off. ON attaches one volmeter per current
    /// mixer row; OFF destroys every volmeter, so libobs stops doing the work
    /// as well as the pipe going quiet.
    fn subscribe_meters(&mut self, on: bool) -> Result<Value, ProtoError> {
        self.detach_volmeters();
        self.meters_on.store(on, Ordering::Relaxed);
        if !on {
            if let Ok(mut m) = self.meter_sink.lock() {
                m.clear();
            }
            return Ok(json!({ "on": false }));
        }
        let names = self.audio_source_names();
        for (name, _) in &names {
            unsafe { self.attach_volmeter(name) };
        }
        Ok(json!({ "on": true, "sources": names.len() }))
    }

    /// # Safety
    /// Engine thread only - creates and attaches libobs objects.
    unsafe fn attach_volmeter(&mut self, name: &str) {
        let c = cstring(name);
        let src = ffi::obs_get_source_by_name(c.as_ptr());
        if src.is_null() {
            return;
        }
        let vm = ffi::obs_volmeter_create(ffi::obs_fader_type_OBS_FADER_CUBIC);
        if vm.is_null() {
            ffi::obs_source_release(src);
            return;
        }
        ffi::obs_volmeter_attach_source(vm, src);
        let channels = ffi::obs_volmeter_get_nr_channels(vm).max(1) as usize;
        let slot = Box::into_raw(Box::new(meters::Slot {
            key: name.to_string(),
            sink: self.meter_sink.clone(),
            channels,
        }));
        ffi::obs_volmeter_add_callback(vm, Some(meters::on_updated), slot as *mut _);
        self.volmeters.push((name.to_string(), vm, slot));
        ffi::obs_source_release(src);
    }

    /// Order matters: remove the callback, destroy the volmeter, and only THEN
    /// free the slot - freeing first leaves a live callback holding a dangling
    /// param.
    fn detach_volmeters(&mut self) {
        for (_, vm, slot) in std::mem::take(&mut self.volmeters) {
            unsafe {
                ffi::obs_volmeter_remove_callback(vm, Some(meters::on_updated), slot as *mut _);
                ffi::obs_volmeter_detach_source(vm);
                ffi::obs_volmeter_destroy(vm);
                meters::free_slot(slot);
            }
        }
    }

    /// Re-attach meters to the CURRENT row set. Called after anything that
    /// changes which sources are on the mixer (scene switch, source add or
    /// remove) so a new row is not permanently dead.
    fn resync_meters(&mut self) {
        if self.meters_on.load(Ordering::Relaxed) {
            let _ = self.subscribe_meters(true);
        }
    }

    fn replay_armed(&self) -> bool {
        self.replay.is_some()
    }

    /// Stream half of the snapshot. With no run, `stream_error` decides
    /// between a clean `idle` and an `error` that outlived its output.
    fn stream_info(&self) -> StreamInfo {
        match &self.stream {
            Some(run) => StreamInfo {
                status: run.status.into(),
                elapsed_ns: run.started.map_or(0, |t| t.elapsed().as_nanos() as u64),
                error: None,
                reconnects: run.reconnects,
            },
            None => StreamInfo {
                status: if self.stream_error.is_some() { "error" } else { "idle" }.into(),
                error: self.stream_error.clone(),
                ..StreamInfo::idle()
            },
        }
    }

    // --- scenes/sources -----------------------------------------------------

    fn find_scene(&self, name: &str) -> Option<*mut ffi::obs_scene> {
        self.scenes.iter().find(|(n, _)| n == name).map(|(_, s)| *s)
    }

    fn create_scene(&mut self, name: &str) -> Result<Value, ProtoError> {
        if self.find_scene(name).is_some() {
            return Err(ProtoError::bad_request(format!("scene '{name}' exists")));
        }
        let c = cstring(name);
        let scene = unsafe { ffi::obs_scene_create(c.as_ptr()) };
        if scene.is_null() {
            return Err(ProtoError::internal("obs_scene_create returned null"));
        }
        self.scenes.push((name.into(), scene));
        if self.current.is_none() {
            self.set_current_scene(name)?;
        }
        Ok(json!({}))
    }

    fn remove_scene(&mut self, name: &str) -> Result<Value, ProtoError> {
        let idx = self
            .scenes
            .iter()
            .position(|(n, _)| n == name)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{name}'")))?;
        if self.recording.is_some() && self.current.as_deref() == Some(name) {
            return Err(ProtoError::busy("scene is live in a recording"));
        }
        let (_, scene) = self.scenes.remove(idx);
        if self.current.as_deref() == Some(name) {
            unsafe { ffi::obs_set_output_source(0, std::ptr::null_mut()) };
            self.current = None;
        }
        unsafe {
            let src = ffi::obs_scene_get_source(scene);
            ffi::obs_source_remove(src);
            ffi::obs_scene_release(scene);
        }
        Ok(json!({}))
    }

    fn set_current_scene(&mut self, name: &str) -> Result<Value, ProtoError> {
        let scene = self
            .find_scene(name)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{name}'")))?;
        unsafe { ffi::obs_set_output_source(0, ffi::obs_scene_get_source(scene)) };
        self.current = Some(name.into());
        // The mixer's non-global rows come from the CURRENT scene, so the
        // volmeter set has to follow the switch or the new rows read silent
        // forever (SP6).
        self.resync_meters();
        Ok(json!({}))
    }

    #[allow(clippy::too_many_arguments)]
    fn create_source(
        &mut self,
        scene: &str,
        id: &str,
        name: &str,
        settings: &Value,
        transform: &Value,
        crop: &Value,
        visible: Option<bool>,
        locked: Option<bool>,
    ) -> Result<Value, ProtoError> {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        // obs_source_create does NOT dedupe names, and duplicates break name
        // addressing â€” auto-suffix and reply the final name (v2 contract).
        let final_name = unsafe { free_name(name) };
        unsafe {
            let cid = cstring(id);
            let cname = cstring(&final_name);
            let data = data_from_value(settings);
            let src = ffi::obs_source_create(cid.as_ptr(), cname.as_ptr(), data, std::ptr::null_mut());
            ffi::obs_data_release(data);
            if src.is_null() {
                return Err(ProtoError::internal(format!("obs_source_create('{id}') null")));
            }
            // monitor_capture's DEFAULT monitor_id is the "DUMMY" sentinel
            // (duplicator-monitor-capture.c:379) â€” OBS's properties dialog
            // swaps in a real monitor when opened; created programmatically it
            // captures nothing forever (eternal black frames). When the caller
            // didn't pick one, resolve the first real monitor from the
            // source's own properties list (the same enumeration the UI uses).
            if id == "monitor_capture" {
                let mut fixes = serde_json::Map::new();
                if settings.get("monitor_id").and_then(Value::as_str).is_none() {
                    if let Some(monitor) = first_real_monitor_id(src) {
                        log::info!("create_source: defaulting monitor_id to {monitor}");
                        fixes.insert("monitor_id".into(), Value::String(monitor));
                    } else {
                        log::warn!("create_source: no real monitor found to default monitor_id");
                    }
                }
                // Default method to WGC (2), not OBS's AUTO: AUTO prefers DXGI
                // duplication, which dies with DXGI_ERROR_UNSUPPORTED (887A0004)
                // on HAGS/hybrid-GPU boxes like the dev machine. WGC is the
                // modern path (Win10 1903+ â€” our floor).
                if settings.get("method").is_none() {
                    fixes.insert("method".into(), Value::from(2));
                }
                if !fixes.is_empty() {
                    let fix = data_from_value(&Value::Object(fixes));
                    ffi::obs_source_update(src, fix);
                    ffi::obs_data_release(fix);
                }
            }
            let item = ffi::obs_scene_add(scene_ptr, src);
            ffi::obs_source_release(src); // the scene item holds its own ref
            if item.is_null() {
                return Err(ProtoError::internal("obs_scene_add returned null"));
            }
            apply_transform_patch(item, transform, crop);
            if let Some(v) = visible {
                ffi::obs_sceneitem_set_visible(item, v);
            }
            if let Some(l) = locked {
                ffi::obs_sceneitem_set_locked(item, l);
            }
            Ok(json!({ "item": ffi::obs_sceneitem_get_id(item), "name": final_name }))
        }
    }

    fn remove_source(&mut self, scene: &str, name: &str) -> Result<Value, ProtoError> {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        unsafe {
            let c = cstring(name);
            let item = ffi::obs_scene_find_source(scene_ptr, c.as_ptr());
            if item.is_null() {
                return Err(ProtoError::bad_request(format!("no source '{name}' in '{scene}'")));
            }
            ffi::obs_sceneitem_remove(item);
        }
        Ok(json!({}))
    }

    fn set_source_settings(
        &mut self,
        _scene: &str,
        name: &str,
        settings: &Value,
        replace: bool,
    ) -> Result<Value, ProtoError> {
        unsafe {
            let c = cstring(name);
            let src = ffi::obs_get_source_by_name(c.as_ptr());
            if src.is_null() {
                return Err(ProtoError::bad_request(format!("no source '{name}'")));
            }
            let data = data_from_value(settings);
            if replace {
                // Whole-settings restore (undo path): replace, don't merge â€”
                // a merge would leave ghost keys from the undone edit behind.
                ffi::obs_source_reset_settings(src, data);
            } else {
                ffi::obs_source_update(src, data);
            }
            ffi::obs_data_release(data);
            ffi::obs_source_release(src);
        }
        Ok(json!({}))
    }

    // --- SP3 scene-graph verbs ------------------------------------------------

    /// Every item verb resolves through this ONE helper â€” find_sceneitem_by_id
    /// does not recurse into groups, so a hand-rolled deep find is the single
    /// place group addressing can go wrong (risk ledger #6).
    fn with_item<F>(&self, scene: &str, id: i64, f: F) -> Result<Value, ProtoError>
    where
        F: FnOnce(*mut ffi::obs_sceneitem_t) -> Result<Value, ProtoError>,
    {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        let item = unsafe { find_item_deep(scene_ptr, id) }
            .ok_or_else(|| ProtoError::bad_request(format!("no item {id} in '{scene}'")))?;
        f(item)
    }

    fn rename_scene(&mut self, name: &str, new_name: &str) -> Result<Value, ProtoError> {
        if new_name.trim().is_empty() {
            return Err(ProtoError::bad_request("empty name"));
        }
        let scene = self
            .find_scene(name)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{name}'")))?;
        if name != new_name && unsafe { name_taken(new_name) } {
            return Err(ProtoError::bad_request(format!("name '{new_name}' is taken")));
        }
        unsafe {
            let c = cstring(new_name);
            ffi::obs_source_set_name(ffi::obs_scene_get_source(scene), c.as_ptr());
        }
        if let Some(entry) = self.scenes.iter_mut().find(|(n, _)| n == name) {
            entry.0 = new_name.into();
        }
        if self.current.as_deref() == Some(name) {
            self.current = Some(new_name.into());
        }
        Ok(json!({}))
    }

    fn rename_item(&mut self, scene: &str, item: i64, new_name: &str) -> Result<Value, ProtoError> {
        if new_name.trim().is_empty() {
            return Err(ProtoError::bad_request("empty name"));
        }
        self.with_item(scene, item, |it| unsafe {
            let src = ffi::obs_sceneitem_get_source(it);
            if src.is_null() {
                return Err(ProtoError::internal("item has no source"));
            }
            let cur = CStr::from_ptr(ffi::obs_source_get_name(src)).to_string_lossy().into_owned();
            if cur != new_name && name_taken(new_name) {
                return Err(ProtoError::bad_request(format!("name '{new_name}' is taken")));
            }
            let c = cstring(new_name);
            ffi::obs_source_set_name(src, c.as_ptr());
            Ok(json!({}))
        })
    }

    fn duplicate_scene(&mut self, name: &str) -> Result<Value, ProtoError> {
        let scene = self
            .find_scene(name)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{name}'")))?;
        let new_name = unsafe { free_name(name) };
        let dup = unsafe {
            let c = cstring(&new_name);
            // DUP_REFS: new items reference the same sources (OBS "Duplicate").
            ffi::obs_scene_duplicate(scene, c.as_ptr(), ffi::obs_scene_duplicate_type_OBS_SCENE_DUP_REFS)
        };
        if dup.is_null() {
            return Err(ProtoError::internal("obs_scene_duplicate returned null"));
        }
        self.scenes.push((new_name.clone(), dup));
        Ok(json!({ "name": new_name }))
    }

    fn reorder_scenes(&mut self, order: &[String]) -> Result<Value, ProtoError> {
        if order.len() != self.scenes.len()
            || !order.iter().all(|n| self.scenes.iter().any(|(sn, _)| sn == n))
        {
            return Err(ProtoError::bad_request("order set mismatch"));
        }
        self.scenes.sort_by_key(|(n, _)| order.iter().position(|o| o == n).unwrap_or(usize::MAX));
        Ok(json!({}))
    }

    fn reorder_items(&mut self, scene: &str, order: &[(i64, Option<i64>)]) -> Result<Value, ProtoError> {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        unsafe {
            let mut infos: Vec<ffi::obs_sceneitem_order_info> = Vec::with_capacity(order.len());
            for (item_id, group_id) in order {
                let item = find_item_deep(scene_ptr, *item_id)
                    .ok_or_else(|| ProtoError::bad_request(format!("no item {item_id} in '{scene}'")))?;
                let group = match group_id {
                    Some(g) => find_item_deep(scene_ptr, *g)
                        .ok_or_else(|| ProtoError::bad_request(format!("no group {g} in '{scene}'")))?,
                    None => std::ptr::null_mut(),
                };
                infos.push(ffi::obs_sceneitem_order_info { group, item });
            }
            if !ffi::obs_scene_reorder_items2(scene_ptr, infos.as_mut_ptr(), infos.len()) {
                return Err(ProtoError::bad_request("order set mismatch (stale snapshot?)"));
            }
        }
        Ok(json!({}))
    }

    fn create_group(&mut self, scene: &str, name: &str) -> Result<Value, ProtoError> {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        let final_name = unsafe { free_name(name) };
        unsafe {
            let c = cstring(&final_name);
            let item = ffi::obs_scene_add_group(scene_ptr, c.as_ptr());
            if item.is_null() {
                return Err(ProtoError::internal("obs_scene_add_group returned null"));
            }
            Ok(json!({ "item": ffi::obs_sceneitem_get_id(item), "name": final_name }))
        }
    }

    fn add_existing(&mut self, scene: &str, source_name: &str) -> Result<Value, ProtoError> {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        unsafe {
            let c = cstring(source_name);
            let src = ffi::obs_get_source_by_name(c.as_ptr());
            if src.is_null() {
                return Err(ProtoError::bad_request(format!("no source '{source_name}'")));
            }
            // Direct self-nesting guard (A into A). Deeper cycles are excluded
            // by the UI (Scene â–¸ lists other scenes only) â€” documented limit.
            if src == ffi::obs_scene_get_source(scene_ptr) {
                ffi::obs_source_release(src);
                return Err(ProtoError::bad_request("cannot nest a scene into itself"));
            }
            let item = ffi::obs_scene_add(scene_ptr, src);
            ffi::obs_source_release(src);
            if item.is_null() {
                return Err(ProtoError::internal("obs_scene_add returned null"));
            }
            Ok(json!({ "item": ffi::obs_sceneitem_get_id(item) }))
        }
    }

    /// Deselect-all + select target. `selected` rides snapshots, so respawn
    /// reconciles; the overlay renderer reads the flag straight off the items.
    fn select_item(&mut self, scene: &str, item: Option<i64>) -> Result<Value, ProtoError> {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        unsafe {
            unsafe extern "C" fn deselect(
                _s: *mut ffi::obs_scene_t,
                it: *mut ffi::obs_sceneitem_t,
                param: *mut std::ffi::c_void,
            ) -> bool {
                unsafe {
                    ffi::obs_sceneitem_select(it, false);
                    if ffi::obs_sceneitem_is_group(it) {
                        ffi::obs_sceneitem_group_enum_items(it, Some(deselect), param);
                    }
                }
                true
            }
            ffi::obs_scene_enum_items(scene_ptr, Some(deselect), std::ptr::null_mut());
            if let Some(id) = item {
                let it = find_item_deep(scene_ptr, id)
                    .ok_or_else(|| ProtoError::bad_request(format!("no item {id} in '{scene}'")))?;
                ffi::obs_sceneitem_select(it, true);
            }
        }
        Ok(json!({}))
    }

    fn get_source_settings(&self, scene: &str, item: i64) -> Result<Value, ProtoError> {
        self.with_item(scene, item, |it| unsafe {
            let src = ffi::obs_sceneitem_get_source(it);
            if src.is_null() {
                return Err(ProtoError::internal("item has no source"));
            }
            Ok(json!({
                "id": cstr_owned(ffi::obs_source_get_id(src)),
                "name": cstr_owned(ffi::obs_source_get_name(src)),
                "settings": source_settings_json(src),
            }))
        })
    }

    fn get_properties(&self, scene: &str, item: i64) -> Result<Value, ProtoError> {
        self.with_item(scene, item, |it| unsafe {
            let src = ffi::obs_sceneitem_get_source(it);
            if src.is_null() {
                return Err(ProtoError::internal("item has no source"));
            }
            let props = ffi::obs_source_properties(src);
            let list = if props.is_null() {
                Vec::new()
            } else {
                let l = props_to_json(props);
                ffi::obs_properties_destroy(props);
                l
            };
            Ok(json!({ "props": list, "settings": source_settings_json(src) }))
        })
    }

    fn click_property_button(&self, scene: &str, item: i64, prop: &str) -> Result<Value, ProtoError> {
        self.with_item(scene, item, |it| unsafe {
            let src = ffi::obs_sceneitem_get_source(it);
            if src.is_null() {
                return Err(ProtoError::internal("item has no source"));
            }
            let props = ffi::obs_source_properties(src);
            if props.is_null() {
                return Err(ProtoError::bad_request("source has no properties"));
            }
            let c = cstring(prop);
            let p = ffi::obs_properties_get(props, c.as_ptr());
            if p.is_null() {
                ffi::obs_properties_destroy(props);
                return Err(ProtoError::bad_request(format!("no property '{prop}'")));
            }
            let refresh = ffi::obs_property_button_clicked(p, src as *mut std::ffi::c_void);
            ffi::obs_properties_destroy(props);
            Ok(json!({ "refresh": refresh }))
        })
    }

    fn list_input_types(&self) -> Result<Value, ProtoError> {
        let mut types = Vec::new();
        unsafe {
            let mut idx = 0usize;
            loop {
                let mut id: *const std::os::raw::c_char = std::ptr::null();
                let mut unversioned: *const std::os::raw::c_char = std::ptr::null();
                if !ffi::obs_enum_input_types2(idx, &mut id, &mut unversioned) {
                    break;
                }
                idx += 1;
                if id.is_null() {
                    continue;
                }
                let caps = ffi::obs_get_source_output_flags(id);
                if caps & ffi::OBS_SOURCE_CAP_DISABLED != 0 {
                    continue;
                }
                let display = ffi::obs_source_get_display_name(id);
                types.push(json!({
                    "id": cstr_owned(id),
                    "display_name": if display.is_null() { cstr_owned(id) } else { cstr_owned(display) },
                    "caps": caps,
                }));
            }
        }
        Ok(json!({ "types": types }))
    }

    /// Device choices for the SF3 pickers. `output`/`input` read the `device_id`
    /// property off the wasapi source TYPE (obs_get_source_properties needs no
    /// instance), which is how OBS's own settings page fills these lists — so an
    /// unassigned slot can still offer devices. `monitoring` is a different
    /// libobs API entirely and is enumerated by callback.
    fn list_audio_devices(&self, kind: &str) -> Result<Value, ProtoError> {
        if kind == "monitoring" {
            return Ok(json!({ "devices": enumerate_monitoring_devices() }));
        }
        let input_id = match kind {
            "output" => "wasapi_output_capture",
            "input" => "wasapi_input_capture",
            _ => return Err(ProtoError::bad_request("kind must be output, input or monitoring")),
        };
        let mut devices = Vec::new();
        unsafe {
            let cid = cstring(input_id);
            let props = ffi::obs_get_source_properties(cid.as_ptr());
            if props.is_null() {
                return Ok(json!({ "devices": devices }));
            }
            let key = cstring("device_id");
            let p = ffi::obs_properties_get(props, key.as_ptr());
            if !p.is_null() {
                for i in 0..ffi::obs_property_list_item_count(p) {
                    let name = ffi::obs_property_list_item_name(p, i);
                    let id = ffi::obs_property_list_item_string(p, i);
                    if id.is_null() {
                        continue;
                    }
                    devices.push(json!({
                        "id": cstr_owned(id),
                        "name": if name.is_null() { cstr_owned(id) } else { cstr_owned(name) },
                    }));
                }
            }
            ffi::obs_properties_destroy(props);
        }
        Ok(json!({ "devices": devices }))
    }

    fn screenshot(
        &self,
        scene: Option<&str>,
        item: Option<i64>,
        picker: Option<&str>,
        width: u32,
    ) -> Result<Value, ProtoError> {
        // Resolve target: picker temp / scene item / whole program.
        let (src, src_w, src_h) = unsafe {
            if let Some(mid) = picker {
                let (_, _, p) = self
                    .picker
                    .iter()
                    .find(|(id, _, _)| id == mid)
                    .ok_or_else(|| ProtoError::bad_request(format!("no picker source '{mid}'")))?;
                (*p, ffi::obs_source_get_width(*p), ffi::obs_source_get_height(*p))
            } else if let (Some(sc), Some(it_id)) = (scene, item) {
                let scene_ptr = self
                    .find_scene(sc)
                    .ok_or_else(|| ProtoError::bad_request(format!("no scene '{sc}'")))?;
                let it = find_item_deep(scene_ptr, it_id)
                    .ok_or_else(|| ProtoError::bad_request(format!("no item {it_id} in '{sc}'")))?;
                let s = ffi::obs_sceneitem_get_source(it);
                (s, ffi::obs_source_get_width(s), ffi::obs_source_get_height(s))
            } else {
                (std::ptr::null_mut(), 0, 0)
            }
        };
        let (cw, ch) = self.canvas_size();
        let (src_w, src_h) = if src_w == 0 || src_h == 0 { (cw, ch) } else { (src_w, src_h) };
        let out_w = width.clamp(64, 640);
        let out_h = ((out_w as u64 * src_h as u64) / src_w.max(1) as u64).max(1) as u32;
        let png = unsafe { screenshot::capture(src, src_w, src_h, out_w, out_h) }
            .map_err(ProtoError::internal)?;
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        Ok(json!({ "png": b64, "w": out_w, "h": out_h }))
    }

    /// Temp PRIVATE monitor_capture per real monitor, inc_showing held (WGC
    /// init gate). Idempotent upsert: close first.
    fn picker_open(&mut self, kind: &str) -> Result<Value, ProtoError> {
        if kind != "monitor" {
            return Err(ProtoError::bad_request(format!("unknown picker kind '{kind}'")));
        }
        self.picker_close();
        let monitors = unsafe { enumerate_monitors() };
        let mut out = Vec::new();
        unsafe {
            for (mid, label) in monitors {
                let settings = data_from_value(&json!({ "monitor_id": mid, "method": 2 }));
                let cid = cstring("monitor_capture");
                let cname = cstring(&format!("__picker {mid}"));
                let src = ffi::obs_source_create_private(cid.as_ptr(), cname.as_ptr(), settings);
                ffi::obs_data_release(settings);
                if src.is_null() {
                    log::warn!("picker: monitor_capture create failed for {mid}");
                    continue;
                }
                ffi::obs_source_inc_showing(src);
                out.push(json!({ "id": mid, "label": label }));
                self.picker.push((mid.clone(), label, src));
            }
        }
        log::info!("picker_open: {} monitor temp source(s)", self.picker.len());
        Ok(json!({ "monitors": out }))
    }

    fn picker_close(&mut self) {
        let n = self.picker.len();
        for (_, _, src) in self.picker.drain(..) {
            unsafe {
                ffi::obs_source_dec_showing(src);
                ffi::obs_source_release(src);
            }
        }
        if n > 0 {
            log::info!("picker_close: released {n} temp source(s)");
        }
    }

    fn canvas_size(&self) -> (u32, u32) {
        unsafe {
            let mut ovi: ffi::obs_video_info = std::mem::zeroed();
            if ffi::obs_get_video_info(&mut ovi) {
                (ovi.base_width, ovi.base_height)
            } else {
                (1920, 1080)
            }
        }
    }

    /// Fresh-box guard: with no persisted collection the program is empty â€”
    /// the preview renders black and start_record errors "no current scene".
    fn ensure_default_scene(&mut self) {
        if self.scenes.is_empty() {
            if let Err(e) = self.create_scene("Scene") {
                log::warn!("default scene create failed: {}", e.message);
            }
        }
    }

    /// Reassign libobs's six global audio channels from the profile (SP6 SF3).
    ///
    /// Channel ASSIGNMENT does not round-trip through the collection — only the
    /// sources themselves do — so it has to be re-applied on every boot. Before
    /// SF3 that re-application was two hardcoded calls, which meant clearing
    /// channel 1 or 2 in the UI silently came back on the next start. The
    /// assignment now lives in the profile ini, so a cleared slot STAYS clear:
    /// an empty `Slot<N>Input` is a real "user emptied this", distinct from an
    /// absent key.
    ///
    /// Runs AFTER load_collection, preserving the adopt-don't-duplicate
    /// contract — creating a source before load duplicated it every boot
    /// (obs_save_sources saves it, obs_load_sources restores it, attach created
    /// a second).
    fn restore_global_slots(&mut self) {
        // No slot keys at all = a box that has never seen SF3. Seed OBS's own
        // defaults (desktop on 1/track 1, mic on 2/track 2) and persist them,
        // so the next boot takes the restore path like any other.
        let fresh = (1..=6).all(|ch| self.profile.get("Audio", &slot_input_key(ch)).is_none());
        if fresh {
            self.seed_default_slots();
            return;
        }
        for ch in 1..=6u32 {
            let input_id = self.profile.get_or("Audio", &slot_input_key(ch), "").to_string();
            if input_id.is_empty() {
                continue; // explicitly cleared, or never assigned
            }
            let device_id = self.profile.get_or("Audio", &slot_device_key(ch), "").to_string();
            if let Err(e) = self.assign_global_slot(ch, &input_id, &device_id) {
                log::warn!("channel {ch} restore failed: {}", e.message);
            }
        }
    }

    /// First-boot seed: the OBS default pair, persisted so it is restorable.
    fn seed_default_slots(&mut self) {
        for (ch, input_id, mask) in
            [(1u32, "wasapi_output_capture", 0b01u32), (2, "wasapi_input_capture", 0b10)]
        {
            match self.assign_global_slot(ch, input_id, "") {
                Ok(_) => unsafe {
                    // Collections predating SP4 carry no mixer mask; set it on
                    // adopt as well as on create.
                    let name = cstring(&global_slot_name(ch));
                    let src = ffi::obs_get_source_by_name(name.as_ptr());
                    if !src.is_null() {
                        ffi::obs_source_set_audio_mixers(src, mask);
                        ffi::obs_source_release(src);
                    }
                },
                Err(e) => log::warn!("channel {ch} seed failed: {}", e.message),
            }
        }
        self.save_slot_profile();
    }

    /// Persist the CURRENT assignment of all six channels. Called after any
    /// slot mutation; reads back from libobs rather than trusting a cached
    /// copy, so the file always matches what the engine actually has wired.
    fn save_slot_profile(&mut self) {
        for ch in 1..=6u32 {
            let (input_id, device_id) = unsafe {
                let src = ffi::obs_get_output_source(ch);
                if src.is_null() {
                    (String::new(), String::new())
                } else {
                    let id = cstr_owned(ffi::obs_source_get_id(src));
                    let settings = ffi::obs_source_get_settings(src);
                    let k = cstring("device_id");
                    let dev = cstr_owned(ffi::obs_data_get_string(settings, k.as_ptr()));
                    ffi::obs_data_release(settings);
                    ffi::obs_source_release(src);
                    (id, dev)
                }
            };
            self.profile.set("Audio", &slot_input_key(ch), input_id);
            self.profile.set("Audio", &slot_device_key(ch), device_id);
        }
        if let Err(e) = self.profile.save() {
            log::warn!("audio slot profile save failed: {e}");
        }
    }

    // --- displays (SP2) -------------------------------------------------------
    // Ephemeral preview swapchains bound to app-owned HWNDs. obs_display_create
    // and _destroy enter the graphics context themselves (obs-display.c), so
    // they are engine-thread-safe; the registered draw callback fires on OBS's
    // internal graphics thread. The engine trusts the app's u64 â€” a garbage or
    // stale HWND fails the D3D11 swapchain create and surfaces as a clean
    // internal error.

    fn display_create(&mut self, id: &str, hwnd: u64, width: u32, height: u32) -> Result<Value, ProtoError> {
        self.remove_display(id); // upsert: replace an existing id
        let init = ffi::gs_init_data {
            window: ffi::gs_window { hwnd: hwnd as *mut std::ffi::c_void },
            cx: width.max(1),
            cy: height.max(1),
            // 1, not 0, and matching OBS's own frontend: with 0 the FIRST display
            // of a process creates fine and every one after a destroy fails with
            // "swapchain on hwnd" — any id, any fresh HWND — until the daemon
            // restarts (measured 2026-08-28). Destroy is the app's only
            // visibility lever, so 0 made the preview one-shot per process.
            num_backbuffers: 1,
            format: ffi::gs_color_format_GS_BGRA,
            zsformat: ffi::gs_zstencil_format_GS_ZS_NONE,
            adapter: 0,
        };
        // Background color is never visible: the region is exact-fit (the app
        // sizes it to the canvas aspect), so no letterbox bars are drawn.
        let d = unsafe { ffi::obs_display_create(&init, 0x000000) };
        if d.is_null() {
            return Err(ProtoError::internal("obs_display_create failed (swapchain on hwnd)"));
        }
        unsafe { ffi::obs_display_add_draw_callback(d, Some(draw_main), std::ptr::null_mut()) };
        self.displays.push((id.into(), d));
        Ok(json!({}))
    }

    fn display_resize(&mut self, id: &str, width: u32, height: u32) -> Result<Value, ProtoError> {
        let d = self
            .displays
            .iter()
            .find(|(n, _)| n == id)
            .map(|(_, d)| *d)
            .ok_or_else(|| ProtoError::bad_request(format!("no display '{id}'")))?;
        // Deferred-safe: only stashes next_cx/cy; the actual gs_resize happens
        // in the render path on the graphics thread.
        unsafe { ffi::obs_display_resize(d, width.max(1), height.max(1)) };
        Ok(json!({}))
    }

    /// Idempotent by design: after an engine respawn the app tears down ids
    /// this (new) engine never had â€” missing is Ok, not bad_request.
    fn display_destroy(&mut self, id: &str) -> Result<Value, ProtoError> {
        self.remove_display(id);
        Ok(json!({}))
    }

    fn remove_display(&mut self, id: &str) {
        if let Some(i) = self.displays.iter().position(|(n, _)| n == id) {
            let (_, d) = self.displays.remove(i);
            unsafe { ffi::obs_display_destroy(d) };
        }
    }

    // --- recording (SP4: profile-driven) --------------------------------------

    /// Create the shared encode session from the current profile, if absent.
    /// Reused by record and (S3) replay â€” never build a second 1080p60 encode.
    fn ensure_encoders(&mut self) -> Result<(), ProtoError> {
        if self.encoders.is_some() {
            return Ok(());
        }
        let mode_adv = self.profile.get_or("Output", "Mode", "Simple").eq_ignore_ascii_case("advanced");
        let (venc_id, venc_settings) = if mode_adv {
            // Advanced: AdvOut.RecEncoder is a libobs id, settings come from
            // recordEncoder.json verbatim (libobs folds its own defaults).
            let id = self.profile.get_or("AdvOut", "RecEncoder", "obs_x264").to_string();
            let v = std::fs::read_to_string(record_encoder_path())
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(Value::Null);
            (id, v)
        } else {
            self.simple_encoder_plan()
        };
        let tracks = {
            let t = self.profile.get_u32("SimpleOutput", "RecTracks", 3) & 0x3F;
            if t == 0 { 1 } else { t }
        };
        unsafe {
            let cid = cstring(&venc_id);
            let cname = cstring("bcast_venc");
            let vdata = data_from_value(&venc_settings);
            let venc = ffi::obs_video_encoder_create(cid.as_ptr(), cname.as_ptr(), vdata, std::ptr::null_mut());
            ffi::obs_data_release(vdata);
            if venc.is_null() {
                return Err(ProtoError::internal(format!("encoder '{venc_id}' create failed")));
            }
            ffi::obs_encoder_set_video(venc, ffi::obs_get_video());

            let mut aencs: Vec<(u32, *mut ffi::obs_encoder)> = Vec::new();
            for i in 0..6u32 {
                if tracks & (1 << i) == 0 {
                    continue;
                }
                let adata = data_from_value(&json!({ "bitrate": 160 }));
                let aid = cstring("ffmpeg_aac");
                let aname = cstring(&format!("bcast_aenc_t{}", i + 1));
                let aenc = ffi::obs_audio_encoder_create(aid.as_ptr(), aname.as_ptr(), adata, i as usize, std::ptr::null_mut());
                ffi::obs_data_release(adata);
                if aenc.is_null() {
                    ffi::obs_encoder_release(venc);
                    for (_, a) in aencs {
                        ffi::obs_encoder_release(a);
                    }
                    return Err(ProtoError::internal("ffmpeg_aac encoder create failed"));
                }
                ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());
                aencs.push((i, aenc));
            }
            log::info!("encoder session up: {venc_id} + {} audio track(s)", aencs.len());
            self.encoders = Some(EncoderSet { venc, aencs });
        }
        Ok(())
    }

    /// Release the shared encoders when the last consumer stopped. Idle
    /// settings changes also route here so the next start builds fresh.
    fn drop_encoders_if_idle(&mut self) {
        if self.recording.is_some() || self.finalizing || self.replay_armed() {
            return;
        }
        if let Some(e) = self.encoders.take() {
            unsafe {
                ffi::obs_encoder_release(e.venc);
                for (_, a) in e.aencs {
                    ffi::obs_encoder_release(a);
                }
            }
            log::info!("encoder session released");
        }
    }

    /// OBS SimpleOutput qualityâ†’settings port: HQ=CRF16, standard=CRF23,
    /// resolution-eased by CalcCRF; Lossless = x264 qp0 in-container (the
    /// utvideo-AVI branch is deliberately not mirrored â€” one pipeline,
    /// multi-track intact; parity-table note).
    fn simple_encoder_plan(&self) -> (String, Value) {
        let quality = self.profile.get_or("SimpleOutput", "RecQuality", "HQ").to_string();
        let family = self.profile.get_or("SimpleOutput", "RecEncoder", "x264").to_string();
        if quality == "Lossless" {
            return (
                "obs_x264".into(),
                json!({ "rate_control": "CRF", "crf": 0, "preset": "ultrafast", "keyint_sec": 2 }),
            );
        }
        let base = if quality == "HQ" { 16 } else { 23 };
        let crf = calc_crf(
            base,
            self.profile.get_u32("Video", "OutputCX", 1920),
            self.profile.get_u32("Video", "OutputCY", 1080),
        );
        let id = self.resolve_encoder_id(&family);
        let settings = match family.as_str() {
            "nvenc" => json!({ "rate_control": "CQP", "cqp": crf, "keyint_sec": 2 }),
            "qsv" => json!({ "rate_control": "ICQ", "icq_quality": crf, "keyint_sec": 2 }),
            "amd" => json!({ "rate_control": "CQP", "cqp": crf, "keyint_sec": 2 }),
            _ => json!({ "rate_control": "CRF", "crf": crf, "preset": "veryfast", "keyint_sec": 2 }),
        };
        (id, settings)
    }

    /// Simple-family â†’ first REGISTERED libobs id (never hardcode one nvenc
    /// variant â€” ids move across OBS releases; enumeration is truth).
    fn resolve_encoder_id(&self, family: &str) -> String {
        let candidates: &[&str] = match family {
            "nvenc" => &["obs_nvenc_h264_tex", "jim_nvenc", "ffmpeg_nvenc"],
            "qsv" => &["obs_qsv11_v2", "obs_qsv11"],
            "amd" => &["h264_texture_amf", "amd_amf_h264"],
            _ => &["obs_x264"],
        };
        for c in candidates {
            if self.caps_encoders.iter().any(|e| e.id == *c) {
                return (*c).to_string();
            }
        }
        if family != "x264" {
            log::warn!("simple encoder family '{family}' not available â€” falling back to obs_x264");
        }
        "obs_x264".into()
    }

    /// `dir`/`stem` override the profile's captures dir + FilenameFormatting for
    /// this one recording (scrim auto-filing) â€” both still create_dir_all /
    /// sanitize / unique_path like the defaults.
    fn start_record(&mut self, dir: Option<&str>, stem: Option<&str>) -> Result<Value, ProtoError> {
        if self.recording.is_some() {
            return Err(ProtoError::busy("already recording"));
        }
        if self.finalizing {
            return Err(ProtoError::busy("finalizing previous recording"));
        }
        if self.current.is_none() {
            return Err(ProtoError::bad_request("no current scene"));
        }
        let dir = dir.map(std::path::PathBuf::from).unwrap_or_else(captures_dir);
        std::fs::create_dir_all(&dir)
            .map_err(|e| ProtoError::internal(format!("captures dir: {e}")))?;

        let format = self.profile.get_or("SimpleOutput", "RecFormat2", "hybrid_mp4").to_string();
        let (out_id, ext) = container_for(&format);
        let template = self
            .profile
            .get_or("Output", "FilenameFormatting", "%CCYY-%MM-%DD %hh-%mm-%ss")
            .to_string();
        let stem = sanitize_filename(&stem.map(str::to_owned).unwrap_or_else(|| namer::format_filename(&template)));
        let stem = if stem.is_empty() { format!("Broadcast {}", local_timestamp_stem()) } else { stem };
        let path = unique_path(&dir, &stem, ext);
        let path_str = path.to_string_lossy().into_owned();

        self.ensure_encoders()?;
        let (venc, aencs) = {
            let e = self.encoders.as_ref().unwrap();
            (e.venc, e.aencs.clone())
        };

        // Auto-split thresholds ride the output settings (OBS muxer keys;
        // identical on ffmpeg_muxer and mp4_output).
        let mut out_settings_v = json!({ "path": path_str });
        if self.profile.get_bool("AdvOut", "RecSplitFile", false) {
            let (t, s) = match self.profile.get_or("AdvOut", "RecSplitFileType", "Time") {
                "Size" => (0, self.profile.get_u32("AdvOut", "RecSplitFileSize", 2048)),
                "Manual" => (0, 0),
                _ => (self.profile.get_u32("AdvOut", "RecSplitFileTime", 15).saturating_mul(60), 0),
            };
            let o = out_settings_v.as_object_mut().unwrap();
            o.insert("split_file".into(), json!(true));
            o.insert("max_time_sec".into(), json!(t));
            o.insert("max_size_mb".into(), json!(s));
            // Segments AFTER the first are named by libobs from these keys
            // (mp4_output::generate_filename reads directory/format/extension/
            // allow_spaces; the first file uses `path` above). Omitting them made
            // the muxer build a NULL next-filename, fail to reopen, and UAF-crash
            // on finalise (mp4-output.c:473). Mirrors start_replay's proven config.
            o.insert("directory".into(), json!(dir.to_string_lossy()));
            o.insert("format".into(), json!(namer::expand_game(&template)));
            o.insert("extension".into(), json!(ext));
            o.insert("allow_spaces".into(), json!(true));
        }

        unsafe {
            let out_settings = data_from_value(&out_settings_v);
            let out_id_c = cstring(out_id);
            let out_name = cstring("rec_out");
            let output = ffi::obs_output_create(out_id_c.as_ptr(), out_name.as_ptr(), out_settings, std::ptr::null_mut());
            ffi::obs_data_release(out_settings);
            if output.is_null() {
                self.drop_encoders_if_idle();
                return Err(ProtoError::internal(format!("{out_id} create failed")));
            }
            ffi::obs_output_set_video_encoder(output, venc);
            for (slot, (_, aenc)) in aencs.iter().enumerate() {
                ffi::obs_output_set_audio_encoder(output, *aenc, slot);
            }

            if !ffi::obs_output_start(output) {
                let err = ffi::obs_output_get_last_error(output);
                let msg = if err.is_null() {
                    "obs_output_start failed".to_string()
                } else {
                    CStr::from_ptr(err).to_string_lossy().into_owned()
                };
                ffi::obs_output_release(output);
                self.drop_encoders_if_idle();
                return Err(ProtoError::internal(msg));
            }

            // Split-rollover tracking: connect file_changed (fires on the
            // muxer thread; callback only posts Cmd::FileChanged back here).
            let sig_ctx = {
                let sh = ffi::obs_output_get_signal_handler(output);
                if sh.is_null() {
                    std::ptr::null_mut()
                } else {
                    let ctx = Box::into_raw(Box::new(SignalCtx { tx: self.cmd_tx.clone() }));
                    ffi::signal_handler_connect(
                        sh,
                        c"file_changed".as_ptr(),
                        Some(on_file_changed),
                        ctx as *mut std::ffi::c_void,
                    );
                    ctx
                }
            };

            self.recording = Some(RecordingRun {
                output,
                path: path_str.clone(),
                started: Instant::now(),
                paused_at: None,
                paused_total: Duration::ZERO,
                sig_ctx,
            });
        }
        self.last_error = None;
        Ok(json!({ "path": path_str }))
    }

    fn stop_record(&mut self) -> Result<Value, ProtoError> {
        let run = self.recording.take().ok_or_else(|| ProtoError::bad_request("not recording"))?;
        self.finalizing = true;
        self.push_state();
        let path = run.path.clone();
        unsafe {
            ffi::obs_output_stop(run.output);
            // Single-flight verbs: block the engine thread until the muxer
            // finalizes (poll, 15 s ceiling â€” matches capture's finalize arc).
            let deadline = Instant::now() + Duration::from_secs(15);
            while ffi::obs_output_active(run.output) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            let still_active = ffi::obs_output_active(run.output);
            if !run.sig_ctx.is_null() {
                let sh = ffi::obs_output_get_signal_handler(run.output);
                if !sh.is_null() {
                    ffi::signal_handler_disconnect(
                        sh,
                        c"file_changed".as_ptr(),
                        Some(on_file_changed),
                        run.sig_ctx as *mut std::ffi::c_void,
                    );
                }
                drop(Box::from_raw(run.sig_ctx));
            }
            ffi::obs_output_release(run.output);
            self.finalizing = false;
            self.drop_encoders_if_idle();
            if still_active {
                return Err(ProtoError::internal("output did not finalize within 15s"));
            }
        }
        let auto_remux = self.profile.get_bool("Video", "AutoRemux", false);
        let _ = self
            .events
            .send(Event { event: "saved".into(), data: json!({ "path": path, "auto_remux": auto_remux }) });
        Ok(json!({ "path": path }))
    }

    /// Pause/resume the active recording (idempotent). The elapsed clock
    /// freezes across the span â€” both the engine (paused_total) and the UI
    /// chip (re-anchor on the paused edge) account for it.
    fn pause_record(&mut self, paused: bool) -> Result<Value, ProtoError> {
        let run = self.recording.as_mut().ok_or_else(|| ProtoError::bad_request("not recording"))?;
        if paused == run.paused_at.is_some() {
            return Ok(json!({}));
        }
        unsafe {
            if !ffi::obs_output_can_pause(run.output) {
                return Err(ProtoError::bad_request("this output cannot pause"));
            }
            if !ffi::obs_output_pause(run.output, paused) {
                return Err(ProtoError::internal("obs_output_pause refused"));
            }
        }
        if paused {
            run.paused_at = Some(Instant::now());
        } else if let Some(t) = run.paused_at.take() {
            run.paused_total += t.elapsed();
        }
        Ok(json!({}))
    }

    /// Manual split â€” the muxer's `split_file` proc. Only meaningful when the
    /// output was started with file splitting enabled; the proc reports that
    /// via its out param and we surface an honest error instead of a no-op.
    fn split_record(&mut self) -> Result<Value, ProtoError> {
        let run = self.recording.as_ref().ok_or_else(|| ProtoError::bad_request("not recording"))?;
        if run.paused_at.is_some() {
            return Err(ProtoError::busy("cannot split while paused"));
        }
        unsafe {
            let ph = ffi::obs_output_get_proc_handler(run.output);
            if ph.is_null() {
                return Err(ProtoError::internal("output has no proc handler"));
            }
            let mut cd: ffi::calldata_t = std::mem::zeroed();
            let called = ffi::proc_handler_call(ph, c"split_file".as_ptr(), &mut cd);
            let mut enabled = false;
            let _ = ffi::calldata_get_data(
                &cd,
                c"split_file_enabled".as_ptr(),
                &mut enabled as *mut bool as *mut std::ffi::c_void,
                std::mem::size_of::<bool>(),
            );
            calldata_free_rs(&mut cd);
            if !called || !enabled {
                return Err(ProtoError::bad_request(
                    "file splitting is not enabled on this recording (set it before starting)",
                ));
            }
        }
        Ok(json!({}))
    }

    // --- replay buffer (SP4 S3) -----------------------------------------------

    /// Arm the replay buffer: a `replay_buffer` output on the shared
    /// [`EncoderSet`] keeping the last RecRBTime seconds / RecRBSize MB.
    /// Idempotent when already armed. The filename `format` keeps its date
    /// tokens UNexpanded â€” libobs stamps them at save time; only `%game` is
    /// pre-expanded here (arm-time game â‰ˆ save-time game).
    fn start_replay(&mut self) -> Result<Value, ProtoError> {
        if self.replay.is_some() {
            return Ok(json!({}));
        }
        let dir = captures_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| ProtoError::internal(format!("captures dir: {e}")))?;
        let prefix = self.profile.get_or("SimpleOutput", "RecRBPrefix", "Replay").to_string();
        let template = self
            .profile
            .get_or("Output", "FilenameFormatting", "%CCYY-%MM-%DD %hh-%mm-%ss")
            .to_string();
        let format = namer::expand_game(&format!("{prefix} {template}"));
        let container = self.profile.get_or("SimpleOutput", "RecFormat2", "hybrid_mp4").to_string();
        let (_out, ext) = container_for(&container);
        let time = self.profile.get_u32("SimpleOutput", "RecRBTime", 30);
        let size = self.profile.get_u32("SimpleOutput", "RecRBSize", 512);

        self.ensure_encoders()?;
        let (venc, aencs) = {
            let e = self.encoders.as_ref().unwrap();
            (e.venc, e.aencs.clone())
        };

        let settings_v = json!({
            "directory": dir.to_string_lossy(),
            "format": format,
            "extension": ext,
            "allow_spaces": true,
            "max_time_sec": time,
            "max_size_mb": size,
        });
        unsafe {
            let settings = data_from_value(&settings_v);
            let out_id = cstring("replay_buffer");
            let out_name = cstring("replay_out");
            let output = ffi::obs_output_create(out_id.as_ptr(), out_name.as_ptr(), settings, std::ptr::null_mut());
            ffi::obs_data_release(settings);
            if output.is_null() {
                self.drop_encoders_if_idle();
                return Err(ProtoError::internal("replay_buffer create failed"));
            }
            ffi::obs_output_set_video_encoder(output, venc);
            for (slot, (_, aenc)) in aencs.iter().enumerate() {
                ffi::obs_output_set_audio_encoder(output, *aenc, slot);
            }
            if !ffi::obs_output_start(output) {
                let err = ffi::obs_output_get_last_error(output);
                let msg = if err.is_null() {
                    "obs_output_start (replay_buffer) failed".to_string()
                } else {
                    CStr::from_ptr(err).to_string_lossy().into_owned()
                };
                ffi::obs_output_release(output);
                self.drop_encoders_if_idle();
                return Err(ProtoError::internal(msg));
            }
            // `saved` fires on a libobs thread â†’ the callback only posts a Cmd.
            let sig_ctx = {
                let sh = ffi::obs_output_get_signal_handler(output);
                if sh.is_null() {
                    std::ptr::null_mut()
                } else {
                    let ctx = Box::into_raw(Box::new(SignalCtx { tx: self.cmd_tx.clone() }));
                    ffi::signal_handler_connect(
                        sh,
                        c"saved".as_ptr(),
                        Some(on_replay_saved),
                        ctx as *mut std::ffi::c_void,
                    );
                    ctx
                }
            };
            self.replay = Some(ReplayRun { output, sig_ctx });
        }
        self.last_error = None;
        log::info!("replay armed: {time}s / {size}MB â†’ {}", dir.display());
        Ok(json!({}))
    }

    /// Disarm: stop the replay output, disconnect `saved`, release it, and drop
    /// the shared encoders if recording is also stopped (drop guard).
    fn stop_replay(&mut self) -> Result<Value, ProtoError> {
        let run = self.replay.take().ok_or_else(|| ProtoError::bad_request("replay not armed"))?;
        unsafe {
            ffi::obs_output_stop(run.output);
            let deadline = Instant::now() + Duration::from_secs(5);
            while ffi::obs_output_active(run.output) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            if !run.sig_ctx.is_null() {
                let sh = ffi::obs_output_get_signal_handler(run.output);
                if !sh.is_null() {
                    ffi::signal_handler_disconnect(
                        sh,
                        c"saved".as_ptr(),
                        Some(on_replay_saved),
                        run.sig_ctx as *mut std::ffi::c_void,
                    );
                }
                drop(Box::from_raw(run.sig_ctx));
            }
            ffi::obs_output_release(run.output);
        }
        self.drop_encoders_if_idle();
        Ok(json!({}))
    }

    /// Fire the `save` proc (fire-and-forget): the write is async; the `saved`
    /// signal (â†’ Cmd::ReplaySaved â†’ replay_saved) announces the finished file.
    fn save_replay(&mut self) -> Result<Value, ProtoError> {
        let run = self.replay.as_ref().ok_or_else(|| ProtoError::bad_request("replay not armed"))?;
        unsafe {
            let ph = ffi::obs_output_get_proc_handler(run.output);
            if ph.is_null() {
                return Err(ProtoError::internal("replay output has no proc handler"));
            }
            let mut cd: ffi::calldata_t = std::mem::zeroed();
            ffi::proc_handler_call(ph, c"save".as_ptr(), &mut cd);
            calldata_free_rs(&mut cd);
        }
        Ok(json!({}))
    }

    /// Engine-thread half of the replay `saved` signal: read the written path
    /// via the `get_last_replay` proc and emit it as a `replay_saved` event.
    fn replay_saved(&mut self) {
        let Some(run) = self.replay.as_ref() else { return };
        let path = unsafe {
            let ph = ffi::obs_output_get_proc_handler(run.output);
            if ph.is_null() {
                return;
            }
            let mut cd: ffi::calldata_t = std::mem::zeroed();
            let ok = ffi::proc_handler_call(ph, c"get_last_replay".as_ptr(), &mut cd);
            let mut s: *const std::os::raw::c_char = std::ptr::null();
            let path = if ok && ffi::calldata_get_string(&cd, c"path".as_ptr(), &mut s) && !s.is_null() {
                Some(CStr::from_ptr(s).to_string_lossy().into_owned())
            } else {
                None
            };
            calldata_free_rs(&mut cd);
            path
        };
        if let Some(path) = path {
            log::info!("replay saved: {path}");
            let _ = self.events.send(Event {
                event: "replay_saved".into(),
                data: json!({ "path": path }),
            });
            self.push_state();
        }
    }

    // --- streaming: service model (SP5 SF1) ------------------------------------

    /// The rtmp-services catalog, resolved the same way libobs resolves its own
    /// data â€” RELATIVE to the `bin/64bit` cwd contract, never an absolute path
    /// composed here. Passed through as raw JSON: it is 84 services of a
    /// ~200-field vendor schema that the UI shapes, so typing it engine-side
    /// would buy nothing and rot on every OBS bump.
    fn get_stream_services(&self) -> Result<Value, ProtoError> {
        const CATALOG: &str = "../../data/obs-plugins/rtmp-services/services.json";
        let text = std::fs::read_to_string(CATALOG).map_err(|e| {
            // The cwd is the whole story when this fails â€” name it in the error
            // rather than making the next reader guess which dir we were in.
            let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
            ProtoError::internal(format!("{CATALOG} (cwd {cwd}): {e}"))
        })?;
        serde_json::from_str(&text)
            .map_err(|e| ProtoError::internal(format!("services.json parse: {e}")))
    }

    /// Current service, or `null` when never configured (absence is a state,
    /// not an error â€” the UI renders its empty form off it).
    fn get_stream_service(&self) -> Result<Value, ProtoError> {
        match std::fs::read_to_string(service_path()) {
            Ok(t) => serde_json::from_str(&t)
                .map_err(|e| ProtoError::internal(format!("service.json parse: {e}"))),
            Err(_) => Ok(Value::Null),
        }
    }

    /// Persist `{type, settings}` verbatim (atomic tmp+rename, as Profile::save).
    /// The engine keeps the body OPAQUE â€” `rtmp_common`, `rtmp_custom`, and the
    /// later url/whip types differ only in their settings keys, so SF4/SF5 add
    /// service types without touching this. The key rides in plaintext exactly
    /// as OBS stores it; SF7 upgrades storage, not shape.
    fn set_stream_service(&mut self, service: &Value) -> Result<Value, ProtoError> {
        let obj = service
            .as_object()
            .ok_or_else(|| ProtoError::bad_request("service must be an object"))?;
        if !obj.get("type").is_some_and(Value::is_string) {
            return Err(ProtoError::bad_request("service.type must be a string"));
        }
        let path = service_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| ProtoError::internal(format!("profile dir: {e}")))?;
        }
        let body = serde_json::to_string_pretty(service)
            .map_err(|e| ProtoError::internal(format!("service encode: {e}")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| ProtoError::internal(format!("service write: {e}")))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| ProtoError::internal(format!("service rename: {e}")))?;
        log::info!("stream service set: type={}", obj["type"]);
        Ok(json!({}))
    }

    // --- streaming: go live (SP5 SF2) ------------------------------------------

    /// Route A encoder plan (M3.2 FORK T3, settled by `[SimpleOutput]
    /// RecQuality != "Stream"` on this profile): a CBR pair built fresh for the
    /// stream, never the shared record [`EncoderSet`]. CBR is what every RTMP
    /// service wants; the recording keeps its CRF quality untouched.
    fn stream_encoder_plan(&self) -> (String, Value) {
        let rec_family = self.profile.get_or("SimpleOutput", "RecEncoder", "x264").to_string();
        let family = self.profile.get_or("SimpleOutput", "StreamEncoder", &rec_family).to_string();
        let bitrate = self.profile.get_u32("SimpleOutput", "VBitrate", 2500);
        let mut settings = json!({ "rate_control": "CBR", "bitrate": bitrate, "keyint_sec": 2 });
        if family == "x264" {
            settings["preset"] = json!("veryfast");
        }
        (self.resolve_encoder_id(&family), settings)
    }

    /// Build the service + a dedicated encoder pair + `rtmp_output`, wire the
    /// six lifecycle signals, and start. Status then rides the signals â€” this
    /// verb returns as soon as libobs accepts the start, NOT when the stream is
    /// live (connecting is a real state the UI shows).
    fn start_stream(&mut self) -> Result<Value, ProtoError> {
        if self.stream.is_some() {
            return Err(ProtoError::busy("already streaming"));
        }
        if self.current.is_none() {
            return Err(ProtoError::bad_request("no current scene"));
        }
        let cfg = self.get_stream_service()?;
        let obj = cfg
            .as_object()
            .ok_or_else(|| ProtoError::bad_request("no stream service configured"))?;
        let svc_type = obj
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtoError::bad_request("stream service has no type"))?
            .to_string();
        let svc_settings = obj.get("settings").cloned().unwrap_or_else(|| json!({}));

        let (venc_id, venc_settings) = self.stream_encoder_plan();
        let abitrate = self.profile.get_u32("SimpleOutput", "ABitrate", 160);
        // SF6 makes these configurable; the defaults are OBS's own. Retries 0 is
        // libobs's own "never reconnect", so the Reconnect toggle rides on it
        // rather than needing a second knob — MaxRetries keeps its value while off.
        let retries = if self.profile.get_bool("Output", "Reconnect", true) {
            self.profile.get_u32("Output", "MaxRetries", 25) as i32
        } else {
            0
        };
        let retry_sec = self.profile.get_u32("Output", "RetryDelay", 2) as i32;
        let delay_sec = self.profile.get_u32("Output", "DelaySec", 0);
        // M7.3: the whole dynamic-bitrate algorithm already ships INSIDE
        // rtmp_output (rtmp-stream.c's dbr_* — congestion sampling, step down,
        // recovery ramp). The frontend's entire job is this one flag, exactly as
        // OBS does it (SimpleOutput.cpp), key name included. The plugin self-gates
        // on OBS_ENCODER_CAP_DYN_BITRATE and self-disables when a delay is set.
        let dyn_bitrate = self.profile.get_bool("Output", "DynamicBitrate", false);
        // Echoed because "the setting silently did not apply" is the failure mode
        // for all four of these — libobs accepts and ignores rather than rejects.
        log::info!(
            "stream resilience: retries={retries} retry_sec={retry_sec} delay_sec={delay_sec} dyn_bitrate={dyn_bitrate}"
        );

        // SP5 SF4: SRT and RIST have NO obs_service in libobs â€” OBS drives them
        // straight off a URL through obs-ffmpeg's mpegts muxer, and `rtmp_custom`
        // will NOT resolve an srt:// server (proven: it builds an rtmp_output and
        // dies CONNECT_FAILED -2 without ever reaching the receiver). `type:"url"`
        // is that second path; every rtmp_common/rtmp_custom service keeps the
        // proven Phase-3 route untouched, service and all.
        let url_mode = svc_type == "url";
        let stream_url = if url_mode {
            Some(
                svc_settings
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|u| !u.is_empty())
                    .ok_or_else(|| ProtoError::bad_request("url service has no url"))?
                    .to_string(),
            )
        } else {
            None
        };

        self.stream_error = None;
        unsafe {
            // Even URL transports need a service object: libobs refuses to start
            // any OBS_OUTPUT_SERVICE-flagged output with none attached, and does
            // it SILENTLY (obs_output_start returns false, nothing logged). So
            // SRT/RIST ride a plain rtmp_custom whose `server` IS the URL, which
            // is also where obs-ffmpeg reads its destination from.
            let (svc_id, svc_data) = match &stream_url {
                Some(url) => ("rtmp_custom".to_string(), json!({ "server": url, "key": "" })),
                None => (svc_type.clone(), svc_settings.clone()),
            };
            let service = {
                let sdata = data_from_value(&svc_data);
                let sid = cstring(&svc_id);
                let sname = cstring("bcast_service");
                let s = ffi::obs_service_create(sid.as_ptr(), sname.as_ptr(), sdata, std::ptr::null_mut());
                ffi::obs_data_release(sdata);
                if s.is_null() {
                    return Err(ProtoError::internal(format!("service '{svc_id}' create failed")));
                }
                s
            };

            // Service clamps (max bitrate, forced codec) land on the STREAM
            // encoder settings only â€” the record EncoderSet is never touched.
            let vdata = data_from_value(&venc_settings);
            let adata = data_from_value(&json!({ "bitrate": abitrate }));
            ffi::obs_service_apply_encoder_settings(service, vdata, adata);

            // WebRTC carries no AAC: whip_output declares `opus` as its only
            // encoded audio codec (obs-webrtc calls addOpusCodec and nothing
            // else), and libobs's pre-start codec check rejects a mismatch —
            // one more start that fails without saying why. RTMP keeps AAC.
            let aenc_id = if svc_type == "whip_custom" { "ffmpeg_opus" } else { "ffmpeg_aac" };
            let vid = cstring(&venc_id);
            let aid = cstring(aenc_id);
            let venc = ffi::obs_video_encoder_create(vid.as_ptr(), c"bcast_stream_venc".as_ptr(), vdata, std::ptr::null_mut());
            let aenc = ffi::obs_audio_encoder_create(aid.as_ptr(), c"bcast_stream_aenc".as_ptr(), adata, 0, std::ptr::null_mut());
            ffi::obs_data_release(vdata);
            ffi::obs_data_release(adata);
            if venc.is_null() || aenc.is_null() {
                if !venc.is_null() {
                    ffi::obs_encoder_release(venc);
                }
                if !aenc.is_null() {
                    ffi::obs_encoder_release(aenc);
                }
                ffi::obs_service_release(service);
                return Err(ProtoError::internal(format!("stream encoder '{venc_id}' create failed")));
            }
            ffi::obs_encoder_set_video(venc, ffi::obs_get_video());
            ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());

            // The mpegts muxer takes its destination as an output SETTING;
            // rtmp_output and whip_output read theirs off the SERVICE instead
            // (obs-webrtc imports obs_output_get_service and pulls `server` +
            // `bearer_token` from it), so the service block above needs no WHIP
            // case at all — `whip_custom` rides through opaque like any other.
            let (out_id, out_json) = match (&stream_url, svc_type.as_str()) {
                (Some(url), _) => ("ffmpeg_mpegts_muxer", json!({ "url": url })),
                (None, "whip_custom") => ("whip_output", json!({})),
                _ => ("rtmp_output", json!({ "dyn_bitrate": dyn_bitrate })),
            };
            log::info!("stream transport: output='{out_id}'");
            let out_settings = data_from_value(&out_json);
            let oid = cstring(out_id);
            let output = ffi::obs_output_create(oid.as_ptr(), c"stream_out".as_ptr(), out_settings, std::ptr::null_mut());
            ffi::obs_data_release(out_settings);
            if output.is_null() {
                ffi::obs_encoder_release(venc);
                ffi::obs_encoder_release(aenc);
                ffi::obs_service_release(service);
                // A null mpegts muxer means obs-ffmpeg never registered it, i.e.
                // the payload lacks srt/rist support â€” abort condition 5, not a
                // bug to iterate on.
                return Err(ProtoError::internal(format!("output '{out_id}' create failed")));
            }

            // Ordering mirrors start_record's rec_out, plus the stream-only
            // legs: encoders, then service, then reconnect settings â€” all
            // BEFORE start, or libobs silently ignores them.
            ffi::obs_output_set_video_encoder(output, venc);
            ffi::obs_output_set_audio_encoder(output, aenc, 0);
            ffi::obs_output_set_service(output, service);
            ffi::obs_output_set_reconnect_settings(output, retries, retry_sec);
            // PRESERVE keeps the buffered delay across a reconnect instead of
            // discarding it — the two SF6 knobs are meant to survive together.
            ffi::obs_output_set_delay(output, delay_sec, ffi::OBS_OUTPUT_DELAY_PRESERVE);

            // Signals connect BEFORE start so `starting`/`start` can't be missed.
            let sig_ctx = {
                let sh = ffi::obs_output_get_signal_handler(output);
                if sh.is_null() {
                    std::ptr::null_mut()
                } else {
                    let ctx = Box::into_raw(Box::new(SignalCtx { tx: self.cmd_tx.clone() }));
                    for (name, cb) in STREAM_SIGNALS {
                        ffi::signal_handler_connect(sh, name.as_ptr(), cb, ctx as *mut std::ffi::c_void);
                    }
                    ctx
                }
            };

            if !ffi::obs_output_start(output) {
                let err = ffi::obs_output_get_last_error(output);
                let msg = if err.is_null() {
                    "obs_output_start (stream) failed".to_string()
                } else {
                    CStr::from_ptr(err).to_string_lossy().into_owned()
                };
                release_stream(StreamRun {
                    output,
                    service,
                    venc,
                    aenc,
                    started: None,
                    status: "connecting",
                    reconnects: 0,
                    sig_ctx,
                });
                return Err(ProtoError::internal(msg));
            }

            log::info!("stream starting: service={svc_type} encoder={venc_id}");
            self.stream = Some(StreamRun {
                output,
                service,
                venc,
                aenc,
                started: None,
                status: "connecting",
                reconnects: 0,
                sig_ctx,
            });
        }
        self.last_error = None;
        Ok(json!({}))
    }

    fn stop_stream(&mut self) -> Result<Value, ProtoError> {
        let run = self.stream.take().ok_or_else(|| ProtoError::bad_request("not streaming"))?;
        unsafe {
            ffi::obs_output_stop(run.output);
            // Single-flight, same as stop_record: hold the engine thread until
            // libobs has torn the connection down, so the release below cannot
            // race the network thread. The `stop` signal still fires, finds no
            // run, and returns â€” that is what prevents a double free.
            let deadline = Instant::now() + Duration::from_secs(10);
            while ffi::obs_output_active(run.output) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            release_stream(run);
        }
        self.stream_error = None;
        log::info!("stream stopped by request");
        Ok(json!({}))
    }

    /// Raw output counters (SP5 SF3). Deliberately a POLL verb, not an event:
    /// the frontend asks every 2 s while live and does its own delta math for
    /// kbps, so the engine reports counters and owns no timer. Idle answers
    /// `{active:false}` â€” absence of a stream is not an error.
    fn get_stream_stats(&self) -> Result<Value, ProtoError> {
        let Some(run) = self.stream.as_ref() else {
            return Ok(json!({ "active": false }));
        };
        // All obs_* on the engine thread, off the run's owned handle â€” never a
        // pointer cached in a socket task, which a reconnect would dangle.
        unsafe {
            Ok(json!({
                "active": true,
                "status": run.status,
                "total_bytes": ffi::obs_output_get_total_bytes(run.output),
                "frames_dropped": ffi::obs_output_get_frames_dropped(run.output),
                "total_frames": ffi::obs_output_get_total_frames(run.output),
                "congestion": ffi::obs_output_get_congestion(run.output),
                "reconnects": run.reconnects,
                "elapsed_ns": run.started.map_or(0, |t| t.elapsed().as_nanos() as u64),
            }))
        }
    }

    /// Every libobs stream signal lands here, on the engine thread. Each arm
    /// ends in a state push â€” a missed push is what leaves the UI stuck on
    /// `connecting` while the log says live.
    fn on_stream_signal(&mut self, kind: &'static str, code: i64) {
        if kind == "stop" {
            // Unsolicited death (retries exhausted, server hung up). A
            // requested stop already took the run, so this is a no-op there.
            let Some(run) = self.stream.take() else { return };
            self.stream_error = stop_code_message(code);
            if let Some(e) = &self.stream_error {
                log::warn!("stream stopped: {e}");
            }
            unsafe { release_stream(run) };
            self.push_state();
            return;
        }
        let Some(run) = self.stream.as_mut() else { return };
        match kind {
            "starting" => run.status = "connecting",
            "start" => {
                run.status = "live";
                run.started = Some(Instant::now());
            }
            "stopping" => run.status = "stopping",
            "reconnect" => run.status = "reconnecting",
            "reconnect_success" => {
                run.status = "live";
                run.reconnects += 1;
            }
            _ => return,
        }
        log::info!("stream signal '{kind}' â†’ {}", run.status);
        self.push_state();
    }

    // --- output settings (SP4) -------------------------------------------------

    /// Merge a `{section: {key: value}}` patch into the profile. Video /
    /// encoder sections are locked while any output is active (shared encode
    /// session â€” the UI surfaces the disarm affordance); [Output] keys
    /// (filename template, mode) are always accepted.
    fn set_output_settings(&mut self, patch: &Value) -> Result<Value, ProtoError> {
        let touches = |sec: &str| {
            patch
                .get(sec)
                .and_then(Value::as_object)
                .map(|o| !o.is_empty())
                .unwrap_or(false)
        };
        // A live stream counts as active too: it holds its own encoders but
        // shares the video pipeline, so a reset_video underneath it would kill
        // the broadcast mid-flight.
        let active =
            self.recording.is_some() || self.finalizing || self.replay_armed() || self.stream.is_some();
        if active && (touches("Video") || touches("SimpleOutput") || touches("AdvOut")) {
            return Err(ProtoError::busy(
                "stop streaming / recording, disarm replay before changing output settings",
            ));
        }
        self.profile.apply_patch(patch);
        self.profile
            .save()
            .map_err(|e| ProtoError::internal(format!("profile save: {e}")))?;
        if touches("Video") {
            // Fully idle here (guard above) â€” geometry/fps re-apply is safe.
            crate::obs::reset_video(&video_cfg_from(&self.profile)).map_err(ProtoError::internal)?;
        }
        self.drop_encoders_if_idle();
        Ok(json!({ "profile": self.profile.to_json() }))
    }

    /// Encoder props for the advanced output page â€” the SAME PropSpec wire
    /// shape as source get_properties, rendered by the same form.
    fn get_encoder_properties(&self, id: &str) -> Result<Value, ProtoError> {
        unsafe {
            let cid = cstring(id);
            let props = ffi::obs_get_encoder_properties(cid.as_ptr());
            if props.is_null() {
                return Err(ProtoError::bad_request(format!("no encoder '{id}'")));
            }
            let list = props_to_json(props);
            ffi::obs_properties_destroy(props);

            let base = ffi::obs_encoder_defaults(cid.as_ptr());
            if base.is_null() {
                return Ok(json!({ "props": list, "settings": {} }));
            }
            let file = record_encoder_path();
            if file.exists() {
                let cpath = cstring(&file.to_string_lossy());
                let over = ffi::obs_data_create_from_json_file(cpath.as_ptr());
                if !over.is_null() {
                    ffi::obs_data_apply(base, over);
                    ffi::obs_data_release(over);
                }
            }
            let js = ffi::obs_data_get_json_with_defaults(base);
            let settings = if js.is_null() {
                json!({})
            } else {
                serde_json::from_str(&CStr::from_ptr(js).to_string_lossy()).unwrap_or_else(|_| json!({}))
            };
            ffi::obs_data_release(base);
            Ok(json!({ "props": list, "settings": settings }))
        }
    }

    /// Merge advanced encoder settings into recordEncoder.json (OBS's own
    /// per-profile filename, written through obs_data for format fidelity).
    fn set_encoder_settings(&mut self, settings: &Value) -> Result<Value, ProtoError> {
        let file = record_encoder_path();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        unsafe {
            let cpath = cstring(&file.to_string_lossy());
            let existing = if file.exists() {
                let d = ffi::obs_data_create_from_json_file(cpath.as_ptr());
                if d.is_null() { ffi::obs_data_create() } else { d }
            } else {
                ffi::obs_data_create()
            };
            let patch = data_from_value(settings);
            ffi::obs_data_apply(existing, patch);
            ffi::obs_data_release(patch);
            let ok = ffi::obs_data_save_json(existing, cpath.as_ptr());
            ffi::obs_data_release(existing);
            if !ok {
                return Err(ProtoError::internal("recordEncoder.json save failed"));
            }
        }
        self.drop_encoders_if_idle();
        Ok(json!({}))
    }

    // --- persistence (SF3) ----------------------------------------------------

    /// OBS-native persistence: the `sources` array is exactly
    /// `obs_save_sources()` output (what obs_load_sources consumes).
    fn save_collection(&self) {
        let path = collection_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        unsafe {
            let root = ffi::obs_data_create();
            let cur = cstring(self.current.as_deref().unwrap_or(""));
            let key_cur = cstring("current_scene");
            ffi::obs_data_set_string(root, key_cur.as_ptr(), cur.as_ptr());
            let arr = ffi::obs_save_sources();
            let key_src = cstring("sources");
            ffi::obs_data_set_array(root, key_src.as_ptr(), arr);
            let cpath = cstring(&path.to_string_lossy());
            if !ffi::obs_data_save_json(root, cpath.as_ptr()) {
                log::warn!("collection save failed: {}", path.display());
            }
            ffi::obs_data_array_release(arr);
            ffi::obs_data_release(root);
        }
        // Scene ORDER sidecar â€” obs_save_sources order is not ours to control,
        // and the UI's scene list order is user-meaningful (reorder_scenes).
        let names: Vec<&str> = self.scenes.iter().map(|(n, _)| n.as_str()).collect();
        if let Ok(json) = serde_json::to_string(&names) {
            let _ = std::fs::write(scene_order_path(), json);
        }
    }

    fn load_collection(&mut self) {
        let path = collection_path();
        if !path.exists() {
            log::info!("no scene collection at {} (fresh start)", path.display());
            return;
        }
        unsafe {
            let cpath = cstring(&path.to_string_lossy());
            let root = ffi::obs_data_create_from_json_file(cpath.as_ptr());
            if root.is_null() {
                log::warn!("collection unreadable: {}", path.display());
                return;
            }
            let key_src = cstring("sources");
            let arr = ffi::obs_data_get_array(root, key_src.as_ptr());
            if !arr.is_null() {
                ffi::obs_load_sources(arr, None, std::ptr::null_mut());
                ffi::obs_data_array_release(arr);
            }
            // Rebuild the owned scene list from what obs_load_sources created.
            unsafe extern "C" fn collect(param: *mut std::ffi::c_void, src: *mut ffi::obs_source) -> bool {
                let out = unsafe { &mut *(param as *mut Vec<(String, *mut ffi::obs_scene)>) };
                let scene = unsafe { ffi::obs_scene_from_source(src) };
                if !scene.is_null() {
                    let name = unsafe { CStr::from_ptr(ffi::obs_source_get_name(src)) }
                        .to_string_lossy()
                        .into_owned();
                    let owned = unsafe { ffi::obs_scene_get_ref(scene) };
                    out.push((name, owned));
                }
                true
            }
            ffi::obs_enum_scenes(Some(collect), &mut self.scenes as *mut _ as *mut std::ffi::c_void);

            // Apply the persisted scene order (sidecar); unknown names keep
            // their enum order at the end.
            if let Ok(txt) = std::fs::read_to_string(scene_order_path()) {
                if let Ok(order) = serde_json::from_str::<Vec<String>>(&txt) {
                    self.scenes.sort_by_key(|(n, _)| {
                        order.iter().position(|o| o == n).unwrap_or(usize::MAX)
                    });
                }
            }

            let key_cur = cstring("current_scene");
            let cur = ffi::obs_data_get_string(root, key_cur.as_ptr());
            let cur = if cur.is_null() { String::new() } else { CStr::from_ptr(cur).to_string_lossy().into_owned() };
            ffi::obs_data_release(root);
            if !cur.is_empty() && self.find_scene(&cur).is_some() {
                let _ = self.set_current_scene(&cur);
            } else if let Some((first, _)) = self.scenes.first() {
                let first = first.clone();
                let _ = self.set_current_scene(&first);
            }
            log::info!("collection loaded: {} scene(s), current={:?}", self.scenes.len(), self.current);
        }
    }

    fn teardown(&mut self) {
        // Displays first: their swapchains must die before ObsCore drops.
        for (_, d) in self.displays.drain(..) {
            unsafe { ffi::obs_display_destroy(d) };
        }
        self.picker_close();
        if self.stream.is_some() {
            let _ = self.stop_stream();
        }
        if self.recording.is_some() {
            let _ = self.stop_record();
        }
        // Disarm replay before the encoder drop â€” the idle guard blocks the
        // release while a replay output is still alive.
        if self.replay.is_some() {
            let _ = self.stop_replay();
        }
        self.drop_encoders_if_idle();
        // Meters before the sources they are attached to (SP6).
        self.detach_volmeters();
        self.meters_on.store(false, Ordering::Relaxed);
        self.save_collection();
        unsafe {
            if !self.scratch_fader.is_null() {
                ffi::obs_fader_detach_source(self.scratch_fader);
                ffi::obs_fader_destroy(self.scratch_fader);
                self.scratch_fader = std::ptr::null_mut();
            }
            // 0 = program scene; 1..=6 = the global audio channels (SP6 wired
            // 3..6, SP1/SP4 wired 1 and 2).
            for ch in 0..=6u32 {
                ffi::obs_set_output_source(ch, std::ptr::null_mut());
            }
            for (_, scene) in self.scenes.drain(..) {
                ffi::obs_scene_release(scene);
            }
        }
        // self.core drops here â†’ obs_shutdown.
    }
}

// --- SP4 free helpers --------------------------------------------------------

/// `[Video]` profile section â†’ the obs_reset_video geometry.
fn video_cfg_from(p: &Profile) -> VideoCfg {
    VideoCfg {
        base_w: p.get_u32("Video", "BaseCX", 1920),
        base_h: p.get_u32("Video", "BaseCY", 1080),
        out_w: p.get_u32("Video", "OutputCX", 1920),
        out_h: p.get_u32("Video", "OutputCY", 1080),
        fps: p.get_u32("Video", "FPSCommon", 60),
    }
}

/// RecFormat2 â†’ (libobs output type id, file extension). Frontend mapping
/// port: hybrid containers are the obs-outputs muxers, everything else rides
/// ffmpeg_muxer with the extension selecting the format.
fn container_for(fmt: &str) -> (&'static str, &'static str) {
    match fmt {
        "mkv" => ("ffmpeg_muxer", "mkv"),
        "mp4" => ("ffmpeg_muxer", "mp4"),
        "mov" => ("ffmpeg_muxer", "mov"),
        "hybrid_mov" => ("mov_output", "mov"),
        _ => ("mp4_output", "mp4"), // hybrid_mp4 (default) + unknowns
    }
}

/// SimpleOutput::CalcCRF port (CROSS_DIST_CUTOFF 2000): the quality CRF eases
/// down (better) as the output diagonal shrinks below 2000 px.
fn calc_crf(base: i32, out_w: u32, out_h: u32) -> i32 {
    const CROSS_DIST_CUTOFF: f64 = 2000.0;
    let dist = ((out_w as f64).powi(2) + (out_h as f64).powi(2)).sqrt();
    let reduction = (1.0 - (dist.min(CROSS_DIST_CUTOFF) / CROSS_DIST_CUTOFF)) * 10.0;
    base - reduction as i32
}

/// One safe Windows filename component: template output may carry user-typed
/// separators/reserved chars; %game is pre-sanitized but the rest is not.
fn sanitize_filename(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    mapped.trim().trim_matches('.').trim().to_string()
}

/// First free `<stem>.<ext>` / `<stem> (n).<ext>` (capture clip_mp4_path
/// dedupe precedent).
fn unique_path(dir: &std::path::Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for i in 2u32.. {
        let p = dir.join(format!("{stem} ({i}).{ext}"));
        if !p.exists() {
            return p;
        }
    }
    unreachable!()
}

/// Boot-time video encoder enumeration (h264/hevc/av1, non-deprecated,
/// non-internal) â€” snapshot caps + simple-family resolution both read this.
unsafe fn enumerate_encoder_types() -> Vec<EncoderInfo> {
    let mut out = Vec::new();
    unsafe {
        let mut idx = 0usize;
        loop {
            let mut id: *const std::os::raw::c_char = std::ptr::null();
            if !ffi::obs_enum_encoder_types(idx, &mut id) {
                break;
            }
            idx += 1;
            if id.is_null() {
                continue;
            }
            if ffi::obs_get_encoder_type(id) != ffi::obs_encoder_type_OBS_ENCODER_VIDEO {
                continue;
            }
            let caps = ffi::obs_get_encoder_caps(id);
            if caps & (ffi::OBS_ENCODER_CAP_DEPRECATED | ffi::OBS_ENCODER_CAP_INTERNAL) != 0 {
                continue;
            }
            let codec = cstr_owned(ffi::obs_get_encoder_codec(id));
            if !matches!(codec.as_str(), "h264" | "hevc" | "av1") {
                continue;
            }
            let display = ffi::obs_encoder_get_display_name(id);
            out.push(EncoderInfo {
                id: cstr_owned(id),
                display_name: if display.is_null() { cstr_owned(id) } else { cstr_owned(display) },
                codec,
            });
        }
    }
    log::info!("encoder types: {}", out.iter().map(|e| e.id.as_str()).collect::<Vec<_>>().join(", "));
    out
}

/// First non-sentinel entry of a source's "monitor_id" list property â€”
/// enumerated by the plugin itself, so ordering matches the OBS UI (primary
/// first). None when the property is missing or only "DUMMY" exists.
unsafe fn first_real_monitor_id(src: *mut ffi::obs_source) -> Option<String> {
    unsafe {
        let props = ffi::obs_source_properties(src);
        if props.is_null() {
            return None;
        }
        let key = cstring("monitor_id");
        let p = ffi::obs_properties_get(props, key.as_ptr());
        let mut found = None;
        if !p.is_null() {
            let count = ffi::obs_property_list_item_count(p);
            for i in 0..count {
                let s = ffi::obs_property_list_item_string(p, i);
                if s.is_null() {
                    continue;
                }
                let s = CStr::from_ptr(s).to_string_lossy();
                if s != "DUMMY" && !s.is_empty() {
                    found = Some(s.into_owned());
                    break;
                }
            }
        }
        ffi::obs_properties_destroy(props);
        found
    }
}

// libobs graphics API â€” exported by obs.dll but outside the bindgen allowlist
// (`obs_.*` only; see scripts/regen-bindings.ps1). Hand-declared, matching
// graphics/graphics.h signatures (vsnprintf-extern precedent in obs/mod.rs).
unsafe extern "C" {
    fn gs_viewport_push();
    fn gs_viewport_pop();
    fn gs_projection_push();
    fn gs_projection_pop();
    fn gs_ortho(left: f32, right: f32, top: f32, bottom: f32, znear: f32, zfar: f32);
    fn gs_set_viewport(x: i32, y: i32, width: i32, height: i32);
    // libobs base allocator â€” calldata stacks are balloc'd; calldata_free is
    // a static inline (no export), so its one-line body is ported below.
    fn bfree(ptr: *mut std::ffi::c_void);
}

/// calldata_free port (callback/calldata.h static inline): free the heap
/// stack a proc/signal wrote into a zero-initialized calldata.
unsafe fn calldata_free_rs(cd: &mut ffi::calldata_t) {
    unsafe {
        if !cd.fixed && !cd.stack.is_null() {
            bfree(cd.stack as *mut std::ffi::c_void);
        }
    }
    cd.stack = std::ptr::null_mut();
    cd.size = 0;
    cd.capacity = 0;
}

/// Display draw callback â€” runs on OBS's internal graphics thread; body is
/// pure gs calls + obs_render_main_texture. The region is exact-fit (app
/// sizes it to the canvas aspect), so there is no letterbox math here â€”
/// ortho over the full base canvas, viewport over the full display. param is
/// null: one static fn serves every display, no Rust context lifetime.
unsafe extern "C" fn draw_main(_param: *mut std::ffi::c_void, cx: u32, cy: u32) {
    unsafe {
        let mut ovi: ffi::obs_video_info = std::mem::zeroed();
        if !ffi::obs_get_video_info(&mut ovi) {
            return;
        }
        gs_viewport_push();
        gs_projection_push();
        gs_ortho(0.0, ovi.base_width as f32, 0.0, ovi.base_height as f32, -100.0, 100.0);
        gs_set_viewport(0, 0, cx as i32, cy as i32);
        ffi::obs_render_main_texture();
        // SP3: selection box + handles + hover outline + snap guides, drawn
        // in the same canvas ortho so they track the preview scale for free.
        overlay::draw_overlay(ovi.base_width, ovi.base_height, cx);
        gs_projection_pop();
        gs_viewport_pop();
    }
}

/// serde_json Value â†’ owned obs_data (caller releases).
unsafe fn data_from_value(v: &Value) -> *mut ffi::obs_data {
    let json = if v.is_null() { "{}".to_string() } else { v.to_string() };
    let c = cstring(&json);
    unsafe { ffi::obs_data_create_from_json(c.as_ptr()) }
}

/// v2 enumeration: wire order = obs_scene_enum_items order (BOTTOMâ†’TOP of
/// the render stack); group children nest under `children` with corners
/// composed through the group's draw transform (canvas space either way).
unsafe fn enum_scene_sources(scene: *mut ffi::obs_scene) -> Vec<SourceInfo> {
    struct EnumCtx {
        out: Vec<SourceInfo>,
        parent: Option<M4>,
    }
    unsafe extern "C" fn collect(
        _scene: *mut ffi::obs_scene,
        item: *mut ffi::obs_scene_item,
        param: *mut std::ffi::c_void,
    ) -> bool {
        unsafe {
            let ctx = &mut *(param as *mut EnumCtx);
            let src = ffi::obs_sceneitem_get_source(item);
            if src.is_null() {
                return true;
            }
            let is_group = ffi::obs_sceneitem_is_group(item);
            let id = CStr::from_ptr(ffi::obs_source_get_id(src)).to_string_lossy().into_owned();

            let mut ti: ffi::obs_transform_info = std::mem::zeroed();
            ffi::obs_sceneitem_get_info2(item, &mut ti);
            let mut cr: ffi::obs_sceneitem_crop = std::mem::zeroed();
            ffi::obs_sceneitem_get_crop(item, &mut cr);

            let children = if is_group {
                let mut sub = EnumCtx {
                    out: Vec::new(),
                    parent: Some(overlay::item_draw_transform(item)),
                };
                ffi::obs_sceneitem_group_enum_items(
                    item,
                    Some(collect),
                    &mut sub as *mut EnumCtx as *mut std::ffi::c_void,
                );
                sub.out
            } else {
                Vec::new()
            };

            ctx.out.push(SourceInfo {
                item_id: ffi::obs_sceneitem_get_id(item),
                name: CStr::from_ptr(ffi::obs_source_get_name(src)).to_string_lossy().into_owned(),
                is_scene: id == "scene",
                id,
                width: ffi::obs_source_get_width(src),
                height: ffi::obs_source_get_height(src),
                showing: ffi::obs_source_showing(src),
                active: ffi::obs_source_active(src),
                visible: ffi::obs_sceneitem_visible(item),
                locked: ffi::obs_sceneitem_locked(item),
                selected: ffi::obs_sceneitem_selected(item),
                is_group,
                transform: Transform {
                    pos_x: ti.pos.__bindgen_anon_1.__bindgen_anon_1.x,
                    pos_y: ti.pos.__bindgen_anon_1.__bindgen_anon_1.y,
                    rot: ti.rot,
                    scale_x: ti.scale.__bindgen_anon_1.__bindgen_anon_1.x,
                    scale_y: ti.scale.__bindgen_anon_1.__bindgen_anon_1.y,
                    alignment: ti.alignment,
                    bounds_type: ti.bounds_type,
                    bounds_alignment: ti.bounds_alignment,
                    bounds_x: ti.bounds.__bindgen_anon_1.__bindgen_anon_1.x,
                    bounds_y: ti.bounds.__bindgen_anon_1.__bindgen_anon_1.y,
                    crop_to_bounds: ti.crop_to_bounds,
                },
                crop: Crop { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom },
                corners: overlay::item_corners(item, ctx.parent.as_ref()),
                children,
            });
            true
        }
    }
    let mut ctx = EnumCtx { out: Vec::new(), parent: None };
    unsafe { ffi::obs_scene_enum_items(scene, Some(collect), &mut ctx as *mut EnumCtx as *mut std::ffi::c_void) };
    ctx.out
}

/// Deep item lookup â€” obs_scene_find_sceneitem_by_id does NOT recurse into
/// groups, so this is the one place group addressing lives (risk #6: every
/// item verb routes through with_item â†’ here).
unsafe fn find_item_deep(scene: *mut ffi::obs_scene, id: i64) -> Option<*mut ffi::obs_sceneitem_t> {
    struct FindCtx {
        id: i64,
        found: Option<*mut ffi::obs_sceneitem_t>,
    }
    unsafe extern "C" fn cb(
        _s: *mut ffi::obs_scene_t,
        item: *mut ffi::obs_sceneitem_t,
        param: *mut std::ffi::c_void,
    ) -> bool {
        unsafe {
            let ctx = &mut *(param as *mut FindCtx);
            if ffi::obs_sceneitem_get_id(item) == ctx.id {
                ctx.found = Some(item);
                return false;
            }
            if ffi::obs_sceneitem_is_group(item) {
                ffi::obs_sceneitem_group_enum_items(item, Some(cb), param);
                if ctx.found.is_some() {
                    return false;
                }
            }
            true
        }
    }
    let mut ctx = FindCtx { id, found: None };
    unsafe { ffi::obs_scene_enum_items(scene, Some(cb), &mut ctx as *mut FindCtx as *mut std::ffi::c_void) };
    ctx.found
}

unsafe fn name_taken(name: &str) -> bool {
    unsafe {
        let c = cstring(name);
        let s = ffi::obs_get_source_by_name(c.as_ptr());
        if s.is_null() {
            false
        } else {
            ffi::obs_source_release(s);
            true
        }
    }
}

/// First free "<base>" / "<base> N" (N from 2) â€” obs_source_create doesn't
/// dedupe and duplicates break name addressing.
unsafe fn free_name(base: &str) -> String {
    unsafe {
        if !name_taken(base) {
            return base.to_owned();
        }
        // u64: a u32 counter overflow-panics in debug / wraps into an infinite loop
        // in release if the suffix space is ever exhausted.
        for i in 2u64.. {
            let candidate = format!("{base} {i}");
            if !name_taken(&candidate) {
                return candidate;
            }
        }
        unreachable!()
    }
}

fn cstr_owned(p: *const std::os::raw::c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

/// Partial-overlay transform/crop patch: read get_info2/get_crop, overlay the
/// JSON-present fields, write back. Used by create_source, set_transform, and
/// transform_commit alike.
unsafe fn apply_transform_patch(item: *mut ffi::obs_sceneitem_t, transform: &Value, crop: &Value) {
    unsafe {
        if transform.is_object() {
            let mut ti: ffi::obs_transform_info = std::mem::zeroed();
            ffi::obs_sceneitem_get_info2(item, &mut ti);
            let f = |k: &str| transform.get(k).and_then(Value::as_f64).map(|v| v as f32);
            if let Some(v) = f("pos_x") {
                ti.pos.__bindgen_anon_1.__bindgen_anon_1.x = v;
            }
            if let Some(v) = f("pos_y") {
                ti.pos.__bindgen_anon_1.__bindgen_anon_1.y = v;
            }
            if let Some(v) = f("rot") {
                ti.rot = v;
            }
            if let Some(v) = f("scale_x") {
                ti.scale.__bindgen_anon_1.__bindgen_anon_1.x = v;
            }
            if let Some(v) = f("scale_y") {
                ti.scale.__bindgen_anon_1.__bindgen_anon_1.y = v;
            }
            if let Some(v) = transform.get("alignment").and_then(Value::as_u64) {
                ti.alignment = v as u32;
            }
            if let Some(v) = transform.get("bounds_type").and_then(Value::as_i64) {
                ti.bounds_type = v as ffi::obs_bounds_type;
            }
            if let Some(v) = transform.get("bounds_alignment").and_then(Value::as_u64) {
                ti.bounds_alignment = v as u32;
            }
            if let Some(v) = f("bounds_x") {
                ti.bounds.__bindgen_anon_1.__bindgen_anon_1.x = v;
            }
            if let Some(v) = f("bounds_y") {
                ti.bounds.__bindgen_anon_1.__bindgen_anon_1.y = v;
            }
            if let Some(v) = transform.get("crop_to_bounds").and_then(Value::as_bool) {
                ti.crop_to_bounds = v;
            }
            ffi::obs_sceneitem_set_info2(item, &ti);
        }
        if crop.is_object() {
            let mut cr: ffi::obs_sceneitem_crop = std::mem::zeroed();
            ffi::obs_sceneitem_get_crop(item, &mut cr);
            let g = |k: &str| crop.get(k).and_then(Value::as_i64).map(|v| v as i32);
            if let Some(v) = g("left") {
                cr.left = v;
            }
            if let Some(v) = g("top") {
                cr.top = v;
            }
            if let Some(v) = g("right") {
                cr.right = v;
            }
            if let Some(v) = g("bottom") {
                cr.bottom = v;
            }
            ffi::obs_sceneitem_set_crop(item, &cr);
        }
    }
}

/// Source settings as a JSON Value, defaults folded in (form seeding + undo
/// capture want the complete picture, not just explicitly-set keys).
unsafe fn source_settings_json(src: *mut ffi::obs_source) -> Value {
    unsafe {
        let data = ffi::obs_source_get_settings(src);
        if data.is_null() {
            return json!({});
        }
        let js = ffi::obs_data_get_json_with_defaults(data);
        let v = if js.is_null() {
            json!({})
        } else {
            serde_json::from_str(&CStr::from_ptr(js).to_string_lossy()).unwrap_or_else(|_| json!({}))
        };
        ffi::obs_data_release(data);
        v
    }
}

/// Monitor list via a throwaway PRIVATE monitor_capture's own "monitor_id"
/// property list (first_real_monitor_id generalized â€” plugin-enumerated, so
/// ordering matches the OBS UI: primary first). Returns (id, label) pairs.
unsafe fn enumerate_monitors() -> Vec<(String, String)> {
    unsafe {
        let cid = cstring("monitor_capture");
        let cname = cstring("__picker_probe");
        let probe = ffi::obs_source_create_private(cid.as_ptr(), cname.as_ptr(), std::ptr::null_mut());
        if probe.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let props = ffi::obs_source_properties(probe);
        if !props.is_null() {
            let key = cstring("monitor_id");
            let p = ffi::obs_properties_get(props, key.as_ptr());
            if !p.is_null() {
                let count = ffi::obs_property_list_item_count(p);
                for i in 0..count {
                    let sv = ffi::obs_property_list_item_string(p, i);
                    let nv = ffi::obs_property_list_item_name(p, i);
                    if sv.is_null() {
                        continue;
                    }
                    let ids = CStr::from_ptr(sv).to_string_lossy();
                    if ids == "DUMMY" || ids.is_empty() {
                        continue;
                    }
                    out.push((ids.into_owned(), cstr_owned(nv)));
                }
            }
            ffi::obs_properties_destroy(props);
        }
        ffi::obs_source_release(probe);
        out
    }
}

/// obs_properties â†’ PropSpec JSON list (recursing groups). The wire shape the
/// PropertiesForm renders; omitted keys = null-absent.
unsafe fn props_to_json(props: *mut ffi::obs_properties_t) -> Vec<Value> {
    unsafe {
        let mut out = Vec::new();
        let mut p = ffi::obs_properties_first(props);
        while !p.is_null() {
            let ty = ffi::obs_property_get_type(p);
            let type_name = match ty {
                ffi::obs_property_type_OBS_PROPERTY_BOOL => "bool",
                ffi::obs_property_type_OBS_PROPERTY_INT => "int",
                ffi::obs_property_type_OBS_PROPERTY_FLOAT => "float",
                ffi::obs_property_type_OBS_PROPERTY_TEXT => "text",
                ffi::obs_property_type_OBS_PROPERTY_PATH => "path",
                ffi::obs_property_type_OBS_PROPERTY_LIST => "list",
                ffi::obs_property_type_OBS_PROPERTY_COLOR => "color",
                ffi::obs_property_type_OBS_PROPERTY_BUTTON => "button",
                ffi::obs_property_type_OBS_PROPERTY_FONT => "font",
                ffi::obs_property_type_OBS_PROPERTY_EDITABLE_LIST => "editable_list",
                ffi::obs_property_type_OBS_PROPERTY_FRAME_RATE => "frame_rate",
                ffi::obs_property_type_OBS_PROPERTY_GROUP => "group",
                ffi::obs_property_type_OBS_PROPERTY_COLOR_ALPHA => "color_alpha",
                _ => "invalid",
            };
            let mut spec = serde_json::Map::new();
            spec.insert("name".into(), Value::String(cstr_owned(ffi::obs_property_name(p))));
            spec.insert("label".into(), Value::String(cstr_owned(ffi::obs_property_description(p))));
            spec.insert("type".into(), Value::String(type_name.into()));
            spec.insert("enabled".into(), Value::Bool(ffi::obs_property_enabled(p)));
            spec.insert("visible".into(), Value::Bool(ffi::obs_property_visible(p)));
            let long_desc = cstr_owned(ffi::obs_property_long_description(p));
            if !long_desc.is_empty() {
                spec.insert("long_desc".into(), Value::String(long_desc));
            }
            match ty {
                ffi::obs_property_type_OBS_PROPERTY_INT => {
                    spec.insert("min".into(), json!(ffi::obs_property_int_min(p)));
                    spec.insert("max".into(), json!(ffi::obs_property_int_max(p)));
                    spec.insert("step".into(), json!(ffi::obs_property_int_step(p)));
                    spec.insert(
                        "number_type".into(),
                        Value::String(
                            if ffi::obs_property_int_type(p) == ffi::obs_number_type_OBS_NUMBER_SLIDER {
                                "slider".into()
                            } else {
                                "scroller".to_string()
                            },
                        ),
                    );
                    let suffix = cstr_owned(ffi::obs_property_int_suffix(p));
                    if !suffix.is_empty() {
                        spec.insert("suffix".into(), Value::String(suffix));
                    }
                }
                ffi::obs_property_type_OBS_PROPERTY_FLOAT => {
                    spec.insert("min".into(), json!(ffi::obs_property_float_min(p)));
                    spec.insert("max".into(), json!(ffi::obs_property_float_max(p)));
                    spec.insert("step".into(), json!(ffi::obs_property_float_step(p)));
                    spec.insert(
                        "number_type".into(),
                        Value::String(
                            if ffi::obs_property_float_type(p) == ffi::obs_number_type_OBS_NUMBER_SLIDER {
                                "slider".into()
                            } else {
                                "scroller".to_string()
                            },
                        ),
                    );
                    let suffix = cstr_owned(ffi::obs_property_float_suffix(p));
                    if !suffix.is_empty() {
                        spec.insert("suffix".into(), Value::String(suffix));
                    }
                }
                ffi::obs_property_type_OBS_PROPERTY_TEXT => {
                    let tt = ffi::obs_property_text_type(p);
                    spec.insert(
                        "text_type".into(),
                        Value::String(
                            match tt {
                                ffi::obs_text_type_OBS_TEXT_PASSWORD => "password",
                                ffi::obs_text_type_OBS_TEXT_MULTILINE => "multiline",
                                ffi::obs_text_type_OBS_TEXT_INFO => "info",
                                _ => "default",
                            }
                            .into(),
                        ),
                    );
                    if tt == ffi::obs_text_type_OBS_TEXT_INFO {
                        spec.insert(
                            "info_type".into(),
                            Value::String(
                                match ffi::obs_property_text_info_type(p) {
                                    ffi::obs_text_info_type_OBS_TEXT_INFO_WARNING => "warning",
                                    ffi::obs_text_info_type_OBS_TEXT_INFO_ERROR => "error",
                                    _ => "normal",
                                }
                                .into(),
                            ),
                        );
                    }
                }
                ffi::obs_property_type_OBS_PROPERTY_PATH => {
                    spec.insert(
                        "path_type".into(),
                        Value::String(
                            match ffi::obs_property_path_type(p) {
                                ffi::obs_path_type_OBS_PATH_FILE_SAVE => "file_save",
                                ffi::obs_path_type_OBS_PATH_DIRECTORY => "directory",
                                _ => "file",
                            }
                            .into(),
                        ),
                    );
                    let filter = cstr_owned(ffi::obs_property_path_filter(p));
                    if !filter.is_empty() {
                        spec.insert("filter".into(), Value::String(filter));
                    }
                    let dp = cstr_owned(ffi::obs_property_path_default_path(p));
                    if !dp.is_empty() {
                        spec.insert("default_path".into(), Value::String(dp));
                    }
                }
                ffi::obs_property_type_OBS_PROPERTY_LIST => {
                    let format = ffi::obs_property_list_format(p);
                    spec.insert(
                        "list_type".into(),
                        Value::String(
                            match ffi::obs_property_list_type(p) {
                                ffi::obs_combo_type_OBS_COMBO_TYPE_EDITABLE => "editable",
                                ffi::obs_combo_type_OBS_COMBO_TYPE_RADIO => "radio",
                                _ => "list",
                            }
                            .into(),
                        ),
                    );
                    let fmt_name = match format {
                        ffi::obs_combo_format_OBS_COMBO_FORMAT_INT => "int",
                        ffi::obs_combo_format_OBS_COMBO_FORMAT_FLOAT => "float",
                        ffi::obs_combo_format_OBS_COMBO_FORMAT_BOOL => "bool",
                        _ => "string",
                    };
                    spec.insert("format".into(), Value::String(fmt_name.into()));
                    let mut items = Vec::new();
                    for i in 0..ffi::obs_property_list_item_count(p) {
                        let value = match format {
                            ffi::obs_combo_format_OBS_COMBO_FORMAT_INT => {
                                json!(ffi::obs_property_list_item_int(p, i))
                            }
                            ffi::obs_combo_format_OBS_COMBO_FORMAT_FLOAT => {
                                json!(ffi::obs_property_list_item_float(p, i))
                            }
                            ffi::obs_combo_format_OBS_COMBO_FORMAT_BOOL => {
                                json!(ffi::obs_property_list_item_bool(p, i))
                            }
                            _ => Value::String(cstr_owned(ffi::obs_property_list_item_string(p, i))),
                        };
                        items.push(json!({
                            "name": cstr_owned(ffi::obs_property_list_item_name(p, i)),
                            "value": value,
                            "disabled": ffi::obs_property_list_item_disabled(p, i),
                        }));
                    }
                    spec.insert("items".into(), Value::Array(items));
                }
                ffi::obs_property_type_OBS_PROPERTY_EDITABLE_LIST => {
                    spec.insert(
                        "editable_list_type".into(),
                        Value::String(
                            match ffi::obs_property_editable_list_type(p) {
                                ffi::obs_editable_list_type_OBS_EDITABLE_LIST_TYPE_FILES => "files",
                                ffi::obs_editable_list_type_OBS_EDITABLE_LIST_TYPE_FILES_AND_URLS => {
                                    "files_and_urls"
                                }
                                _ => "strings",
                            }
                            .into(),
                        ),
                    );
                    let filter = cstr_owned(ffi::obs_property_editable_list_filter(p));
                    if !filter.is_empty() {
                        spec.insert("filter".into(), Value::String(filter));
                    }
                }
                ffi::obs_property_type_OBS_PROPERTY_BUTTON => {
                    let bt = ffi::obs_property_button_type(p);
                    spec.insert(
                        "button_type".into(),
                        Value::String(
                            if bt == ffi::obs_button_type_OBS_BUTTON_URL { "url" } else { "default" }.into(),
                        ),
                    );
                    let url = cstr_owned(ffi::obs_property_button_url(p));
                    if !url.is_empty() {
                        spec.insert("url".into(), Value::String(url));
                    }
                }
                ffi::obs_property_type_OBS_PROPERTY_GROUP => {
                    spec.insert(
                        "group_type".into(),
                        Value::String(
                            if ffi::obs_property_group_type(p) == ffi::obs_group_type_OBS_GROUP_CHECKABLE {
                                "checkable".into()
                            } else {
                                "normal".to_string()
                            },
                        ),
                    );
                    let content = ffi::obs_property_group_content(p);
                    let children = if content.is_null() { Vec::new() } else { props_to_json(content) };
                    spec.insert("children".into(), Value::Array(children));
                }
                _ => {}
            }
            out.push(Value::Object(spec));
            if !ffi::obs_property_next(&mut p) {
                break;
            }
        }
        out
    }
}

// --- SP6 audio free helpers --------------------------------------------------

/// # Safety
/// `src` must be a live source ref.
unsafe fn source_name(src: *mut ffi::obs_source) -> Option<String> {
    let p = ffi::obs_source_get_name(src);
    if p.is_null() {
        return None;
    }
    Some(CStr::from_ptr(p).to_string_lossy().into_owned())
}

/// # Safety
/// `src` must be a live source ref.
unsafe fn source_type_id(src: *mut ffi::obs_source) -> Option<String> {
    let p = ffi::obs_source_get_id(src);
    if p.is_null() {
        return None;
    }
    Some(CStr::from_ptr(p).to_string_lossy().into_owned())
}

fn monitoring_name(t: ffi::obs_monitoring_type) -> &'static str {
    match t {
        ffi::obs_monitoring_type_OBS_MONITORING_TYPE_MONITOR_ONLY => "monitor_only",
        ffi::obs_monitoring_type_OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT => "monitor_and_output",
        _ => "none",
    }
}

/// libobs hands back BORROWED strings here - copy, never free.
fn monitoring_device() -> Option<DeviceRef> {
    unsafe {
        let mut name: *const std::os::raw::c_char = std::ptr::null();
        let mut id: *const std::os::raw::c_char = std::ptr::null();
        ffi::obs_get_audio_monitoring_device(&mut name, &mut id);
        if name.is_null() || id.is_null() {
            return None;
        }
        Some(DeviceRef {
            id: CStr::from_ptr(id).to_string_lossy().into_owned(),
            name: CStr::from_ptr(name).to_string_lossy().into_owned(),
        })
    }
}

/// Is `id` a REGISTERED filter type? The only reliable answer, because
/// `obs_source_create` happily returns an unknown-type placeholder for a
/// garbage id rather than null (see `add_filter`).
fn filter_type_exists(id: &str) -> bool {
    unsafe {
        let mut idx = 0usize;
        loop {
            let mut cur: *const std::os::raw::c_char = std::ptr::null();
            if !ffi::obs_enum_filter_types(idx, &mut cur) {
                return false;
            }
            idx += 1;
            if !cur.is_null() && CStr::from_ptr(cur).to_string_lossy() == id {
                return true;
            }
        }
    }
}

/// Filter chain in signal order (libobs enumerates front to back).
///
/// # Safety
/// `src` must be a live source ref.
unsafe fn enum_filters(src: *mut ffi::obs_source) -> Vec<FilterInfo> {
    unsafe extern "C" fn collect(
        _parent: *mut ffi::obs_source,
        filter: *mut ffi::obs_source,
        param: *mut std::ffi::c_void,
    ) {
        unsafe {
            let out = &mut *(param as *mut Vec<FilterInfo>);
            if filter.is_null() {
                return;
            }
            out.push(FilterInfo {
                name: source_name(filter).unwrap_or_default(),
                id: source_type_id(filter).unwrap_or_default(),
                enabled: ffi::obs_source_enabled(filter),
            });
        }
    }
    let mut out: Vec<FilterInfo> = Vec::new();
    ffi::obs_source_enum_filters(src, Some(collect), &mut out as *mut _ as *mut _);
    out
}

/// Audio-capable source names in one scene, top level only. Group children are
/// skipped deliberately: a group is a scene-item construct with no audio of its
/// own, and its children already appear as their own sources when they carry
/// audio.
///
/// # Safety
/// `scene` must be a live scene ref.
unsafe fn scene_audio_source_names(scene: *mut ffi::obs_scene) -> Vec<String> {
    unsafe extern "C" fn collect(
        _scene: *mut ffi::obs_scene,
        item: *mut ffi::obs_scene_item,
        param: *mut std::ffi::c_void,
    ) -> bool {
        unsafe {
            let out = &mut *(param as *mut Vec<String>);
            let src = ffi::obs_sceneitem_get_source(item);
            if src.is_null() {
                return true;
            }
            if ffi::obs_source_get_output_flags(src) & ffi::OBS_SOURCE_AUDIO != 0 {
                if let Some(n) = source_name(src) {
                    if !out.contains(&n) {
                        out.push(n);
                    }
                }
            }
            true
        }
    }
    let mut out: Vec<String> = Vec::new();
    ffi::obs_scene_enum_items(scene, Some(collect), &mut out as *mut _ as *mut _);
    out
}

/// Names for the six global slots. Channels 1 and 2 keep the names SP1/SP4
/// already persisted in the collection ("Desktop Audio", "Mic/Aux") - renaming
/// them would orphan every existing user's saved audio settings.
/// How a `set_volume` call expressed the level it wants (SP6). The mixer strip
/// drags a 0..1 fader; SF3's numeric field types exact decibels. Both resolve
/// through the same libobs fader, so the cubic curve is defined once.
#[derive(Debug, Clone, Copy)]
pub enum VolumeLevel {
    Deflection(f32),
    Db(f32),
}

/// Monitoring outputs (SP6 SF3). Not a source property like the capture
/// devices — libobs exposes these only through a callback enumerator, which
/// pushes into the Vec behind `data`.
fn enumerate_monitoring_devices() -> Vec<Value> {
    unsafe extern "C" fn push(
        data: *mut std::ffi::c_void,
        name: *const std::os::raw::c_char,
        id: *const std::os::raw::c_char,
    ) -> bool {
        if !data.is_null() && !id.is_null() {
            let out = unsafe { &mut *(data as *mut Vec<Value>) };
            let id_s = cstr_owned(id);
            let name_s = if name.is_null() { id_s.clone() } else { cstr_owned(name) };
            out.push(json!({ "id": id_s, "name": name_s }));
        }
        true // keep enumerating
    }
    let mut out: Vec<Value> = Vec::new();
    unsafe {
        ffi::obs_enum_audio_monitoring_devices(
            Some(push),
            &mut out as *mut Vec<Value> as *mut std::ffi::c_void,
        );
    }
    out
}

/// Profile ini keys for a global audio slot. `[Audio] Slot1Input=…` /
/// `Slot1Device=…`, OBS's own PascalCase key style.
fn slot_input_key(channel: u32) -> String {
    format!("Slot{channel}Input")
}

fn slot_device_key(channel: u32) -> String {
    format!("Slot{channel}Device")
}

fn global_slot_name(channel: u32) -> String {
    match channel {
        1 => "Desktop Audio".into(),
        2 => "Mic/Aux".into(),
        3 => "Desktop Audio 2".into(),
        n => format!("Mic/Aux {}", n - 2),
    }
}
