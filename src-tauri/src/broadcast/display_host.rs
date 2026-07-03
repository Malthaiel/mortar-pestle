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
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, w, Ref, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, POINTL, WPARAM};
use windows::Win32::Graphics::Gdi::{MapWindowPoints, HBRUSH};
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP,
    DROPEFFECT, DROPEFFECT_COPY,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, EnumChildWindows, GetClassNameW, IsWindow,
    PostMessageW, RegisterClassExW, SendMessageW, SetWindowPos, HWND_TOP, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR, WNDCLASSEXW,
    WS_CHILD, WS_CLIPSIBLINGS, WS_EX_NOPARENTNOTIFY, WS_EX_TRANSPARENT, WS_VISIBLE,
};

/// display id → child HWND (as isize; HWND is not Send). TABS idiom.
static HOSTS: Mutex<Option<HashMap<String, isize>>> = Mutex::new(None);

/// Main-window HWND (set in `ensure`) + cached WebView2 input child, both as
/// isize (HWND is not Send). The cache re-resolves lazily whenever the stored
/// window dies — WebView2 recreates its input window freely.
static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);
static FORWARD_TARGET: AtomicIsize = AtomicIsize::new(0);

/// AppHandle for the WM_DROPFILES relay (wndprocs have no userdata channel
/// worth the ceremony for one emit). Set once in `ensure`.
static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "system" fn find_webview_input(hwnd: HWND, lp: LPARAM) -> BOOL {
    let mut class = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, &mut class) } as usize;
    if String::from_utf16_lossy(&class[..n]) == "Chrome_RenderWidgetHostHWND" {
        unsafe { *(lp.0 as *mut isize) = hwnd.0 as isize };
        return BOOL(0);
    }
    BOOL(1)
}

/// The WebView2 descendant that accepts WM_MOUSE* input (Chromium's "legacy
/// window"). None until the webview exists; cached after first resolve.
fn forward_target() -> Option<HWND> {
    let cached = FORWARD_TARGET.load(Ordering::Relaxed);
    if cached != 0 && unsafe { IsWindow(Some(HWND(cached as *mut _))) }.as_bool() {
        return Some(HWND(cached as *mut _));
    }
    let main = MAIN_HWND.load(Ordering::Relaxed);
    if main == 0 {
        return None;
    }
    let mut found: isize = 0;
    unsafe {
        let _ = EnumChildWindows(
            Some(HWND(main as *mut _)),
            Some(find_webview_input),
            LPARAM(&mut found as *mut isize as isize),
        );
    }
    if found == 0 {
        return None;
    }
    FORWARD_TARGET.store(found, Ordering::Relaxed);
    Some(HWND(found as *mut _))
}

/// The host window procedure — a mouse RELAY (SP3 pointer-input fix).
///
/// Neither `HTTRANSPARENT` on WM_NCHITTEST nor the `WS_EX_TRANSPARENT`
/// ex-style lets input fall through to the WebView2 sibling: the system's
/// mouse targeting honors either only among same-thread windows, and
/// WebView2's input windows live on the msedgewebview2 process's threads —
/// so this child receives all pointer input over the preview regardless
/// (verified live 2026-07-03: DOM saw one edge `pointerenter`, then silence
/// inside the region).
///
/// So the host relays: mouse messages are re-posted to the WebView2 input
/// child with coordinates mapped into its client space; Chromium then
/// synthesizes normal DOM pointer events on whatever lies at that point —
/// PreviewInteract's surface. WM_SETCURSOR is SENT through so the
/// DOM-computed cursor (move/resize) actually renders. Wheel lParam is
/// screen coords — retargeted unchanged. OLE drops hit the same cross-thread
/// wall, so the window carries its own [`HostDropTarget`]. `WS_EX_TRANSPARENT`
/// stays on the window: harmless to the relay, honored by API-level
/// WindowFromPoint callers.
unsafe extern "system" fn host_wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN | WM_RBUTTONUP
        | WM_MBUTTONDOWN | WM_MBUTTONUP => {
            if let Some(target) = forward_target() {
                let mut pts = [POINT {
                    x: (lp.0 & 0xFFFF) as u16 as i16 as i32,
                    y: ((lp.0 >> 16) & 0xFFFF) as u16 as i16 as i32,
                }];
                unsafe { MapWindowPoints(Some(hwnd), Some(target), &mut pts) };
                let packed = ((pts[0].y as u32 & 0xFFFF) << 16) | (pts[0].x as u32 & 0xFFFF);
                unsafe {
                    let _ = PostMessageW(Some(target), msg, wp, LPARAM(packed as i32 as isize));
                }
            }
            LRESULT(0)
        }
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            if let Some(target) = forward_target() {
                unsafe {
                    let _ = PostMessageW(Some(target), msg, wp, lp);
                }
            }
            LRESULT(0)
        }
        WM_SETCURSOR => {
            if let Some(target) = forward_target() {
                let r = unsafe {
                    SendMessageW(target, WM_SETCURSOR, Some(WPARAM(target.0 as usize)), Some(lp))
                };
                if r.0 != 0 {
                    return r;
                }
            }
            unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

/// OLE drop target for the host child. OLE resolves drop targets from the
/// window under the cursor — this child, same cross-thread wall as the mouse
/// (verified 2026-07-03: WRY's target fires `leave` at the region edge and
/// the legacy DragAcceptFiles shim never engages because the top-level
/// carries an `OleDropTargetInterface` prop). So the host carries its own
/// target and relays drops as `broadcast://host-drop` in onDragDropEvent's
/// coordinate convention (physical px, main-window client space).
#[implement(IDropTarget)]
struct HostDropTarget;

impl IDropTarget_Impl for HostDropTarget_Impl {
    fn DragEnter(
        &self,
        _pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe { *pdweffect = DROPEFFECT_COPY };
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe { *pdweffect = DROPEFFECT_COPY };
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe { *pdweffect = DROPEFFECT_COPY };
        let Some(data) = pdataobj.as_ref() else {
            return Ok(());
        };
        let fmt = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0 as u32,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let mut medium = unsafe { data.GetData(&fmt) }?;
        let mut paths = Vec::new();
        unsafe {
            let hdrop = HDROP(medium.u.hGlobal.0 as *mut _);
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                let n = DragQueryFileW(hdrop, i, Some(&mut buf)) as usize;
                paths.push(String::from_utf16_lossy(&buf[..n]));
            }
            ReleaseStgMedium(&mut medium);
        }
        // pt is SCREEN px; the frontend expects main-window client physical px.
        let main = MAIN_HWND.load(Ordering::Relaxed);
        let mut pts = [POINT { x: pt.x, y: pt.y }];
        if main != 0 {
            unsafe { MapWindowPoints(None, Some(HWND(main as *mut _)), &mut pts) };
        }
        if let Some(app) = APP.get() {
            let _ = app.emit(
                "broadcast://host-drop",
                serde_json::json!({ "paths": paths, "position": { "x": pts[0].x, "y": pts[0].y } }),
            );
        }
        Ok(())
    }
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
            MAIN_HWND.store(parent.0 as isize, Ordering::Relaxed);
            let _ = APP.set(app2.clone());
            let hwnd = unsafe {
                let hinstance = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandleW: {e}"))?;
                CreateWindowExW(
                    WS_EX_NOPARENTNOTIFY | WS_EX_TRANSPARENT,
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
                let target: IDropTarget = HostDropTarget.into();
                if let Err(e) = RegisterDragDrop(hwnd, &target) {
                    log::warn!("display_host: RegisterDragDrop failed: {e:?}");
                }
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
            let _ = RevokeDragDrop(HWND(raw as *mut std::ffi::c_void));
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
