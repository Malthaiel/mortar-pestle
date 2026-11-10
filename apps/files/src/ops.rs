//! Copying and moving (File Explorer plan step 2), off the drawing thread: a job is
//! pairs of "this goes there", run on its own thread, telling its progress at most
//! ten times a second, stopped between chunks, asking the window on a name clash
//! (GNOME's Replace / Skip / Keep Both, "for all"; a folder onto a folder merges).
//! A move on one drive is a rename; across drives (or btrfs subvolumes) a copy,
//! then the original goes. Files copy in 8 MB pieces through `copy_file_range`
//! (btrfs shares the blocks, no bytes move), their mode and modified time kept.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use iced::futures::channel::mpsc::UnboundedSender;

const CHUNK: usize = 8 << 20;
const EVERY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Copy,
    Move,
}

/// A clash's answer: for a folder onto a folder, Replace merges them (GNOME).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    Replace,
    Skip,
    Both,
}

#[derive(Debug, Clone)]
pub enum News {
    /// The whole job's bytes, counted before the first one moves.
    Size(u64),
    /// Bytes done so far.
    Done(u64),
    /// `to` is taken: the window answers (`Pick`, for all). `dir`: a folder onto a
    /// folder (Replace merges); `bins`: a file onto a folder or the other way
    /// (Replace sends what's there to the Bin).
    Clash { to: PathBuf, dir: bool, bins: bool },
    /// What went where (top level), what failed, whether it was stopped, and
    /// whether any of it merged with, replaced or only partly joined what was
    /// there (`mixed`: Undo can't tell the new from the old).
    Finished { made: Vec<(PathBuf, PathBuf)>, errors: Vec<String>, stopped: bool, mixed: bool },
}

/// "name (copy).ext", then "name (copy 2).ext" (GNOME's), the first free one.
pub fn free_name(folder: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rsplit_once('.').filter(|(s, _)| !s.is_empty()) {
        Some((s, e)) => (s, format!(".{e}")),
        None => (name, String::new()),
    };
    (1..).map(|n| folder.join(if n == 1 { format!("{stem} (copy){ext}") } else { format!("{stem} (copy {n}){ext}") })).find(|p| p.symlink_metadata().is_err()).unwrap()
}

/// The pairs for a paste of `from` into `folder`: a thing pasted where it already
/// is gets a free name (a copy) or stays (a move).
pub fn pairs(from: &[PathBuf], folder: &Path, kind: Kind) -> Vec<(PathBuf, PathBuf)> {
    from.iter()
        .filter_map(|f| {
            let name = f.file_name()?;
            let to = folder.join(name);
            match (to == *f, kind) {
                (true, Kind::Copy) => Some((f.clone(), free_name(folder, &name.to_string_lossy()))),
                (true, Kind::Move) => None,
                _ => Some((f.clone(), to)),
            }
        })
        .collect()
}

struct Run<'a> {
    kind: Kind,
    tx: &'a UnboundedSender<News>,
    answers: &'a Receiver<(Pick, bool)>,
    stop: &'a AtomicBool,
    /// The answer kept "for all", files and folders apart.
    all: [Option<Pick>; 2],
    done: u64,
    said: Instant,
    /// Things inside a folder that failed or were left out, as "name: why".
    errors: Vec<String>,
    mixed: bool,
}

fn stopped() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "stopped")
}

impl Run<'_> {
    fn tick(&mut self, n: u64) -> io::Result<()> {
        self.done += n;
        if self.said.elapsed() >= EVERY {
            self.said = Instant::now();
            let _ = self.tx.unbounded_send(News::Done(self.done));
        }
        if self.stop.load(Ordering::Relaxed) { Err(stopped()) } else { Ok(()) }
    }

    fn ask(&mut self, to: &Path, dir: bool, bins: bool) -> io::Result<Pick> {
        if let Some(p) = self.all[dir as usize] {
            return Ok(p);
        }
        let _ = self.tx.unbounded_send(News::Clash { to: to.into(), dir, bins });
        loop {
            match self.answers.recv_timeout(Duration::from_millis(200)) {
                Ok((pick, all)) => {
                    if all {
                        self.all[dir as usize] = Some(pick);
                    }
                    return Ok(pick);
                }
                Err(RecvTimeoutError::Timeout) if !self.stop.load(Ordering::Relaxed) => {}
                _ => return Err(stopped()),
            }
        }
    }

    /// One thing to its place: asks on a clash; `Ok(None)` = skipped.
    fn put(&mut self, from: &Path, to: &Path) -> io::Result<Option<PathBuf>> {
        let src = fs::symlink_metadata(from)?;
        if src.is_dir() && to.starts_with(from) {
            return Err(io::Error::other(format!("\u{201c}{}\u{201d} can't go inside itself", name(from))));
        }
        let mut to = to.to_path_buf();
        let mut merge = false;
        if let Ok(there) = fs::symlink_metadata(&to) {
            let dirs = src.is_dir() && there.is_dir();
            let swap = there.is_dir() != src.is_dir();
            let pick = self.ask(&to, dirs, swap)?;
            self.mixed |= pick == Pick::Replace;
            match pick {
                Pick::Skip => return Ok(None),
                Pick::Both => to = free_name(to.parent().unwrap_or(Path::new("/")), &name(&to)),
                Pick::Replace if dirs => merge = true,
                // A file over a folder or the other way: the old one goes to the
                // Bin first (a whole folder is never lost to one press).
                Pick::Replace if swap => drop(crate::bin::bin(&to)?),
                Pick::Replace => {}
            }
        }
        if self.kind == Kind::Move && !merge {
            match fs::rename(from, &to) {
                Ok(()) => return Ok(Some(to)),
                Err(e) if e.raw_os_error() != Some(libc::EXDEV) => return Err(e),
                Err(_) => {}
            }
        }
        let whole = self.copy(from, &to)?;
        self.mixed |= !whole;
        // A move takes the source away only when all of it landed: a thing skipped
        // or failed inside stays where it was (GNOME Files' "don't delete source if
        // there was a skipped file").
        if self.kind == Kind::Move && whole {
            crate::bin::delete(from)?;
        }
        Ok((whole || to.symlink_metadata().is_ok()).then_some(to))
    }

    /// A copy of a link, a file or a folder (into an existing one: merged, each
    /// clash inside asked again). `Ok(false)`: something under it was skipped,
    /// failed (told in `errors`) or left out, and the copy went on past it.
    fn copy(&mut self, from: &Path, to: &Path) -> io::Result<bool> {
        let m = fs::symlink_metadata(from)?;
        if m.file_type().is_symlink() {
            let _ = fs::remove_file(to);
            std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
            return Ok(true);
        }
        if m.is_dir() {
            match fs::create_dir(to) {
                Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
                _ => {}
            }
            let mut whole = true;
            for e in fs::read_dir(from)? {
                let (a, done) = match e {
                    Ok(e) => (e.path(), self.child(&e.path(), &to.join(e.file_name()))),
                    Err(e) => (from.to_path_buf(), Err(e)),
                };
                match done {
                    Ok(all) => whole &= all,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => return Err(e),
                    // One bad file doesn't end its folder: told, and the rest goes on.
                    Err(e) => {
                        whole = false;
                        self.errors.push(format!("{}: {}", name(&a), plain(&e)));
                    }
                }
            }
            let _ = fs::set_permissions(to, m.permissions());
            return Ok(whole);
        }
        // A pipe, a socket, a device: opening one can wait for ever.
        if !m.is_file() {
            self.errors.push(format!("{}: not a file or a folder, left out", name(from)));
            return Ok(false);
        }
        self.file(from, to, &m)?;
        Ok(true)
    }

    /// One thing inside a folder being copied: a clash asked (inside a merge, the
    /// same question, thing by thing); a move takes it away once all of it landed.
    fn child(&mut self, a: &Path, b: &Path) -> io::Result<bool> {
        let at = if b.symlink_metadata().is_ok() {
            match self.inner(a, b)? {
                Some(at) => at,
                None => return Ok(false),
            }
        } else {
            b.to_path_buf()
        };
        let whole = self.copy(a, &at)?;
        if whole && self.kind == Kind::Move {
            crate::bin::delete(a)?;
        }
        Ok(whole)
    }

    fn inner(&mut self, from: &Path, to: &Path) -> io::Result<Option<PathBuf>> {
        let (a, b) = (fs::symlink_metadata(from)?.is_dir(), fs::symlink_metadata(to)?.is_dir());
        Ok(match self.ask(to, a && b, a != b)? {
            Pick::Skip => None,
            Pick::Both => Some(free_name(to.parent().unwrap_or(Path::new("/")), &name(to))),
            Pick::Replace if a && b => Some(to.to_path_buf()),
            Pick::Replace => {
                if a != b {
                    crate::bin::bin(to)?;
                }
                Some(to.to_path_buf())
            }
        })
    }

    /// A file's bytes into a side name, then over `to` in one step (a stop or a
    /// failure never leaves half a file under the real name).
    fn file(&mut self, from: &Path, to: &Path, m: &fs::Metadata) -> io::Result<()> {
        let part = to.with_file_name(format!(".{}.mp-part", name(to)));
        let result = (|| {
            let mut a = File::open(from)?;
            let mut b = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(m.permissions().mode()).open(&part)?;
            let mut fast = true;
            loop {
                let n = if fast {
                    // SAFETY: both descriptors are open files we own; null offsets use
                    // and move the files' own positions.
                    let n = unsafe { libc::copy_file_range(a.as_raw_fd(), std::ptr::null_mut(), b.as_raw_fd(), std::ptr::null_mut(), CHUNK, 0) };
                    if n < 0 {
                        let e = io::Error::last_os_error();
                        if matches!(e.raw_os_error(), Some(libc::EXDEV | libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP)) {
                            fast = false;
                            continue;
                        }
                        return Err(e);
                    }
                    n as usize
                } else {
                    let mut buf = vec![0; CHUNK.min(1 << 20)];
                    let n = a.read(&mut buf)?;
                    b.write_all(&buf[..n])?;
                    n
                };
                if n == 0 {
                    break;
                }
                self.tick(n as u64)?;
            }
            b.set_permissions(m.permissions())?;
            if let Ok(t) = m.modified() {
                let _ = b.set_modified(t);
            }
            drop(b);
            fs::rename(&part, to)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&part);
        }
        result
    }
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The bytes under `p` (links count nothing).
fn bytes(p: &Path) -> u64 {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::read_dir(p).into_iter().flatten().flatten().map(|e| bytes(&e.path())).sum(),
        Ok(m) if m.is_file() => m.len(),
        _ => 0,
    }
}

/// Runs a job on this thread (the caller gives it one).
pub fn run(kind: Kind, pairs: Vec<(PathBuf, PathBuf)>, tx: UnboundedSender<News>, answers: Receiver<(Pick, bool)>, stop: Arc<AtomicBool>) {
    // A move on one drive costs no bytes: only what can't be renamed is counted.
    let total = pairs.iter().filter(|(f, t)| kind == Kind::Copy || !same_drive(f, t)).map(|(f, _)| bytes(f)).sum();
    let _ = tx.unbounded_send(News::Size(total));
    let mut run = Run { kind, tx: &tx, answers: &answers, stop: &stop, all: [None; 2], done: 0, said: Instant::now(), errors: Vec::new(), mixed: false };
    let (mut made, mut errors, mut halted) = (Vec::new(), Vec::new(), false);
    for (from, to) in pairs {
        match run.put(&from, &to) {
            Ok(Some(at)) => made.push((from, at)),
            Ok(None) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                halted = true;
                break;
            }
            Err(e) => errors.push(format!("{}: {}", name(&from), plain(&e))),
        }
    }
    errors.append(&mut run.errors);
    let _ = tx.unbounded_send(News::Finished { made, errors, stopped: halted, mixed: run.mixed });
}

/// A drop's action (GNOME's `nautilus_dnd_get_preferred_action`): a move when the
/// first thing is on the folder's drive and may leave its own folder, else a copy.
pub fn dropped(first: &Path, folder: &Path) -> Kind {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    let dev = |p: &Path| fs::symlink_metadata(p).map(|m| m.dev()).ok();
    // SAFETY: `d` is a NUL-ended string that lives through the call.
    let leaves = first.parent().and_then(|d| std::ffi::CString::new(d.as_os_str().as_bytes()).ok()).is_some_and(|d| unsafe { libc::access(d.as_ptr(), libc::W_OK) } == 0);
    let drive = fs::metadata(folder).map(|m| m.dev()).ok();
    if leaves && dev(first).is_some() && dev(first) == drive { Kind::Move } else { Kind::Copy }
}

fn same_drive(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let dev = |p: &Path| fs::symlink_metadata(p).map(|m| m.dev()).ok();
    dev(a).is_some() && dev(a) == b.parent().and_then(dev)
}

/// An error in plain words.
pub fn plain(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::PermissionDenied => "you don't have permission".into(),
        io::ErrorKind::NotFound => "it isn't there any more".into(),
        io::ErrorKind::AlreadyExists => "that name is taken".into(),
        io::ErrorKind::StorageFull => "the drive is full".into(),
        io::ErrorKind::ReadOnlyFilesystem => "the drive can't be written".into(),
        _ => e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs a job with its answers given ahead; a question past them stops it.
    fn job(kind: Kind, pairs: Vec<(PathBuf, PathBuf)>, answers: &[(Pick, bool)]) -> Vec<News> {
        let (tx, mut rx) = iced::futures::channel::mpsc::unbounded();
        let (atx, arx) = std::sync::mpsc::channel();
        for a in answers {
            atx.send(*a).unwrap();
        }
        drop(atx);
        run(kind, pairs, tx, arx, Arc::new(AtomicBool::new(false)));
        let mut out = Vec::new();
        while let Ok(n) = rx.try_recv() {
            out.push(n);
        }
        out
    }

    /// GNOME's drop rule: a move on one drive from a folder we may change, else a copy.
    #[test]
    fn drop_kind() {
        use std::os::unix::fs::MetadataExt;
        let d = std::env::temp_dir().join(format!("mp-files-drop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("a")).unwrap();
        fs::create_dir_all(d.join("b")).unwrap();
        fs::write(d.join("a/x.txt"), "x").unwrap();
        assert_eq!(dropped(&d.join("a/x.txt"), &d.join("b")), Kind::Move);
        // A folder we may not change: the thing can't leave it.
        fs::set_permissions(d.join("a"), fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(dropped(&d.join("a/x.txt"), &d.join("b")), Kind::Copy);
        fs::set_permissions(d.join("a"), fs::Permissions::from_mode(0o755)).unwrap();
        // Another drive (the temp folder is tmpfs, home is btrfs).
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
        if fs::metadata(&home).unwrap().dev() != fs::metadata(&d).unwrap().dev() {
            assert_eq!(dropped(&d.join("a/x.txt"), &home), Kind::Copy);
        }
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn copy_move_clash() {
        let d = std::env::temp_dir().join(format!("mp-files-ops-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("a/inner")).unwrap();
        fs::create_dir_all(d.join("b")).unwrap();
        fs::write(d.join("a/inner/x.txt"), "x").unwrap();
        fs::write(d.join("a/y.txt"), vec![7u8; 3 << 20]).unwrap();
        // A paste in the same folder: a copy with GNOME's name.
        let p = pairs(&[d.join("a/y.txt")], &d.join("a"), Kind::Copy);
        assert_eq!(p[0].1, d.join("a/y (copy).txt"));
        job(Kind::Copy, p, &[]);
        assert_eq!(fs::read(d.join("a/y (copy).txt")).unwrap().len(), 3 << 20);
        assert!(pairs(&[d.join("a/y.txt")], &d.join("a"), Kind::Move).is_empty());
        // A folder copied, then copied again: the clash merges (Replace for all).
        job(Kind::Copy, pairs(&[d.join("a")], &d.join("b"), Kind::Copy), &[]);
        assert_eq!(fs::read_to_string(d.join("b/a/inner/x.txt")).unwrap(), "x");
        let news = job(Kind::Copy, pairs(&[d.join("a")], &d.join("b"), Kind::Copy), &[(Pick::Replace, true), (Pick::Replace, true)]);
        assert!(news.iter().any(|n| matches!(n, News::Clash { dir: true, .. })));
        assert!(matches!(news.last(), Some(News::Finished { errors, stopped: false, .. }) if errors.is_empty()));
        // Into itself: refused.
        let news = job(Kind::Copy, vec![(d.join("a"), d.join("a/inner/a"))], &[]);
        assert!(matches!(news.last(), Some(News::Finished { errors, .. }) if errors.len() == 1));
        // A move, then Keep Both on a clash.
        fs::write(d.join("z.txt"), "1").unwrap();
        job(Kind::Move, pairs(&[d.join("z.txt")], &d.join("b"), Kind::Move), &[]);
        assert!(!d.join("z.txt").exists() && d.join("b/z.txt").exists());
        fs::write(d.join("z.txt"), "2").unwrap();
        job(Kind::Move, pairs(&[d.join("z.txt")], &d.join("b"), Kind::Move), &[(Pick::Both, false)]);
        assert_eq!(fs::read_to_string(d.join("b/z (copy).txt")).unwrap(), "2");
        assert!(!d.join("b/.z.txt.mp-part").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    /// Fable Sweep F1: a move that merges, with one file inside skipped, leaves that
    /// file where it was (it used to go with the source folder, for good).
    #[test]
    fn move_merge_skip_keeps_the_skipped() {
        let d = std::env::temp_dir().join(format!("mp-files-merge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("a/Album")).unwrap();
        fs::create_dir_all(d.join("b/Album")).unwrap();
        fs::write(d.join("a/Album/song.txt"), "mine").unwrap();
        fs::write(d.join("a/Album/other.txt"), "other").unwrap();
        fs::write(d.join("b/Album/song.txt"), "theirs").unwrap();
        let news = job(Kind::Move, pairs(&[d.join("a/Album")], &d.join("b"), Kind::Move), &[(Pick::Replace, false), (Pick::Skip, false)]);
        assert_eq!(fs::read_to_string(d.join("a/Album/song.txt")).unwrap(), "mine", "the skipped file stays");
        assert_eq!(fs::read_to_string(d.join("b/Album/song.txt")).unwrap(), "theirs");
        assert!(!d.join("a/Album/other.txt").exists() && d.join("b/Album/other.txt").exists(), "the rest moved");
        assert!(matches!(news.last(), Some(News::Finished { mixed: true, stopped: false, .. })));
        // Nothing skipped: the source folder goes, as before.
        fs::remove_file(d.join("b/Album/song.txt")).unwrap();
        job(Kind::Move, pairs(&[d.join("a/Album")], &d.join("b"), Kind::Move), &[(Pick::Replace, false)]);
        assert!(!d.join("a/Album").exists());
        assert_eq!(fs::read_to_string(d.join("b/Album/song.txt")).unwrap(), "mine");
        fs::remove_dir_all(&d).unwrap();
    }

    /// Fable Sweep F5: a file that can't be read is told and the rest of its folder
    /// still copies; a pipe is left out (opening one waits for ever).
    #[test]
    fn copy_goes_past_a_bad_file() {
        use std::os::unix::ffi::OsStrExt;
        let d = std::env::temp_dir().join(format!("mp-files-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("a/F")).unwrap();
        fs::create_dir_all(d.join("b")).unwrap();
        for n in ["1.txt", "2.txt", "3.txt"] {
            fs::write(d.join("a/F").join(n), n).unwrap();
        }
        fs::set_permissions(d.join("a/F/2.txt"), fs::Permissions::from_mode(0o000)).unwrap();
        let pipe = std::ffi::CString::new(d.join("a/F/pipe").as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-ended path that lives through the call.
        assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
        let news = job(Kind::Copy, pairs(&[d.join("a/F")], &d.join("b"), Kind::Copy), &[]);
        assert!(d.join("b/F/1.txt").exists() && d.join("b/F/3.txt").exists() && !d.join("b/F/pipe").exists());
        let Some(News::Finished { made, errors, mixed, .. }) = news.last() else { panic!() };
        assert_eq!(made.len(), 1);
        assert!(*mixed);
        // Root reads anything: only the pipe is told then.
        let root = fs::read(d.join("a/F/2.txt")).is_ok();
        assert_eq!(errors.len(), if root { 1 } else { 2 }, "{errors:?}");
        assert!(errors.iter().any(|e| e.starts_with("pipe: ")));
        fs::set_permissions(d.join("a/F/2.txt"), fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_dir_all(&d).unwrap();
    }
}
