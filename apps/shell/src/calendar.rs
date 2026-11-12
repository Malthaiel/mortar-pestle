//! The clock's month calendar (M&P Shell plan, step 1): his Windows calendar 1-1
//! (`web/src/components/planner/MiniMonthPicker.jsx` with `quick={false}`, the
//! `daycell` + `chip` shapes in `web/src/styles.css`), held to the rulebook
//! (`style.rs`). The month name between two arrow buttons, the weekday row, six
//! weeks of day boxes, today ringed in the accent. His picks 2026-10-29: the
//! arrows, the scroll wheel or the month name (back to this month) change the
//! month, which slides out and fades while the next slides in (Caelestia's
//! dashboard calendar, @b51fdb3 `modules/dashboard/dash/Calendar.qml`); days do
//! nothing until the Planner exists; the strip's menus in bold.

use iced::advanced::image::{self, Renderer as _};
use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::{Renderer as _, mouse, renderer};
use iced::alignment::Vertical;
use iced::time::Instant;
use iced::{Border, Color, Event, Pixels, Point, Rectangle, Renderer, Size, Vector};

use crate::colours::Colours;
use crate::menu::{Body, Reply};
use crate::motion::{self, Tween};
use crate::style::{self, CONTROL, GAP_1, GAP_2, GAP_3, SMALL};

/// An arrow button: Windows' `chip`, padded gap-3 round its icon.
const BUTTON: f32 = GAP_3 + style::ICON as f32 + GAP_3;
/// The weekday row: its text plus `paddingBottom: 4`.
fn week_row() -> f32 {
    (SMALL * style::LINE + GAP_1).round()
}
/// A day box's padding round its number (Windows: 6 top, the 3s: 8), and
/// today's ring (`outline: 2px`).
const DAY_PAD: f32 = GAP_2;
const RING: f32 = 2.0;
/// How far a month slides (asked 2026-10-29: the 3s have no slide distance).
const SLIDE: f32 = GAP_3;

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

pub struct Calendar {
    /// Today: year, month 0-11, day.
    pub today: (i32, u32, u32),
    pub colours: Colours,
    pub prev: image::Handle,
    pub next: image::Handle,
}

/// The parts that take a click, in `State::tints` order.
#[derive(Clone, Copy, PartialEq)]
enum Spot {
    Prev,
    Title,
    Next,
}

const SPOTS: [Spot; 3] = [Spot::Prev, Spot::Title, Spot::Next];

pub struct State {
    /// The month asked for and the month drawn (year, month 0-11): they differ
    /// while the old one leaves.
    target: (i32, u32),
    shown: (i32, u32),
    leaving: bool,
    /// -1 when a later month is coming (the old one leaves to the left).
    dir: f32,
    slide: Tween,
    fade: Tween,
    hovered: Option<Spot>,
    tints: [Tween; 3],
    /// The content's width, set by `size`.
    width: f32,
}

/// A day box's side. Windows sizes the box to its content (`width: max-content`):
/// a day box is its number padded gap-3 each side; the weekday grid has no gaps;
/// the header is two buttons, gap-2, this year's widest month name, gap-2. The
/// box is square (his call 2026-10-29: Windows' 30 tall was too small for 15
/// numbers). Whole pixels keep every box on the pixel grid.
fn side(year: i32) -> f32 {
    let day = (1..=31).map(|d| width(&d.to_string(), style::BODY)).fold(0.0, f32::max) + 2.0 * GAP_3;
    let name = WEEKDAYS.iter().map(|d| width(d, SMALL)).fold(0.0, f32::max);
    let title = MONTHS.iter().map(|m| width(&format!("{m} {year}"), style::BODY)).fold(0.0, f32::max);
    let wide = (7.0 * day + 6.0 * GAP_1).max(7.0 * name).max(2.0 * (BUTTON + GAP_2) + title);
    ((wide - 6.0 * GAP_1) / 7.0).ceil()
}

/// The calendar's height inside the menu's box: header, weekday row, six weeks.
pub fn height(year: i32) -> f32 {
    CONTROL + GAP_2 + week_row() + GAP_2 + 6.0 * side(year) + 5.0 * GAP_1
}

fn words<T>(content: T, size: f32, bounds: Size, align_x: text::Alignment, align_y: Vertical) -> text::Text<T> {
    text::Text { content, bounds, size: Pixels(size), line_height: style::LINE.into(), font: crate::BOLD, align_x, align_y, shaping: text::Shaping::Basic, wrapping: text::Wrapping::None }
}

fn width(content: &str, size: f32) -> f32 {
    <Renderer as text::Renderer>::Paragraph::with_text(words(content, size, Size::INFINITE, text::Alignment::Left, Vertical::Top)).min_width()
}

/// (year, month 0-11) moved by `by` months.
fn add((y, m): (i32, u32), by: i32) -> (i32, u32) {
    let n = y * 12 + m as i32 + by;
    (n.div_euclid(12), n.rem_euclid(12) as u32)
}

fn days_in((y, m): (i32, u32)) -> u32 {
    match m {
        1 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        1 => 28,
        3 | 5 | 8 | 10 => 30,
        _ => 31,
    }
}

/// 0 = Monday (Sakamoto's method).
fn weekday((y, m): (i32, u32), d: u32) -> u32 {
    const T: [i32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if m < 2 { y - 1 } else { y };
    let sunday_first = (y + y / 4 - y / 100 + y / 400 + T[m as usize] + d as i32).rem_euclid(7);
    ((sunday_first + 6) % 7) as u32
}

fn quad(bounds: Rectangle, ring: Option<Color>) -> renderer::Quad {
    let border = Border { color: ring.unwrap_or(Color::TRANSPARENT), width: if ring.is_some() { RING } else { 0.0 }, radius: style::CORNER.into() };
    renderer::Quad { bounds, border, ..Default::default() }
}

impl Calendar {
    fn this_month(&self) -> (i32, u32) {
        (self.today.0, self.today.1)
    }

    /// Where a spot sits, from the content's top left.
    fn spot(&self, s: &State, spot: Spot) -> Rectangle {
        match spot {
            Spot::Prev => Rectangle { x: 0.0, y: 0.0, width: BUTTON, height: CONTROL },
            Spot::Title => Rectangle { x: BUTTON + GAP_2, y: 0.0, width: s.width - 2.0 * (BUTTON + GAP_2), height: CONTROL },
            Spot::Next => Rectangle { x: s.width - BUTTON, y: 0.0, width: BUTTON, height: CONTROL },
        }
    }

    /// The month name takes a click only away from this month (Caelestia's `disabled`).
    fn live(&self, s: &State, spot: Spot) -> bool {
        spot != Spot::Title || s.target != self.this_month()
    }

    fn change(&self, s: &mut State, to: (i32, u32), now: Instant) {
        if to == s.target {
            return;
        }
        // Caelestia's `animDirection`.
        s.dir = if to > s.target { -1.0 } else { 1.0 };
        s.target = to;
        s.leaving = true;
        s.fade.go_with(0.0, now, motion::EFFECTS);
        s.slide.go_with(SLIDE * s.dir, now, motion::SPATIAL_FAST);
    }
}

impl Body for Calendar {
    type State = State;

    fn state(&self) -> State {
        State {
            target: self.this_month(),
            shown: self.this_month(),
            leaving: false,
            dir: -1.0,
            slide: Tween::new(0.0, motion::SPATIAL),
            fade: Tween::new(1.0, motion::EFFECTS),
            hovered: None,
            tints: [Tween::new(0.0, motion::EFFECTS); 3],
            width: 0.0,
        }
    }

    fn size(&self, s: &mut State) -> Size {
        s.width = 7.0 * side(self.today.0) + 6.0 * GAP_1;
        Size::new(s.width, height(self.today.0))
    }

    fn update(&self, s: &mut State, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        // The old month gone: the new one comes in from the other side.
        if s.leaving && !s.fade.moving(now) {
            s.leaving = false;
            s.shown = s.target;
            s.slide.set(-SLIDE * s.dir);
            s.slide.go_with(0.0, now, motion::SPATIAL);
            s.fade.go_with(1.0, now, motion::EFFECTS);
        }
        let hovered = at.and_then(|p| SPOTS.into_iter().find(|&k| self.live(s, k) && self.spot(s, k).contains(p)));
        if hovered != s.hovered {
            s.hovered = hovered;
            for (tint, spot) in s.tints.iter_mut().zip(SPOTS) {
                tint.go(if hovered == Some(spot) { style::HOVER } else { 0.0 }, now);
            }
        }
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                let to = match s.hovered {
                    Some(Spot::Prev) => add(s.target, -1),
                    Some(Spot::Next) => add(s.target, 1),
                    Some(Spot::Title) => self.this_month(),
                    None => return Reply::None,
                };
                self.change(s, to, now);
                Reply::Used
            }
            Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { y, .. } | mouse::ScrollDelta::Pixels { y, .. } }) if at.is_some() && *y != 0.0 => {
                // Caelestia: wheel up = the month before.
                let to = add(s.target, if *y > 0.0 { -1 } else { 1 });
                self.change(s, to, now);
                Reply::Used
            }
            _ => Reply::None,
        }
    }

    fn draw(&self, s: &State, renderer: &mut Renderer, c: Rectangle, alpha: f32, now: Instant) {
        let colours = &self.colours;
        let at = |r: Rectangle| r + Vector::new(c.x, c.y);
        let shade = |colour: Color, a: f32| Color { a: colour.a * a, ..colour };

        // The arrow buttons (Raised, the one corner), then the hover layers: an 8%
        // patch of the text colour.
        for spot in [Spot::Prev, Spot::Next] {
            renderer.fill_quad(quad(at(self.spot(s, spot)), None), shade(colours.raised, alpha));
        }
        for (tint, spot) in s.tints.iter().zip(SPOTS) {
            let a = tint.value(now).clamp(0.0, 1.0) * alpha;
            if a > 0.0 {
                renderer.fill_quad(quad(at(self.spot(s, spot)), None), shade(colours.text, a));
            }
        }
        for (picture, spot) in [(&self.prev, Spot::Prev), (&self.next, Spot::Next)] {
            let r = at(self.spot(s, spot));
            let side = style::ICON as f32;
            let icon = Rectangle { x: r.x + GAP_3, y: r.y + (CONTROL - side) / 2.0, width: side, height: side };
            renderer.draw_image(image::Image { opacity: alpha, ..image::Image::new(picture.clone()) }, icon, r);
        }

        // Whole-pixel slide: a part-covered edge pixel would be left behind.
        let dx = Vector::new(s.slide.value(now).round(), 0.0);
        let shown_alpha = alpha * s.fade.value(now).clamp(0.0, 1.0);
        let title = at(self.spot(s, Spot::Title)) + dx;
        let name = format!("{} {}", MONTHS[s.shown.1 as usize], s.shown.0);
        let centred = |r: Rectangle, content: String, size: f32| words(content, size, r.size(), text::Alignment::Center, Vertical::Center);
        renderer.fill_text(centred(title, name, style::BODY), title.center(), shade(colours.text, shown_alpha), title);

        // The weekday row: its own grid, no gaps, so each name centres on a seventh.
        let week_y = c.y + CONTROL + GAP_2;
        let seventh = s.width / 7.0;
        for (i, day) in WEEKDAYS.iter().enumerate() {
            let r = Rectangle { x: c.x + i as f32 * seventh, y: week_y, width: seventh, height: week_row() - GAP_1 };
            renderer.fill_text(centred(r, day.to_string(), SMALL), r.center(), shade(colours.text_faint, alpha), r);
        }

        // Six weeks of day boxes: Card, the one corner, the number top left;
        // today in the accent with its ring; other months' days at 40%.
        let grid_y = week_y + week_row() + GAP_2;
        let column = (s.width - 6.0 * GAP_1) / 7.0;
        let first = weekday(s.shown, 1) as i32;
        let (before, after) = (add(s.shown, -1), add(s.shown, 1));
        for i in 0..42 {
            let n = i - first + 1;
            let (month, day) = match n {
                _ if n < 1 => (before, (days_in(before) as i32 + n) as u32),
                _ if n > days_in(s.shown) as i32 => (after, (n - days_in(s.shown) as i32) as u32),
                _ => (s.shown, n as u32),
            };
            let today = (month.0, month.1, day) == self.today;
            let x = c.x + (i % 7) as f32 * (column + GAP_1);
            let y = grid_y + (i / 7) as f32 * (column + GAP_1);
            let r = Rectangle { x, y, width: column, height: column } + dx;
            let a = shown_alpha * if month == s.shown { 1.0 } else { style::FADED };
            renderer.fill_quad(quad(r, today.then_some(shade(colours.accent, a))), shade(colours.panel, a));
            let number = Rectangle { x: r.x + GAP_3, y: r.y + DAY_PAD, width: column - 2.0 * GAP_3, height: column - DAY_PAD };
            let colour = if today { colours.accent } else { colours.text };
            // Body, as the power menu's names (his call 2026-10-29; Windows: small).
            let digits = words(day.to_string(), style::BODY, number.size(), text::Alignment::Left, Vertical::Top);
            renderer.fill_text(digits, number.position(), shade(colour, a), r);
        }
    }

    fn moving(&self, s: &State, now: Instant) -> bool {
        s.leaving || s.slide.moving(now) || s.fade.moving(now) || s.tints.iter().any(|t| t.moving(now))
    }

    fn clickable(&self, s: &State) -> bool {
        s.hovered.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months() {
        assert_eq!(add((2026, 11), 1), (2027, 0));
        assert_eq!(add((2026, 0), -1), (2025, 11));
        assert_eq!(add((2026, 5), 14), (2027, 7));
        assert_eq!([(2024, 1), (2025, 1), (1900, 1), (2000, 1), (2026, 10), (2026, 11)].map(days_in), [29, 28, 28, 29, 30, 31]);
    }

    #[test]
    fn weekdays() {
        // 0 = Monday: Wednesday 11 November 2026, Thursday 29 February 2024, Saturday 1 January 2000.
        assert_eq!(weekday((2026, 10), 11), 2);
        assert_eq!(weekday((2024, 1), 29), 3);
        assert_eq!(weekday((2000, 0), 1), 5);
    }
}
