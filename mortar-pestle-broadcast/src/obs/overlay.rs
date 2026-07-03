//! Engine-drawn preview overlay — selection box + 8 scale handles, hover
//! outline, snap guides. Drawn inside the display draw callback AFTER
//! `obs_render_main_texture`, in canvas coordinates (the callback's ortho is
//! already the base canvas), so everything here scales with the preview for
//! free. GPL corpus: rendering approach ported from the OBS frontend's
//! window-basic-preview (reference clone, tag 32.1.2).
//!
//! Threading: verbs (engine thread) write [`OVERLAY`]; the draw callback
//! (OBS graphics thread) `try_lock`s — on contention it skips a frame rather
//! than ever blocking the render. Scene-item enumeration from the graphics
//! thread is the same pattern OBS's own preview uses (libobs locks
//! internally).

use std::sync::Mutex;

use crate::bindings as ffi;

/// (axis, pos): axis 0 = vertical line at x=pos, 1 = horizontal at y=pos.
pub type Guide = (u8, f32);

#[derive(Default)]
pub struct OverlayState {
    /// (scene name, item id) — dim outline; only drawn when the scene is the
    /// program scene (off-air items aren't on the preview at all).
    pub hover: Option<(String, i64)>,
    pub guides: Vec<Guide>,
}

pub static OVERLAY: Mutex<OverlayState> = Mutex::new(OverlayState { hover: None, guides: Vec::new() });

/// vec4 stand-in for gs_effect_set_vec4 — libobs vec4 is 16-byte aligned
/// (SSE loads), so a plain [f32;4] (align 4) would be UB to pass.
#[repr(C, align(16))]
pub struct V4(pub [f32; 4]);

// Colors follow the app's neutral status language (DESIGN.md: no stoplight,
// no glow): selection = bold near-white, hover = the same dimmed, guides
// lighter still.
const COL_SELECT: V4 = V4([0.92, 0.90, 0.86, 1.0]);
const COL_HOVER: V4 = V4([0.92, 0.90, 0.86, 0.45]);
const COL_GUIDE: V4 = V4([0.92, 0.90, 0.86, 0.6]);
/// Outline thickness / handle size in SCREEN px (converted per-frame).
const OUTLINE_PX: f32 = 2.0;
const HANDLE_PX: f32 = 8.0;

/// matrix4 mirror — bindings' `matrix4` is opaque (graphics/matrix4.h fields
/// aren't expanded by bindgen), but the layout is four align(16) vec4 rows
/// (x, y, z, t). Row-vector convention: canvas = v.x*x + v.y*y + t.
#[repr(C, align(16))]
#[derive(Clone, Copy, Default)]
pub struct M4 {
    pub x: [f32; 4],
    pub y: [f32; 4],
    pub z: [f32; 4],
    pub t: [f32; 4],
}

impl M4 {
    pub fn apply(&self, u: f32, v: f32) -> [f32; 2] {
        [
            u * self.x[0] + v * self.y[0] + self.t[0],
            u * self.x[1] + v * self.y[1] + self.t[1],
        ]
    }
}

/// The item's visible box corners (TL, TR, BR, BL) in its parent's space —
/// canvas space for top-level items; compose with the group's draw transform
/// (`parent`) for grouped children.
pub unsafe fn item_corners(item: *mut ffi::obs_sceneitem_t, parent: Option<&M4>) -> [[f32; 2]; 4] {
    let mut m = M4::default();
    unsafe { ffi::obs_sceneitem_get_box_transform(item, &mut m as *mut M4 as *mut ffi::matrix4) };
    let unit = [[0.0f32, 0.0f32], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    let mut out = [[0.0f32; 2]; 4];
    for (i, [u, v]) in unit.into_iter().enumerate() {
        let p = m.apply(u, v);
        out[i] = match parent {
            Some(g) => g.apply(p[0], p[1]),
            None => p,
        };
    }
    out
}

pub unsafe fn item_draw_transform(item: *mut ffi::obs_sceneitem_t) -> M4 {
    let mut m = M4::default();
    unsafe { ffi::obs_sceneitem_get_draw_transform(item, &mut m as *mut M4 as *mut ffi::matrix4) };
    m
}

// libobs graphics API outside the bindgen allowlist (`obs_.*`) — hand-declared
// against graphics/graphics.h, engine.rs gs_* extern precedent. `gs_eparam`/
// `gs_technique` stay opaque c_void.
unsafe extern "C" {
    fn gs_effect_get_technique(
        effect: *mut ffi::gs_effect,
        name: *const std::os::raw::c_char,
    ) -> *mut std::os::raw::c_void;
    fn gs_technique_begin(tech: *mut std::os::raw::c_void) -> usize;
    fn gs_technique_end(tech: *mut std::os::raw::c_void);
    fn gs_technique_begin_pass(tech: *mut std::os::raw::c_void, pass: usize) -> bool;
    fn gs_technique_end_pass(tech: *mut std::os::raw::c_void);
    fn gs_effect_get_param_by_name(
        effect: *mut ffi::gs_effect,
        name: *const std::os::raw::c_char,
    ) -> *mut std::os::raw::c_void;
    fn gs_effect_set_vec4(param: *mut std::os::raw::c_void, val: *const V4);
    fn gs_render_start(b_new: bool);
    fn gs_render_stop(mode: i32);
    fn gs_vertex2f(x: f32, y: f32);
}

const GS_TRISTRIP: i32 = 4;

struct SolidPass {
    tech: *mut std::os::raw::c_void,
    color: *mut std::os::raw::c_void,
}

impl SolidPass {
    unsafe fn begin() -> Option<SolidPass> {
        unsafe {
            let effect = ffi::obs_get_base_effect(ffi::obs_base_effect_OBS_EFFECT_SOLID);
            if effect.is_null() {
                return None;
            }
            let tech = gs_effect_get_technique(effect, c"Solid".as_ptr());
            let color = gs_effect_get_param_by_name(effect, c"color".as_ptr());
            if tech.is_null() || color.is_null() {
                return None;
            }
            gs_technique_begin(tech);
            gs_technique_begin_pass(tech, 0);
            Some(SolidPass { tech, color })
        }
    }

    unsafe fn set_color(&self, c: &V4) {
        unsafe { gs_effect_set_vec4(self.color, c as *const V4) };
    }

    /// Filled quad via tristrip.
    unsafe fn quad(&self, a: [f32; 2], b: [f32; 2], c: [f32; 2], d: [f32; 2]) {
        unsafe {
            gs_render_start(false);
            gs_vertex2f(a[0], a[1]);
            gs_vertex2f(b[0], b[1]);
            gs_vertex2f(d[0], d[1]);
            gs_vertex2f(c[0], c[1]);
            gs_render_stop(GS_TRISTRIP);
        }
    }

    /// Edge A→B as a filled quad of thickness `th` (canvas units).
    unsafe fn edge(&self, a: [f32; 2], b: [f32; 2], th: f32) {
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let len = (dx * dx + dy * dy).sqrt().max(1e-6);
        let nx = -dy / len * th * 0.5;
        let ny = dx / len * th * 0.5;
        unsafe {
            self.quad(
                [a[0] + nx, a[1] + ny],
                [b[0] + nx, b[1] + ny],
                [b[0] - nx, b[1] - ny],
                [a[0] - nx, a[1] - ny],
            );
        }
    }

    unsafe fn outline(&self, corners: &[[f32; 2]; 4], th: f32) {
        for i in 0..4 {
            unsafe { self.edge(corners[i], corners[(i + 1) % 4], th) };
        }
    }

    /// Axis-aligned square handle centered at p.
    unsafe fn handle(&self, p: [f32; 2], size: f32) {
        let h = size * 0.5;
        unsafe {
            self.quad(
                [p[0] - h, p[1] - h],
                [p[0] + h, p[1] - h],
                [p[0] + h, p[1] + h],
                [p[0] - h, p[1] + h],
            );
        }
    }
}

impl Drop for SolidPass {
    fn drop(&mut self) {
        unsafe {
            gs_technique_end_pass(self.tech);
            gs_technique_end(self.tech);
        }
    }
}

struct DrawCtx {
    pass: *const SolidPass,
    th: f32,
    hs: f32,
    hover: Option<i64>,
    parent: Option<M4>,
}

/// Per-item draw: selected → bold outline + 8 handles; hovered (≠ selected)
/// → dim outline. Recurses into groups with the composed parent transform.
unsafe extern "C" fn draw_item(
    _scene: *mut ffi::obs_scene_t,
    item: *mut ffi::obs_sceneitem_t,
    param: *mut std::os::raw::c_void,
) -> bool {
    unsafe {
        let ctx = &*(param as *const DrawCtx);
        let pass = &*ctx.pass;
        if !ffi::obs_sceneitem_visible(item) {
            return true;
        }
        let selected = ffi::obs_sceneitem_selected(item);
        let hovered = ctx.hover == Some(ffi::obs_sceneitem_get_id(item));
        if selected || hovered {
            let corners = item_corners(item, ctx.parent.as_ref());
            if selected {
                pass.set_color(&COL_SELECT);
                pass.outline(&corners, ctx.th);
                // 8 handles: 4 corners + 4 edge midpoints.
                for i in 0..4 {
                    pass.handle(corners[i], ctx.hs);
                    let j = (i + 1) % 4;
                    pass.handle(
                        [(corners[i][0] + corners[j][0]) * 0.5, (corners[i][1] + corners[j][1]) * 0.5],
                        ctx.hs,
                    );
                }
            } else {
                pass.set_color(&COL_HOVER);
                pass.outline(&corners, ctx.th);
            }
        }
        if ffi::obs_sceneitem_is_group(item) {
            let sub = DrawCtx {
                pass: ctx.pass,
                th: ctx.th,
                hs: ctx.hs,
                hover: ctx.hover,
                parent: Some(item_draw_transform(item)),
            };
            ffi::obs_sceneitem_group_enum_items(item, Some(draw_item), &sub as *const DrawCtx as *mut _);
        }
        true
    }
}

/// Called from the display draw callback, inside the canvas ortho. `cx` is
/// the display's pixel width — used to keep outline/handle sizes constant in
/// screen px regardless of preview scale.
pub unsafe fn draw_overlay(base_width: u32, base_height: u32, cx: u32) {
    unsafe {
        // Program scene (channel 0). Incremented ref — release before return.
        let src = ffi::obs_get_output_source(0);
        if src.is_null() {
            return;
        }
        let scene = ffi::obs_scene_from_source(src);
        if scene.is_null() {
            ffi::obs_source_release(src);
            return;
        }
        let program_name = {
            let n = ffi::obs_source_get_name(src);
            if n.is_null() { String::new() } else { std::ffi::CStr::from_ptr(n).to_string_lossy().into_owned() }
        };

        let (hover, guides) = match OVERLAY.try_lock() {
            Ok(st) => {
                let hover = st
                    .hover
                    .as_ref()
                    .and_then(|(s, id)| (*s == program_name).then_some(*id));
                (hover, st.guides.clone())
            }
            Err(_) => {
                ffi::obs_source_release(src);
                return; // skip the frame, never block the graphics thread
            }
        };

        let scale = base_width as f32 / cx.max(1) as f32;
        let pass = match SolidPass::begin() {
            Some(p) => p,
            None => {
                ffi::obs_source_release(src);
                return;
            }
        };

        let ctx = DrawCtx {
            pass: &pass as *const SolidPass,
            th: OUTLINE_PX * scale,
            hs: HANDLE_PX * scale,
            hover,
            parent: None,
        };
        ffi::obs_scene_enum_items(scene, Some(draw_item), &ctx as *const DrawCtx as *mut _);

        if !guides.is_empty() {
            pass.set_color(&COL_GUIDE);
            let th = OUTLINE_PX * scale;
            for (axis, pos) in &guides {
                if *axis == 0 {
                    pass.quad(
                        [pos - th * 0.5, 0.0],
                        [pos + th * 0.5, 0.0],
                        [pos + th * 0.5, base_height as f32],
                        [pos - th * 0.5, base_height as f32],
                    );
                } else {
                    pass.quad(
                        [0.0, pos - th * 0.5],
                        [base_width as f32, pos - th * 0.5],
                        [base_width as f32, pos + th * 0.5],
                        [0.0, pos + th * 0.5],
                    );
                }
            }
        }

        drop(pass);
        ffi::obs_source_release(src);
    }
}
