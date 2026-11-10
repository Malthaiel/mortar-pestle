//! The File Explorer's actions (File Explorer plan step 2): picking (a click, Ctrl,
//! Shift, a box dragged on the empty part), cut / copy / paste, rename, new folder,
//! Move to Bin, Delete Forever, the Bin's Restore and Empty, pinned folders, and
//! Recents' Undo / Redo. Copies and moves run as jobs on their own threads (`ops`),
//! their progress shown on the Recents page, a name clash asked in a box.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use iced::widget::operation;
use iced::{Point, Rectangle, Task, window};
use mp_ui::style::GAP_1;

use crate::bin::{self, Binned};
use crate::open;
use crate::ops::{self, Kind, News, Pick};
use crate::recents::{self, Act, Line, Then};
use crate::{Ask, Band, DRAG_PICTURE, DRAG_PICTURES, DRAG_REST, DRAG_SLIP, Do, Drag, EDGE, Files, GRID, Message, Page, Press, ROWS, Spot, Target, Win, blocking, grid_cells, kind_picture, row_height};

pub struct Job {
    pub id: u64,
    pub kind: Kind,
    pub pairs: Vec<(PathBuf, PathBuf)>,
    pub total: u64,
    pub done: u64,
    pub stop: Arc<AtomicBool>,
    answers: std::sync::mpsc::Sender<(Pick, bool)>,
    window: window::Id,
    /// The Recents line this job undoes or redoes (its errors land there).
    line: Option<u64>,
}

/// A Bin thing's pick key: where it lies in the Bin.
pub fn key(b: &Binned) -> String {
    b.file().to_string_lossy().into_owned()
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// What a typed name can't be (GNOME's words), and whether it may be used: empty,
/// `.` / `..`, a `/`, or taken by another (`old` is the one being renamed); a
/// leading dot is told (it hides the file) but allowed.
pub fn name_note(text: &str, folder: &Path, old: Option<&str>) -> (Option<String>, bool) {
    let t = text.trim();
    if t.is_empty() {
        return (None, false);
    }
    if t == "." || t == ".." {
        return (Some(format!("A file can't be called \u{201c}{t}\u{201d}.")), false);
    }
    if t.contains('/') {
        return (Some("File names can't contain \u{201c}/\u{201d}.".into()), false);
    }
    if old != Some(t) && folder.join(t).symlink_metadata().is_ok() {
        return (Some("A file or folder with that name already exists.".into()), false);
    }
    if t.starts_with('.') {
        return (Some("Names starting with \u{201c}.\u{201d} are hidden.".into()), true);
    }
    (None, true)
}

/// GNOME Files' `SILENT_OPEN_LIMIT`: opening more starts and windows than this asks.
const SILENT_OPEN: usize = 5;

pub fn pins_load() -> Vec<PathBuf> {
    std::fs::read_to_string(crate::places::state().join("pinned")).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(PathBuf::from).collect()
}

impl Files {
    /// How many things the shown page lists.
    pub(crate) fn count(&self, w: &Win) -> usize {
        match w.page {
            Page::Folder => w.shown.len(),
            Page::Bin => self.binned.len(),
            Page::Recents => 0,
        }
    }

    /// The `i`th thing's pick key: a folder's name, a Bin thing's place.
    pub(crate) fn key_at(&self, w: &Win, i: usize) -> Option<String> {
        match w.page {
            Page::Folder => w.shown.get(i).map(|&j| w.entries[j].name.clone()),
            Page::Bin => self.binned.get(i).map(|b| key(&b.binned)),
            Page::Recents => None,
        }
    }

    fn keys(&self, w: &Win) -> Vec<String> {
        (0..self.count(w)).filter_map(|i| self.key_at(w, i)).collect()
    }

    /// The picked things in the shown folder, as paths.
    pub(crate) fn picked_paths(&self, w: &Win) -> Vec<PathBuf> {
        w.shown.iter().map(|&i| &w.entries[i]).filter(|e| w.picked.contains(&e.name)).map(|e| w.folder.join(&e.os)).collect()
    }

    fn picked_binned(&self, w: &Win) -> Vec<Binned> {
        self.binned.iter().filter(|b| w.picked.contains(&key(&b.binned))).map(|b| b.binned.clone()).collect()
    }

    /// Items a line and a line's height on the shown page, as drawn.
    pub(crate) fn layout_of(&self, w: &Win) -> (usize, f32) {
        match w.page {
            Page::Folder | Page::Bin if self.grid => {
                let (columns, _, line) = grid_cells(w.area.width, GRID[self.grid_zoom]);
                (columns, line)
            }
            Page::Recents => (1, crate::RECENT_LINE),
            _ => (1, row_height(ROWS[self.rows_zoom])),
        }
    }

    /// The `i`th thing's box in the list's own space (scrolled to the top).
    pub(crate) fn rect(&self, w: &Win, i: usize) -> Rectangle {
        let (columns, line) = self.layout_of(w);
        if columns > 1 || (w.page != Page::Recents && self.grid) {
            let (_, cell_w, _) = grid_cells(w.area.width, GRID[self.grid_zoom]);
            Rectangle { x: GAP_1 + (i % columns) as f32 * cell_w, y: (i / columns) as f32 * line, width: cell_w - GAP_1, height: line - GAP_1 }
        } else {
            Rectangle { x: GAP_1, y: i as f32 * line, width: w.area.width - 2.0 * GAP_1, height: line - GAP_1 }
        }
    }

    /// A press on the `at`th thing: a click (`pick`), except on one of several picked
    /// with no Ctrl or Shift: they stay picked till the release (GTK's), so they can
    /// be dragged together. In a folder the press may become a drag.
    pub(crate) fn press(&mut self, id: window::Id, at: usize) {
        let Some(w) = self.windows.get(&id) else { return };
        let later = w.page == Page::Folder && !self.held.control() && !self.held.shift() && w.picked.len() > 1 && self.key_at(w, at).is_some_and(|k| w.picked.contains(&k));
        if !later {
            self.pick(id, at);
        }
        let from = mp_ui::drop::pointer();
        if let Some(w) = self.windows.get_mut(&id).filter(|w| w.page == Page::Folder) {
            (w.context, w.menu) = (None, false);
            w.press = Some(Press { at, from, later });
        }
    }

    /// The pointer moves with the button down on a thing: past GTK's 8 px the
    /// press becomes a drag of what's picked. A drag follows the pointer, finds
    /// where it would land, starts the half-second rest again when that changes or
    /// the pointer slips 8 px, and scrolls the list at its edge (GTK's).
    pub(crate) fn drag_move(&mut self, id: window::Id, p: Point) -> Task<Message> {
        let Some(w) = self.windows.get(&id) else { return Task::none() };
        if let Some(press) = w.press {
            if press.from.distance(p) < DRAG_SLIP {
                return Task::none();
            }
            let paths = self.picked_paths(w);
            let pictures = w.shown.iter().map(|&i| &w.entries[i]).filter(|e| w.picked.contains(&e.name)).take(DRAG_PICTURES).map(|e| kind_picture(e.kind, DRAG_PICTURE, &self.colours)).collect();
            let drag = (!paths.is_empty()).then(|| Drag { paths, from: w.folder.clone(), pictures, at: p, over: None, rest: (p, 0) });
            let w = self.windows.get_mut(&id).unwrap();
            (w.press, w.drag, w.hover) = (None, drag, None);
        }
        let Some(w) = self.windows.get(&id) else { return Task::none() };
        let Some(d) = &w.drag else { return Task::none() };
        let over = self.spot_at(w, p).filter(|s| match s {
            // Not onto a thing dragged or inside one, nor the folder they're in.
            Spot::Folder(f) => !d.paths.iter().any(|x| f.starts_with(x)) && *f != d.from,
            Spot::Bin => true,
        });
        let inside = w.area.contains(p);
        let edge = if inside { edge(w, p) } else { 0.0 };
        self.rests += 1;
        let n = self.rests;
        let w = self.windows.get_mut(&id).unwrap();
        w.edge = edge;
        let d = w.drag.as_mut().unwrap();
        d.at = p;
        let again = over != d.over || d.rest.0.distance(p) >= DRAG_SLIP;
        d.over = over;
        if !again || !matches!(d.over, Some(Spot::Folder(_))) {
            return Task::none();
        }
        d.rest = (p, n);
        Task::perform(blocking(|| std::thread::sleep(DRAG_REST)), move |()| Message::Rest(id, n))
    }

    /// Where the pointer would drop: a folder in the list (as drawn), the shown
    /// folder on the list's empty part or a file, else the left column's row or
    /// the path's piece under it.
    fn spot_at(&self, w: &Win, p: Point) -> Option<Spot> {
        if w.page != Page::Folder || !w.area.contains(p) {
            return w.spot.clone();
        }
        let q = Point::new(p.x - w.area.x, p.y - w.area.y + w.offset);
        let (columns, line) = self.layout_of(w);
        let first = (q.y / line).floor().max(0.0) as usize * columns;
        let hit = (first..(first + columns).min(w.shown.len())).find(|&i| self.rect(w, i).contains(q));
        match hit.map(|i| &w.entries[w.shown[i]]) {
            Some(e) if e.dir => Some(Spot::Folder(w.folder.join(&e.os))),
            _ => Some(Spot::Folder(w.folder.clone())),
        }
    }

    /// A drag's rest ran out still on the same folder: it opens (GNOME's), the
    /// drag going on inside it.
    pub(crate) fn rest(&mut self, id: window::Id, n: u64) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        let Some(d) = w.drag.as_mut().filter(|d| d.rest.1 == n) else { return Task::none() };
        let Some(Spot::Folder(f)) = d.over.clone() else { return Task::none() };
        if f == w.folder {
            return Task::none();
        }
        d.over = None;
        self.go(id, f, true)
    }

    /// The button comes up: a press that waited picks its thing alone; a drag drops
    /// where it is: the Bin bins, a folder takes a move on the same drive when the
    /// first thing may leave its folder, else a copy (GNOME's), Ctrl a copy, Shift a
    /// move, as a job with its Recents line.
    pub(crate) fn drag_end(&mut self, id: window::Id) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        w.edge = 0.0;
        if let Some(press) = w.press.take() {
            if press.later {
                self.pick(id, press.at);
            }
            return Task::none();
        }
        let Some(d) = w.drag.take() else { return Task::none() };
        match d.over {
            Some(Spot::Bin) => self.bin_paths(id, d.paths),
            Some(Spot::Folder(to)) => {
                let kind = if self.held.control() {
                    Kind::Copy
                } else if self.held.shift() {
                    Kind::Move
                } else {
                    ops::dropped(&d.paths[0], &to)
                };
                return self.start_job(id, kind, ops::pairs(&d.paths, &to, kind), None);
            }
            None => {}
        }
        Task::none()
    }

    /// Things to the Bin, one Recents line for them all.
    fn bin_paths(&mut self, id: window::Id, paths: Vec<PathBuf>) {
        let (mut done, mut errors) = (Vec::new(), Vec::new());
        for p in paths {
            match bin::bin(&p) {
                Ok(b) => done.push(b),
                Err(e) => errors.push(format!("{}: {}", name(&p), ops::plain(&e))),
            }
        }
        if let Some(w) = self.windows.get_mut(&id) {
            w.picked.clear();
        }
        let mut line = Line::new(Act::Bin(done));
        line.errors = errors;
        self.log(line);
    }

    /// A click on the `at`th thing (GNOME's): alone; Ctrl adds or drops it; Shift
    /// takes the run from the last one clicked.
    pub(crate) fn pick(&mut self, id: window::Id, at: usize) {
        let Some(w) = self.windows.get(&id) else { return };
        let keys = self.keys(w);
        let (ctrl, shift) = (self.held.control(), self.held.shift());
        let Some(w) = self.windows.get_mut(&id) else { return };
        let Some(k) = keys.get(at).cloned() else { return };
        (w.context, w.menu) = (None, false);
        match w.anchor.as_ref().and_then(|a| keys.iter().position(|x| x == a)).filter(|_| shift) {
            Some(from) => {
                if !ctrl {
                    w.picked.clear();
                }
                w.picked.extend(keys[from.min(at)..=from.max(at)].iter().cloned());
            }
            None if ctrl => {
                if !w.picked.remove(&k) {
                    w.picked.insert(k.clone());
                }
                w.anchor = Some(k.clone());
            }
            None => {
                w.picked = HashSet::from([k.clone()]);
                w.anchor = Some(k.clone());
            }
        }
        w.lead = Some(k);
    }

    /// Arrows (`by` 2 = a grid line): the lead moves and is picked alone, or with
    /// Shift the run from where it started; kept in sight.
    pub(crate) fn step(&mut self, id: window::Id, by: i64) -> Task<Message> {
        let Some(w) = self.windows.get(&id) else { return Task::none() };
        let (keys, (columns, line)) = (self.keys(w), self.layout_of(w));
        let shift = self.held.shift();
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        if keys.is_empty() {
            return Task::none();
        }
        let now = w.lead.as_ref().and_then(|l| keys.iter().position(|k| k == l));
        let by = if by.abs() == 2 { by.signum() * columns as i64 } else { by };
        let to = match now {
            None => 0,
            Some(n) => (n as i64 + by).clamp(0, keys.len() as i64 - 1) as usize,
        };
        w.lead = Some(keys[to].clone());
        match w.anchor.as_ref().and_then(|a| keys.iter().position(|k| k == a)).filter(|_| shift) {
            Some(from) => w.picked = keys[from.min(to)..=from.max(to)].iter().cloned().collect(),
            None => {
                w.picked = HashSet::from([keys[to].clone()]);
                w.anchor = Some(keys[to].clone());
            }
        }
        sight(w, (to / columns) as f32 * line, line).unwrap_or_else(Task::none)
    }

    /// A thing picked before its folder was read (another program's "show in
    /// folder", a file typed as an address) is scrolled into sight, once: when
    /// the names have come and the list has been measured.
    pub(crate) fn reveal(&mut self, id: window::Id) -> Option<Task<Message>> {
        let w = self.windows.get(&id).filter(|w| w.reveal && !w.loading && w.area.width > 0.0)?;
        let (columns, line) = self.layout_of(w);
        let at = w.lead.as_ref().and_then(|l| (0..self.count(w)).find(|&i| self.key_at(w, i).as_ref() == Some(l)));
        let w = self.windows.get_mut(&id)?;
        w.reveal = false;
        sight(w, (at? / columns) as f32 * line, line)
    }

    /// A press on the empty part: the picks go (unless Ctrl), a box starts.
    pub(crate) fn band_start(&mut self, id: window::Id) {
        let ctrl = self.held.control();
        let p = mp_ui::drop::pointer();
        let Some(w) = self.windows.get_mut(&id) else { return };
        (w.context, w.menu) = (None, false);
        if w.page == Page::Recents {
            return;
        }
        if !ctrl {
            w.picked.clear();
        }
        let at = Point::new(p.x - w.area.x, p.y - w.area.y + w.offset);
        w.band = Some(Band { from: at, to: at, base: w.picked.clone() });
    }

    /// The box follows the pointer; what it touches is picked (with what was before
    /// it, when it began with Ctrl). Only the lines it spans are looked at.
    pub(crate) fn band_move(&mut self, id: window::Id, p: Point) {
        let Some(w) = self.windows.get(&id) else { return };
        let Some(band) = &w.band else { return };
        let to = Point::new(p.x - w.area.x, p.y - w.area.y + w.offset);
        let r = Band::rect(band.from, to);
        let (columns, line) = self.layout_of(w);
        let first = (r.y / line).floor().max(0.0) as usize * columns;
        let last = ((((r.y + r.height) / line).floor().max(0.0) as usize) + 1) * columns;
        let mut picked = band.base.clone();
        for i in first..last.min(self.count(w)) {
            if self.rect(w, i).intersects(&r)
                && let Some(k) = self.key_at(w, i)
            {
                picked.insert(k);
            }
        }
        let edge = edge(w, p);
        let Some(w) = self.windows.get_mut(&id) else { return };
        (w.picked, w.edge) = (picked, edge);
        if let Some(b) = &mut w.band {
            b.to = to;
        }
    }

    /// A right click: on a thing not picked, it alone is picked first; on the empty
    /// part the picks go (GNOME's); the menu opens at the pointer.
    pub(crate) fn right(&mut self, id: window::Id, at: Option<usize>) {
        let Some(w) = self.windows.get(&id) else { return };
        let k = at.and_then(|i| self.key_at(w, i));
        let Some(w) = self.windows.get_mut(&id) else { return };
        match k {
            Some(k) => {
                if !w.picked.contains(&k) {
                    w.picked = HashSet::from([k.clone()]);
                    (w.anchor, w.lead) = (Some(k.clone()), Some(k));
                }
            }
            None => w.picked.clear(),
        }
        w.menu = false;
        w.context = Some((mp_ui::drop::pointer(), if at.is_some() { Target::Picks } else { Target::Here }));
    }

    fn focus_field(w: &Win, select: Option<usize>) -> Task<Message> {
        let id = w.field_id.clone();
        let place = match select {
            Some(n) => operation::select_range(id.clone(), 0, n),
            None => operation::select_all(id.clone()),
        };
        Task::batch([operation::focus(id), place])
    }

    pub(crate) fn act(&mut self, id: window::Id, d: Do) -> Task<Message> {
        if let Some(w) = self.windows.get_mut(&id) {
            (w.context, w.menu) = (None, false);
        }
        let Some(w) = self.windows.get(&id) else { return Task::none() };
        match d {
            Do::Open if w.page == Page::Folder => {
                let picked = w.shown.iter().map(|&i| &w.entries[i]).filter(|e| w.picked.contains(&e.name)).map(|e| (w.folder.join(&e.os), e.dir)).collect();
                return self.open_all(id, picked, true);
            }
            Do::Cut | Do::Copy if w.page == Page::Folder => {
                let paths = self.picked_paths(w);
                if !paths.is_empty() {
                    let kind = if d == Do::Cut { Kind::Move } else { Kind::Copy };
                    self.cut = if kind == Kind::Move { paths.iter().cloned().collect() } else { HashSet::new() };
                    // The paths as text on the desktop clipboard too, so a paste in
                    // another program's text box gives them (files as files: step 8).
                    let text = paths.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>().join("\n");
                    self.clipboard = Some((kind, paths));
                    return iced::clipboard::write(text);
                }
            }
            Do::Paste if w.page == Page::Folder => {
                let Some((kind, paths)) = self.clipboard.clone() else { return Task::none() };
                let pairs = ops::pairs(&paths, &w.folder, kind);
                // A cut is pasted once (GNOME's).
                if kind == Kind::Move {
                    (self.clipboard, self.cut) = (None, HashSet::new());
                }
                return self.start_job(id, kind, pairs, None);
            }
            Do::Rename if w.page == Page::Folder && w.picked.len() == 1 => {
                let Some(old) = w.picked.iter().next().cloned() else { return Task::none() };
                let stem = match old.rsplit_once('.') {
                    Some((s, _)) if !s.is_empty() && !w.folder.join(&old).is_dir() => s.chars().count(),
                    _ => old.chars().count(),
                };
                let w = self.windows.get_mut(&id).unwrap();
                w.ask = Some(Ask::Rename { text: old.clone(), old, error: None });
                return Self::focus_field(w, Some(stem));
            }
            Do::NewFolder if w.page == Page::Folder => {
                let w = self.windows.get_mut(&id).unwrap();
                w.ask = Some(Ask::NewFolder { text: String::new(), error: None });
                return Self::focus_field(w, None);
            }
            Do::All => {
                let all: HashSet<String> = self.keys(w).into_iter().collect();
                self.windows.get_mut(&id).unwrap().picked = all;
            }
            Do::Bin if w.page == Page::Folder => self.bin_paths(id, self.picked_paths(w)),
            Do::Delete | Do::Bin if w.page == Page::Bin => {
                let items = self.picked_binned(w);
                if !items.is_empty() {
                    self.windows.get_mut(&id).unwrap().ask = Some(Ask::Forget(items));
                }
            }
            Do::Delete if w.page == Page::Folder => {
                let paths = self.picked_paths(w);
                if !paths.is_empty() {
                    self.windows.get_mut(&id).unwrap().ask = Some(Ask::Delete(paths));
                }
            }
            Do::Restore if w.page == Page::Bin => {
                let (mut done, mut errors) = (Vec::new(), Vec::new());
                for b in self.picked_binned(w) {
                    match bin::restore(&b) {
                        Ok(()) => done.push(b),
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => errors.push(format!("{}: something else is there now", name(&b.from))),
                        Err(e) => errors.push(format!("{}: {}", name(&b.from), ops::plain(&e))),
                    }
                }
                self.windows.get_mut(&id).unwrap().picked.clear();
                let mut line = Line::new(Act::Restore(done));
                line.errors = errors;
                self.log(line);
            }
            Do::Empty if !self.binned.is_empty() => self.windows.get_mut(&id).unwrap().ask = Some(Ask::Empty),
            Do::Pin => {
                // The one folder picked, else the folder shown (Ctrl+D, GNOME's).
                let picked = self.picked_paths(w);
                let folder = match picked.as_slice() {
                    [one] if one.is_dir() => one.clone(),
                    _ if w.page == Page::Folder => w.folder.clone(),
                    _ => return Task::none(),
                };
                if !self.pins.contains(&folder) {
                    self.pins.push(folder);
                    self.save_pins();
                }
            }
            Do::Unpin(i) => {
                if i < self.pins.len() {
                    self.pins.remove(i);
                    self.save_pins();
                }
            }
            Do::Undo => {
                // The newest line that can be undone: one that can't (deleted for
                // ever, its files moved since) doesn't stand in the way.
                if let Some(line) = self.recents.iter().find(|l| l.can_undo()).map(|l| l.id) {
                    return self.undo_line(id, line, false);
                }
            }
            Do::Redo => {
                if let Some(&line) = self.redo.last() {
                    return self.undo_line(id, line, true);
                }
            }
            _ => {}
        }
        Task::none()
    }

    /// Opens what's picked (GNOME Files' `activate_files`): the files with their
    /// programs, one start a program; one folder here, several each in a window of
    /// its own (GNOME's tabs: step 5); more than five starts and windows asks first.
    pub(crate) fn open_all(&mut self, id: window::Id, picked: Vec<(PathBuf, bool)>, ask: bool) -> Task<Message> {
        let mut dirs: Vec<PathBuf> = picked.iter().filter(|(_, dir)| *dir).map(|(p, _)| p.clone()).collect();
        let files: Vec<PathBuf> = picked.iter().filter(|(_, dir)| !*dir).map(|(p, _)| p.clone()).collect();
        let (groups, mut errors) = open::group(&files);
        let windows = groups.len() + if dirs.len() > 1 { dirs.len() } else { 0 };
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        if ask && windows > SILENT_OPEN {
            w.ask = Some(Ask::OpenAll(picked, windows));
            return Task::none();
        }
        // GNOME's box, over the folder (it showed in the folder's place before).
        errors.extend(open::start(groups));
        if let Some((name, words)) = errors.into_iter().next() {
            w.ask = Some(Ask::Note(format!("Could Not Display \u{201c}{name}\u{201d}"), words));
        }
        match dirs.len() {
            0 => Task::none(),
            1 => self.go(id, dirs.remove(0), true),
            _ => Task::batch(dirs.into_iter().map(|d| self.window(d, None)).collect::<Vec<_>>()),
        }
    }

    /// The box's main choice (or Enter).
    pub(crate) fn confirm(&mut self, id: window::Id) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        let Some(ask) = w.ask.clone() else { return Task::none() };
        match ask {
            Ask::Rename { old, text, .. } => {
                let text = text.trim().to_string();
                if !name_note(&text, &w.folder, Some(&old)).1 {
                    return Task::none();
                }
                w.ask = None;
                if text == old {
                    return Task::none();
                }
                let (from, to) = (w.folder.join(&old), w.folder.join(&text));
                match std::fs::rename(&from, &to) {
                    Ok(()) => {
                        w.picked = HashSet::from([text.clone()]);
                        (w.anchor, w.lead) = (Some(text.clone()), Some(text));
                        self.log(Line::new(Act::Rename(from, to)));
                    }
                    Err(e) => w.ask = Some(Ask::Rename { old, text, error: Some(ops::plain(&e)) }),
                }
            }
            Ask::NewFolder { text, .. } => {
                let text = text.trim().to_string();
                if !name_note(&text, &w.folder, None).1 {
                    return Task::none();
                }
                let path = w.folder.join(&text);
                match std::fs::create_dir(&path) {
                    Ok(()) => {
                        w.ask = None;
                        w.picked = HashSet::from([text.clone()]);
                        (w.anchor, w.lead) = (Some(text.clone()), Some(text));
                        self.log(Line::new(Act::Make(path)));
                    }
                    Err(e) => w.ask = Some(Ask::NewFolder { text, error: Some(ops::plain(&e)) }),
                }
            }
            // Gone for good, off the drawing thread (a big folder takes a while).
            Ask::Delete(paths) => {
                (w.ask, w.picked) = (None, HashSet::new());
                self.deleting += 1;
                return Task::perform(
                    blocking(move || {
                        let (mut done, mut errors) = (Vec::new(), Vec::new());
                        for p in paths {
                            match bin::delete(&p) {
                                Ok(()) => done.push(p),
                                Err(e) => errors.push(format!("{}: {}", name(&p), ops::plain(&e))),
                            }
                        }
                        let mut line = Line::new(Act::Delete(done));
                        line.errors = errors;
                        line
                    }),
                    Message::Logged,
                );
            }
            Ask::Forget(items) => {
                (w.ask, w.picked) = (None, HashSet::new());
                self.deleting += 1;
                return Task::perform(blocking(move || forget(items)), Message::Logged);
            }
            Ask::Empty => {
                w.ask = None;
                self.deleting += 1;
                let items: Vec<Binned> = self.binned.iter().map(|b| b.binned.clone()).collect();
                return Task::perform(blocking(move || forget(items)), Message::Logged);
            }
            Ask::Clash { .. } => self.answer(id, Some(Pick::Replace)),
            Ask::OpenAll(picked, _) => {
                w.ask = None;
                return self.open_all(id, picked, false);
            }
            Ask::Note(..) => w.ask = None,
        }
        Task::none()
    }

    /// A clash box's choice: `None` stops the copy.
    pub(crate) fn answer(&mut self, id: window::Id, pick: Option<Pick>) {
        let Some(w) = self.windows.get_mut(&id) else { return };
        let Some(Ask::Clash { job, all, .. }) = w.ask.take() else { return };
        if let Some(j) = self.jobs.iter().find(|j| j.id == job) {
            match pick {
                Some(p) => {
                    let _ = j.answers.send((p, all));
                }
                None => j.stop.store(true, Ordering::Relaxed),
            }
        }
    }

    pub(crate) fn start_job(&mut self, window: window::Id, kind: Kind, pairs: Vec<(PathBuf, PathBuf)>, line: Option<u64>) -> Task<Message> {
        if pairs.is_empty() {
            return Task::none();
        }
        self.jobs_made += 1;
        let n = self.jobs_made;
        let (tx, rx) = iced::futures::channel::mpsc::unbounded();
        let (answers, heard) = std::sync::mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let (p, s) = (pairs.clone(), stop.clone());
        std::thread::spawn(move || ops::run(kind, p, tx, heard, s));
        self.jobs.push(Job { id: n, kind, pairs, total: 0, done: 0, stop, answers, window, line });
        Task::run(rx, move |news| Message::Job(n, news))
    }

    pub(crate) fn job_news(&mut self, n: u64, news: News) -> Task<Message> {
        let Some(at) = self.jobs.iter().position(|j| j.id == n) else { return Task::none() };
        match news {
            News::Size(t) => self.jobs[at].total = t,
            News::Done(d) => self.jobs[at].done = d,
            News::Clash { to, dir, bins } => self.ask_clash(Ask::Clash { job: n, to, dir, bins, all: false }),
            News::Finished { made, errors, stopped, mixed } => {
                let job = self.jobs.remove(at);
                for w in self.windows.values_mut() {
                    if matches!(&w.ask, Some(Ask::Clash { job, .. }) if *job == n) {
                        w.ask = None;
                    }
                }
                match job.line.and_then(|l| self.recents.iter_mut().find(|x| x.id == l)) {
                    Some(line) => {
                        line.errors.extend(errors);
                        line.stopped |= stopped;
                        recents::save(&self.recents);
                        self.refresh_can();
                    }
                    None if !made.is_empty() || !errors.is_empty() => {
                        let mut line = Line::new(Act::Put(job.kind, made));
                        (line.errors, line.stopped, line.mixed) = (errors, stopped, mixed);
                        self.log(line);
                    }
                    None => {}
                }
                return self.leave();
            }
        }
        Task::none()
    }

    /// Shows a job's clash box: in the job's window, else in another (the job's
    /// from then on); with no window left, what's there stays. Also where a box
    /// goes when its window shuts (Fable Sweep F6: the copy waited for ever).
    pub(crate) fn ask_clash(&mut self, ask: Ask) {
        let Ask::Clash { job: n, .. } = &ask else { return };
        let Some(job) = self.jobs.iter_mut().find(|j| j.id == *n) else { return };
        let shown = if self.windows.contains_key(&job.window) { Some(job.window) } else { self.windows.keys().next().copied() };
        match shown.and_then(|id| Some((id, self.windows.get_mut(&id)?))) {
            Some((id, w)) => (job.window, w.ask) = (id, Some(ask)),
            None => {
                let _ = job.answers.send((Pick::Skip, true));
            }
        }
    }

    /// The program goes with its last window, once no copy or delete still runs.
    pub(crate) fn leave(&self) -> Task<Message> {
        if self.windows.is_empty() && self.jobs.is_empty() && self.deleting == 0 { iced::exit() } else { Task::none() }
    }

    /// A new Recents line: kept, saved, and the redo list starts again.
    pub(crate) fn log(&mut self, mut line: Line) {
        self.lines_made += 1;
        line.id = self.lines_made;
        self.recents.insert(0, line);
        self.redo.clear();
        recents::save(&self.recents);
        self.refresh_can();
        self.refresh_bin();
    }

    /// Why each line's Undo or Redo can't be used now (none: it can), for a window
    /// showing Recents.
    pub(crate) fn refresh_can(&mut self) {
        self.can = if self.windows.values().any(|w| w.page == Page::Recents) { self.recents.iter().map(Line::blocked).collect() } else { Vec::new() };
    }

    pub(crate) fn refresh_bin(&mut self) {
        if self.windows.values().any(|w| w.page == Page::Bin) {
            self.binned = bin::list();
            let keys: HashSet<String> = self.binned.iter().map(|b| key(&b.binned)).collect();
            for w in self.windows.values_mut().filter(|w| w.page == Page::Bin) {
                w.picked.retain(|k| keys.contains(k));
            }
        }
    }

    pub(crate) fn undo_line(&mut self, id: window::Id, line: u64, redo: bool) -> Task<Message> {
        let Some(l) = self.recents.iter_mut().find(|l| l.id == line) else { return Task::none() };
        if !(if redo { l.can_redo() } else { l.can_undo() }) {
            return Task::none();
        }
        let then = match if redo { l.redo() } else { l.undo() } {
            Ok(then) => then,
            Err(e) => {
                l.errors.push(e);
                Then::Done
            }
        };
        if redo {
            self.redo.retain(|x| *x != line);
        } else {
            self.redo.push(line);
        }
        recents::save(&self.recents);
        let task = match then {
            Then::Done => Task::none(),
            Then::Job(kind, pairs) => self.start_job(id, kind, pairs, Some(line)),
        };
        self.refresh_can();
        self.refresh_bin();
        task
    }

    pub(crate) fn save_pins(&self) {
        let path = crate::places::state().join("pinned");
        let _ = std::fs::create_dir_all(crate::places::state());
        let text: String = self.pins.iter().map(|p| p.to_string_lossy().into_owned() + "\n").collect();
        let _ = std::fs::write(path, text);
    }
}

/// Out of the Bin for good: the Recents line of it.
fn forget(items: Vec<Binned>) -> Line {
    let (mut done, mut errors) = (Vec::new(), Vec::new());
    for b in items {
        match bin::forget(&b) {
            Ok(()) => done.push(b.from),
            Err(e) => errors.push(format!("{}: {}", name(&b.from), ops::plain(&e))),
        }
    }
    let mut line = Line::new(Act::Delete(done));
    line.errors = errors;
    line
}

/// Scrolls the list just far enough to show the line at `top`; none when it shows.
fn sight(w: &Win, top: f32, line: f32) -> Option<Task<Message>> {
    let y = if top < w.offset {
        top
    } else if top + line > w.offset + w.area.height {
        top + line - w.area.height
    } else {
        return None;
    };
    Some(operation::scroll_to(w.list.clone(), iced::widget::scrollable::AbsoluteOffset { x: None, y: Some(y.max(0.0)) }))
}

/// GTK's edge scroll (`update_autoscroll`): within 30 px of the list's top or
/// bottom (or past it, for a box), a third of how deep, a frame.
fn edge(w: &Win, p: Point) -> f32 {
    let y = p.y - w.area.y;
    if y < EDGE {
        -(EDGE - y) / 3.0
    } else if w.area.height - y < EDGE {
        (EDGE - (w.area.height - y)) / 3.0
    } else {
        0.0
    }
}
