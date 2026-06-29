//! B1 interop spike — orchestrator (now a thin caller of the shared `capture` module).
//!
//! Proves one end-to-end chain on this machine and records the GL-vs-CUDA NVENC
//! verdict (locked GL, 2026-06-13):
//!
//!   portal ScreenCast (MONITOR) -> PipeWire -> one BGRx dmabuf frame
//!     -> EGLImage -> FBO-blit into an owned GL_TEXTURE_2D -> NVENC (OPENGL device)
//!     -> one forced-IDR H.264 packet -> ffmpeg decodes a PNG.
//!
//! Since the capture loop landed (Stage C), the EGL/import/blit and the PipeWire
//! dmabuf negotiation live in `crate::capture::{egl, stream, portal}`; this spike
//! reuses them so the one-frame proof and the continuous `run` loop share exactly
//! one implementation of the fragile NVIDIA dmabuf recipe. The GL FBO-blit is now
//! the only path (NVENC rejects EGLImage-external textures — the B1 finding); the
//! SHM arm stays a diagnostic isolator (CPU ARGB -> CUDA) for when dmabuf doesn't
//! negotiate.

use std::cell::{Cell, RefCell};
use std::os::fd::{AsRawFd, OwnedFd};
use std::process::{Command, ExitCode};
use std::rc::Rc;

use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use spa::pod::Pod;

use crate::capture::{egl, portal, stream};

const ES_PATH: &str = "/tmp/mortar-pestle-capture-interop.h264";
const PNG_PATH: &str = "/tmp/mortar-pestle-capture-interop.png";

/// Entry point for `mortar-pestle-capture spike interop`.
pub fn run() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    match run_inner() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log::error!("B1 interop spike failed: {e}");
            eprintln!(
                "\nVERDICT: B1 BLOCKED — {e}\n\
                 (GL arm only per plan; the CUDA fallback arm is a separate confirm-gated step.\n\
                 Re-run with RUST_LOG=debug for more detail.)\n"
            );
            ExitCode::from(1)
        }
    }
}

fn run_inner() -> Result<(), String> {
    // 1. Portal handshake (shared; own short-lived runtime, dropped before GL).
    let portal = portal::handshake()?;
    log::info!(
        "portal: node_id={} compositor_size={}x{}",
        portal.node_id,
        portal.width,
        portal.height
    );

    // 2. EGL display + context (made current on THIS thread) + glow loader.
    let egl = egl::Egl::new()?;
    log::info!("GL renderer: {}", egl.renderer());

    // 3. Query concrete dmabuf modifiers, then capture one frame (shared helpers).
    let modifiers = egl.query_dmabuf_modifiers(stream::DRM_FORMAT_XRGB8888);
    let frame = capture_one_frame(portal.fd, portal.node_id, &modifiers)?;

    // 4. NVENC: branch on the buffer path we actually got.
    let nv = nvenc_sys::Nvenc::load().map_err(|e| format!("NVENC load: {e:?}"))?;
    let (es, gl_path, verdict_detail) = match frame {
        stream::CapturedFrame::Dmabuf { planes, modifier, fourcc, width, height } => {
            log::info!(
                "captured DMABUF {width}x{height} fourcc=0x{fourcc:08x} modifier=0x{modifier:016x} \
                 planes={} plane0(offset={}, stride={})",
                planes.len(),
                planes[0].offset,
                planes[0].stride
            );
            // GL context is current → open the OPENGL NVENC session.
            let session = nv
                .open_gl_session()
                .map_err(|e| format!("open_gl_session (is the GL context current?): {e:?}"))?;
            session
                .initialize_h264(width, height, 60, 1)
                .map_err(|e| format!("init_h264: {e:?}"))?;
            // Import the dmabuf and FBO-blit it into an owned GL_TEXTURE_2D (the
            // only path — NVENC rejects EGLImage-external textures), then encode.
            let image = egl.import_dmabuf(
                planes[0].fd.as_raw_fd(),
                planes[0].offset,
                planes[0].stride,
                modifier,
                fourcc,
                width,
                height,
            )?;
            let blit = egl.make_blit_target(width as i32, height as i32)?;
            let blit_res = blit.blit(&egl, image);
            egl.destroy_image(image);
            blit_res?;
            let es = session
                .test_encode_h264_gl_tex(width, height, blit.owned_texture())
                .map_err(|e| format!("nvenc GL encode (FBO blit): {e:?}"))?;
            log::info!("GL FBO-blit encode OK ({} bytes)", es.len());
            (es, true, "GL device type (NV_ENC_DEVICE_TYPE_OPENGL) + OPENGL_TEX dmabuf input")
        }
        stream::CapturedFrame::Shm { bytes, stride, width, height } => {
            log::warn!(
                "captured SHM {width}x{height} (stride={stride}) — dmabuf was NOT negotiated; \
                 running the SHM isolator (decision 6): encode it to prove capture+encode work."
            );
            let cuda = nvenc_sys::cuda::CudaContext::new().map_err(|e| format!("CUDA ctx: {e:?}"))?;
            let session = nv
                .open_cuda_session(&cuda)
                .map_err(|e| format!("open_cuda_session: {e:?}"))?;
            session
                .initialize_h264(width, height, 60, 1)
                .map_err(|e| format!("init_h264: {e:?}"))?;
            let argb = repack_bgrx(&bytes, stride, width, height);
            let es = session
                .test_encode_h264_argb(width, height, &argb)
                .map_err(|e| format!("nvenc ARGB encode: {e:?}"))?;
            log::info!("SHM isolator encode OK ({} bytes)", es.len());
            (es, false, "SHM isolator (CPU ARGB) — capture+encode proven; dmabuf/EGL import is the gap")
        }
    };

    // 5. Write the ES and shell ffmpeg for the decode-proof PNG.
    std::fs::write(ES_PATH, &es).map_err(|e| format!("write ES: {e}"))?;
    let head: Vec<String> = es.iter().take(5).map(|b| format!("{b:02x}")).collect();
    log::info!("wrote {} bytes ES -> {ES_PATH} (first: {})", es.len(), head.join(" "));
    decode_proof(ES_PATH, PNG_PATH)?;

    // 6. Verdict.
    if gl_path {
        eprintln!(
            "\nVERDICT: B1 PASS — {verdict_detail}\n  \
             shared path: capture::{{egl,stream,portal}} (same code the `run` loop uses)\n  \
             proof: {PNG_PATH} — open it and eyeball vs the captured screen.\n  \
             A BGR/RGB or matrix color shift is EXPECTED here and deferred to the B2 color spike.\n"
        );
    } else {
        eprintln!(
            "\nVERDICT: B1 PARTIAL — {verdict_detail}\n  \
             KWin handed back an SHM buffer, not a dmabuf. Isolator proof: {PNG_PATH}.\n"
        );
    }
    Ok(())
}

/// Capture exactly one frame over the portal `fd`, then stop. A thin one-frame
/// PipeWire mainloop built on the shared `capture::stream` pods + parser.
fn capture_one_frame(
    fd: OwnedFd,
    node_id: u32,
    modifiers: &[u64],
) -> Result<stream::CapturedFrame, String> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| format!("pw mainloop: {e}"))?;
    let context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| format!("pw context: {e}"))?;
    let core = context
        .connect_fd_rc(fd, None)
        .map_err(|e| format!("pw connect_fd (portal remote): {e}"))?;

    let pw_stream = pw::stream::StreamRc::new(
        core,
        "mortar-pestle-capture-b1",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("pw stream: {e}"))?;

    let format: Rc<RefCell<spa::param::video::VideoInfoRaw>> = Rc::new(RefCell::new(Default::default()));
    let captured: Rc<RefCell<Option<stream::CapturedFrame>>> = Rc::new(RefCell::new(None));
    let cap_err: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let loop_weak = mainloop.downgrade();

    let fmt_pc = format.clone();
    let fmt_proc = format.clone();
    let cap_proc = captured.clone();
    let err_proc = cap_err.clone();
    let skip = Cell::new(0u32);

    let _listener = pw_stream
        .add_local_listener_with_user_data(())
        .state_changed(|_, _, old, new| log::info!("pw stream state: {old:?} -> {new:?}"))
        .param_changed(move |stream, _, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param) else {
                return;
            };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            let mut info = spa::param::video::VideoInfoRaw::default();
            if info.parse(param).is_ok() {
                let size = info.size();
                log::info!(
                    "negotiated format: {:?} {}x{} modifier=0x{:016x}",
                    info.format(),
                    size.width,
                    size.height,
                    info.modifier()
                );
                *fmt_pc.borrow_mut() = info;
                let pod_bytes = stream::buffers_pod(size.width, size.height);
                match Pod::from_bytes(&pod_bytes) {
                    Some(pod) => match stream.update_params(&mut [pod]) {
                        Ok(()) => log::info!("declared SPA_PARAM_Buffers (dataType=dmabuf)"),
                        Err(e) => log::warn!("update_params(Buffers) failed: {e}"),
                    },
                    None => log::warn!("failed to build Buffers pod"),
                }
            }
        })
        .process(move |stream, _| {
            if cap_proc.borrow().is_some() {
                return;
            }
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let info = *fmt_proc.borrow();
            match stream::build_frame(&mut buffer, info) {
                Ok(frame) => {
                    *cap_proc.borrow_mut() = Some(frame);
                    if let Some(ml) = loop_weak.upgrade() {
                        ml.quit();
                    }
                }
                Err(e) => {
                    let n = skip.get() + 1;
                    skip.set(n);
                    if n == 1 || n % 60 == 0 {
                        log::info!("waiting for a filled buffer (skipped {n}: {e})");
                    }
                    if n >= 300 {
                        *err_proc.borrow_mut() = Some(format!("no filled buffer after {n} tries; last: {e}"));
                        if let Some(ml) = loop_weak.upgrade() {
                            ml.quit();
                        }
                    }
                }
            }
        })
        .register()
        .map_err(|e| format!("pw register listener: {e}"))?;

    let dmabuf_pod = stream::video_format_pod(modifiers);
    let mut params = [Pod::from_bytes(&dmabuf_pod).ok_or("bad dmabuf pod")?];
    pw_stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT,
            &mut params,
        )
        .map_err(|e| format!("pw stream connect: {e}"))?;

    log::info!("pw mainloop running; waiting for one frame…");
    mainloop.run();

    if let Some(e) = cap_err.borrow_mut().take() {
        return Err(e);
    }
    let frame = captured.borrow_mut().take();
    frame.ok_or_else(|| "mainloop exited without capturing a frame".to_string())
}

/// Repack a BGRx SHM frame (possibly padded `stride`) into tight `width*4` rows.
/// BGRx bytes `[B,G,R,x]` are valid NV_ENC_BUFFER_FORMAT_ARGB input — no channel
/// swap, only de-padding.
fn repack_bgrx(bytes: &[u8], stride: i32, width: u32, height: u32) -> Vec<u8> {
    let stride = stride.max(0) as usize;
    let row = width as usize * 4;
    let mut out = vec![0u8; row * height as usize];
    for y in 0..height as usize {
        let src = y * stride;
        let dst = y * row;
        if src + row <= bytes.len() {
            out[dst..dst + row].copy_from_slice(&bytes[src..src + row]);
        }
    }
    out
}

/// Shell system ffmpeg to decode the first frame of the raw H.264 ES to a PNG.
fn decode_proof(es: &str, png: &str) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i", es, "-frames:v", "1", png])
        .status()
        .map_err(|e| format!("spawn ffmpeg (is it installed?): {e}"))?;
    if status.success() {
        log::info!("ffmpeg decode-proof -> {png}");
        Ok(())
    } else {
        Err(format!("ffmpeg decode failed ({status}) — the ES may be malformed"))
    }
}
