//! The File Explorer (`mp-files`, File Explorer plan step 1): GNOME Files 51.1's
//! window held to the Native UI rulebook. The left column of places, the top bar
//! (back and forward, the path as pieces, the view button with its menu), and the
//! folder as a grid of big pictures or as rows, only what's on screen built
//! (folders of 21,036 files). One program for every window; gone with the last.

mod acts;
mod bin;
mod bus;
mod folder;
mod kind;
mod open;
mod ops;
mod pages;
mod places;
mod recents;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use iced::keyboard::{Key, Modifiers, key::Named};
use iced::widget::{Id, column, container, image, mouse_area, operation, row, scrollable, space, stack, text, text_input};
use iced::{Alignment, Color, Element, Length, Point, Rectangle, Size, Subscription, Task, border, mouse, window};
use mp_ui::bar::{self, Bar};
use mp_ui::colours::{self, Colours};
use mp_ui::drop::{self, Item};
use mp_ui::icon::Pair;
use mp_ui::measured::measured;
use mp_ui::seam::{self, Seam};
use mp_ui::style::{BODY, CONTROL, CORNER, FADED, GAP_1, GAP_2, GAP_3, HOVER, ICON, LINE_TIGHT, SMALL};
use mp_ui::{BOLD_TTF, FONT_TTF, MEDIUM};

use folder::{Entry, Sort};
use kind::{KINDS, Kind};

/// GNOME's picture sizes (`nautilus-enums.h`, his OK 2026-11-03): the grid starts
/// at 96, rows at 32.
const GRID: [u32; 5] = [48, 64, 96, 168, 256];
const ROWS: [u32; 3] = [16, 32, 64];
/// GNOME's window (`nautilus-window.blp`) and its sidebar: a fifth of the window,
/// libadwaita's 180-280 (`AdwOverlaySplitView`).
const WINDOW: Size = Size::new(890.0, 550.0);
const SIDE_MIN: f32 = 180.0;
const SIDE_MAX: f32 = 280.0;
/// The rows' size and date columns.
const SIZE_W: f32 = 110.0;
const DATE_W: f32 = 130.0;
/// GTK's drag threshold (`gtk-dnd-drag-threshold`), GNOME Files' rest before a
/// folder opens under a drag (`HOVER_TIMEOUT`) and its drag pictures' size
/// (`NAUTILUS_DRAG_SURFACE_ICON_SIZE`), up to four (`MAX_DRAWN_DRAG_ICONS`).
const DRAG_SLIP: f32 = 8.0;
const DRAG_REST: std::time::Duration = std::time::Duration::from_millis(500);
const DRAG_PICTURE: u32 = 64;
const DRAG_PICTURES: usize = 4;
/// GTK's list edge that scrolls under a drag or a dragged box (`SCROLL_EDGE_SIZE`):
/// a third of how deep the pointer is in it, a frame.
const EDGE: f32 = 30.0;

fn main() -> iced::Result {
    mp_ui::only_our_font();
    colours::hold();
    // SAFETY: plain C calls, before any thread starts. Big blocks go straight back to
    // the system and every thread shares one memory pile (M&P Chat's), so what a
    // folder's reading thread frees isn't kept apart (measured 2026-11-03: a
    // 21,036-file folder opened and shut left 12-14 MB more each time).
    unsafe {
        libc::mallopt(libc::M_MMAP_THRESHOLD, 131_072);
        libc::mallopt(libc::M_ARENA_MAX, 1);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let service = args.iter().any(|a| a == "--bus");
    let first = args.iter().find(|a| !a.starts_with("--")).map(|a| folder::from_arg(a)).unwrap_or_else(places::home);
    if bus::take().is_err() {
        if !service {
            bus::show(&first);
        }
        return Ok(());
    }
    let start = (!service).then_some(first);
    iced::daemon(move || Files::new(start.clone()), Files::update, Files::view)
        .title(Files::title)
        .subscription(Files::subscription)
        .style(|s: &Files, _| iced::theme::Style { background_color: s.colours.frame, text_color: s.colours.text })
        .settings(iced::Settings { fonts: vec![FONT_TTF.into(), BOLD_TTF.into()], default_font: MEDIUM, default_text_size: BODY.into(), ..Default::default() })
        .run()
}

struct Pictures {
    kinds: Vec<Pair>,
    places: Vec<Pair>,
    back: Pair,
    forward: Pair,
    grid: Pair,
    rows: Pair,
    down: Pair,
    bigger: Pair,
    smaller: Pair,
    sorts: [Pair; 6],
    eye: Pair,
    check: Pair,
    history: Pair,
    trash: Pair,
    trash_x: Pair,
    pinned: Pair,
    pin: Pair,
    unpin: Pair,
    open: Pair,
    cut: Pair,
    copy: Pair,
    paste: Pair,
    rename: Pair,
    folder_plus: Pair,
    select_all: Pair,
    undo: Pair,
    stop: Pair,
    checkbox: Pair,
    checked: Pair,
}

impl Pictures {
    fn new(c: &Colours, size: u32) -> Self {
        let p = |data: &[u8]| Pair::new(data, ICON, c.text, c.on_accent);
        let kinds = KINDS.iter().map(|&kind| kind_picture(kind, size, c)).collect();
        Self {
            kinds,
            places: vec![
                p(include_bytes!("../assets/bx-home.svg")),
                p(include_bytes!("../assets/bx-file-detail.svg")),
                p(include_bytes!("../assets/bx-folder-down-arrow.svg")),
                p(include_bytes!("../assets/bx-music.svg")),
                p(include_bytes!("../assets/bx-image.svg")),
                p(include_bytes!("../assets/bx-film.svg")),
            ],
            back: p(include_bytes!("../assets/bx-chevron-left.svg")),
            forward: p(include_bytes!("../assets/bx-chevron-right.svg")),
            grid: p(include_bytes!("../assets/bx-grid.svg")),
            rows: p(include_bytes!("../assets/bx-list-ul.svg")),
            down: p(include_bytes!("../assets/bx-chevron-down.svg")),
            bigger: p(include_bytes!("../assets/bx-plus-circle.svg")),
            smaller: p(include_bytes!("../assets/bx-minus-circle.svg")),
            sorts: [
                p(include_bytes!("../assets/bx-arrow-down-a-z.svg")),
                p(include_bytes!("../assets/bx-arrow-up-a-z.svg")),
                p(include_bytes!("../assets/bx-calendar.svg")),
                p(include_bytes!("../assets/bx-calendar-alt.svg")),
                p(include_bytes!("../assets/bx-layers.svg")),
                p(include_bytes!("../assets/bx-tag.svg")),
            ],
            eye: p(include_bytes!("../assets/bx-eye.svg")),
            check: p(include_bytes!("../assets/bx-check.svg")),
            history: p(include_bytes!("../assets/bx-history.svg")),
            trash: p(include_bytes!("../assets/bx-trash.svg")),
            trash_x: p(include_bytes!("../assets/bx-trash-x.svg")),
            pinned: p(include_bytes!("../assets/bx-folder.svg")),
            pin: p(include_bytes!("../assets/bx-pin.svg")),
            unpin: p(include_bytes!("../assets/bx-pin-slash-alt.svg")),
            open: p(include_bytes!("../assets/bx-folder-open.svg")),
            cut: p(include_bytes!("../assets/bx-cut.svg")),
            copy: p(include_bytes!("../assets/bx-copy.svg")),
            paste: p(include_bytes!("../assets/bx-paste.svg")),
            rename: p(include_bytes!("../assets/bx-rename.svg")),
            folder_plus: p(include_bytes!("../assets/bx-folder-plus.svg")),
            select_all: p(include_bytes!("../assets/bx-select-all.svg")),
            undo: p(include_bytes!("../assets/bx-undo.svg")),
            stop: p(include_bytes!("../assets/bx-stop.svg")),
            checkbox: p(include_bytes!("../assets/bx-checkbox.svg")),
            checked: p(include_bytes!("../assets/bx-checkbox-checked.svg")),
        }
    }
}

/// A kind's picture at `size`, in the list's colours.
fn kind_picture(kind: Kind, size: u32, c: &Colours) -> Pair {
    let data: &[u8] = match kind {
        Kind::Folder => include_bytes!("../assets/bx-folder.svg"),
        Kind::Text => include_bytes!("../assets/bx-file-detail.svg"),
        Kind::Code => include_bytes!("../assets/bx-file-code.svg"),
        Kind::Image => include_bytes!("../assets/bx-image.svg"),
        Kind::Audio => include_bytes!("../assets/bx-music.svg"),
        Kind::Video => include_bytes!("../assets/bx-film.svg"),
        Kind::Archive => include_bytes!("../assets/bx-file-zip.svg"),
        Kind::Book => include_bytes!("../assets/bx-book.svg"),
        Kind::Package => include_bytes!("../assets/bx-package.svg"),
        Kind::File => include_bytes!("../assets/bx-file.svg"),
    };
    Pair::new(data, size, c.text_muted, c.on_accent)
}

const SORTS: [(Sort, &str); 6] = [(Sort::Az, "A-Z"), (Sort::Za, "Z-A"), (Sort::Newest, "Last Modified"), (Sort::Oldest, "First Modified"), (Sort::Size, "Size"), (Sort::Type, "Type")];

/// What a window shows: a folder, or one of the left column's two pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Page {
    Folder,
    Recents,
    Bin,
}

/// A Recents line's height: the default bar (its Undo) and the gap under it.
const RECENT_LINE: f32 = bar::THICK + GAP_1;

/// A box over the window (`mp_ui::ask`).
#[derive(Debug, Clone)]
enum Ask {
    Rename {
        old: String,
        text: String,
        error: Option<String>,
    },
    NewFolder {
        text: String,
        error: Option<String>,
    },
    Delete(Vec<PathBuf>),
    Forget(Vec<bin::Binned>),
    Empty,
    Clash {
        job: u64,
        to: PathBuf,
        dir: bool,
        /// A file onto a folder or the other way: Replace bins what's there.
        bins: bool,
        all: bool,
    },
    /// Opening the picks (path, folder) would make this many starts and windows.
    OpenAll(Vec<(PathBuf, bool)>, usize),
    /// A box that only tells (a title, its words): a click off it or Esc closes it.
    Note(String, String),
}

/// A box dragged on the empty part, in the list's own space; `base` what was
/// picked when it began (kept with Ctrl).
#[derive(Debug, Clone)]
struct Band {
    from: Point,
    to: Point,
    base: HashSet<String>,
}

impl Band {
    fn rect(a: Point, b: Point) -> Rectangle {
        Rectangle { x: a.x.min(b.x), y: a.y.min(b.y), width: (a.x - b.x).abs(), height: (a.y - b.y).abs() }
    }
}

/// A press on a thing in a folder: which, where, and whether picking it alone
/// waits for the release (it was one of several picked: they drag together).
#[derive(Debug, Clone, Copy)]
struct Press {
    at: usize,
    from: Point,
    later: bool,
}

/// Where a drag would land: a folder, or the Bin.
#[derive(Debug, Clone, PartialEq)]
enum Spot {
    Folder(PathBuf),
    Bin,
}

/// Things dragged inside the window (GNOME Files'): their paths and the folder they
/// came from, up to four pictures, the pointer, the spot it would land on, and
/// the rest that opens a folder (where it began, its number).
#[derive(Debug, Clone)]
struct Drag {
    paths: Vec<PathBuf>,
    from: PathBuf,
    pictures: Vec<Pair>,
    at: Point,
    over: Option<Spot>,
    rest: (Point, u64),
}

/// The actions, from the keys and the right-click menus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Do {
    Open,
    Cut,
    Copy,
    Paste,
    Rename,
    NewFolder,
    All,
    Bin,
    Delete,
    Restore,
    Empty,
    Pin,
    Unpin(usize),
    Undo,
    Redo,
}

/// What a right click was on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Picks,
    Here,
    Pin(usize),
}

struct Win {
    page: Page,
    folder: PathBuf,
    back: Vec<(Page, PathBuf)>,
    forward: Vec<(Page, PathBuf)>,
    /// Every entry, sorted; `shown` the ones the hidden switch lets through.
    entries: Vec<Entry>,
    shown: Vec<usize>,
    /// The picked things (a folder's names, the Bin's places; kept across a re-read),
    /// where Shift's run starts, and where the arrows are.
    picked: HashSet<String>,
    anchor: Option<String>,
    lead: Option<String>,
    band: Option<Band>,
    press: Option<Press>,
    drag: Option<Drag>,
    /// The left column's row or the path's piece under the pointer.
    spot: Option<Spot>,
    /// The left column's row held to drag a pin into a new place.
    lifted: Option<usize>,
    /// How far the list scrolls a frame while a drag or a box is at its edge.
    edge: f32,
    ask: Option<Ask>,
    field_id: Id,
    context: Option<(Point, Target)>,
    hover: Option<usize>,
    error: Option<String>,
    /// Which read is current: an older one's answer is dropped.
    read: u64,
    /// A new folder is being read: the last one stays shown until its names come
    /// (no "Folder is empty" flash, yazi's way), then the list starts at the top.
    loading: bool,
    /// The lead was picked before the folder was read: scroll to it once it's in.
    reveal: bool,
    list: Id,
    offset: f32,
    area: Rectangle,
    size: Size,
    seam: Seam,
    view_button: Rectangle,
    menu: bool,
    /// Ctrl+L: the address being typed in place of the path's pieces; `bad` when
    /// Enter found nothing there (till the next letter).
    address: Option<String>,
    bad: bool,
    address_id: Id,
}

struct Files {
    colours: Colours,
    pictures: Pictures,
    places: Vec<places::Place>,
    windows: HashMap<window::Id, Win>,
    grid: bool,
    grid_zoom: usize,
    rows_zoom: usize,
    sort: Sort,
    hidden: bool,
    reads: u64,
    /// Ctrl / Shift / Alt as held now.
    held: Modifiers,
    clipboard: Option<(ops::Kind, Vec<PathBuf>)>,
    /// What was cut, drawn faded till it's pasted.
    cut: HashSet<PathBuf>,
    jobs: Vec<acts::Job>,
    jobs_made: u64,
    /// Deletes for ever still running off the drawing thread.
    deleting: usize,
    recents: Vec<recents::Line>,
    lines_made: u64,
    /// Per line, why its Undo / Redo can't be used now (none: it can), for a window
    /// on Recents.
    can: Vec<Option<String>>,
    /// Lines undone, newest last: Ctrl+Shift+Z redoes from the end.
    redo: Vec<u64>,
    binned: Vec<bin::Item>,
    pins: Vec<PathBuf>,
    rests: u64,
}

#[derive(Debug, Clone)]
enum Message {
    Bus(bus::Call),
    Opened,
    Closed(window::Id),
    Resized(window::Id, Size),
    Colours,
    Go(window::Id, PathBuf),
    Back(window::Id),
    Forward(window::Id),
    Listed(window::Id, u64, Result<Vec<Entry>, String>),
    Detailed(window::Id, u64, Vec<(std::ffi::OsString, folder::Details)>),
    Changed(window::Id),
    Pick(window::Id, usize),
    Open(window::Id, usize),
    Hover(window::Id, Option<usize>),
    Scrolled(window::Id, f32),
    Area(window::Id, Rectangle),
    ViewButton(window::Id, Rectangle),
    Key(window::Id, Key, Modifiers),
    Mouse(window::Id, mouse::Button),
    Toggle,
    Menu(window::Id, bool),
    Zoom(i32),
    Sort(Sort),
    Hidden,
    Seam(window::Id, seam::Message),
    Typed(window::Id, String),
    Submit(window::Id),
    Pressed(window::Id),
    Focused(window::Id, bool),
    Page(window::Id, Page),
    Held(Modifiers),
    Right(window::Id, Option<usize>),
    PinMenu(window::Id, usize),
    Context(window::Id),
    Do(window::Id, Do),
    BandStart(window::Id),
    BandMove(window::Id, Point),
    BandEnd(window::Id),
    DragMove(window::Id, Point),
    DragEnd(window::Id),
    /// A drag rested this long on a folder (the rest's number).
    Rest(window::Id, u64),
    /// The pointer went onto (`true`) or off a left-column row or a path piece.
    Spot(window::Id, Spot, bool),
    /// A frame, while a list scrolls at its edge.
    Tick,
    /// A left-column row held up to drag (its place in the column).
    Lift(window::Id, usize),
    /// A pin let go: from, to, among the pins.
    MovePin(window::Id, usize, usize),
    /// A box closes (`false`) .
    Ask(window::Id),
    Field(window::Id, String),
    Confirm(window::Id),
    All(window::Id),
    Clash(window::Id, Option<ops::Pick>),
    Job(u64, ops::News),
    Stop(u64),
    /// Undo (`false`) or redo a Recents line.
    Line(window::Id, u64, bool),
    Logged(recents::Line),
    BinChanged,
    Nothing,
}

impl Files {
    fn new(start: Option<PathBuf>) -> (Self, Task<Message>) {
        let colours = colours::load();
        let mut recents = recents::load();
        for (i, l) in recents.iter_mut().rev().enumerate() {
            l.id = i as u64 + 1;
        }
        let lines_made = recents.len() as u64;
        let mut files = Self {
            pictures: Pictures::new(&colours, GRID[2]),
            colours,
            places: places::load(),
            windows: HashMap::new(),
            grid: true,
            grid_zoom: 2,
            rows_zoom: 1,
            sort: Sort::Az,
            hidden: false,
            reads: 0,
            held: Modifiers::empty(),
            clipboard: None,
            cut: HashSet::new(),
            jobs: Vec::new(),
            jobs_made: 0,
            deleting: 0,
            recents,
            lines_made,
            can: Vec::new(),
            redo: Vec::new(),
            binned: Vec::new(),
            pins: acts::pins_load(),
            rests: 0,
        };
        let task = start.map(|p| files.window(p, None)).unwrap_or_else(Task::none);
        (files, task)
    }

    fn title(&self, id: window::Id) -> String {
        match self.windows.get(&id) {
            Some(w) if w.page == Page::Recents => "Recents".into(),
            Some(w) if w.page == Page::Bin => "Bin".into(),
            Some(w) => show_name(&w.folder),
            None => "File Explorer".into(),
        }
    }

    fn picture_size(&self) -> u32 {
        if self.grid { GRID[self.grid_zoom] } else { ROWS[self.rows_zoom] }
    }

    /// A new window on `folder`, `pick` (a name in it) picked and scrolled to.
    fn window(&mut self, folder: PathBuf, pick: Option<String>) -> Task<Message> {
        let settings = window::Settings { size: WINDOW, platform_specific: window::settings::PlatformSpecific { application_id: "mp-files".into(), ..Default::default() }, ..Default::default() };
        let (id, open) = window::open(settings);
        let side = (WINDOW.width * 0.2).clamp(SIDE_MIN, SIDE_MAX);
        let win = Win {
            page: Page::Folder,
            folder: folder.clone(),
            back: Vec::new(),
            forward: Vec::new(),
            entries: Vec::new(),
            shown: Vec::new(),
            picked: pick.iter().cloned().collect(),
            anchor: pick.clone(),
            reveal: pick.is_some(),
            lead: pick,
            band: None,
            press: None,
            drag: None,
            spot: None,
            lifted: None,
            edge: 0.0,
            ask: None,
            field_id: Id::unique(),
            context: None,
            hover: None,
            error: None,
            read: 0,
            loading: true,
            list: Id::unique(),
            offset: 0.0,
            area: Rectangle::default(),
            size: WINDOW,
            seam: Seam::new(side),
            view_button: Rectangle::default(),
            menu: false,
            address: None,
            bad: false,
            address_id: Id::unique(),
        };
        self.windows.insert(id, win);
        Task::batch([open.map(|_| Message::Opened), self.read(id)])
    }

    /// Reads the window's folder: the names, then (a second message) the details.
    fn read(&mut self, id: window::Id) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        self.reads += 1;
        w.read = self.reads;
        let (n, folder) = (self.reads, w.folder.clone());
        Task::perform(blocking(move || folder::list(&folder)), move |r| Message::Listed(id, n, r))
    }

    fn refilter(&mut self, id: window::Id) {
        let (sort, hidden) = (self.sort, self.hidden);
        let Some(w) = self.windows.get_mut(&id) else { return };
        folder::order(&mut w.entries, sort);
        w.shown = (0..w.entries.len()).filter(|&i| hidden || !w.entries[i].hidden).collect();
        w.hover = None;
    }

    fn go(&mut self, id: window::Id, to: PathBuf, history: bool) -> Task<Message> {
        self.show(id, Page::Folder, to, history)
    }

    /// Shows a folder or a page; a new folder is read (the last one stays on screen
    /// till its names come), a page starts at the top.
    fn show(&mut self, id: window::Id, page: Page, to: PathBuf, history: bool) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        if page == w.page && to == w.folder {
            return Task::none();
        }
        if history {
            w.back.push((w.page, w.folder.clone()));
            w.forward.clear();
        }
        let new = to != w.folder;
        (w.page, w.folder) = (page, to);
        (w.picked, w.anchor, w.lead, w.band, w.menu, w.context, w.address) = (HashSet::new(), None, None, None, false, None, None);
        // A drag goes on in the new folder; a press waiting to pick doesn't.
        w.press = None;
        if page == Page::Folder && new {
            w.loading = true;
            return self.read(id);
        }
        (w.offset, w.hover) = (0.0, None);
        let top = operation::scroll_to(w.list.clone(), scrollable::AbsoluteOffset { x: None, y: Some(0.0) });
        self.refresh_can();
        self.refresh_bin();
        top
    }

    fn open(&mut self, id: window::Id, at: usize) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id).filter(|w| w.page == Page::Folder) else { return Task::none() };
        let Some(e) = w.shown.get(at).map(|&i| &w.entries[i]) else { return Task::none() };
        let one = vec![(w.folder.join(&e.os), e.dir)];
        self.open_all(id, one, false)
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Bus(bus::Call::Folders(paths)) => return Task::batch(paths.into_iter().map(|p| self.window(p, None))),
            Message::Bus(bus::Call::Items(paths)) => {
                let tasks: Vec<Task<Message>> = paths
                    .into_iter()
                    .map(|p| {
                        let parent = p.parent().map(Path::to_path_buf).unwrap_or_else(places::home);
                        self.window(parent, p.file_name().map(|n| n.to_string_lossy().into_owned()))
                    })
                    .collect();
                return Task::batch(tasks);
            }
            Message::Opened => {}
            Message::Closed(id) => {
                // A clash box shut with its window is asked again in another.
                if let Some(ask @ Ask::Clash { .. }) = self.windows.remove(&id).and_then(|w| w.ask) {
                    self.ask_clash(ask);
                }
                return self.leave();
            }
            Message::Resized(id, size) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.size = size;
                    let max = (size.width * 0.5).max(SIDE_MIN);
                    if w.seam.to() > max {
                        w.seam.go(max);
                    }
                }
            }
            Message::Colours => {
                self.colours = colours::load();
                self.pictures = Pictures::new(&self.colours, self.picture_size());
            }
            Message::Go(id, to) => return self.go(id, to, true),
            Message::Back(id) => {
                if let Some(w) = self.windows.get_mut(&id)
                    && let Some(to) = w.back.pop()
                {
                    w.forward.push((w.page, w.folder.clone()));
                    return self.show(id, to.0, to.1, false);
                }
            }
            Message::Forward(id) => {
                if let Some(w) = self.windows.get_mut(&id)
                    && let Some(to) = w.forward.pop()
                {
                    w.back.push((w.page, w.folder.clone()));
                    return self.show(id, to.0, to.1, false);
                }
            }
            Message::Listed(id, n, result) => {
                let Some(w) = self.windows.get_mut(&id).filter(|w| w.read == n) else { return Task::none() };
                match result {
                    Ok(entries) => {
                        let keep: HashMap<std::ffi::OsString, folder::Details> = w.entries.iter().filter_map(|e| Some((e.os.clone(), e.details?))).collect();
                        w.entries = entries;
                        // A re-read of the same folder keeps the sizes it had till the new ones come.
                        if !w.loading {
                            for e in &mut w.entries {
                                e.details = keep.get(&e.os).copied();
                            }
                        }
                        w.error = None;
                    }
                    Err(e) => (w.entries, w.error) = (Vec::new(), Some(e)),
                }
                let top = if std::mem::take(&mut w.loading) {
                    (w.offset, w.hover) = (0.0, None);
                    operation::scroll_to(w.list.clone(), scrollable::AbsoluteOffset { x: None, y: Some(0.0) })
                } else {
                    Task::none()
                };
                let (folder, names): (PathBuf, Vec<(std::ffi::OsString, bool)>) = (w.folder.clone(), w.entries.iter().map(|e| (e.os.clone(), e.dir)).collect());
                self.refilter(id);
                // The list starts at the top, or where a thing picked ahead shows.
                let top = self.reveal(id).unwrap_or(top);
                return Task::batch([top, Task::perform(blocking(move || folder::details(&folder, names)), move |d| Message::Detailed(id, n, d))]);
            }
            Message::Detailed(id, n, details) => {
                let Some(w) = self.windows.get_mut(&id).filter(|w| w.read == n) else { return Task::none() };
                folder::fill(&mut w.entries, details);
                self.refilter(id);
            }
            Message::Changed(id) => return self.read(id),
            Message::Pick(id, at) => self.press(id, at),
            Message::Open(id, at) => return self.open(id, at),
            Message::Hover(id, at) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.hover = at;
                }
            }
            Message::Scrolled(id, y) => {
                let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
                w.offset = y;
                // A box or a drag at the edge: what's under the pointer has moved.
                if w.band.is_some() {
                    self.band_move(id, drop::pointer());
                } else if w.drag.is_some() {
                    return self.drag_move(id, drop::pointer());
                }
            }
            Message::Area(id, r) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.area = r;
                }
                return self.reveal(id).unwrap_or_else(Task::none);
            }
            Message::ViewButton(id, r) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.view_button = r;
                }
            }
            Message::Key(id, key, keys) => return self.key(id, key, keys),
            Message::Mouse(id, mouse::Button::Back) => return self.update(Message::Back(id)),
            Message::Mouse(id, mouse::Button::Forward) => return self.update(Message::Forward(id)),
            Message::Mouse(..) => {}
            Message::Toggle => {
                self.grid = !self.grid;
                self.pictures = Pictures::new(&self.colours, self.picture_size());
                for w in self.windows.values_mut() {
                    w.menu = false;
                }
            }
            Message::Menu(id, open) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.menu = open;
                }
            }
            Message::Zoom(by) => {
                let (zoom, most) = if self.grid { (&mut self.grid_zoom, GRID.len() - 1) } else { (&mut self.rows_zoom, ROWS.len() - 1) };
                *zoom = (*zoom as i32 + by).clamp(0, most as i32) as usize;
                self.pictures = Pictures::new(&self.colours, self.picture_size());
            }
            Message::Sort(sort) => {
                self.sort = sort;
                let ids: Vec<window::Id> = self.windows.keys().copied().collect();
                ids.into_iter().for_each(|id| self.refilter(id));
            }
            Message::Hidden => {
                self.hidden = !self.hidden;
                let ids: Vec<window::Id> = self.windows.keys().copied().collect();
                ids.into_iter().for_each(|id| self.refilter(id));
            }
            Message::Seam(id, m) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    let max = (w.size.width * 0.5).max(SIDE_MIN);
                    w.seam.update(m, SIDE_MIN, max);
                }
            }
            Message::Typed(id, t) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    (w.address, w.bad) = (Some(t), false);
                }
            }
            Message::Submit(id) => return self.submit(id),
            // A click off the box (it lets go of the keys): back to the pieces.
            Message::Pressed(id) => {
                if let Some(w) = self.windows.get(&id).filter(|w| w.address.is_some()) {
                    return operation::is_focused(w.address_id.clone()).map(move |on| Message::Focused(id, on));
                }
            }
            Message::Focused(id, on) => {
                if let Some(w) = self.windows.get_mut(&id).filter(|_| !on) {
                    w.address = None;
                }
            }
            Message::Page(id, page) => {
                let folder = self.windows.get(&id).map(|w| w.folder.clone()).unwrap_or_else(places::home);
                return self.show(id, page, folder, true);
            }
            Message::Held(m) => self.held = m,
            Message::Right(id, at) => self.right(id, at),
            Message::PinMenu(id, i) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    (w.menu, w.context) = (false, Some((drop::pointer(), Target::Pin(i))));
                }
            }
            Message::Context(id) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.context = None;
                }
            }
            Message::Do(id, d) => return self.act(id, d),
            Message::BandStart(id) => self.band_start(id),
            Message::BandMove(id, p) => self.band_move(id, p),
            Message::BandEnd(id) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    (w.band, w.edge) = (None, 0.0);
                }
            }
            Message::DragMove(id, p) => return self.drag_move(id, p),
            Message::DragEnd(id) => return self.drag_end(id),
            Message::Rest(id, n) => return self.rest(id, n),
            Message::Spot(id, spot, on) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    // Off one row onto the next can come in either order.
                    if on {
                        w.spot = Some(spot);
                    } else if w.spot.as_ref() == Some(&spot) {
                        w.spot = None;
                    }
                }
            }
            Message::Tick => {
                return Task::batch(self.windows.values().filter(|w| w.edge != 0.0).map(|w| operation::scroll_by(w.list.clone(), scrollable::AbsoluteOffset { x: 0.0, y: w.edge })));
            }
            Message::Lift(id, i) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.lifted = Some(i);
                }
            }
            Message::MovePin(id, from, to) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.lifted = None;
                }
                if from != to && from < self.pins.len() && to < self.pins.len() {
                    let pin = self.pins.remove(from);
                    self.pins.insert(to, pin);
                    self.save_pins();
                }
            }
            Message::Ask(id) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    if matches!(w.ask, Some(Ask::Clash { .. })) {
                        self.answer(id, None);
                    } else {
                        w.ask = None;
                    }
                }
            }
            Message::Field(id, t) => {
                if let Some(w) = self.windows.get_mut(&id)
                    && let Some(Ask::Rename { text, error, .. } | Ask::NewFolder { text, error }) = &mut w.ask
                {
                    (*text, *error) = (t, None);
                }
            }
            Message::Confirm(id) => return self.confirm(id),
            Message::All(id) => {
                if let Some(Ask::Clash { all, .. }) = self.windows.get_mut(&id).and_then(|w| w.ask.as_mut()) {
                    *all = !*all;
                }
            }
            Message::Clash(id, pick) => self.answer(id, pick),
            Message::Job(n, news) => return self.job_news(n, news),
            Message::Stop(n) => {
                if let Some(j) = self.jobs.iter().find(|j| j.id == n) {
                    j.stop.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                for w in self.windows.values_mut() {
                    if matches!(&w.ask, Some(Ask::Clash { job, .. }) if *job == n) {
                        w.ask = None;
                    }
                }
            }
            Message::Line(id, line, redo) => return self.undo_line(id, line, redo),
            Message::Logged(line) => {
                self.deleting = self.deleting.saturating_sub(1);
                self.log(line);
                return self.leave();
            }
            Message::BinChanged => self.refresh_bin(),
            Message::Nothing => {}
        }
        Task::none()
    }

    /// GNOME Files' keys: arrows move the pick, Enter opens it, Backspace and Alt+Up
    /// go up, Alt+Left / Right back and forward, Ctrl+H hidden files, Ctrl+plus and
    /// Ctrl+minus the picture size, Esc closes the menu.
    fn key(&mut self, id: window::Id, key: Key, keys: Modifiers) -> Task<Message> {
        let up = |s: &Self| s.windows.get(&id).filter(|w| w.page == Page::Folder).and_then(|w| w.folder.parent().map(Path::to_path_buf));
        let Some(w) = self.windows.get(&id) else { return Task::none() };
        // A box open: Esc closes it, Enter takes a box with no text box in it.
        if let Some(a) = &w.ask {
            return match key.as_ref() {
                Key::Named(Named::Escape) => self.update(Message::Ask(id)),
                Key::Named(Named::Enter) if matches!(a, Ask::Delete(_) | Ask::Forget(_) | Ask::Empty | Ask::OpenAll(..) | Ask::Note(..)) => self.confirm(id),
                _ => Task::none(),
            };
        }
        let typing = w.address.is_some();
        let ch = match key.as_ref() {
            Key::Character(c) if !typing => Some(c.to_lowercase()),
            _ => None,
        };
        // GNOME Files' action keys.
        let act = match (key.as_ref(), ch.as_deref()) {
            (_, Some("a")) if keys.control() => Some(Do::All),
            (_, Some("c")) if keys.control() => Some(Do::Copy),
            (_, Some("x")) if keys.control() => Some(Do::Cut),
            (_, Some("v")) if keys.control() => Some(Do::Paste),
            (_, Some("z")) if keys.control() && keys.shift() => Some(Do::Redo),
            (_, Some("z")) if keys.control() => Some(Do::Undo),
            (_, Some("n")) if keys.control() && keys.shift() => Some(Do::NewFolder),
            (_, Some("d")) if keys.control() => Some(Do::Pin),
            (Key::Named(Named::F2), _) if !typing => Some(Do::Rename),
            (Key::Named(Named::Delete), _) if !typing && keys.shift() => Some(Do::Delete),
            (Key::Named(Named::Delete), _) if !typing => Some(Do::Bin),
            _ => None,
        };
        if let Some(d) = act {
            return self.act(id, d);
        }
        match key.as_ref() {
            Key::Named(Named::ArrowLeft) if keys.alt() => self.update(Message::Back(id)),
            Key::Named(Named::ArrowRight) if keys.alt() => self.update(Message::Forward(id)),
            Key::Named(Named::ArrowUp) if keys.alt() => up(self).map(|p| self.go(id, p, true)).unwrap_or_else(Task::none),
            Key::Named(Named::Backspace) => up(self).map(|p| self.go(id, p, true)).unwrap_or_else(Task::none),
            Key::Named(Named::ArrowLeft) => self.step(id, -1),
            Key::Named(Named::ArrowRight) => self.step(id, 1),
            Key::Named(Named::ArrowUp) => self.step(id, if self.grid { -2 } else { -1 }),
            Key::Named(Named::ArrowDown) => self.step(id, if self.grid { 2 } else { 1 }),
            Key::Named(Named::Enter) => self.act(id, Do::Open),
            Key::Named(Named::Escape) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    (w.address, w.context, w.band, w.press, w.drag, w.edge) = (None, None, None, None, None, 0.0);
                }
                self.update(Message::Menu(id, false))
            }
            Key::Character("l") if keys.control() => self.address(id, None),
            // GNOME: typing a path's start opens the box with it.
            Key::Character(c @ ("/" | "~")) if !keys.control() && !keys.alt() => self.address(id, Some(c.to_string())),
            Key::Character("h") if keys.control() => self.update(Message::Hidden),
            Key::Character("=" | "+") if keys.control() => self.update(Message::Zoom(1)),
            Key::Character("-") if keys.control() => self.update(Message::Zoom(-1)),
            _ => Task::none(),
        }
    }

    /// Opens the address box: the shown folder's path, all of it picked so typing
    /// replaces it, or `start` typed already (the caret after it).
    fn address(&mut self, id: window::Id, start: Option<String>) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        let select = start.is_none();
        w.address = Some(start.unwrap_or_else(|| w.folder.to_string_lossy().into_owned()));
        (w.bad, w.menu) = (false, false);
        let target = w.address_id.clone();
        let place = if select { operation::select_all(target.clone()) } else { operation::move_cursor_to_end(target.clone()) };
        Task::batch([operation::focus(target), place])
    }

    /// Enter in the address box: a folder opens, a file's folder opens with it
    /// picked; nothing there turns the box the error colour.
    fn submit(&mut self, id: window::Id) -> Task<Message> {
        let Some(w) = self.windows.get_mut(&id) else { return Task::none() };
        let Some(t) = w.address.as_deref() else { return Task::none() };
        let to = folder::typed(t, &w.folder, &places::home());
        let (folder, pick) = match std::fs::metadata(&to) {
            Ok(m) if m.is_dir() => (to, None),
            Ok(_) => match (to.parent(), to.file_name()) {
                (Some(parent), Some(name)) => (parent.to_path_buf(), Some(name.to_string_lossy().into_owned())),
                _ => (to, None),
            },
            Err(_) => {
                w.bad = true;
                return Task::none();
            }
        };
        w.address = None;
        let task = self.go(id, folder, true);
        if let Some(w) = self.windows.get_mut(&id).filter(|_| pick.is_some()) {
            w.picked = pick.iter().cloned().collect();
            (w.anchor, w.lead, w.reveal) = (pick.clone(), pick, true);
        }
        task
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut all = vec![
            bus::calls().map(Message::Bus),
            window::close_events().map(Message::Closed),
            window::resize_events().map(|(id, size)| Message::Resized(id, size)),
            colours::changes().map(|()| Message::Colours),
            iced::event::listen_with(events),
        ];
        // A dragged box follows the pointer till the button comes up.
        if self.windows.values().any(|w| w.band.is_some()) {
            all.push(iced::event::listen_with(|event, _, id| match event {
                iced::Event::Mouse(mouse::Event::CursorMoved { position }) => Some(Message::BandMove(id, position)),
                iced::Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => Some(Message::BandEnd(id)),
                _ => None,
            }));
        }
        // A press on a thing, or its drag, follows the pointer till the button comes up.
        if self.windows.values().any(|w| w.press.is_some() || w.drag.is_some()) {
            all.push(iced::event::listen_with(|event, _, id| match event {
                iced::Event::Mouse(mouse::Event::CursorMoved { position }) => Some(Message::DragMove(id, position)),
                iced::Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => Some(Message::DragEnd(id)),
                _ => None,
            }));
        }
        if self.windows.values().any(|w| w.edge != 0.0) {
            all.push(window::frames().map(|_| Message::Tick));
        }
        // The Bin's own folder watched while a window shows it.
        if let Some((&id, _)) = self.windows.iter().find(|(_, w)| w.page == Page::Bin) {
            all.push(folder::changes(id, bin::home_bin().join("info")).map(|_| Message::BinChanged));
        }
        for (&id, w) in &self.windows {
            all.push(folder::changes(id, w.folder.clone()).map(Message::Changed));
            all.push(w.seam.subscription().with(id).map(|(id, m)| Message::Seam(id, m)));
        }
        Subscription::batch(all)
    }

    fn view(&self, id: window::Id) -> Element<'_, Message> {
        let Some(w) = self.windows.get(&id) else { return space().into() };
        let c = self.colours;
        let body =
            row![container(self.side(id, w)).width(w.seam.width()).height(Length::Fill), w.seam.edge().map(move |m| Message::Seam(id, m)), column![self.top(id, w), self.page(id, w)].spacing(GAP_2).width(Length::Fill),].padding(GAP_2);
        let mut layers: Vec<Element<'_, Message>> = vec![body.into()];
        if w.menu {
            let items = self.menu_items(id);
            let at = iced::Point::new(w.view_button.x + w.view_button.width - drop::width(&items), w.view_button.y + w.view_button.height + GAP_1);
            layers.push(drop::layer(items, Some(&self.pictures.check), c, at, w.size, Message::Menu(id, false)));
        }
        if let Some((at, target)) = w.context {
            let items = self.context_items(id, w, target);
            if !items.is_empty() {
                let place = drop::at_pointer(&items, at, w.size);
                layers.push(drop::layer(items, None, c, place, w.size, Message::Context(id)));
            }
        }
        if let Some(b) = &w.band {
            let r = Band::rect(b.from, b.to);
            let fill = Color { a: HOVER, ..c.text };
            let shape = container(space().width(r.width).height(r.height)).style(move |_| container::Style { background: Some(fill.into()), border: border::width(1).color(c.border), ..Default::default() });
            let placed = container(shape).padding(iced::Padding { left: r.x + w.area.x, top: r.y + w.area.y - w.offset, ..iced::Padding::ZERO });
            layers.push(container(placed).width(Length::Fill).height(Length::Fill).into());
        }
        if let Some(d) = &w.drag {
            layers.push(self.drag_view(d));
        }
        if let Some(a) = &w.ask {
            layers.push(self.ask_view(id, w, a));
        }
        if let Some(l) = w.seam.layer() {
            layers.push(l.map(move |m| Message::Seam(id, m)));
        }
        mp_ui::scroll::smooth(stack(layers).width(Length::Fill).height(Length::Fill))
    }

    /// The top bar: back and forward, the path as pieces, the view button.
    fn top<'a>(&'a self, id: window::Id, w: &'a Win) -> Element<'a, Message> {
        let c = self.colours;
        let pic = &self.pictures;
        let button = |p: &Pair, m: Message, on: bool| -> Element<'a, Message> {
            let item = bar::icon(p.get(false));
            // Nowhere to go: faded, as another month's day.
            if on { mouse_area(item).on_press(m).interaction(mouse::Interaction::Pointer).into() } else { container(image(p.get(false)).width(ICON as f32).height(ICON as f32).opacity(FADED)).center(bar::SLOT).into() }
        };
        let history =
            Bar::new(vec![button(&pic.back, Message::Back(id), !w.back.is_empty()), button(&pic.forward, Message::Forward(id), !w.forward.is_empty())], vec![bar::icon(pic.back.get(true)), bar::icon(pic.forward.get(true))], None, None, &c)
                .across();
        // The path: Home and what's inside it, or the disk's top ("/") down.
        let home = places::home();
        let mut pieces: Vec<(String, PathBuf)> = Vec::new();
        let (start, rest) = match w.folder.strip_prefix(&home) {
            _ if w.page == Page::Recents => (("Recents".to_string(), w.folder.clone()), PathBuf::new()),
            _ if w.page == Page::Bin => (("Bin".to_string(), w.folder.clone()), PathBuf::new()),
            Ok(rest) => (("Home".to_string(), home.clone()), rest.to_path_buf()),
            Err(_) => (("/".to_string(), PathBuf::from("/")), w.folder.strip_prefix("/").map(Path::to_path_buf).unwrap_or_default()),
        };
        pieces.push(start.clone());
        let mut at = start.1;
        for part in rest.iter() {
            at = at.join(part);
            pieces.push((part.to_string_lossy().into_owned(), at.clone()));
        }
        let last = pieces.len() - 1;
        let piece = |name: &str, colour: Color| container(text(name.to_string()).size(BODY).line_height(LINE_TIGHT).color(colour).wrapping(text::Wrapping::None)).padding([0.0, GAP_2]).height(bar::SLOT).align_y(Alignment::Center);
        let plain: Vec<Element<'a, Message>> = pieces
            .iter()
            .enumerate()
            .map(|(i, (name, path))| {
                let spot = (w.page == Page::Folder).then(|| Spot::Folder(path.clone()));
                let m = mouse_area(piece(name, if i == last { c.text } else { c.text_muted })).on_press(Message::Go(id, path.clone())).interaction(mouse::Interaction::Pointer);
                match spot {
                    Some(s) => m.on_enter(Message::Spot(id, s.clone(), true)).on_exit(Message::Spot(id, s, false)).into(),
                    None => m.into(),
                }
            })
            .collect();
        let lit: Vec<Element<'a, Message>> = pieces.iter().map(|(name, _)| piece(name, c.on_accent).into()).collect();
        let path: Element<'a, Message> = match &w.address {
            Some(t) => self.address_box(id, w, t),
            None => container(Bar::new(plain, lit, None, None, &c).across()).width(Length::Fill).clip(true).into(),
        };
        // GNOME's split button: the picture swaps the view, the arrow opens its menu.
        let swap = if self.grid { &pic.rows } else { &pic.grid };
        let view = Bar::new(
            vec![
                mouse_area(bar::icon(swap.get(false))).on_press(Message::Toggle).interaction(mouse::Interaction::Pointer).into(),
                mouse_area(bar::icon(pic.down.get(false))).on_press(Message::Menu(id, !w.menu)).interaction(mouse::Interaction::Pointer).into(),
            ],
            vec![bar::icon(swap.get(true)), bar::icon(pic.down.get(true))],
            None,
            w.menu.then_some(1),
            &c,
        )
        .across();
        let view = measured(view, move |r| Message::ViewButton(id, r));
        let mut top = row![history, path].spacing(GAP_2).align_y(Alignment::Center);
        if w.page == Page::Bin {
            top = top.push(self.word_button("Empty Bin", (!self.binned.is_empty()).then_some(Message::Do(id, Do::Empty))));
        }
        top.push(view).into()
    }

    /// The address box (Ctrl+L): the Library's search box, its whole face accent
    /// while typing, set in the path bar's track so the words start where the
    /// first piece's did; `error` when Enter found nothing.
    fn address_box<'a>(&'a self, id: window::Id, w: &'a Win, typed: &'a str) -> Element<'a, Message> {
        let c = self.colours;
        let face = if w.bad { c.error } else { c.accent };
        let input = text_input("", typed)
            .id(w.address_id.clone())
            .on_input(move |t| Message::Typed(id, t))
            .on_submit(Message::Submit(id))
            .size(BODY)
            .font(MEDIUM)
            .line_height(LINE_TIGHT)
            .padding(0)
            .width(Length::Fill)
            .style(move |_, _| text_input::Style { background: Color::TRANSPARENT.into(), border: border::rounded(0), icon: Color::TRANSPARENT, placeholder: c.on_accent, value: c.on_accent, selection: c.on_accent.scale_alpha(0.3) });
        let field = container(input).padding([0.0, GAP_2]).width(Length::Fill).height(bar::SLOT).align_y(Alignment::Center).style(move |_| container::Style {
            background: Some(face.into()),
            border: border::rounded(bar::SLOT / 2.0),
            ..Default::default()
        });
        container(field).padding(GAP_1).width(Length::Fill).height(bar::THICK).style(move |_| container::Style { background: Some(c.raised.into()), border: border::rounded(bar::THICK / 2.0), ..Default::default() }).into()
    }

    fn menu_items(&self, id: window::Id) -> Vec<Item<'_, Message>> {
        let pic = &self.pictures;
        let entry = |icon: &Pair, label: &'static str, picked: bool, pick: Message| Item::Row(drop::Row { icon: icon.clone(), label, after: None, picked, pick });
        let mut items = vec![entry(&pic.bigger, "Zoom In", false, Message::Zoom(1)), entry(&pic.smaller, "Zoom Out", false, Message::Zoom(-1)), Item::Header("Sort")];
        for (i, (sort, label)) in SORTS.iter().enumerate() {
            items.push(entry(&pic.sorts[i], label, self.sort == *sort, Message::Sort(*sort)));
        }
        items.push(Item::Header("Show"));
        items.push(entry(&pic.eye, "Hidden Files", self.hidden, Message::Hidden));
        let _ = id;
        items
    }

    /// The folder: a Panel box holding the grid or the rows, only what's on screen
    /// built; a word when it's empty or can't be read.
    fn page<'a>(&'a self, id: window::Id, w: &'a Win) -> Element<'a, Message> {
        let c = self.colours;
        let note = |s: String| -> Element<'a, Message> { container(text(s).size(BODY).color(c.text_faint)).center(Length::Fill).into() };
        let inside: Element<'a, Message> = if w.page == Page::Recents {
            self.recents_view(id, w)
        } else if w.page == Page::Bin {
            self.bin_view(id, w)
        } else if let Some(e) = &w.error {
            note(e.clone())
        } else if w.shown.is_empty() && !w.loading {
            note("Folder is empty".into())
        } else if self.grid {
            self.grid_view(id, w)
        } else {
            self.rows_view(id, w)
        };
        // A press on the empty part starts a box; a right click there, its menu.
        let inside = mouse_area(inside).on_press(Message::BandStart(id)).on_right_press(Message::Right(id, None));
        // A drag would land in the shown folder itself: the whole box is outlined.
        let whole = w.drag.as_ref().is_some_and(|d| d.over.as_ref() == Some(&Spot::Folder(w.folder.clone())));
        container(inside).width(Length::Fill).height(Length::Fill).style(move |_| container::Style { background: Some(c.panel.into()), border: landing(whole, c), ..Default::default() }).into()
    }

    /// The folder in this window's list a drag would land on, by name.
    fn landing_name<'a>(&self, w: &'a Win) -> Option<&'a std::ffi::OsStr> {
        match w.drag.as_ref().and_then(|d| d.over.as_ref()) {
            Some(Spot::Folder(f)) if f.parent() == Some(w.folder.as_path()) => f.file_name(),
            _ => None,
        }
    }

    /// A scrolling list of `lines` lines, `line` tall, only those in sight (plus one
    /// each side) built; the rest are empty room.
    fn long<'a>(&'a self, id: window::Id, w: &'a Win, lines: usize, line: f32, draw: impl Fn(usize) -> Element<'a, Message>) -> Element<'a, Message> {
        let first = ((w.offset / line).floor() as usize).saturating_sub(1).min(lines);
        let seen = ((w.area.height.max(w.size.height) / line).ceil() as usize + 3).min(lines - first);
        let mut parts: Vec<Element<'a, Message>> = vec![space().height(first as f32 * line).into()];
        parts.extend((first..first + seen).map(draw));
        parts.push(space().height((lines - first - seen) as f32 * line).into());
        let list = scrollable(column(parts).width(Length::Fill)).id(w.list.clone()).on_scroll(move |v| Message::Scrolled(id, v.absolute_offset().y)).width(Length::Fill).height(Length::Fill);
        measured(mp_ui::scroll::styled(list, self.colours), move |r| Message::Area(id, r)).into()
    }

    /// A cut thing's picture fades till it's pasted (GNOME's).
    fn faded(&self, w: &Win, e: &Entry) -> f32 {
        if !self.cut.is_empty() && self.cut.contains(&w.folder.join(&e.os)) { FADED } else { 1.0 }
    }

    /// A face: the hover patch, or the accent when picked; outlined where a drag
    /// would land.
    fn face<'a>(&self, picked: bool, hover: bool, target: bool, inside: impl Into<Element<'a, Message>>) -> container::Container<'a, Message> {
        let c = self.colours;
        let back = if picked {
            Some(c.accent)
        } else if hover {
            Some(Color { a: HOVER, ..c.text })
        } else {
            None
        };
        container(inside).style(move |_| container::Style { background: back.map(Into::into), border: landing(target, c), ..Default::default() })
    }

    fn cell<'a>(&'a self, id: window::Id, at: usize, inside: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
        mouse_area(inside).on_press(Message::Pick(id, at)).on_double_click(Message::Open(id, at)).on_right_press(Message::Right(id, Some(at))).on_enter(Message::Hover(id, Some(at))).on_exit(Message::Hover(id, None)).into()
    }

    fn grid_view<'a>(&'a self, id: window::Id, w: &'a Win) -> Element<'a, Message> {
        let over = self.landing_name(w);
        self.grid(id, w, w.shown.len(), move |at| {
            let e = &w.entries[w.shown[at]];
            (e.kind, e.name.clone(), w.picked.contains(&e.name), self.faded(w, e), over == Some(e.os.as_os_str()))
        })
    }

    /// GNOME's grid of `n` things, only the lines in sight built: each thing's kind,
    /// name, whether it's picked, its picture's opacity and whether a drag lands on it.
    pub(crate) fn grid<'a>(&'a self, id: window::Id, w: &'a Win, n: usize, thing: impl Fn(usize) -> (Kind, String, bool, f32, bool) + 'a) -> Element<'a, Message> {
        let c = self.colours;
        let side = GRID[self.grid_zoom];
        let (columns, cell_w, line) = grid_cells(w.area.width, side);
        self.long(id, w, n.div_ceil(columns), line, move |l| {
            let cells = (l * columns..((l + 1) * columns).min(n)).map(|at| {
                let (kind, name, picked, opacity, target) = thing(at);
                let colour = if picked { c.on_accent } else { c.text };
                let picture = image(self.pictures.kinds[kind as usize].get(picked)).width(side as f32).height(side as f32).opacity(opacity);
                let name = container(text(name).size(SMALL).line_height(LINE_TIGHT).color(colour).align_x(Alignment::Center).wrapping(text::Wrapping::WordOrGlyph))
                    .width(Length::Fill)
                    .height(3.0 * SMALL * LINE_TIGHT)
                    .clip(true)
                    .align_x(Alignment::Center);
                let inside = column![picture, name].spacing(GAP_1).align_x(Alignment::Center).padding(GAP_2);
                let face = self.face(picked, w.hover == Some(at), target, inside).width(cell_w - GAP_1).height(line - GAP_1);
                self.cell(id, at, face)
            });
            row(cells).spacing(GAP_1).padding([0.0, GAP_1]).height(line).into()
        })
    }

    fn rows_view<'a>(&'a self, id: window::Id, w: &'a Win) -> Element<'a, Message> {
        let c = self.colours;
        let side = ROWS[self.rows_zoom];
        let line = row_height(side);
        let head = |s: &'static str, width: Length| container(text(s).size(SMALL).color(c.text_faint)).width(width);
        let header = row![space().width(side as f32), head("Name", Length::Fill), head("Size", Length::Fixed(SIZE_W)), head("Modified", Length::Fixed(DATE_W))].spacing(GAP_3).padding([GAP_2, GAP_3]);
        let over = self.landing_name(w);
        let list = self.long(id, w, w.shown.len(), line, move |at| {
            let e = &w.entries[w.shown[at]];
            let picked = w.picked.contains(&e.name);
            let (strong, soft) = if picked { (c.on_accent, c.on_accent) } else { (c.text, c.text_muted) };
            let cell = |s: String, width: Length, colour: Color| container(text(s).size(BODY).line_height(LINE_TIGHT).color(colour).wrapping(text::Wrapping::None)).width(width).clip(true);
            let (size, date) = match e.details {
                Some(d) => (folder::size(&d, e.dir), d.modified.map(folder::date).unwrap_or_default()),
                None => (String::new(), String::new()),
            };
            let inside = row![
                image(self.pictures.kinds[e.kind as usize].get(picked)).width(side as f32).height(side as f32).opacity(self.faded(w, e)),
                cell(e.name.clone(), Length::Fill, strong),
                cell(size, Length::Fixed(SIZE_W), soft),
                cell(date, Length::Fixed(DATE_W), soft),
            ]
            .spacing(GAP_3)
            .align_y(Alignment::Center)
            .padding([0.0, GAP_3]);
            let face = self.face(picked, w.hover == Some(at), over == Some(e.os.as_os_str()), inside).width(Length::Fill).height(line - GAP_1).align_y(Alignment::Center);
            container(self.cell(id, at, face)).padding([0.0, GAP_1]).height(line).into()
        });
        column![header, list].into()
    }
}

/// Columns, each cell's width and a line's height for a grid `width` wide: as many
/// cells as fit at their least width, stretched to fill the line (GTK's grid view).
fn grid_cells(width: f32, side: u32) -> (usize, f32, f32) {
    let least = (side as f32 + 48.0).max(112.0);
    let room = (width - 2.0 * GAP_1).max(least);
    let columns = ((room / least).floor() as usize).max(1);
    let line = side as f32 + 3.0 * SMALL * LINE_TIGHT + GAP_1 + 2.0 * GAP_2 + GAP_1;
    (columns, room / columns as f32, line)
}

/// The corner, with an accent line round it where a drag would land (GTK's drop
/// look, 2 px).
fn landing(on: bool, c: Colours) -> iced::Border {
    border::rounded(CORNER).width(if on { 2.0 } else { 0.0 }).color(c.accent)
}

/// A row: the control height, or the picture's when it's taller (GNOME's 32 and 64).
fn row_height(side: u32) -> f32 {
    CONTROL.max(side as f32 + 2.0 * GAP_1) + GAP_1
}

fn show_name(folder: &Path) -> String {
    if folder == places::home() {
        return "Home".into();
    }
    folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into())
}

/// Keys the window didn't take, the mouse's back / forward buttons, and where the
/// pointer is (kept for menus, no message).
fn events(event: iced::Event, status: iced::event::Status, id: window::Id) -> Option<Message> {
    match event {
        iced::Event::Mouse(mouse::Event::CursorMoved { position }) => {
            drop::keep_pointer(position);
            None
        }
        iced::Event::Mouse(mouse::Event::ButtonPressed(b @ (mouse::Button::Back | mouse::Button::Forward))) => Some(Message::Mouse(id, b)),
        iced::Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => Some(Message::Pressed(id)),
        iced::Event::Keyboard(iced::keyboard::Event::ModifiersChanged(m)) => Some(Message::Held(m)),
        // Esc even when the address box took it (iced's text box keeps Esc).
        iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { key: key @ Key::Named(Named::Escape), modifiers, .. }) => Some(Message::Key(id, key, modifiers)),
        iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { key, modifiers, .. }) if status == iced::event::Status::Ignored => Some(Message::Key(id, key, modifiers)),
        _ => None,
    }
}

/// Runs blocking work on its own thread and hands back its answer.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = iced::futures::channel::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    rx.await.expect("the reading thread ended")
}
