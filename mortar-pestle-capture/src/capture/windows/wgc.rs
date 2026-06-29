//! WGC (Windows.Graphics.Capture) frame source (Game Capture SF2). Captures the
//! foreground window into a free-threaded D3D11 frame pool on the shared device,
//! yielding one `ID3D11Texture2D` per frame and recreating the pool on resize.
//!
//! Trap #3: `CreateFreeThreaded` has no DispatcherQueue / message pump; the
//! `FrameArrived` callback runs on a WGC worker thread and must ONLY stash the
//! frame (it is `Send` in the `windows` crate) into a channel — never touch the
//! encoder or the immediate context. The consumer thread owns those.

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Mutex;
use std::time::Duration;

use windows::core::{IInspectable, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

const FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const POOL_BUFFERS: i32 = 2;

/// One captured frame: the `ID3D11Texture2D` (on the shared device) + its size.
pub struct CapturedTexture {
    pub texture: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
}

/// Continuous WGC capture of one window. The `FrameArrived` callback stashes the
/// latest frame into a channel (trap #3); `next_frame` drains it and recreates the
/// pool on a `ContentSize` change. The shared `IDirect3DDevice` is kept for the
/// `Recreate` call so frames stay on our device.
pub struct WgcCapture {
    winrt_device: IDirect3DDevice,
    /// Held to keep the capture item alive for the session's lifetime (SF9 will
    /// read it for a display-affinity exclude).
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    rx: Receiver<Direct3D11CaptureFrame>,
    size: SizeInt32,
    recreates: u32,
}

impl WgcCapture {
    /// Start capturing `hwnd` on `winrt_device` (the WinRT wrap of the shared
    /// `ID3D11Device`). Frames begin arriving on the pool thread immediately.
    pub fn start(hwnd: HWND, winrt_device: &IDirect3DDevice) -> Result<Self, String> {
        let interop: IGraphicsCaptureItemInterop =
            windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                .map_err(|e| format!("IGraphicsCaptureItemInterop factory: {e}"))?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd) }
            .map_err(|e| format!("CreateForWindow: {e}"))?;
        let size = item.Size().map_err(|e| format!("item.Size: {e}"))?;

        let (pool, rx) = build_pool(winrt_device, size)?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|e| format!("CreateCaptureSession: {e}"))?;
        session.StartCapture().map_err(|e| format!("StartCapture: {e}"))?;

        Ok(Self {
            winrt_device: winrt_device.clone(),
            _item: item,
            pool,
            session,
            rx,
            size,
            recreates: 0,
        })
    }

    /// Block up to `timeout` for the next frame and return its `ID3D11Texture2D`
    /// (on the shared device). On a `ContentSize` change, `Recreate` the pool to
    /// the new size first (NVENC's encode size is fixed at init, so the encoder
    /// side letterboxes/crops in SF3 — SF2 just tracks the resize).
    pub fn next_frame(&mut self, timeout: Duration) -> Result<CapturedTexture, String> {
        let frame = match self.rx.recv_timeout(timeout) {
            Ok(f) => f,
            Err(RecvTimeoutError::Timeout) => return Err("no WGC frame within the timeout".into()),
            Err(RecvTimeoutError::Disconnected) => return Err("the WGC capture thread is gone".into()),
        };
        self.take_frame(frame)
    }

    /// Non-blocking variant: return the next queued frame if one is ready, else
    /// `None`. The SF3 pacer drains to the newest frame each tick (bounding latency
    /// when WGC over-delivers on a high-refresh display). `Err` only if the capture
    /// thread is gone.
    pub fn try_next_frame(&mut self) -> Result<Option<CapturedTexture>, String> {
        let frame = match self.rx.try_recv() {
            Ok(f) => f,
            Err(TryRecvError::Empty) => return Ok(None),
            Err(TryRecvError::Disconnected) => return Err("the WGC capture thread is gone".into()),
        };
        self.take_frame(frame).map(Some)
    }

    /// Apply a received frame: `Recreate` the pool on a `ContentSize` change, then
    /// pull the `ID3D11Texture2D` out of the frame's surface (on the shared device).
    fn take_frame(&mut self, frame: Direct3D11CaptureFrame) -> Result<CapturedTexture, String> {
        let content = frame.ContentSize().map_err(|e| format!("frame.ContentSize: {e}"))?;
        if content.Width != self.size.Width || content.Height != self.size.Height {
            log::info!(
                "WGC ContentSize {}x{} -> {}x{}; recreating the frame pool",
                self.size.Width,
                self.size.Height,
                content.Width,
                content.Height
            );
            self.size = content;
            self.pool
                .Recreate(&self.winrt_device, FORMAT, POOL_BUFFERS, content)
                .map_err(|e| format!("Recreate: {e}"))?;
            self.recreates += 1;
        }

        let surface = frame.Surface().map_err(|e| format!("frame.Surface: {e}"))?;
        let access: IDirect3DDxgiInterfaceAccess = surface
            .cast()
            .map_err(|e| format!("cast IDirect3DDxgiInterfaceAccess: {e}"))?;
        let texture: ID3D11Texture2D =
            unsafe { access.GetInterface() }.map_err(|e| format!("GetInterface ID3D11Texture2D: {e}"))?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        Ok(CapturedTexture { texture, width: desc.Width, height: desc.Height })
    }

    pub fn recreate_count(&self) -> u32 {
        self.recreates
    }

    pub fn size(&self) -> (u32, u32) {
        (self.size.Width.max(0) as u32, self.size.Height.max(0) as u32)
    }
}

impl Drop for WgcCapture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// Build a free-threaded frame pool on `winrt_device` + the `FrameArrived` handler
/// that stashes frames into a channel. Returns the pool (the caller creates the
/// session from it) and the receiver.
fn build_pool(
    winrt_device: &IDirect3DDevice,
    size: SizeInt32,
) -> Result<(Direct3D11CaptureFramePool, Receiver<Direct3D11CaptureFrame>), String> {
    let pool =
        Direct3D11CaptureFramePool::CreateFreeThreaded(winrt_device, FORMAT, POOL_BUFFERS, size)
            .map_err(|e| format!("CreateFreeThreaded: {e}"))?;

    let (tx, rx) = std::sync::mpsc::channel::<Direct3D11CaptureFrame>();
    let tx: Mutex<Sender<Direct3D11CaptureFrame>> = Mutex::new(tx);
    let handler =
        TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |pool, _| {
            if let Some(pool) = pool.as_ref() {
                if let Ok(frame) = pool.TryGetNextFrame() {
                    // Stash only — never touch the encoder / immediate context here.
                    let _ = tx.lock().unwrap().send(frame);
                }
            }
            Ok(())
        });
    pool.FrameArrived(&handler).map_err(|e| format!("FrameArrived: {e}"))?;
    Ok((pool, rx))
}
