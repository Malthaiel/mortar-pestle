//! Recents (File Explorer plan step 2; his words: "a screen that shows recent things
//! done in the file explorer as well as undo buttons"): every action, kept 30 days
//! in `$XDG_STATE_HOME/mp-files/recents` (a JSON line each, saved whole on a
//! change). Undo is offered only while the files are still where the action left
//! them; an undone line offers Redo the same way. A deletion forever has neither.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::bin::{self, Binned};
use crate::ops::Kind;

/// Lines older than this drop off (his pick).
const KEEP: i64 = 30 * 24 * 3600;

#[derive(Debug, Clone)]
pub enum Act {
    /// Copied or moved, the top-level pairs as they landed.
    Put(Kind, Vec<(PathBuf, PathBuf)>),
    Rename(PathBuf, PathBuf),
    /// A new folder.
    Make(PathBuf),
    Bin(Vec<Binned>),
    Restore(Vec<Binned>),
    Delete(Vec<PathBuf>),
}

#[derive(Debug, Clone)]
pub struct Line {
    /// Its number in this run (not saved): what Undo and a job point at.
    pub id: u64,
    pub at: i64,
    pub act: Act,
    pub undone: bool,
    /// What an undo put in the Bin (copies, a new folder), for a redo to bring back.
    pub parked: Vec<Binned>,
    pub errors: Vec<String>,
    pub stopped: bool,
    /// The copy or move merged with, replaced or only partly joined what was
    /// there: no Undo (it would take the old things along with the new).
    pub mixed: bool,
}

/// What an undo or redo needs the window to do: nothing more, or a move job (a move
/// across drives copies, so it runs as any other).
pub enum Then {
    Done,
    Job(Kind, Vec<(PathBuf, PathBuf)>),
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn there(p: &Path) -> bool {
    p.symlink_metadata().is_ok()
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

/// `“name”` for one, "N items" for more.
fn things(names: &[String]) -> String {
    match names {
        [one] => format!("\u{201c}{one}\u{201d}"),
        many => format!("{} items", many.len()),
    }
}

impl Line {
    pub fn new(act: Act) -> Self {
        Self { id: 0, at: now(), act, undone: false, parked: Vec::new(), errors: Vec::new(), stopped: false, mixed: false }
    }

    /// The line as people read it.
    pub fn words(&self) -> String {
        match &self.act {
            Act::Put(kind, pairs) => {
                let names: Vec<String> = pairs.iter().map(|(f, _)| name(f)).collect();
                let to = pairs.first().and_then(|(_, t)| t.parent()).map(name).unwrap_or_default();
                let verb = if *kind == Kind::Copy { "Copied" } else { "Moved" };
                format!("{verb} {} to {to}", things(&names))
            }
            Act::Rename(from, to) => format!("Renamed \u{201c}{}\u{201d} to \u{201c}{}\u{201d}", name(from), name(to)),
            Act::Make(p) => format!("New folder \u{201c}{}\u{201d}", name(p)),
            Act::Bin(b) => format!("Moved {} to the Bin", things(&b.iter().map(|b| name(&b.from)).collect::<Vec<_>>())),
            Act::Restore(b) => format!("Restored {}", things(&b.iter().map(|b| name(&b.from)).collect::<Vec<_>>())),
            Act::Delete(p) => format!("Deleted {} forever", things(&p.iter().map(|p| name(p)).collect::<Vec<_>>())),
        }
    }

    /// Everything is still where the action left it.
    pub fn can_undo(&self) -> bool {
        !self.undone && self.blocked().is_none()
    }

    /// Everything is still where the undo left it.
    pub fn can_redo(&self) -> bool {
        self.undone && self.blocked().is_none()
    }

    /// Why its button (Undo, or Redo once undone) can't be used now, in plain words:
    /// the first thing no longer where the action (or the undo) left it.
    pub fn blocked(&self) -> Option<String> {
        let gone = |p: &Path| (!there(p)).then(|| format!("\u{201c}{}\u{201d} was moved or deleted", name(p)));
        let taken = |p: &Path| there(p).then(|| format!("another \u{201c}{}\u{201d} is there now", name(p)));
        let unbinned = |b: &Binned| (!there(&b.file())).then(|| format!("\u{201c}{}\u{201d} is no longer in the Bin", name(&b.from)));
        let none = |empty: bool| empty.then(|| "nothing was done".to_string());
        if self.mixed && !self.undone {
            return Some("it merged with or replaced what was there".into());
        }
        if !self.undone {
            return match &self.act {
                Act::Put(Kind::Copy, pairs) => none(pairs.is_empty()).or_else(|| pairs.iter().find_map(|(_, t)| gone(t))),
                Act::Put(Kind::Move, pairs) => none(pairs.is_empty()).or_else(|| pairs.iter().find_map(|(f, t)| gone(t).or_else(|| taken(f)))),
                Act::Rename(f, t) => gone(t).or_else(|| taken(f)),
                Act::Make(p) => (!p.is_dir()).then(|| format!("\u{201c}{}\u{201d} was moved or deleted", name(p))),
                Act::Bin(b) => none(b.is_empty()).or_else(|| b.iter().find_map(|b| unbinned(b).or_else(|| taken(&b.from)))),
                Act::Restore(b) => none(b.is_empty()).or_else(|| b.iter().find_map(|b| gone(&b.from))),
                Act::Delete(_) => Some("deleted forever".into()),
            };
        }
        match &self.act {
            Act::Put(Kind::Copy, _) | Act::Make(_) => none(self.parked.is_empty()).or_else(|| self.parked.iter().find_map(|b| unbinned(b).or_else(|| taken(&b.from)))),
            Act::Put(Kind::Move, pairs) => pairs.iter().find_map(|(f, t)| gone(f).or_else(|| taken(t))),
            Act::Rename(f, t) => gone(f).or_else(|| taken(t)),
            Act::Bin(b) => b.iter().find_map(|b| gone(&b.from)),
            Act::Restore(b) => b.iter().find_map(|b| unbinned(b).or_else(|| taken(&b.from))),
            Act::Delete(_) => Some("deleted forever".into()),
        }
    }

    /// Undoes it (the caller checked `can_undo`). Copies and a new folder go to the
    /// Bin rather than away for good, so a redo can bring them back.
    pub fn undo(&mut self) -> Result<Then, String> {
        let then = match &mut self.act {
            Act::Put(Kind::Copy, pairs) => {
                self.parked = pairs.iter().map(|(_, t)| bin::bin(t)).collect::<Result<_, _>>().map_err(|e| crate::ops::plain(&e))?;
                Then::Done
            }
            Act::Put(Kind::Move, pairs) => Then::Job(Kind::Move, pairs.iter().map(|(f, t)| (t.clone(), f.clone())).collect()),
            Act::Rename(f, t) => {
                fs::rename(&*t, &*f).map_err(|e| crate::ops::plain(&e))?;
                Then::Done
            }
            Act::Make(p) => {
                self.parked = vec![bin::bin(p).map_err(|e| crate::ops::plain(&e))?];
                Then::Done
            }
            Act::Bin(b) => {
                b.iter().try_for_each(bin::restore).map_err(|e| crate::ops::plain(&e))?;
                Then::Done
            }
            // Binned again: new names in the Bin, kept for the redo.
            Act::Restore(b) => {
                *b = b.iter().map(|b| bin::bin(&b.from)).collect::<Result<_, _>>().map_err(|e| crate::ops::plain(&e))?;
                Then::Done
            }
            Act::Delete(_) => return Err("can't be undone".into()),
        };
        self.undone = true;
        Ok(then)
    }

    /// Does it again (the caller checked `can_redo`).
    pub fn redo(&mut self) -> Result<Then, String> {
        let then = match &mut self.act {
            Act::Put(Kind::Copy, _) | Act::Make(_) => {
                self.parked.iter().try_for_each(bin::restore).map_err(|e| crate::ops::plain(&e))?;
                self.parked.clear();
                Then::Done
            }
            Act::Put(Kind::Move, pairs) => Then::Job(Kind::Move, pairs.clone()),
            Act::Rename(f, t) => {
                fs::rename(&*f, &*t).map_err(|e| crate::ops::plain(&e))?;
                Then::Done
            }
            Act::Bin(b) => {
                *b = b.iter().map(|b| bin::bin(&b.from)).collect::<Result<_, _>>().map_err(|e| crate::ops::plain(&e))?;
                Then::Done
            }
            Act::Restore(b) => {
                b.iter().try_for_each(bin::restore).map_err(|e| crate::ops::plain(&e))?;
                Then::Done
            }
            Act::Delete(_) => return Err("can't be done again".into()),
        };
        self.undone = false;
        Ok(then)
    }
}

fn path(v: &Value) -> PathBuf {
    PathBuf::from(v.as_str().unwrap_or_default())
}

fn s(p: &Path) -> Value {
    Value::String(p.to_string_lossy().into_owned())
}

fn binned_json(b: &[Binned]) -> Value {
    b.iter().map(|b| json!({ "root": s(&b.root), "name": b.name, "from": s(&b.from) })).collect()
}

fn binned_back(v: &Value) -> Vec<Binned> {
    v.as_array().into_iter().flatten().map(|b| Binned { root: path(&b["root"]), name: b["name"].as_str().unwrap_or_default().into(), from: path(&b["from"]) }).collect()
}

fn pairs_json(p: &[(PathBuf, PathBuf)]) -> Value {
    p.iter().map(|(f, t)| json!([s(f), s(t)])).collect()
}

fn pairs_back(v: &Value) -> Vec<(PathBuf, PathBuf)> {
    v.as_array().into_iter().flatten().map(|p| (path(&p[0]), path(&p[1]))).collect()
}

impl Line {
    fn json(&self) -> Value {
        let mut v = json!({ "at": self.at, "undone": self.undone, "parked": binned_json(&self.parked), "errors": self.errors, "stopped": self.stopped, "mixed": self.mixed });
        let (kind, rest) = match &self.act {
            Act::Put(Kind::Copy, p) => ("copy", json!({ "pairs": pairs_json(p) })),
            Act::Put(Kind::Move, p) => ("move", json!({ "pairs": pairs_json(p) })),
            Act::Rename(f, t) => ("rename", json!({ "from": s(f), "to": s(t) })),
            Act::Make(p) => ("make", json!({ "path": s(p) })),
            Act::Bin(b) => ("bin", json!({ "items": binned_json(b) })),
            Act::Restore(b) => ("restore", json!({ "items": binned_json(b) })),
            Act::Delete(p) => ("delete", json!({ "paths": p.iter().map(|p| s(p)).collect::<Vec<_>>() })),
        };
        v["act"] = kind.into();
        for (k, x) in rest.as_object().into_iter().flatten() {
            v[k] = x.clone();
        }
        v
    }

    fn back(v: &Value) -> Option<Self> {
        let act = match v["act"].as_str()? {
            "copy" => Act::Put(Kind::Copy, pairs_back(&v["pairs"])),
            "move" => Act::Put(Kind::Move, pairs_back(&v["pairs"])),
            "rename" => Act::Rename(path(&v["from"]), path(&v["to"])),
            "make" => Act::Make(path(&v["path"])),
            "bin" => Act::Bin(binned_back(&v["items"])),
            "restore" => Act::Restore(binned_back(&v["items"])),
            "delete" => Act::Delete(v["paths"].as_array().into_iter().flatten().map(path).collect()),
            _ => return None,
        };
        Some(Self {
            id: 0,
            at: v["at"].as_i64()?,
            act,
            undone: v["undone"].as_bool().unwrap_or(false),
            parked: binned_back(&v["parked"]),
            errors: v["errors"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(str::to_string)).collect(),
            stopped: v["stopped"].as_bool().unwrap_or(false),
            mixed: v["mixed"].as_bool().unwrap_or(false),
        })
    }
}

fn file() -> PathBuf {
    crate::places::state().join("recents")
}

/// The saved lines, newest first, the ones past 30 days left out.
pub fn load() -> Vec<Line> {
    let since = now() - KEEP;
    let mut out: Vec<Line> = fs::read_to_string(file()).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).filter_map(|v| Line::back(&v)).filter(|l| l.at >= since).collect();
    out.reverse();
    out
}

/// Saves them whole (oldest first), written beside and moved over (never half a file).
pub fn save(lines: &[Line]) {
    let since = now() - KEEP;
    let text: String = lines.iter().rev().filter(|l| l.at >= since).map(|l| l.json().to_string() + "\n").collect();
    let path = file();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let side = path.with_extension("new");
    if fs::write(&side, text).is_ok() {
        let _ = fs::rename(side, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_round_trip() {
        let mut l = Line::new(Act::Put(Kind::Move, vec![("/a/x".into(), "/b/x".into())]));
        l.errors.push("y: you don't have permission".into());
        let back = Line::back(&l.json()).unwrap();
        assert_eq!(back.words(), "Moved \u{201c}x\u{201d} to b");
        assert_eq!(back.errors, l.errors);
        // Fable Sweep F4: a merged copy or move keeps no Undo, and says why.
        l.mixed = true;
        let back = Line::back(&l.json()).unwrap();
        assert!(back.mixed && !back.can_undo());
        assert_eq!(back.blocked().as_deref(), Some("it merged with or replaced what was there"));
        let b = Line::new(Act::Bin(vec![Binned { root: "/t".into(), name: "x.2".into(), from: "/a/x".into() }, Binned { root: "/t".into(), name: "y".into(), from: "/a/y".into() }]));
        let back = Line::back(&b.json()).unwrap();
        assert_eq!(back.words(), "Moved 2 items to the Bin");
        assert!(matches!(&back.act, Act::Bin(v) if v[0].name == "x.2"));
        assert_eq!(Line::new(Act::Rename("/a/x".into(), "/a/y".into())).words(), "Renamed \u{201c}x\u{201d} to \u{201c}y\u{201d}");
    }

    #[test]
    fn undo_and_redo_rename() {
        let d = std::env::temp_dir().join(format!("mp-files-recents-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a"), "").unwrap();
        fs::rename(d.join("a"), d.join("b")).unwrap();
        let mut l = Line::new(Act::Rename(d.join("a"), d.join("b")));
        assert!(l.can_undo() && !l.can_redo());
        l.undo().unwrap();
        assert!(d.join("a").exists() && l.can_redo() && !l.can_undo());
        fs::write(d.join("b"), "").unwrap();
        assert!(!l.can_redo(), "b is taken now");
        assert_eq!(l.blocked().as_deref(), Some("another \u{201c}b\u{201d} is there now"));
        fs::remove_file(d.join("b")).unwrap();
        l.redo().unwrap();
        assert!(d.join("b").exists() && l.can_undo());
        fs::remove_file(d.join("b")).unwrap();
        assert_eq!(l.blocked().as_deref(), Some("\u{201c}b\u{201d} was moved or deleted"));
        fs::remove_dir_all(&d).unwrap();
    }
}
