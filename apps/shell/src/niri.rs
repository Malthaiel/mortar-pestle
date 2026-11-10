//! niri: what its own config says, so the shell matches the windows, and its
//! windows and workspaces, read live from its socket.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::{LazyLock, Mutex};
use std::thread;

use iced::Subscription;
use iced::futures::channel::mpsc;
use serde_json::Value;

/// A window as niri reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub id: u64,
    pub title: String,
    pub app_id: String,
    pub workspace: Option<u64>,
}

/// A workspace as niri reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Workspace {
    pub id: u64,
    pub idx: u64,
    pub output: String,
    pub active: bool,
    /// The window last used on it (niri's `active_window_id`).
    pub active_window: Option<u64>,
}

/// niri's windows (in opening order: niri's ids only grow) and workspaces.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Desktop {
    pub windows: Vec<Window>,
    pub workspaces: Vec<Workspace>,
}

impl Desktop {
    /// What the bar draws: the workspaces, and which one each window is on (no
    /// titles since the window name left the bar, Noctalia Look step 2).
    fn strip(&self) -> (Vec<(u64, Option<u64>)>, &[Workspace]) {
        (self.windows.iter().map(|w| (w.id, w.workspace)).collect(), &self.workspaces)
    }
}

/// The latest `Desktop`, kept by the reader thread; the strip reads it when it draws.
pub static DESKTOP: Mutex<Desktop> = Mutex::new(Desktop { windows: Vec::new(), workspaces: Vec::new() });

pub fn desktop() -> Desktop {
    DESKTOP.lock().unwrap().clone()
}

fn connect() -> std::io::Result<UnixStream> {
    UnixStream::connect(std::env::var_os("NIRI_SOCKET").ok_or(std::io::ErrorKind::NotFound)?)
}

/// Fires whenever `DESKTOP` changes in a way the strip draws (foot's title spinner
/// sends about one title change a second while Claude works, measured
/// 2026-10-29: only a shown active window's could wake it, and `drawable` leaves
/// the spinner out). A thread waits on niri's
/// event stream (one JSON event per line, niri-ipc's documented protocol), so
/// nothing runs between events.
pub fn events() -> Subscription<()> {
    Subscription::run(|| {
        let (mut tx, rx) = mpsc::channel(1);
        thread::spawn(move || {
            let stream = match connect().and_then(|mut s| s.write_all(b"\"EventStream\"\n").map(|()| s)) {
                Ok(s) => s,
                Err(e) => return eprintln!("mp-shell: niri socket: {e}"),
            };
            let mut sent = Desktop::default();
            // niri's reply ({"Ok":"Handled"}) comes first; `apply` skips it.
            for line in BufReader::new(stream).lines() {
                let Ok(event) = line.map(|l| serde_json::from_str::<Value>(&l).unwrap_or_default()) else { break };
                let mut d = DESKTOP.lock().unwrap();
                apply(&mut d, &event);
                if d.strip() != sent.strip() {
                    sent = d.clone();
                    drop(d);
                    let _ = tx.try_send(());
                }
            }
            eprintln!("mp-shell: niri event stream ended");
        });
        rx
    })
}

/// A title as the strip can draw it. Ioskeley Mono is the shell's only font (its service
/// hides the system's), so letters it has no shape for (Claude's spinner, emoji,
/// Japanese) would draw as boxes: they are left out (his pick 2026-10-30), and the
/// spaces round them close up. A spinner turning then changes nothing drawn.
fn drawable(title: &str) -> String {
    static FACE: LazyLock<ttf_parser::Face<'static>> = LazyLock::new(|| ttf_parser::Face::parse(crate::FONT_TTF, 0).expect("bundled font"));
    let kept: String = title.chars().filter(|&c| c.is_whitespace() || FACE.glyph_index(c).is_some()).collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn window(w: &Value) -> Window {
    Window { id: w["id"].as_u64().unwrap_or(0), title: drawable(w["title"].as_str().unwrap_or("")), app_id: w["app_id"].as_str().unwrap_or("").into(), workspace: w["workspace_id"].as_u64() }
}

fn workspace(w: &Value) -> Workspace {
    Workspace { id: w["id"].as_u64().unwrap_or(0), idx: w["idx"].as_u64().unwrap_or(0), output: w["output"].as_str().unwrap_or("").into(), active: w["is_active"].as_bool().unwrap_or(false), active_window: w["active_window_id"].as_u64() }
}

/// Folds one event in; events the strip doesn't use are skipped, so a newer
/// niri's new events change nothing.
fn apply(d: &mut Desktop, event: &Value) {
    let Some((name, e)) = event.as_object().and_then(|o| o.iter().next()) else { return };
    let list = |v: &Value| v.as_array().cloned().unwrap_or_default();
    match name.as_str() {
        "WorkspacesChanged" => {
            d.workspaces = list(&e["workspaces"]).iter().map(workspace).collect();
            d.workspaces.sort_by_key(|w| w.idx);
        }
        "WorkspaceActivated" => {
            let id = e["id"].as_u64();
            if let Some(output) = d.workspaces.iter().find(|w| Some(w.id) == id).map(|w| w.output.clone()) {
                for w in d.workspaces.iter_mut().filter(|w| w.output == output) {
                    w.active = Some(w.id) == id;
                }
            }
        }
        "WindowsChanged" => {
            d.windows = list(&e["windows"]).iter().map(window).collect();
            d.windows.sort_by_key(|w| w.id);
        }
        "WorkspaceActiveWindowChanged" => {
            if let Some(w) = d.workspaces.iter_mut().find(|w| Some(w.id) == e["workspace_id"].as_u64()) {
                w.active_window = e["active_window_id"].as_u64();
            }
        }
        "WindowOpenedOrChanged" => {
            let w = window(&e["window"]);
            match d.windows.binary_search_by_key(&w.id, |o| o.id) {
                Ok(i) => d.windows[i] = w,
                Err(i) => d.windows.insert(i, w),
            }
        }
        "WindowClosed" => d.windows.retain(|w| Some(w.id) != e["id"].as_u64()),
        _ => {}
    }
}

/// Whether a screen's current workspace shows a full-screen window (Caelestia's
/// `Notifs.hasFullscreen`, a notice's shorter time). niri 26.04 reports no
/// full-screen flag, so: a window exactly its screen's size. Asked on demand, on the
/// caller's thread (two requests on a connection of their own).
pub fn fullscreen() -> bool {
    let (Some(outputs), Some(windows)) = (ask("Outputs"), ask("Windows")) else { return false };
    let d = desktop();
    windows.as_array().into_iter().flatten().any(|w| {
        let Some(ws) = d.workspaces.iter().find(|ws| ws.active && Some(ws.id) == w["workspace_id"].as_u64()) else { return false };
        let (screen, size) = (&outputs[&ws.output]["logical"], &w["layout"]["window_size"]);
        size[0].as_u64().is_some_and(|x| Some(x) == screen["width"].as_u64()) && size[1].as_u64().is_some_and(|y| Some(y) == screen["height"].as_u64())
    })
}

/// niri's active screen by name (`DP-1`): the mouse's, by focus-follows-mouse. Asked on
/// the caller's thread.
pub fn focused_output() -> Option<String> {
    ask("FocusedOutput")?["name"].as_str().map(String::from)
}

/// niri's focused window's id (the keyboard's), asked on the caller's thread: a
/// capture pop-up reads it as it opens, since its own keyboard hold may change it.
pub fn focused_window() -> Option<u64> {
    ask("FocusedWindow")?["id"].as_u64()
}

/// One request (`"Outputs"`) on a connection of its own, on the caller's thread.
fn ask(what: &str) -> Option<Value> {
    let mut s = connect().ok()?;
    s.write_all(format!("\"{what}\"\n").as_bytes()).ok()?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).ok()?;
    let mut reply: Value = serde_json::from_str(&line).ok()?;
    Some(reply["Ok"][what].take())
}

/// niri's screens by name (`DP-1`): its model (`LG ULTRAGEAR+`) and its size in
/// logical pixels; asked on the caller's thread.
pub fn screens() -> Vec<(String, String, u64)> {
    let Some(Value::Object(outputs)) = ask("Outputs") else { return Vec::new() };
    let mut out: Vec<(String, String, u64)> = outputs
        .iter()
        .map(|(name, o)| {
            let size = |k: &str| o["logical"][k].as_u64().unwrap_or(0);
            (name.clone(), o["model"].as_str().unwrap_or(name).trim().to_string(), size("width") * size("height"))
        })
        .collect();
    out.sort();
    out
}

/// Asks niri to do something (`{"FocusWindow":{"id":3}}`) on its own connection:
/// the event stream's takes no more requests. Off the drawing thread.
pub fn act(action: Value) {
    thread::spawn(move || {
        let request = serde_json::json!({ "Action": action }).to_string() + "\n";
        let mut reply = String::new();
        if let Err(e) = connect().and_then(|mut s| {
            s.write_all(request.as_bytes())?;
            BufReader::new(s).read_line(&mut reply)
        }) {
            eprintln!("mp-shell: niri action: {e}");
        }
    });
}
