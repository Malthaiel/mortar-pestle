//! Shared D3D11 device for the Windows capture backend (Game Capture SF2). ONE
//! `ID3D11Device` backs both the WGC frame pool and (SF3) the NVENC encoder — the
//! SF0 register-direct invariant (a foreign device makes register/map fail).

use windows::core::Interface;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

/// Create one `ID3D11Device` (+ immediate context) with BGRA support — required
/// for WGC and `CreateDirect3D11DeviceFromDXGIDevice`. Hardware first, WARP fallback.
pub fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
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
