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
    CanvasInfo, Crop, Event, ProtoError, RecordingInfo, SceneInfo, SourceInfo, StateSnapshot,
    Transform, PROTO_VERSION,
};
use crate::obs::overlay::{self, M4};
use crate::obs::{app_config_dir, screenshot, ObsCore};

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
    StartRecord { reply: Reply },
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
    Screenshot { scene: Option<String>, item: Option<i64>, picker: Option<String>, width: u32, reply: Reply },
    PickerOpen { kind: String, reply: Reply },
    PickerClose { reply: Reply },
    LoadBrowserModule { reply: Reply },
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
    /// Monitor-picker temp sources: (monitor id, label, PRIVATE source ptr).
    /// Private → never saved by obs_save_sources, so the autosave path can't
    /// leak them into the collection. inc_showing held while open (WGC gate).
    picker: Vec<(String, String, *mut ffi::obs_source)>,
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
                picker: Vec::new(),
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
        let (cw, ch) = self.canvas_size();
        StateSnapshot {
            version: PROTO_VERSION,
            state: state.into(),
            current_scene: self.current.clone(),
            canvas: CanvasInfo { width: cw, height: ch },
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
        // addressing — auto-suffix and reply the final name (v2 contract).
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
                // Whole-settings restore (undo path): replace, don't merge —
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

    /// Every item verb resolves through this ONE helper — find_sceneitem_by_id
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
            // by the UI (Scene ▸ lists other scenes only) — documented limit.
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
        // Scene ORDER sidecar — obs_save_sources order is not ours to control,
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
        // SP3: selection box + handles + hover outline + snap guides, drawn
        // in the same canvas ortho so they track the preview scale for free.
        overlay::draw_overlay(ovi.base_width, ovi.base_height, cx);
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

/// v2 enumeration: wire order = obs_scene_enum_items order (BOTTOM→TOP of
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

/// Deep item lookup — obs_scene_find_sceneitem_by_id does NOT recurse into
/// groups, so this is the one place group addressing lives (risk #6: every
/// item verb routes through with_item → here).
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

/// First free "<base>" / "<base> N" (N from 2) — obs_source_create doesn't
/// dedupe and duplicates break name addressing.
unsafe fn free_name(base: &str) -> String {
    unsafe {
        if !name_taken(base) {
            return base.to_owned();
        }
        for i in 2u32.. {
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
/// property list (first_real_monitor_id generalized — plugin-enumerated, so
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

/// obs_properties → PropSpec JSON list (recursing groups). The wire shape the
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
