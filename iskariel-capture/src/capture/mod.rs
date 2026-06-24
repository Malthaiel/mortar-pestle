//! Continuous capture → encode loop (Stage C + the Stage E integration).
//!
//! Everything after the portal handshake runs **synchronously on one thread**
//! (the PipeWire mainloop thread) with one EGL/GL context current — EGL contexts
//! are thread-affine and NVENC-on-GL binds the current context, so capture, the
//! FBO blit, and the encode all share this thread (`pipewire-rs` `Rc` types are
//! `!Send` regardless). The loop:
//!
//!   portal MONITOR ScreenCast → PipeWire dmabuf (`.process` cb)
//!     → EGLImage → FBO-blit into ONE owned GL_TEXTURE_2D (the NVENC input)
//!   60 Hz mainloop timer (`.tick`) → encode the latest owned texture inline
//!     (~6.4 ms) with the next cfr_index → packets to the [`FrameSink`]
//!
//! Static screen → the timer re-encodes the same owned texture (tiny P-frame).
//! Over-delivery → extra dmabufs just refresh the owned texture between ticks and
//! are never encoded (the drop path; B4 reads the delivered-vs-cfr ratio).

pub mod audio;
pub mod egl;
pub mod portal;
pub mod replay_ring;
pub mod stream;

use std::cell::{Cell, RefCell};
use std::os::fd::AsRawFd;
use std::rc::Rc;
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use spa::pod::Pod;

use nvenc_sys::encoder::{
    Codec, EncodeFlags, Encoder, EncoderConfig, InputHandle, InputKind, NvencGlEncoder, RateControl,
};

// The video PTS fallback (SPA_META_Header absent) and the audio ring anchors share
// this ONE raw CLOCK_MONOTONIC source, so the save-time audio cut co-registers with
// the video clock (Step 6 clock-domain unification).
use crate::daemon::socket::now_mono_ns;

/// 60 fps CFR tick period (the pacer clock).
const FRAME_PERIOD: Duration = Duration::from_nanos(16_666_667);

/// Sink for capture output — defined in [`crate::run`] now (next to its
/// `Recorder`/`TeeSink` impls, the cross-platform home so the Windows daemon pacer
/// can drive them too). Re-exported here for the Linux capture pipeline.
pub use crate::run::FrameSink;

/// Encoder configuration shared by every frame (width/height come from the
/// negotiated PipeWire format at runtime).
#[derive(Debug, Clone, Copy)]
pub struct EncodeParams {
    pub bitrate_bps: u32,
    pub gop_len: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

/// The per-resolution GL pipeline, built lazily on the first dmabuf frame (the
/// negotiated size is authoritative). Lives on the capture thread for the run.
struct GlEngine {
    blit: egl::BlitTarget,
    encoder: NvencGlEncoder,
    handle: InputHandle,
}

/// The latest blitted frame's state (the owned texture already holds its pixels).
#[derive(Default)]
struct Latest {
    ready: bool,
    pts_ns: i64,
}

/// A capture session: opens the portal, streams dmabuf frames, paces to 60 fps,
/// and drives the GL encoder, delivering packets to a [`FrameSink`].
pub struct CaptureSession {
    pub params: EncodeParams,
}

impl CaptureSession {
    pub fn new(params: EncodeParams) -> Self {
        Self { params }
    }

    /// Run the capture → encode loop for `duration`, delivering output to `sink`.
    /// Blocks (runs the PipeWire mainloop) on the calling thread.
    ///
    /// Thin backward-compat wrapper over [`build_clip`]: it owns a one-shot
    /// `MainLoopRc`, builds a single [`Clip`] on it with `on_end = quit-the-loop`
    /// and a duration-based `should_end`, runs the loop until that fires (or a
    /// fatal capture/encode error), then tears the clip down and returns. The
    /// observable behavior — block for `duration`, dump every packet to `sink`,
    /// `Err` on fatal — is behavior-preserving for the `run` CLI subcommand and
    /// the in-flight 10-min Deadlock soak. (`start` is now captured just before
    /// `build_clip`'s portal handshake rather than just after it, so the effective
    /// window is `duration` minus the handshake latency — negligible with the
    /// persisted restore token (~ms), and the soak measures an offset-invariant
    /// PTS span.)
    pub fn run<S: FrameSink + 'static>(
        &self,
        duration: Duration,
        sink: Rc<RefCell<S>>,
    ) -> Result<(), String> {
        // One-shot owning loop for this wrapper (the daemon supplies its own
        // persistent loop instead and never quits it per clip).
        pw::init();
        let mainloop =
            pw::main_loop::MainLoopRc::new(None).map_err(|e| format!("pw mainloop: {e}"))?;

        // The wrapper relies on `duration`: end this (only) clip once the wall
        // clock passes it. `start` is captured here, just before `build_clip`'s
        // portal handshake (the pre-refactor monolith captured it just after — a
        // ~ms restore-token-handshake difference; see this fn's doc comment).
        let start = Instant::now();
        let should_end = move || start.elapsed() >= duration;

        // `on_end` quits the one-shot loop, preserving today's behavior. The
        // pacer fires it on fatal OR `should_end` (the wrapper never flips `stop`).
        let quit_loop = mainloop.downgrade();
        let on_end = move || {
            if let Some(ml) = quit_loop.upgrade() {
                ml.quit();
            }
        };
        let stop = Rc::new(Cell::new(false)); // wrapper leaves this false.

        log::info!("capture loop running for {:.1}s…", duration.as_secs_f64());
        let clip = build_clip(&mainloop, &self.params, sink, stop, should_end, on_end)?;

        mainloop.run();

        // Tear the clip down (drops the pacer timer → releases the loop borrow,
        // disconnects the stream) before returning, exactly as the old
        // `drop(timer)` did. `stop` consumes the clip and yields its fatal slot.
        clip.stop()
    }
}

/// Per-clip resources built on a caller-owned mainloop by [`build_clip`]. Owns
/// everything that lives for one clip — the 60 Hz pacer timer (whose `'l` borrow
/// pins it to the passed loop), the PipeWire stream + its listener, the EGL/GL
/// context, the GL/NVENC engine, and the portal remote core — but **never the
/// loop**. Dropping a `Clip` (via [`stop`](Clip::stop) or scope exit) removes the
/// timer and disconnects the stream **without quitting or destroying the loop**,
/// so the same loop can build the next clip. This is what lets the daemon run one
/// persistent outer loop and build/tear-down clips on it per command.
pub struct Clip<'l> {
    /// 60 Hz pacer timer — borrows `&'l Loop`; held only for its `Drop`, which
    /// calls `destroy_source`, removing the timer from the loop (the old
    /// `drop(timer)`). Never read directly.
    _timer: pw::loop_::TimerSource<'l>,
    /// The capture stream; disconnected in [`stop`](Clip::stop)/`Drop`.
    stream: pw::stream::StreamRc,
    /// Stream listener — its `Drop` unhooks the callbacks. Held for the run.
    _listener: pw::stream::StreamListener<()>,
    /// EGL/GL context (thread-affine; current on the build thread). Kept alive
    /// for the encoder, which binds it.
    _egl: Rc<egl::Egl>,
    /// Portal remote core — keeps the dmabuf stream's transport alive.
    _core: pw::core::CoreRc,
    /// GL/NVENC engine slot (built lazily on the first dmabuf frame).
    _engine: Rc<RefCell<Option<GlEngine>>>,
    /// Fatal capture/encode error, set by the callbacks; surfaced by `stop`.
    fatal: Rc<RefCell<Option<String>>>,
    /// Negotiated encode size `(width, height)`, published by `param_changed`.
    /// Read via [`dimensions`](Clip::dimensions) before teardown for `SavedClip`.
    negotiated: Rc<Cell<(u32, u32)>>,
}

impl Clip<'_> {
    /// The negotiated encode size `(width, height)` (`(0, 0)` if a frame never
    /// negotiated a format). Read before [`stop`](Clip::stop) consumes the clip.
    pub fn dimensions(&self) -> (u32, u32) {
        self.negotiated.get()
    }

    /// Tear down the clip and report its outcome. Consumes `self` so the pacer
    /// timer and stream listener drop here (removing the timer from the loop and
    /// unhooking the callbacks), and explicitly disconnects the stream. Does
    /// **not** touch the loop. Returns the fatal capture/encode error if one was
    /// recorded, else `Ok(())`.
    pub fn stop(self) -> Result<(), String> {
        // Disconnect before the Rc<Stream> drops; ignore an already-gone stream.
        if let Err(e) = self.stream.disconnect() {
            log::warn!("stream disconnect on clip teardown: {e}");
        }
        let err = self.fatal.borrow_mut().take();
        // `self` drops here: TimerSource::Drop removes the pacer from the loop;
        // StreamListener::Drop unhooks; the loop itself is untouched.
        match err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

/// Build one clip's full pipeline — portal session + PipeWire stream + EGL + the
/// owned GL texture + NVENC + the 60 Hz pacer timer — **attached to `mainloop`**,
/// and return a [`Clip`] owning the per-clip resources. The loop is borrowed, not
/// owned: `build_clip` adds sources to it but never runs, quits, or destroys it.
///
/// The caller drives the lifecycle:
/// * `stop` — checked by the pacer every tick; flip it to `true` to end the clip
///   from outside (the daemon does this on `StopClip`). The `run` wrapper leaves
///   it `false` and ends via `should_end`.
/// * `should_end` — an extra per-tick end predicate (the wrapper uses
///   `start.elapsed() >= duration`; the daemon passes `|| false`).
/// * `on_end` — invoked **once** by the pacer when the clip ends (fatal OR `stop`
///   OR `should_end`). In the wrapper it quits the owned loop; in the daemon it
///   must **not** quit the persistent loop — it signals completion (sets a `Cell`/
///   fires a callback) so the capture thread drops the `Clip` and keeps the loop
///   running for the next command. A fatal NVENC error sets `fatal` then calls
///   `on_end` through the same path.
#[allow(clippy::too_many_arguments)]
pub fn build_clip<'l, S, E, D>(
    mainloop: &'l pw::main_loop::MainLoopRc,
    params: &EncodeParams,
    sink: Rc<RefCell<S>>,
    stop: Rc<Cell<bool>>,
    should_end: E,
    on_end: D,
) -> Result<Clip<'l>, String>
where
    S: FrameSink + 'static,
    E: Fn() -> bool + 'static,
    D: Fn() + 'static,
{
    // 1. Portal handshake (own short-lived runtime, dropped before GL exists).
    let portal = portal::handshake()?;
    log::info!(
        "portal: node_id={} compositor_size={}x{}",
        portal.node_id,
        portal.width,
        portal.height
    );

    // 2. EGL display + context (made current on THIS thread) + glow loader.
    let egl = Rc::new(egl::Egl::new()?);
    log::info!("GL renderer: {}", egl.renderer());

    // 3. Concrete dmabuf modifiers EGL supports for BGRx (KWin needs these to
    //    allocate dmabuf buffers — an INVALID-only offer yields empty buffers).
    let modifiers = egl.query_dmabuf_modifiers(stream::DRM_FORMAT_XRGB8888);

    // 4. Shared state for the two mainloop callbacks (single thread → Rc/RefCell).
    let params = *params;
    let format: Rc<RefCell<spa::param::video::VideoInfoRaw>> =
        Rc::new(RefCell::new(Default::default()));
    // Negotiated encode size, published by `param_changed` and read at reap for the
    // `SavedClip` dimensions (the only place the actual encode size is known).
    let negotiated: Rc<Cell<(u32, u32)>> = Rc::new(Cell::new((0, 0)));
    let engine: Rc<RefCell<Option<GlEngine>>> = Rc::new(RefCell::new(None));
    let latest: Rc<RefCell<Latest>> = Rc::new(RefCell::new(Latest::default()));
    let cfr = Rc::new(Cell::new(0u64));
    let fatal: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let logged_pts = Rc::new(Cell::new(false));
    let skip = Rc::new(Cell::new(0u32));

    // 5. The portal remote core on the CALLER'S loop (no per-clip mainloop).
    let context =
        pw::context::ContextRc::new(mainloop, None).map_err(|e| format!("pw context: {e}"))?;
    let core = context
        .connect_fd_rc(portal.fd, None)
        .map_err(|e| format!("pw connect_fd (portal remote): {e}"))?;

    let pw_stream = pw::stream::StreamRc::new(
        core.clone(),
        "iskariel-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("pw stream: {e}"))?;

    // param_changed: parse the negotiated format + declare dmabuf buffers.
    let fmt_pc = format.clone();
    let n_neg = negotiated.clone();
    // process: blit each dmabuf into the owned texture; update `latest`.
    let (p_egl, p_fmt, p_engine, p_latest, p_sink, p_fatal, p_logged, p_skip) = (
        egl.clone(),
        format.clone(),
        engine.clone(),
        latest.clone(),
        sink.clone(),
        fatal.clone(),
        logged_pts.clone(),
        skip.clone(),
    );

    let listener = pw_stream
        .add_local_listener_with_user_data(())
        .state_changed(|_, _, old, new| log::info!("pw stream state: {old:?} -> {new:?}"))
        .param_changed(move |stream, _, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param)
            else {
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
                n_neg.set((size.width, size.height));
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
            if p_fatal.borrow().is_some() {
                return;
            }
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let info = *p_fmt.borrow();
            let size = info.size();
            if size.width == 0 || size.height == 0 {
                return; // format not negotiated yet
            }

            let (pts_ns, from_meta) = match stream::read_pts_ns(&buffer) {
                Some(p) => (p, true),
                None => (now_mono_ns() as i64, false),
            };
            if !p_logged.replace(true) {
                log::info!(
                    "pts source: {}",
                    if from_meta {
                        "SPA_META_Header (CLOCK_MONOTONIC presentation pts)"
                    } else {
                        "CLOCK_MONOTONIC at dequeue (SPA_META_Header absent — approved fallback)"
                    }
                );
            }

            match stream::build_frame(&mut buffer, info) {
                Ok(stream::CapturedFrame::Dmabuf { planes, modifier, fourcc, width, height }) => {
                    // Build the GL engine on the first frame (size is authoritative).
                    let mut slot = p_engine.borrow_mut();
                    if slot.is_none() {
                        match build_engine(&p_egl, &params, width, height) {
                            Ok(e) => {
                                log::info!("GL engine ready: {width}x{height}, owned tex registered with NVENC");
                                *slot = Some(e);
                            }
                            Err(e) => {
                                *p_fatal.borrow_mut() = Some(e);
                                return;
                            }
                        }
                    }
                    let eng = slot.as_ref().unwrap();
                    let image = match p_egl.import_dmabuf(
                        planes[0].fd.as_raw_fd(),
                        planes[0].offset,
                        planes[0].stride,
                        modifier,
                        fourcc,
                        width,
                        height,
                    ) {
                        Ok(i) => i,
                        Err(e) => {
                            log::warn!("import_dmabuf failed (frame dropped): {e}");
                            return;
                        }
                    };
                    let blit_res = eng.blit.blit(&p_egl, image);
                    p_egl.destroy_image(image);
                    if let Err(e) = blit_res {
                        log::warn!("FBO blit failed (frame dropped): {e}");
                        return;
                    }
                    {
                        let mut l = p_latest.borrow_mut();
                        l.ready = true;
                        l.pts_ns = pts_ns;
                    }
                    p_sink.borrow_mut().on_arrival(true, pts_ns);
                }
                Ok(stream::CapturedFrame::Shm { width, height, .. }) => {
                    log::error!(
                        "captured SHM {width}x{height} — dmabuf was NOT negotiated; the zero-copy \
                         GL path is unavailable on this buffer (surfaced in stats)"
                    );
                    p_sink.borrow_mut().on_arrival(false, pts_ns);
                }
                Err(e) => {
                    // Initial/placeholder empty buffers are normal (damage-driven).
                    let n = p_skip.get() + 1;
                    p_skip.set(n);
                    if n == 1 || n % 120 == 0 {
                        log::info!("waiting for a filled buffer (skipped {n}: {e})");
                    }
                }
            }
        })
        .register()
        .map_err(|e| format!("pw register listener: {e}"))?;

    // 6. 60 Hz pacer timer on the CALLER'S loop — encodes the latest texture.
    //    End condition is parameterized: the pacer fires `on_end` exactly once on
    //    fatal OR `stop` OR `should_end`, then stops encoding this clip. It never
    //    touches the loop itself — `on_end` decides (wrapper quits; daemon signals).
    let (t_engine, t_latest, t_sink, t_cfr, t_fatal) =
        (engine.clone(), latest.clone(), sink.clone(), cfr.clone(), fatal.clone());
    let t_stop = stop.clone();
    let ended = Rc::new(Cell::new(false));
    let timer = mainloop.loop_().add_timer(move |_expirations| {
        if t_fatal.borrow().is_some() || t_stop.get() || should_end() {
            // Fire `on_end` once, then go inert for this clip (no more encoding).
            if !ended.replace(true) {
                on_end();
            }
            return;
        }
        // Sample-latest: once a frame exists, every tick encodes (dup if static).
        let (ready, pts_ns) = {
            let l = t_latest.borrow();
            (l.ready, l.pts_ns)
        };
        if !ready {
            return;
        }
        let mut slot = t_engine.borrow_mut();
        let Some(eng) = slot.as_mut() else { return };
        let cfr_index = t_cfr.get();
        let t0 = Instant::now();
        match eng.encoder.encode(eng.handle, cfr_index, EncodeFlags::default()) {
            Ok(packets) => {
                let encode_ns = t0.elapsed().as_nanos();
                let mut s = t_sink.borrow_mut();
                for p in &packets {
                    s.on_packet(&p.data, p.keyframe, cfr_index, pts_ns, encode_ns);
                }
                t_cfr.set(cfr_index + 1);
            }
            Err(e) => {
                *t_fatal.borrow_mut() = Some(format!("NVENC encode failed: {e:?}"));
                if !ended.replace(true) {
                    on_end();
                }
            }
        }
    });
    timer
        .update_timer(Some(FRAME_PERIOD), Some(FRAME_PERIOD))
        .into_result()
        .map_err(|e| format!("arm pacer timer: {e:?}"))?;

    // 7. Connect the stream (dmabuf offer with concrete modifiers). The caller
    //    runs the loop; `build_clip` returns once the pipeline is armed.
    let dmabuf_pod = stream::video_format_pod(&modifiers);
    let mut connect_params = [Pod::from_bytes(&dmabuf_pod).ok_or("bad dmabuf pod")?];
    pw_stream
        .connect(
            spa::utils::Direction::Input,
            Some(portal.node_id),
            pw::stream::StreamFlags::AUTOCONNECT,
            &mut connect_params,
        )
        .map_err(|e| format!("pw stream connect: {e}"))?;

    Ok(Clip {
        _timer: timer,
        stream: pw_stream,
        _listener: listener,
        _egl: egl,
        _core: core,
        _engine: engine,
        fatal,
        negotiated,
    })
}

/// Build the per-resolution GL engine: the owned-texture blit target + an NVENC
/// GL encoder registered to it. The EGL/GL context must be current on this thread.
fn build_engine(egl: &egl::Egl, params: &EncodeParams, width: u32, height: u32) -> Result<GlEngine, String> {
    let blit = egl.make_blit_target(width as i32, height as i32)?;
    let owned_tex = blit.owned_texture();
    let config = EncoderConfig {
        codec: Codec::H264,
        width,
        height,
        fps_num: params.fps_num,
        fps_den: params.fps_den,
        input: InputKind::GlTexture,
        gop_len: params.gop_len,
        b_frames: 0,
        rate_control: Some(RateControl::Cbr { bitrate_bps: params.bitrate_bps }),
    };
    let mut encoder =
        NvencGlEncoder::open(config, owned_tex).map_err(|e| format!("NVENC GL open: {e:?}"))?;
    let handle = encoder
        .register(InputKind::GlTexture)
        .map_err(|e| format!("NVENC register GL texture: {e:?}"))?;
    Ok(GlEngine { blit, encoder, handle })
}
