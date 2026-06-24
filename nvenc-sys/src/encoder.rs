//! `encoder.rs` — the SF3 encoder trait + its NVENC H.264 implementation.
//!
//! [`Encoder`] is the input-agnostic encode surface the capture engine drives:
//! register an input resource once (registration is high-overhead), then encode
//! frames by handle. Phase 1 ships one implementation — [`NvencH264Encoder`] on
//! the CPU ARGB input path (the bring-up path proven in SF2). The zero-copy
//! GL/CUDA input kinds wire in after the B1 interop spike decides GL vs CUDA;
//! production rate control (CBR), explicit GOP config, and the dedicated encode
//! thread are SF4. Here the keyframe cadence is driven by **forced IDR every
//! `gop_len` frames** and B-frames are a hard 0 (enforced at [`NvencH264Encoder::open`]).

#[cfg(not(windows))]
use std::sync::mpsc::{channel, Receiver, Sender};
#[cfg(not(windows))]
use std::thread::JoinHandle;

#[cfg(not(windows))]
use crate::cuda::CudaContext;
use crate::{ffi, status, struct_version, Nvenc, NvencError};

/// Bytes per ARGB pixel.
#[cfg(not(windows))]
const ARGB_BPP: usize = 4;

// NV_ENC_PIC_TYPE values (nvEncodeAPI.h) — a packet is a keyframe iff its output
// picture type is IDR or I. Read from the locked bitstream, never inferred from
// the requested flag (the encoder is the source of truth).
const PIC_TYPE_I: u32 = 0x02;
const PIC_TYPE_IDR: u32 = 0x03;

/// `NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER` = `NVENCAPI_STRUCT_VERSION(1)`.
const NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER: u32 = struct_version(1);

/// Codec selection. Phase 1: H.264 only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
}

/// Input resource kinds an encoder accepts. The B1 interop spike picked **GL**,
/// so the capture engine drives [`NvencGlEncoder`] on `GlTexture`; `HostArgb`
/// stays the CPU bring-up/measurement path on [`NvencH264Encoder`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    /// CPU-side packed ARGB (word-order A8R8G8B8, `[B, G, R, A]` bytes). Bring-up.
    HostArgb,
    /// A `GL_TEXTURE_2D` registered as an NVENC `OPENGL_TEX` input — the zero-copy
    /// capture path. The texture name is supplied to [`NvencGlEncoder::open`]; the
    /// GL producer writes the texture out-of-band before each `encode`.
    GlTexture,
    // CudaDevicePtr, // not used — GL device type locked (B1)
    /// An `ID3D11Texture2D` registered as an NVENC `DIRECTX` input — the Windows
    /// zero-copy capture path (Game Capture SF1). The capture side writes the
    /// texture out-of-band (CopyResource from the WGC frame) before each `encode`.
    #[cfg(windows)]
    D3d11Texture,
}

/// Rate control mode. `None` on [`EncoderConfig`] keeps the preset/tuning
/// default (the SF3 path); `Cbr` configures constant-bitrate encoding (SF4, the
/// capture engine's production mode).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateControl {
    /// Constant bitrate at `bitrate_bps` bits/sec.
    Cbr { bitrate_bps: u32 },
}

/// Encoder configuration. With `rate_control = None` the preset/tuning defaults
/// apply (SF3); `Some(RateControl::Cbr { .. })` configures CBR (SF4). The GOP
/// cadence is forced-IDR every `gop_len` frames and `b_frames` must be 0 (the
/// capture engine's `-bf 0` requirement, enforced at `open`).
#[derive(Debug, Clone, Copy)]
pub struct EncoderConfig {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub input: InputKind,
    /// Keyframe interval in frames (e.g. 2 s @ 60 fps = 120). Must be > 0.
    pub gop_len: u32,
    /// B-frame count. Phase 1: must be 0.
    pub b_frames: u32,
    /// Rate control. `None` = preset default (SF3); `Some(Cbr)` = SF4.
    pub rate_control: Option<RateControl>,
}

/// A registered-input handle. Opaque; valid until [`Encoder::unregister`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputHandle(usize);

/// Per-frame encode flags.
#[derive(Debug, Clone, Copy, Default)]
pub struct EncodeFlags {
    /// Force this frame to an IDR keyframe (on top of the GOP cadence).
    pub force_idr: bool,
}

/// One encoded access unit.
#[derive(Debug, Clone)]
pub struct Packet {
    /// Annex-B elementary-stream bytes (forced-IDR frames carry inline SPS/PPS).
    pub data: Vec<u8>,
    pub pts: u64,
    pub dts: u64,
    pub keyframe: bool,
}

/// The input-agnostic encode surface (SF3). Synchronous — Linux NVENC is
/// sync-only. Phase 1 has one implementation, [`NvencH264Encoder`].
pub trait Encoder {
    /// Input kinds this encoder accepts (Phase 1: exactly one).
    fn accepted_inputs(&self) -> &[InputKind];
    /// Register an input resource (high-overhead — register once, reuse).
    fn register(&mut self, input: InputKind) -> Result<InputHandle, NvencError>;
    /// Release a registered input.
    fn unregister(&mut self, handle: InputHandle) -> Result<(), NvencError>;
    /// Upload a host ARGB frame into a registered `HostArgb` input — the host
    /// analog of a GL/CUDA producer writing its resource out-of-band before
    /// `encode`. `argb` is `width*height*4` bytes, word-order `[B, G, R, A]`.
    fn upload_host_frame(&mut self, handle: InputHandle, argb: &[u8]) -> Result<(), NvencError>;
    /// Encode the frame currently in `handle` at `pts`. Returns the packet(s)
    /// produced (Phase 1: exactly one — no reordering).
    fn encode(
        &mut self,
        handle: InputHandle,
        pts: u64,
        flags: EncodeFlags,
    ) -> Result<Vec<Packet>, NvencError>;
    /// SPS/PPS for the muxer (non-empty once initialized).
    fn sequence_headers(&self) -> Result<Vec<u8>, NvencError>;
    /// Drain buffered frames. Phase 1 is B-frame-free, so this is always empty.
    fn flush(&mut self) -> Result<Vec<Packet>, NvencError>;
}

/// A registered NVENC input buffer plus its (stable) device pitch, captured once
/// at registration so `encode` can fill `inputPitch` without re-locking.
#[cfg(not(windows))]
#[derive(Clone, Copy)]
struct RegisteredInput {
    ptr: *mut std::ffi::c_void,
    pitch: u32,
}

/// NVENC H.264 encoder on the CPU ARGB input path (Phase 1). Owns its [`Nvenc`]
/// (and the CUDA context backing the session), so it holds the raw session
/// handle rather than a borrowing [`crate::Session`].
#[cfg(not(windows))]
pub struct NvencH264Encoder {
    nv: Nvenc,
    _cuda: CudaContext,
    encoder: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    gop_len: u32,
    frame_index: u64,
    /// Registered inputs (handle = index; `None` = freed slot).
    inputs: Vec<Option<RegisteredInput>>,
    /// One reusable output bitstream buffer.
    bitstream: *mut std::ffi::c_void,
}

#[cfg(not(windows))]
impl NvencH264Encoder {
    /// Open + initialize an NVENC H.264 encoder. Errors `Unsupported` for any
    /// non-Phase-1 config (non-H.264 codec, non-`HostArgb` input, `b_frames != 0`,
    /// or `gop_len == 0`).
    pub fn open(config: EncoderConfig) -> Result<Self, NvencError> {
        if config.codec != Codec::H264
            || config.input != InputKind::HostArgb
            || config.b_frames != 0
            || config.gop_len == 0
        {
            return Err(NvencError::Unsupported);
        }
        let nv = Nvenc::load()?;
        let cuda = CudaContext::new()?;
        let encoder = nv.open_cuda_encoder(&cuda)?;
        match config.rate_control {
            None => {
                nv.init_h264(encoder, config.width, config.height, config.fps_num, config.fps_den)?
            }
            Some(RateControl::Cbr { bitrate_bps }) => nv.init_h264_cbr(
                encoder,
                config.width,
                config.height,
                config.fps_num,
                config.fps_den,
                config.gop_len,
                bitrate_bps,
            )?,
        }

        // One reusable output bitstream buffer for the whole session.
        let create_bs = nv
            .api
            .nvEncCreateBitstreamBuffer
            .ok_or(NvencError::Unsupported)?;
        // SAFETY: zeroed struct, version set per the ABI; `bitstreamBuffer` is the
        // out handle. On any error below, `encoder` is destroyed by Drop.
        let bitstream = unsafe {
            let mut cb: ffi::NV_ENC_CREATE_BITSTREAM_BUFFER = std::mem::zeroed();
            cb.version = crate::NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            status(create_bs(encoder, &mut cb))?;
            cb.bitstreamBuffer
        };

        Ok(Self {
            nv,
            _cuda: cuda,
            encoder,
            width: config.width,
            height: config.height,
            gop_len: config.gop_len,
            frame_index: 0,
            inputs: Vec::new(),
            bitstream,
        })
    }

    fn input(&self, handle: InputHandle) -> Result<RegisteredInput, NvencError> {
        self.inputs
            .get(handle.0)
            .and_then(|slot| *slot)
            .ok_or(NvencError::Unsupported)
    }
}

/// Phase 1 accepts exactly one input kind.
#[cfg(not(windows))]
static ACCEPTED: [InputKind; 1] = [InputKind::HostArgb];

#[cfg(not(windows))]
impl Encoder for NvencH264Encoder {
    fn accepted_inputs(&self) -> &[InputKind] {
        &ACCEPTED
    }

    fn register(&mut self, input: InputKind) -> Result<InputHandle, NvencError> {
        if input != InputKind::HostArgb {
            return Err(NvencError::Unsupported);
        }
        let create_in = self.nv.api.nvEncCreateInputBuffer.ok_or(NvencError::Unsupported)?;
        let lock = self.nv.api.nvEncLockInputBuffer.ok_or(NvencError::Unsupported)?;
        let unlock = self.nv.api.nvEncUnlockInputBuffer.ok_or(NvencError::Unsupported)?;
        // SAFETY: zeroed structs with versions set per the ABI; the lock/unlock
        // pair only reads the (stable) device pitch — no pixels touched here.
        let registered = unsafe {
            let mut ci: ffi::NV_ENC_CREATE_INPUT_BUFFER = std::mem::zeroed();
            ci.version = crate::NV_ENC_CREATE_INPUT_BUFFER_VER;
            ci.width = self.width;
            ci.height = self.height;
            ci.bufferFmt = crate::NV_ENC_BUFFER_FORMAT_ARGB as _;
            status(create_in(self.encoder, &mut ci))?;
            let ptr = ci.inputBuffer;

            let mut li: ffi::NV_ENC_LOCK_INPUT_BUFFER = std::mem::zeroed();
            li.version = crate::NV_ENC_LOCK_INPUT_BUFFER_VER;
            li.inputBuffer = ptr;
            status(lock(self.encoder, &mut li))?;
            let pitch = li.pitch;
            let _ = unlock(self.encoder, ptr);
            RegisteredInput { ptr, pitch }
        };
        self.inputs.push(Some(registered));
        Ok(InputHandle(self.inputs.len() - 1))
    }

    fn unregister(&mut self, handle: InputHandle) -> Result<(), NvencError> {
        let slot = self.inputs.get_mut(handle.0).ok_or(NvencError::Unsupported)?;
        let ri = slot.take().ok_or(NvencError::Unsupported)?;
        if let Some(destroy) = self.nv.api.nvEncDestroyInputBuffer {
            // SAFETY: single destroy of a live, registered input buffer.
            unsafe {
                let _ = destroy(self.encoder, ri.ptr);
            }
        }
        Ok(())
    }

    fn upload_host_frame(&mut self, handle: InputHandle, argb: &[u8]) -> Result<(), NvencError> {
        if argb.len() != self.width as usize * self.height as usize * ARGB_BPP {
            return Err(NvencError::Unsupported);
        }
        let ri = self.input(handle)?;
        let lock = self.nv.api.nvEncLockInputBuffer.ok_or(NvencError::Unsupported)?;
        let unlock = self.nv.api.nvEncUnlockInputBuffer.ok_or(NvencError::Unsupported)?;
        // SAFETY: lock yields a CPU-mapped buffer; we copy `width*4` bytes per row
        // at the device pitch, then unlock. Bounds checked above.
        unsafe {
            let mut li: ffi::NV_ENC_LOCK_INPUT_BUFFER = std::mem::zeroed();
            li.version = crate::NV_ENC_LOCK_INPUT_BUFFER_VER;
            li.inputBuffer = ri.ptr;
            status(lock(self.encoder, &mut li))?;
            let pitch = li.pitch as usize;
            let row = self.width as usize * ARGB_BPP;
            for y in 0..self.height as usize {
                std::ptr::copy_nonoverlapping(
                    argb.as_ptr().add(y * row),
                    (li.bufferDataPtr as *mut u8).add(y * pitch),
                    row,
                );
            }
            status(unlock(self.encoder, ri.ptr))
        }
    }

    fn encode(
        &mut self,
        handle: InputHandle,
        pts: u64,
        flags: EncodeFlags,
    ) -> Result<Vec<Packet>, NvencError> {
        let ri = self.input(handle)?;
        let enc = self.nv.api.nvEncEncodePicture.ok_or(NvencError::Unsupported)?;
        let lock_bs = self.nv.api.nvEncLockBitstream.ok_or(NvencError::Unsupported)?;
        let unlock_bs = self.nv.api.nvEncUnlockBitstream.ok_or(NvencError::Unsupported)?;

        // GOP cadence: force IDR at every `gop_len` boundary (and on demand).
        let force_idr = flags.force_idr || self.frame_index % self.gop_len as u64 == 0;
        let mut pic_flags = 0u32;
        if force_idr {
            pic_flags |= crate::NV_ENC_PIC_FLAG_FORCEIDR | crate::NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
        }

        // SAFETY: zeroed pic params with version + buffers + flags set per the ABI;
        // synchronous encode (no B-frames) → output ready on SUCCESS.
        unsafe {
            let mut pic: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
            pic.version = crate::NV_ENC_PIC_PARAMS_VER;
            pic.inputWidth = self.width;
            pic.inputHeight = self.height;
            pic.inputPitch = ri.pitch;
            pic.inputBuffer = ri.ptr;
            pic.outputBitstream = self.bitstream;
            pic.bufferFmt = crate::NV_ENC_BUFFER_FORMAT_ARGB as _;
            pic.pictureStruct = crate::NV_ENC_PIC_STRUCT_FRAME as _;
            pic.encodePicFlags = pic_flags;
            pic.inputTimeStamp = pts;

            let rc = enc(self.encoder, &mut pic);
            if rc as i32 == crate::st::NEED_MORE_INPUT {
                // No B-frames means this shouldn't occur; if it did, no packet yet.
                self.frame_index += 1;
                return Ok(Vec::new());
            }
            status(rc)?;

            let mut lb: ffi::NV_ENC_LOCK_BITSTREAM = std::mem::zeroed();
            lb.version = crate::NV_ENC_LOCK_BITSTREAM_VER;
            lb.outputBitstream = self.bitstream;
            status(lock_bs(self.encoder, &mut lb))?;
            let data = std::slice::from_raw_parts(
                lb.bitstreamBufferPtr as *const u8,
                lb.bitstreamSizeInBytes as usize,
            )
            .to_vec();
            let keyframe = matches!(lb.pictureType as u32, PIC_TYPE_I | PIC_TYPE_IDR);
            let _ = unlock_bs(self.encoder, self.bitstream);

            self.frame_index += 1;
            // No B-frames → dts == pts.
            Ok(vec![Packet { data, pts, dts: pts, keyframe }])
        }
    }

    fn sequence_headers(&self) -> Result<Vec<u8>, NvencError> {
        let f = self.nv.api.nvEncGetSequenceParams.ok_or(NvencError::Unsupported)?;
        let mut buf = vec![0u8; 1024];
        let mut out_size: u32 = 0;
        // SAFETY: client-owned buffer handed to NVENC with its size; NVENC writes
        // SPS/PPS and reports the byte count via `outSPSPPSPayloadSize`.
        unsafe {
            let mut p: ffi::NV_ENC_SEQUENCE_PARAM_PAYLOAD = std::mem::zeroed();
            p.version = NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER;
            p.inBufferSize = buf.len() as u32;
            p.spsppsBuffer = buf.as_mut_ptr() as *mut std::ffi::c_void;
            p.outSPSPPSPayloadSize = &mut out_size;
            status(f(self.encoder, &mut p))?;
        }
        buf.truncate(out_size as usize);
        Ok(buf)
    }

    fn flush(&mut self) -> Result<Vec<Packet>, NvencError> {
        // Phase 1 is B-frame-free (`-bf 0`): every `encode` returns its packet
        // synchronously, so nothing is ever buffered. The EOS-drain path lands
        // when B-frames are supported (post-Phase-1).
        Ok(Vec::new())
    }
}

#[cfg(not(windows))]
impl Drop for NvencH264Encoder {
    fn drop(&mut self) {
        // SAFETY: each handle is destroyed once, in dependency order (inputs +
        // bitstream before the encoder); teardown statuses are ignored.
        unsafe {
            if let Some(destroy_in) = self.nv.api.nvEncDestroyInputBuffer {
                for ri in self.inputs.iter().flatten() {
                    let _ = destroy_in(self.encoder, ri.ptr);
                }
            }
            if let Some(destroy_bs) = self.nv.api.nvEncDestroyBitstreamBuffer {
                let _ = destroy_bs(self.encoder, self.bitstream);
            }
            if let Some(destroy_enc) = self.nv.api.nvEncDestroyEncoder {
                let _ = destroy_enc(self.encoder);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// GL zero-copy encoder (the capture engine's production path)
// ---------------------------------------------------------------------------

/// NVENC H.264 encoder on the **zero-copy GL texture** input path — the capture
/// engine's production encoder. Opened on the OpenGL device type with **no CUDA
/// context**, so the EGL/GL context that owns the input texture MUST be current
/// on the calling thread for `open`, `register`, every `encode`, and `Drop`
/// (NVENC-on-GL binds the current context).
///
/// One owned `GL_TEXTURE_2D` (the capture side's FBO-blit target) is registered
/// **once** via [`Encoder::register`]; each [`Encoder::encode`] maps it (reading
/// the texture's *current* contents, written out-of-band by the capture blit),
/// encodes one frame with the forced-IDR GOP cadence, then unmaps. B-frames are a
/// hard 0 (`-bf 0`), enforced at [`NvencGlEncoder::open`].
pub struct NvencGlEncoder {
    nv: Nvenc,
    encoder: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    gop_len: u32,
    frame_index: u64,
    /// The GL texture name the capture side blits into, registered in `register`.
    gl_texture: u32,
    /// The registered NVENC resource for `gl_texture` (`None` until `register`).
    registered: Option<*mut std::ffi::c_void>,
    /// One reusable output bitstream buffer.
    bitstream: *mut std::ffi::c_void,
}

impl NvencGlEncoder {
    /// Open + initialize an NVENC H.264 encoder on the GL device for `gl_texture`.
    /// The GL context owning `gl_texture` must be current on this thread. Errors
    /// `Unsupported` for any non-Phase-1 config (non-H.264, non-`GlTexture` input,
    /// `b_frames != 0`, or `gop_len == 0`).
    pub fn open(config: EncoderConfig, gl_texture: u32) -> Result<Self, NvencError> {
        if config.codec != Codec::H264
            || config.input != InputKind::GlTexture
            || config.b_frames != 0
            || config.gop_len == 0
        {
            return Err(NvencError::Unsupported);
        }
        let nv = Nvenc::load()?;
        // GL device type: device = NULL, binds the current GL context (no CUDA).
        let encoder = nv.open_gl_encoder()?;
        match config.rate_control {
            None => {
                nv.init_h264(encoder, config.width, config.height, config.fps_num, config.fps_den)?
            }
            Some(RateControl::Cbr { bitrate_bps }) => nv.init_h264_cbr(
                encoder,
                config.width,
                config.height,
                config.fps_num,
                config.fps_den,
                config.gop_len,
                bitrate_bps,
            )?,
        }

        let create_bs = nv.api.nvEncCreateBitstreamBuffer.ok_or(NvencError::Unsupported)?;
        // SAFETY: zeroed struct, version set per the ABI; on any error the encoder
        // is destroyed by Drop.
        let bitstream = unsafe {
            let mut cb: ffi::NV_ENC_CREATE_BITSTREAM_BUFFER = std::mem::zeroed();
            cb.version = crate::NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            status(create_bs(encoder, &mut cb))?;
            cb.bitstreamBuffer
        };

        Ok(Self {
            nv,
            encoder,
            width: config.width,
            height: config.height,
            gop_len: config.gop_len,
            frame_index: 0,
            gl_texture,
            registered: None,
            bitstream,
        })
    }
}

/// The GL encoder accepts exactly one input kind.
static GL_ACCEPTED: [InputKind; 1] = [InputKind::GlTexture];

impl Encoder for NvencGlEncoder {
    fn accepted_inputs(&self) -> &[InputKind] {
        &GL_ACCEPTED
    }

    /// Register the owned GL texture as an NVENC `OPENGL_TEX` resource (once).
    /// Idempotent — a second `register` returns the same handle without re-registering.
    fn register(&mut self, input: InputKind) -> Result<InputHandle, NvencError> {
        if input != InputKind::GlTexture {
            return Err(NvencError::Unsupported);
        }
        if self.registered.is_none() {
            let r =
                self.nv
                    .register_gl_texture(self.encoder, self.gl_texture, self.width, self.height)?;
            self.registered = Some(r);
        }
        Ok(InputHandle(0))
    }

    fn unregister(&mut self, _handle: InputHandle) -> Result<(), NvencError> {
        if let Some(r) = self.registered.take() {
            self.nv.unregister_input(self.encoder, r);
        }
        Ok(())
    }

    /// Unsupported on the GL path: the producer writes the texture out-of-band
    /// (the capture side FBO-blits the dmabuf into it) before `encode`.
    fn upload_host_frame(&mut self, _handle: InputHandle, _argb: &[u8]) -> Result<(), NvencError> {
        Err(NvencError::Unsupported)
    }

    fn encode(
        &mut self,
        _handle: InputHandle,
        pts: u64,
        flags: EncodeFlags,
    ) -> Result<Vec<Packet>, NvencError> {
        let registered = self.registered.ok_or(NvencError::Unsupported)?;
        let enc = self.nv.api.nvEncEncodePicture.ok_or(NvencError::Unsupported)?;
        let lock_bs = self.nv.api.nvEncLockBitstream.ok_or(NvencError::Unsupported)?;
        let unlock_bs = self.nv.api.nvEncUnlockBitstream.ok_or(NvencError::Unsupported)?;

        // Map the registered texture → a fresh input pointer reflecting the GL
        // texture's current contents (the capture blit completed before this call).
        let (mapped, mapped_fmt) = self.nv.map_input(self.encoder, registered)?;

        // GOP cadence: force IDR at every `gop_len` boundary (and on demand).
        let force_idr = flags.force_idr || self.frame_index % self.gop_len as u64 == 0;
        let mut pic_flags = 0u32;
        if force_idr {
            pic_flags |= crate::NV_ENC_PIC_FLAG_FORCEIDR | crate::NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
        }

        // SAFETY: zeroed pic params with version + buffers + flags set per the ABI;
        // synchronous encode (no B-frames) → output ready on SUCCESS. The mapped
        // resource is unmapped on every path below before returning.
        let outcome: Result<Vec<Packet>, NvencError> = unsafe {
            let mut pic: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
            pic.version = crate::NV_ENC_PIC_PARAMS_VER;
            pic.inputWidth = self.width;
            pic.inputHeight = self.height;
            pic.inputPitch = self.width * 4;
            pic.inputBuffer = mapped;
            pic.outputBitstream = self.bitstream;
            pic.bufferFmt = mapped_fmt;
            pic.pictureStruct = crate::NV_ENC_PIC_STRUCT_FRAME as _;
            pic.encodePicFlags = pic_flags;
            pic.inputTimeStamp = pts;

            let rc = enc(self.encoder, &mut pic);
            if rc as i32 == crate::st::NEED_MORE_INPUT {
                // No B-frames means this shouldn't occur; if it did, no packet yet.
                Ok(Vec::new())
            } else if let Err(e) = status(rc) {
                Err(e)
            } else {
                let mut lb: ffi::NV_ENC_LOCK_BITSTREAM = std::mem::zeroed();
                lb.version = crate::NV_ENC_LOCK_BITSTREAM_VER;
                lb.outputBitstream = self.bitstream;
                match status(lock_bs(self.encoder, &mut lb)) {
                    Err(e) => Err(e),
                    Ok(()) => {
                        let data = std::slice::from_raw_parts(
                            lb.bitstreamBufferPtr as *const u8,
                            lb.bitstreamSizeInBytes as usize,
                        )
                        .to_vec();
                        let keyframe = matches!(lb.pictureType as u32, PIC_TYPE_I | PIC_TYPE_IDR);
                        let _ = unlock_bs(self.encoder, self.bitstream);
                        // No B-frames → dts == pts.
                        Ok(vec![Packet { data, pts, dts: pts, keyframe }])
                    }
                }
            }
        };

        self.nv.unmap_input(self.encoder, mapped);
        self.frame_index += 1;
        outcome
    }

    fn sequence_headers(&self) -> Result<Vec<u8>, NvencError> {
        let f = self.nv.api.nvEncGetSequenceParams.ok_or(NvencError::Unsupported)?;
        let mut buf = vec![0u8; 1024];
        let mut out_size: u32 = 0;
        // SAFETY: client-owned buffer handed to NVENC with its size; NVENC writes
        // SPS/PPS and reports the byte count via `outSPSPPSPayloadSize`.
        unsafe {
            let mut p: ffi::NV_ENC_SEQUENCE_PARAM_PAYLOAD = std::mem::zeroed();
            p.version = NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER;
            p.inBufferSize = buf.len() as u32;
            p.spsppsBuffer = buf.as_mut_ptr() as *mut std::ffi::c_void;
            p.outSPSPPSPayloadSize = &mut out_size;
            status(f(self.encoder, &mut p))?;
        }
        buf.truncate(out_size as usize);
        Ok(buf)
    }

    fn flush(&mut self) -> Result<Vec<Packet>, NvencError> {
        // B-frame-free (`-bf 0`) → every `encode` returns its packet synchronously.
        Ok(Vec::new())
    }
}

impl Drop for NvencGlEncoder {
    fn drop(&mut self) {
        // SAFETY: each `encode` already unmapped; unregister the resource (if still
        // registered) before destroying the bitstream + encoder, in dependency order.
        if let Some(r) = self.registered.take() {
            self.nv.unregister_input(self.encoder, r);
        }
        unsafe {
            if let Some(destroy_bs) = self.nv.api.nvEncDestroyBitstreamBuffer {
                let _ = destroy_bs(self.encoder, self.bitstream);
            }
            if let Some(destroy_enc) = self.nv.api.nvEncDestroyEncoder {
                let _ = destroy_enc(self.encoder);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// D3D11 zero-copy encoder (the Windows capture engine's production path, SF1)
// ---------------------------------------------------------------------------

/// NVENC H.264 encoder on the **zero-copy D3D11 texture** input path — the Windows
/// capture engine's production encoder (Game Capture SF1; the D3D11 analog of
/// [`NvencGlEncoder`], proven by the SF0 d3d11wgc spike). Opened on the DirectX
/// device type with the shared `ID3D11Device*` that backs the WGC frame pool; the
/// capture side writes the input `ID3D11Texture2D` out-of-band (CopyResource from
/// the WGC frame, or a stable register-direct pool texture) before each `encode`.
/// Register **once** ([`Encoder::register`]), then map/encode/unmap per frame.
/// B-frames are a hard 0 (`-bf 0`), enforced at [`NvencD3d11Encoder::open`].
#[cfg(windows)]
pub struct NvencD3d11Encoder {
    nv: Nvenc,
    encoder: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    gop_len: u32,
    frame_index: u64,
    /// The input `ID3D11Texture2D*` the capture side writes, registered in `register`.
    texture: *mut std::ffi::c_void,
    /// The registered NVENC resource for `texture` (`None` until `register`).
    registered: Option<*mut std::ffi::c_void>,
    /// One reusable output bitstream buffer.
    bitstream: *mut std::ffi::c_void,
}

#[cfg(windows)]
impl NvencD3d11Encoder {
    /// Open + initialize an NVENC H.264 encoder on the DirectX device for `texture`.
    /// `device` is the `ID3D11Device*` that owns `texture` and backs the capture
    /// frame pool (ONE shared device — see the SF0 spike). Errors `Unsupported` for
    /// any non-Phase-1 config (non-H.264, non-`D3d11Texture` input, `b_frames != 0`,
    /// or `gop_len == 0`).
    pub fn open(
        config: EncoderConfig,
        device: *mut std::ffi::c_void,
        texture: *mut std::ffi::c_void,
    ) -> Result<Self, NvencError> {
        if config.codec != Codec::H264
            || config.input != InputKind::D3d11Texture
            || config.b_frames != 0
            || config.gop_len == 0
        {
            return Err(NvencError::Unsupported);
        }
        let nv = Nvenc::load()?;
        // DirectX device type: bind the shared ID3D11Device (no CUDA, no GL context).
        let encoder = nv.open_d3d11_encoder(device)?;
        match config.rate_control {
            None => {
                nv.init_h264(encoder, config.width, config.height, config.fps_num, config.fps_den)?
            }
            Some(RateControl::Cbr { bitrate_bps }) => nv.init_h264_cbr(
                encoder,
                config.width,
                config.height,
                config.fps_num,
                config.fps_den,
                config.gop_len,
                bitrate_bps,
            )?,
        }

        let create_bs = nv.api.nvEncCreateBitstreamBuffer.ok_or(NvencError::Unsupported)?;
        // SAFETY: zeroed struct, version set per the ABI; on any error the encoder
        // is destroyed by Drop.
        let bitstream = unsafe {
            let mut cb: ffi::NV_ENC_CREATE_BITSTREAM_BUFFER = std::mem::zeroed();
            cb.version = crate::NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            status(create_bs(encoder, &mut cb))?;
            cb.bitstreamBuffer
        };

        Ok(Self {
            nv,
            encoder,
            width: config.width,
            height: config.height,
            gop_len: config.gop_len,
            frame_index: 0,
            texture,
            registered: None,
            bitstream,
        })
    }
}

/// The D3D11 encoder accepts exactly one input kind.
#[cfg(windows)]
static D3D11_ACCEPTED: [InputKind; 1] = [InputKind::D3d11Texture];

#[cfg(windows)]
impl Encoder for NvencD3d11Encoder {
    fn accepted_inputs(&self) -> &[InputKind] {
        &D3D11_ACCEPTED
    }

    /// Register the input `ID3D11Texture2D` as an NVENC `DIRECTX` resource (once).
    /// Idempotent — a second `register` returns the same handle without re-registering.
    fn register(&mut self, input: InputKind) -> Result<InputHandle, NvencError> {
        if input != InputKind::D3d11Texture {
            return Err(NvencError::Unsupported);
        }
        if self.registered.is_none() {
            let r = self
                .nv
                .register_d3d11_texture(self.encoder, self.texture, self.width, self.height)?;
            self.registered = Some(r);
        }
        Ok(InputHandle(0))
    }

    fn unregister(&mut self, _handle: InputHandle) -> Result<(), NvencError> {
        if let Some(r) = self.registered.take() {
            self.nv.unregister_input(self.encoder, r);
        }
        Ok(())
    }

    /// Unsupported on the D3D11 path: the capture side writes the texture
    /// out-of-band (CopyResource from the WGC frame) before `encode`.
    fn upload_host_frame(&mut self, _handle: InputHandle, _argb: &[u8]) -> Result<(), NvencError> {
        Err(NvencError::Unsupported)
    }

    fn encode(
        &mut self,
        _handle: InputHandle,
        pts: u64,
        flags: EncodeFlags,
    ) -> Result<Vec<Packet>, NvencError> {
        let registered = self.registered.ok_or(NvencError::Unsupported)?;
        let enc = self.nv.api.nvEncEncodePicture.ok_or(NvencError::Unsupported)?;
        let lock_bs = self.nv.api.nvEncLockBitstream.ok_or(NvencError::Unsupported)?;
        let unlock_bs = self.nv.api.nvEncUnlockBitstream.ok_or(NvencError::Unsupported)?;

        // Map the registered texture → a fresh input pointer reflecting its current
        // contents (the capture side wrote it before this call).
        let (mapped, mapped_fmt) = self.nv.map_input(self.encoder, registered)?;

        let force_idr = flags.force_idr || self.frame_index % self.gop_len as u64 == 0;
        let mut pic_flags = 0u32;
        if force_idr {
            pic_flags |= crate::NV_ENC_PIC_FLAG_FORCEIDR | crate::NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
        }

        // SAFETY: zeroed pic params with version + buffers + flags set per the ABI;
        // synchronous encode (no B-frames). The mapped resource is unmapped on every
        // path below before returning.
        let outcome: Result<Vec<Packet>, NvencError> = unsafe {
            let mut pic: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
            pic.version = crate::NV_ENC_PIC_PARAMS_VER;
            pic.inputWidth = self.width;
            pic.inputHeight = self.height;
            pic.inputPitch = self.width * 4;
            pic.inputBuffer = mapped;
            pic.outputBitstream = self.bitstream;
            pic.bufferFmt = mapped_fmt;
            pic.pictureStruct = crate::NV_ENC_PIC_STRUCT_FRAME as _;
            pic.encodePicFlags = pic_flags;
            pic.inputTimeStamp = pts;

            let rc = enc(self.encoder, &mut pic);
            if rc as i32 == crate::st::NEED_MORE_INPUT {
                Ok(Vec::new())
            } else if let Err(e) = status(rc) {
                Err(e)
            } else {
                let mut lb: ffi::NV_ENC_LOCK_BITSTREAM = std::mem::zeroed();
                lb.version = crate::NV_ENC_LOCK_BITSTREAM_VER;
                lb.outputBitstream = self.bitstream;
                match status(lock_bs(self.encoder, &mut lb)) {
                    Err(e) => Err(e),
                    Ok(()) => {
                        let data = std::slice::from_raw_parts(
                            lb.bitstreamBufferPtr as *const u8,
                            lb.bitstreamSizeInBytes as usize,
                        )
                        .to_vec();
                        let keyframe = matches!(lb.pictureType as u32, PIC_TYPE_I | PIC_TYPE_IDR);
                        let _ = unlock_bs(self.encoder, self.bitstream);
                        // No B-frames → dts == pts.
                        Ok(vec![Packet { data, pts, dts: pts, keyframe }])
                    }
                }
            }
        };

        self.nv.unmap_input(self.encoder, mapped);
        self.frame_index += 1;
        outcome
    }

    fn sequence_headers(&self) -> Result<Vec<u8>, NvencError> {
        let f = self.nv.api.nvEncGetSequenceParams.ok_or(NvencError::Unsupported)?;
        let mut buf = vec![0u8; 1024];
        let mut out_size: u32 = 0;
        // SAFETY: client-owned buffer handed to NVENC with its size; NVENC writes
        // SPS/PPS and reports the byte count via `outSPSPPSPayloadSize`.
        unsafe {
            let mut p: ffi::NV_ENC_SEQUENCE_PARAM_PAYLOAD = std::mem::zeroed();
            p.version = NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER;
            p.inBufferSize = buf.len() as u32;
            p.spsppsBuffer = buf.as_mut_ptr() as *mut std::ffi::c_void;
            p.outSPSPPSPayloadSize = &mut out_size;
            status(f(self.encoder, &mut p))?;
        }
        buf.truncate(out_size as usize);
        Ok(buf)
    }

    fn flush(&mut self) -> Result<Vec<Packet>, NvencError> {
        // B-frame-free (`-bf 0`) → every `encode` returns its packet synchronously.
        Ok(Vec::new())
    }
}

#[cfg(windows)]
impl Drop for NvencD3d11Encoder {
    fn drop(&mut self) {
        // SAFETY: each `encode` already unmapped; unregister the resource (if still
        // registered) before destroying the bitstream + encoder, in dependency order.
        if let Some(r) = self.registered.take() {
            self.nv.unregister_input(self.encoder, r);
        }
        unsafe {
            if let Some(destroy_bs) = self.nv.api.nvEncDestroyBitstreamBuffer {
                let _ = destroy_bs(self.encoder, self.bitstream);
            }
            if let Some(destroy_enc) = self.nv.api.nvEncDestroyEncoder {
                let _ = destroy_enc(self.encoder);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SF4 — dedicated encode thread
// ---------------------------------------------------------------------------

/// One encode job's result: the packets plus the **encode-only** wall-clock time
/// (the `encode` call alone — excludes the host upload the zero-copy GL/CUDA path
/// won't have), for SF4's ms/frame measurement.
#[cfg(not(windows))]
pub struct EncodeReply {
    pub packets: Vec<Packet>,
    pub encode_ns: u128,
}

#[cfg(not(windows))]
enum Job {
    Encode { argb: Vec<u8>, pts: u64, force_idr: bool },
    Shutdown,
}

/// An [`NvencH264Encoder`] running on its own thread — the SF4 dedicated encode
/// thread. The encoder is created and used *entirely* on the worker (NVENC
/// handles never cross threads, sidestepping the raw pointers' `!Send`); ARGB
/// frames go in and packets come back over channels, so the capture thread can
/// feed it without blocking on NVENC.
#[cfg(not(windows))]
pub struct ThreadedEncoder {
    tx: Sender<Job>,
    rx: Receiver<Result<EncodeReply, NvencError>>,
    worker: Option<JoinHandle<()>>,
}

#[cfg(not(windows))]
impl ThreadedEncoder {
    /// Spawn the worker, build + initialize the encoder there, and register one
    /// `HostArgb` input. Blocks until the encoder is ready, propagating any
    /// open/register error from the worker.
    pub fn spawn(config: EncoderConfig) -> Result<Self, NvencError> {
        let (job_tx, job_rx) = channel::<Job>();
        let (reply_tx, reply_rx) = channel::<Result<EncodeReply, NvencError>>();
        let (ready_tx, ready_rx) = channel::<Result<(), NvencError>>();

        let worker = std::thread::spawn(move || {
            // Build the encoder ON this thread; it never leaves.
            let mut enc = match NvencH264Encoder::open(config) {
                Ok(e) => e,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let handle = match enc.register(InputKind::HostArgb) {
                Ok(h) => h,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            if ready_tx.send(Ok(())).is_err() {
                return;
            }

            while let Ok(job) = job_rx.recv() {
                match job {
                    Job::Shutdown => break,
                    Job::Encode { argb, pts, force_idr } => {
                        let reply = (|| {
                            enc.upload_host_frame(handle, &argb)?;
                            let t0 = std::time::Instant::now();
                            let packets = enc.encode(handle, pts, EncodeFlags { force_idr })?;
                            Ok(EncodeReply { packets, encode_ns: t0.elapsed().as_nanos() })
                        })();
                        if reply_tx.send(reply).is_err() {
                            break;
                        }
                    }
                }
            }
            // `enc` drops here — destroys its buffers + encoder on this thread.
        });

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self { tx: job_tx, rx: reply_rx, worker: Some(worker) }),
            Ok(Err(e)) => {
                let _ = worker.join();
                Err(e)
            }
            Err(_) => Err(NvencError::Lost),
        }
    }

    /// Encode one ARGB frame on the worker thread; returns its packets plus the
    /// encode-only time. Synchronous (one job in flight at a time).
    pub fn encode(
        &self,
        argb: Vec<u8>,
        pts: u64,
        force_idr: bool,
    ) -> Result<EncodeReply, NvencError> {
        self.tx
            .send(Job::Encode { argb, pts, force_idr })
            .map_err(|_| NvencError::Lost)?;
        self.rx.recv().map_err(|_| NvencError::Lost)?
    }
}

#[cfg(not(windows))]
impl Drop for ThreadedEncoder {
    fn drop(&mut self) {
        let _ = self.tx.send(Job::Shutdown);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

#[cfg(all(test, windows))]
mod d3d11_tests {
    use super::*;

    fn cfg(input: InputKind) -> EncoderConfig {
        EncoderConfig {
            codec: Codec::H264,
            width: 1920,
            height: 1080,
            fps_num: 60,
            fps_den: 1,
            input,
            gop_len: 120,
            b_frames: 0,
            rate_control: None,
        }
    }

    // Config validation runs before any device/driver use, so null pointers are
    // safe here — these assert the SF1 encoder's Phase-1 config gate headlessly.
    #[test]
    fn open_rejects_non_d3d11_input() {
        let r = NvencD3d11Encoder::open(
            cfg(InputKind::HostArgb),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        assert!(matches!(r, Err(NvencError::Unsupported)));
    }

    #[test]
    fn open_rejects_b_frames() {
        let mut c = cfg(InputKind::D3d11Texture);
        c.b_frames = 2;
        let r = NvencD3d11Encoder::open(c, std::ptr::null_mut(), std::ptr::null_mut());
        assert!(matches!(r, Err(NvencError::Unsupported)));
    }
}
