//! Safe-ish wrappers over the libobs bindings — startup/shutdown, module
//! loading, log routing. Scene/source/output handles land with SF3/SF4.
//!
//! GPL corpus: semantics here are ported from the OBS Studio frontend's init
//! path (reference clone: frontend obs-main + app startup, tag 32.1.2).

use std::ffi::{c_char, c_int, CStr, CString};
use std::path::{Path, PathBuf};

use crate::bindings as ffi;

/// v1 bundled module allowlist (Engine Foundation § detail pass) — loaded via
/// libobs's safe-module list so `obs_load_all_modules` skips everything else
/// in the payload (obs-browser/CEF deferred to SP3, VST to SP6, scripting to
/// SP11). obs-x264 is in from day one: the SP1 gate records with x264.
const V1_MODULES: &[&str] = &[
    "win-capture",
    "obs-x264",
    "obs-ffmpeg",
    "obs-outputs",
    "rtmp-services",
    "obs-filters",
    "obs-transitions",
    "image-source",
    "text-freetype2",
    "win-wasapi",
    "win-dshow",
];

/// libobs log levels (util/base.h): LOG_ERROR=100 .. LOG_DEBUG=400.
unsafe extern "C" fn log_handler(level: c_int, msg: *const c_char, args: *mut c_char, _param: *mut std::ffi::c_void) {
    // va_list on x64 MSVC is char*; format via the CRT since Rust can't.
    unsafe extern "C" {
        fn vsnprintf(s: *mut c_char, n: usize, format: *const c_char, arg: *mut c_char) -> c_int;
    }
    let mut buf = [0u8; 4096];
    let n = unsafe { vsnprintf(buf.as_mut_ptr() as *mut c_char, buf.len(), msg, args) };
    let text = if n > 0 {
        String::from_utf8_lossy(&buf[..(n as usize).min(buf.len() - 1)]).into_owned()
    } else {
        "<unformattable obs log line>".into()
    };
    match level {
        ..=100 => log::error!(target: "libobs", "{text}"),
        101..=200 => log::warn!(target: "libobs", "{text}"),
        201..=300 => log::info!(target: "libobs", "{text}"),
        _ => log::debug!(target: "libobs", "{text}"),
    }
}

fn cstring(s: &str) -> CString {
    CString::new(s).expect("no interior NUL")
}

/// Engine config dir: `%APPDATA%\dev.malthaiel.mortar-pestle\broadcast\`.
/// Scene collections + profiles (SF3) and libobs per-module config live here.
pub fn app_config_dir() -> PathBuf {
    let base = std::env::var("APPDATA").expect("APPDATA unset");
    Path::new(&base).join("dev.malthaiel.mortar-pestle").join("broadcast")
}

pub struct ObsCore {
    _not_send: std::marker::PhantomData<*const ()>,
}

impl ObsCore {
    /// Full frontend-less init per docs.obsproject.com/frontends:
    /// startup → reset_video → reset_audio → module paths → load → post_load.
    /// 1080p60 NV12 defaults (config-store-overridable, SF3+).
    pub fn init(payload_root: &Path) -> Result<Self, String> {
        unsafe {
            // COM before OBS: win-dshow/win-wasapi assume an initialized COM
            // process; without it, shutdown corrupts the heap (0xC0000374).
            #[cfg(windows)]
            {
                use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
                let hr = CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as u32);
                if hr < 0 {
                    return Err(format!("CoInitializeEx failed: {hr:#x}"));
                }
            }

            ffi::base_set_log_handler(Some(log_handler), std::ptr::null_mut());

            let plugin_config = app_config_dir().join("plugin_config");
            std::fs::create_dir_all(&plugin_config).map_err(|e| e.to_string())?;
            let locale = cstring("en-US");
            let module_config = cstring(&plugin_config.to_string_lossy());
            if !ffi::obs_startup(locale.as_ptr(), module_config.as_ptr(), std::ptr::null_mut()) {
                return Err("obs_startup returned false".into());
            }

            let graphics_module = cstring("libobs-d3d11");
            let mut ovi: ffi::obs_video_info = std::mem::zeroed();
            ovi.graphics_module = graphics_module.as_ptr();
            ovi.fps_num = 60;
            ovi.fps_den = 1;
            ovi.base_width = 1920;
            ovi.base_height = 1080;
            ovi.output_width = 1920;
            ovi.output_height = 1080;
            ovi.output_format = ffi::video_format_VIDEO_FORMAT_NV12;
            ovi.adapter = 0;
            ovi.gpu_conversion = true;
            ovi.colorspace = ffi::video_colorspace_VIDEO_CS_709;
            ovi.range = ffi::video_range_type_VIDEO_RANGE_PARTIAL;
            ovi.scale_type = ffi::obs_scale_type_OBS_SCALE_BICUBIC;
            let vr = ffi::obs_reset_video(&mut ovi);
            if vr != ffi::OBS_VIDEO_SUCCESS as c_int {
                ffi::obs_shutdown();
                return Err(format!("obs_reset_video failed: {vr}"));
            }

            let mut oai: ffi::obs_audio_info = std::mem::zeroed();
            oai.samples_per_sec = 48000;
            oai.speakers = ffi::speaker_layout_SPEAKERS_STEREO;
            if !ffi::obs_reset_audio(&oai) {
                ffi::obs_shutdown();
                return Err("obs_reset_audio failed".into());
            }

            // NO obs_add_module_path: obs_startup already registers the
            // compiled-in default ("../../obs-plugins/64bit" + matching data
            // path, resolved against our bin/64bit cwd). Adding the same dir
            // again loads every module TWICE → duplicate registrations and a
            // double-unload heap corruption (0xC0000374) at shutdown.
            let _ = payload_root; // location is implied by the cwd contract
            // Dev diagnostic override: comma list of modules, or "none" to skip
            // module loading entirely. Default = the v1 allowlist.
            let module_override = std::env::var("MORTAR_PESTLE_BROADCAST_MODULES").ok();
            let modules: Vec<&str> = match module_override.as_deref() {
                Some("none") => vec![],
                Some(list) => list.split(',').filter(|s| !s.is_empty()).collect(),
                None => V1_MODULES.to_vec(),
            };
            // An EMPTY safe list means "load everything in the path" (obs.h:571)
            // — so "none" must skip the load calls, not pass an empty list.
            if modules.is_empty() {
                log::info!("module loading skipped (MORTAR_PESTLE_BROADCAST_MODULES=none)");
            } else {
                for name in &modules {
                    let n = cstring(name);
                    ffi::obs_add_safe_module(n.as_ptr());
                }
                ffi::obs_load_all_modules();
                ffi::obs_post_load_modules();
                ffi::obs_log_loaded_modules();
            }
        }
        Ok(ObsCore { _not_send: std::marker::PhantomData })
    }

    pub fn version_string(&self) -> String {
        unsafe {
            CStr::from_ptr(ffi::obs_get_version_string()).to_string_lossy().into_owned()
        }
    }
}

impl Drop for ObsCore {
    fn drop(&mut self) {
        unsafe { ffi::obs_shutdown() }
    }
}
