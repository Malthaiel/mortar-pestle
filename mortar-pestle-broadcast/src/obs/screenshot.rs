//! Source/program screenshots for picker thumbnails — texrender → staged
//! GPU→CPU copy → PNG. GPL corpus: the render/stage/map sequence is the OBS
//! frontend ScreenshotObj pipeline (reference clone, tag 32.1.2), collapsed
//! from its tick-driven 4-stage state machine into ONE `obs_enter_graphics`
//! bracket: `obs_enter_graphics` takes the global graphics mutex (serializing
//! against the render thread — ScreenshotObj's own destructor enters graphics
//! from the Qt thread, sanctioned pattern), and `gs_stagesurface_map` is a
//! D3D11 Map that blocks until the staged copy completes, so map-after-stage
//! inside one bracket is correct. OBS splits it across ticks only to avoid
//! stalling its graphics thread; we stall the idle engine thread ~2-5 ms at
//! 1 Hz instead.

use crate::bindings as ffi;
use crate::obs::overlay::V4;

/// Render `src` (null = whole program via obs_render_main_texture) at
/// `out_w`×`out_h` (GPU downscale for free — the ortho maps the full source
/// rect onto the small target) and PNG-encode. Returns the PNG bytes.
pub unsafe fn capture(
    src: *mut ffi::obs_source,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
) -> Result<Vec<u8>, String> {
    let rgba = unsafe {
        ffi::obs_enter_graphics();
        let r = capture_rgba(src, src_w, src_h, out_w, out_h);
        ffi::obs_leave_graphics();
        r?
    };
    encode_png(&rgba, out_w, out_h)
}

/// Must run inside the obs_enter_graphics bracket.
unsafe fn capture_rgba(
    src: *mut ffi::obs_source,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
) -> Result<Vec<u8>, String> {
    unsafe {
        let texrender = gs_texrender_create(ffi::gs_color_format_GS_BGRA, ffi::gs_zstencil_format_GS_ZS_NONE);
        if texrender.is_null() {
            return Err("gs_texrender_create failed".into());
        }
        // Drop guards run before this fn returns — still inside the bracket.
        let _tex_guard = TexGuard(texrender);

        if !gs_texrender_begin(texrender, out_w, out_h) {
            return Err("gs_texrender_begin failed".into());
        }
        let zero = V4([0.0, 0.0, 0.0, 0.0]);
        gs_clear(GS_CLEAR_COLOR, &zero, 0.0, 0);
        gs_ortho(0.0, src_w as f32, 0.0, src_h as f32, -100.0, 100.0);
        gs_blend_state_push();
        gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
        if src.is_null() {
            ffi::obs_render_main_texture();
        } else {
            // inc/dec showing brackets the WGC/duplicator init gate — a
            // never-shown source renders black forever without it.
            ffi::obs_source_inc_showing(src);
            ffi::obs_source_video_render(src);
            ffi::obs_source_dec_showing(src);
        }
        gs_blend_state_pop();
        gs_texrender_end(texrender);

        let stage = gs_stagesurface_create(out_w, out_h, ffi::gs_color_format_GS_BGRA);
        if stage.is_null() {
            return Err("gs_stagesurface_create failed".into());
        }
        let _stage_guard = StageGuard(stage);

        gs_stage_texture(stage, gs_texrender_get_texture(texrender));
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut linesize: u32 = 0;
        if !gs_stagesurface_map(stage, &mut data, &mut linesize) {
            return Err("gs_stagesurface_map failed".into());
        }
        let mut rgba = vec![0u8; (out_w * out_h * 4) as usize];
        for y in 0..out_h as usize {
            let row = data.add(y * linesize as usize);
            let dst = &mut rgba[y * out_w as usize * 4..][..out_w as usize * 4];
            for x in 0..out_w as usize {
                let b = *row.add(x * 4);
                let g = *row.add(x * 4 + 1);
                let r = *row.add(x * 4 + 2);
                let a = *row.add(x * 4 + 3);
                dst[x * 4] = r;
                dst[x * 4 + 1] = g;
                dst[x * 4 + 2] = b;
                dst[x * 4 + 3] = a;
            }
        }
        gs_stagesurface_unmap(stage);
        Ok(rgba)
    }
}

struct TexGuard(*mut std::os::raw::c_void);
impl Drop for TexGuard {
    fn drop(&mut self) {
        unsafe { gs_texrender_destroy(self.0) };
    }
}

struct StageGuard(*mut std::os::raw::c_void);
impl Drop for StageGuard {
    fn drop(&mut self) {
        unsafe { gs_stagesurface_destroy(self.0) };
    }
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| format!("png header: {e}"))?;
        writer.write_image_data(rgba).map_err(|e| format!("png write: {e}"))?;
    }
    Ok(out)
}

// graphics/graphics.h — outside the bindgen allowlist, hand-declared
// (engine.rs / overlay.rs precedent).
const GS_CLEAR_COLOR: u32 = 1 << 0;
const GS_BLEND_ZERO: i32 = 0;
const GS_BLEND_ONE: i32 = 1;

unsafe extern "C" {
    fn gs_texrender_create(format: ffi::gs_color_format, zsformat: ffi::gs_zstencil_format) -> *mut std::os::raw::c_void;
    fn gs_texrender_destroy(texrender: *mut std::os::raw::c_void);
    fn gs_texrender_begin(texrender: *mut std::os::raw::c_void, cx: u32, cy: u32) -> bool;
    fn gs_texrender_end(texrender: *mut std::os::raw::c_void);
    fn gs_texrender_get_texture(texrender: *mut std::os::raw::c_void) -> *mut ffi::gs_texture;
    fn gs_stagesurface_create(width: u32, height: u32, format: ffi::gs_color_format) -> *mut std::os::raw::c_void;
    fn gs_stagesurface_destroy(stagesurf: *mut std::os::raw::c_void);
    fn gs_stage_texture(dst: *mut std::os::raw::c_void, src: *mut ffi::gs_texture);
    fn gs_stagesurface_map(stagesurf: *mut std::os::raw::c_void, data: *mut *mut u8, linesize: *mut u32) -> bool;
    fn gs_stagesurface_unmap(stagesurf: *mut std::os::raw::c_void);
    fn gs_clear(clear_flags: u32, color: *const V4, depth: f32, stencil: u8);
    fn gs_blend_state_push();
    fn gs_blend_state_pop();
    fn gs_blend_function(src: i32, dest: i32);
    fn gs_ortho(left: f32, right: f32, top: f32, bottom: f32, znear: f32, zfar: f32);
}
