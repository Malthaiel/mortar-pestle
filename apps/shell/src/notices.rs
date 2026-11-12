//! Notices (M&P Shell plan, step 2): the desktop's notice server
//! (`org.freedesktop.Notifications`, spec 1.3) with Caelestia's rules
//! (caelestia-dots/shell @bcbb5d5 `services/Notifs.qml` + `NotifData.qml`): every
//! notice goes into the list (the side panel's, step 6) and pops up in the top-right
//! corner of every screen (`popups.rs`), unless do not disturb is on or the side
//! panel is open. A pop-up leaves after its time (the sender's, else 5 s, 2 s over a
//! full-screen window), held while the pointer is on it; leaving, or swiped away, it
//! stays in the list; a middle click or its X takes it out. The last 100 are kept in
//! `$XDG_STATE_HOME/mp-shell/notices/` (his pick 2026-11-03: Windows' cap).
//!
//! One bus connection on its own thread, as `mpris.rs`: zbus 6 inside `block_on`;
//! only the bus and our own replies (a notice closed, a button pressed) wake it.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iced::Subscription;
use iced::futures::StreamExt;
use iced::futures::channel::mpsc;
use iced::time::Instant;
use iced::widget::image;
use serde_json::{Value, json};
use zbus::OwnedVariant;
use zbus::object_server::SignalEmitter;

const NAME: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
/// Kept after a restart (Windows' `CAP`).
const KEEP: usize = 100;
/// A pop-up's time when the sender leaves it to us (Caelestia `defaultExpireTimeout`,
/// his pick 2026-11-03), and over a full-screen window (`fullscreenExpireTimeout`).
const TIME: Duration = Duration::from_millis(5000);
const FULLSCREEN_TIME: Duration = Duration::from_millis(2000);
/// The sender's picture, cut round (the rulebook's control height; Caelestia's 42 is
/// off the table), and the program's beside it or alone (the icon sizes).
pub const PICTURE: u32 = mp_ui::style::CONTROL as u32;
pub const BADGE_ICON: u32 = mp_ui::style::ICON_SM;
pub const ALONE_ICON: u32 = mp_ui::style::ICON;

#[derive(Debug, Clone)]
pub struct Notice {
    pub id: u32,
    pub app: String,
    pub summary: String,
    pub body: String,
    /// Each button: the key told back to the sender, and its label.
    pub actions: Vec<(String, String)>,
    pub critical: bool,
    /// Kept after a button is pressed (the `resident` hint).
    resident: bool,
    /// Not kept once its pop-up leaves (the `transient` hint).
    transient: bool,
    /// When it came, seconds since 1970.
    pub at: u64,
    /// The sender's picture is saved (`<id>.png`).
    picture: bool,
    /// The program's picture: the icon theme's file.
    icon: Option<PathBuf>,
    pub read: bool,
    /// Showing in the corner.
    pub popup: bool,
    /// How long it pops up; none = until it is closed (the sender's 0, spec).
    time: Option<Duration>,
    /// When its pop-up leaves; none while held (the pointer on it).
    pub until: Option<Instant>,
    /// Its pictures while it pops up: the sender's, and the program's (a badge on
    /// the sender's, or alone at `ALONE_ICON`).
    pub face: Option<image::Handle>,
    pub badge: Option<image::Handle>,
}

/// Newest first.
static LIST: Mutex<Vec<Notice>> = Mutex::new(Vec::new());
static NEXT: AtomicU32 = AtomicU32::new(1);
/// Do not disturb (step 6's switch), and the side panel open: no pop-ups then.
static QUIET: AtomicBool = AtomicBool::new(false);
static PANEL: AtomicBool = AtomicBool::new(false);
static WAKE: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);
static OUT: Mutex<Option<mpsc::UnboundedSender<Out>>> = Mutex::new(None);

/// What we tell the senders.
enum Out {
    /// Its id, and why: 1 its time ran out, 2 the person closed it, 3 the sender
    /// asked, 4 otherwise (spec).
    Closed(u32, u32),
    Invoked(u32, String),
}

fn wake() {
    if let Some(tx) = WAKE.lock().unwrap().as_mut() {
        let _ = tx.try_send(());
    }
}

fn tell(out: Out) {
    if let Some(tx) = OUT.lock().unwrap().as_ref() {
        let _ = tx.unbounded_send(out);
    }
}

/// The ones popping up, newest first.
pub fn popups() -> Vec<Notice> {
    LIST.lock().unwrap().iter().filter(|n| n.popup).cloned().collect()
}

/// Every kept notice, newest first (the side panel's list).
pub fn list() -> Vec<Notice> {
    LIST.lock().unwrap().clone()
}

/// The side panel opened or closed. Open, nothing pops up, every pop-up leaves the
/// corner (Caelestia's `NotifDock`: `popup = false` for all) and all are read
/// (Windows' `markAllRead`).
pub fn panel(open: bool) {
    PANEL.store(open, Relaxed);
    if !open {
        return;
    }
    let mut list = LIST.lock().unwrap();
    for n in list.iter_mut() {
        n.read = true;
        n.popup = false;
        (n.face, n.badge, n.until) = (None, None, None);
    }
    let gone: Vec<u32> = list.iter().filter(|n| n.transient).map(|n| n.id).collect();
    list.retain(|n| !n.transient);
    drop(list);
    for id in gone {
        tell(Out::Closed(id, 1));
    }
    save();
    wake();
}

/// Do not disturb (the side panel's switch): kept after a restart as a file that is
/// there while it is on.
pub fn quiet() -> bool {
    QUIET.load(Relaxed)
}

pub fn set_quiet(on: bool) {
    QUIET.store(on, Relaxed);
    let file = crate::apps::state("quiet");
    let done = if on { fs::create_dir_all(folder()).and_then(|()| fs::write(&file, "")) } else { fs::remove_file(&file).or(Ok(())) };
    if let Err(e) = done {
        eprintln!("mp-shell: notices: {}: {e}", file.display());
    }
}

/// Each program's pictures for the side panel's groups: the newest saved sender's
/// picture, and the program's (a badge on it, or alone). `drawn` keeps the program
/// pictures made while the panel shows, so each is drawn once.
pub fn group_pictures(list: &[Notice], drawn: &mut HashMap<(PathBuf, u32), image::Handle>) -> HashMap<String, (Option<image::Handle>, Option<image::Handle>)> {
    let mut out = HashMap::new();
    for n in list {
        if out.contains_key(&n.app) {
            continue;
        }
        let mine = || list.iter().filter(|m| m.app == n.app);
        let face = mine().find(|m| m.picture).map(|m| image::Handle::from_path(picture_file(m.id)));
        let side = if face.is_some() { BADGE_ICON } else { ALONE_ICON };
        let icon = mine().find_map(|m| m.icon.clone()).and_then(|path| {
            let key = (path, side);
            if !drawn.contains_key(&key) {
                drawn.insert(key.clone(), crate::apps::draw(&key.0, side)?);
            }
            drawn.get(&key).cloned()
        });
        out.insert(n.app.clone(), (face, icon));
    }
    out
}

/// Closes many at once (the side panel's group and clear-all), told and saved once.
pub fn dismiss_all(ids: &[u32]) {
    let gone: Vec<u32> = ids.iter().copied().filter(|&id| take(id)).collect();
    if gone.is_empty() {
        return;
    }
    for id in gone {
        tell(Out::Closed(id, 2));
    }
    save();
    wake();
}

/// The pointer came onto a pop-up (its time stops) or left it (its time starts again
/// from the top, as Caelestia's `timer.start()`).
pub fn hold(id: u32, on: bool) {
    let mut list = LIST.lock().unwrap();
    if let Some(n) = list.iter_mut().find(|n| n.id == id && n.popup) {
        n.until = if on { None } else { n.time.map(|t| Instant::now() + t) };
    }
    drop(list);
    wake();
}

/// A pop-up's time ran out, or it was swiped away: it leaves the corner and stays in
/// the list (Caelestia's `popup = false`); a transient one goes.
pub fn popdown(id: u32) {
    let mut list = LIST.lock().unwrap();
    let Some(i) = list.iter().position(|n| n.id == id && n.popup) else { return };
    let n = &mut list[i];
    n.popup = false;
    (n.face, n.badge) = (None, None);
    if n.transient {
        list.remove(i);
        drop(list);
        tell(Out::Closed(id, 1));
    } else {
        drop(list);
    }
    wake();
}

/// Its X or a middle click: out of the list (Caelestia's `close()`).
pub fn dismiss(id: u32) {
    if take(id) {
        tell(Out::Closed(id, 2));
        save();
        wake();
    }
}

/// One of its buttons: told to the sender, then the notice goes unless it is resident
/// (spec: "the server closes it" otherwise).
pub fn invoke(id: u32, key: String) {
    let resident = LIST.lock().unwrap().iter().find(|n| n.id == id).is_some_and(|n| n.resident);
    tell(Out::Invoked(id, key));
    if !resident {
        dismiss(id);
    }
}

/// Takes it out of the list and its picture off the disk.
fn take(id: u32) -> bool {
    let mut list = LIST.lock().unwrap();
    let Some(i) = list.iter().position(|n| n.id == id) else { return false };
    let n = list.remove(i);
    drop(list);
    if n.picture {
        let _ = fs::remove_file(picture_file(id));
    }
    true
}

fn folder() -> PathBuf {
    crate::apps::state("notices")
}

fn picture_file(id: u32) -> PathBuf {
    folder().join(format!("{id}.png"))
}

/// The list as a small JSON file (no pictures, no buttons: a sender's buttons die
/// with its run), written whole each change: one notice is a few hundred bytes.
fn save() {
    let list = LIST.lock().unwrap();
    let kept: Vec<Value> = list
        .iter()
        .filter(|n| !n.transient)
        .map(|n| {
            json!({ "id": n.id, "app": n.app, "summary": n.summary, "body": n.body, "critical": n.critical, "at": n.at,
                "picture": n.picture, "icon": n.icon.as_ref().map(|p| p.to_string_lossy()), "read": n.read })
        })
        .collect();
    drop(list);
    let file = folder().join("list.json");
    let new = file.with_extension("json.new");
    let written = fs::create_dir_all(folder()).and_then(|()| fs::write(&new, Value::Array(kept).to_string())).and_then(|()| fs::rename(&new, &file));
    if let Err(e) = written {
        eprintln!("mp-shell: notices: {}: {e}", file.display());
    }
}

fn load() {
    QUIET.store(crate::apps::state("quiet").exists(), Relaxed);
    let Ok(text) = fs::read_to_string(folder().join("list.json")) else { return };
    let Ok(Value::Array(saved)) = serde_json::from_str::<Value>(&text) else { return };
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let list: Vec<Notice> = saved
        .iter()
        .map(|v| Notice {
            id: v["id"].as_u64().unwrap_or(0) as u32,
            app: s(&v["app"]),
            summary: s(&v["summary"]),
            body: s(&v["body"]),
            actions: Vec::new(),
            critical: v["critical"].as_bool().unwrap_or(false),
            resident: false,
            transient: false,
            at: v["at"].as_u64().unwrap_or(0),
            picture: v["picture"].as_bool().unwrap_or(false),
            icon: v["icon"].as_str().map(PathBuf::from),
            read: v["read"].as_bool().unwrap_or(true),
            popup: false,
            time: Some(TIME),
            until: None,
            face: None,
            badge: None,
        })
        .filter(|n| n.id != 0)
        .collect();
    NEXT.store(list.iter().map(|n| n.id).max().unwrap_or(0) + 1, Relaxed);
    *LIST.lock().unwrap() = list;
}

/// Wakes the shell whenever the pop-ups change.
pub fn events() -> Subscription<()> {
    Subscription::run(|| {
        let (tx, rx) = mpsc::channel(1);
        *WAKE.lock().unwrap() = Some(tx);
        thread::spawn(|| {
            if let Err(e) = zbus::block_on(run()) {
                eprintln!("mp-shell: notices: {e}");
            }
        });
        rx
    })
}

async fn run() -> zbus::Result<()> {
    load();
    let (tx, mut rx) = mpsc::unbounded();
    *OUT.lock().unwrap() = Some(tx);
    // The strip takes the name back from any other notice server, and nothing takes
    // it from the strip (zbus's default lets it be taken; found 2026-11-03).
    let conn = zbus::connection::Builder::session().allow_name_replacements(false).serve_at(PATH, Server).name(NAME).build().await?;
    let emitter = SignalEmitter::new(&conn, PATH)?;
    while let Some(out) = rx.next().await {
        let sent = match out {
            Out::Closed(id, why) => Server::notification_closed(&emitter, id, why).await,
            Out::Invoked(id, key) => Server::action_invoked(&emitter, id, &key).await,
        };
        if let Err(e) = sent {
            eprintln!("mp-shell: notices: {e}");
        }
    }
    Ok(())
}

struct Server;

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Server {
    /// What we draw: buttons, the body (as plain text: markup is taken out, as we
    /// don't say `body-markup`), and a kept list.
    fn get_capabilities(&self) -> Vec<&'static str> {
        vec!["actions", "body", "persistence"]
    }

    #[allow(clippy::too_many_arguments)]
    fn notify(&self, app_name: String, replaces_id: u32, app_icon: String, summary: String, body: String, actions: Vec<String>, hints: HashMap<String, OwnedVariant>, expire_timeout: i32) -> u32 {
        add(app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout)
    }

    fn close_notification(&self, id: u32) {
        if take(id) {
            tell(Out::Closed(id, 3));
            save();
            wake();
        }
    }

    fn get_server_information(&self) -> (&'static str, &'static str, &'static str, &'static str) {
        ("mp-shell", "Mortar & Pestle", env!("CARGO_PKG_VERSION"), "1.3")
    }

    #[zbus(signal)]
    async fn notification_closed(emitter: &SignalEmitter<'_>, id: u32, reason: u32) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn action_invoked(emitter: &SignalEmitter<'_>, id: u32, action_key: &str) -> zbus::Result<()>;
}

fn hint<T: TryFrom<OwnedVariant>>(hints: &HashMap<String, OwnedVariant>, keys: &[&str]) -> Option<T> {
    keys.iter().find_map(|k| hints.get(*k)?.try_clone().ok()?.try_into().ok())
}

/// A notice of the shell's own (a clip saved), as any program's.
pub fn post(app: &str, summary: &str, body: &str) {
    add(app.into(), 0, String::new(), summary.into(), body.into(), Vec::new(), HashMap::new(), -1);
}

#[allow(clippy::too_many_arguments)]
fn add(app: String, replaces: u32, app_icon: String, summary: String, body: String, actions: Vec<String>, hints: HashMap<String, OwnedVariant>, timeout: i32) -> u32 {
    let mut list = LIST.lock().unwrap();
    let old = list.iter().position(|n| replaces != 0 && n.id == replaces);
    drop(list);
    let id = if old.is_some() { replaces } else { NEXT.fetch_add(1, Relaxed) };

    // The sender's picture: `image-data`, else `image-path` (a file), cut round once
    // and kept as a small PNG (Caelestia's image cache); a path that isn't a picture
    // file is an icon name, as the spec allows: the program's picture then.
    let raw: Option<(i32, i32, i32, bool, i32, i32, Vec<u8>)> = hint(&hints, &["image-data", "image_data", "icon_data"]);
    let path: Option<String> = hint(&hints, &["image-path", "image_path"]);
    let path = path.map(|p| p.strip_prefix("file://").unwrap_or(&p).to_string());
    let decoded = raw.and_then(from_raw).or_else(|| {
        let p = path.as_deref().filter(|p| p.starts_with('/'))?;
        ::image::load_from_memory(&fs::read(p).ok()?).ok()
    });
    let png = decoded.and_then(|d| mp_ui::cover::square_png(&d, PICTURE, PICTURE as f32 / 2.0));
    let picture = png.is_some_and(|png| fs::create_dir_all(folder()).and_then(|()| fs::write(picture_file(id), &png)).is_ok());
    let face = picture.then(|| image::Handle::from_path(picture_file(id)));
    let icon_name = if app_icon.is_empty() { path.filter(|p| !p.starts_with('/')).unwrap_or_default() } else { app_icon };
    let side = if picture { BADGE_ICON } else { ALONE_ICON };
    let (icon, badge) = crate::apps::picture(&icon_name, side).map_or((None, None), |(p, h)| (Some(p), Some(h)));

    let urgency: Option<u8> = hint(&hints, &["urgency"]);
    let flag = |k: &str| hint::<bool>(&hints, &[k]).unwrap_or(false);
    let popup = !QUIET.load(Relaxed) && !PANEL.load(Relaxed);
    // Caelestia's `interval`: the sender's time (0 = until closed, spec), else 2 s over
    // a full-screen window, else 5 s.
    let time = match timeout {
        0 => None,
        t if t > 0 => Some(Duration::from_millis(t as u64)),
        _ if crate::niri::fullscreen() => Some(FULLSCREEN_TIME),
        _ => Some(TIME),
    };
    let notice = Notice {
        id,
        app,
        summary: plain(&summary),
        body: plain(&body),
        actions: actions.chunks(2).filter(|a| a.len() == 2).map(|a| (a[0].clone(), a[1].clone())).collect(),
        critical: urgency == Some(2),
        resident: flag("resident"),
        transient: flag("transient"),
        at: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        picture,
        icon,
        read: false,
        popup,
        time,
        until: time.map(|t| Instant::now() + t),
        face: popup.then_some(face).flatten(),
        badge: popup.then_some(badge).flatten(),
    };

    list = LIST.lock().unwrap();
    // Replaced in its place (the spec's `replaces_id`), else on top.
    match list.iter().position(|n| n.id == id) {
        Some(i) => list[i] = notice,
        None => list.insert(0, notice),
    }
    let dropped: Vec<Notice> = if list.len() > KEEP { list.split_off(KEEP) } else { Vec::new() };
    drop(list);
    for n in dropped {
        if n.picture {
            let _ = fs::remove_file(picture_file(n.id));
        }
        tell(Out::Closed(n.id, 4));
    }
    save();
    wake();
    id
}

/// `image-data` (spec: width, height, row stride, alpha, bits per sample, channels,
/// bytes) as a picture.
fn from_raw((w, h, stride, _alpha, bits, channels, data): (i32, i32, i32, bool, i32, i32, Vec<u8>)) -> Option<::image::DynamicImage> {
    let (w, h, stride, ch) = (usize::try_from(w).ok()?, usize::try_from(h).ok()?, usize::try_from(stride).ok()?, usize::try_from(channels).ok()?);
    if bits != 8 || !(3..=4).contains(&ch) || w == 0 || h == 0 || data.len() < (h - 1) * stride + w * ch {
        return None;
    }
    let mut rgba = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        for px in data[row * stride..][..w * ch].chunks(ch) {
            rgba.extend_from_slice(&[px[0], px[1], px[2], if ch == 4 { px[3] } else { 255 }]);
        }
    }
    Some(::image::DynamicImage::ImageRgba8(::image::RgbaImage::from_raw(w as u32, h as u32, rgba)?))
}

/// A body as plain text: senders may send markup (`<b>`, `<a href>`) though we don't
/// ask for it, so tags are taken out and the five escapes put back. A `<` opens a tag
/// only when a letter or `/` follows it and a `>` closes it: "i <3 you" keeps its words.
fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('>').filter(|_| after.starts_with(|c: char| c.is_ascii_alphabetic() || c == '/')) {
            Some(end) => rest = &after[end + 1..],
            None => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// Caelestia's `timeStr` (as Windows' `age`): now, then minutes, hours, days.
pub fn age(at: u64) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let m = now.saturating_sub(at) / 60;
    let (h, d) = (m / 60, m / 60 / 24);
    if m < 1 {
        "now".into()
    } else if d > 0 {
        format!("{d}d")
    } else if h > 0 {
        format!("{h}h")
    } else {
        format!("{m}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text() {
        assert_eq!(plain("<b>Hi</b> &amp; <a href=\"x\">you</a> 1 &lt; 2"), "Hi & you 1 < 2");
        assert_eq!(plain("no tags"), "no tags");
        // A bare `<` is not a tag (Fable Sweep row H15).
        assert_eq!(plain("i <3 you"), "i <3 you");
        assert_eq!(plain("a < b and <b>c</b> > d"), "a < b and c > d");
        assert_eq!(plain("cut off <b"), "cut off <b");
    }

    #[test]
    fn ages() {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert_eq!(age(now), "now");
        assert_eq!(age(now - 59), "now");
        assert_eq!(age(now - 5 * 60), "5m");
        assert_eq!(age(now - 3 * 3600), "3h");
        assert_eq!(age(now - 49 * 3600), "2d");
        // A clock set back: never a negative age.
        assert_eq!(age(now + 100), "now");
    }

    #[test]
    fn raw_picture() {
        // 2x1, three channels, rows padded to 8 bytes.
        let p = from_raw((2, 1, 8, false, 8, 3, vec![255, 0, 0, 0, 255, 0, 9, 9])).unwrap().into_rgba8();
        assert_eq!(p.as_raw(), &[255, 0, 0, 255, 0, 255, 0, 255]);
        assert!(from_raw((2, 2, 6, false, 8, 3, vec![0; 6])).is_none());
    }
}
