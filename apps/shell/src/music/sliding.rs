//! A line of words that slides when it is too long for its room (Malthaiel's pick
//! 2026-11-04, the playing box's title and artist; Spotify's player bar rolls a long
//! title too). One that fits sits still at its room's left end, against the cover (the
//! cover to its left since the playing bar, his ask 2026-11-08).
//! One too long shows its start, rests, slides left until its end shows, rests,
//! slides back, and again, while the box shows; the box is a new surface each time
//! it opens, so each opening starts from the start. Under the pointer it slows to a
//! stop and the wheel moves it, up and down as left and right, in the small moves
//! `mp_ui::scroll::smooth` hands out round the whole box (his ask 2026-11-04: "use
//! the app's scroll smoothness"); there it takes the wheel from the volume. Off it,
//! it rests, then slides on from where it was left. It asks its own redraws, one a
//! whole pixel of slide and none while resting, no message.

use std::time::Duration;

use iced::advanced::layout::{self, Layout};
use iced::advanced::text::{self, Renderer as _, paragraph::Plain};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Shell, mouse, renderer};
use iced::alignment::Vertical;
use iced::time::Instant;
use iced::{Color, Element, Event, Length, Pixels, Point, Rectangle, Renderer, Size, Theme, window};
use mp_ui::motion;
use mp_ui::style::LINE_TIGHT;

/// The rest at each end, and after the pointer leaves.
const REST: Duration = Duration::from_secs(2);
/// The slide, in px a second.
const SPEED: f32 = 40.0;

type Paragraph = <Renderer as text::Renderer>::Paragraph;

pub struct Sliding {
    words: String,
    size: f32,
    colour: Color,
}

pub fn sliding<'a, Message: 'a>(words: String, size: f32, colour: Color) -> Element<'a, Message> {
    Element::new(Sliding { words, size, colour })
}

#[derive(Clone, Copy)]
enum Mode {
    /// Sliding by itself, `dir` 1 to the end, -1 back; resting until `rest`.
    Auto { dir: f32, rest: Option<Instant> },
    /// The pointer came on it at `start`, the line moving: its speed falls evenly to
    /// nothing over the rulebook's move time, from where it was drawn to the whole
    /// pixel nearest where that speed carries it. Drawn in quarter pixels, cosmic-text's
    /// finest (his ask 2026-11-04: whole pixels made the stop "choppy").
    Stopping { start: Instant, from: f32, to: f32 },
    /// Under the pointer, still but for the wheel.
    Held,
}

/// The words shaped once; how it moves; how far it has slid; the last frame; whether
/// the pointer is on it.
struct State {
    line: Plain<Paragraph>,
    mode: Mode,
    slid: f32,
    last: Option<Instant>,
    over: bool,
}

impl Default for State {
    fn default() -> Self {
        Self { line: Plain::default(), mode: Mode::Auto { dir: 1.0, rest: None }, slid: 0.0, last: None, over: false }
    }
}

impl State {
    /// From the start, resting first (new words, or a first frame).
    fn restart(&mut self) {
        self.slid = 0.0;
        self.last = None;
        self.mode = if self.over { Mode::Held } else { Mode::Auto { dir: 1.0, rest: None } };
    }
}

impl Sliding {
    fn tall(&self) -> f32 {
        self.size * LINE_TIGHT
    }
}

/// How far the words reach past the room, whole pixels; 0 when they fit, or reach past
/// by under a pixel: that is the last letter's own blank, and a 1-pixel slide showed
/// nothing new, only a wiggle (his ask 2026-11-06, "i think about you all the time",
/// filmed moving 1 pixel every 2 s).
fn far(s: &State, room: Rectangle) -> f32 {
    (s.line.min_width() - room.width).floor().max(0.0)
}

impl<Message> Widget<Message, Theme, Renderer> for Sliding {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fixed(self.tall()))
    }

    fn layout(&mut self, tree: &mut Tree, _: &Renderer, limits: &layout::Limits) -> layout::Node {
        let s = tree.state.downcast_mut::<State>();
        let words = text::Text {
            content: self.words.as_str(),
            bounds: Size::new(f32::INFINITY, self.tall()),
            size: Pixels(self.size),
            line_height: LINE_TIGHT.into(),
            font: mp_ui::MEDIUM,
            align_x: text::Alignment::Left,
            align_y: Vertical::Center,
            shaping: text::Shaping::Advanced,
            wrapping: text::Wrapping::None,
        };
        // New words (the next song) start from the start.
        if s.line.update(words) {
            s.restart();
        }
        layout::Node::new(limits.resolve(Length::Fill, Length::Fixed(self.tall()), Size::ZERO))
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, _: &Renderer, _: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, _: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        let b = layout.bounds();
        let far = far(s, b);
        match event {
            Event::Window(window::Event::RedrawRequested(at)) => {
                if far <= 0.0 {
                    s.restart();
                    return;
                }
                let at = *at;
                let last = s.last.replace(at);
                match s.mode {
                    Mode::Held => {}
                    Mode::Stopping { start, from, to } => {
                        let u = (at.saturating_duration_since(start).as_secs_f32() / motion::SPATIAL.duration().as_secs_f32()).min(1.0);
                        s.slid = from + (to - from) * u * (2.0 - u);
                        if u >= 1.0 {
                            s.mode = Mode::Held;
                        } else {
                            shell.request_redraw();
                        }
                    }
                    Mode::Auto { mut dir, rest } => {
                        // A first frame rests at the start.
                        let Some(last) = last else {
                            s.mode = Mode::Auto { dir, rest: Some(at + REST) };
                            shell.request_redraw_at(at + REST);
                            return;
                        };
                        if let Some(until) = rest.filter(|u| at < *u) {
                            shell.request_redraw_at(until);
                            return;
                        }
                        let since = rest.map_or(last, |u| u.max(last));
                        s.slid += dir * SPEED * at.saturating_duration_since(since).as_secs_f32();
                        let mut rest = None;
                        if s.slid >= far || s.slid <= 0.0 {
                            s.slid = s.slid.clamp(0.0, far);
                            dir = if s.slid >= far { -1.0 } else { 1.0 };
                            rest = Some(at + REST);
                        }
                        s.mode = Mode::Auto { dir, rest };
                        shell.request_redraw_at(rest.unwrap_or(at + Duration::from_secs_f32(1.0 / SPEED)));
                    }
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { .. } | mouse::Event::CursorLeft) => {
                let over = cursor.is_over(b);
                if over == s.over {
                    return;
                }
                s.over = over;
                let now = Instant::now();
                if over {
                    let speed = match s.mode {
                        Mode::Auto { dir, rest: None } if s.last.is_some() => dir * SPEED,
                        _ => 0.0,
                    };
                    let from = s.slid.round();
                    let to = (from + speed * motion::SPATIAL.duration().as_secs_f32() / 2.0).round().clamp(0.0, far);
                    s.slid = from;
                    s.mode = if to == from { Mode::Held } else { Mode::Stopping { start: now, from, to } };
                    shell.request_redraw();
                } else {
                    // Rest, then on toward the end it was heading for.
                    let dir = match s.mode {
                        Mode::Auto { dir, .. } => dir,
                        Mode::Stopping { from, to, .. } if to < from => -1.0,
                        _ => 1.0,
                    };
                    let dir = if s.slid >= far {
                        -1.0
                    } else if s.slid <= 0.0 {
                        1.0
                    } else {
                        dir
                    };
                    s.mode = Mode::Auto { dir, rest: Some(now + REST) };
                    s.last = Some(now);
                    shell.request_redraw_at(now + REST);
                }
            }
            // The wheel's small moves: down shows the end, up the start.
            Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Pixels { x, y } }) if far > 0.0 && cursor.is_over(b) => {
                s.slid = (s.slid - x - y).clamp(0.0, far);
                s.mode = Mode::Held;
                shell.capture_event();
                shell.request_redraw();
            }
            _ => {}
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, _: &Theme, _: &renderer::Style, layout: Layout<'_>, _: mouse::Cursor, _: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        let b = layout.bounds();
        // Whole pixels, sharp, but for the stop's quarter pixels.
        let slid = if matches!(s.mode, Mode::Stopping { .. }) { s.slid } else { s.slid.round() };
        let x = if far(s, b) == 0.0 { b.x } else { b.x - slid };
        // A paragraph is drawn from its top left (iced's own text widget anchors it).
        let y = b.center_y() - s.line.min_height() / 2.0;
        renderer.fill_paragraph(s.line.raw(), Point::new(x, y), self.colour, b);
    }
}
