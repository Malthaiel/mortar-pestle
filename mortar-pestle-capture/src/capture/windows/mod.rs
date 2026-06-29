//! Windows capture backend (Game Capture SF2) — the WGC + D3D11 frame source,
//! cfg-selected as `crate::capture` on Windows (via a `#[path]` in `main.rs`). The
//! Linux backend is the sibling `capture/mod.rs` (PipeWire/EGL/GL); the two never
//! compile together, so neither file is gated internally.
//!
//! SF2 yields `ID3D11Texture2D`s on one shared `ID3D11Device` (the SF0 invariant);
//! SF3 wires `wgc::WgcCapture` + the SF1 `NvencD3d11Encoder` into the daemon engine
//! (the concrete capture/encoder types are cfg type-aliased there — no trait object,
//! keeping the hot path vtable-free).

pub mod d3d11;
pub mod encode;
pub mod wgc;

// The encoded-packet replay ring is platform-neutral (a pure data structure, no
// syscalls); include the sibling Linux file directly so `crate::capture::replay_ring`
// resolves on Windows too (the daemon engine + `run::TeeSink` consume it). Compiled
// once per cfg build — never alongside the Linux `capture/mod.rs`'s `pub mod replay_ring`.
#[path = "../replay_ring.rs"]
pub mod replay_ring;

// System-audio capture (Game Capture SF5). The neutral cut/stats/PcmBuffer parts are
// platform-shared; the WASAPI loopback impl is the `#[cfg(windows)]` arm inside the
// file. Same `#[path]` include pattern as `replay_ring` so `crate::capture::audio`
// resolves on Windows too (the daemon engine consumes `AudioCapture`).
#[path = "../audio.rs"]
pub mod audio;

/// Encoder configuration shared by every frame — the Windows mirror of the Linux
/// `capture::EncodeParams` (the daemon's `params_from_config` builds it). Width and
/// height come from the WGC capture size at session start, not from here.
#[derive(Debug, Clone, Copy)]
pub struct EncodeParams {
    pub bitrate_bps: u32,
    pub gop_len: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// SF2 verification probe (`mortar-pestle-capture capture probe [frames]`): capture
/// `frames` foreground-window frames on the shared device, logging sizes + the
/// pool-Recreate count. Run with a window focused; resize it mid-run to exercise
/// `Recreate`. Needs a live desktop + an NVIDIA GPU — the same interactive gate as
/// the SF0 spike. Returns the number of frames actually captured.
pub fn probe(frames: u32) -> Result<u32, String> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // WGC activation factories need an initialized COM apartment; MTA matches the
    // free-threaded pool (S_FALSE / RPC_E_CHANGED_MODE if already initialized).
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let hwnd: HWND = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err("GetForegroundWindow returned null — focus a window first".into());
    }

    let (device, _context) = d3d11::create_device()?;
    let winrt_device = d3d11::wrap_for_winrt(&device)?;
    let mut cap = wgc::WgcCapture::start(hwnd, &winrt_device)?;
    let (w, h) = cap.size();
    log::info!("WGC capture started on foreground HWND {:?} ({w}x{h}); grabbing {frames} frames", hwnd.0);

    let mut got = 0u32;
    for i in 0..frames {
        match cap.next_frame(Duration::from_secs(2)) {
            Ok(t) => {
                got += 1;
                if i == 0 || i % 30 == 0 {
                    log::info!(
                        "frame {i}: {}x{} texture={:?} on the shared device",
                        t.width,
                        t.height,
                        t.texture.as_raw()
                    );
                }
            }
            Err(e) => {
                log::warn!("frame {i}: {e}");
                break;
            }
        }
    }
    log::info!(
        "captured {got}/{frames} frames; {} pool recreate(s)",
        cap.recreate_count()
    );
    Ok(got)
}

/// SF10 — `true` when a D3D **exclusive-fullscreen** app is the foreground window.
/// Such apps are invisible to WGC (OBS/Discord hit the same wall), so the daemon
/// warns instead of recording a black clip. A fast hint only — the no-first-frame
/// check in the engine's `build_win_session` is the authoritative catch (it also
/// covers protected windows that don't trip this state). Any FFI error (rare, e.g.
/// the secure desktop) is treated as "not fullscreen" so the frame check decides.
pub fn is_exclusive_fullscreen() -> bool {
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
    // SAFETY: plain FFI; reads the current shell user-notification state.
    matches!(unsafe { SHQueryUserNotificationState() }, Ok(QUNS_RUNNING_D3D_FULL_SCREEN))
}
