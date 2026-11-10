//! A folder's contents, yazi's way: the names first (one directory read, the kind
//! from the name, no file opened: 6-7 ms for the 21,036 entries of
//! `/usr/share/man/man3`, measured 2026-11-03), then each entry's size and date in
//! a second pass (73 ms there warm, 351 cold) that fills the rows in. GNOME Files'
//! order (folders first, names as people count: "file2" before "file10"), its
//! hidden rule (a leading dot, a trailing `~`, or a line in the folder's `.hidden`)
//! and its "simple" sizes and dates.

use std::cmp::Ordering;
use std::ffi::OsString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iced::Subscription;
use iced::futures::StreamExt;
use iced::futures::channel::mpsc;
use iced::window;

use crate::kind::{self, Kind};

#[derive(Debug, Clone)]
pub struct Entry {
    pub os: OsString,
    pub name: String,
    /// Lower case, for the order and (step 3) the search.
    pub low: String,
    pub dir: bool,
    pub kind: Kind,
    pub hidden: bool,
    pub details: Option<Details>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Details {
    /// A file's bytes; a folder's items (what it shows, hidden ones left out).
    pub size: u64,
    pub modified: Option<i64>,
}

/// GNOME Files' sort menu (`nautilus-list-base`): A-Z, Z-A, Last Modified, First
/// Modified, Size (largest first), Type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Az,
    Za,
    Newest,
    Oldest,
    Size,
    Type,
}

/// The names, read in one pass. Links count as what they point at.
pub fn list(folder: &Path) -> Result<Vec<Entry>, String> {
    let dots: Vec<String> = std::fs::read_to_string(folder.join(".hidden")).map(|t| t.lines().map(str::to_string).collect()).unwrap_or_default();
    let mut out = Vec::new();
    for e in std::fs::read_dir(folder).map_err(|e| say(&e))?.flatten() {
        let os = e.file_name();
        let name = os.to_string_lossy().into_owned();
        let dir = match e.file_type() {
            Ok(t) if t.is_symlink() => std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false),
            Ok(t) => t.is_dir(),
            Err(_) => false,
        };
        let hidden = name.starts_with('.') || name.ends_with('~') || dots.contains(&name);
        out.push(Entry { kind: kind::of(&name, dir), low: name.to_lowercase(), os, name, dir, hidden, details: None });
    }
    Ok(out)
}

/// Each name's size and date, the name with them: the list is sorted while these
/// are read, so an answer is matched by its name, never by its place (Fable Sweep
/// F2: by place, most rows showed another file's size and date).
pub fn details(folder: &Path, entries: Vec<(OsString, bool)>) -> Vec<(OsString, Details)> {
    entries
        .into_iter()
        .map(|(os, dir)| {
            let path = folder.join(&os);
            let Ok(m) = std::fs::metadata(&path) else { return (os, Details::default()) };
            let modified = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
            let size = if dir { std::fs::read_dir(&path).map(|r| r.flatten().filter(|e| !e.file_name().as_encoded_bytes().starts_with(b".")).count() as u64).unwrap_or(0) } else { m.len() };
            (os, Details { size, modified })
        })
        .collect()
}

/// Puts the details on the entries they name; an entry not named keeps its own.
pub fn fill(entries: &mut [Entry], details: Vec<(OsString, Details)>) {
    let by_name: std::collections::HashMap<OsString, Details> = details.into_iter().collect();
    for e in entries {
        e.details = by_name.get(&e.os).copied().or(e.details);
    }
}

/// GNOME Files' order: folders first, then the sort, names as people count.
pub fn order(entries: &mut [Entry], sort: Sort) {
    let modified = |e: &Entry| e.details.and_then(|d| d.modified).unwrap_or(0);
    let size = |e: &Entry| e.details.map(|d| d.size).unwrap_or(0);
    entries.sort_by(|a, b| {
        b.dir.cmp(&a.dir).then_with(|| match sort {
            Sort::Az => natural(&a.low, &b.low),
            Sort::Za => natural(&b.low, &a.low),
            Sort::Newest => modified(b).cmp(&modified(a)).then_with(|| natural(&a.low, &b.low)),
            Sort::Oldest => modified(a).cmp(&modified(b)).then_with(|| natural(&a.low, &b.low)),
            Sort::Size => size(b).cmp(&size(a)).then_with(|| natural(&a.low, &b.low)),
            Sort::Type => a.kind.cmp(&b.kind).then_with(|| natural(&a.low, &b.low)),
        })
    });
}

/// Runs of digits compare as numbers ("file2" < "file10"), the rest letter by letter.
pub fn natural(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.as_bytes(), b.as_bytes());
    loop {
        match (a.first(), b.first()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let run = |s: &[u8]| s.iter().take_while(|c| c.is_ascii_digit()).count();
                let (na, nb) = (run(a), run(b));
                let (da, db) = (&a[..na], &b[..nb]);
                let trim = |d: &[u8]| d.iter().position(|&c| c != b'0').map_or(&d[d.len()..], |i| &d[i..]).to_vec();
                let (ta, tb) = (trim(da), trim(db));
                let by = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(&tb)).then_with(|| na.cmp(&nb));
                if by != Ordering::Equal {
                    return by;
                }
                (a, b) = (&a[na..], &b[nb..]);
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(y);
                }
                (a, b) = (&a[1..], &b[1..]);
            }
        }
    }
}

/// GNOME's "simple" size (`g_format_size`, steps of 1000): "1 byte", "512 bytes",
/// "4.2 kB", "12.3 MB"; a folder's "1 item", "7 items".
pub fn size(d: &Details, dir: bool) -> String {
    if dir {
        return if d.size == 1 { "1 item".into() } else { format!("{} items", d.size) };
    }
    match d.size {
        1 => "1 byte".into(),
        n if n < 1000 => format!("{n} bytes"),
        n => {
            let mut v = n as f64 / 1000.0;
            let mut unit = 0;
            while v >= 999.95 && unit < 4 {
                v /= 1000.0;
                unit += 1;
            }
            format!("{v:.1} {}", ["kB", "MB", "GB", "TB", "PB"][unit])
        }
    }
}

/// GNOME's "simple" date: today the time, "Yesterday", this year "3 Oct", before it
/// "3 Oct 2024".
pub fn date(secs: i64) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs() as i64;
    let (then, today) = (local(secs), local(now));
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = MONTHS[then.tm_mon.clamp(0, 11) as usize];
    if then.tm_year == today.tm_year && then.tm_yday == today.tm_yday {
        let h = then.tm_hour % 12;
        format!("{}:{:02} {}", if h == 0 { 12 } else { h }, then.tm_min, if then.tm_hour < 12 { "AM" } else { "PM" })
    } else if local(now - 86_400).tm_yday == then.tm_yday && local(now - 86_400).tm_year == then.tm_year {
        "Yesterday".into()
    } else if then.tm_year == today.tm_year {
        format!("{} {month}", then.tm_mday)
    } else {
        format!("{} {month} {}", then.tm_mday, then.tm_year + 1900)
    }
}

pub fn local(secs: i64) -> libc::tm {
    // SAFETY: localtime_r fills the zeroed tm we own; the time is a plain number.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&(secs as libc::time_t), &mut tm);
        tm
    }
}

/// The folder a start argument names: a path or a `file://` address.
pub fn from_arg(arg: &str) -> PathBuf {
    match arg.strip_prefix("file://") {
        Some(rest) => PathBuf::from(unescape(rest)),
        None => PathBuf::from(arg),
    }
}

/// What a typed address (Ctrl+L) names: `~` is home, a `file://` address its path,
/// anything not starting at `/` is inside `here`; `.` and `..` read as written
/// (a link isn't followed, so the path shown stays the one typed).
pub fn typed(t: &str, here: &Path, home: &Path) -> PathBuf {
    let t = t.trim();
    let p = match t.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => from_arg(t),
    };
    let mut out = PathBuf::new();
    for part in here.join(p).components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub use mp_ui::portal::unescape;

/// A path as a `file://` address, unsafe bytes as `%xx`.
pub fn address(path: &Path) -> String {
    let mut out = String::from("file://");
    for &c in path.as_os_str().as_encoded_bytes() {
        if c.is_ascii_alphanumeric() || b"/-_.~".contains(&c) {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

fn say(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "You don't have permission to open this folder".into(),
        std::io::ErrorKind::NotFound => "This folder doesn't exist".into(),
        _ => e.to_string(),
    }
}

/// A word each time the folder really changes (a name made, gone or moved; a file
/// saved or its details changed), 200 ms batched, while the window shows it. Our own
/// inotify: `notify`'s watch also heard every open and read of a file there (923
/// wake-ups in 10 s on Home, nothing changed) and its debouncer ticked 20 times a
/// second (measured 2026-11-03); this one sleeps until a real change.
pub fn changes(id: window::Id, folder: PathBuf) -> Subscription<window::Id> {
    Subscription::run_with((id, folder), |(id, folder)| {
        let (tx, rx) = mpsc::unbounded();
        let id = *id;
        let watch = Watch::start(folder, tx);
        rx.map(move |()| {
            let _ = &watch;
            id
        })
    })
}

/// The watching thread; dropped (the window shut or moved on), it's told to end.
struct Watch(Option<OwnedFd>);

impl Watch {
    fn start(folder: &Path, tx: mpsc::UnboundedSender<()>) -> Self {
        // SAFETY: plain calls; each descriptor made here is owned right away.
        let made = unsafe {
            let notes = libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK);
            let bell = libc::eventfd(0, libc::EFD_CLOEXEC);
            (notes >= 0 && bell >= 0).then(|| (OwnedFd::from_raw_fd(notes), OwnedFd::from_raw_fd(bell)))
        };
        let Some((notes, bell)) = made else { return Self(None) };
        let Ok(path) = std::ffi::CString::new(folder.as_os_str().as_encoded_bytes()) else { return Self(None) };
        let mask = libc::IN_CREATE | libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE | libc::IN_ATTRIB | libc::IN_DELETE_SELF | libc::IN_MOVE_SELF;
        // SAFETY: a valid descriptor and a NUL-ended path.
        if unsafe { libc::inotify_add_watch(notes.as_raw_fd(), path.as_ptr(), mask) } < 0 {
            return Self(None);
        }
        let Ok(ring) = bell.try_clone() else { return Self(None) };
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let drain = |buf: &mut [u8]| {
                // SAFETY: reads into our own buffer from our own descriptor.
                while unsafe { libc::read(notes.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
            };
            loop {
                let mut fds = [libc::pollfd { fd: notes.as_raw_fd(), events: libc::POLLIN, revents: 0 }, libc::pollfd { fd: ring.as_raw_fd(), events: libc::POLLIN, revents: 0 }];
                // SAFETY: two pollfds we own; no timeout, so it sleeps till one is told.
                if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 || fds[1].revents != 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
                drain(&mut buf);
                if tx.unbounded_send(()).is_err() {
                    break;
                }
            }
        });
        Self(Some(bell))
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        if let Some(bell) = &self.0 {
            // SAFETY: writes the eventfd's 8-byte count from our own value.
            unsafe { libc::write(bell.as_raw_fd(), (&1u64 as *const u64).cast(), 8) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn people_count() {
        let mut v = vec!["file10", "file2", "File1", "a", "file02"];
        v.sort_by(|a, b| natural(&a.to_lowercase(), &b.to_lowercase()));
        assert_eq!(v, ["a", "File1", "file2", "file02", "file10"]);
        assert_eq!(size(&Details { size: 4_200, modified: None }, false), "4.2 kB");
        assert_eq!(size(&Details { size: 1, modified: None }, true), "1 item");
        assert_eq!(unescape("/home/a%20b"), "/home/a b");
        assert_eq!(address(Path::new("/home/a b")), "file:///home/a%20b");
    }

    /// Fable Sweep F2: the details are read in the order the names came, the list
    /// is sorted meanwhile; each entry still gets its own.
    #[test]
    fn details_land_on_their_own_names() {
        let d = std::env::temp_dir().join(format!("mp-files-details-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("sub/one"), "").unwrap();
        for (name, len) in [("zz", 5), ("b", 300), ("m10", 1), ("m2", 70), ("A", 9)] {
            std::fs::write(d.join(name), vec![0u8; len]).unwrap();
        }
        let mut entries = list(&d).unwrap();
        let names: Vec<(OsString, bool)> = entries.iter().rev().map(|e| (e.os.clone(), e.dir)).collect();
        order(&mut entries, Sort::Az);
        fill(&mut entries, details(&d, names));
        let got: Vec<(&str, u64)> = entries.iter().map(|e| (e.name.as_str(), e.details.unwrap().size)).collect();
        assert_eq!(got, [("sub", 1), ("A", 9), ("b", 300), ("m2", 70), ("m10", 1), ("zz", 5)]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn typed_addresses() {
        let (here, home) = (Path::new("/home/m/Music"), Path::new("/home/m"));
        assert_eq!(typed("~", here, home), Path::new("/home/m"));
        assert_eq!(typed(" ~/Documents/ ", here, home), Path::new("/home/m/Documents"));
        assert_eq!(typed("/usr/share/../lib", here, home), Path::new("/usr/lib"));
        assert_eq!(typed("Albums/./x", here, home), Path::new("/home/m/Music/Albums/x"));
        assert_eq!(typed("..", here, home), Path::new("/home/m"));
        assert_eq!(typed("file:///home/a%20b", here, home), Path::new("/home/a b"));
        assert_eq!(typed("~x", here, home), Path::new("/home/m/Music/~x"));
    }
}
