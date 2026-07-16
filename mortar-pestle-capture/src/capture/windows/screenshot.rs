//! One-shot full-monitor screenshot (Game Capture SF9). Grabs one WGC frame of the
//! monitor the capture target (the game / foreground window) is on, reads it back
//! through a CPU staging texture, and writes a PNG next to the clips
//! (`<Game> YYYY-MM-DD HH-MM-SS.png` under the captures root).
//!
//! Monitor capture (not window capture) on purpose: WDA_EXCLUDEFROMCAPTURE windows
//! — our own overlays — are composited out of a monitor item, so a screenshot
//! excludes the overlay unless the host lifts the affinity for the shot (the
//! "include overlay" toggle). Runs on its own COM-initialized thread; never call
//! from the dispatch task.

use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use super::{d3d11, wgc::WgcCapture};
use crate::daemon::save;

/// Grab one frame of the capture target's monitor and save it as a PNG. Returns
/// the saved path. Mirrors the Linux portal twin's `Result<String, String>` shape.
pub fn take_screenshot() -> Result<String, String> {
    // WGC activation factories need an initialized COM apartment; MTA matches the
    // free-threaded pool (S_FALSE / RPC_E_CHANGED_MODE if already initialized).
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    // Null foreground hwnd → MONITOR_DEFAULTTOPRIMARY falls back to the primary.
    let hwnd: HWND = save::namer::capture_target_hwnd();
    let hmon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY) };

    let (device, context) = d3d11::create_device()?;
    let winrt = d3d11::wrap_for_winrt(&device)?;
    let mut cap = WgcCapture::start_monitor(hmon, &winrt)?;
    let frame = cap.next_frame(Duration::from_secs(2))?;
    let rgba = readback_rgba(&device, &context, &frame.texture, frame.width, frame.height)?;
    drop(cap); // close the WGC session before the PNG encode

    let path = save::screenshot_png_path(&save::namer::detect_game())?;
    write_png(&path, frame.width, frame.height, &rgba)?;
    Ok(path)
}

/// Copy `src` (BGRA, on the shared device) into a fresh CPU staging texture, map
/// it, and return tightly-packed RGBA rows (alpha forced opaque — WGC monitor
/// frames can carry garbage alpha).
fn readback_rgba(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    src: &ID3D11Texture2D,
    w: u32,
    h: u32,
) -> Result<Vec<u8>, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut staging: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
        .map_err(|e| format!("CreateTexture2D (screenshot staging {w}x{h}): {e}"))?;
    let staging = staging.ok_or("CreateTexture2D returned a null staging texture")?;

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: staging is a fresh CPU-read texture on the same device as `src`;
    // CopyResource requires identical descs, which the WGC frame's BGRA desc matches.
    unsafe {
        context.CopyResource(&staging, src);
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|e| format!("Map (screenshot staging): {e}"))?;
    }
    let pitch = mapped.RowPitch as usize;
    let mut rgba = vec![0u8; (w as usize) * (h as usize) * 4];
    // SAFETY: mapped.pData is valid for RowPitch × Height bytes while mapped.
    unsafe {
        let base = mapped.pData as *const u8;
        for y in 0..h as usize {
            let row = std::slice::from_raw_parts(base.add(y * pitch), (w as usize) * 4);
            let out = &mut rgba[y * (w as usize) * 4..(y + 1) * (w as usize) * 4];
            for x in 0..w as usize {
                out[x * 4] = row[x * 4 + 2]; // R <- B slot
                out[x * 4 + 1] = row[x * 4 + 1]; // G
                out[x * 4 + 2] = row[x * 4]; // B <- R slot
                out[x * 4 + 3] = 255;
            }
        }
        context.Unmap(&staging, 0);
    }
    Ok(rgba)
}

/// Encode tightly-packed RGBA rows to `path` as an 8-bit PNG.
fn write_png(path: &str, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| format!("create {path}: {e}"))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| format!("png header: {e}"))?;
    writer.write_image_data(rgba).map_err(|e| format!("png write: {e}"))?;
    writer.finish().map_err(|e| format!("png finish: {e}"))?;
    Ok(())
}
