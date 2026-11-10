//! A scrolling list: the bar 6 wide, unseen at rest as Windows drew it, and while held
//! or pointed at Noctalia's (`lib/ui/controls/scrollbar.cpp`): a faint groove in
//! `border` and a handle in `text-muted`, both at half, square ends, not widening
//! (his pick 2026-11-09; it was accent).
//! And as Windows moved it: `smooth` round a whole window glides every list in it on
//! the wheel, as Windows' engine (WebView2, Chromium) does.

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Shell, mouse, renderer};
use iced::time::Instant;
use iced::widget::{Scrollable, container, scrollable};
use iced::{Color, Element, Event, Length, Point, Rectangle, Renderer, Shadow, Size, Theme, Vector, border, keyboard, window};

use crate::colours::Colours;
use crate::motion;
use crate::style::{CORNER, SCROLL_ALPHA, SCROLL_BAR};

/// It sets the bar, which resets where the list is held: call `anchor_bottom` after it.
pub fn styled<'a, Message>(list: Scrollable<'a, Message>, c: Colours) -> Scrollable<'a, Message> {
    list.direction(scrollable::Direction::Vertical(scrollable::Scrollbar::new().width(SCROLL_BAR).scroller_width(SCROLL_BAR))).style(look(c))
}

/// `styled` turned: a list that scrolls sideways, the wheel's up and down moving it
/// left and right (iced turns them only with Shift held; a mouse wheel has no other).
/// The music box's cover wall (his ask 2026-11-08: "scroll goes sideways").
pub fn sideways<'a, Message: 'a>(list: Scrollable<'a, Message>, c: Colours) -> Element<'a, Message> {
    let list = list.direction(scrollable::Direction::Horizontal(scrollable::Scrollbar::new().width(SCROLL_BAR).scroller_width(SCROLL_BAR))).style(look(c));
    Element::new(Sideways { content: list.into() })
}

struct Sideways<'a, Message> {
    content: Element<'a, Message>,
}

impl<Message> Widget<Message, Theme, Renderer> for Sideways<'_, Message> {
    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(&[&self.content]);
    }

    fn size(&self) -> Size<Length> {
        self.content.as_widget().size()
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        self.content.as_widget_mut().layout(&mut tree.children[0], renderer, limits)
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn iced::advanced::widget::Operation) {
        self.content.as_widget_mut().operate(&mut tree.children[0], layout, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, renderer: &Renderer, clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let turned = match event {
            Event::Mouse(mouse::Event::WheelScrolled { delta }) => Event::Mouse(mouse::Event::WheelScrolled {
                delta: match *delta {
                    mouse::ScrollDelta::Lines { x, y } => mouse::ScrollDelta::Lines { x: x + y, y: 0.0 },
                    mouse::ScrollDelta::Pixels { x, y } => mouse::ScrollDelta::Pixels { x: x + y, y: 0.0 },
                },
            }),
            _ => event.clone(),
        };
        self.content.as_widget_mut().update(&mut tree.children[0], &turned, layout, cursor, renderer, clipboard, shell, viewport);
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle) {
        self.content.as_widget().draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.content.as_widget().mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout<'b>, renderer: &Renderer, viewport: &Rectangle, translation: Vector) -> Option<iced::advanced::overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.as_widget_mut().overlay(&mut tree.children[0], layout, renderer, viewport, translation)
    }
}

fn look(c: Colours) -> impl Fn(&Theme, scrollable::Status) -> scrollable::Style {
    move |_, status| {
        let on = matches!(status, scrollable::Status::Dragged { .. } | scrollable::Status::Hovered { is_vertical_scrollbar_hovered: true, .. } | scrollable::Status::Hovered { is_horizontal_scrollbar_hovered: true, .. });
        let shown = |colour: Color| if on { Color { a: colour.a * SCROLL_ALPHA, ..colour } } else { Color::TRANSPARENT };
        let rail = scrollable::Rail { background: Some(shown(c.border).into()), border: border::rounded(CORNER), scroller: scrollable::Scroller { background: shown(c.text_muted).into(), border: border::rounded(CORNER) } };
        scrollable::Style {
            container: container::Style::default(),
            vertical_rail: rail,
            horizontal_rail: rail,
            gap: None,
            auto_scroll: scrollable::AutoScroll { background: Color::TRANSPARENT.into(), border: border::rounded(0), shadow: Shadow::default(), icon: Color::TRANSPARENT },
        }
    }
}

/// A wheel notch's move on Windows' engine: 3 lines (`SPI_GETWHEELSCROLLLINES`' default)
/// of 100 / 3 (`kScrollbarPixelsPerLine`), Chromium's
/// `ui/events/blink/web_input_event_builders_win.cc`. iced's own is 60, at once.
const NOTCH: f32 = 100.0;
/// Chromium's wheel curve, ease-in-out (`kEaseInOutControlPoints`), its first point
/// raised on a retarget to keep the speed (`EaseInOutWithInitialSlope`):
/// `cc/animation/scroll_offset_animation_curve.cc`.
const X1: f32 = 0.42;
const X2: f32 = 0.58;

/// Every list inside `content` glides on a wheel notch instead of jumping (his ask,
/// M&P Library plan step 6: "Smooth scrolling as Windows had"). A notch is held back
/// and handed on frame by frame as small pixel moves, as a touchpad's are, so iced
/// picks the list under the pointer as it always does (an inner one first, then the
/// one around it once the inner one is at its end) and each list's own `on_scroll` and
/// bottom hold work as with a touchpad, whose moves pass as they are.
pub fn smooth<'a, Message: 'a>(content: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    Element::new(Smooth { content: content.into() })
}

struct Smooth<'a, Message> {
    content: Element<'a, Message>,
}

/// One glide: from where it set off to where the notches so far lead, both counted
/// from the first notch, on Chromium's curve.
#[derive(Clone, Copy)]
struct Glide {
    /// Where the pointer was at the last notch: the list the moves go to.
    at: Point,
    start: Instant,
    ms: f32,
    from: Vector,
    to: Vector,
    /// The curve's slope at its start: 0, or the speed kept from the glide before.
    slope: f32,
    /// What has been handed on so far.
    sent: Vector,
}

impl Glide {
    fn curve(&self) -> [f32; 4] {
        [X1, X1 * self.slope, X2, 1.0]
    }

    fn progress(&self, now: Instant) -> f32 {
        if self.ms <= 0.0 { 1.0 } else { (now.saturating_duration_since(self.start).as_secs_f32() * 1000.0 / self.ms).min(1.0) }
    }

    fn value(&self, now: Instant) -> Vector {
        self.from + (self.to - self.from) * motion::bezier(self.curve(), self.progress(now))
    }

    /// Pixels a millisecond along the longer side (Chromium's `CalculateVelocity`).
    fn speed(&self, now: Instant) -> f32 {
        if self.ms <= 0.0 { 0.0 } else { motion::slope(self.curve(), self.progress(now)) * longer(self.to - self.from) / self.ms }
    }
}

/// The longer side of a move, with its sign (Chromium's `MaximumDimension`).
fn longer(v: Vector) -> f32 {
    if v.x.abs() > v.y.abs() { v.x } else { v.y }
}

/// Chromium's wheel time (`kInverseDelta`): 12 frames at 60 a second for a move up to
/// 120, falling to 6 at 480 and over, so a fast spin snaps and a slow one glides.
fn duration(d: f32) -> f32 {
    (14.0 - d.abs() / 60.0).clamp(6.0, 12.0) * 1000.0 / 60.0
}

/// A notch moving `step` with the pointer at `at`. During a glide it adds to where the
/// glide heads and keeps its speed, never taking longer than that speed needs (Chromium's
/// `UpdateTarget`); turned the other way it sets off fresh from where the list is
/// (Chromium can't overshoot a list's end, so there it turns at once too; this can't
/// see the end, so it turns at once everywhere).
fn notch(glide: Option<Glide>, step: Vector, at: Point, now: Instant) -> Glide {
    let fresh = |sent: Vector| Glide { at, start: now, ms: duration(longer(step)), from: sent, to: sent + step, slope: 0.0, sent };
    let Some(g) = glide else { return fresh(Vector::ZERO) };
    let left = g.to - g.sent;
    if left.x * step.x + left.y * step.y < 0.0 {
        return fresh(g.sent);
    }
    let to = g.to + step;
    let ahead = longer(to - g.sent);
    let speed = g.speed(now);
    // How long that speed takes to get there, with room for the slowing at the end.
    let bound = if speed.abs() < 1e-4 || ahead / speed < 0.0 { f32::INFINITY } else { ahead / speed * 2.5 };
    let ms = duration(ahead).min(bound);
    let slope = if ahead.abs() < 0.01 { 0.0 } else { speed * ms / ahead };
    Glide { at, start: now, ms, from: g.sent, to, slope: slope.clamp(-1000.0, 1000.0), sent: g.sent }
}

#[derive(Default)]
struct State {
    glide: Option<Glide>,
    /// Shift held: the wheel goes sideways, as iced's own notches do.
    shift: bool,
}

impl<Message> Widget<Message, Theme, Renderer> for Smooth<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(&[&self.content]);
    }

    fn size(&self) -> Size<Length> {
        self.content.as_widget().size()
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        self.content.as_widget_mut().layout(&mut tree.children[0], renderer, limits)
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn iced::advanced::widget::Operation) {
        self.content.as_widget_mut().operate(&mut tree.children[0], layout, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, renderer: &Renderer, clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        match event {
            Event::Keyboard(keyboard::Event::ModifiersChanged(m)) => s.shift = m.shift(),
            Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { x, y } }) => {
                if let Some(at) = cursor.position() {
                    let (x, y) = if s.shift { (*y, *x) } else { (*x, *y) };
                    s.glide = Some(notch(s.glide, Vector::new(x, y) * NOTCH, at, Instant::now()));
                    shell.request_redraw();
                    shell.capture_event();
                    return;
                }
            }
            Event::Window(window::Event::RedrawRequested(now)) => {
                // The frame first, so nothing in it sees the move as taken; then the
                // move, drawn in this same frame.
                self.content.as_widget_mut().update(&mut tree.children[0], event, layout, cursor, renderer, clipboard, shell, viewport);
                let s = tree.state.downcast_mut::<State>();
                let Some(g) = s.glide.as_mut() else { return };
                let done = g.progress(*now) >= 1.0;
                let at = if done { g.to } else { g.value(*now) };
                let step = at - g.sent;
                g.sent = at;
                let point = g.at;
                if done {
                    s.glide = None;
                } else {
                    shell.request_redraw();
                }
                if step != Vector::ZERO {
                    let wheel = Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Pixels { x: step.x, y: step.y } });
                    self.content.as_widget_mut().update(&mut tree.children[0], &wheel, layout, mouse::Cursor::Available(point), renderer, clipboard, shell, viewport);
                }
                return;
            }
            _ => {}
        }
        self.content.as_widget_mut().update(&mut tree.children[0], event, layout, cursor, renderer, clipboard, shell, viewport);
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle) {
        self.content.as_widget().draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.content.as_widget().mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout<'b>, renderer: &Renderer, viewport: &Rectangle, translation: Vector) -> Option<iced::advanced::overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.as_widget_mut().overlay(&mut tree.children[0], layout, renderer, viewport, translation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn one_notch_glides_100_in_200_ms() {
        let t = Instant::now();
        let g = notch(None, Vector::new(0.0, 100.0), Point::ORIGIN, t);
        assert_eq!(g.ms, 200.0);
        assert!((g.value(t + Duration::from_millis(100)).y - 50.0).abs() < 0.5, "ease-in-out is half way at half time");
        assert_eq!(g.value(t + Duration::from_millis(200)).y, 100.0);
    }

    #[test]
    fn a_second_notch_adds_on_and_keeps_the_speed() {
        let t = Instant::now();
        let mut g = notch(None, Vector::new(0.0, 100.0), Point::ORIGIN, t);
        let mid = t + Duration::from_millis(100);
        g.sent = g.value(mid);
        let speed = g.speed(mid);
        let g = notch(Some(g), Vector::new(0.0, 100.0), Point::ORIGIN, mid);
        assert_eq!(g.to.y, 200.0);
        assert!((g.speed(mid) - speed).abs() < 0.01 * speed.abs(), "{} vs {}", g.speed(mid), speed);
    }

    #[test]
    fn the_other_way_turns_at_once() {
        let t = Instant::now();
        let mut g = notch(None, Vector::new(0.0, 300.0), Point::ORIGIN, t);
        g.sent = Vector::new(0.0, 120.0);
        let g = notch(Some(g), Vector::new(0.0, -100.0), Point::ORIGIN, t + Duration::from_millis(50));
        assert_eq!((g.from.y, g.to.y, g.slope), (120.0, 20.0, 0.0));
    }
}
