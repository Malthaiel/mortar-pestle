//! Broadcast SP2 — the child-HWND host for engine preview regions.
//!
//! The app creates a bare Win32 child window under the main Tauri window and
//! hands its HWND (as u64) to the engine's `display_create`; the engine only
//! creates a D3D11 swapchain on it (the Qt-frontend `winId()` / SLOBS shape,
//! spike-verified cross-process 2026-07-02). Position never crosses the pipe —
//! the app owns SetWindowPos; only the physical size does (`display_resize`).
//!
//! Threading: every window op runs on the main thread via `run_on_main_thread`
//! + a oneshot (the browser_windows.rs discipline — window ops on a command
//! worker thread deadlock/starve serialized IPC).
//!
//! DPI: callers pass LOGICAL px (JS `getBoundingClientRect`, rounded); this
//! module owns the ×`scale_factor()` conversion to physical px. Child
//! coordinates are relative to the parent's client area, which the main
//! webview fills — so viewport coords map 1:1.
//!
//! Window lifetime = engine-display lifetime, NEVER longer: a killed engine
//! process leaves its swapchain association on the HWND, and a NEW engine's
//! `obs_display_create` on that reused window fails (observed 2026-07-03,
//! "swapchain on hwnd" after a respawn drill). So `ensure` always creates a
//! FRESH window (destroying any cached one for the id) and `destroy` really
//! destroys — no hide-and-reuse. Keyed by display id (SP8 multiview adds
//! entries, same map); stored as `isize` because `HWND` is not `Send`.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, SetWindowPos, HWND_TOP,
    SWP_NOACTIVATE, SWP_SHOWWINDOW, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
    WS_EX_NOPARENTNOTIFY, WS_VISIBLE,
};

/// display id → child HWND (as isize; HWND is not Send). TABS idiom.
static HOSTS: Mutex<Option<HashMap<String, isize>>> = Mutex::new(None);

/// The host window procedure — pure DefWindowProc passthrough. Exists only
/// because `WNDPROC` requires the "system" ABI and windows-rs declares
/// `DefWindowProcW` as a plain fn item.
unsafe extern "system" fn host_wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

/// Register the host window class once. Null `hbrBackground` is deliberate:
/// no WM_ERASEBKGND paint means no background flicker under the swapchain
/// during resizes (why the predefined STATIC class is not used).
fn ensure_class() -> Result<(), String> {
    static CLASS: std::sync::Once = std::sync::Once::new();
    let mut failed = false;
    CLASS.call_once(|| unsafe {
        let hinstance = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(_) => {
                failed = true;
                return;
            }
        };
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(host_wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: w!("MPBroadcastDisplay"),
            hbrBackground: HBRUSH::default(),
            ..Default::default()
        };
        if RegisterClassExW(&wc) == 0 {
            failed = true;
        }
    });
    if failed {
        Err("RegisterClassExW(MPBroadcastDisplay) failed".into())
    } else {
        Ok(())
    }
}

/// Logical→physical for one rect against the main window's live scale factor
/// (re-read per call — a DPI change rides the next bounds sync).
fn to_physical(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(i32, i32, i32, i32), String> {
    let main = app.get_webview_window("main").ok_or("no main window")?;
    let sf = main.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    Ok((
        (x * sf).round() as i32,
        (y * sf).round() as i32,
        ((w * sf).round() as i32).max(1),
        ((h * sf).round() as i32).max(1),
    ))
}

fn stored(id: &str) -> Option<isize> {
    HOSTS.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(id).copied()))
}

/// Create a FRESH child host for `id` at the given LOGICAL rect, destroying
/// any cached window for that id first (see module header — a window that
/// hosted a dead engine's swapchain refuses a new one). Returns
/// `(hwnd as u64, physical_w, physical_h)` for the engine's `display_create`.
pub async fn ensure(app: &AppHandle, id: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(u64, u32, u32), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(u64, u32, u32), String>>();
    let app2 = app.clone();
    let id = id.to_string();
    app.run_on_main_thread(move || {
        let _ = tx.send((|| -> Result<(u64, u32, u32), String> {
            ensure_class()?;
            let (px, py, pw, ph) = to_physical(&app2, x, y, w, h)?;
            destroy_stored(&id);
            let main = app2.get_webview_window("main").ok_or("no main window")?;
            let parent = main.hwnd().map_err(|e| format!("main hwnd: {e}"))?;
            let hwnd = unsafe {
                let hinstance = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandleW: {e}"))?;
                CreateWindowExW(
                    WS_EX_NOPARENTNOTIFY,
                    w!("MPBroadcastDisplay"),
                    None,
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                    px,
                    py,
                    pw,
                    ph,
                    Some(parent),
                    None,
                    Some(hinstance.into()),
                    None,
                )
                .map_err(|e| format!("CreateWindowExW: {e}"))?
            };
            // New children start atop siblings, but assert it — the WebView2
            // controller is a sibling child and the region must float above it.
            unsafe {
                let _ = SetWindowPos(hwnd, Some(HWND_TOP), px, py, pw, ph, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }
            let raw = hwnd.0 as isize;
            if let Ok(mut g) = HOSTS.lock() {
                g.get_or_insert_with(HashMap::new).insert(id, raw);
            }
            Ok((raw as u64, pw as u32, ph as u32))
        })());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "display_host::ensure task dropped".to_string())?
}

/// Reposition an existing host (LOGICAL rect in). Returns the physical size
/// for the engine's `display_resize`. Deliberately NO `SWP_SHOWWINDOW`:
/// showing belongs to `ensure` only — a bounds sync racing a hide must never
/// resurrect a hidden host with stale swapchain pixels (the 2026-07-03
/// frozen-preview bug).
pub async fn set_bounds(app: &AppHandle, id: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(u32, u32), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(u32, u32), String>>();
    let app2 = app.clone();
    let id = id.to_string();
    app.run_on_main_thread(move || {
        let _ = tx.send((|| -> Result<(u32, u32), String> {
            let raw = stored(&id).ok_or_else(|| format!("no display host '{id}'"))?;
            let (px, py, pw, ph) = to_physical(&app2, x, y, w, h)?;
            unsafe {
                SetWindowPos(HWND(raw as *mut std::ffi::c_void), Some(HWND_TOP), px, py, pw, ph, SWP_NOACTIVATE)
                    .map_err(|e| format!("SetWindowPos: {e}"))?;
            }
            Ok((pw as u32, ph as u32))
        })());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "display_host::set_bounds task dropped".to_string())?
}

/// Destroy the host window for `id`. Missing id is a no-op — this runs on
/// best-effort cleanup paths. MAIN-THREAD ONLY (DestroyWindow must run on the
/// creating thread) — callers go through [`destroy`].
fn destroy_stored(id: &str) {
    let raw = HOSTS.lock().ok().and_then(|mut g| g.as_mut().and_then(|m| m.remove(id)));
    if let Some(raw) = raw {
        unsafe {
            let _ = DestroyWindow(HWND(raw as *mut std::ffi::c_void));
        }
    }
}

/// Tear down the host for `id` (window destroyed, not hidden — see module
/// header). Missing id is a no-op.
pub async fn destroy(app: &AppHandle, id: &str) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let id = id.to_string();
    app.run_on_main_thread(move || {
        destroy_stored(&id);
        let _ = tx.send(Ok(()));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "display_host::destroy task dropped".to_string())?
}
