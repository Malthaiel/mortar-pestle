//! D3D11 staging-copy encode bridge (Game Capture SF3).
//!
//! WGC hands a DIFFERENT `ID3D11Texture2D` each frame, but NVENC's
//! [`NvencD3d11Encoder`] registers ONE input texture at `open`. So we own a
//! fixed-size `USAGE_DEFAULT` texture, register THAT once, and `CopyResource` each
//! WGC frame into it before `encode` — the D3D11 analog of the Linux FBO-blit into
//! one owned `GL_TEXTURE_2D` (SF0's register-direct was a 1-frame shortcut;
//! continuous capture needs this staging copy).
//!
//! The encode size is **locked to the first frame**. On a WGC `ContentSize` change
//! (the pool was Recreated mid-run) the incoming frame's desc no longer matches the
//! staging texture, so `CopyResource` (which requires identical descs) would fail —
//! instead we `CopySubresourceRegion` the overlapping top-left rect (the border keeps
//! its last contents) and warn once. Full letterbox/scale is deferred; the
//! borderless-windowed "done" target is stable-size.

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

use nvenc_sys::encoder::{
    Codec, EncodeFlags, Encoder, EncoderConfig, InputHandle, InputKind, NvencD3d11Encoder, Packet,
    RateControl,
};

use super::wgc::CapturedTexture;
use super::EncodeParams;

/// Owns the NVENC D3D11 encoder + the fixed-size staging texture it reads.
pub struct D3d11Encode {
    enc: NvencD3d11Encoder,
    handle: InputHandle,
    /// The owned `USAGE_DEFAULT` ARGB texture registered with NVENC (the copy dest).
    owned: ID3D11Texture2D,
    width: u32,
    height: u32,
    warned_resize: bool,
}

impl D3d11Encode {
    /// Create the staging texture sized `w`×`h` (the locked encode size), open an
    /// NVENC DirectX H.264 encoder on `device` for it, and register it once. CBR at
    /// the configured bitrate, forced-IDR GOP, B-frames off (the SF1 contract).
    pub fn open(
        device: &ID3D11Device,
        w: u32,
        h: u32,
        params: &EncodeParams,
    ) -> Result<Self, String> {
        let owned = create_staging(device, w, h)?;
        let config = EncoderConfig {
            codec: Codec::H264,
            width: w,
            height: h,
            fps_num: params.fps_num,
            fps_den: params.fps_den,
            input: InputKind::D3d11Texture,
            gop_len: params.gop_len,
            b_frames: 0,
            rate_control: Some(RateControl::Cbr { bitrate_bps: params.bitrate_bps }),
        };
        // SAFETY: `device` and `owned` are live COM objects on the same device; their
        // raw pointers stay valid for the encoder's life (`owned` is held in `self`).
        let mut enc = NvencD3d11Encoder::open(config, device.as_raw(), owned.as_raw())
            .map_err(|e| format!("NVENC D3D11 open: {e:?}"))?;
        let handle = enc
            .register(InputKind::D3d11Texture)
            .map_err(|e| format!("NVENC register D3D11 texture: {e:?}"))?;
        Ok(Self { enc, handle, owned, width: w, height: h, warned_resize: false })
    }

    /// Copy the WGC frame into the owned staging texture (the out-of-band write
    /// before `encode`). Exact-size match → `CopyResource`; a size mismatch (the WGC
    /// pool was Recreated mid-run) → copy the overlapping top-left rect via
    /// `CopySubresourceRegion` (the border keeps its last contents) + warn once.
    pub fn stage(&mut self, ctx: &ID3D11DeviceContext, frame: &CapturedTexture) {
        if frame.width == self.width && frame.height == self.height {
            // SAFETY: both are live `ID3D11Texture2D` on the same device with an
            // identical desc — the CopyResource precondition.
            unsafe { ctx.CopyResource(&self.owned, &frame.texture) };
            return;
        }
        if !self.warned_resize {
            log::warn!(
                "WGC frame {}x{} != locked encode size {}x{}; cropping the overlap \
                 (full letterbox is deferred)",
                frame.width,
                frame.height,
                self.width,
                self.height
            );
            self.warned_resize = true;
        }
        let cw = frame.width.min(self.width);
        let ch = frame.height.min(self.height);
        let src_box = D3D11_BOX { left: 0, top: 0, front: 0, right: cw, bottom: ch, back: 1 };
        // SAFETY: `src_box` is clamped to the min extent of both textures; dest at
        // (0,0), subresource 0, same device + format. A held border is accepted (SF3).
        unsafe {
            ctx.CopySubresourceRegion(
                &self.owned,
                0,
                0,
                0,
                0,
                &frame.texture,
                0,
                Some(&src_box as *const D3D11_BOX),
            );
        }
    }

    /// Encode the current staging-texture contents at `cfr_index` (the NVENC input
    /// timestamp / frame number). Returns the produced packet(s).
    pub fn encode(&mut self, cfr_index: u64) -> Result<Vec<Packet>, String> {
        self.enc
            .encode(self.handle, cfr_index, EncodeFlags::default())
            .map_err(|e| format!("NVENC D3D11 encode: {e:?}"))
    }
}

/// Create a fixed-size `USAGE_DEFAULT` `B8G8R8A8_UNORM` texture — the NVENC-friendly,
/// CopyResource-dest-legal staging target. BGRA matches WGC and is NVENC `ARGB`
/// no-swap (the SF0 finding).
fn create_staging(device: &ID3D11Device, w: u32, h: u32) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    // SAFETY: a valid desc; no initial data; `tex` is the out-param the driver fills.
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .map_err(|e| format!("CreateTexture2D (staging {w}x{h}): {e}"))?;
    }
    tex.ok_or_else(|| "CreateTexture2D returned a null texture".to_string())
}
