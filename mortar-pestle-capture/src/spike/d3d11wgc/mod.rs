//! SF0 feasibility spike — WGC -> D3D11 -> NVENC (Windows Game Capture port).
//!
//! THE GATE (Game Capture.md SF0). Proves the one genuinely unproven link before
//! the weeks-long port: a Windows.Graphics.Capture frame's `ID3D11Texture2D` can
//! be registered DIRECTLY as an NVENC `DIRECTX` input resource and encoded — the
//! D3D11 analog of the Linux GL-texture zero-copy path. Throwaway (~250 lines):
//! does NOT use the `Encoder` trait, the daemon, or the pacer.
//!
//!   GetForegroundWindow -> WGC GraphicsCaptureItem
//!     -> Direct3D11CaptureFramePool(B8G8R8A8, FreeThreaded) on ONE shared device
//!     -> ID3D11Texture2D -> NVENC (DEVICE_TYPE_DIRECTX, register D3D11, ARGB, pitch=0)
//!     -> one forced-IDR H.264 ES -> ffmpeg -frames:v 1 -> PNG (eyeball).
//!
//! GO iff the PNG shows the window's content and NVENCSTATUS==0 (a color shift is
//! tolerated). NO-GO fork A (register rejects the WGC texture) -> staging-copy;
//! fork B (frame on a foreign device) -> fix the WinRT device-wrap. Running the
//! GO/NO-GO RUN needs a live desktop with a window focused + an NVIDIA GPU.

use std::process::{Command, ExitCode};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use windows::core::{IInspectable, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

const ES_NAME: &str = "mortar-pestle-capture-d3d11wgc.h264";
const PNG_NAME: &str = "mortar-pestle-capture-d3d11wgc.png";

/// Entry point for `mortar-pestle-capture spike d3d11wgc`.
pub fn run() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    match run_inner() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log::error!("SF0 d3d11wgc spike failed: {e}");
            eprintln!(
                "\nVERDICT: SF0 NO-GO — {e}\n\
                 (Register-direct happy path. If register/map rejected the WGC texture →\n\
                 \x20 NO-GO fork A: re-spike the staging-copy path — own a USAGE_DEFAULT texture,\n\
                 \x20 CopyResource the WGC frame into it, register THAT. If the frame came back on\n\
                 \x20 a foreign device → NO-GO fork B: fix the CreateDirect3D11DeviceFromDXGIDevice\n\
                 \x20 wrap (do NOT paper over with a keyed mutex). RUST_LOG=debug for detail.)\n"
            );
            ExitCode::from(1)
        }
    }
}

fn run_inner() -> Result<(), String> {
    // 0. WGC/WinRT activation factories require an initialized COM apartment; MTA
    //    matches the free-threaded frame pool (no message pump). S_FALSE /
    //    RPC_E_CHANGED_MODE (already initialized) are fine — we never uninit.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // 1. Foreground window (the auto-target; decision #3).
    let hwnd: HWND = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err("GetForegroundWindow returned null — focus a window first".into());
    }
    log::info!("foreground HWND = {:?}", hwnd.0);

    // 2. ONE shared ID3D11Device (BGRA support required for WGC; trap #1).
    let (device, _context) = create_d3d11_device()?;

    // 3. Wrap that SAME device for WinRT so WGC frames return ON it (trap #1).
    let dxgi: IDXGIDevice = device.cast().map_err(|e| format!("cast IDXGIDevice: {e}"))?;
    let winrt_device: IDirect3DDevice = unsafe {
        CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
            .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice: {e}"))?
    }
    .cast()
    .map_err(|e| format!("cast IDirect3DDevice: {e}"))?;

    // 4. WGC capture item for the foreground window (interop activation factory).
    let interop: IGraphicsCaptureItemInterop =
        windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|e| format!("IGraphicsCaptureItemInterop factory: {e}"))?;
    let item: GraphicsCaptureItem =
        unsafe { interop.CreateForWindow(hwnd) }.map_err(|e| format!("CreateForWindow: {e}"))?;
    let size = item.Size().map_err(|e| format!("item.Size: {e}"))?;
    log::info!("capture item size = {}x{}", size.Width, size.Height);

    // 5. Free-threaded frame pool on OUR device (trap #3: no message pump; the
    //    FrameArrived callback only stashes the texture — never touches NVENC).
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )
    .map_err(|e| format!("CreateFreeThreaded: {e}"))?;
    let session = pool
        .CreateCaptureSession(&item)
        .map_err(|e| format!("CreateCaptureSession: {e}"))?;

    // 6. FrameArrived: stash exactly one frame and signal (send-once via the Mutex).
    let (tx, rx) = mpsc::channel::<Direct3D11CaptureFrame>();
    let tx = Mutex::new(Some(tx));
    let handler = TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
        move |pool, _| {
            if let Some(pool) = pool.as_ref() {
                if let Ok(frame) = pool.TryGetNextFrame() {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(frame);
                    }
                }
            }
            Ok(())
        },
    );
    pool.FrameArrived(&handler).map_err(|e| format!("FrameArrived: {e}"))?;

    // 7. Start, grab one frame, stop.
    session.StartCapture().map_err(|e| format!("StartCapture: {e}"))?;
    let frame = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "no WGC frame within 5s (exclusive-fullscreen or minimized?)".to_string())?;
    let _ = session.Close();
    let _ = pool.Close();

    // 8. Pull the ID3D11Texture2D out of the frame's surface (on our device).
    let surface = frame.Surface().map_err(|e| format!("frame.Surface: {e}"))?;
    let access: IDirect3DDxgiInterfaceAccess = surface
        .cast()
        .map_err(|e| format!("cast IDirect3DDxgiInterfaceAccess: {e}"))?;
    let texture: ID3D11Texture2D =
        unsafe { access.GetInterface() }.map_err(|e| format!("GetInterface ID3D11Texture2D: {e}"))?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    let (w, h) = (desc.Width, desc.Height);
    log::info!(
        "WGC texture {w}x{h} format={:?} bind=0x{:x} usage={:?}",
        desc.Format, desc.BindFlags, desc.Usage
    );

    // 9. NVENC: open a DIRECTX session on the SAME device, register the WGC texture
    //    DIRECTLY (register-direct = the SF0 GO arm), encode one forced-IDR frame.
    let nv = nvenc_sys::Nvenc::load()
        .map_err(|e| format!("NVENC load (nvEncodeAPI64.dll — NVIDIA driver present?): {e:?}"))?;
    let enc = nv
        .open_d3d11_session(device.as_raw())
        .map_err(|e| format!("open_d3d11_session: {e:?}"))?;
    enc.initialize_h264(w, h, 60, 1)
        .map_err(|e| format!("init_h264: {e:?}"))?;
    let es = enc
        .test_encode_h264_d3d11_tex(w, h, texture.as_raw())
        .map_err(|e| format!("NVENC D3D11 register+map+encode: {e:?}"))?;
    log::info!("D3D11 register-direct encode OK ({} bytes)", es.len());

    // 10. Write the ES and shell ffmpeg for the decode-proof PNG.
    let es_path = std::env::temp_dir().join(ES_NAME);
    let png_path = std::env::temp_dir().join(PNG_NAME);
    std::fs::write(&es_path, &es).map_err(|e| format!("write ES: {e}"))?;
    let head: Vec<String> = es.iter().take(5).map(|b| format!("{b:02x}")).collect();
    log::info!(
        "wrote {} bytes ES -> {} (first: {})",
        es.len(),
        es_path.display(),
        head.join(" ")
    );
    decode_proof(&es_path.to_string_lossy(), &png_path.to_string_lossy())?;

    // 11. Verdict.
    eprintln!(
        "\nVERDICT: SF0 GO — WGC ID3D11Texture2D registered DIRECT as an NVENC DIRECTX\n  \
         input and encoded to H.264 (NVENCSTATUS==0).\n  \
         device: ONE shared ID3D11Device (WGC frame pool + NVENC); winning arm: REGISTER-DIRECT.\n  \
         proof: {} — open it and eyeball vs the captured window.\n  \
         A BGR/RGB or 601/709 color shift is EXPECTED here and deferred (not a blocker).\n  \
         A sheared/garbled image means the texture has a padded row pitch → staging-copy (fork A).\n",
        png_path.display()
    );
    Ok(())
}

/// Create one `ID3D11Device` (+ immediate context) with BGRA support — required
/// for WGC and for `CreateDirect3D11DeviceFromDXGIDevice`. Tries the hardware
/// driver first, then WARP (so a headless/RDP box still builds a device).
fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut last = String::new();
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let hr = unsafe {
            D3D11CreateDevice(
                None,
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        };
        match hr {
            Ok(()) => {
                let device = device.ok_or("D3D11CreateDevice returned null device")?;
                let context = context.ok_or("D3D11CreateDevice returned null context")?;
                log::info!("ID3D11Device created ({driver:?})");
                return Ok((device, context));
            }
            Err(e) => {
                log::warn!("D3D11CreateDevice({driver:?}) failed: {e}");
                last = e.to_string();
            }
        }
    }
    Err(format!("D3D11CreateDevice failed for HARDWARE and WARP: {last}"))
}

/// Shell system ffmpeg to decode the first frame of the raw H.264 ES to a PNG.
fn decode_proof(es: &str, png: &str) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i", es, "-frames:v", "1", png])
        .status()
        .map_err(|e| format!("spawn ffmpeg (is it installed / on PATH?): {e}"))?;
    if status.success() {
        log::info!("ffmpeg decode-proof -> {png}");
        Ok(())
    } else {
        Err(format!("ffmpeg decode failed ({status}) — the ES may be malformed"))
    }
}
