//! The right side panel (M&P Shell plan, step 6): Caelestia's sidebar (@bcbb5d5
//! `modules/sidebar/{NotifDock,NotifDockList,NotifGroup,NotifGroupList,Notif}.qml`) over
//! its utilities' switches card (`modules/utilities/cards/Toggles.qml`), as Windows'
//! `SidePanel.jsx`, `NotifDock.jsx` and `QuickToggles.jsx`, in one `Menu` card
//! (`Edge::Side`, his ask 2026-11-09 "make the right panel one"): the list over the
//! recorder and switches, sliding in whole from behind the right edge, from the right
//! edge's zone, the bottom edge's right end or the bell alike. Caelestia's hands, every
//! size from the rulebook (Malthaiel's picks 2026-11-03).
//!
//! The list: one card per program, newest first: its picture, its name, the newest's
//! age, a count with an arrow, and its first 3 notices one line each. Opened (the count,
//! a right click, or a press dragged 20 px down; 20 px up shuts) each notice gets its
//! own box: the whole title and body, X and the sender's buttons. A notice or a whole
//! card dragged sideways past 30% flies off and is closed, as by a middle click (on a
//! notice it alone, elsewhere on the card all of it); the clear-all button closes the
//! cards one after another (Caelestia's `clearTimer`). The wheel scrolls the list.
//! A pin at the list box's top right (clear-all's round button) keeps the panel open
//! till pressed again (Malthaiel's ask 2026-11-04).
//! Over Quick toggles, the screen recorder (`recorder.rs`, Caelestia's `Record.qml`,
//! back by his ask 2026-11-05: Caelestia's order, keep awake left out): its height
//! glides as its list opens or a recording starts, the list's box's bottom with it.
//! Quick toggles, no title (his call 2026-11-04): a centred row of strip pills (`Pill`),
//! a gap-2 apart: dark / light (`mp-theme toggle`) and do not disturb, each picture
//! showing what is on now; then [replay] and [camera] (back from the top strip, Left
//! Strip Return step 5), each pressed folding the panel and opening its pop-up
//! (`capture.rs`). While a recording runs the replay pill shows a red dot and its time;
//! a moment after a clip is saved, a check.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use iced::advanced::image::{self as img, Renderer as _};
use iced::advanced::{Renderer as _, renderer};
use iced::time::Instant;
use iced::widget::image;
use iced::{Color, Event, Point, Rectangle, Renderer, Size, border, mouse};
use mp_ui::bar::{SLOT, THICK};

use crate::colours::Colours;
use crate::menu::{Body, Reply};
use crate::motion::{self, Tween};
use crate::notices::{self, Notice};
use crate::popups::{self, cut, say, tall, width, words};
use crate::record::Live;
use crate::recorder::{self, Part, Recorder};
use crate::{icon, style};

/// The content's width: the box (Caelestia's `sizes.sidebar.width`, the pop-ups') less
/// the menu's padding.
const W: f32 = popups::WIDTH - 2.0 * style::MENU_PAD;
/// Caelestia `padding.medium` / `spacing.medium` (the list box's padding, a card's, the
/// room between parts) and `spacing.small` / `extraSmall` (between cards and lines).
const PAD: f32 = style::GAP_2;
const SMALL: f32 = style::GAP_1;
const PICTURE: f32 = notices::PICTURE as f32;
/// A card's width, and its text column's start and width (beside the picture).
const GW: f32 = W - 2.0 * PAD;
const COL_X: f32 = PAD + PICTURE + style::GAP_2;
const COL_W: f32 = GW - COL_X - PAD;
const TITLE_LINE: f32 = style::BODY * style::LINE_TIGHT;
const SMALL_LINE: f32 = style::SMALL * style::LINE_TIGHT;
/// The count pill (Caelestia: its count + `padding.extraSmall`), which sets the header.
const PILL_H: f32 = SMALL_LINE + SMALL;
const HEAD: f32 = PILL_H;
/// Caelestia `notifs.groupPreviewNum`, `clearThreshold`, `expandThreshold`.
const PREVIEW: usize = 3;
const CLEAR: f32 = 0.3;
const EXPAND: f32 = 20.0;
/// A wheel notch (Windows' engine, Chromium's 100 px).
const NOTCH: f32 = 100.0;
/// The empty list's picture: 80% of the list's width (Caelestia, Windows' `.c-dock-empty`).
const DINO: u32 = (GW * 0.8) as u32;
const NO_BODY: &str = "No body here! :/";

/// The two switches pick 0 and 1, then the pin, the replay pill, the camera; the
/// recorder box starts a mode (`START` + its place in `recorder::MODES`), pauses, stops,
/// takes a screenshot (`SNAP` + its place in `recorder::SHOTS`).
pub const PIN: usize = 2;
pub const REC: usize = 3;
pub const SHOT: usize = 4;
pub const START: usize = 5;
pub const PAUSE: usize = START + recorder::MODES.len();
pub const STOP: usize = PAUSE + 1;
pub const SNAP: usize = STOP + 1;

/// The pills' top in the switches card: padded gap-3.
pub fn row_top() -> f32 {
    style::GAP_3
}

/// The switches card's height: the pills, padded (the corner box's content).
pub fn switches_h() -> f32 {
    (row_top() + THICK + style::GAP_3).ceil()
}

/// The panel's titles in the strip menus' weight (Malthaiel's call 2026-11-04).
fn bold(t: iced::advanced::text::Text<&str>) -> iced::advanced::text::Text<&str> {
    iced::advanced::text::Text { font: crate::BOLD, ..t }
}

/// A picture in Text and On Accent, at the button size.
pub fn pair(svg: &[u8], c: &Colours) -> [image::Handle; 2] {
    [icon::svg(svg, style::ICON, c.text), icon::svg(svg, style::ICON, c.on_accent)]
}

/// One button in a strip pill: its picture (plain, lit) and maybe a word after it,
/// with the word's width measured.
pub struct Item<'a> {
    pub picture: &'a [image::Handle; 2],
    pub word: Option<(&'a str, f32)>,
}

impl Item<'_> {
    /// A slot, or the picture where a slot holds it, a gap-1, the word, and the
    /// picture's own margin again after it.
    fn w(&self) -> f32 {
        self.word.map_or(SLOT, |(_, w)| (SLOT + style::GAP_1 + w).ceil())
    }
}

/// A strip pill, drawn by hand to `mp_ui::bar::Bar`'s look (the panel paints itself,
/// so the widget can't sit in it; Malthaiel's call 2026-11-03: the left strip's pills,
/// size and everything): a Raised track `THICK` thick, round; buttons `SLOT` thick, a
/// gap-1 apart and a gap-1 in from each end; the accent pill on the one under the
/// pointer (`Glide`), their On Accent copy inside it. A press anywhere on it is the
/// nearest button's, gaps included, as the accent pill shows.
pub struct Pill<'a>(pub Vec<Item<'a>>);

impl Pill<'_> {
    pub fn w(&self) -> f32 {
        self.0.iter().map(|i| i.w() + style::GAP_1).sum::<f32>() + style::GAP_1
    }

    /// Each button's start and width along the pill.
    pub fn span(&self, i: usize) -> (f32, f32) {
        let x = style::GAP_1 + self.0[..i].iter().map(|i| i.w() + style::GAP_1).sum::<f32>();
        (x, self.0[i].w())
    }

    /// The button nearest `p` on the pill at `at`, when `p` is on it.
    pub fn at(&self, at: Point, p: Point) -> Option<usize> {
        if !(Rectangle { x: at.x, y: at.y, width: self.w(), height: THICK }).contains(p) {
            return None;
        }
        let off = |i: usize| {
            let (x, w) = self.span(i);
            (at.x + x - p.x).max(p.x - at.x - x - w)
        };
        (0..self.0.len()).min_by(|&i, &j| off(i).total_cmp(&off(j)))
    }

    /// At `at` on the screen, faded by `alpha`.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(&self, renderer: &mut Renderer, at: Point, glide: &Glide, col: &Colours, alpha: f32, clip: Rectangle, now: Instant) {
        let x0 = at.x.round();
        let track = Rectangle { x: x0, y: at.y.round(), width: (at.x + self.w()).round() - x0, height: THICK };
        renderer.fill_quad(renderer::Quad { bounds: track, border: border::rounded(THICK / 2.0), ..Default::default() }, Color { a: col.raised.a * alpha, ..col.raised });
        let Some(clip) = track.intersection(&clip) else { return };
        let margin = (SLOT - style::ICON as f32) / 2.0;
        let items = |renderer: &mut Renderer, lit: bool, clip: Rectangle| {
            for (i, item) in self.0.iter().enumerate() {
                let x = x0 + self.span(i).0;
                let y = track.y + style::GAP_1;
                let spot = Rectangle { x: x + margin, y: y + margin, width: style::ICON as f32, height: style::ICON as f32 };
                renderer.draw_image(img::Image { opacity: alpha, ..img::Image::new(item.picture[lit as usize].clone()) }, spot, clip);
                if let Some((word, _)) = item.word {
                    let colour = if lit { col.on_accent } else { col.text };
                    say(renderer, words(word, style::SMALL, f32::INFINITY, false), Point::new(x + SLOT - margin + style::GAP_1, y + SLOT / 2.0), Color { a: colour.a * alpha, ..colour }, track, clip);
                }
            }
        };
        items(renderer, false, clip);
        // The accent pill, in whole pixels (`pill::Highlight`); the lit copy takes over
        // halfway through its fade.
        let a = glide.alpha.value(now).clamp(0.0, 1.0);
        if a <= 0.0 {
            return;
        }
        let x = (x0 + glide.x.value(now)).round();
        let pill = Rectangle { x, y: track.y + style::GAP_1, width: (x0 + glide.x.value(now) + glide.w.value(now)).round() - x, height: SLOT };
        let Some(view) = pill.intersection(&clip) else { return };
        renderer.with_layer(view, |renderer| {
            renderer.fill_quad(renderer::Quad { bounds: pill, border: border::rounded(SLOT / 2.0), ..Default::default() }, Color { a: col.accent.a * alpha * a, ..col.accent });
            if a >= 0.5 {
                items(renderer, true, view);
            }
        });
    }
}

/// A strip pill's accent pill, moving as `pill::Highlight`: seen, it slides to the
/// button under the pointer; unseen, it shows where it lands; gone, it fades where it is.
pub struct Glide {
    x: Tween,
    w: Tween,
    alpha: Tween,
}

impl Glide {
    pub fn new() -> Self {
        Self { x: Tween::new(0.0, motion::SPATIAL), w: Tween::new(0.0, motion::SPATIAL), alpha: Tween::new(0.0, motion::EFFECTS) }
    }

    /// Shown on the button at `span` from the start: a pill whose accent rests on its
    /// picked button (the recorder box's record pill, Malthaiel's ask 2026-11-06).
    pub fn at((x, w): (f32, f32)) -> Self {
        Self { x: Tween::new(x, motion::SPATIAL), w: Tween::new(w, motion::SPATIAL), alpha: Tween::new(1.0, motion::EFFECTS) }
    }

    /// Onto the button at `span` (`Pill::span`), or none.
    pub fn go(&mut self, span: Option<(f32, f32)>, now: Instant) {
        let Some((x, w)) = span else { return self.alpha.go(0.0, now) };
        if self.alpha.value(now) < 0.01 {
            self.x.set(x);
            self.w.set(w);
        } else {
            self.x.go(x, now);
            self.w.go(w, now);
        }
        self.alpha.go(1.0, now);
    }

    pub fn moving(&self, now: Instant) -> bool {
        self.x.moving(now) || self.w.moving(now) || self.alpha.moving(now)
    }
}

/// The panel's own pictures, drawn each time it opens (and on a recolour).
pub struct Pictures {
    dino: image::Handle,
    clear: image::Handle,
    /// The pin, plain and lit (pinned: on Accent).
    pin: [image::Handle; 2],
    down: image::Handle,
    up: image::Handle,
    /// Each switch's pictures by what is on now (plain, lit): light / dark (a sun, a
    /// moon), notices / do not disturb (a bell, a bell struck through).
    switches: [[[image::Handle; 2]; 2]; 2],
    /// The capture pills': instant replay, the check after a save, a recording's red dot
    /// (the rulebook's error), the camera; the widest digit and the colon, so the
    /// recording's time holds still as it counts.
    replay: [image::Handle; 2],
    check: [image::Handle; 2],
    dot: [image::Handle; 2],
    camera: [image::Handle; 2],
    digit_w: f32,
    colon_w: f32,
    rec: recorder::Pictures,
}

impl Pictures {
    pub fn new(c: &Colours) -> Self {
        let pair = |svg: &[u8]| pair(svg, c);
        Self {
            dino: icon::svg(include_bytes!("../assets/bx-dino.svg"), DINO, c.text_faint),
            clear: icon::svg(include_bytes!("../assets/bx-list-x.svg"), style::ICON, c.text),
            pin: pair(include_bytes!("../assets/bx-pin.svg")),
            down: icon::svg(include_bytes!("../assets/bx-chevron-down.svg"), style::ICON_SM, c.text_muted),
            up: icon::svg(include_bytes!("../assets/bx-chevron-up.svg"), style::ICON_SM, c.text_muted),
            switches: [[pair(include_bytes!("../assets/bx-sun.svg")), pair(include_bytes!("../assets/bx-moon.svg"))], [pair(include_bytes!("../assets/bx-bell.svg")), pair(include_bytes!("../assets/bx-bell-slash.svg"))]],
            replay: pair(include_bytes!("../assets/bx-repeat.svg")),
            check: pair(include_bytes!("../assets/bx-check.svg")),
            dot: [icon::svg(include_bytes!("../assets/bx-circle.svg"), style::ICON, c.error), icon::svg(include_bytes!("../assets/bx-circle.svg"), style::ICON, c.on_accent)],
            camera: pair(include_bytes!("../assets/bx-camera.svg")),
            digit_w: (0..10).map(|d| width(&d.to_string(), style::SMALL)).fold(0.0, f32::max),
            colon_w: width(":", style::SMALL),
            rec: recorder::Pictures::new(c),
        }
    }

    /// A recording's time's room: each digit as wide as the widest.
    fn time_w(&self, time: &str) -> f32 {
        time.chars().map(|c| if c.is_ascii_digit() { self.digit_w } else { self.colon_w }).sum::<f32>().ceil()
    }
}

pub struct Side<'a> {
    /// The column's content height (`menu::side_inner`).
    pub height: f32,
    /// Every kept notice, newest first.
    pub list: &'a [Notice],
    /// Each program's pictures (`notices::group_pictures`).
    pub faces: &'a HashMap<String, (Option<image::Handle>, Option<image::Handle>)>,
    pub quiet: bool,
    pub dark: bool,
    /// Kept open by the pin.
    pub pinned: bool,
    /// A recording's time while one runs; a clip saved a moment ago.
    pub recording: Option<&'a str>,
    pub saved: bool,
    /// The recording running, and a start asked for not yet seen (the recorder box's).
    pub live: Option<Live>,
    pub starting: bool,
    pub colours: Colours,
    pub cards: &'a popups::Pictures,
    pub pictures: &'a Pictures,
}

/// A notice's words, measured once (as the pop-ups').
struct Lines {
    key: (String, String, String),
    /// Shut: the title cut to the line, its width, and the body in the rest.
    title: String,
    title_w: f32,
    preview: String,
    /// Open: the title and body wrapped, beside the age.
    title_h: f32,
    body_h: f32,
    age_w: f32,
}

impl Lines {
    fn new(n: &Notice) -> Self {
        let age = notices::age(n.at);
        let age_w = width(&age, style::SMALL);
        let title = cut(&n.summary, style::BODY, COL_W);
        let title_w = width(&title, style::BODY);
        let rest = COL_W - title_w - SMALL;
        let preview = if rest > 2.0 * style::SMALL { cut(&n.body, style::SMALL, rest) } else { String::new() };
        let inner = COL_W - 2.0 * PAD;
        Self {
            title_h: tall(&n.summary, style::BODY, inner - age_w - SMALL).max(TITLE_LINE),
            body_h: tall(if n.body.is_empty() { NO_BODY } else { &n.body }, style::SMALL, inner),
            key: (n.summary.clone(), n.body.clone(), age),
            title,
            title_w,
            preview,
            age_w,
        }
    }

    fn stale(&self, n: &Notice) -> bool {
        (&self.key.0, &self.key.1) != (&n.summary, &n.body) || self.key.2 != notices::age(n.at)
    }

    /// An open notice's box.
    fn open_h(&self) -> f32 {
        (2.0 * PAD + self.title_h + SMALL + self.body_h + style::GAP_2 + style::CONTROL).ceil()
    }
}

/// A card's header, measured once: the name cut beside the age and the count.
struct Head {
    key: (usize, String),
    name: String,
    age: String,
    age_w: f32,
    count: String,
    count_w: f32,
}

impl Head {
    fn pill_w(&self) -> f32 {
        self.count_w + SMALL + style::ICON_SM as f32 + style::GAP_3
    }
}

/// A program's card.
struct Group<'n> {
    app: &'n str,
    notices: Vec<&'n Notice>,
    critical: bool,
}

/// What the pointer is on.
#[derive(Clone, PartialEq)]
enum Over {
    Nothing,
    Group(String),
    Row(u32),
    Pill(String),
    Button(u32, usize),
    Clear,
    Pin,
    Switch(usize),
    /// The replay pill (0) or the camera (1).
    Capture(usize),
    Rec(Part),
}

enum Held {
    Group(String),
    Row(u32),
}

struct Press {
    held: Held,
    from: Point,
    x: f32,
}

pub struct State {
    /// The opened cards (Caelestia's `expandedNotifs`).
    open: HashSet<String>,
    /// Each card's place and height in the list, gliding.
    y: HashMap<String, Tween>,
    h: HashMap<String, Tween>,
    /// Sideways: each card's and each notice's (dragged, or flying off).
    gx: HashMap<String, Tween>,
    nx: HashMap<u32, Tween>,
    /// Flying off: closed once their glide ends.
    gone_g: HashSet<String>,
    gone_n: HashSet<u32>,
    /// Clear all: each card's turn.
    clearing: Vec<(Instant, String)>,
    lines: HashMap<u32, Lines>,
    heads: HashMap<String, Head>,
    scroll: Tween,
    scroll_to: f32,
    /// The list's whole height.
    full_h: f32,
    over: Over,
    press: Option<Press>,
    switches: Glide,
    capture: [Glide; 2],
    rec: recorder::State,
}

impl Side<'_> {
    fn groups(&self) -> Vec<Group<'_>> {
        let mut out: Vec<Group> = Vec::new();
        for n in self.list {
            match out.iter_mut().find(|g| g.app == n.app) {
                Some(g) => {
                    g.critical |= n.critical;
                    g.notices.push(n);
                }
                None => out.push(Group { app: &n.app, notices: vec![n], critical: n.critical }),
            }
        }
        out
    }

    fn recorder(&self) -> Recorder<'_> {
        Recorder { live: self.live, starting: self.starting, colours: self.colours, pictures: &self.pictures.rec }
    }

    /// The recorder's box, from the content's top left: over the switches, its height
    /// gliding.
    fn rec_rect(&self, s: &State, now: Instant) -> Rectangle {
        let h = s.rec.h(now);
        Rectangle { x: 0.0, y: self.switches_y() - style::MENU_PAD - h, width: W, height: h }
    }

    /// The list's box, from the content's top left: down to the recorder.
    fn dock_h(&self, s: &State, now: Instant) -> f32 {
        self.rec_rect(s, now).y - style::MENU_PAD
    }

    fn list_rect(&self, s: &State, now: Instant) -> Rectangle {
        let y = PAD + SMALL + TITLE_LINE + PAD;
        Rectangle { x: PAD, y, width: GW, height: (self.dock_h(s, now) - y - PAD).max(0.0) }
    }

    fn clear_rect(&self, s: &State, now: Instant) -> Rectangle {
        let side = style::CONTROL;
        Rectangle { x: W - PAD - side, y: self.dock_h(s, now) - PAD - side, width: side, height: side }
    }

    /// The pin: clear-all's button at the box's top right, on the title's line.
    fn pin_rect() -> Rectangle {
        let side = style::CONTROL;
        Rectangle { x: W - PAD - side, y: (PAD + SMALL + (TITLE_LINE - side) / 2.0).round(), width: side, height: side }
    }

    /// The switches: at the column's bottom.
    fn switches_y(&self) -> f32 {
        self.height - switches_h()
    }

    /// The switches' pill, its pictures by what is on now.
    fn switches(&self) -> Pill<'_> {
        let s = &self.pictures.switches;
        Pill(vec![Item { picture: &s[0][self.dark as usize], word: None }, Item { picture: &s[1][self.quiet as usize], word: None }])
    }

    /// The capture pills: replay (a recording's red dot and time, the check a moment
    /// after a save) and the camera.
    fn capture(&self) -> [Pill<'_>; 2] {
        let p = self.pictures;
        let replay = match self.recording {
            Some(time) => Item { picture: &p.dot, word: Some((time, p.time_w(time))) },
            None => Item { picture: if self.saved { &p.check } else { &p.replay }, word: None },
        };
        [Pill(vec![replay]), Pill(vec![Item { picture: &p.camera, word: None }])]
    }

    /// The row's pills from the content's top left (the switches, replay, the camera):
    /// centred, a gap-2 apart.
    fn pills_at(&self) -> [Point; 3] {
        let [rec, shot] = self.capture();
        let ws = [self.switches().w(), rec.w(), shot.w()];
        let mut x = ((W - ws.iter().sum::<f32>() - 2.0 * style::GAP_2) / 2.0).round();
        let y = self.switches_y() + row_top();
        ws.map(|w| {
            let at = Point::new(x, y);
            x += w + style::GAP_2;
            at
        })
    }

    /// A card's notices with their places from the card's top left: one line each shut
    /// (the first `PREVIEW`), each its own box open.
    fn rows(&self, s: &State, g: &Group, open: bool) -> Vec<(u32, Rectangle)> {
        let mut y = PAD + HEAD + if open { SMALL } else { 0.0 };
        let shown = if open { g.notices.len() } else { PREVIEW.min(g.notices.len()) };
        g.notices[..shown]
            .iter()
            .map(|n| {
                let h = if open { s.lines.get(&n.id).map_or(TITLE_LINE, Lines::open_h) } else { TITLE_LINE };
                let r = Rectangle { x: COL_X, y, width: COL_W, height: h };
                y += h + SMALL;
                (n.id, r)
            })
            .collect()
    }

    fn card_h(&self, s: &State, g: &Group, open: bool) -> f32 {
        let rows = self.rows(s, g, open);
        let column = rows.last().map_or(HEAD, |(_, r)| r.y + r.height - PAD);
        (2.0 * PAD + PICTURE.max(column)).ceil()
    }

    /// A card's place in the list, from the content's top left.
    fn card_rect(&self, s: &State, app: &str, now: Instant) -> Rectangle {
        let list = self.list_rect(s, now);
        let value = |m: &HashMap<String, Tween>| m.get(app).map_or(0.0, |t| t.value(now));
        Rectangle { x: list.x + value(&s.gx), y: list.y + value(&s.y) - s.scroll.value(now), width: GW, height: value(&s.h) }
    }

    /// An open notice's buttons from its box's top left: X (as wide as it is tall, or the
    /// whole row with no other), then the sender's, sharing the rest (the pop-ups').
    fn buttons(n: &Notice, h: f32) -> Vec<Rectangle> {
        let (x0, w) = (PAD, COL_W - 2.0 * PAD);
        let y = h - PAD - style::CONTROL;
        let k = n.actions.len();
        let x_w = if k == 0 { w } else { style::CONTROL };
        let mut out = vec![Rectangle { x: x0, y, width: x_w, height: style::CONTROL }];
        let each = ((w - x_w - k as f32 * SMALL) / k.max(1) as f32).floor();
        for i in 0..k {
            out.push(Rectangle { x: x0 + x_w + SMALL + i as f32 * (each + SMALL), y, width: each, height: style::CONTROL });
        }
        out
    }

    fn over(&self, s: &State, p: Point, now: Instant) -> Over {
        let rec = self.rec_rect(s, now);
        if let Some(part) = self.recorder().over(&s.rec, Point::new(p.x - rec.x, p.y - rec.y), rec.height, now) {
            return Over::Rec(part);
        }
        let [at, rec_at, shot_at] = self.pills_at();
        let switches = self.switches();
        if let Some(i) = switches.at(at, p) {
            return Over::Switch(i);
        }
        for (t, (pill, at)) in self.capture().iter().zip([rec_at, shot_at]).enumerate() {
            if pill.at(at, p).is_some() {
                return Over::Capture(t);
            }
        }
        if Self::pin_rect().contains(p) {
            return Over::Pin;
        }
        if !self.list.is_empty() && self.clear_rect(s, now).contains(p) {
            return Over::Clear;
        }
        if !self.list_rect(s, now).contains(p) {
            return Over::Nothing;
        }
        for g in self.groups() {
            let card = self.card_rect(s, g.app, now);
            if s.gone_g.contains(g.app) || !card.contains(p) {
                continue;
            }
            let local = Point::new(p.x - card.x, p.y - card.y);
            if let Some(head) = s.heads.get(g.app) {
                let w = head.pill_w();
                if (Rectangle { x: GW - PAD - w, y: PAD, width: w, height: PILL_H }).contains(local) {
                    return Over::Pill(g.app.into());
                }
            }
            let open = s.open.contains(g.app);
            for (id, r) in self.rows(s, &g, open) {
                if !r.contains(local) {
                    continue;
                }
                if open && let Some(n) = g.notices.iter().find(|n| n.id == id) {
                    let inner = Point::new(local.x - r.x, local.y - r.y);
                    if let Some(b) = Self::buttons(n, r.height).iter().position(|b| b.contains(inner)) {
                        return Over::Button(id, b);
                    }
                }
                return Over::Row(id);
            }
            return Over::Group(g.app.into());
        }
        Over::Nothing
    }

    /// A card flies off the way it was dragged and its notices close after.
    fn leave_group(s: &mut State, app: &str, way: f32, now: Instant) {
        if s.gone_g.insert(app.into()) {
            s.gx.entry(app.into()).or_insert_with(|| Tween::new(0.0, motion::SPATIAL)).go_with(way * GW, now, motion::SPATIAL_FAST);
        }
    }

    /// One notice flies off and closes after; a card's last takes its card with it
    /// (Windows' `NotifGroup`).
    fn leave_notice(&self, s: &mut State, id: u32, way: f32, now: Instant) {
        let Some(app) = self.list.iter().find(|n| n.id == id).map(|n| n.app.as_str()) else { return };
        if self.list.iter().filter(|n| n.app == app).count() == 1 {
            return Self::leave_group(s, app, way, now);
        }
        if s.gone_n.insert(id) {
            s.nx.entry(id).or_insert_with(|| Tween::new(0.0, motion::SPATIAL)).go_with(way * COL_W, now, motion::SPATIAL_FAST);
        }
    }

    fn app_of(&self, id: u32) -> Option<String> {
        self.list.iter().find(|n| n.id == id).map(|n| n.app.clone())
    }
}

impl Body for Side<'_> {
    type State = State;

    fn state(&self) -> State {
        State {
            open: HashSet::new(),
            y: HashMap::new(),
            h: HashMap::new(),
            gx: HashMap::new(),
            nx: HashMap::new(),
            gone_g: HashSet::new(),
            gone_n: HashSet::new(),
            clearing: Vec::new(),
            lines: HashMap::new(),
            heads: HashMap::new(),
            scroll: Tween::new(0.0, motion::EFFECTS),
            scroll_to: 0.0,
            full_h: 0.0,
            over: Over::Nothing,
            press: None,
            switches: Glide::new(),
            capture: [Glide::new(), Glide::new()],
            rec: self.recorder().state(),
        }
    }

    fn size(&self, s: &mut State) -> Size {
        let now = Instant::now();
        self.recorder().size(&mut s.rec, now);
        // Words measured once, again only when they change.
        let ids: HashSet<u32> = self.list.iter().map(|n| n.id).collect();
        s.lines.retain(|id, _| ids.contains(id));
        s.nx.retain(|id, _| ids.contains(id));
        for n in self.list {
            if s.lines.get(&n.id).is_none_or(|l| l.stale(n)) {
                s.lines.insert(n.id, Lines::new(n));
            }
        }
        // The cards: each glides to its place and height; a new one appears in place.
        let groups = self.groups();
        let apps: HashSet<&str> = groups.iter().map(|g| g.app).collect();
        for m in [&mut s.y, &mut s.h, &mut s.gx] {
            m.retain(|app, _| apps.contains(app.as_str()));
        }
        s.open.retain(|app| apps.contains(app.as_str()));
        s.heads.retain(|app, _| apps.contains(app.as_str()));
        let mut y = 0.0;
        for g in &groups {
            let age = notices::age(g.notices[0].at);
            let key = (g.notices.len(), age.clone());
            if s.heads.get(g.app).is_none_or(|h| h.key != key) {
                let count = g.notices.len().to_string();
                let count_w = width(&count, style::SMALL);
                let age_w = width(&age, style::SMALL);
                let pill_w = count_w + SMALL + style::ICON_SM as f32 + style::GAP_3;
                let name = cut(g.app, style::SMALL, COL_W - pill_w - age_w - 2.0 * SMALL);
                s.heads.insert(g.app.into(), Head { key, name, age, age_w, count, count_w });
            }
            let h = self.card_h(s, g, s.open.contains(g.app));
            if let (Some(ty), Some(th)) = (s.y.get_mut(g.app), s.h.get_mut(g.app)) {
                ty.go(y, now);
                th.go(h, now);
            } else {
                s.y.insert(g.app.into(), Tween::new(y, motion::SPATIAL));
                s.h.insert(g.app.into(), Tween::new(h, motion::SPATIAL));
            }
            y += h + SMALL;
        }
        s.full_h = (y - SMALL).max(0.0);
        let most = (s.full_h - self.list_rect(s, now).height).max(0.0);
        if s.scroll_to > most {
            s.scroll_to = most;
            s.scroll.go(most, now);
        }
        Size::new(W, self.height)
    }

    fn update(&self, s: &mut State, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        self.handle(s, event, at, now)
    }

    fn draw(&self, s: &State, renderer: &mut Renderer, content: Rectangle, alpha: f32, now: Instant) {
        self.draw_in(s, renderer, content, content, alpha, now);
    }

    /// The list over the recorder and switches, both cut to `clip` (the card's shown part).
    fn draw_in(&self, s: &State, renderer: &mut Renderer, c: Rectangle, clip: Rectangle, alpha: f32, now: Instant) {
        self.draw_list(s, renderer, c, clip, alpha, now);
        self.draw_foot(s, renderer, c, clip, alpha, now);
    }

    fn moving(&self, s: &State, now: Instant) -> bool {
        let any = |m: &HashMap<String, Tween>| m.values().any(|t| t.moving(now));
        s.press.is_some()
            || !s.gone_g.is_empty()
            || !s.gone_n.is_empty()
            || !s.clearing.is_empty()
            || s.scroll.moving(now)
            || s.switches.moving(now)
            || s.capture.iter().any(|g| g.moving(now))
            || self.recorder().moving(&s.rec, now)
            || any(&s.y)
            || any(&s.h)
            || any(&s.gx)
            || s.nx.values().any(|t| t.moving(now))
    }

    fn clickable(&self, s: &State) -> bool {
        !matches!(s.over, Over::Nothing)
    }

    fn busy(&self, s: &State) -> bool {
        s.press.is_some()
    }

    fn wake(&self, _s: &State, now: Instant) -> Option<Instant> {
        self.recorder().wake(now)
    }
}

impl Side<'_> {
    fn handle(&self, s: &mut State, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        // Clear all: each card's turn; then the ones done flying off are closed.
        let turns: Vec<String> = s.clearing.iter().filter(|(t, _)| now >= *t).map(|(_, app)| app.clone()).collect();
        s.clearing.retain(|(t, _)| now < *t);
        for app in turns {
            Self::leave_group(s, &app, 1.0, now);
        }
        let flown = |t: Option<&Tween>| t.is_none_or(|t| !t.moving(now));
        let mut done: Vec<u32> = s.gone_n.iter().copied().filter(|id| flown(s.nx.get(id))).collect();
        s.gone_n.retain(|id| !done.contains(id));
        let apps: Vec<String> = s.gone_g.iter().filter(|app| flown(s.gx.get(*app))).cloned().collect();
        s.gone_g.retain(|app| !apps.contains(app));
        done.extend(self.list.iter().filter(|n| apps.contains(&n.app)).map(|n| n.id));
        if !done.is_empty() {
            notices::dismiss_all(&done);
        }

        if !self.busy(s) {
            s.over = at.map_or(Over::Nothing, |p| self.over(s, p, now));
        }
        let switch = match s.over {
            Over::Switch(i) => Some(self.switches().span(i)),
            _ => None,
        };
        s.switches.go(switch, now);
        let part = match s.over {
            Over::Rec(part) => Some(part),
            _ => None,
        };
        self.recorder().hover(&mut s.rec, part, now);
        let pills = self.capture();
        for (t, glide) in s.capture.iter_mut().enumerate() {
            glide.go((s.over == Over::Capture(t)).then(|| pills[t].span(0)), now);
        }
        let toggle = |s: &mut State, app: String| {
            if !s.open.remove(&app) {
                s.open.insert(app);
            }
        };
        match event {
            Event::Mouse(mouse::Event::WheelScrolled { delta }) => {
                let Some(p) = at else { return Reply::None };
                let by = match delta {
                    mouse::ScrollDelta::Lines { y, .. } => -y * NOTCH,
                    mouse::ScrollDelta::Pixels { y, .. } => -y,
                };
                let rec = self.rec_rect(s, now);
                if self.recorder().wheel(&mut s.rec, by, Point::new(p.x - rec.x, p.y - rec.y), now) {
                    return Reply::Used;
                }
                if !self.list_rect(s, now).contains(p) {
                    return Reply::None;
                }
                let most = (s.full_h - self.list_rect(s, now).height).max(0.0);
                s.scroll_to = (s.scroll_to + by).clamp(0.0, most);
                s.scroll.go(s.scroll_to, now);
                Reply::Used
            }
            Event::Mouse(mouse::Event::CursorMoved { .. }) => {
                let (Some(press), Some(p)) = (&s.press, at) else { return Reply::None };
                let (x, dy) = (press.x + p.x - press.from.x, p.y - press.from.y);
                let (app, tween) = match &press.held {
                    Held::Group(app) => (Some(app.clone()), s.gx.get_mut(app)),
                    Held::Row(id) => (self.app_of(*id), s.nx.entry(*id).or_insert_with(|| Tween::new(0.0, motion::SPATIAL)).into()),
                };
                if let Some(t) = tween {
                    t.set(x);
                }
                // A notice's drag opens or shuts only a shut card (Caelestia's `NotifGroupList`).
                let can = matches!(press.held, Held::Group(_)) || app.as_ref().is_some_and(|a| !s.open.contains(a));
                if let Some(app) = app.filter(|_| can && dy.abs() > EXPAND)
                    && s.open.contains(&app) != (dy > 0.0)
                {
                    toggle(s, app);
                    return Reply::Used;
                }
                Reply::None
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                let Some(p) = at else { return Reply::None };
                match s.over.clone() {
                    Over::Nothing => return Reply::None,
                    Over::Rec(part) => return self.recorder().press(&mut s.rec, part, now),
                    Over::Switch(i) => return Reply::Pick(i),
                    Over::Capture(t) => return Reply::Pick(REC + t),
                    Over::Pin => return Reply::Pick(PIN),
                    Over::Clear => {
                        // Caelestia's pace: quicker the more there are.
                        let every = (69.8 - 12.3 * (self.list.len().max(1) as f32).ln()).clamp(15.0, 80.0);
                        s.clearing = self.groups().iter().enumerate().map(|(i, g)| (now + Duration::from_secs_f32(i as f32 * every / 1000.0), g.app.to_string())).collect();
                    }
                    Over::Pill(app) => toggle(s, app),
                    Over::Button(id, 0) => self.leave_notice(s, id, 1.0, now),
                    Over::Button(id, b) => {
                        if let Some(key) = self.list.iter().find(|n| n.id == id).and_then(|n| n.actions.get(b - 1)).map(|a| a.0.clone()) {
                            notices::invoke(id, key);
                        }
                    }
                    Over::Row(id) => {
                        let x = s.nx.get(&id).map_or(0.0, |t| t.value(now));
                        s.press = Some(Press { held: Held::Row(id), from: p, x });
                    }
                    Over::Group(app) => {
                        let x = s.gx.get(&app).map_or(0.0, |t| t.value(now));
                        s.press = Some(Press { held: Held::Group(app), from: p, x });
                    }
                }
                Reply::Used
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                let Some(press) = s.press.take() else { return Reply::None };
                match press.held {
                    Held::Group(app) => {
                        let x = s.gx.get(&app).map_or(0.0, |t| t.value(now));
                        if x.abs() < CLEAR * GW {
                            if let Some(t) = s.gx.get_mut(&app) {
                                t.go(0.0, now);
                            }
                        } else {
                            Self::leave_group(s, &app, x.signum(), now);
                        }
                    }
                    Held::Row(id) => {
                        let x = s.nx.get(&id).map_or(0.0, |t| t.value(now));
                        if x.abs() < CLEAR * COL_W {
                            if let Some(t) = s.nx.get_mut(&id) {
                                t.go(0.0, now);
                            }
                        } else {
                            self.leave_notice(s, id, x.signum(), now);
                        }
                    }
                }
                Reply::Used
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Right)) => {
                let app = match s.over.clone() {
                    Over::Group(app) | Over::Pill(app) => Some(app),
                    Over::Row(id) | Over::Button(id, _) => self.app_of(id),
                    _ => None,
                };
                let Some(app) = app else { return Reply::None };
                toggle(s, app);
                Reply::Used
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Middle)) => {
                match s.over.clone() {
                    Over::Group(app) | Over::Pill(app) => Self::leave_group(s, &app, 1.0, now),
                    Over::Row(id) | Over::Button(id, _) => self.leave_notice(s, id, 1.0, now),
                    _ => return Reply::None,
                }
                Reply::Used
            }
            _ => Reply::None,
        }
    }

    /// The list's box: its card, title, pin, cards and clear-all, from the column's top
    /// left `c` (moved as its box slides in), cut to `clip`.
    fn draw_list(&self, s: &State, renderer: &mut Renderer, c: Rectangle, clip: Rectangle, alpha: f32, now: Instant) {
        let col = &self.colours;
        let fade = |colour: Color, by: f32| Color { a: colour.a * alpha * by, ..colour };
        let hover = |on: Color, by: f32| fade(Color { a: style::HOVER, ..on }, by);
        let quad = |b: Rectangle, radius: f32| renderer::Quad { bounds: b, border: border::rounded(radius), ..Default::default() };
        let at = |r: Rectangle| Rectangle { x: (c.x + r.x).round(), y: (c.y + r.y).round(), width: r.width.round(), height: r.height.round() };
        let centred = |b: Rectangle, side: f32| Rectangle { x: b.x + ((b.width - side) / 2.0).round(), y: b.y + ((b.height - side) / 2.0).round(), width: side, height: side };
        let picture = |renderer: &mut Renderer, h: &image::Handle, b: Rectangle, by: f32, clip: Rectangle| {
            renderer.draw_image(img::Image { opacity: alpha * by, ..img::Image::new(h.clone()) }, b, clip);
        };

        let dock = at(Rectangle { x: 0.0, y: 0.0, width: W, height: self.dock_h(s, now) });
        renderer.fill_quad(quad(dock, style::CORNER), fade(col.panel, 1.0));
        // Caelestia's title: the count, then "notifications".
        let title = match self.list.len() {
            0 => "Notifications".to_string(),
            1 => "1 notification".to_string(),
            n => format!("{n} notifications"),
        };
        // The Quick toggles title's size (Malthaiel's call 2026-11-04).
        let to = Point::new(dock.x + PAD + SMALL, dock.y + PAD + SMALL + TITLE_LINE / 2.0);
        say(renderer, bold(words(&title, style::BODY, f32::INFINITY, false)), to, fade(col.text_muted, 1.0), dock, clip);

        let list = at(self.list_rect(s, now));
        if self.list.is_empty() {
            // Caelestia's empty list: its picture and "All up to date!".
            let (side, line) = (DINO as f32, style::TITLE * style::LINE_TIGHT);
            let top = (list.y + (list.height - side - style::GAP_3 - line) / 2.0).round();
            picture(renderer, &self.pictures.dino, Rectangle { x: (list.x + (list.width - side) / 2.0).round(), y: top, width: side, height: side }, 1.0, clip);
            let words_w = width("All up to date!", style::TITLE);
            let to = Point::new((list.x + (list.width - words_w) / 2.0).round(), top + side + style::GAP_3 + line / 2.0);
            say(renderer, words("All up to date!", style::TITLE, f32::INFINITY, false), to, fade(col.text_faint, 1.0), list, clip);
        } else if let Some(shown) = list.intersection(&clip) {
            renderer.with_layer(shown, |renderer| {
                for g in self.groups() {
                    self.draw_card(s, renderer, &g, at(self.card_rect(s, g.app, now)), shown, alpha, now);
                }
            });
            // Clear all, over the list's bottom right (Caelestia's `clearBtn`).
            let b = at(self.clear_rect(s, now));
            renderer.fill_quad(quad(b, b.height / 2.0), fade(col.raised, 1.0));
            if s.over == Over::Clear {
                renderer.fill_quad(quad(b, b.height / 2.0), hover(col.text, 1.0));
            }
            picture(renderer, &self.pictures.clear, centred(b, style::ICON as f32), 1.0, clip);
        }
        // The pin: clear-all's look; pinned, Accent with the pin in On Accent.
        let b = at(Self::pin_rect());
        renderer.fill_quad(quad(b, b.height / 2.0), fade(if self.pinned { col.accent } else { col.raised }, 1.0));
        if s.over == Over::Pin {
            renderer.fill_quad(quad(b, b.height / 2.0), hover(if self.pinned { col.on_accent } else { col.text }, 1.0));
        }
        picture(renderer, &self.pictures.pin[self.pinned as usize], centred(b, style::ICON as f32), 1.0, clip);
    }

    /// The corner box: the recorder (`recorder.rs`) over the switches (Caelestia's
    /// `Toggles.qml`), strip pills, no title; the list's colour, the box's padding below
    /// the list, no line between them (Malthaiel's calls 2026-11-03, the title gone
    /// 2026-11-04). From the column's top left `c`, cut to `clip`; the modes' list last,
    /// over the rest.
    fn draw_foot(&self, s: &State, renderer: &mut Renderer, c: Rectangle, clip: Rectangle, alpha: f32, now: Instant) {
        let col = &self.colours;
        let quad = |b: Rectangle, radius: f32| renderer::Quad { bounds: b, border: border::rounded(radius), ..Default::default() };
        let at = |r: Rectangle| Rectangle { x: (c.x + r.x).round(), y: (c.y + r.y).round(), width: r.width.round(), height: r.height.round() };
        let fade = |colour: Color| Color { a: colour.a * alpha, ..colour };
        let card = at(Rectangle { x: 0.0, y: self.switches_y(), width: W, height: switches_h() });
        renderer.fill_quad(quad(card, style::CORNER), fade(col.panel));
        let [p, rec, shot] = self.pills_at();
        let on = |p: Point| Point::new(c.x + p.x, c.y + p.y);
        self.switches().draw(renderer, on(p), &s.switches, col, alpha, clip, now);
        for ((pill, p), glide) in self.capture().iter().zip([rec, shot]).zip(&s.capture) {
            pill.draw(renderer, on(p), glide, col, alpha, clip, now);
        }
        let r = self.rec_rect(s, now);
        let rec = Rectangle { x: (c.x + r.x).round(), y: (c.y + r.y).round(), width: r.width, height: r.height.round() };
        let part = match s.over {
            Over::Rec(part) => Some(part),
            _ => None,
        };
        self.recorder().draw(&s.rec, renderer, rec, clip, alpha, part, now);
    }

    /// One program's card at `card` (on the screen), cut to the list's `shown` part.
    #[allow(clippy::too_many_arguments)]
    fn draw_card(&self, s: &State, renderer: &mut Renderer, g: &Group, card: Rectangle, shown: Rectangle, alpha: f32, now: Instant) {
        if card.intersection(&shown).is_none() {
            return;
        }
        let col = &self.colours;
        // Flying off: it fades as it goes.
        let by = (1.0 - s.gx.get(g.app).map_or(0.0, |t| t.value(now)).abs() / GW).clamp(0.0, 1.0);
        let fade = |colour: Color, f: f32| Color { a: colour.a * alpha * by * f, ..colour };
        let quad = |b: Rectangle, radius: f32| renderer::Quad { bounds: b, border: border::rounded(radius), ..Default::default() };
        let centred = |b: Rectangle, side: f32| Rectangle { x: b.x + ((b.width - side) / 2.0).round(), y: b.y + ((b.height - side) / 2.0).round(), width: side, height: side };
        renderer.fill_quad(quad(card, style::CORNER), fade(col.raised, 1.0));

        let spot = Rectangle { x: card.x + PAD, y: card.y + PAD, width: PICTURE, height: PICTURE };
        let (face, badge) = self.faces.get(g.app).map_or((None, None), |(f, b)| (f.as_ref(), b.as_ref()));
        popups::picture(renderer, spot, (face, badge), g.critical, col, self.cards, alpha * by, shown);

        // The header: the name, the newest's age, the count pill with its arrow.
        if let Some(head) = s.heads.get(g.app) {
            let line = card.y + PAD + HEAD / 2.0;
            let x = card.x + COL_X;
            say(renderer, words(&head.name, style::SMALL, f32::INFINITY, false), Point::new(x, line), fade(col.text_muted, 1.0), card, shown);
            let w = head.pill_w();
            let pill = Rectangle { x: card.x + GW - PAD - w, y: card.y + PAD, width: w, height: PILL_H };
            let age = pill.x - SMALL - head.age_w;
            say(renderer, words(&head.age, style::SMALL, f32::INFINITY, false), Point::new(age, line), fade(col.text_faint, 1.0), card, shown);
            let patch = |by: f32| Color { a: style::HOVER * by, ..col.text };
            renderer.fill_quad(quad(pill, PILL_H / 2.0), fade(patch(if s.over == Over::Pill(g.app.into()) { 2.0 } else { 1.0 }), 1.0));
            let count_x = pill.x + style::GAP_3 / 2.0;
            say(renderer, words(&head.count, style::SMALL, f32::INFINITY, false), Point::new(count_x, line), fade(col.text_muted, 1.0), card, shown);
            let arrow = style::ICON_SM as f32;
            let spot = Rectangle { x: count_x + head.count_w + SMALL, y: (pill.center_y() - arrow / 2.0).round(), width: arrow, height: arrow };
            // Opened, the arrow points up (Caelestia turns it).
            let shape = if s.open.contains(g.app) { &self.pictures.up } else { &self.pictures.down };
            renderer.draw_image(img::Image { opacity: alpha * by, ..img::Image::new(shape.clone()) }, spot, shown);
        }

        let open = s.open.contains(g.app);
        for (id, r) in self.rows(s, g, open) {
            let (Some(n), Some(l)) = (g.notices.iter().find(|n| n.id == id), s.lines.get(&id)) else { continue };
            let dx = s.nx.get(&id).map_or(0.0, |t| t.value(now));
            let row_by = (1.0 - dx.abs() / COL_W).clamp(0.0, 1.0);
            let b = Rectangle { x: (card.x + r.x + dx).round(), y: (card.y + r.y).round(), width: r.width, height: r.height.round() };
            let fade = |colour: Color| Color { a: colour.a * alpha * by * row_by, ..colour };
            if !open {
                let line = b.y + TITLE_LINE / 2.0;
                say(renderer, words(&l.title, style::BODY, f32::INFINITY, false), Point::new(b.x, line), fade(col.text), card, shown);
                if !l.preview.is_empty() {
                    let to = Point::new(b.x + l.title_w + SMALL, line);
                    say(renderer, words(&l.preview, style::SMALL, f32::INFINITY, false), to, fade(col.text_muted), card, shown);
                }
                continue;
            }
            // Opened: its own box, the whole title beside its age, the body, the buttons.
            renderer.fill_quad(quad(b, style::CORNER), fade(col.panel));
            let inner = COL_W - 2.0 * PAD;
            say(renderer, words(&n.summary, style::BODY, inner - l.age_w - SMALL, true), Point::new(b.x + PAD, b.y + PAD), fade(col.text), card, shown);
            let age = notices::age(n.at);
            let to = Point::new(b.x + b.width - PAD - l.age_w, b.y + PAD + TITLE_LINE / 2.0);
            say(renderer, words(&age, style::SMALL, f32::INFINITY, false), to, fade(col.text_faint), card, shown);
            let body = if n.body.is_empty() { NO_BODY } else { &n.body };
            say(renderer, words(body, style::SMALL, inner, true), Point::new(b.x + PAD, b.y + PAD + l.title_h + SMALL), fade(col.text_muted), card, shown);
            for (i, button) in Self::buttons(n, b.height).into_iter().enumerate() {
                let button = Rectangle { x: b.x + button.x, y: b.y + button.y, ..button };
                renderer.fill_quad(quad(button, button.height / 2.0), fade(col.raised));
                if s.over == Over::Button(id, i) {
                    renderer.fill_quad(quad(button, button.height / 2.0), fade(Color { a: style::HOVER, ..col.text }));
                }
                if i == 0 {
                    renderer.draw_image(img::Image { opacity: alpha * by * row_by, ..img::Image::new(self.cards.close.clone()) }, centred(button, style::ICON as f32), shown);
                } else if let Some((_, label)) = n.actions.get(i - 1) {
                    let label = cut(label, style::SMALL, button.width - 2.0 * PAD);
                    let w = width(&label, style::SMALL);
                    let to = Point::new((button.x + (button.width - w) / 2.0).round(), button.center_y());
                    say(renderer, words(&label, style::SMALL, f32::INFINITY, false), to, fade(col.text), card, shown);
                }
            }
        }
    }
}
