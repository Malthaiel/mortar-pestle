//! EGL display/context + dmabuf import + a reusable FBO-blit target.
//!
//! Headless EGL on NVIDIA (device → surfaceless → default fallbacks), a
//! surfaceless OpenGL context made current on the calling thread, dmabuf →
//! `EGLImage` via `EGL_EXT_image_dma_buf_import`, and a **persistent owned
//! `GL_TEXTURE_2D`** that each frame's imported `EGLImage` is FBO-blitted into.
//! NVENC rejects `EGLImage`-external textures (B1 interop verdict), so the blit
//! into an owned, normally-allocated texture is mandatory — not just a fallback.
//!
//! Promoted + generalized from the B1 interop spike's `egl.rs`: the spike created
//! a fresh owned texture per call; here the imported texture, owned texture, and
//! both FBOs are created **once** and reused every frame (the imported texture is
//! re-pointed at the new `EGLImage` each frame via `glEGLImageTargetTexture2DOES`).

use std::ffi::c_void;

use glow::HasContext;
use khronos_egl as egl;

// --- EXT/KHR constants (values from the Khronos EGL registry) ---
const PLATFORM_DEVICE_EXT: egl::Enum = 0x313F;
const PLATFORM_SURFACELESS_MESA: egl::Enum = 0x31DD;
const LINUX_DMA_BUF_EXT: egl::Enum = 0x3270;
const LINUX_DRM_FOURCC_EXT: egl::Attrib = 0x3271;
const DMA_BUF_PLANE0_FD_EXT: egl::Attrib = 0x3272;
const DMA_BUF_PLANE0_OFFSET_EXT: egl::Attrib = 0x3273;
const DMA_BUF_PLANE0_PITCH_EXT: egl::Attrib = 0x3274;
const DMA_BUF_PLANE0_MODIFIER_LO_EXT: egl::Attrib = 0x3443;
const DMA_BUF_PLANE0_MODIFIER_HI_EXT: egl::Attrib = 0x3444;
/// `DRM_FORMAT_MOD_INVALID` — when negotiated, omit the modifier attribs so EGL
/// uses the buffer's implicit modifier.
const DRM_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;

type DynEgl = egl::DynamicInstance<egl::EGL1_4>;
/// `void glEGLImageTargetTexture2DOES(GLenum target, GLeglImageOES image)`.
type EglImageTargetTexture2DOes = extern "system" fn(u32, *const c_void);

/// A loaded EGL instance with a current surfaceless OpenGL context + a glow
/// loader. Owns the EXT entry point NVENC's GL import path needs.
pub struct Egl {
    inst: DynEgl,
    display: egl::Display,
    // Held to keep the context alive for the instance's lifetime (made current in
    // `new`); never re-bound after that — capture + encode stay on this thread.
    #[allow(dead_code)]
    context: egl::Context,
    gl: glow::Context,
    egl_image_target_texture_2d_oes: EglImageTargetTexture2DOes,
}

impl Egl {
    /// Load libEGL, pick a headless display, create + make-current a surfaceless
    /// OpenGL context on this thread, and resolve the dmabuf-bind entry point.
    pub fn new() -> Result<Self, String> {
        let inst = unsafe { DynEgl::load_required() }.map_err(|e| format!("load libEGL: {e}"))?;

        // Pick a display (device platform → surfaceless → default), in a scope so
        // the EGL1_5 upcast borrow is released before `inst` is moved into Self.
        let (display, path) = {
            let egl5 = inst.upcast::<egl::EGL1_5>().ok_or("EGL 1.5 not available")?;
            let device_result: Result<egl::Display, String> = (|| {
                type QueryDevicesFn =
                    extern "system" fn(egl::Int, *mut *mut c_void, *mut egl::Int) -> egl::Boolean;
                let proc = inst
                    .get_proc_address("eglQueryDevicesEXT")
                    .ok_or("eglQueryDevicesEXT not available")?;
                // SAFETY: transmute to the EGL_EXT_device_enumeration signature.
                let query_devices: QueryDevicesFn = unsafe { std::mem::transmute(proc) };
                let mut count: egl::Int = 0;
                if query_devices(0, std::ptr::null_mut(), &mut count) == 0 || count <= 0 {
                    return Err(format!("eglQueryDevicesEXT reported {count} devices"));
                }
                let mut devices: Vec<*mut c_void> = vec![std::ptr::null_mut(); count as usize];
                if query_devices(count, devices.as_mut_ptr(), &mut count) == 0 {
                    return Err("eglQueryDevicesEXT enumeration failed".into());
                }
                log::info!("eglQueryDevicesEXT: {count} EGL device(s); using device 0");
                unsafe {
                    egl5.get_platform_display(PLATFORM_DEVICE_EXT, devices[0], &[egl::ATTRIB_NONE])
                }
                .map_err(|e| format!("eglGetPlatformDisplay(DEVICE): {e:?}"))
            })();
            match device_result {
                Ok(d) => (d, "device"),
                Err(e1) => {
                    log::warn!("EGL device platform failed ({e1}); trying surfaceless");
                    match unsafe {
                        egl5.get_platform_display(
                            PLATFORM_SURFACELESS_MESA,
                            std::ptr::null_mut(),
                            &[egl::ATTRIB_NONE],
                        )
                    } {
                        Ok(d) => (d, "surfaceless"),
                        Err(e2) => {
                            log::warn!("surfaceless failed ({e2:?}); trying default display");
                            let d = unsafe { inst.get_display(egl::DEFAULT_DISPLAY) }
                                .ok_or("eglGetDisplay(DEFAULT) returned no display")?;
                            (d, "default")
                        }
                    }
                }
            }
        };

        let (major, minor) = inst
            .initialize(display)
            .map_err(|e| format!("eglInitialize: {e:?}"))?;
        log::info!("EGL {major}.{minor} via {path} platform");
        if (major, minor) < (1, 5) {
            return Err(format!("EGL {major}.{minor} < 1.5 (need eglCreateImage)"));
        }

        inst.bind_api(egl::OPENGL_API)
            .map_err(|e| format!("eglBindAPI(OpenGL): {e:?}"))?;

        let config = inst
            .choose_first_config(
                display,
                &[
                    egl::SURFACE_TYPE,
                    egl::PBUFFER_BIT,
                    egl::RENDERABLE_TYPE,
                    egl::OPENGL_BIT,
                    egl::RED_SIZE,
                    8,
                    egl::GREEN_SIZE,
                    8,
                    egl::BLUE_SIZE,
                    8,
                    egl::ALPHA_SIZE,
                    8,
                    egl::NONE,
                ],
            )
            .map_err(|e| format!("eglChooseConfig: {e:?}"))?
            .ok_or("no matching EGL config")?;

        let context = inst
            .create_context(
                display,
                config,
                None,
                &[
                    egl::CONTEXT_MAJOR_VERSION,
                    3,
                    egl::CONTEXT_MINOR_VERSION,
                    3,
                    egl::NONE,
                ],
            )
            .map_err(|e| format!("eglCreateContext: {e:?}"))?;

        // Surfaceless: no draw/read surface (EGL_KHR_surfaceless_context).
        inst.make_current(display, None, None, Some(context))
            .map_err(|e| format!("eglMakeCurrent (surfaceless): {e:?}"))?;

        let gl = unsafe {
            glow::Context::from_loader_function(|s| {
                inst.get_proc_address(s)
                    .map_or(std::ptr::null(), |f| f as *const c_void)
            })
        };

        let proc = inst
            .get_proc_address("glEGLImageTargetTexture2DOES")
            .ok_or("glEGLImageTargetTexture2DOES not available")?;
        // SAFETY: transmute the loaded GL extension entry point to its known signature.
        let egl_image_target_texture_2d_oes: EglImageTargetTexture2DOes =
            unsafe { std::mem::transmute(proc) };

        Ok(Self { inst, display, context, gl, egl_image_target_texture_2d_oes })
    }

    /// `GL_RENDERER` string (diagnostics).
    pub fn renderer(&self) -> String {
        unsafe { self.gl.get_parameter_string(glow::RENDERER) }
    }

    /// Query the concrete dmabuf modifiers EGL supports for `fourcc` (via
    /// `eglQueryDmaBufModifiersEXT`). KWin needs a concrete modifier offer to
    /// allocate dmabuf buffers — an INVALID-only offer yields empty buffers.
    /// Prefers non-external-only modifiers (importable as `GL_TEXTURE_2D`).
    pub fn query_dmabuf_modifiers(&self, fourcc: u32) -> Vec<u64> {
        type QueryModsFn = extern "system" fn(
            egl::EGLDisplay,
            egl::Int,
            egl::Int,
            *mut u64,
            *mut egl::Boolean,
            *mut egl::Int,
        ) -> egl::Boolean;
        let Some(proc) = self.inst.get_proc_address("eglQueryDmaBufModifiersEXT") else {
            log::warn!("eglQueryDmaBufModifiersEXT unavailable; using implicit modifier");
            return Vec::new();
        };
        // SAFETY: transmute to the EGL_EXT_image_dma_buf_import_modifiers signature.
        let query: QueryModsFn = unsafe { std::mem::transmute(proc) };
        let dpy = self.display.as_ptr();
        let fmt = fourcc as egl::Int;

        let mut count: egl::Int = 0;
        if query(dpy, fmt, 0, std::ptr::null_mut(), std::ptr::null_mut(), &mut count) == 0
            || count <= 0
        {
            log::warn!("no EGL dmabuf modifiers for fourcc 0x{fourcc:08x}");
            return Vec::new();
        }
        let mut mods = vec![0u64; count as usize];
        let mut external = vec![0u32; count as usize];
        if query(dpy, fmt, count, mods.as_mut_ptr(), external.as_mut_ptr(), &mut count) == 0 {
            return Vec::new();
        }
        let n = (count.max(0) as usize).min(mods.len());
        mods.truncate(n);
        external.truncate(n);
        let non_external: Vec<u64> = mods
            .iter()
            .zip(external.iter())
            .filter(|(_, &e)| e == 0)
            .map(|(&m, _)| m)
            .collect();
        log::info!(
            "eglQueryDmaBufModifiers(0x{fourcc:08x}): {} total, {} non-external",
            mods.len(),
            non_external.len()
        );
        if non_external.is_empty() {
            mods
        } else {
            non_external
        }
    }

    /// Import a single-plane dmabuf into an `EGLImage` (BGRx). Omits the modifier
    /// attribs when the negotiated modifier is INVALID/implicit. The returned
    /// image must be released with [`Egl::destroy_image`] after the blit.
    pub fn import_dmabuf(
        &self,
        fd: std::os::fd::RawFd,
        offset: u32,
        stride: i32,
        modifier: u64,
        fourcc: u32,
        width: u32,
        height: u32,
    ) -> Result<egl::Image, String> {
        let egl5 = self.inst.upcast::<egl::EGL1_5>().ok_or("EGL 1.5 not available")?;
        let mut attrs: Vec<egl::Attrib> = vec![
            LINUX_DRM_FOURCC_EXT,
            fourcc as egl::Attrib,
            egl::WIDTH as egl::Attrib,
            width as egl::Attrib,
            egl::HEIGHT as egl::Attrib,
            height as egl::Attrib,
            DMA_BUF_PLANE0_FD_EXT,
            fd as egl::Attrib,
            DMA_BUF_PLANE0_OFFSET_EXT,
            offset as egl::Attrib,
            DMA_BUF_PLANE0_PITCH_EXT,
            stride.max(0) as egl::Attrib,
        ];
        if modifier != DRM_MOD_INVALID && modifier != 0 {
            attrs.push(DMA_BUF_PLANE0_MODIFIER_LO_EXT);
            attrs.push((modifier & 0xffff_ffff) as egl::Attrib);
            attrs.push(DMA_BUF_PLANE0_MODIFIER_HI_EXT);
            attrs.push((modifier >> 32) as egl::Attrib);
        }
        attrs.push(egl::ATTRIB_NONE);

        // For EGL_LINUX_DMA_BUF_EXT the context MUST be EGL_NO_CONTEXT and the
        // client buffer MUST be NULL (per the extension spec).
        egl5.create_image(
            self.display,
            unsafe { egl::Context::from_ptr(egl::NO_CONTEXT) },
            LINUX_DMA_BUF_EXT,
            unsafe { egl::ClientBuffer::from_ptr(std::ptr::null_mut()) },
            &attrs,
        )
        .map_err(|e| format!("eglCreateImage(DMA_BUF): {e:?}"))
    }

    /// Release an `EGLImage` from [`Egl::import_dmabuf`] (call after the blit each
    /// frame, so the underlying dmabuf can be recycled by PipeWire).
    pub fn destroy_image(&self, image: egl::Image) {
        if let Some(egl5) = self.inst.upcast::<egl::EGL1_5>() {
            let _ = egl5.destroy_image(self.display, image);
        }
    }

    /// Re-point `texture` at `image` (a dmabuf-backed `EGLImage`) via
    /// `glEGLImageTargetTexture2DOES`. Used to refresh the imported texture each
    /// frame before the FBO blit.
    fn target_texture(&self, texture: glow::Texture, image: egl::Image) -> Result<(), String> {
        // SAFETY: `texture` is a live GL_TEXTURE_2D name in the current context;
        // the EXT entry point binds the EGLImage's storage to it.
        unsafe {
            self.gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            (self.egl_image_target_texture_2d_oes)(glow::TEXTURE_2D, image.as_ptr() as *const c_void);
            let e = self.gl.get_error();
            if e != glow::NO_ERROR {
                return Err(format!("glEGLImageTargetTexture2DOES failed (GL error 0x{e:04x})"));
            }
        }
        Ok(())
    }

    /// Create the reusable [`BlitTarget`]: an imported `GL_TEXTURE_2D` (re-pointed
    /// per frame), an owned `RGBA8` texture (the NVENC input, allocated once), and
    /// the read/draw FBOs wired to them. The owned texture is the one NVENC registers.
    pub fn make_blit_target(&self, width: i32, height: i32) -> Result<BlitTarget, String> {
        let gl = &self.gl;
        // SAFETY: standard GL object creation in the current context; the owned
        // texture is given immutable storage and the FBOs attach each texture once.
        unsafe {
            let imported = gl.create_texture().map_err(|e| format!("glGenTextures(imported): {e}"))?;
            gl.bind_texture(glow::TEXTURE_2D, Some(imported));
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::NEAREST as i32);
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::NEAREST as i32);
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
            gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);

            let owned = gl.create_texture().map_err(|e| format!("glGenTextures(owned): {e}"))?;
            gl.bind_texture(glow::TEXTURE_2D, Some(owned));
            gl.tex_storage_2d(glow::TEXTURE_2D, 1, glow::RGBA8, width, height);

            let read_fbo = gl.create_framebuffer().map_err(|e| format!("read FBO: {e}"))?;
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(read_fbo));
            gl.framebuffer_texture_2d(
                glow::READ_FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(imported),
                0,
            );
            let draw_fbo = gl.create_framebuffer().map_err(|e| format!("draw FBO: {e}"))?;
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(draw_fbo));
            gl.framebuffer_texture_2d(
                glow::DRAW_FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(owned),
                0,
            );
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);

            Ok(BlitTarget { imported, owned, read_fbo, draw_fbo, width, height })
        }
    }
}

/// The persistent GL objects the capture loop blits each frame's dmabuf into.
/// `owned_texture()` is registered with NVENC once; `blit` refreshes it per frame.
pub struct BlitTarget {
    imported: glow::Texture,
    owned: glow::Texture,
    read_fbo: glow::Framebuffer,
    draw_fbo: glow::Framebuffer,
    width: i32,
    height: i32,
}

impl BlitTarget {
    /// The owned `GL_TEXTURE_2D` name to register as the NVENC input resource.
    pub fn owned_texture(&self) -> u32 {
        self.owned.0.get()
    }

    /// Re-point the imported texture at `image` and FBO-blit it into the owned
    /// texture (the NVENC input). `glFinish` ensures the blit completes before the
    /// encoder maps the owned texture (no explicit-sync object negotiated — B3).
    pub fn blit(&self, egl: &Egl, image: egl::Image) -> Result<(), String> {
        egl.target_texture(self.imported, image)?;
        let gl = &egl.gl;
        // SAFETY: the FBOs already attach imported (read) + owned (draw); blitting
        // copies the freshly-targeted imported texture into the owned one.
        unsafe {
            gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(self.read_fbo));
            gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, Some(self.draw_fbo));
            gl.blit_framebuffer(
                0, 0, self.width, self.height, 0, 0, self.width, self.height,
                glow::COLOR_BUFFER_BIT, glow::NEAREST,
            );
            gl.finish();
            let e = gl.get_error();
            if e != glow::NO_ERROR {
                return Err(format!("FBO blit failed (GL error 0x{e:04x})"));
            }
        }
        Ok(())
    }
}
