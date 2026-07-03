//! The engine thread: owns every libobs object and is the ONLY thread that
//! calls `obs_*` after init. Socket tasks send [`Cmd`]s over a std mpsc and
//! await tokio oneshot replies; state pushes go out on the tokio broadcast
//! bus as `state_changed` events (capture daemon architecture, third
//! instance).
//!
//! GPL corpus — record-pipeline semantics ported from the OBS frontend's
//! basic output handler (reference clone, tag 32.1.2).

use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};

use crate::bindings as ffi;
use crate::daemon::protocol::{
    Event, ProtoError, RecordingInfo, SceneInfo, SourceInfo, StateSnapshot, PROTO_VERSION,
};
use crate::obs::{app_config_dir, ObsCore};

pub type Reply = oneshot::Sender<Result<Value, ProtoError>>;

pub enum Cmd {
    GetState(Reply),
    CreateScene { name: String, reply: Reply },
    RemoveScene { name: String, reply: Reply },
    SetCurrentScene { name: String, reply: Reply },
    CreateSource { scene: String, id: String, name: String, settings: Value, reply: Reply },
    RemoveSource { scene: String, name: String, reply: Reply },
    SetSourceSettings { scene: String, name: String, settings: Value, reply: Reply },
    StartRecord { reply: Reply },
    StopRecord { reply: Reply },
    DisplayCreate { id: String, hwnd: u64, width: u32, height: u32, reply: Reply },
    DisplayResize { id: String, width: u32, height: u32, reply: Reply },
    DisplayDestroy { id: String, reply: Reply },
    Shutdown { reply: Reply },
}

struct RecordingRun {
    output: *mut ffi::obs_output,
    venc: *mut ffi::obs_encoder,
    aenc: *mut ffi::obs_encoder,
    path: String,
    started: Instant,
}

struct Engine {
    core: ObsCore,
    /// (name, owned scene ref)
    scenes: Vec<(String, *mut ffi::obs_scene)>,
    current: Option<String>,
    desktop_audio: *mut ffi::obs_source,
    /// (id, display) — ephemeral preview swapchains on app-owned HWNDs.
    /// Never persisted, never in StateSnapshot: a respawned engine starts
    /// with zero displays and the app re-creates them on its alive edge.
    displays: Vec<(String, *mut ffi::obs_display_t)>,
    recording: Option<RecordingRun>,
    finalizing: bool,
    last_error: Option<ProtoError>,
    events: broadcast::Sender<Event>,
}

fn cstring(s: &str) -> CString {
    CString::new(s).unwrap_or_default()
}

fn collection_path() -> PathBuf {
    app_config_dir().join("scenes").join("default.json")
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
    cmd_rx: mpsc::Receiver<Cmd>,
    events: broadcast::Sender<Event>,
    init_done: oneshot::Sender<Result<(), String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("obs-engine".into())
        .spawn(move || {
            let core = match ObsCore::init(&payload_root) {
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
                desktop_audio: std::ptr::null_mut(),
                displays: Vec::new(),
                recording: None,
                finalizing: false,
                last_error: None,
                events,
            };
            eng.load_collection();
            eng.ensure_default_scene();
            eng.ensure_desktop_audio();
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
            Cmd::CreateSource { scene, id, name, settings, reply } => {
                let r = self.create_source(&scene, &id, &name, &settings);
                self.finish(reply, r);
            }
            Cmd::RemoveSource { scene, name, reply } => {
                let r = self.remove_source(&scene, &name);
                self.finish(reply, r);
            }
            Cmd::SetSourceSettings { scene, name, settings, reply } => {
                let r = self.set_source_settings(&scene, &name, &settings);
                self.finish(reply, r);
            }
            Cmd::StartRecord { reply } => {
                let r = self.start_record();
                self.finish(reply, r);
            }
            Cmd::StopRecord { reply } => {
                let r = self.stop_record();
                self.finish(reply, r);
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
    /// state — display_resize arrives at rAF rate during layout drags; the
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
        let (state, rec) = match (&self.recording, self.finalizing) {
            (Some(run), _) => (
                "recording",
                RecordingInfo {
                    active: true,
                    path: Some(run.path.clone()),
                    elapsed_ns: run.started.elapsed().as_nanos() as u64,
                },
            ),
            (None, true) => ("finalizing", RecordingInfo { active: false, path: None, elapsed_ns: 0 }),
            (None, false) => (
                if self.last_error.is_some() { "error" } else { "idle" },
                RecordingInfo { active: false, path: None, elapsed_ns: 0 },
            ),
        };
        StateSnapshot {
            version: PROTO_VERSION,
            state: state.into(),
            current_scene: self.current.clone(),
            scenes,
            recording: rec,
            obs_version: self.core.version_string(),
            last_error: self.last_error.clone(),
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
        Ok(json!({}))
    }

    fn create_source(
        &mut self,
        scene: &str,
        id: &str,
        name: &str,
        settings: &Value,
    ) -> Result<Value, ProtoError> {
        let scene_ptr = self
            .find_scene(scene)
            .ok_or_else(|| ProtoError::bad_request(format!("no scene '{scene}'")))?;
        unsafe {
            let cid = cstring(id);
            let cname = cstring(name);
            let data = data_from_value(settings);
            let src = ffi::obs_source_create(cid.as_ptr(), cname.as_ptr(), data, std::ptr::null_mut());
            ffi::obs_data_release(data);
            if src.is_null() {
                return Err(ProtoError::internal(format!("obs_source_create('{id}') null")));
            }
            // monitor_capture's DEFAULT monitor_id is the "DUMMY" sentinel
            // (duplicator-monitor-capture.c:379) — OBS's properties dialog
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
                // modern path (Win10 1903+ — our floor).
                if settings.get("method").is_none() {
                    fixes.insert("method".into(), Value::from(2));
                }
                if !fixes.is_empty() {
                    let fix = data_from_value(&Value::Object(fixes));
                    ffi::obs_source_update(src, fix);
                    ffi::obs_data_release(fix);
                }
            }
            ffi::obs_scene_add(scene_ptr, src);
            ffi::obs_source_release(src); // the scene item holds its own ref
        }
        Ok(json!({}))
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
    ) -> Result<Value, ProtoError> {
        unsafe {
            let c = cstring(name);
            let src = ffi::obs_get_source_by_name(c.as_ptr());
            if src.is_null() {
                return Err(ProtoError::bad_request(format!("no source '{name}'")));
            }
            let data = data_from_value(settings);
            ffi::obs_source_update(src, data);
            ffi::obs_data_release(data);
            ffi::obs_source_release(src);
        }
        Ok(json!({}))
    }

    /// Fresh-box guard: with no persisted collection the program is empty —
    /// the preview renders black and start_record errors "no current scene".
    fn ensure_default_scene(&mut self) {
        if self.scenes.is_empty() {
            if let Err(e) = self.create_scene("Scene") {
                log::warn!("default scene create failed: {}", e.message);
            }
        }
    }

    /// Desktop Audio is a REGULAR persisted source (round-trips through the
    /// collection like everything else): reuse the loaded one by name, create
    /// it only on a fresh start. Runs AFTER load_collection — creating it
    /// before load duplicated it on every boot (obs_save_sources saves it,
    /// obs_load_sources restores it, attach created a second).
    fn ensure_desktop_audio(&mut self) {
        unsafe {
            let name = cstring("Desktop Audio");
            let mut src = ffi::obs_get_source_by_name(name.as_ptr());
            if src.is_null() {
                let id = cstring("wasapi_output_capture");
                src = ffi::obs_source_create(id.as_ptr(), name.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut());
                if src.is_null() {
                    log::warn!("desktop audio source creation failed");
                    return;
                }
            }
            ffi::obs_set_output_source(1, src);
            self.desktop_audio = src; // owned ref either way; released in teardown
        }
    }

    // --- displays (SP2) -------------------------------------------------------
    // Ephemeral preview swapchains bound to app-owned HWNDs. obs_display_create
    // and _destroy enter the graphics context themselves (obs-display.c), so
    // they are engine-thread-safe; the registered draw callback fires on OBS's
    // internal graphics thread. The engine trusts the app's u64 — a garbage or
    // stale HWND fails the D3D11 swapchain create and surfaces as a clean
    // internal error.

    fn display_create(&mut self, id: &str, hwnd: u64, width: u32, height: u32) -> Result<Value, ProtoError> {
        self.remove_display(id); // upsert: replace an existing id
        let init = ffi::gs_init_data {
            window: ffi::gs_window { hwnd: hwnd as *mut std::ffi::c_void },
            cx: width.max(1),
            cy: height.max(1),
            num_backbuffers: 0,
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
    /// this (new) engine never had — missing is Ok, not bad_request.
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

    // --- recording ----------------------------------------------------------

    fn start_record(&mut self) -> Result<Value, ProtoError> {
        if self.recording.is_some() {
            return Err(ProtoError::busy("already recording"));
        }
        if self.current.is_none() {
            return Err(ProtoError::bad_request("no current scene"));
        }
        let dir = captures_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| ProtoError::internal(format!("captures dir: {e}")))?;
        let path = dir.join(format!("Broadcast {}.mp4", local_timestamp_stem()));
        let path_str = path.to_string_lossy().into_owned();

        unsafe {
            // x264 CBR 12 Mbps, 2s keyint (SP1 gate spec: deterministic CPU encode).
            let venc_settings = data_from_value(&json!({
                "rate_control": "CBR", "bitrate": 12000, "keyint_sec": 2, "preset": "veryfast",
            }));
            let venc_id = cstring("obs_x264");
            let venc_name = cstring("rec_venc");
            let venc = ffi::obs_video_encoder_create(venc_id.as_ptr(), venc_name.as_ptr(), venc_settings, std::ptr::null_mut());
            ffi::obs_data_release(venc_settings);
            if venc.is_null() {
                return Err(ProtoError::internal("obs_x264 encoder create failed"));
            }
            ffi::obs_encoder_set_video(venc, ffi::obs_get_video());

            let aenc_settings = data_from_value(&json!({ "bitrate": 160 }));
            let aenc_id = cstring("ffmpeg_aac");
            let aenc_name = cstring("rec_aenc");
            let aenc = ffi::obs_audio_encoder_create(aenc_id.as_ptr(), aenc_name.as_ptr(), aenc_settings, 0, std::ptr::null_mut());
            ffi::obs_data_release(aenc_settings);
            if aenc.is_null() {
                ffi::obs_encoder_release(venc);
                return Err(ProtoError::internal("ffmpeg_aac encoder create failed"));
            }
            ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());

            // Hybrid MP4 ("mp4_output", obs-ffmpeg) — the locked default container.
            let out_settings = data_from_value(&json!({ "path": path_str }));
            let out_id = cstring("mp4_output");
            let out_name = cstring("rec_out");
            let output = ffi::obs_output_create(out_id.as_ptr(), out_name.as_ptr(), out_settings, std::ptr::null_mut());
            ffi::obs_data_release(out_settings);
            if output.is_null() {
                ffi::obs_encoder_release(venc);
                ffi::obs_encoder_release(aenc);
                return Err(ProtoError::internal("mp4_output create failed"));
            }
            ffi::obs_output_set_video_encoder(output, venc);
            ffi::obs_output_set_audio_encoder(output, aenc, 0);

            if !ffi::obs_output_start(output) {
                let err = ffi::obs_output_get_last_error(output);
                let msg = if err.is_null() {
                    "obs_output_start failed".to_string()
                } else {
                    CStr::from_ptr(err).to_string_lossy().into_owned()
                };
                ffi::obs_output_release(output);
                ffi::obs_encoder_release(venc);
                ffi::obs_encoder_release(aenc);
                return Err(ProtoError::internal(msg));
            }

            self.recording = Some(RecordingRun { output, venc, aenc, path: path_str.clone(), started: Instant::now() });
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
            // finalizes (poll, 15 s ceiling — matches capture's finalize arc).
            let deadline = Instant::now() + Duration::from_secs(15);
            while ffi::obs_output_active(run.output) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            let still_active = ffi::obs_output_active(run.output);
            ffi::obs_output_release(run.output);
            ffi::obs_encoder_release(run.venc);
            ffi::obs_encoder_release(run.aenc);
            self.finalizing = false;
            if still_active {
                return Err(ProtoError::internal("output did not finalize within 15s"));
            }
        }
        let _ = self.events.send(Event { event: "saved".into(), data: json!({ "path": path }) });
        Ok(json!({ "path": path }))
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
        if self.recording.is_some() {
            let _ = self.stop_record();
        }
        self.save_collection();
        unsafe {
            ffi::obs_set_output_source(0, std::ptr::null_mut());
            ffi::obs_set_output_source(1, std::ptr::null_mut());
            if !self.desktop_audio.is_null() {
                ffi::obs_source_release(self.desktop_audio);
            }
            for (_, scene) in self.scenes.drain(..) {
                ffi::obs_scene_release(scene);
            }
        }
        // self.core drops here → obs_shutdown.
    }
}

/// First non-sentinel entry of a source's "monitor_id" list property —
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

// libobs graphics API — exported by obs.dll but outside the bindgen allowlist
// (`obs_.*` only; see scripts/regen-bindings.ps1). Hand-declared, matching
// graphics/graphics.h signatures (vsnprintf-extern precedent in obs/mod.rs).
unsafe extern "C" {
    fn gs_viewport_push();
    fn gs_viewport_pop();
    fn gs_projection_push();
    fn gs_projection_pop();
    fn gs_ortho(left: f32, right: f32, top: f32, bottom: f32, znear: f32, zfar: f32);
    fn gs_set_viewport(x: i32, y: i32, width: i32, height: i32);
}

/// Display draw callback — runs on OBS's internal graphics thread; body is
/// pure gs calls + obs_render_main_texture. The region is exact-fit (app
/// sizes it to the canvas aspect), so there is no letterbox math here —
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
        gs_projection_pop();
        gs_viewport_pop();
    }
}

/// serde_json Value → owned obs_data (caller releases).
unsafe fn data_from_value(v: &Value) -> *mut ffi::obs_data {
    let json = if v.is_null() { "{}".to_string() } else { v.to_string() };
    let c = cstring(&json);
    unsafe { ffi::obs_data_create_from_json(c.as_ptr()) }
}

unsafe fn enum_scene_sources(scene: *mut ffi::obs_scene) -> Vec<SourceInfo> {
    unsafe extern "C" fn collect(
        _scene: *mut ffi::obs_scene,
        item: *mut ffi::obs_scene_item,
        param: *mut std::ffi::c_void,
    ) -> bool {
        let out = unsafe { &mut *(param as *mut Vec<SourceInfo>) };
        let src = unsafe { ffi::obs_sceneitem_get_source(item) };
        if !src.is_null() {
            let name = unsafe { CStr::from_ptr(ffi::obs_source_get_name(src)) }.to_string_lossy().into_owned();
            let id = unsafe { CStr::from_ptr(ffi::obs_source_get_id(src)) }.to_string_lossy().into_owned();
            let width = unsafe { ffi::obs_source_get_width(src) };
            let height = unsafe { ffi::obs_source_get_height(src) };
            let showing = unsafe { ffi::obs_source_showing(src) };
            let active = unsafe { ffi::obs_source_active(src) };
            out.push(SourceInfo { name, id, width, height, showing, active });
        }
        true
    }
    let mut out = Vec::new();
    unsafe { ffi::obs_scene_enum_items(scene, Some(collect), &mut out as *mut _ as *mut std::ffi::c_void) };
    out
}
