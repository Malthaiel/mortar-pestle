//! `nvenc-sys` — thin, nothing-linked FFI to NVIDIA NVENC.
//!
//! `bindgen` (build.rs) generates raw declarations from the vendored MIT
//! `nv-codec-headers` `nvEncodeAPI.h` (NVENCAPI 13.0, see `vendor/`); the NVENC
//! entry points are resolved at runtime by `dlopen`-ing the driver's
//! `libnvidia-encode.so.1` (one entry: `NvEncodeAPICreateInstance`). Nothing is
//! linked — the crate stays loadable with no NVIDIA driver, returning
//! [`NvencError::DriverMissing`] instead of failing to link.
//!
//! SF1 surface (Encode Engine.md): the [`Nvenc`] loader, the struct-version
//! helpers ([`struct_version`]), typed [`NvencError`], and [`probe`]. SF2 adds
//! [`Session`] — a CUDA-device session open plus a 1-frame ARGB
//! [`Session::test_encode_h264_argb`] that proves the function-pointer table
//! drives a real H.264 encode (the probe contract: never trust caps listings).
//! The encoder trait (SF3) builds on the same [`Nvenc::api`] table.

/// Raw bindgen output (NVENC C ABI). Names follow the C header.
pub mod ffi {
    // Machine-generated bindgen output — silence all lints (the conventional
    // posture for a generated include; nothing here is hand-maintained).
    #![allow(warnings)]
    include!(concat!(env!("OUT_DIR"), "/nvenc_bindings.rs"));
}

pub mod cuda;
pub mod encoder;

use libloading::{Library, Symbol};

// NVENC API version from the vendored header (tag n13.0.19.0):
//   #define NVENCAPI_MAJOR_VERSION 13
//   #define NVENCAPI_MINOR_VERSION 0
pub const NVENCAPI_MAJOR_VERSION: u32 = 13;
pub const NVENCAPI_MINOR_VERSION: u32 = 0;

/// `NVENCAPI_VERSION` — the struct-tagging encoding: `major | (minor << 24)`.
pub const NVENCAPI_VERSION: u32 = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);

/// `NvEncodeAPIGetMaxSupportedVersion` packs as `(major << 4) | minor` — a
/// *different* encoding from [`NVENCAPI_VERSION`]. Use this for the driver
/// compatibility check.
pub const NVENCAPI_VERSION_PACKED: u32 = (NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION;

/// `NVENCAPI_STRUCT_VERSION(ver)` from nvEncodeAPI.h:
///   `NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)`.
///
/// Every NVENC struct's `.version` field must be set to its `_VER` value or the
/// driver rejects the call with `NV_ENC_ERR_INVALID_VERSION` — the classic
/// silent NVENC failure this crate's tests guard against.
pub const fn struct_version(ver: u32) -> u32 {
    NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)
}

/// `NV_ENCODE_API_FUNCTION_LIST_VER` = `NVENCAPI_STRUCT_VERSION(2)`.
pub const NV_ENCODE_API_FUNCTION_LIST_VER: u32 = struct_version(2);

/// Typed loader / session errors — the SF1 contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NvencError {
    /// `libnvidia-encode.so.1` absent or unloadable (no usable NVIDIA driver).
    DriverMissing,
    /// All concurrent NVENC sessions in use (GeForce cap is 12 since Nov 2025).
    SessionLimit,
    /// Requested codec / format / device type / API version unsupported.
    Unsupported,
    /// Session lost or an unmapped NVENC status (driver reset / generic error).
    Lost,
}

// NVENCSTATUS values from `_NVENCSTATUS` in nvEncodeAPI.h (tag n13.0.19.0).
// Referenced by value, NOT by bindgen const name: bindgen's `Consts` mode
// disambiguates some colliding variants with an `_NVENCSTATUS_` prefix (e.g.
// `_NVENCSTATUS_NV_ENC_ERR_OUT_OF_MEMORY`) while leaving others bare, so the
// generated names are inconsistent. These integer values are stable NVENC ABI.
mod st {
    pub const SUCCESS: i32 = 0;
    pub const ERR_NO_ENCODE_DEVICE: i32 = 1;
    pub const ERR_OUT_OF_MEMORY: i32 = 10;
    pub const ERR_UNSUPPORTED_PARAM: i32 = 12;
    pub const ERR_INVALID_VERSION: i32 = 15;
    /// Not an error: encoder is buffering and needs more input (B-frames /
    /// lookahead). The single-frame test encode flushes with EOS if it sees this.
    pub const NEED_MORE_INPUT: i32 = 17;
}

/// Map a raw `NVENCSTATUS` to the typed error set.
fn status(code: ffi::NVENCSTATUS) -> Result<(), NvencError> {
    match code as i32 {
        st::SUCCESS => Ok(()),
        st::ERR_INVALID_VERSION | st::ERR_UNSUPPORTED_PARAM => Err(NvencError::Unsupported),
        st::ERR_NO_ENCODE_DEVICE => Err(NvencError::DriverMissing),
        st::ERR_OUT_OF_MEMORY => Err(NvencError::SessionLimit),
        _ => Err(NvencError::Lost),
    }
}

type CreateInstanceFn =
    unsafe extern "C" fn(*mut ffi::NV_ENCODE_API_FUNCTION_LIST) -> ffi::NVENCSTATUS;
type GetMaxVersionFn = unsafe extern "C" fn(*mut u32) -> ffi::NVENCSTATUS;

/// A loaded NVENC API instance: the driver library kept alive plus the resolved
/// function-pointer table.
pub struct Nvenc {
    _lib: Library,
    /// The NVENC function-pointer table (`nvEncOpenEncodeSessionEx`, …) — the
    /// surface SF3's encoder trait calls through.
    pub api: ffi::NV_ENCODE_API_FUNCTION_LIST,
    /// Driver's max supported version, packed `(major << 4) | minor`.
    pub driver_max_version: u32,
}

impl Nvenc {
    /// Load the NVENC driver library and create the API instance. The driver
    /// library name is per-OS: `nvEncodeAPI64.dll` on Windows (Game Capture SF0),
    /// `libnvidia-encode.so.1` elsewhere.
    pub fn load() -> Result<Self, NvencError> {
        #[cfg(windows)]
        let name = "nvEncodeAPI64.dll";
        #[cfg(not(windows))]
        let name = "libnvidia-encode.so.1";
        Self::load_from(name)
    }

    /// Testable variant — load a named library (pass a bogus name to exercise
    /// the [`NvencError::DriverMissing`] path without an NVIDIA driver).
    pub fn load_from(lib_name: &str) -> Result<Self, NvencError> {
        // SAFETY: dlopen of a versioned driver `.so`; `lib` is kept alive in the
        // returned value so the resolved symbols stay valid for its lifetime.
        unsafe {
            let lib = Library::new(lib_name).map_err(|_| NvencError::DriverMissing)?;

            let get_max: Symbol<GetMaxVersionFn> = lib
                .get(b"NvEncodeAPIGetMaxSupportedVersion\0")
                .map_err(|_| NvencError::DriverMissing)?;
            let mut driver_max_version: u32 = 0;
            status(get_max(&mut driver_max_version))?;

            // The header must not be newer than the driver (packed encoding).
            if NVENCAPI_VERSION_PACKED > driver_max_version {
                return Err(NvencError::Unsupported);
            }

            let create: Symbol<CreateInstanceFn> = lib
                .get(b"NvEncodeAPICreateInstance\0")
                .map_err(|_| NvencError::DriverMissing)?;
            let mut api: ffi::NV_ENCODE_API_FUNCTION_LIST = std::mem::zeroed();
            api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
            status(create(&mut api))?;

            Ok(Self { _lib: lib, api, driver_max_version })
        }
    }
}

/// What the driver supports — the SF1 slice (version handshake). SF2 extends
/// this with the full caps query + a 1-frame test encode.
#[derive(Debug, Clone)]
pub struct EncoderCaps {
    /// Driver max NVENC API version, packed `(major << 4) | minor`.
    pub driver_max_version: u32,
    /// This build's header version, packed `(major << 4) | minor`.
    pub header_version: u32,
}

/// Load the driver and report the version handshake. Fails loud with a typed
/// [`NvencError`] when NVENC is absent — never silently at first real frame.
pub fn probe() -> Result<EncoderCaps, NvencError> {
    let nv = Nvenc::load()?;
    Ok(EncoderCaps {
        driver_max_version: nv.driver_max_version,
        header_version: NVENCAPI_VERSION_PACKED,
    })
}

// `_NV_ENC_DEVICE_TYPE { DIRECTX=0, CUDA=1, OPENGL=2 }` — by value (bindgen
// `Consts` const names are inconsistent; same reasoning as the status() codes).
const NV_ENC_DEVICE_TYPE_CUDA: u32 = 1;
// OPENGL device type — Linux-only; `device` is NULL (current GL context used). B1.
const NV_ENC_DEVICE_TYPE_OPENGL: u32 = 2;
// DIRECTX device type — Windows; `device` is the `ID3D11Device*`. Game Capture SF0.
#[cfg(windows)]
const NV_ENC_DEVICE_TYPE_DIRECTX: u32 = 0;

/// `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER` = `NVENCAPI_STRUCT_VERSION(1)`.
pub const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 = struct_version(1);

// --- H.264 test-encode surface (SF2): GUIDs, struct versions, enum values ---

const fn guid(d1: u32, d2: u16, d3: u16, d4: [u8; 8]) -> ffi::GUID {
    ffi::GUID { Data1: d1, Data2: d2, Data3: d3, Data4: d4 }
}

// bindgen does NOT emit the header's `static const GUID` initializers, so the
// codec/preset GUIDs are hardcoded from nvEncodeAPI.h (tag n13.0.19.0).
/// `NV_ENC_CODEC_H264_GUID`.
const NV_ENC_CODEC_H264_GUID: ffi::GUID =
    guid(0x6bc8_2762, 0x4e63, 0x4ca4, [0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf]);
/// `NV_ENC_PRESET_P4_GUID` — balanced preset. With ultra-low-latency tuning it
/// runs B-frame-free (the engine's `-bf 0` requirement) and outputs each frame
/// synchronously, so one forced-IDR frame needs no reorder flush.
const NV_ENC_PRESET_P4_GUID: ffi::GUID =
    guid(0x90a7_b826, 0xdf06, 0x4862, [0xb9, 0xd2, 0xcd, 0x6d, 0x73, 0xa0, 0x86, 0x81]);

/// `NV_ENC_INITIALIZE_PARAMS_VER` = `STRUCT_VERSION(7) | (1<<31)` (extensible).
pub const NV_ENC_INITIALIZE_PARAMS_VER: u32 = struct_version(7) | (1 << 31);
/// `NV_ENC_CREATE_INPUT_BUFFER_VER` = `STRUCT_VERSION(2)`.
pub const NV_ENC_CREATE_INPUT_BUFFER_VER: u32 = struct_version(2);
/// `NV_ENC_CREATE_BITSTREAM_BUFFER_VER` = `STRUCT_VERSION(1)`.
pub const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = struct_version(1);
/// `NV_ENC_LOCK_INPUT_BUFFER_VER` = `STRUCT_VERSION(1)`.
pub const NV_ENC_LOCK_INPUT_BUFFER_VER: u32 = struct_version(1);
/// `NV_ENC_PIC_PARAMS_VER` = `STRUCT_VERSION(7) | (1<<31)`.
pub const NV_ENC_PIC_PARAMS_VER: u32 = struct_version(7) | (1 << 31);
/// `NV_ENC_LOCK_BITSTREAM_VER` = `STRUCT_VERSION(2) | (1<<31)`.
pub const NV_ENC_LOCK_BITSTREAM_VER: u32 = struct_version(2) | (1 << 31);
/// `NV_ENC_PRESET_CONFIG_VER` = `STRUCT_VERSION(5) | (1<<31)` (SF4 CBR config).
pub const NV_ENC_PRESET_CONFIG_VER: u32 = struct_version(5) | (1 << 31);
/// `NV_ENC_CONFIG_VER` = `STRUCT_VERSION(9) | (1<<31)` (SF4 CBR config).
pub const NV_ENC_CONFIG_VER: u32 = struct_version(9) | (1 << 31);
/// `NV_ENC_REGISTER_RESOURCE_VER` = `STRUCT_VERSION(5)` (register a GL/CUDA input — B1).
pub const NV_ENC_REGISTER_RESOURCE_VER: u32 = struct_version(5);
/// `NV_ENC_MAP_INPUT_RESOURCE_VER` = `STRUCT_VERSION(4)` (map a registered input — B1).
pub const NV_ENC_MAP_INPUT_RESOURCE_VER: u32 = struct_version(4);

// Enum values by ABI value (bindgen `Consts` names are inconsistent — same
// reasoning as status()/device-type above). From nvEncodeAPI.h:
/// word-order A8R8G8B8 — bytes are `[B, G, R, A]` per pixel.
const NV_ENC_BUFFER_FORMAT_ARGB: u32 = 0x0100_0000;
const NV_ENC_PIC_STRUCT_FRAME: u32 = 0x01;
const NV_ENC_PIC_FLAG_FORCEIDR: u32 = 0x2;
const NV_ENC_PIC_FLAG_OUTPUT_SPSPPS: u32 = 0x4;
const NV_ENC_PIC_FLAG_EOS: u32 = 0x8;
const NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY: u32 = 3;
// `_NV_ENC_PARAMS_RC_MODE { CONSTQP=0, VBR=1, CBR=2 }` — SF4 uses CBR.
const NV_ENC_PARAMS_RC_CBR: u32 = 0x2;
// `_NV_ENC_INPUT_RESOURCE_TYPE { DIRECTX=0x0, ..., OPENGL_TEX=0x3 }` — input register.
const NV_ENC_INPUT_RESOURCE_TYPE_OPENGL_TEX: u32 = 0x3;
// DIRECTX (D3D11) input resource — register an `ID3D11Texture2D*` directly. SF0.
#[cfg(windows)]
const NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX: u32 = 0x0;
// `_NV_ENC_BUFFER_USAGE { NV_ENC_INPUT_IMAGE=0x0, ... }`.
const NV_ENC_INPUT_IMAGE: u32 = 0x0;
// GL `GL_TEXTURE_2D` target (NV_ENC_INPUT_RESOURCE_OPENGL_TEX.target accepts
// GL_TEXTURE_2D or GL_TEXTURE_RECTANGLE).
const GL_TEXTURE_2D: u32 = 0x0DE1;

/// An open NVENC encode session bound to a device. Destroyed on drop.
pub struct Session<'a> {
    nv: &'a Nvenc,
    encoder: *mut std::ffi::c_void,
}

impl Nvenc {
    /// Open a raw NVENC encode session on a CUDA device, returning the opaque
    /// session handle. Shared by [`Nvenc::open_cuda_session`] (the SF2 probe
    /// wrapper) and the SF3 [`encoder::NvencH264Encoder`], which owns its `Nvenc`
    /// and so cannot hold a borrowing [`Session`].
    pub fn open_cuda_encoder(
        &self,
        ctx: &cuda::CudaContext,
    ) -> Result<*mut std::ffi::c_void, NvencError> {
        let open = self.api.nvEncOpenEncodeSessionEx.ok_or(NvencError::Unsupported)?;
        // SAFETY: `params` is zeroed then its version/device fields set per the
        // NVENC ABI; `encoder` receives the opaque session handle on success.
        unsafe {
            let mut params: ffi::NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS = std::mem::zeroed();
            params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
            params.deviceType = NV_ENC_DEVICE_TYPE_CUDA as _;
            params.device = ctx.as_ptr();
            params.apiVersion = NVENCAPI_VERSION;
            let mut encoder: *mut std::ffi::c_void = std::ptr::null_mut();
            status(open(&mut params, &mut encoder))?;
            Ok(encoder)
        }
    }

    /// Open an NVENC session on a CUDA device. This is the self-contained
    /// bring-up / self-test device (SF2); the engine's real dmabuf input path
    /// (GL vs CUDA) is decided independently by the Phase-0 interop spike (B1).
    pub fn open_cuda_session<'a>(
        &'a self,
        ctx: &cuda::CudaContext,
    ) -> Result<Session<'a>, NvencError> {
        Ok(Session { nv: self, encoder: self.open_cuda_encoder(ctx)? })
    }

    /// Open a raw NVENC encode session on the **OpenGL** device type (Linux-only).
    /// Unlike the CUDA path, `device` is NULL: NVENC binds the GL context that is
    /// *current on the calling thread*, so the caller must have an EGL/GL context
    /// current before this call and keep it current for the session's
    /// register/map/encode lifetime. Shared by [`Nvenc::open_gl_session`] (the B1
    /// interop spike's GL arm).
    pub fn open_gl_encoder(&self) -> Result<*mut std::ffi::c_void, NvencError> {
        let open = self.api.nvEncOpenEncodeSessionEx.ok_or(NvencError::Unsupported)?;
        // SAFETY: `params` is zeroed then its version/device fields set per the
        // NVENC ABI; `device = NULL` is required for the OPENGL device type (the
        // current GL context is used implicitly). `encoder` receives the handle.
        unsafe {
            let mut params: ffi::NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS = std::mem::zeroed();
            params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
            params.deviceType = NV_ENC_DEVICE_TYPE_OPENGL as _;
            params.device = std::ptr::null_mut();
            params.apiVersion = NVENCAPI_VERSION;
            let mut encoder: *mut std::ffi::c_void = std::ptr::null_mut();
            status(open(&mut params, &mut encoder))?;
            Ok(encoder)
        }
    }

    /// Open an NVENC session on the OpenGL device type (B1 spike GL arm). The GL
    /// context must be current on this thread — see [`Nvenc::open_gl_encoder`].
    pub fn open_gl_session(&self) -> Result<Session<'_>, NvencError> {
        Ok(Session { nv: self, encoder: self.open_gl_encoder()? })
    }

    /// Open a raw NVENC encode session on the **DirectX** device type (Windows,
    /// Game Capture SF0). `device` is the `ID3D11Device*` whose textures will be
    /// registered as input; the WGC `Direct3D11CaptureFramePool` MUST be created on
    /// this same device or the frame texture is foreign and register/map rejects it.
    #[cfg(windows)]
    pub fn open_d3d11_encoder(
        &self,
        device: *mut std::ffi::c_void,
    ) -> Result<*mut std::ffi::c_void, NvencError> {
        let open = self.api.nvEncOpenEncodeSessionEx.ok_or(NvencError::Unsupported)?;
        // SAFETY: `params` zeroed then version/device fields set per the NVENC ABI;
        // `device` is a live `ID3D11Device*` kept alive by the caller for the
        // session lifetime. `encoder` receives the opaque session handle.
        unsafe {
            let mut params: ffi::NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS = std::mem::zeroed();
            params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
            params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX as _;
            params.device = device;
            params.apiVersion = NVENCAPI_VERSION;
            let mut encoder: *mut std::ffi::c_void = std::ptr::null_mut();
            status(open(&mut params, &mut encoder))?;
            Ok(encoder)
        }
    }

    /// Open an NVENC session on the DirectX device type for `device` (the SF0
    /// d3d11wgc spike's encode arm). See [`Nvenc::open_d3d11_encoder`].
    #[cfg(windows)]
    pub fn open_d3d11_session(
        &self,
        device: *mut std::ffi::c_void,
    ) -> Result<Session<'_>, NvencError> {
        Ok(Session { nv: self, encoder: self.open_d3d11_encoder(device)? })
    }

    /// Initialize a raw NVENC session handle as an H.264 encoder: preset **P4**,
    /// **ultra-low-latency** tuning (B-frame-free, synchronous output),
    /// `enablePTD=1`, `encodeConfig` NULL (preset/tuning defaults). Shared by
    /// SF2's [`Session::initialize_h264`] and the SF3 encoder. Production CBR +
    /// explicit GOP config land in SF4.
    pub fn init_h264(
        &self,
        encoder: *mut std::ffi::c_void,
        width: u32,
        height: u32,
        fps_num: u32,
        fps_den: u32,
    ) -> Result<(), NvencError> {
        let init = self.api.nvEncInitializeEncoder.ok_or(NvencError::Unsupported)?;
        // SAFETY: `params` zeroed, then version + required fields set per the ABI.
        unsafe {
            let mut params: ffi::NV_ENC_INITIALIZE_PARAMS = std::mem::zeroed();
            params.version = NV_ENC_INITIALIZE_PARAMS_VER;
            params.encodeGUID = NV_ENC_CODEC_H264_GUID;
            params.presetGUID = NV_ENC_PRESET_P4_GUID;
            params.encodeWidth = width;
            params.encodeHeight = height;
            params.darWidth = width;
            params.darHeight = height;
            params.frameRateNum = fps_num;
            params.frameRateDen = fps_den;
            params.enablePTD = 1; // encoder picks frame types; we force IDR per-pic
            params.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY as _;
            status(init(encoder, &mut params))
        }
    }

    /// Initialize a raw NVENC session handle as an H.264 **CBR** encoder (SF4):
    /// fetches the P4 / ultra-low-latency preset config (which fills the
    /// codec-specific defaults), then overrides GOP length, `frameIntervalP = 1`
    /// (no B-frames, `-bf 0`), and constant-bitrate rate control at `bitrate_bps`.
    pub fn init_h264_cbr(
        &self,
        encoder: *mut std::ffi::c_void,
        width: u32,
        height: u32,
        fps_num: u32,
        fps_den: u32,
        gop_len: u32,
        bitrate_bps: u32,
    ) -> Result<(), NvencError> {
        let get_preset = self
            .api
            .nvEncGetEncodePresetConfigEx
            .ok_or(NvencError::Unsupported)?;
        let init = self.api.nvEncInitializeEncoder.ok_or(NvencError::Unsupported)?;
        // SAFETY: preset config fetched (versions set per the ABI) then a few
        // fields overridden; a pointer to the local `cfg` is valid for the
        // duration of the InitializeEncoder call below.
        unsafe {
            let mut preset: ffi::NV_ENC_PRESET_CONFIG = std::mem::zeroed();
            preset.version = NV_ENC_PRESET_CONFIG_VER;
            preset.presetCfg.version = NV_ENC_CONFIG_VER;
            status(get_preset(
                encoder,
                NV_ENC_CODEC_H264_GUID,
                NV_ENC_PRESET_P4_GUID,
                NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY as _,
                &mut preset,
            ))?;

            let mut cfg = preset.presetCfg;
            cfg.gopLength = gop_len;
            cfg.frameIntervalP = 1; // I/P only — no B-frames
            cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR as _;
            cfg.rcParams.averageBitRate = bitrate_bps;

            let mut params: ffi::NV_ENC_INITIALIZE_PARAMS = std::mem::zeroed();
            params.version = NV_ENC_INITIALIZE_PARAMS_VER;
            params.encodeGUID = NV_ENC_CODEC_H264_GUID;
            params.presetGUID = NV_ENC_PRESET_P4_GUID;
            params.encodeWidth = width;
            params.encodeHeight = height;
            params.darWidth = width;
            params.darHeight = height;
            params.frameRateNum = fps_num;
            params.frameRateDen = fps_den;
            params.enablePTD = 1;
            params.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY as _;
            params.encodeConfig = &mut cfg;
            status(init(encoder, &mut params))
        }
    }

    // --- GL input-resource primitives (B1 + the capture engine's GL encoder) ---
    //
    // Shared by the one-shot [`Session::test_encode_h264_gl_tex`] (register +
    // map + encode + unmap + unregister per call) and the capture engine's
    // persistent `encoder::NvencGlEncoder` (register **once** at setup, then
    // map/encode/unmap every frame). The GL context that owns `texture` must be
    // current on the calling thread for all four calls.

    /// Register a `GL_TEXTURE_2D` as an NVENC input resource
    /// (`NV_ENC_INPUT_RESOURCE_TYPE_OPENGL_TEX`). High-overhead — register once,
    /// reuse across frames (the texture's *contents* may change between encodes).
    pub fn register_gl_texture(
        &self,
        encoder: *mut std::ffi::c_void,
        texture: u32,
        width: u32,
        height: u32,
    ) -> Result<*mut std::ffi::c_void, NvencError> {
        let register = self.api.nvEncRegisterResource.ok_or(NvencError::Unsupported)?;
        // SAFETY: `gltex` outlives the register call it is referenced by; struct
        // versions/fields set per the NVENC ABI. `registeredResource` is the out handle.
        unsafe {
            let mut gltex: ffi::NV_ENC_INPUT_RESOURCE_OPENGL_TEX = std::mem::zeroed();
            gltex.texture = texture;
            gltex.target = GL_TEXTURE_2D;

            let mut reg: ffi::NV_ENC_REGISTER_RESOURCE = std::mem::zeroed();
            reg.version = NV_ENC_REGISTER_RESOURCE_VER;
            reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_OPENGL_TEX as _;
            reg.width = width;
            reg.height = height;
            reg.pitch = width * 4; // OPENGL_TEX: width * components (ARGB = 4)
            reg.subResourceIndex = 0;
            reg.resourceToRegister = &mut gltex as *mut _ as *mut std::ffi::c_void;
            reg.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB as _;
            reg.bufferUsage = NV_ENC_INPUT_IMAGE as _;
            status(register(encoder, &mut reg))?;
            Ok(reg.registeredResource)
        }
    }

    /// Register an `ID3D11Texture2D` as an NVENC input resource
    /// (`NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX`, Game Capture SF0). Unlike the GL path,
    /// the texture pointer is passed **directly** as `resourceToRegister` (no helper
    /// struct) and **`pitch = 0`** — the driver derives the D3D11 pitch; a wrong
    /// pitch silently corrupts. `B8G8R8A8_UNORM` bytes are `[B,G,R,A]` =
    /// `NV_ENC_BUFFER_FORMAT_ARGB` exactly (no channel swap).
    #[cfg(windows)]
    pub fn register_d3d11_texture(
        &self,
        encoder: *mut std::ffi::c_void,
        texture: *mut std::ffi::c_void,
        width: u32,
        height: u32,
    ) -> Result<*mut std::ffi::c_void, NvencError> {
        let register = self.api.nvEncRegisterResource.ok_or(NvencError::Unsupported)?;
        // SAFETY: struct zeroed, version/fields set per the NVENC ABI; `texture` is a
        // live `ID3D11Texture2D*` on the session's device. `registeredResource` out.
        unsafe {
            let mut reg: ffi::NV_ENC_REGISTER_RESOURCE = std::mem::zeroed();
            reg.version = NV_ENC_REGISTER_RESOURCE_VER;
            reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX as _;
            reg.width = width;
            reg.height = height;
            reg.pitch = 0; // DIRECTX: driver derives the pitch (GL used width*4)
            reg.subResourceIndex = 0;
            reg.resourceToRegister = texture; // the ID3D11Texture2D* directly
            reg.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB as _;
            reg.bufferUsage = NV_ENC_INPUT_IMAGE as _;
            status(register(encoder, &mut reg))?;
            Ok(reg.registeredResource)
        }
    }

    /// Map a registered input resource → an NVENC input pointer + its buffer
    /// format (call before every `nvEncEncodePicture`; pair with [`Nvenc::unmap_input`]).
    pub fn map_input(
        &self,
        encoder: *mut std::ffi::c_void,
        registered: *mut std::ffi::c_void,
    ) -> Result<(*mut std::ffi::c_void, ffi::NV_ENC_BUFFER_FORMAT), NvencError> {
        let map = self.api.nvEncMapInputResource.ok_or(NvencError::Unsupported)?;
        // SAFETY: `registered` is a live handle from `register_gl_texture`; struct
        // version/field set per the ABI; `mappedResource`/`mappedBufferFmt` are out fields.
        unsafe {
            let mut mir: ffi::NV_ENC_MAP_INPUT_RESOURCE = std::mem::zeroed();
            mir.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
            mir.registeredResource = registered;
            status(map(encoder, &mut mir))?;
            Ok((mir.mappedResource, mir.mappedBufferFmt))
        }
    }

    /// Unmap a previously [`Nvenc::map_input`]-ed resource (status ignored — teardown).
    pub fn unmap_input(&self, encoder: *mut std::ffi::c_void, mapped: *mut std::ffi::c_void) {
        if let Some(unmap) = self.api.nvEncUnmapInputResource {
            // SAFETY: single unmap of a live mapped resource.
            unsafe {
                let _ = unmap(encoder, mapped);
            }
        }
    }

    /// Unregister a previously [`Nvenc::register_gl_texture`]-ed resource (status ignored).
    pub fn unregister_input(&self, encoder: *mut std::ffi::c_void, registered: *mut std::ffi::c_void) {
        if let Some(unregister) = self.api.nvEncUnregisterResource {
            // SAFETY: single unregister of a live registered resource (after unmap).
            unsafe {
                let _ = unregister(encoder, registered);
            }
        }
    }
}

impl Session<'_> {
    /// Count of supported codec GUIDs — a cheap proof the function table is
    /// callable past session open.
    pub fn encode_guid_count(&self) -> Result<u32, NvencError> {
        let f = self.nv.api.nvEncGetEncodeGUIDCount.ok_or(NvencError::Unsupported)?;
        // SAFETY: `encoder` is a live session handle from open_cuda_session.
        unsafe {
            let mut n: u32 = 0;
            status(f(self.encoder, &mut n))?;
            Ok(n)
        }
    }
}

impl Session<'_> {
    /// Initialize this session as an H.264 encoder (delegates to
    /// [`Nvenc::init_h264`]). Must be called before
    /// [`Session::test_encode_h264_argb`].
    pub fn initialize_h264(
        &self,
        width: u32,
        height: u32,
        fps_num: u32,
        fps_den: u32,
    ) -> Result<(), NvencError> {
        self.nv.init_h264(self.encoder, width, height, fps_num, fps_den)
    }

    /// Encode one ARGB frame as a forced-IDR H.264 access unit (SPS+PPS+IDR) and
    /// return the elementary-stream bytes. The session must already be
    /// initialized via [`Session::initialize_h264`].
    ///
    /// This is the SF2 *probe-contract* test encode — prove a real frame, never
    /// trust caps listings. It uses an encoder-allocated, CPU-lockable input
    /// buffer, so it exercises the full NVENC chain **without** committing to the
    /// engine's GL-vs-CUDA dmabuf input path (that's the Phase-0 interop spike).
    ///
    /// `argb` is word-ordered A8R8G8B8 — 4 bytes/pixel as `[B, G, R, A]` in
    /// memory, exactly `width*height*4` bytes (repacked to the encoder's pitch).
    pub fn test_encode_h264_argb(
        &self,
        width: u32,
        height: u32,
        argb: &[u8],
    ) -> Result<Vec<u8>, NvencError> {
        if argb.len() != (width as usize) * (height as usize) * 4 {
            return Err(NvencError::Unsupported);
        }
        let api = &self.nv.api;
        let create_in = api.nvEncCreateInputBuffer.ok_or(NvencError::Unsupported)?;
        let create_out = api.nvEncCreateBitstreamBuffer.ok_or(NvencError::Unsupported)?;
        let lock_in = api.nvEncLockInputBuffer.ok_or(NvencError::Unsupported)?;
        let unlock_in = api.nvEncUnlockInputBuffer.ok_or(NvencError::Unsupported)?;
        let encode = api.nvEncEncodePicture.ok_or(NvencError::Unsupported)?;
        let lock_bs = api.nvEncLockBitstream.ok_or(NvencError::Unsupported)?;
        let unlock_bs = api.nvEncUnlockBitstream.ok_or(NvencError::Unsupported)?;
        let destroy_in = api.nvEncDestroyInputBuffer.ok_or(NvencError::Unsupported)?;
        let destroy_out = api.nvEncDestroyBitstreamBuffer.ok_or(NvencError::Unsupported)?;

        // SAFETY: each struct is zeroed then has its `.version` + required fields
        // set per the NVENC ABI; the two buffers are created up front and always
        // destroyed once at the end (labeled-block early-exits jump to teardown).
        unsafe {
            let mut cin: ffi::NV_ENC_CREATE_INPUT_BUFFER = std::mem::zeroed();
            cin.version = NV_ENC_CREATE_INPUT_BUFFER_VER;
            cin.width = width;
            cin.height = height;
            cin.bufferFmt = NV_ENC_BUFFER_FORMAT_ARGB as _;
            status(create_in(self.encoder, &mut cin))?;
            let input = cin.inputBuffer;

            let mut cout: ffi::NV_ENC_CREATE_BITSTREAM_BUFFER = std::mem::zeroed();
            cout.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            if let Err(e) = status(create_out(self.encoder, &mut cout)) {
                let _ = destroy_in(self.encoder, input);
                return Err(e);
            }
            let output = cout.bitstreamBuffer;

            let outcome: Result<Vec<u8>, NvencError> = 'enc: {
                // Lock input, copy pixels row-by-row at the encoder's pitch, unlock.
                let mut lin: ffi::NV_ENC_LOCK_INPUT_BUFFER = std::mem::zeroed();
                lin.version = NV_ENC_LOCK_INPUT_BUFFER_VER;
                lin.inputBuffer = input;
                if let Err(e) = status(lock_in(self.encoder, &mut lin)) {
                    break 'enc Err(e);
                }
                let pitch = lin.pitch as usize;
                let row = (width as usize) * 4;
                for y in 0..(height as usize) {
                    std::ptr::copy_nonoverlapping(
                        argb.as_ptr().add(y * row),
                        (lin.bufferDataPtr as *mut u8).add(y * pitch),
                        row,
                    );
                }
                if let Err(e) = status(unlock_in(self.encoder, input)) {
                    break 'enc Err(e);
                }

                // Encode one forced-IDR picture with inline SPS+PPS.
                let mut pic: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
                pic.version = NV_ENC_PIC_PARAMS_VER;
                pic.inputWidth = width;
                pic.inputHeight = height;
                pic.inputPitch = pitch as u32;
                pic.inputBuffer = input;
                pic.outputBitstream = output;
                pic.bufferFmt = NV_ENC_BUFFER_FORMAT_ARGB as _;
                pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME as _;
                pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
                let rc = encode(self.encoder, &mut pic);
                if rc as i32 == st::NEED_MORE_INPUT {
                    // No B-frames means this shouldn't happen, but flush defensively.
                    let mut eos: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
                    eos.version = NV_ENC_PIC_PARAMS_VER;
                    eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
                    if let Err(e) = status(encode(self.encoder, &mut eos)) {
                        break 'enc Err(e);
                    }
                } else if let Err(e) = status(rc) {
                    break 'enc Err(e);
                }

                // Lock the bitstream, copy the ES bytes out, unlock.
                let mut lbs: ffi::NV_ENC_LOCK_BITSTREAM = std::mem::zeroed();
                lbs.version = NV_ENC_LOCK_BITSTREAM_VER;
                lbs.outputBitstream = output;
                if let Err(e) = status(lock_bs(self.encoder, &mut lbs)) {
                    break 'enc Err(e);
                }
                let bytes = std::slice::from_raw_parts(
                    lbs.bitstreamBufferPtr as *const u8,
                    lbs.bitstreamSizeInBytes as usize,
                )
                .to_vec();
                let _ = unlock_bs(self.encoder, output);
                Ok(bytes)
            };

            let _ = destroy_out(self.encoder, output);
            let _ = destroy_in(self.encoder, input);
            outcome
        }
    }
}

impl Session<'_> {
    /// Encode one frame from an existing **GL texture** (a `GL_TEXTURE_2D`, e.g. a
    /// PipeWire dmabuf imported via EGLImage) as a forced-IDR H.264 access unit and
    /// return the elementary-stream bytes. The session must be initialized via
    /// [`Session::initialize_h264`] and opened with [`Nvenc::open_gl_session`].
    ///
    /// The GL analog of [`Session::test_encode_h264_argb`] (B1 interop spike, GL
    /// arm): instead of an encoder-allocated CPU input buffer + row copy, it
    /// registers the GL texture as an NVENC input resource
    /// (`NV_ENC_INPUT_RESOURCE_TYPE_OPENGL_TEX`) and maps it — the zero-copy path.
    /// **The EGL/GL context that owns `gl_texture` MUST be current on this thread**
    /// for the whole call (register/map/encode all bind the GL context).
    ///
    /// `gl_texture` is a `GL_TEXTURE_2D` name; the pixel format is the working
    /// hypothesis `NV_ENC_BUFFER_FORMAT_ARGB` for a BGRx import (the exact RGB→YUV
    /// matrix is the separate B2 color spike, not solved here).
    pub fn test_encode_h264_gl_tex(
        &self,
        width: u32,
        height: u32,
        gl_texture: u32,
    ) -> Result<Vec<u8>, NvencError> {
        let api = &self.nv.api;
        let create_out = api.nvEncCreateBitstreamBuffer.ok_or(NvencError::Unsupported)?;
        let encode = api.nvEncEncodePicture.ok_or(NvencError::Unsupported)?;
        let lock_bs = api.nvEncLockBitstream.ok_or(NvencError::Unsupported)?;
        let unlock_bs = api.nvEncUnlockBitstream.ok_or(NvencError::Unsupported)?;
        let destroy_out = api.nvEncDestroyBitstreamBuffer.ok_or(NvencError::Unsupported)?;

        // Register (once) + map the GL texture via the shared GL primitives — the
        // same calls the capture engine's persistent `NvencGlEncoder` makes per frame.
        let registered = self.nv.register_gl_texture(self.encoder, gl_texture, width, height)?;
        let (mapped, mapped_fmt) = match self.nv.map_input(self.encoder, registered) {
            Ok(v) => v,
            Err(e) => {
                self.nv.unregister_input(self.encoder, registered);
                return Err(e);
            }
        };

        // SAFETY: structs zeroed + versioned per the ABI; the bitstream buffer is
        // created up front and destroyed at the end, and the mapped GL resource
        // drives exactly one encode. The mapped/registered resource is torn down
        // after the unsafe block on every path (no leak).
        let outcome: Result<Vec<u8>, NvencError> = unsafe {
            let mut cout: ffi::NV_ENC_CREATE_BITSTREAM_BUFFER = std::mem::zeroed();
            cout.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            if let Err(e) = status(create_out(self.encoder, &mut cout)) {
                self.nv.unmap_input(self.encoder, mapped);
                self.nv.unregister_input(self.encoder, registered);
                return Err(e);
            }
            let output = cout.bitstreamBuffer;

            let result: Result<Vec<u8>, NvencError> = 'enc: {
                // Encode one forced-IDR picture (inline SPS+PPS) from the mapped GL
                // resource — no CPU upload (the zero-copy point B1 proves).
                let mut pic: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
                pic.version = NV_ENC_PIC_PARAMS_VER;
                pic.inputWidth = width;
                pic.inputHeight = height;
                pic.inputPitch = width * 4;
                pic.inputBuffer = mapped;
                pic.outputBitstream = output;
                pic.bufferFmt = mapped_fmt;
                pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME as _;
                pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
                let rc = encode(self.encoder, &mut pic);
                if rc as i32 == st::NEED_MORE_INPUT {
                    // No B-frames means this shouldn't happen, but flush defensively.
                    let mut eos: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
                    eos.version = NV_ENC_PIC_PARAMS_VER;
                    eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
                    if let Err(e) = status(encode(self.encoder, &mut eos)) {
                        break 'enc Err(e);
                    }
                } else if let Err(e) = status(rc) {
                    break 'enc Err(e);
                }

                let mut lbs: ffi::NV_ENC_LOCK_BITSTREAM = std::mem::zeroed();
                lbs.version = NV_ENC_LOCK_BITSTREAM_VER;
                lbs.outputBitstream = output;
                if let Err(e) = status(lock_bs(self.encoder, &mut lbs)) {
                    break 'enc Err(e);
                }
                let bytes = std::slice::from_raw_parts(
                    lbs.bitstreamBufferPtr as *const u8,
                    lbs.bitstreamSizeInBytes as usize,
                )
                .to_vec();
                let _ = unlock_bs(self.encoder, output);
                Ok(bytes)
            };

            let _ = destroy_out(self.encoder, output);
            result
        };

        // Teardown: unmap before unregister (no-ops if the fn pointers are absent).
        self.nv.unmap_input(self.encoder, mapped);
        self.nv.unregister_input(self.encoder, registered);
        outcome
    }
}

#[cfg(windows)]
impl Session<'_> {
    /// Encode one frame from an existing **`ID3D11Texture2D`** (e.g. a WGC
    /// `Direct3D11CaptureFrame` surface) as a forced-IDR H.264 access unit — the
    /// D3D11 analog of [`Session::test_encode_h264_gl_tex`] and the SF0 d3d11wgc
    /// spike's encode step. The session must be opened with
    /// [`Nvenc::open_d3d11_session`] on the SAME `ID3D11Device` that owns
    /// `d3d11_texture`, and initialized via [`Session::initialize_h264`]. Pitch
    /// follows the GL precedent (`width*4`); if the decode-proof shears, the WGC
    /// texture has a padded row pitch → fall to the staging-copy arm (NO-GO fork A).
    pub fn test_encode_h264_d3d11_tex(
        &self,
        width: u32,
        height: u32,
        d3d11_texture: *mut std::ffi::c_void,
    ) -> Result<Vec<u8>, NvencError> {
        let api = &self.nv.api;
        let create_out = api.nvEncCreateBitstreamBuffer.ok_or(NvencError::Unsupported)?;
        let encode = api.nvEncEncodePicture.ok_or(NvencError::Unsupported)?;
        let lock_bs = api.nvEncLockBitstream.ok_or(NvencError::Unsupported)?;
        let unlock_bs = api.nvEncUnlockBitstream.ok_or(NvencError::Unsupported)?;
        let destroy_out = api.nvEncDestroyBitstreamBuffer.ok_or(NvencError::Unsupported)?;

        // Register + map the D3D11 texture directly (register-direct; the SF0 GO arm).
        let registered =
            self.nv.register_d3d11_texture(self.encoder, d3d11_texture, width, height)?;
        let (mapped, mapped_fmt) = match self.nv.map_input(self.encoder, registered) {
            Ok(v) => v,
            Err(e) => {
                self.nv.unregister_input(self.encoder, registered);
                return Err(e);
            }
        };

        // SAFETY: structs zeroed + versioned per the ABI; the bitstream buffer is
        // created up front and destroyed at the end; the mapped resource drives
        // exactly one encode and is torn down on every path (no leak).
        let outcome: Result<Vec<u8>, NvencError> = unsafe {
            let mut cout: ffi::NV_ENC_CREATE_BITSTREAM_BUFFER = std::mem::zeroed();
            cout.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            if let Err(e) = status(create_out(self.encoder, &mut cout)) {
                self.nv.unmap_input(self.encoder, mapped);
                self.nv.unregister_input(self.encoder, registered);
                return Err(e);
            }
            let output = cout.bitstreamBuffer;

            let result: Result<Vec<u8>, NvencError> = 'enc: {
                let mut pic: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
                pic.version = NV_ENC_PIC_PARAMS_VER;
                pic.inputWidth = width;
                pic.inputHeight = height;
                pic.inputPitch = width * 4;
                pic.inputBuffer = mapped;
                pic.outputBitstream = output;
                pic.bufferFmt = mapped_fmt;
                pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME as _;
                pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
                let rc = encode(self.encoder, &mut pic);
                if rc as i32 == st::NEED_MORE_INPUT {
                    let mut eos: ffi::NV_ENC_PIC_PARAMS = std::mem::zeroed();
                    eos.version = NV_ENC_PIC_PARAMS_VER;
                    eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
                    if let Err(e) = status(encode(self.encoder, &mut eos)) {
                        break 'enc Err(e);
                    }
                } else if let Err(e) = status(rc) {
                    break 'enc Err(e);
                }

                let mut lbs: ffi::NV_ENC_LOCK_BITSTREAM = std::mem::zeroed();
                lbs.version = NV_ENC_LOCK_BITSTREAM_VER;
                lbs.outputBitstream = output;
                if let Err(e) = status(lock_bs(self.encoder, &mut lbs)) {
                    break 'enc Err(e);
                }
                let bytes = std::slice::from_raw_parts(
                    lbs.bitstreamBufferPtr as *const u8,
                    lbs.bitstreamSizeInBytes as usize,
                )
                .to_vec();
                let _ = unlock_bs(self.encoder, output);
                Ok(bytes)
            };

            let _ = destroy_out(self.encoder, output);
            result
        };

        self.nv.unmap_input(self.encoder, mapped);
        self.nv.unregister_input(self.encoder, registered);
        outcome
    }
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        if let Some(destroy) = self.nv.api.nvEncDestroyEncoder {
            // SAFETY: single destroy of a live handle; status ignored on teardown.
            unsafe {
                let _ = destroy(self.encoder);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn struct_version_encoding() {
        assert_eq!(NVENCAPI_VERSION, 13); // 13 | (0 << 24)
        assert_eq!(NVENCAPI_VERSION_PACKED, 13 << 4); // (13 << 4) | 0 = 208
        assert_eq!(struct_version(2), 13 | (2 << 16) | (0x7 << 28));
        assert_eq!(NV_ENCODE_API_FUNCTION_LIST_VER, struct_version(2));
        // The top nibble is always 0x7 — NVENC's struct-version tag.
        assert_eq!(struct_version(1) >> 28, 0x7);
    }

    #[test]
    fn driver_missing_on_bogus_lib() {
        assert!(matches!(
            Nvenc::load_from("libnvidia-encode-does-not-exist.so.999"),
            Err(NvencError::DriverMissing)
        ));
    }
}
