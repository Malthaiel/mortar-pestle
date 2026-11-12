//! The screen recorder box in the side panel, over Quick toggles (Left Strip Return step
//! 5, Malthaiel's ask 2026-11-05: "bring the ... recording box back. just copy caelestia
//! 1-1"; first built in the Side Panel Recorder plan, step 2, `23d98c2f`, his verified box
//! of 2026-11-03). Caelestia @bcbb5d5 `modules/utilities/cards/Record.qml`,
//! `RecordingList.qml` and `components/controls/SplitButton.qml`, as Windows'
//! `RecordCard.jsx` + `SplitButton.jsx`, held to the rulebook (`mp_ui::style`) as the
//! switches box under it is.
//!
//! Two rows, each a picture, a title and a strip pill (`side::Pill`, pictures only), then
//! a swatch pill that shows or hides the row's list right under it, gliding open (his
//! asks 2026-11-06). The head: the camcorder, bare (no circle), "Screen Recorder" over its
//! state ("Recording for 1:05" while one runs, his ask 2026-11-05), and the record pill in
//! place of Caelestia's split button and its list of four modes: fullscreen and region
//! each record and become the picked one, the PC's sound turns on and off (its picture
//! shows which). While a recording runs, pause (none inside the instant replay, which
//! can't pause) and stop take the pill's place (his ask 2026-11-05; Caelestia's REC chip
//! and its blink gone). Then the image picture, "Screenshot" and the pill of the three
//! shots, whole screen, an area, one window; a press folds the panel, then niri takes the
//! shot. Each pill's accent rests on its picked button, goes to the one pointed at and
//! comes back; a swatch's shows while its list does. The lists, the recordings and saved
//! clips, and niri's screenshots: newest first, 3 rows (Caelestia's shut list; its head
//! and the wider list went 2026-11-06), the wheel scrolling on; each row what and when,
//! open (a recording in mpv, a screenshot held in mpv) and its folder (mp-files), both
//! closing the panel as Caelestia's, and delete (to the bin, no question: his call
//! 2026-11-03). Colours as his Windows box: no red.
//!
//! What runs is the shell's one `capture::Capture`, told to the box (`Recorder.live`);
//! the box asks it to start, pause and stop through the panel's picks (`side::START`,
//! `side::PAUSE`, `side::STOP`, the shots `side::SNAP`), so the box, the replay pill and
//! the pop-up agree.

use std::sync::atomic::Ordering::Relaxed;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::time::Duration;

use iced::advanced::image::{self as img, Renderer as _};
use iced::advanced::{Renderer as _, renderer};
use iced::border::{self, Radius};
use iced::time::Instant;
use iced::widget::image;
use iced::{Color, Point, Rectangle, Renderer};

use crate::capture::Shot;
use crate::colours::Colours;
use crate::menu::Reply;
use crate::motion::{self, Tween};
use crate::popups::{self, say, width, words};
use crate::record::{self, Live, Saved};
use crate::side::{Glide, Item, Pill};
use crate::{icon, side, style};
use mp_ui::bar::THICK;

const W: f32 = popups::WIDTH - 2.0 * style::MENU_PAD;
/// Windows' card padding (Caelestia `padding.large`), the room between its parts
/// (`spacing.medium`), and between a part's pieces (`spacing.small` / `extraSmall`).
const PAD: f32 = style::GAP_3;
const GAP: f32 = style::GAP_2;
const SMALL: f32 = style::GAP_1;
const C: f32 = style::CONTROL;
const TITLE_LINE: f32 = style::BODY * style::LINE_TIGHT;
const SMALL_LINE: f32 = style::SMALL * style::LINE_TIGHT;
/// Pause and stop: the icon and Caelestia's `padding.large` each side.
const BUTTON: f32 = style::ICON as f32 + 2.0 * style::GAP_3;
/// A list's rows (Caelestia's shut list), and its room under its row when shown: a gap,
/// the rows.
const ROWS: f32 = 3.0;
const LIST: f32 = GAP + ROWS * C;

/// The modes: an area picked or the whole screen, the PC's sound; a mode's place here
/// is `area + 2 * sound`.
pub const MODES: [(bool, bool); 4] = [(false, false), (true, false), (false, true), (true, true)];
/// The record pill's pictures: fullscreen, region, the sound off, on.
const SPLIT_SVGS: [&[u8]; 4] = [include_bytes!("../assets/bx-fullscreen.svg"), include_bytes!("../assets/bx-square-dashed.svg"), include_bytes!("../assets/bx-volume-mute.svg"), include_bytes!("../assets/bx-volume-full.svg")];

/// The screenshot buttons' jobs, in the pill's order.
pub const SHOTS: [Shot; 3] = [Shot::Screen, Shot::Region, Shot::Window];

/// An area picked over the whole screen, the PC's sound, the last screenshot taken, and
/// each list shown (0 the recordings, 1 the screenshots), kept while the shell runs
/// (Caelestia's `props`).
static AREA: AtomicBool = AtomicBool::new(false);
static SOUND: AtomicBool = AtomicBool::new(false);
static SNAPPED: AtomicUsize = AtomicUsize::new(0);
static SHOWN: [AtomicBool; 2] = [AtomicBool::new(false), AtomicBool::new(false)];

/// Each list shown, as the box glides to.
fn shown() -> [f32; 2] {
    SHOWN.each_ref().map(|s| s.load(Relaxed) as u8 as f32)
}

/// The picked mode's place in `MODES`.
fn mode() -> usize {
    AREA.load(Relaxed) as usize + 2 * SOUND.load(Relaxed) as usize
}

/// The box's pictures, drawn each time the panel opens (and on a recolour).
pub struct Pictures {
    /// The camcorder; the picture before "Screenshot" (Boxicons' image: his pick 2026-11-06).
    tile: image::Handle,
    image: image::Handle,
    /// The record pill's (`SPLIT_SVGS`): plain + lit, and faint while a start is awaited.
    split: [[[image::Handle; 2]; 2]; 4],
    pause: image::Handle,
    resume: image::Handle,
    stop: image::Handle,
    /// The swatch that shows a row's list (plain, lit).
    swatch: [image::Handle; 2],
    /// A row's open: a recording (play), a screenshot (an eye).
    open: [image::Handle; 2],
    folder: image::Handle,
    trash: image::Handle,
    none: image::Handle,
    /// The screenshot pill's: whole screen, an area, one window (plain, lit).
    shots: [[image::Handle; 2]; 3],
}

impl Pictures {
    pub fn new(c: &Colours) -> Self {
        let svg = |data: &[u8], size: u32, colour: Color| icon::svg(data, size, colour);
        let small = style::ICON_SM;
        Self {
            tile: svg(include_bytes!("../assets/bx-camcoder.svg"), style::ICON_LG, c.text),
            image: svg(include_bytes!("../assets/bx-image.svg"), style::ICON_LG, c.text),
            split: SPLIT_SVGS.map(|d| [side::pair(d, c), [(); 2].map(|_| svg(d, style::ICON, c.text_faint))]),
            pause: svg(include_bytes!("../assets/bx-pause.svg"), style::ICON, c.text),
            resume: svg(include_bytes!("../assets/bx-play.svg"), style::ICON, c.on_accent),
            stop: svg(include_bytes!("../assets/bx-stop.svg"), style::ICON, c.panel),
            swatch: side::pair(include_bytes!("../assets/bx-swatch.svg"), c),
            open: [svg(include_bytes!("../assets/bx-play.svg"), style::ICON, c.text_muted), svg(include_bytes!("../assets/bx-eye.svg"), style::ICON, c.text_muted)],
            folder: svg(include_bytes!("../assets/bx-folder.svg"), style::ICON, c.text_muted),
            trash: svg(include_bytes!("../assets/bx-trash.svg"), style::ICON, c.text),
            none: svg(include_bytes!("../assets/bx-list-x.svg"), small, c.text_faint),
            shots: [side::pair(include_bytes!("../assets/bx-fullscreen.svg"), c), side::pair(include_bytes!("../assets/bx-square-dashed.svg"), c), side::pair(include_bytes!("../assets/bx-window.svg"), c)],
        }
    }
}

/// What the pointer is on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Part {
    /// A record pill button: fullscreen, region, the sound.
    Split(usize),
    Pause,
    Stop,
    /// A screenshot button (`SHOTS`).
    Shot(usize),
    /// Row `l`'s swatch (0 the recorder's, 1 the screenshots'): shows or hides its list.
    Swatch(usize),
    /// List `l`'s row `i`: open, its folder, delete.
    Open(usize, usize),
    Folder(usize, usize),
    Trash(usize, usize),
}

/// A list: its files, how shown (0 hidden .. 1 shown, gliding), its scroll.
struct List {
    saved: Vec<Saved>,
    shown: Tween,
    scroll: Tween,
    scroll_to: f32,
}

impl List {
    fn new(saved: Vec<Saved>, l: usize) -> Self {
        Self { saved, shown: Tween::new(shown()[l], motion::SPATIAL), scroll: Tween::new(0.0, motion::EFFECTS), scroll_to: 0.0 }
    }

    /// How far it scrolls: its rows past the shown ones.
    fn most(&self) -> f32 {
        (self.saved.len() as f32 - ROWS).max(0.0) * C
    }
}

pub struct State {
    lists: [List; 2],
    /// A recording shown at the last look: its end reloads the list (its file in it).
    was: bool,
    /// The record, screenshot and swatch pills' accent pills, and the part last pointed at.
    split: Glide,
    shot: Glide,
    swatch: [Glide; 2],
    last: Option<Part>,
}

impl State {
    /// How shown each list is now.
    fn shown(&self, now: Instant) -> [f32; 2] {
        self.lists.each_ref().map(|l| l.shown.value(now))
    }

    /// The box's height now, gliding.
    pub fn h(&self, now: Instant) -> f32 {
        height(self.shown(now))
    }
}

/// The head's height: the title over its state, or a control, the taller.
fn head() -> f32 {
    (TITLE_LINE + SMALL_LINE).max(C).ceil()
}

/// The screenshot row's top: under the head and the recordings as shown as `o` says.
fn below(o: [f32; 2]) -> f32 {
    PAD + head() + o[0] * LIST + GAP
}

/// Row `l`'s top and height: the head, or the screenshot row.
fn row(l: usize, o: [f32; 2]) -> (f32, f32) {
    if l == 0 { (PAD, head()) } else { (below(o), THICK) }
}

/// The box's height: the two rows and the lists as shown.
fn height(o: [f32; 2]) -> f32 {
    (below(o) + THICK + o[1] * LIST + PAD).ceil()
}

/// Row `l`'s picture (the camcorder, the image) at the box's left.
fn tile(l: usize, o: [f32; 2]) -> Rectangle {
    let (y, h) = row(l, o);
    Rectangle { x: PAD, y, width: style::ICON_LG as f32, height: h }
}

/// List `l`'s rows under its row, cut to how shown it is.
fn rows_rect(l: usize, o: [f32; 2]) -> Rectangle {
    let (y, h) = row(l, o);
    Rectangle { x: PAD, y: y + h + GAP, width: W - 2.0 * PAD, height: (o[l] * LIST - GAP).max(0.0) }
}

/// A row's open, folder and delete buttons from the rows' top, Caelestia's order.
fn row_buttons(rows: Rectangle, y: f32) -> [Rectangle; 3] {
    let trash = Rectangle { x: rows.x + rows.width - C, y, width: C, height: C };
    let folder = Rectangle { x: trash.x - SMALL - C, ..trash };
    [Rectangle { x: folder.x - SMALL - C, ..folder }, folder, trash]
}

pub struct Recorder<'a> {
    /// The recording running, and a start asked for not yet seen (`capture::Capture`).
    pub live: Option<Live>,
    pub starting: bool,
    pub colours: Colours,
    pub pictures: &'a Pictures,
}

impl Recorder<'_> {
    fn busy(&self) -> bool {
        self.live.is_some() || self.starting
    }

    /// Row `l`'s swatch pill, at the box's padded right.
    fn swatch(&self, l: usize, o: [f32; 2]) -> (Pill<'_>, Point) {
        let pill = Pill(vec![Item { picture: &self.pictures.swatch, word: None }]);
        let (y, h) = row(l, o);
        let at = Point::new(W - PAD - pill.w(), y + (h - THICK) / 2.0);
        (pill, at)
    }

    /// Where row `l`'s pill (or pause and stop) ends: a gap-2 before its swatch.
    fn end(&self, l: usize, o: [f32; 2]) -> f32 {
        self.swatch(l, o).1.x - GAP
    }

    /// A pill on row `l`, ending before its swatch.
    fn place<'p>(&self, pill: Pill<'p>, l: usize, o: [f32; 2]) -> (Pill<'p>, Point) {
        let (y, h) = row(l, o);
        let at = Point::new(self.end(l, o) - pill.w(), y + (h - THICK) / 2.0);
        (pill, at)
    }

    /// The screenshot pill and its place on its row.
    fn shots(&self, o: [f32; 2]) -> (Pill<'_>, Point) {
        self.place(Pill(self.pictures.shots.iter().map(|picture| Item { picture, word: None }).collect()), 1, o)
    }

    /// The record pill and its place on the head: fullscreen, region, the sound off or on
    /// (faint while a start is awaited).
    fn split(&self) -> (Pill<'_>, Point) {
        let (p, f) = (self.pictures, self.starting as usize);
        let sound = 2 + SOUND.load(Relaxed) as usize;
        self.place(Pill([0, 1, sound].into_iter().map(|i| Item { picture: &p.split[i][f], word: None }).collect()), 0, [0.0; 2])
    }

    /// Pause and stop: in the record pill's place, Caelestia's `ButtonRow`
    /// (`spacing.extraSmall`).
    fn stop_rect(&self) -> Rectangle {
        Rectangle { x: self.end(0, [0.0; 2]) - BUTTON, y: PAD + (head() - C) / 2.0, width: BUTTON, height: C }
    }

    fn pause_rect(&self) -> Rectangle {
        Rectangle { x: self.stop_rect().x - SMALL - BUTTON, ..self.stop_rect() }
    }

    /// Pause shows unless the recording runs inside the replay.
    fn pauses(&self) -> bool {
        self.live.is_some_and(|l| !l.inside)
    }

    /// Each pill's accent: on the button pointed at, else resting on its picked one (the
    /// record pill's mode, the last screenshot; his asks 2026-11-06), a swatch's while its
    /// list shows; the record pill's none while a start is awaited.
    fn glide(&self, s: &mut State, now: Instant) {
        let o = s.shown(now);
        let split = match s.last {
            _ if self.starting => None,
            Some(Part::Split(i)) => Some(i),
            _ => Some(AREA.load(Relaxed) as usize),
        };
        s.split.go(split.map(|i| self.split().0.span(i)), now);
        let shot = match s.last {
            Some(Part::Shot(i)) => i,
            _ => SNAPPED.load(Relaxed),
        };
        s.shot.go(Some(self.shots(o).0.span(shot)), now);
        for (l, shown) in SHOWN.iter().enumerate() {
            let on = s.last == Some(Part::Swatch(l)) || shown.load(Relaxed);
            s.swatch[l].go(on.then(|| self.swatch(l, o).0.span(0)), now);
        }
    }

    /// Made as the panel opens, a recording running or not: each pill's accent already
    /// on its picked button.
    pub fn state(&self) -> State {
        let o = [0.0; 2];
        let swatch = |l: usize| if SHOWN[l].load(Relaxed) { Glide::at(self.swatch(l, o).0.span(0)) } else { Glide::new() };
        State {
            lists: [List::new(record::saved(), 0), List::new(record::shots(), 1)],
            was: self.live.is_some(),
            split: if self.starting { Glide::new() } else { Glide::at(self.split().0.span(AREA.load(Relaxed) as usize)) },
            shot: Glide::at(self.shots(o).0.span(SNAPPED.load(Relaxed))),
            swatch: [swatch(0), swatch(1)],
            last: None,
        }
    }

    /// A recording ended since the last look reloads its list; then the accents, and
    /// each list's scroll held inside it.
    pub fn size(&self, s: &mut State, now: Instant) {
        let live = self.live.is_some();
        if live != s.was {
            s.was = live;
            if !live {
                s.lists[0].saved = record::saved();
            }
        }
        self.glide(s, now);
        for list in &mut s.lists {
            let most = list.most();
            if list.scroll_to > most {
                list.scroll_to = most;
                list.scroll.go(most, now);
            }
        }
    }

    /// The pointer at `p`, from the box's top left, the box `h` tall now.
    pub fn over(&self, s: &State, p: Point, h: f32, now: Instant) -> Option<Part> {
        if !(Rectangle { x: 0.0, y: 0.0, width: W, height: h }).contains(p) {
            return None;
        }
        let o = s.shown(now);
        if self.live.is_some() {
            if self.stop_rect().contains(p) {
                return Some(Part::Stop);
            }
            if self.pauses() && self.pause_rect().contains(p) {
                return Some(Part::Pause);
            }
        } else if !self.busy() {
            let (pill, at) = self.split();
            if let Some(i) = pill.at(at, p) {
                return Some(Part::Split(i));
            }
        }
        let (pill, at) = self.shots(o);
        if let Some(i) = pill.at(at, p) {
            return Some(Part::Shot(i));
        }
        for l in 0..2 {
            let (pill, at) = self.swatch(l, o);
            if pill.at(at, p).is_some() {
                return Some(Part::Swatch(l));
            }
            let rows = rows_rect(l, o);
            if !rows.contains(p) {
                continue;
            }
            let list = &s.lists[l];
            let scroll = list.scroll.value(now);
            let i = ((p.y - rows.y + scroll) / C).floor() as usize;
            if i >= list.saved.len() {
                return None;
            }
            let y = rows.y + i as f32 * C - scroll;
            let [open, folder, trash] = row_buttons(rows, y);
            return [(open, Part::Open(l, i)), (folder, Part::Folder(l, i)), (trash, Part::Trash(l, i))].into_iter().find(|(r, _)| r.contains(p)).map(|(_, part)| part);
        }
        None
    }

    /// The pills' accents follow the hovered button.
    pub fn hover(&self, s: &mut State, part: Option<Part>, now: Instant) {
        s.last = part;
        self.glide(s, now);
    }

    pub fn press(&self, s: &mut State, part: Part, now: Instant) -> Reply {
        match part {
            // The sound turns on and off; fullscreen or region records and is picked.
            Part::Split(2) => {
                SOUND.fetch_xor(true, Relaxed);
            }
            Part::Split(i) => {
                AREA.store(i == 1, Relaxed);
                self.glide(s, now);
                return Reply::Pick(side::START + mode());
            }
            Part::Pause => return Reply::Pick(side::PAUSE),
            Part::Stop => return Reply::Pick(side::STOP),
            Part::Shot(i) => {
                SNAPPED.store(i, Relaxed);
                return Reply::Pick(side::SNAP + i);
            }
            Part::Swatch(l) => {
                let shown = !SHOWN[l].fetch_xor(true, Relaxed);
                s.lists[l].shown.go(shown as u8 as f32, now);
                self.glide(s, now);
            }
            Part::Open(l, i) | Part::Folder(l, i) => {
                if let Some(saved) = s.lists[l].saved.get(i) {
                    match (part, l) {
                        (Part::Open(..), 0) => record::play(&saved.path),
                        (Part::Open(..), _) => record::view(&saved.path),
                        (_, 0) => record::show(&record::folder()),
                        _ => record::show(&record::shots_folder()),
                    }
                    return Reply::Close;
                }
            }
            Part::Trash(l, i) => {
                let list = &mut s.lists[l];
                if list.saved.get(i).is_some_and(|saved| record::trash(&saved.path)) {
                    list.saved.remove(i);
                }
            }
        }
        Reply::Used
    }

    /// The wheel over a list's rows; true when it was there.
    pub fn wheel(&self, s: &mut State, by: f32, p: Point, now: Instant) -> bool {
        let o = s.shown(now);
        let Some(l) = (0..2).find(|&l| rows_rect(l, o).contains(p)) else { return false };
        let list = &mut s.lists[l];
        list.scroll_to = (list.scroll_to + by).clamp(0.0, list.most());
        list.scroll.go(list.scroll_to, now);
        true
    }

    pub fn moving(&self, s: &State, now: Instant) -> bool {
        s.lists.iter().any(|l| l.shown.moving(now) || l.scroll.moving(now)) || [&s.split, &s.shot, &s.swatch[0], &s.swatch[1]].iter().any(|g| g.moving(now))
    }

    /// The next frame though nothing glides: the clock's next second while a recording
    /// runs unpaused.
    pub fn wake(&self, now: Instant) -> Option<Instant> {
        let l = self.live.filter(|l| !l.paused())?;
        Some(now + Duration::from_millis(1000 - l.filmed(record::now_ms()) % 1000))
    }

    /// The box at `card` (on the screen, its height gliding), cut to the shown `clip`.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(&self, s: &State, renderer: &mut Renderer, card: Rectangle, clip: Rectangle, alpha: f32, over: Option<Part>, now: Instant) {
        let col = &self.colours;
        let fade = |colour: Color| Color { a: colour.a * alpha, ..colour };
        let patch = |on: Color| fade(Color { a: style::HOVER, ..on });
        let quad = |b: Rectangle, radius: Radius| renderer::Quad { bounds: b, border: border::rounded(radius), ..Default::default() };
        let at = |r: Rectangle| Rectangle { x: (card.x + r.x).round(), y: (card.y + r.y).round(), width: r.width.round(), height: r.height.round() };
        let on = |spot: Point| Point::new(card.x + spot.x, card.y + spot.y);
        let picture = |renderer: &mut Renderer, h: &image::Handle, b: Rectangle| {
            renderer.draw_image(img::Image { opacity: alpha, ..img::Image::new(h.clone()) }, b, clip);
        };
        let p = &self.pictures;
        let o = s.shown(now);
        renderer.fill_quad(quad(at(Rectangle { x: 0.0, y: 0.0, width: W, height: card.height }), style::CORNER.into()), fade(col.panel));

        // The head: the camcorder, the title over its state, then pause and stop while
        // recording, else the record pill (out of reach while a start is awaited).
        let big = style::ICON_LG as f32;
        let t = at(tile(0, o));
        picture(renderer, &p.tile, centred(t, big));
        let state = match self.live {
            Some(l) if l.paused() => "Paused".to_string(),
            Some(l) => format!("Recording for {}", record::clock(l.filmed(record::now_ms()))),
            None if self.starting => "Starting".to_string(),
            None => "Ready".to_string(),
        };
        let x = t.x + big + GAP;
        let top = card.y + PAD + ((head() - TITLE_LINE - SMALL_LINE) / 2.0).round();
        say(renderer, words("Screen Recorder", style::BODY, f32::INFINITY, false), Point::new(x, top + TITLE_LINE / 2.0), fade(col.text), card, clip);
        say(renderer, words(&state, style::SMALL, f32::INFINITY, false), Point::new(x, top + TITLE_LINE + SMALL_LINE / 2.0), fade(col.text_muted), card, clip);

        let half = C / 2.0;
        if let Some(l) = self.live {
            // Pause: tonal, the accent and squarer while paused (Caelestia's checked); stop
            // in Text (Windows' Hyper Minimal: no red).
            let paused = l.paused();
            if self.pauses() {
                let pb = at(self.pause_rect());
                let r: Radius = if paused { style::CORNER } else { half }.into();
                renderer.fill_quad(quad(pb, r), if paused { fade(col.accent) } else { patch(col.text) });
                if over == Some(Part::Pause) {
                    renderer.fill_quad(quad(pb, r), patch(if paused { col.on_accent } else { col.text }));
                }
                picture(renderer, if paused { &p.resume } else { &p.pause }, centred(pb, style::ICON as f32));
            }
            let sb = at(self.stop_rect());
            renderer.fill_quad(quad(sb, half.into()), fade(col.text));
            if over == Some(Part::Stop) {
                renderer.fill_quad(quad(sb, half.into()), patch(col.panel));
            }
            picture(renderer, &p.stop, centred(sb, style::ICON as f32));
        } else {
            let (pill, spot) = self.split();
            pill.draw(renderer, on(spot), &s.split, col, alpha, clip, now);
        }

        // The image picture under the camcorder, "Screenshot" in the title's column and
        // size, its pill.
        let r = at(tile(1, o));
        picture(renderer, &p.image, centred(r, big));
        say(renderer, words("Screenshot", style::BODY, f32::INFINITY, false), Point::new(x, r.center_y()), fade(col.text), card, clip);
        let (pill, spot) = self.shots(o);
        pill.draw(renderer, on(spot), &s.shot, col, alpha, clip, now);

        // Each row's swatch and its list under it.
        for l in 0..2 {
            let (pill, spot) = self.swatch(l, o);
            pill.draw(renderer, on(spot), &s.swatch[l], col, alpha, clip, now);
            self.draw_list(s, l, renderer, at(rows_rect(l, o)), card, clip, alpha, over, now);
        }
    }

    /// List `l`'s rows at `rows` (on the screen), cut to what shows of them.
    #[allow(clippy::too_many_arguments)]
    fn draw_list(&self, s: &State, l: usize, renderer: &mut Renderer, rows: Rectangle, card: Rectangle, clip: Rectangle, alpha: f32, over: Option<Part>, now: Instant) {
        let Some(shown) = rows.intersection(&clip) else { return };
        let col = &self.colours;
        let p = &self.pictures;
        let fade = |colour: Color| Color { a: colour.a * alpha, ..colour };
        let list = &s.lists[l];
        renderer.with_layer(shown, |renderer| {
            let picture = |renderer: &mut Renderer, h: &image::Handle, b: Rectangle| {
                renderer.draw_image(img::Image { opacity: alpha, ..img::Image::new(h.clone()) }, b, shown);
            };
            if list.saved.is_empty() {
                // Windows' `.c-rempty`: the picture and the words, centred in the rows.
                let empty = ["No recordings found", "No screenshots found"][l];
                let (small, words_w) = (style::ICON_SM as f32, width(empty, style::SMALL));
                let x = (rows.x + (rows.width - small - GAP - words_w) / 2.0).round();
                let mid = (rows.y + ROWS * C / 2.0).round();
                picture(renderer, &p.none, Rectangle { x, y: mid - small / 2.0, width: small, height: small });
                say(renderer, words(empty, style::SMALL, f32::INFINITY, false), Point::new(x + small + GAP, mid), fade(col.text_faint), card, shown);
                return;
            }
            let scroll = list.scroll.value(now);
            for (i, saved) in list.saved.iter().enumerate() {
                let y = (rows.y + i as f32 * C - scroll).round();
                if y + C < shown.y || y > shown.y + shown.height {
                    continue;
                }
                say(renderer, words(&saved.when, style::SMALL, f32::INFINITY, false), Point::new(rows.x, y + C / 2.0), fade(col.text_muted), card, shown);
                let parts = [Part::Open(l, i), Part::Folder(l, i), Part::Trash(l, i)];
                for ((b, part), image) in row_buttons(rows, y).into_iter().zip(parts).zip([&p.open[l], &p.folder, &p.trash]) {
                    if over == Some(part) {
                        renderer.fill_quad(renderer::Quad { bounds: b, border: border::rounded(C / 2.0), ..Default::default() }, fade(Color { a: style::HOVER, ..col.text }));
                    }
                    picture(renderer, image, centred(b, style::ICON as f32));
                }
            }
        });
    }
}

/// A square `side` big in the middle of `b`, in whole pixels.
fn centred(b: Rectangle, side: f32) -> Rectangle {
    Rectangle { x: b.x + ((b.width - side) / 2.0).round(), y: b.y + ((b.height - side) / 2.0).round(), width: side, height: side }
}
