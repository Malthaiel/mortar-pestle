//! The Bin: the freedesktop Trash spec 1.0, our own (the `trash` crate's `delete`
//! doesn't say where a file went, which Undo needs; re-checked 2026-11-03, 5.2.9).
//! A file on the home folder's drive goes to `$XDG_DATA_HOME/Trash`; one on another
//! drive to that drive's `.Trash/$uid` (a shared sticky folder) or `.Trash-$uid`.
//! Each holds `files/<name>` and `info/<name>.trashinfo` (where it came from, when).

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::folder;

/// One thing in a Bin: its Bin folder, its name in `files/`, where it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Binned {
    pub root: PathBuf,
    pub name: String,
    pub from: PathBuf,
}

impl Binned {
    pub fn file(&self) -> PathBuf {
        self.root.join("files").join(&self.name)
    }

    fn info(&self) -> PathBuf {
        self.root.join("info").join(format!("{}.trashinfo", self.name))
    }
}

/// A line of the Bin page: the thing, when it was binned (seconds), a folder or not.
#[derive(Debug, Clone)]
pub struct Item {
    pub binned: Binned,
    pub when: i64,
    pub dir: bool,
}

fn uid() -> u32 {
    // SAFETY: getuid has no failure and touches no memory.
    unsafe { libc::getuid() }
}

pub fn home_bin() -> PathBuf {
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| crate::places::home().join(".local/share"));
    data.join("Trash")
}

fn ready(root: &Path) -> io::Result<()> {
    for part in ["files", "info"] {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(root.join(part))?;
    }
    Ok(())
}

/// The top of the drive `path` sits on: the last folder up with its device.
fn top_of(path: &Path, dev: u64) -> PathBuf {
    let mut top = path.to_path_buf();
    while let Some(up) = top.parent() {
        if fs::metadata(up).map(|m| m.dev()).ok() != Some(dev) {
            break;
        }
        top = up.to_path_buf();
    }
    top
}

/// The Bin for a thing on another drive, and the path the info names (from the
/// drive's top, as the spec asks there).
fn drive_bin(path: &Path, dev: u64) -> io::Result<(PathBuf, PathBuf)> {
    let top = top_of(path, dev);
    let shared = top.join(".Trash");
    let rel = path.strip_prefix(&top).map(Path::to_path_buf).unwrap_or_else(|_| path.to_path_buf());
    // A shared `.Trash` counts only as a real sticky folder, never a link.
    if let Ok(m) = fs::symlink_metadata(&shared)
        && m.is_dir()
        && m.permissions().mode() & 0o1000 != 0
    {
        let mine = shared.join(uid().to_string());
        if ready(&mine).is_ok() {
            return Ok((mine, rel));
        }
    }
    let own = top.join(format!(".Trash-{}", uid()));
    ready(&own)?;
    Ok((own, rel))
}

/// "name.2.ext" for the second of a name (gio's way).
fn nth(name: &str, n: u32) -> String {
    if n == 1 {
        return name.to_string();
    }
    match name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()) {
        Some((stem, ext)) => format!("{stem}.{n}.{ext}"),
        None => format!("{name}.{n}"),
    }
}

fn stamp(secs: i64) -> String {
    let tm = folder::local(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

fn unstamp(s: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| s.get(r).and_then(|v| v.parse::<i32>().ok());
    // SAFETY: mktime reads the tm we own and fills nothing outside it.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        (tm.tm_year, tm.tm_mon, tm.tm_mday) = (n(0..4)? - 1900, n(5..7)? - 1, n(8..10)?);
        (tm.tm_hour, tm.tm_min, tm.tm_sec, tm.tm_isdst) = (n(11..13)?, n(14..16)?, n(17..19)?, -1);
        Some(libc::mktime(&mut tm) as i64)
    }
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Moves `path` into its drive's Bin (a link goes, not what it points at).
pub fn bin(path: &Path) -> io::Result<Binned> {
    let dev = fs::symlink_metadata(path)?.dev();
    let home = home_bin();
    ready(&home)?;
    let (root, named) = if fs::metadata(&home)?.dev() == dev { (home, path.to_path_buf()) } else { drive_bin(path, dev)? };
    let base = path.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| io::Error::other("no name"))?;
    let body = format!("[Trash Info]\nPath={}\nDeletionDate={}\n", folder::address(&named).trim_start_matches("file://"), stamp(now()));
    for n in 1.. {
        let b = Binned { root: root.clone(), name: nth(&base, n), from: path.to_path_buf() };
        // The info first, made only if new: it claims the name (the spec's way).
        let mut info = match fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(b.info()) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        if b.file().symlink_metadata().is_ok() {
            drop(info);
            let _ = fs::remove_file(b.info());
            continue;
        }
        info.write_all(body.as_bytes())?;
        if let Err(e) = fs::rename(path, b.file()) {
            let _ = fs::remove_file(b.info());
            return Err(e);
        }
        return Ok(b);
    }
    unreachable!()
}

/// Back where it came from (its folder made again if it went); not over another.
pub fn restore(b: &Binned) -> io::Result<()> {
    if b.from.symlink_metadata().is_ok() {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    if let Some(up) = b.from.parent() {
        fs::create_dir_all(up)?;
    }
    fs::rename(b.file(), &b.from)?;
    let _ = fs::remove_file(b.info());
    Ok(())
}

/// Gone for good, out of the Bin.
pub fn forget(b: &Binned) -> io::Result<()> {
    delete(&b.file())?;
    let _ = fs::remove_file(b.info());
    Ok(())
}

/// Gone for good (Shift+Delete): a folder with all inside, a link and not its target.
pub fn delete(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

/// Every Bin in reach: the home one, and the drives' (mounted ones holding ours).
fn roots() -> Vec<(PathBuf, Option<PathBuf>)> {
    let mut out = vec![(home_bin(), None)];
    let mounts = fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    for top in mounts.lines().filter_map(|l| l.split(' ').nth(1)).map(|t| PathBuf::from(folder::unescape(&t.replace("\\040", " ")))) {
        for root in [top.join(".Trash").join(uid().to_string()), top.join(format!(".Trash-{}", uid()))] {
            if root.join("info").is_dir() && !out.iter().any(|(r, _)| *r == root) {
                out.push((root, Some(top.clone())));
            }
        }
    }
    out
}

/// What's in the Bin, newest first.
pub fn list() -> Vec<Item> {
    let mut out = Vec::new();
    for (root, top) in roots() {
        for e in fs::read_dir(root.join("info")).into_iter().flatten().flatten() {
            let file = e.file_name().to_string_lossy().into_owned();
            let Some(name) = file.strip_suffix(".trashinfo") else { continue };
            let text = fs::read_to_string(e.path()).unwrap_or_default();
            let field = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)).map(str::trim);
            let Some(path) = field("Path=") else { continue };
            let path = PathBuf::from(folder::unescape(path));
            let from = match &top {
                Some(top) if path.is_relative() => top.join(path),
                _ => path,
            };
            let binned = Binned { root: root.clone(), name: name.to_string(), from };
            let Ok(m) = binned.file().symlink_metadata() else { continue };
            out.push(Item { when: field("DeletionDate=").and_then(unstamp).unwrap_or(0), dir: m.is_dir(), binned });
        }
    }
    out.sort_by_key(|i| std::cmp::Reverse(i.when));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_dates() {
        assert_eq!(nth("song.opus", 1), "song.opus");
        assert_eq!(nth("song.opus", 2), "song.2.opus");
        assert_eq!(nth(".bashrc", 3), ".bashrc.3");
        assert_eq!(nth("Folder", 2), "Folder.2");
        let t = now();
        assert_eq!(unstamp(&stamp(t)), Some(t));
    }

    #[test]
    fn bin_and_back() {
        let dir = std::env::temp_dir().join(format!("mp-files-bin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Trash")).unwrap();
        // SAFETY: this test alone reads XDG_DATA_HOME.
        unsafe { std::env::set_var("XDG_DATA_HOME", &dir) };
        let file = dir.join("a b.txt");
        fs::write(&file, "hi").unwrap();
        let one = bin(&file).unwrap();
        fs::write(&file, "again").unwrap();
        let two = bin(&file).unwrap();
        assert_eq!((one.name.as_str(), two.name.as_str()), ("a b.txt", "a b.2.txt"));
        let info = fs::read_to_string(two.info()).unwrap();
        assert!(info.contains("Path=") && info.contains("a%20b.txt"), "{info}");
        let listed = list();
        assert!(listed.iter().any(|i| i.binned == one) && listed.iter().any(|i| i.binned == two));
        restore(&two).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "again");
        assert!(restore(&one).is_err(), "never over another");
        forget(&one).unwrap();
        assert!(!one.file().exists() && !one.info().exists());
        // Fable Sweep F3: a file copied over a folder of its name, Replace: the folder
        // goes to the Bin with what's in it (it used to be deleted for good).
        fs::create_dir_all(dir.join("to/Notes")).unwrap();
        fs::write(dir.join("to/Notes/diary.txt"), "years").unwrap();
        fs::write(dir.join("Notes"), "a file").unwrap();
        let (tx, mut rx) = iced::futures::channel::mpsc::unbounded();
        let (atx, arx) = std::sync::mpsc::channel();
        atx.send((crate::ops::Pick::Replace, false)).unwrap();
        crate::ops::run(crate::ops::Kind::Copy, vec![(dir.join("Notes"), dir.join("to/Notes"))], tx, arx, Default::default());
        assert!(matches!(rx.try_recv(), Ok(crate::ops::News::Size(_))));
        assert!(matches!(rx.try_recv(), Ok(crate::ops::News::Clash { dir: false, bins: true, .. })));
        assert_eq!(fs::read_to_string(dir.join("to/Notes")).unwrap(), "a file");
        let kept = list().into_iter().find(|i| i.binned.from == dir.join("to/Notes")).expect("the folder is in the Bin");
        assert_eq!(fs::read_to_string(kept.binned.file().join("diary.txt")).unwrap(), "years");
        fs::remove_dir_all(&dir).unwrap();
    }
}
