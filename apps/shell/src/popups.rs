//! The notices' pop-ups (M&P Shell plan, step 2): Caelestia's
//! `modules/notifications/Content.qml` + `Notification.qml` (@bcbb5d5) inside the `Menu`
//! card at the top right, sliding in from behind the right edge (`Edge::Corner`).
//! Caelestia's card motion, every size from the rulebook (his pick 2026-11-03).
//!
//! Newest on top; a new card slides in from the right as the rest glide down, a
//! leaving one flies out sideways as the rest close up. A card: the picture (the
//! sender's, the program's as a badge on it, or the program's alone), the title, a
//! dot and its age, one line of the body, and an arrow that opens it all: the
//! program's name, the whole title and body, and its buttons (X, then the sender's).
//! Caelestia's hands: the pointer on a card holds its time; dragged sideways past 30%
//! it leaves the corner (it stays in the list); dragged 20 px down it opens, up it
//! shuts; a middle click or X closes it.

use iced::advanced::image::{self as img, Renderer as _};
use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::{Renderer as _, renderer};
use iced::alignment::Vertical;
use iced::time::Instant;
use iced::widget::image;
use iced::{Color, Event, Pixels, Point, Rectangle, Renderer, Size, border, mouse};

use crate::colours::Colours;
use crate::menu::{Body, Reply};
use crate::motion::{self, Tween};
use crate::notices::{self, Notice};
use crate::{icon, style};

/// The box's width: Caelestia's `sizes.notifs.width` (= its sidebar's, and Windows'
/// `--side-w`); off the rulebook, built to show him.
pub const WIDTH: f32 = 430.0;
const CARD: f32 = WIDTH - 2.0 * style::MENU_PAD;
/// A card's padding and the room between cards (Caelestia `padding.medium`,
/// `spacing.medium`), and between a line's parts (`spacing.small`).
const PAD: f32 = style::GAP_2;
const SPACE: f32 = style::GAP_2;
const SMALL_GAP: f32 = style::GAP_1;
const PICTURE: f32 = notices::PICTURE as f32;
/// The program's badge on the sender's picture (Caelestia `sizes.notifs.badge` 20).
const BADGE: f32 = style::ICON as f32;
const ARROW: f32 = style::ICON as f32;
const TEXT_X: f32 = PAD + PICTURE + style::GAP_2;
/// Where the text and the buttons end: the arrow's room on the right.
const TEXT_W: f32 = CARD - TEXT_X - PAD - ARROW - SMALL_GAP;
/// Caelestia `notifs.clearThreshold` and `expandThreshold`.
const CLEAR: f32 = 0.3;
const EXPAND: f32 = 20.0;
const TITLE_LINE: f32 = style::BODY * style::LINE_TIGHT;
const SMALL_LINE: f32 = style::SMALL * style::LINE_TIGHT;

/// The cards' own pictures, drawn on start and on a recolour.
pub struct Pictures {
    pub(crate) down: image::Handle,
    pub(crate) up: image::Handle,
    pub(crate) close: image::Handle,
    bell: image::Handle,
    /// The bell on a critical notice's `error` circle.
    bell_on_error: image::Handle,
}

impl Pictures {
    pub fn new(c: &Colours) -> Self {
        let bell = include_bytes!("../assets/bx-bell.svg");
        Self {
            down: icon::svg(include_bytes!("../assets/bx-chevron-down.svg"), style::ICON, c.text),
            up: icon::svg(include_bytes!("../assets/bx-chevron-up.svg"), style::ICON, c.text),
            close: icon::svg(include_bytes!("../assets/bx-x.svg"), style::ICON, c.text),
            bell: icon::svg(bell, style::ICON, c.text),
            bell_on_error: icon::svg(bell, style::ICON, c.frame),
        }
    }
}

pub struct Popups<'a> {
    /// The ones popping up, newest first (`notices::popups`).
    pub cards: &'a [Notice],
    pub colours: Colours,
    pub pictures: &'a Pictures,
}

pub(crate) fn words(content: &str, size: f32, width: f32, wrap: bool) -> text::Text<&str> {
    text::Text {
        content,
        bounds: Size::new(width, f32::INFINITY),
        size: Pixels(size),
        line_height: if wrap { style::LINE } else { style::LINE_TIGHT }.into(),
        font: crate::MEDIUM,
        align_x: text::Alignment::Left,
        align_y: if wrap { Vertical::Top } else { Vertical::Center },
        shaping: text::Shaping::Basic,
        wrapping: if wrap { text::Wrapping::WordOrGlyph } else { text::Wrapping::None },
    }
}

pub(crate) fn width(s: &str, size: f32) -> f32 {
    <Renderer as text::Renderer>::Paragraph::with_text(words(s, size, f32::INFINITY, false)).min_width()
}

pub(crate) fn tall(s: &str, size: f32, w: f32) -> f32 {
    if s.is_empty() { 0.0 } else { <Renderer as text::Renderer>::Paragraph::with_text(words(s, size, w, true)).min_bounds().height.ceil() }
}

/// `s` on one line, cut with an ellipsis to `w` (Caelestia's `ElideRight`).
pub(crate) fn cut(s: &str, size: f32, w: f32) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if width(&one, size) <= w {
        return one;
    }
    let chars: Vec<char> = one.chars().collect();
    let shown = |n: usize| chars[..n].iter().collect::<String>().trim_end().to_string() + "\u{2026}";
    let (mut lo, mut hi) = (0, chars.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if width(&shown(mid), size) <= w { lo = mid } else { hi = mid - 1 }
    }
    shown(lo)
}

/// A card's words, measured: cut again only when they change (and the age, whose
/// width the title shares).
struct Lines {
    key: (String, String, String, String),
    age: String,
    title: String,
    preview: String,
    name: String,
    /// The whole title and body, wrapped, when open.
    title_h: f32,
    body_h: f32,
}

impl Lines {
    fn new(n: &Notice) -> Self {
        let age = notices::age(n.at);
        let key = (n.summary.clone(), n.body.clone(), n.app.clone(), age.clone());
        let after = 2.0 * SMALL_GAP + width("\u{2022}", style::SMALL) + width(&age, style::SMALL);
        Self {
            title: cut(&n.summary, style::BODY, TEXT_W - after),
            preview: cut(&n.body, style::SMALL, TEXT_W),
            name: cut(&n.app, style::SMALL, TEXT_W - after),
            title_h: tall(&n.summary, style::BODY, TEXT_W),
            body_h: tall(&n.body, style::SMALL, TEXT_W),
            key,
            age,
        }
    }

    fn stale(&self, n: &Notice) -> bool {
        (&self.key.0, &self.key.1, &self.key.2) != (&n.summary, &n.body, &n.app) || self.key.3 != notices::age(n.at)
    }
}

struct Card {
    n: Notice,
    lines: Lines,
    x: Tween,
    y: Tween,
    h: Tween,
    open: bool,
    leaving: bool,
    fresh: bool,
}

impl Card {
    fn shut_h() -> f32 {
        (2.0 * PAD + PICTURE.max(TITLE_LINE + SMALL_LINE)).ceil()
    }

    fn open_h(&self) -> f32 {
        let body = if self.lines.body_h > 0.0 { self.lines.body_h + SMALL_GAP } else { 0.0 };
        (2.0 * PAD + TITLE_LINE + SMALL_GAP + self.lines.title_h + SMALL_GAP + body + style::CONTROL).ceil()
    }

    fn target_h(&self) -> f32 {
        if self.open { self.open_h() } else { Self::shut_h() }
    }

    /// 0 shut .. 1 open, by its height now: what fades in and out with it.
    fn opened(&self, now: Instant) -> f32 {
        let (shut, open) = (Self::shut_h(), self.open_h());
        if open <= shut {
            return if self.open { 1.0 } else { 0.0 };
        }
        ((self.h.value(now) - shut) / (open - shut)).clamp(0.0, 1.0)
    }

    /// Off sideways, the way it was dragged (Caelestia's `removeAnim`).
    fn leave(&mut self, now: Instant) {
        if !self.leaving {
            self.leaving = true;
            let way = if self.x.value(now) >= 0.0 { 1.0 } else { -1.0 };
            self.x.go_with(way * 2.0 * CARD, now, motion::SPATIAL_FAST);
        }
    }

    fn rect(&self, now: Instant) -> Rectangle {
        Rectangle { x: self.x.value(now), y: self.y.value(now), width: CARD, height: self.h.value(now) }
    }

    /// The arrow's spot from the card's top left, and the room round it that takes a click.
    fn arrow() -> Rectangle {
        Rectangle { x: CARD - PAD - ARROW, y: PAD + ((TITLE_LINE - ARROW) / 2.0).round(), width: ARROW, height: ARROW }
    }

    /// The buttons when open, from the card's top left: X (as wide as it is tall, or
    /// the whole row with no other), then the sender's, sharing the rest.
    fn buttons(&self) -> Vec<Rectangle> {
        let y = self.open_h() - PAD - style::CONTROL;
        let n = self.n.actions.len();
        let mut out = Vec::with_capacity(n + 1);
        let x_w = if n == 0 { TEXT_W } else { style::CONTROL };
        out.push(Rectangle { x: TEXT_X, y, width: x_w, height: style::CONTROL });
        if n > 0 {
            let each = ((TEXT_W - x_w - n as f32 * SMALL_GAP) / n as f32).floor();
            for i in 0..n {
                let x = TEXT_X + x_w + SMALL_GAP + i as f32 * (each + SMALL_GAP);
                out.push(Rectangle { x, y, width: each, height: style::CONTROL });
            }
        }
        out
    }
}

/// What the pointer is on.
#[derive(Clone, Copy, PartialEq)]
enum Over {
    Nothing,
    Arrow(u32),
    Button(u32, usize),
}

struct Press {
    id: u32,
    from: Point,
    x: f32,
}

pub struct State {
    cards: Vec<Card>,
    hovered: Option<u32>,
    over: Over,
    press: Option<Press>,
}

fn grow(r: Rectangle, by: f32) -> Rectangle {
    Rectangle { x: r.x - by, y: r.y - by, width: r.width + 2.0 * by, height: r.height + 2.0 * by }
}

impl Popups<'_> {
    /// The cards matched to the notices: new ones slide in, gone ones fly out where
    /// they were; the rest glide to their places. Returns the cards' whole height.
    fn reconcile(&self, s: &mut State, now: Instant) -> f32 {
        let mut kept: Vec<Option<Card>> = std::mem::take(&mut s.cards).into_iter().map(Some).collect();
        let mut cards = Vec::with_capacity(self.cards.len());
        for n in self.cards {
            let found = kept.iter_mut().find(|c| c.as_ref().is_some_and(|c| c.n.id == n.id && !c.leaving)).and_then(Option::take);
            let mut card = found.unwrap_or_else(|| {
                let mut x = Tween::new(CARD, motion::SPATIAL);
                x.go(0.0, now);
                Card { lines: Lines::new(n), n: n.clone(), x, y: Tween::new(0.0, motion::SPATIAL), h: Tween::new(0.0, motion::SPATIAL), open: false, leaving: false, fresh: true }
            });
            if card.lines.stale(n) {
                card.lines = Lines::new(n);
            }
            card.n = n.clone();
            cards.push(card);
        }
        for (i, card) in kept.into_iter().enumerate() {
            let Some(mut card) = card else { continue };
            card.leave(now);
            if card.x.moving(now) {
                cards.insert(i.min(cards.len()), card);
            }
        }
        let mut y = 0.0;
        for c in cards.iter_mut().filter(|c| !c.leaving) {
            let h = c.target_h();
            if c.fresh {
                c.y.set(y);
                c.h.set(h);
                c.fresh = false;
            } else {
                c.y.go(y, now);
                c.h.go(h, now);
            }
            y += h + SPACE;
        }
        s.cards = cards;
        (y - SPACE).max(0.0)
    }

    fn card_at(s: &State, p: Point, now: Instant) -> Option<usize> {
        s.cards.iter().position(|c| !c.leaving && c.rect(now).contains(p))
    }

    fn over(s: &State, p: Point, now: Instant) -> Over {
        let Some(i) = Self::card_at(s, p, now) else { return Over::Nothing };
        let c = &s.cards[i];
        let at = c.rect(now);
        let local = Point::new(p.x - at.x, p.y - at.y);
        if grow(Card::arrow(), SMALL_GAP).contains(local) {
            return Over::Arrow(c.n.id);
        }
        if c.open
            && c.opened(now) > 0.5
            && let Some(b) = c.buttons().iter().position(|b| b.contains(local))
        {
            return Over::Button(c.n.id, b);
        }
        Over::Nothing
    }
}

impl Body for Popups<'_> {
    type State = State;

    fn state(&self) -> State {
        State { cards: Vec::new(), hovered: None, over: Over::Nothing, press: None }
    }

    fn size(&self, s: &mut State) -> Size {
        Size::new(CARD, self.reconcile(s, Instant::now()))
    }

    fn update(&self, s: &mut State, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        // A card whose time ran out leaves (its time is held while the pointer is on it).
        for c in s.cards.iter_mut().filter(|c| !c.leaving) {
            if c.n.until.is_some_and(|u| now >= u) {
                notices::popdown(c.n.id);
                c.leave(now);
            }
        }
        let held = s.press.as_ref().map(|p| p.id);
        if held.is_none() {
            let hovered = at.and_then(|p| Self::card_at(s, p, now)).map(|i| s.cards[i].n.id);
            if hovered != s.hovered {
                if let Some(old) = s.hovered {
                    notices::hold(old, false);
                }
                if let Some(new) = hovered {
                    notices::hold(new, true);
                }
                s.hovered = hovered;
            }
        }
        s.over = at.map_or(Over::Nothing, |p| Self::over(s, p, now));
        match event {
            Event::Mouse(mouse::Event::CursorMoved { .. }) => {
                if let (Some(press), Some(p)) = (&s.press, at) {
                    let (id, from, x) = (press.id, press.from, press.x);
                    if let Some(c) = s.cards.iter_mut().find(|c| c.n.id == id && !c.leaving) {
                        c.x.set(x + p.x - from.x);
                        let dy = p.y - from.y;
                        if dy.abs() > EXPAND && c.open != (dy > 0.0) {
                            // Its new height reaches the box on the next layout (`Reply::Used`).
                            c.open = dy > 0.0;
                            return Reply::Used;
                        }
                    }
                }
                Reply::None
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                let Some(id) = s.hovered else { return Reply::None };
                match s.over {
                    Over::Arrow(id) => {
                        if let Some(c) = s.cards.iter_mut().find(|c| c.n.id == id && !c.leaving) {
                            c.open = !c.open;
                        }
                    }
                    Over::Button(id, 0) => {
                        notices::dismiss(id);
                        if let Some(c) = s.cards.iter_mut().find(|c| c.n.id == id) {
                            c.leave(now);
                        }
                    }
                    Over::Button(id, b) => {
                        let key = s.cards.iter().find(|c| c.n.id == id).and_then(|c| c.n.actions.get(b - 1)).map(|a| a.0.clone());
                        if let Some(key) = key {
                            notices::invoke(id, key);
                        }
                    }
                    Over::Nothing => {
                        let x = s.cards.iter().find(|c| c.n.id == id).map_or(0.0, |c| c.x.value(now));
                        s.press = at.map(|from| Press { id, from, x });
                    }
                }
                Reply::Used
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Middle)) => {
                let Some(id) = s.hovered else { return Reply::None };
                notices::dismiss(id);
                if let Some(c) = s.cards.iter_mut().find(|c| c.n.id == id) {
                    c.leave(now);
                }
                s.hovered = None;
                Reply::Used
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                let Some(press) = s.press.take() else { return Reply::None };
                if let Some(c) = s.cards.iter_mut().find(|c| c.n.id == press.id && !c.leaving) {
                    if c.x.value(now).abs() < CLEAR * CARD {
                        c.x.go(0.0, now);
                    } else {
                        notices::popdown(c.n.id);
                        c.leave(now);
                    }
                }
                // Let go off the card: its time starts again (Caelestia's `onReleased`).
                let still = at.and_then(|p| Self::card_at(s, p, now)).map(|i| s.cards[i].n.id);
                if still != Some(press.id) {
                    notices::hold(press.id, false);
                    s.hovered = None;
                }
                Reply::Used
            }
            _ => Reply::None,
        }
    }

    fn draw(&self, s: &State, renderer: &mut Renderer, content: Rectangle, alpha: f32, now: Instant) {
        self.draw_in(s, renderer, content, grow(content, style::MENU_PAD), alpha, now);
    }

    fn draw_in(&self, s: &State, renderer: &mut Renderer, content: Rectangle, clip: Rectangle, alpha: f32, now: Instant) {
        let c = &self.colours;
        let p = self.pictures;
        let fade = |colour: Color, by: f32| Color { a: colour.a * alpha * by, ..colour };
        for card in &s.cards {
            let r = card.rect(now);
            let at = Rectangle { x: (content.x + r.x).round(), y: (content.y + r.y).round(), width: CARD, height: r.height.round() };
            let Some(cut) = at.intersection(&clip) else { continue };
            let n = &card.n;
            let open = card.opened(now);
            renderer.with_layer(cut, |renderer| {
                let quad = |b: Rectangle, radius: f32| renderer::Quad { bounds: b, border: border::rounded(radius), ..Default::default() };
                renderer.fill_quad(quad(at, style::CORNER), fade(c.raised, 1.0));

                let spot = Rectangle { x: at.x + PAD, y: at.y + PAD, width: PICTURE, height: PICTURE };
                picture(renderer, spot, (n.face.as_ref(), n.badge.as_ref()), n.critical, c, p, alpha, cut);
                let centred = |b: Rectangle, side: f32| Rectangle { x: b.x + ((b.width - side) / 2.0).round(), y: b.y + ((b.height - side) / 2.0).round(), width: side, height: side };

                let l = &card.lines;
                let x = at.x + TEXT_X;
                let line1 = at.y + PAD + TITLE_LINE / 2.0;
                let say = |renderer: &mut Renderer, words: text::Text<&str>, to: Point, colour: Color| say(renderer, words, to, colour, at, cut);
                // The first line: shut, the title then the dot and age; open, the
                // program's name in its place (the title moves down to wrap).
                let dot_age = |renderer: &mut Renderer, from: f32, by: f32| {
                    let dot = from + SMALL_GAP;
                    say(renderer, words("\u{2022}", style::SMALL, f32::INFINITY, false), Point::new(dot, line1), fade(c.text_muted, by));
                    let age = dot + width("\u{2022}", style::SMALL) + SMALL_GAP;
                    say(renderer, words(&l.age, style::SMALL, f32::INFINITY, false), Point::new(age, line1), fade(c.text_muted, by));
                };
                if open < 1.0 {
                    let by = 1.0 - open;
                    say(renderer, words(&l.title, style::BODY, f32::INFINITY, false), Point::new(x, line1), fade(c.text, by));
                    dot_age(renderer, x + width(&l.title, style::BODY), by);
                    let line2 = at.y + PAD + TITLE_LINE + SMALL_LINE / 2.0;
                    say(renderer, words(&l.preview, style::SMALL, f32::INFINITY, false), Point::new(x, line2), fade(c.text_muted, by));
                }
                if open > 0.0 {
                    say(renderer, words(&l.name, style::SMALL, f32::INFINITY, false), Point::new(x, line1), fade(c.text_muted, open));
                    dot_age(renderer, x + width(&l.name, style::SMALL), open);
                    let title = at.y + PAD + TITLE_LINE + SMALL_GAP;
                    say(renderer, words(&n.summary, style::BODY, TEXT_W, true), Point::new(x, title), fade(c.text, open));
                    let body = title + l.title_h + SMALL_GAP;
                    if l.body_h > 0.0 {
                        say(renderer, words(&n.body, style::SMALL, TEXT_W, true), Point::new(x, body), fade(c.text_muted, open));
                    }
                    for (i, b) in card.buttons().into_iter().enumerate() {
                        let b = Rectangle { x: at.x + b.x, y: at.y + b.y, ..b };
                        renderer.fill_quad(quad(b, b.height / 2.0), fade(c.panel, open));
                        if s.over == Over::Button(n.id, i) {
                            renderer.fill_quad(quad(b, b.height / 2.0), fade(Color { a: style::HOVER, ..c.text }, open));
                        }
                        if i == 0 {
                            renderer.draw_image(img::Image { opacity: alpha * open, ..img::Image::new(p.close.clone()) }, centred(b, style::ICON as f32), cut);
                        } else if let Some((_, label)) = n.actions.get(i - 1) {
                            let label = cut_label(label, b.width - 2.0 * PAD);
                            let w = width(&label, style::SMALL);
                            say(renderer, words(&label, style::SMALL, f32::INFINITY, false), Point::new((b.x + (b.width - w) / 2.0).round(), b.center_y()), fade(c.text, open));
                        }
                    }
                }

                // The arrow, a hover patch round it as Caelestia's `StateLayer`.
                let arrow = Card::arrow();
                let arrow = Rectangle { x: at.x + arrow.x, y: at.y + arrow.y, ..arrow };
                if s.over == Over::Arrow(n.id) {
                    renderer.fill_quad(quad(grow(arrow, SMALL_GAP), ARROW / 2.0 + SMALL_GAP), fade(Color { a: style::HOVER, ..c.text }, 1.0));
                }
                let shape = if card.open { &p.up } else { &p.down };
                renderer.draw_image(img::Image { opacity: alpha, ..img::Image::new(shape.clone()) }, arrow, cut);
            });
        }
    }

    fn moving(&self, s: &State, now: Instant) -> bool {
        s.press.is_some() || s.cards.iter().any(|c| c.x.moving(now) || c.y.moving(now) || c.h.moving(now))
    }

    fn clickable(&self, s: &State) -> bool {
        s.over != Over::Nothing
    }

    fn busy(&self, s: &State) -> bool {
        s.press.is_some()
    }

    fn wake(&self, s: &State, _now: Instant) -> Option<Instant> {
        s.cards.iter().filter(|c| !c.leaving).filter_map(|c| c.n.until).min()
    }
}

/// A notice's picture in its `PICTURE` square: the sender's with the program's badge,
/// else the program's alone on a circle, else a bell on one; critical = an `error`
/// circle. Shared with the side panel's groups.
#[allow(clippy::too_many_arguments)]
pub(crate) fn picture(renderer: &mut Renderer, spot: Rectangle, (face, badge): (Option<&image::Handle>, Option<&image::Handle>), critical: bool, c: &Colours, p: &Pictures, alpha: f32, clip: Rectangle) {
    let quad = |b: Rectangle, radius: f32| renderer::Quad { bounds: b, border: border::rounded(radius), ..Default::default() };
    let circle = Color { a: alpha, ..if critical { c.error } else { c.panel } };
    let draw = |renderer: &mut Renderer, h: &image::Handle, b: Rectangle| {
        renderer.draw_image(img::Image { opacity: alpha, ..img::Image::new(h.clone()) }, b, clip);
    };
    let centred = |b: Rectangle, side: f32| Rectangle { x: b.x + ((b.width - side) / 2.0).round(), y: b.y + ((b.height - side) / 2.0).round(), width: side, height: side };
    match (face, badge) {
        (Some(face), badge) => {
            draw(renderer, face, spot);
            if let Some(badge) = badge {
                let b = Rectangle { x: spot.x + PICTURE - BADGE, y: spot.y + PICTURE - BADGE, width: BADGE, height: BADGE };
                renderer.fill_quad(quad(b, BADGE / 2.0), circle);
                draw(renderer, badge, centred(b, notices::BADGE_ICON as f32));
            }
        }
        (None, Some(alone)) => {
            renderer.fill_quad(quad(spot, PICTURE / 2.0), circle);
            draw(renderer, alone, centred(spot, notices::ALONE_ICON as f32));
        }
        (None, None) => {
            renderer.fill_quad(quad(spot, PICTURE / 2.0), circle);
            draw(renderer, if critical { &p.bell_on_error } else { &p.bell }, centred(spot, style::ICON as f32));
        }
    }
}

/// A text drawn in a finite box, as every other text in the shell (an endless one drew
/// only each run's first letter, photographed 2026-11-03), its reach told as well past
/// `near` (the card it sits on): iced_tiny_skia masks a text to the layer only when the
/// bounds it is given aren't inside it, so the card's own cut let an opening card's
/// words spill under the box (his catch 2026-11-03).
pub(crate) fn say(renderer: &mut Renderer, words: text::Text<&str>, to: Point, colour: Color, near: Rectangle, clip: Rectangle) {
    let text::Text { content, bounds, size, line_height, font, align_x, align_y, shaping, wrapping } = words;
    let tall = if wrapping == text::Wrapping::None { size.0 * style::LINE_TIGHT } else { clip.height };
    let bounds = Size::new(bounds.width.min(near.width), bounds.height.min(tall));
    let words = text::Text { content: content.to_string(), bounds, size, line_height, font, align_x, align_y, shaping, wrapping };
    let reach = Rectangle { x: near.x - near.width, y: near.y - near.width, width: 3.0 * near.width, height: 4096.0 };
    renderer.fill_text(words, to, colour, reach);
}

fn cut_label(label: &str, w: f32) -> String {
    cut(label, style::SMALL, w)
}

/// The box's size for the pop-ups now, before any card has a state (a new surface).
pub fn size(cards: &[Notice]) -> Size {
    let n = cards.len() as f32;
    let h = if n > 0.0 { n * Card::shut_h() + (n - 1.0) * SPACE } else { 0.0 };
    Size::new(WIDTH, (h + 2.0 * style::MENU_PAD).ceil())
}
