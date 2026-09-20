//! Native Video Player — the mpv picture surface and its process lane.
//!
//! The app creates a bare Win32 child window under the main Tauri window and
//! hands its HWND (as u64) to `mpv --wid=<hwnd>`; mpv creates its own D3D11
//! swapchain on it. Shape copied from `broadcast/display_host.rs`, which does
//! the identical thing for the capture engine's preview: child window, LOGICAL
//! px in, this module owns the ×scale_factor conversion, every window op on the
//! main thread via `run_on_main_thread` + a oneshot (window ops on a command
//! worker thread starve serialized IPC).
//!
//! Why a child HWND and not a `<video>` element: WebView2 in this app decodes
//! no HEVC at all, so an anime episode had to be re-encoded (91 s) before it
//! could play, and could not be seeked at all until that finished. mpv opens
//! the same 2 GB file, hardware-decodes HEVC Main10 and delivers a frame at an
//! arbitrary timestamp in 0.98 s. Spike-proven and photographed 2026-08-23.
//!
//! Z-ORDER: the host sits at HWND_TOP, ABOVE the web layer. This is not a
//! choice — the two-way spike showed the webview surface is opaque, so mpv at
//! HWND_BOTTOM is simply invisible. The controls therefore cannot live in the
//! main web layer.
//!
//! THE CONTROLS ARE A BORDERLESS TRANSPARENT TOP-LEVEL WINDOW **OWNED BY THE
//! MAIN WINDOW** — deliberately NOT an always-on-top one. Ownership is what
//! keeps the bar above the app and its mpv child while still letting every
//! OTHER application cover it; `always_on_top` was tried on 2026-09-06 and
//! floated this click-eating transparent layer over File Explorer. The full
//! reasoning lives at the `.owner(&main)` call in `player_controls_attach`,
//! which is the authority — do not re-derive it from this header.
//!
//! A non-TOPMOST ex-style on the live window is therefore CORRECT, not a
//! missing flag. Re-verified by measurement 2026-09-07 after this header's
//! earlier "ALWAYS-ON-TOP" wording sent a debug session hunting a z-order bug
//! that does not exist: `GWLP_HWNDPARENT` on the live controls window returns
//! the main HWND, and forcing the main window to `HWND_TOP` still cannot get
//! above the bar. Note the window is rebuilt on every episode change, so a
//! handle captured earlier measures a DEAD window and reports no owner.
//!
//! It uses the same shape `overlay-toast` and `overlay-host` already do.
//! A CHILD WEBVIEW WAS TRIED
//! FIRST AND CANNOT WORK: a transparent child webview occludes the mpv child
//! EVERYWHERE IT EXTENDS, transparent pixels included — its DirectComposition
//! surface hides a plain sibling window and shows the MAIN web layer through
//! instead. Measured 2026-08-23: over a 450px picture, a 44px bar cost 410px of
//! video and an 82px bar cost 368px.
//!
//! A top-level window has no such cost, so it is sized to the WHOLE PICTURE
//! rather than to the bar it draws. Measured 2026-08-23: with a full 1440x900
//! overlay stacked on top, mpv still reported `osd-dimensions 1440x900` — the
//! complete rect. That is what lets ONE overlay hold both bars and also own
//! click-to-pause and double-click-fullscreen across the picture, talking to
//! mpv directly. No click-through trickery is involved; the host's
//! `WS_EX_TRANSPARENT` is left over from the child-webview attempt and is now
//! dead weight.
//!
//! Why the app cannot instead draw what mpv draws: mpv's own OSC is a Lua
//! script emitting ASS that mpv's OSD layer paints INTO the frame, and that
//! path draws only ASS. The apps that composite mpv with an HTML UI in ONE
//! window (Jellyfin Media Player, Plex Desktop) link libmpv and render into
//! their own graphics context — unreachable here, because WebView2 owns its
//! composited surface.
//!
//! Do NOT test this window with a flat colour. A GDI `FillRect` on it never
//! reaches the screen at EITHER z-order — the webview's DirectComposition
//! surface covers plain drawing, while a D3D swapchain shows fine. A colour
//! proxy yields a false negative; test with mpv itself.
//!
//! Keyed by surface id (`modal` / `pip` / `popout`) — all three must work, and
//! PiP means two can be live at once. Stored as `isize` because `HWND` is not
//! `Send`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, IsWindow, RegisterClassExW, SetWindowPos,
    HWND_TOP, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, WNDCLASSEXW, WS_CHILD,
    GetWindowLongPtrW, SetWindowLongPtrW,
    GWL_EXSTYLE, WS_CLIPSIBLINGS, WS_EX_NOACTIVATE,
    WS_EX_NOPARENTNOTIFY, WS_EX_TRANSPARENT, WS_VISIBLE,
};

/// surface id → child HWND (as isize). The `display_host` HOSTS idiom.
static HOSTS: Mutex<Option<HashMap<String, isize>>> = Mutex::new(None);

/// surface id → its mpv's pid. A leaked mpv keeps decoding a 2 GB file with no
/// window to draw into. Only the pid is parked here: the `Child` itself belongs
/// to its supervisor task, because `wait()` needs it exclusively and holding a
/// map lock for the length of a playback session is not a thing.
static PIDS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

/// One in-flight request: the JSON to write, and where the reply goes.
type Request = (serde_json::Value, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>);

/// surface id → the channel into that surface's IPC actor. The actor owns the
/// pipe; nothing else may write to it, because mpv correlates replies by
/// `request_id` and two writers interleaving mid-line would corrupt the stream.
static CONNS: Mutex<Option<HashMap<String, tokio::sync::mpsc::UnboundedSender<Request>>>> =
    Mutex::new(None);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// surface id → the label of its controls webview, so bounds and teardown can
/// find it again. The webview itself is owned by the window.
static CONTROLS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// surface id → its picture's LOGICAL client rect. A top-level controls window
/// does not ride the main window the way the child host does, so when the app
/// moves this is what the new screen position is recomputed FROM. Stored rather
/// than re-derived because only the caller knows where the picture is.
static RECTS: Mutex<Option<HashMap<String, (f64, f64, f64, f64)>>> = Mutex::new(None);

/// Opening and closing are serialised against each other.
///
/// `player_open` kills the surface's previous mpv, THEN spawns, THEN records the
/// new pid — so two concurrent opens both find nothing to kill and both spawn,
/// leaving an orphan decoding a 2 GB file with no window. Measured 2026-08-23:
/// React's StrictMode double-invokes the effect that opens the player, and two
/// mpv processes appeared in the same second.
///
/// One global lock rather than one per surface: opening a player happens at
/// human speed and there are three surfaces, so the contention this could ever
/// cause is smaller than the bookkeeping to avoid it.
static OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What `player_open` hands back. The pipe name is the control channel.
#[derive(serde::Serialize)]
pub struct PlayerHandle {
    pub hwnd: u64,
    pub pid: u32,
    pub pipe: String,
}

/// One IPC pipe per OPEN — not per surface. (Still one per surface at any
/// moment, so a PiP seek can never reach the modal.)
///
/// A name fixed per surface cannot be reused fast enough. Changing episode kills
/// the old mpv and spawns the next about five milliseconds later, and Windows
/// has not torn down the dead process's pipe server by then, so the new mpv
/// starts with no control channel at all:
///
///   [ipc] Couldn't create first pipe instance: Access is denied. (0x80070005)
///
/// It plays perfectly and answers nothing — every command comes back "the video
/// player is no longer running" while the picture is on screen, which reads
/// exactly like a crash and is not one. Measured 2026-08-23: three of six
/// episode changes. A sequence number sidesteps the wait entirely; nothing
/// guesses this name, it is handed back in `PlayerHandle` and the live one is
/// held per surface in `CONNS`.
static PIPE_SEQ: AtomicU64 = AtomicU64::new(1);

fn pipe_name(surface: &str) -> String {
    let n = PIPE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!(r"\\.\pipe\mortar-pestle-mpv-{surface}-{n}")
}

/// mpv's stdout/stderr sink: `%LOCALAPPDATA%\mortar-pestle\logs\mortar-pestle-mpv.log`.
/// The spike ran blind because mpv's output went nowhere — every failure looked
/// identical from the app side. Same shape as the capture/broadcast sidecars.
fn log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("mortar-pestle").join("logs").join("mortar-pestle-mpv.log"))
}

/// mpv owns every pixel of this window through its own swapchain, so the proc
/// has nothing to do but the default. It still has to exist: `DefWindowProcW`
/// itself is an `unsafe fn`, not an `extern "system"` fn pointer.
unsafe extern "system" fn host_wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

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
            lpszClassName: w!("MPPlayerHost"),
            hbrBackground: HBRUSH::default(),
            ..Default::default()
        };
        if RegisterClassExW(&wc) == 0 {
            failed = true;
        }
    });
    if failed {
        Err("RegisterClassExW(MPPlayerHost) failed".into())
    } else {
        Ok(())
    }
}

/// Logical→physical against the main window's live scale factor. `get_window`,
/// never `get_webview_window` — the latter returns None once a child webview is
/// added to the main window, which Phase 3's controls layer will do.
fn to_physical(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(i32, i32, i32, i32), String> {
    let main = app.get_window("main").ok_or("no main window")?;
    let sf = main.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    Ok((
        (x * sf).round() as i32,
        (y * sf).round() as i32,
        ((w * sf).round() as i32).max(1),
        ((h * sf).round() as i32).max(1),
    ))
}

fn destroy_stored(surface: &str) {
    let raw = HOSTS
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().and_then(|m| m.remove(surface)));
    if let Some(raw) = raw {
        let hwnd = HWND(raw as *mut _);
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = DestroyWindow(hwnd);
            }
        }
    }
}

/// Create a FRESH picture host for `surface` at the given LOGICAL rect. Always
/// fresh, never hide-and-reuse: a dead mpv leaves its swapchain association on
/// the HWND and the next one fails to bind (the lesson `display_host` already
/// learned from a respawned capture engine).
pub async fn ensure(app: &AppHandle, surface: String, x: f64, y: f64, w: f64, h: f64) -> Result<u64, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<u64, String>>();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send((|| -> Result<u64, String> {
            ensure_class()?;
            let (px, py, pw, ph) = to_physical(&app2, x, y, w, h)?;
            destroy_stored(&surface);
            let main = app2.get_window("main").ok_or("no main window")?;
            let parent = main.hwnd().map_err(|e| format!("main hwnd: {e}"))?;
            let hwnd = unsafe {
                let hinstance =
                    GetModuleHandleW(None).map_err(|e| format!("GetModuleHandleW: {e}"))?;
                CreateWindowExW(
                    // NOPARENTNOTIFY + TRANSPARENT: the host is a passive picture
                    // surface, never an input target. Clicks pass through to the
                    // layer that owns the controls.
                    WS_EX_NOPARENTNOTIFY | WS_EX_TRANSPARENT,
                    w!("MPPlayerHost"),
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
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    px,
                    py,
                    pw,
                    ph,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            let raw = hwnd.0 as isize;
            if let Ok(mut g) = HOSTS.lock() {
                g.get_or_insert_with(HashMap::new).insert(surface, raw);
            }
            Ok(raw as u64)
        })());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "player_host::ensure task dropped".to_string())?
}

/// Reposition an existing host (LOGICAL rect in). No SWP_SHOWWINDOW and no
/// z-order change — a bounds sync must never resurrect a destroyed host nor
/// re-stack the surface behind whatever now sits above it.
pub async fn set_bounds(app: &AppHandle, surface: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send((|| -> Result<(), String> {
            let raw = HOSTS
                .lock()
                .ok()
                .and_then(|g| g.as_ref().and_then(|m| m.get(&surface).copied()))
                .ok_or_else(|| format!("no player host for surface {surface}"))?;
            let (px, py, pw, ph) = to_physical(&app2, x, y, w, h)?;
            unsafe {
                SetWindowPos(
                    HWND(raw as *mut _),
                    None,
                    px,
                    py,
                    pw,
                    ph,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                )
                .map_err(|e| format!("SetWindowPos: {e}"))?;
            }
            Ok(())
        })());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "player_host::set_bounds task dropped".to_string())?
}

/// Kill the mpv owning `surface`, if any. By pid rather than through the
/// `Child`, which the supervisor task owns; `PROCESS_TERMINATE` on a pid that
/// already exited simply fails, which is the outcome we want anyway.
fn kill_proc(surface: &str) {
    let pid = PIDS
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().and_then(|m| m.remove(surface)));
    drop_conn(surface);
    let Some(pid) = pid else { return };
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(h, 0);
            let _ = CloseHandle(h);
        }
    }
}

/// Tear down one surface: mpv first, then the window it was drawing into.
pub async fn destroy(app: &AppHandle, surface: String) -> Result<(), String> {
    kill_proc(&surface);
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    app.run_on_main_thread(move || {
        destroy_stored(&surface);
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "player_host::destroy task dropped".to_string())
}

/// One line in the mpv log for every lifecycle event, into the SAME file mpv's
/// own output goes to so the order of "we opened" against "mpv said" is readable
/// without correlating two clocks. A player that vanishes with no error on
/// screen is otherwise invisible: an mpv we killed ourselves reports no exit by
/// design, so without this the only evidence of a wrong-order teardown is a
/// black rectangle.
pub fn trace(what: &str) {
    use std::io::Write;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Some(path) = log_path() {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[host {ms}] {what}");
            return;
        }
    }
    log::info!("[player_host] {what}");
}

/// Drain one child pipe into the mpv log. Byte-oriented + lossy on purpose:
/// `lines()` aborts the whole reader on the first non-UTF-8 byte and takes the
/// rest of the output with it, silently.
async fn drain_to_log<R>(pipe: R, tag: &'static str)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use std::io::Write;
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end();
        if let Some(path) = log_path() {
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = writeln!(f, "[{tag}] {line}");
                continue;
            }
        }
        log::info!("[mpv {tag}] {line}");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Open `path` in a fresh mpv bound to a fresh host window for `surface`.
///
/// `start` is an mpv time spec (`"0"`, `"14:00"`, `"842.5"`) — the whole point
/// of the lane: an arbitrary seek costs the same as opening at zero.
#[tauri::command]
pub async fn player_open(
    app: AppHandle,
    surface: String,
    path: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    start: Option<String>,
) -> Result<PlayerHandle, String> {
    trace(&format!("open  request surface={surface} path={path}"));
    // Held for the whole open: kill → spawn → record must not interleave with
    // another open or a close on any surface.
    let _guard = OPEN_LOCK.lock().await;
    trace(&format!("open  lock     surface={surface}"));
    let mpv = crate::tool_path::resolve("mpv");
    // Any previous mpv on this surface dies BEFORE its window does — mpv losing
    // its render target out from under it is not a state worth exploring.
    kill_proc(&surface);
    let hwnd = ensure(&app, surface.clone(), x, y, w, h).await?;
    let pipe = pipe_name(&surface);

    let mut child = crate::commands::proc_util::tokio_cmd(&mpv)
        // The user's own mpv.conf must not reach into the app's player — an
        // --osc or --vo line there would fight the app's controls.
        .arg("--no-config")
        .arg(format!("--wid={hwnd}"))
        .arg(format!("--input-ipc-server={pipe}"))
        .arg("--hwdec=auto")
        // Hold the last frame instead of the process exiting at EOF, so the app
        // decides what "episode ended" means.
        .arg("--keep-open=yes")
        // No mpv chrome and no mpv keybinds — the app's candy controls are the
        // only UI, and mpv must not eat a keystroke meant for the app.
        .arg("--osc=no")
        .arg("--no-input-default-bindings")
        .arg(format!("--start={}", start.unwrap_or_else(|| "0".into())))
        .arg(crate::tool_path::native_str(&path))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("could not start the video player ({mpv}): {e}")
        })?;

    let pid = child.id().unwrap_or(0);
    if let Some(out) = child.stdout.take() {
        tokio::spawn(drain_to_log(out, "out"));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(drain_to_log(err, "err"));
    }

    if let Ok(mut g) = PIDS.lock() {
        g.get_or_insert_with(HashMap::new).insert(surface.clone(), pid);
    }
    trace(&format!("open  spawned  surface={surface} pid={pid}"));

    // Supervision, deliberately thin: no respawn. A player that died has a
    // reason the user needs to see (decision 8 — plain-English panel + retry,
    // never a silent fallback to the 91 s convert lane), so report the exit and
    // let the UI decide. An exit we caused (close, or a newer open on the same
    // surface) has already dropped the pid entry, and reports nothing.
    let app2 = app.clone();
    let surface2 = surface.clone();
    tokio::spawn(async move {
        let status = child.wait().await.ok();
        let ours = PIDS
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().and_then(|m| m.remove(&surface2)))
            == Some(pid);
        if !ours {
            return;
        }
        drop_conn(&surface2);
        let code = status.and_then(|s| s.code()).unwrap_or(-1);
        let _ = app2.emit(
            "player-exit",
            serde_json::json!({
                "surface": surface2,
                "code": code,
                "log": log_path().map(|p| p.to_string_lossy().into_owned()),
            }),
        );
    });

    let (ctx, crx) = tokio::sync::mpsc::unbounded_channel::<Request>();
    if let Ok(mut g) = CONNS.lock() {
        g.get_or_insert_with(HashMap::new).insert(surface.clone(), ctx);
    }
    tokio::spawn(ipc_actor(pipe.clone(), crx));

    Ok(PlayerHandle { hwnd, pid, pipe })
}

// ---------------------------------------------------------------------------
// Control lane — mpv's JSON IPC over a per-surface named pipe
// ---------------------------------------------------------------------------

/// The pipe does not exist the instant mpv is spawned; it appears once mpv has
/// set up its input layer. Retry rather than fail — a first seek arriving 40 ms
/// before the pipe opens must not surface as "the player is not responding".
const CONNECT_TRIES: u32 = 200;
const CONNECT_GAP_MS: u64 = 25;

/// Own one surface's pipe for the life of its mpv: write every request, read
/// every reply, hand each reply back to whoever is waiting on that request_id.
///
/// mpv answers `{"error":"success","data":…,"request_id":N}` and interleaves
/// unsolicited `{"event":…}` lines, so replies must be matched by id, never by
/// arrival order.
async fn ipc_actor(pipe: String, mut rx: tokio::sync::mpsc::UnboundedReceiver<Request>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut client = None;
    for _ in 0..CONNECT_TRIES {
        match ClientOptions::new().open(&pipe) {
            Ok(c) => {
                client = Some(c);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(CONNECT_GAP_MS)).await,
        }
    }
    let Some(client) = client else {
        // Fail every caller loudly rather than hanging them forever.
        while let Some((_, tx)) = rx.recv().await {
            let _ = tx.send(Err(format!("could not reach the video player ({pipe})")));
        }
        return;
    };

    let (rd, mut wr) = tokio::io::split(client);
    let pending: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let pending_rd = pending.clone();
    let reader = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(rd).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            let Some(id) = v.get("request_id").and_then(|i| i.as_u64()) else { continue };
            let waiting = pending_rd.lock().ok().and_then(|mut m| m.remove(&id));
            if let Some(tx) = waiting {
                let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("success");
                let _ = tx.send(if err == "success" {
                    Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
                } else {
                    Err(err.to_string())
                });
            }
        }
        // Pipe closed (mpv gone): release everyone still waiting.
        if let Ok(mut m) = pending_rd.lock() {
            for (_, tx) in m.drain() {
                let _ = tx.send(Err("the video player closed".into()));
            }
        }
    });

    while let Some((mut req, tx)) = rx.recv().await {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        if let Some(o) = req.as_object_mut() {
            o.insert("request_id".into(), serde_json::json!(id));
        }
        if let Ok(mut m) = pending.lock() {
            m.insert(id, tx);
        }
        let mut line = req.to_string();
        line.push('\n');
        if wr.write_all(line.as_bytes()).await.is_err() {
            if let Ok(mut m) = pending.lock() {
                if let Some(tx) = m.remove(&id) {
                    let _ = tx.send(Err("the video player stopped listening".into()));
                }
            }
            break;
        }
    }
    reader.abort();
}

/// Drop a surface's IPC actor. The actor's `recv` ends, its reader is aborted,
/// and the pipe handle closes with it.
fn drop_conn(surface: &str) {
    if let Ok(mut g) = CONNS.lock() {
        if let Some(m) = g.as_mut() {
            m.remove(surface);
        }
    }
}

/// Send one mpv command array and wait for its reply.
///
/// Deliberately generic: mpv's whole control surface is `["set_property", …]`,
/// `["get_property", …]`, `["seek", …]`, `["cycle", …]`. Ten narrow commands
/// would be ten things to keep in sync with a protocol that already has names.
#[tauri::command]
pub async fn player_command(
    surface: String,
    args: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let tx = CONNS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(&surface).cloned()))
        .ok_or_else(|| format!("no video player open on {surface}"))?;
    let (rtx, rrx) = tokio::sync::oneshot::channel();
    tx.send((serde_json::json!({ "command": args }), rtx))
        .map_err(|_| "the video player is no longer running".to_string())?;
    // A reply that never comes must not wedge the UI forever.
    match tokio::time::timeout(std::time::Duration::from_secs(5), rrx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("the video player dropped the request".into()),
        Err(_) => Err("the video player did not answer in time".into()),
    }
}

// ---------------------------------------------------------------------------
// Controls layer — a see-through window ABOVE the picture
// ---------------------------------------------------------------------------
//
// FIRST ATTEMPT, AND WHY IT IS GONE: a transparent child webview added to the
// main window with `Window::add_child`. It composited beautifully — and cut its
// own height out of the video. Measured 2026-08-23: a 44px bar left 410px of a
// 450px picture, an 82px bar left 368px; 410+44 = 368+82 = 450 exactly. A
// webview's DirectComposition surface hides a plain sibling child window across
// its WHOLE rect, transparent pixels included, so controls could never float
// over the picture that way — they could only be cut out of it.
//
// A borderless transparent TOP-LEVEL window composites through the desktop
// compositor instead, which does stack correctly over another window's child
// HWND. The app already ships two of these (`overlay-host`, `overlay-toast`),
// so this is that proven shape reused, not new machinery.
//
// Coordinates: callers pass the picture's LOGICAL rect in the main window's
// CLIENT space — the same rect they give `ensure`. A top-level window needs
// SCREEN coordinates, so this module converts once, here, against the main
// window's live inner position and scale factor. Nothing else may restate it.

fn controls_label(surface: &str) -> String {
    format!("player-controls-{surface}")
}

/// Logical client rect → screen rect, against the main window's LIVE geometry.
/// The one place that conversion happens; `inner_position`, not `outer`, since
/// the caller's rect is client-relative and the difference is the title bar.
fn to_screen(app: &AppHandle, x: f64, y: f64, w: f64, h: f64)
    -> Result<(PhysicalPosition<i32>, PhysicalSize<u32>), String>
{
    let main = app.get_window("main").ok_or("no main window")?;
    let sf = main.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    let origin = main.inner_position().map_err(|e| format!("inner_position: {e}"))?;
    Ok((
        PhysicalPosition::new(
            origin.x + (x * sf).round() as i32,
            origin.y + (y * sf).round() as i32,
        ),
        PhysicalSize::new(((w * sf).round() as u32).max(1), ((h * sf).round() as u32).max(1)),
    ))
}

/// Re-place every live controls window from its stored rect. Called whenever the
/// app window moves or resizes — the controls must not be told where to go by
/// anyone who is only guessing; they are recomputed from the app's real position
/// every time.
fn reflow_controls(app: &AppHandle) {
    let entries: Vec<(String, String)> = CONTROLS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
        .unwrap_or_default();
    for (surface, label) in entries {
        let rect = RECTS
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|m| m.get(&surface).copied()));
        let (Some((x, y, w, h)), Some(win)) = (rect, app.get_webview_window(&label)) else { continue };
        if let Ok((pos, size)) = to_screen(app, x, y, w, h) {
            let _ = win.set_position(pos);
            let _ = win.set_size(size);
        }
    }
}

/// Show or hide every live controls window. An always-on-top window that keeps
/// floating once the app is behind something else is a bug, not a feature.
/// Re-apply `WS_EX_NOACTIVATE`. MUST be called AFTER every `show()`.
///
/// NEVER take focus. A normal window steals activation the moment it is created
/// or clicked, which blurs the main window — and the controls hide with the app,
/// so using a control hid the controls. Worse, the two events disagree: measured
/// 2026-08-23, the controls window reported `focused=true` in its event while
/// `is_focused()` said false 176 ms later, so nothing that ASKS about focus can
/// arbitrate this. With the flag the window still receives every mouse message,
/// it just never becomes active; keyboard input keeps going to the app, which is
/// where the player's shortcuts already live.
///
/// AFTER, not before: showing a window rewrites `GWL_EXSTYLE` wholesale from the
/// toolkit's own flag model, so a style applied between `build()` and `show()` is
/// erased with no error. Measured 2026-09-06 — the live controls window read
/// ex=0x40118, the NOACTIVATE bit (0x08000000) absent, and it was the foreground
/// window. That is why this lives in a function: every `show()` site needs it.
fn no_activate(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
        }
    }
}

fn set_controls_visible(app: &AppHandle, visible: bool) {
    let labels: Vec<String> = CONTROLS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|m| m.values().cloned().collect()))
        .unwrap_or_default();
    trace(&format!("vis   set      visible={visible} windows={}", labels.len()));
    for label in labels {
        match app.get_webview_window(&label) {
            Some(win) => {
                let r = if visible { win.show() } else { win.hide() };
                if visible {
                    no_activate(&win);
                }
                trace(&format!("vis   {label} ok={}", r.is_ok()));
            }
            None => trace(&format!("vis   {label} NO SUCH WINDOW")),
        }
    }
}

/// Wire the controls windows to the app window, once. Window events arrive on
/// the main thread, which is where every placement call has to happen anyway.
///
/// Move and resize only. Nothing here reacts to focus — see the note above
/// `player_controls_attach` for why focus is not tracked at all. Registered
/// lazily behind a `Once` whose body starts with `let Some(main) = … else
/// { return }`: one missed lookup spends the `Once` for the life of the process
/// and the handler is then never registered at all. Measured 2026-08-23: the
/// controls window stayed hidden through every focus change, while
/// `player_bounds` proved the CONTROLS map was intact the whole time.
fn ensure_follow(app: &AppHandle) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let Some(main) = app.get_window("main") else { return };
        let app = app.clone();
        main.on_window_event(move |ev| match ev {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => reflow_controls(&app),
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                set_controls_visible(&app, false)
            }
            _ => {}
        });
    });
}

/// FOCUS IS NOT TRACKED. There used to be an `on_focus_change` here that hid
/// the controls whenever the app blurred, because an `always_on_top` layer left
/// up would float over whatever the user switched to. The layer is OWNED by main
/// now (see `player_controls_attach`), so the window manager already keeps it
/// above this app and below every other one, and it hides and minimises with its
/// owner for free — the hide had nothing left to prevent and two ways to fail:
///
/// - mpv takes the foreground when it spawns, so the "is the front window still
///   ours" test read a foreign pid and put the bar away 650 ms into playback
///   (measured 2026-09-06).
/// - WS_EX_NOACTIVATE means clicking the bar can never re-focus main, so once
///   the bar was hidden NOTHING on the player could bring it back. That is the
///   dead-controls bug, and no amount of tuning the test fixes it: the test is
///   the wrong question now.
///
/// `set_controls_visible` survives for teardown (`ensure_follow`'s close path).
/// Attach (or move) the controls window over `surface`'s picture rect.
#[tauri::command]
pub async fn player_controls_attach(
    app: AppHandle,
    surface: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<String, String> {
    // Window creation is a main-thread affair: the platform pumps it on the UI
    // message loop, and a command worker calling it would wait forever.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send((|| -> Result<String, String> {
            let label = controls_label(&surface);
            if let Ok(mut g) = RECTS.lock() {
                g.get_or_insert_with(HashMap::new).insert(surface.clone(), (x, y, w, h));
            }
            let (pos, size) = to_screen(&app2, x, y, w, h)?;

            if let Some(win) = app2.get_webview_window(&label) {
                win.set_position(pos).map_err(|e| format!("controls position: {e}"))?;
                win.set_size(size).map_err(|e| format!("controls size: {e}"))?;
                let _ = win.show();
                no_activate(&win);
                return Ok(label);
            }

            // The owner, looked up before the builder so a missing main window is
            // an error here rather than a silently un-owned floating layer.
            let main = app2
                .get_webview_window("main")
                .ok_or_else(|| "controls: no main window to own the layer".to_string())?;

            let win = WebviewWindowBuilder::new(
                &app2,
                &label,
                WebviewUrl::App(format!("index.html#/player/controls?surface={surface}").into()),
            )
            // Named so window enumeration can tell it apart. Left at the default
            // it reports as "Tauri App", and any script picking the app by
            // window name grabs the controls layer instead of the app.
            .title(format!("Mortar & Pestle Player Controls ({surface})"))
            // The whole point: everything the page does not paint shows the
            // picture behind it, not a background colour.
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            // OWNED BY MAIN, never always-on-top. An owned window is kept above
            // its owner AND the owner's children — so above the mpv picture,
            // which is what this needs — and BELOW every other application,
            // which is the whole difference. `always_on_top(true)` floated this
            // transparent, click-eating layer over File Explorer and everything
            // else: the other app looked like it was in front while every click
            // aimed at it landed here instead. Measured 2026-09-06 — ex=0x40118
            // (TOPMOST set) on a window stacked over a foreign window, and the
            // app's own hide-on-blur could not save it. Ownership is the window
            // manager's own answer to "above mine, below theirs" and needs no
            // focus bookkeeping at all.
            .owner(&main)
            .map_err(|e| format!("owner(controls): {e}"))?
            // Never steal activation at creation. Without this the new window
            // takes focus, the MAIN window blurs, and the blur handler hides the
            // controls the instant they were built — the app is then focused
            // with no controls and nothing to bring them back. WS_EX_NOACTIVATE
            // is applied after every show() as well — see `no_activate`.
            .focused(false)
            // Placed before it is shown, so it never flashes at the origin.
            .visible(false)
            .build()
            .map_err(|e| format!("build(controls): {e}"))?;
            win.set_position(pos).map_err(|e| format!("controls position: {e}"))?;
            win.set_size(size).map_err(|e| format!("controls size: {e}"))?;
            let _ = win.show();
            no_activate(&win);
            if let Ok(mut g) = CONTROLS.lock() {
                g.get_or_insert_with(HashMap::new).insert(surface.clone(), label.clone());
            }
            ensure_follow(&app2);
            Ok(label)
        })());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "player_controls_attach task dropped".to_string())?
}

/// Tear the controls window down. Idempotent — a surface with none is fine.
pub fn controls_detach(app: &AppHandle, surface: &str) {
    let label = CONTROLS
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().and_then(|m| m.remove(surface)));
    if let Some(label) = label {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
    }
    if let Ok(mut g) = RECTS.lock() {
        if let Some(m) = g.as_mut() {
            m.remove(surface);
        }
    }
}

#[tauri::command]
pub async fn player_bounds(app: AppHandle, surface: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    // The controls layer is glued to the picture, never tracked separately —
    // two rects kept in step by hand drift apart on the first missed event.
    if CONTROLS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|m| m.contains_key(&surface)))
        .unwrap_or(false)
    {
        player_controls_attach(app.clone(), surface.clone(), x, y, w, h).await?;
    }
    set_bounds(&app, surface, x, y, w, h).await
}

#[tauri::command]
pub async fn player_close(app: AppHandle, surface: String) -> Result<(), String> {
    trace(&format!("close request surface={surface}"));
    let _guard = OPEN_LOCK.lock().await;
    trace(&format!("close lock     surface={surface}"));
    controls_detach(&app, &surface);
    let r = destroy(&app, surface.clone()).await;
    trace(&format!("close done     surface={surface} ok={}", r.is_ok()));
    r
}
