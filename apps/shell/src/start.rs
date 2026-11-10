//! The Start menu (M&P Shell plan, step 3): Windows' program finder
//! (`web/src/components/chrome/Launcher.jsx`, after Caelestia's launcher) held to
//! the rulebook (`style.rs`): the programs as two-line rows, the accent pill on
//! the cursor row, the search box under them. niri's Mod+D sends a SIGUSR1
//! (`signal.rs`); its card slides up from behind the bottom middle of the mouse's
//! screen (`menu.rs`, `Edge::Bottom`) and holds the keyboard until it closes.

use iced::advanced::image::{self, Renderer as _};
use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::{Renderer as _, renderer};
use iced::alignment::Vertical;
use iced::keyboard::{self, Key, key::Named};
use iced::time::Instant;
use iced::{Color, Event, Font, Point, Rectangle, Renderer, Size, border, mouse, window};

use crate::apps::App;
use crate::colours::Colours;
use crate::icon;
use crate::menu::{Body, Reply};
use crate::motion::{self, Tween};
use crate::style::{BODY, CONTROL, CORNER, GAP_1, GAP_2, GAP_3, ICON, ICON_LG, LINE_TIGHT, SMALL};
use crate::{BOLD, MEDIUM};

/// Rows shown before the wheel scrolls (Windows' `maxShown`).
const ROWS: usize = 7;
/// Where a row's text starts: gap-3, the picture, gap-3 (Windows' `12px` pad and gap).
const TEXT_X: f32 = GAP_3 + ICON_LG as f32 + GAP_3;
const NONE: [&str; 2] = ["No results", "Try searching for something else"];

/// A row: gap-2 over and under its name line and grey line (Windows' `8px` pad).
fn row() -> f32 {
    (2.0 * GAP_2 + (BODY + SMALL) * LINE_TIGHT).round()
}

/// A row and the gap-2 to the next (Windows' `gap: 8px`).
fn pitch() -> f32 {
    row() + GAP_2
}

/// "No results": its two lines with a gap-3 over and under (Windows' 16).
fn none_height() -> f32 {
    (2.0 * GAP_3 + (BODY + SMALL) * LINE_TIGHT).round()
}

/// The content's height for `n` matches: the rows (at most `ROWS`) or "No
/// results", a gap-3, the search box.
fn height(n: usize) -> f32 {
    let list = if n == 0 { none_height() } else { n.min(ROWS) as f32 * pitch() - GAP_2 };
    list + GAP_3 + CONTROL
}

/// The content at its tallest: the surface is made this size once, on open.
pub fn tallest(apps: usize) -> f32 {
    height(apps).max(height(0))
}

fn line<T>(content: T, size: f32, font: Font, bounds: Size) -> text::Text<T> {
    text::Text { content, bounds, size: size.into(), line_height: LINE_TIGHT.into(), font, align_x: text::Alignment::Left, align_y: Vertical::Top, shaping: text::Shaping::Basic, wrapping: text::Wrapping::None }
}

fn width(content: &str, size: f32, font: Font) -> f32 {
    <Renderer as text::Renderer>::Paragraph::with_text(line(content, size, font, Size::INFINITE)).min_width()
}

/// The content's width, as the menus size themselves: the widest name or grey
/// line, measured, read once on open so the box keeps it while typing.
pub fn widest(apps: &[App]) -> f32 {
    let lines = |name: &str, about: &str| width(name, BODY, BOLD).max(width(about, SMALL, MEDIUM));
    let widest = apps.iter().map(|a| lines(&a.name, &a.about)).fold(lines(NONE[0], NONE[1]), f32::max);
    (TEXT_X + widest + GAP_3).ceil()
}

/// Windows' `match` (`Launcher.jsx`), 1-1: the letters of `q` (lower case) in
/// order anywhere in `name`, case-blind; each scores 1, 2 more right after the
/// last, 3 more at a word's start (fzf's bonuses). -1 = no match.
pub fn score(q: &str, name: &str) -> i32 {
    let s: Vec<char> = name.to_lowercase().chars().collect();
    let q: Vec<char> = q.chars().collect();
    let (mut i, mut score, mut prev) = (0, 0, usize::MAX);
    for (j, &c) in s.iter().enumerate() {
        if i == q.len() {
            break;
        }
        if c != q[i] {
            continue;
        }
        let run = j > 0 && prev == j - 1;
        let start = j == 0 || !matches!(s[j - 1], 'a'..='z' | '0'..='9');
        score += 1 + if run { 2 } else { 0 } + if start { 3 } else { 0 };
        prev = j;
        i += 1;
    }
    if i == q.len() { score } else { -1 }
}

/// The menu's own pictures, drawn on open: a program without one (Windows'
/// `bx-window`, plain and lit), the search box's magnifier, the empty list's.
pub struct Pictures {
    fallback: [image::Handle; 2],
    field: image::Handle,
    none: image::Handle,
}

impl Pictures {
    pub fn new(c: &Colours) -> Self {
        let window = include_bytes!("../assets/bx-window.svg");
        let search = include_bytes!("../assets/bx-search.svg");
        Self { fallback: [icon::svg(window, ICON_LG, c.text_muted), icon::svg(window, ICON_LG, c.on_accent)], field: icon::svg(search, ICON, c.on_accent), none: icon::svg(search, ICON_LG, c.text_muted) }
    }
}

pub struct Start<'a> {
    pub apps: &'a [App],
    /// `widest`, read on open.
    pub width: f32,
    pub colours: Colours,
    pub pictures: &'a Pictures,
}

pub struct State {
    query: String,
    /// The matches, best first: indexes into `apps`.
    results: Vec<usize>,
    /// The cursor's place in `results`, the first one shown, the one under the pointer.
    cursor: usize,
    top: usize,
    hovered: Option<usize>,
    /// The accent pill's top in the list.
    pill: Tween,
}

impl Start<'_> {
    /// Windows' search: the names holding the typed letters in order, best first,
    /// ties to the shorter name; all of them, in order, while nothing is typed.
    /// The cursor goes back to the top of every new list.
    fn search(&self, s: &mut State, now: Instant) {
        let q = s.query.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        s.results = (0..self.apps.len()).collect();
        if !q.is_empty() {
            let mut scored: Vec<(usize, i32)> = s.results.iter().map(|&i| (i, score(&q, &self.apps[i].name))).filter(|&(_, n)| n >= 0).collect();
            scored.sort_by_key(|&(i, n)| (-n, self.apps[i].name.chars().count()));
            s.results = scored.into_iter().map(|(i, _)| i).collect();
        }
        s.top = 0;
        self.move_to(s, 0, now);
    }

    /// The cursor to match `i`, the list scrolled just enough to show it
    /// (Windows' `scrollIntoView({ block: 'nearest' })`), the pill gliding there.
    fn move_to(&self, s: &mut State, i: usize, now: Instant) {
        s.cursor = i.min(s.results.len().saturating_sub(1));
        s.top = s.top.min(s.cursor).max((s.cursor + 1).saturating_sub(ROWS));
        s.pill.go((s.cursor - s.top) as f32 * pitch(), now);
    }

    /// The match under the pointer: on a row, not the gap between two.
    fn under(&self, s: &State, at: Option<Point>) -> Option<usize> {
        let p = at?;
        let k = (p.y / pitch()).floor();
        let i = s.top + k.max(0.0) as usize;
        (p.x >= 0.0 && p.x < self.width && p.y >= 0.0 && k < ROWS as f32 && p.y - k * pitch() < row() && i < s.results.len()).then_some(i)
    }

    /// Windows' empty list: the magnifier, then "No results" over its hint, centred.
    fn draw_none(&self, renderer: &mut Renderer, list: Rectangle, alpha: f32) {
        let muted = Color { a: alpha, ..self.colours.text_muted };
        let side = ICON_LG as f32;
        let words = width(NONE[0], BODY, BOLD).max(width(NONE[1], SMALL, MEDIUM));
        let x = (list.x + (list.width - side - GAP_3 - words) / 2.0).round();
        let spot = Rectangle { x, y: (list.center_y() - side / 2.0).round(), width: side, height: side };
        renderer.draw_image(image::Image { opacity: alpha, ..image::Image::new(self.pictures.none.clone()) }, spot, list);
        let top = (list.center_y() - (BODY + SMALL) * LINE_TIGHT / 2.0).round();
        let at = Point::new(x + side + GAP_3, top);
        renderer.fill_text(line(NONE[0].to_string(), BODY, BOLD, list.size()), at, muted, list);
        renderer.fill_text(line(NONE[1].to_string(), SMALL, MEDIUM, list.size()), at + iced::Vector::new(0.0, BODY * LINE_TIGHT), muted, list);
    }
}

impl Body for Start<'_> {
    type State = State;

    fn state(&self) -> State {
        let pill = Tween::new(0.0, motion::SPATIAL_FAST);
        State { query: String::new(), results: (0..self.apps.len()).collect(), cursor: 0, top: 0, hovered: None, pill }
    }

    fn size(&self, s: &mut State) -> Size {
        Size::new(self.width, height(s.results.len()))
    }

    fn update(&self, s: &mut State, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        match event {
            Event::Keyboard(keyboard::Event::KeyPressed { key, text, modifiers, .. }) => {
                match key.as_ref() {
                    Key::Named(Named::Escape) => return Reply::Close,
                    Key::Named(Named::Enter) => return s.results.get(s.cursor).map_or(Reply::Used, |&i| Reply::Pick(i)),
                    Key::Named(Named::ArrowDown) => self.move_to(s, s.cursor + 1, now),
                    Key::Named(Named::ArrowUp) => self.move_to(s, s.cursor.saturating_sub(1), now),
                    Key::Named(Named::Backspace) => {
                        if s.query.pop().is_some() {
                            self.search(s, now);
                        }
                    }
                    _ => match text {
                        Some(t) if !(modifiers.control() || modifiers.alt() || modifiers.logo()) && !t.chars().any(char::is_control) => {
                            s.query.push_str(t);
                            self.search(s, now);
                        }
                        _ => return Reply::None,
                    },
                }
                Reply::Used
            }
            // The keyboard went elsewhere (the other screen, the lock screen): Windows' blur.
            Event::Window(window::Event::Unfocused) => Reply::Close,
            Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { y, .. } | mouse::ScrollDelta::Pixels { y, .. } }) if at.is_some() && *y != 0.0 => {
                let last = s.results.len().saturating_sub(ROWS);
                let top = if *y > 0.0 { s.top.saturating_sub(1) } else { (s.top + 1).min(last) };
                // The pill rides the list a row, then goes to the row now under the pointer.
                s.pill.set((s.pill.value(now) - (top as f32 - s.top as f32) * pitch()).clamp(0.0, (ROWS - 1) as f32 * pitch()));
                s.top = top;
                let i = self.under(s, at).unwrap_or(s.cursor.clamp(top, top + ROWS - 1));
                self.move_to(s, i, now);
                Reply::Used
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) if at.is_some() => self.under(s, at).map_or(Reply::Used, |i| Reply::Pick(s.results[i])),
            _ => {
                // The row the pointer comes onto takes the cursor (Windows' onPointerEnter).
                let hovered = self.under(s, at);
                if hovered != s.hovered {
                    s.hovered = hovered;
                    if let Some(i) = hovered {
                        self.move_to(s, i, now);
                    }
                }
                Reply::None
            }
        }
    }

    fn draw(&self, s: &State, renderer: &mut Renderer, c: Rectangle, alpha: f32, now: Instant) {
        let colours = &self.colours;
        let (row, pitch) = (row(), pitch());
        let shown = s.results.len().saturating_sub(s.top).min(ROWS);
        let list = Rectangle { height: if shown == 0 { none_height() } else { shown as f32 * pitch - GAP_2 }, ..c };
        let quad = |bounds, radius| renderer::Quad { bounds, border: border::rounded(radius), ..Default::default() };
        if shown == 0 {
            self.draw_none(renderer, list, alpha);
        } else {
            // No layer of its own: a layer's clip replaces the card's sliding one
            // (iced_graphics `push_clip`), and the content would show outside the card.
            let pill = Rectangle { y: (list.y + s.pill.value(now)).round(), height: row, ..list };
            renderer.fill_quad(quad(pill, CORNER), Color { a: alpha, ..colours.accent });
            for k in 0..shown {
                let app = &self.apps[s.results[s.top + k]];
                let y = list.y + k as f32 * pitch;
                // How lit: the share of the row the pill covers, as `menu::Rows`.
                let lit = ((pill.y + row).min(y + row) - pill.y.max(y)).max(0.0) / row;
                let side = ICON_LG as f32;
                let spot = Rectangle { x: c.x + GAP_3, y: y + ((row - side) / 2.0).round(), width: side, height: side };
                let picture = |handle: &image::Handle, opacity| image::Image { opacity, ..image::Image::new(handle.clone()) };
                match &app.picture {
                    Some(p) => renderer.draw_image(picture(p, alpha), spot, list),
                    None => {
                        renderer.draw_image(picture(&self.pictures.fallback[0], alpha), spot, list);
                        if lit > 0.0 {
                            renderer.draw_image(picture(&self.pictures.fallback[1], alpha * lit), spot, list);
                        }
                    }
                }
                // Two colours a line, the lit one faded in over the plain one
                // (iced_tiny_skia caches letters per colour; see `menu::Rows`).
                let bounds = Size::new(c.width - TEXT_X, row);
                let name = Point::new(c.x + TEXT_X, y + GAP_2);
                let about = Point::new(name.x, name.y + BODY * LINE_TIGHT);
                for (words, size, font, plain, at) in [(&app.name, BODY, BOLD, colours.text, name), (&app.about, SMALL, MEDIUM, colours.text_muted, about)] {
                    let clip = Rectangle::new(at, bounds);
                    if lit < 0.99 {
                        renderer.fill_text(line(words.clone(), size, font, bounds), at, Color { a: alpha, ..plain }, clip);
                    }
                    if lit > 0.0 {
                        renderer.fill_text(line(words.clone(), size, font, bounds), at, Color { a: alpha * lit.min(1.0), ..colours.on_accent }, clip);
                    }
                }
            }
        }
        // Windows' open search box (`BarField open`, `.icon-bar-field`): round, a
        // gap-1 in from each side, accent while typing in it (always, here); the
        // magnifier centred in a control-sized spot, gap-2, the words.
        let field = Rectangle { x: c.x + GAP_1, y: list.y + list.height + GAP_3, width: c.width - 2.0 * GAP_1, height: CONTROL };
        let on = Color { a: alpha, ..colours.on_accent };
        renderer.fill_quad(quad(field, CONTROL / 2.0), Color { a: alpha, ..colours.accent });
        let side = ICON as f32;
        let glass = Rectangle { x: field.x + (CONTROL - side) / 2.0, y: field.y + (CONTROL - side) / 2.0, width: side, height: side };
        renderer.draw_image(image::Image { opacity: alpha, ..image::Image::new(self.pictures.field.clone()) }, glass, field);
        let at = Point::new(glass.x + side + GAP_2, field.y + ((CONTROL - BODY * LINE_TIGHT) / 2.0).round());
        let words = if s.query.is_empty() { "Search".to_string() } else { s.query.clone() };
        let bounds = Size::new(field.x + field.width - at.x, BODY * LINE_TIGHT);
        renderer.fill_text(line(words, BODY, MEDIUM, bounds), at, on, field);
        // A steady caret where the typing goes (no blink: nothing runs on a timer).
        let typed = if s.query.is_empty() { 0.0 } else { width(&s.query, BODY, MEDIUM) };
        let caret = Rectangle { x: (at.x + typed).round(), y: at.y, width: 1.0, height: (BODY * LINE_TIGHT).round() };
        renderer.fill_quad(quad(caret, 0.0), on);
    }

    fn moving(&self, s: &State, now: Instant) -> bool {
        s.pill.moving(now)
    }

    fn clickable(&self, s: &State) -> bool {
        s.hovered.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::score;

    #[test]
    fn windows_match() {
        // f at a word start (1 + 3), the second f after a gap (1).
        assert_eq!(score("ff", "Firefox"), 5);
        // Greedy leftmost, as Windows: the first f (1 + 3), then o (1), then x right after (1 + 2).
        assert_eq!(score("fox", "Firefox"), 8);
        assert_eq!(score("xf", "Firefox"), -1);
        assert!(score("obs", "OBS Studio") > score("obs", "Volume Control Bits"));
        assert_eq!(score("", "Anything"), 0);
    }
}
