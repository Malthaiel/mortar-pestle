//! Shared D3D11 device for the Windows capture backend (Game Capture SF2). ONE
//! `ID3D11Device` backs both the WGC frame pool and (SF3) the NVENC encoder — the
//! SF0 register-direct invariant (a foreign device makes register/map fail).

use windows::core::Interface;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_DRIVER_TYPE_WARP,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIDevice, IDXGIFactory1,
};
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

const NVIDIA_VENDOR_ID: u32 = 0x10DE;

/// Find the NVIDIA DXGI adapter, if present. On a hybrid-GPU box (NVIDIA dGPU +
/// AMD/Intel iGPU) the system default adapter is often the iGPU, and NVENC then
/// can't open a session on that non-NVIDIA D3D11 device (it fails `Lost`). So we
/// pick the NVIDIA adapter explicitly and build the shared device on it.
fn nvidia_adapter() -> Option<IDXGIAdapter> {
    // SAFETY: standard DXGI enumeration; EnumAdapters1 errors (DXGI_ERROR_NOT_FOUND)
    // terminate the loop. GetDesc1 fills the out-param desc.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut i = 0u32;
        loop {
            let adapter = factory.EnumAdapters1(i).ok()?;
            i += 1;
            if let Ok(desc) = adapter.GetDesc1() {
                if desc.VendorId == NVIDIA_VENDOR_ID {
                    return adapter.cast::<IDXGIAdapter>().ok();
                }
            }
        }
    }
}

/// Create one `ID3D11Device` (+ immediate context) with BGRA support — required
/// for WGC and `CreateDirect3D11DeviceFromDXGIDevice`. Prefers the NVIDIA adapter
/// (NVENC needs an NVIDIA device); falls back to the default adapter (hardware
/// then WARP) when no NVIDIA GPU is present.
pub fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    // NVIDIA adapter first — an explicit adapter requires DRIVER_TYPE_UNKNOWN
    // (D3D11CreateDevice rejects an adapter + HARDWARE with E_INVALIDARG).
    if let Some(adapter) = nvidia_adapter() {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let hr = unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
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
                let device = device.ok_or("D3D11CreateDevice returned a null device")?;
                let context = context.ok_or("D3D11CreateDevice returned a null context")?;
                log::info!("ID3D11Device created on the NVIDIA adapter");
                return Ok((device, context));
            }
            Err(e) => log::warn!(
                "D3D11CreateDevice(NVIDIA adapter): {e} — falling back to the default adapter"
            ),
        }
    } else {
        log::warn!("no NVIDIA DXGI adapter found — NVENC will likely fail; using the default adapter");
    }

    // Fallback: default adapter, hardware then WARP (pre-hybrid-fix behavior).
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
                let device = device.ok_or("D3D11CreateDevice returned a null device")?;
                let context = context.ok_or("D3D11CreateDevice returned a null context")?;
                log::info!("ID3D11Device created ({driver:?})");
                return Ok((device, context));
            }
            Err(e) => {
                log::warn!("D3D11CreateDevice({driver:?}): {e}");
                last = e.to_string();
            }
        }
    }
    Err(format!("D3D11CreateDevice failed for HARDWARE and WARP: {last}"))
}

/// Wrap an `ID3D11Device` as a WinRT `IDirect3DDevice` for the WGC frame pool so
/// frames return on OUR device (trap #1; the SF0 register-direct invariant).
pub fn wrap_for_winrt(device: &ID3D11Device) -> Result<IDirect3DDevice, String> {
    let dxgi: IDXGIDevice = device.cast().map_err(|e| format!("cast IDXGIDevice: {e}"))?;
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice: {e}"))?;
    inspectable
        .cast()
        .map_err(|e| format!("cast IDirect3DDevice: {e}"))
}
