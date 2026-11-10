//! The top bar's left box: the workspace marks (Noctalia Look step 2, his picks
//! 2026-11-08). Noctalia's workspaces widget (`src/shell/bar/widgets/workspaces_widget.cpp`
//! @2f3e3c4f, its plain pill style) at the sizes hooxoo's picture shows: a mark per niri
//! workspace on the screen in niri's order, the current one a long bar, the others
//! short; the lengths glide on Noctalia's 200 ms ease-out cubic (`motion::SPATIAL`,
//! its `animNormal`). Colours as Noctalia's: the current one in the accent (its
//! primary), one with windows in Muted (its secondary; the theme has none since the
//! Caelestia Strip scrap), an empty one the same at 55%. The box is the bar's (Raised,
//! `BAR_BOX` tall, padded `BAR_PAD`), the pointer over it a hover patch over the whole
//! box (Noctalia's single-widget capsule); a click on a mark goes to its workspace.

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, renderer};
use iced::time::Instant;
use iced::{Color, Element, Event, Length, Rectangle, Renderer, Size, Theme, window};

use crate::colours::Colours;
use crate::motion::{self, Tween};
use crate::style;

/// The picture's marks: the current one 26 long, the others 6, all 8 tall, 4 apart
/// (Noctalia's `spaceXs`).
const ON: f32 = 26.0;
const OFF: f32 = 6.0;
const TALL: f32 = 8.0;
const GAP: f32 = style::GAP_1;
/// Noctalia's empty workspace: its colour's alpha times 0.55.
const EMPTY: f32 = 0.55;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Current,
    Windows,
    Empty,
}

pub struct Workspaces<'a, Message> {
    /// This screen's workspaces in niri's order: each one's id and kind.
    pub marks: Vec<(u64, Kind)>,
    pub colours: Colours,
    pub on_click: Box<dyn Fn(u64) -> Message + 'a>,
}

#[derive(Default)]
struct State {
    /// Each mark's length, gliding, by its workspace's id.
    lengths: Vec<(u64, Tween)>,
    over: bool,
    now: Option<Instant>,
}

fn length(kind: Kind) -> f32 {
    if kind == Kind::Current { ON } else { OFF }
}

impl<Message> Workspaces<'_, Message> {
    fn width(&self) -> f32 {
        let marks: f32 = self.marks.iter().map(|&(_, k)| length(k)).sum();
        2.0 * style::BAR_PAD + marks + GAP * self.marks.len().saturating_sub(1) as f32
    }

    /// Each mark's left edge and length in the box, as drawn now: whole pixels, as the
    /// CPU renderer redraws a shape's exact bounds.
    fn spots(&self, s: &State) -> Vec<(f32, f32)> {
        let mut x = style::BAR_PAD;
        self.marks
            .iter()
            .map(|&(id, kind)| {
                let w = match (s.lengths.iter().find(|(i, _)| *i == id), s.now) {
                    (Some((_, t)), Some(now)) => t.value(now),
                    _ => length(kind),
                }
                .round();
                x += w + GAP;
                (x - w - GAP, w)
            })
            .collect()
    }
}

impl<Message> Widget<Message, Theme, Renderer> for Workspaces<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fixed(self.width()), Length::Fixed(style::BAR_BOX))
    }

    fn layout(&mut self, _tree: &mut Tree, _renderer: &Renderer, _limits: &layout::Limits) -> layout::Node {
        layout::Node::new(Size::new(self.width(), style::BAR_BOX))
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, _renderer: &Renderer, _clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, _viewport: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        let now = match event {
            Event::Window(window::Event::RedrawRequested(now)) => *now,
            _ => Instant::now(),
        };
        s.now = Some(now);
        // Each mark's length follows its workspace; a new one shows as it is.
        let old = std::mem::take(&mut s.lengths);
        s.lengths = self
            .marks
            .iter()
            .map(|&(id, kind)| match old.iter().find(|(i, _)| *i == id) {
                Some((_, t)) => {
                    let mut t = t.clone();
                    t.go(length(kind), now);
                    (id, t)
                }
                None => (id, Tween::new(length(kind), motion::SPATIAL)),
            })
            .collect();
        if s.lengths.iter().any(|(_, t)| t.moving(now)) {
            shell.request_redraw();
        }
        let b = layout.bounds();
        let over = cursor.is_over(b);
        if over != s.over {
            s.over = over;
            shell.request_redraw();
        }
        if let (Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)), Some(p)) = (event, cursor.position_in(b)) {
            // Each mark takes the room to half way to the next, the ends to the box's edges.
            let spots = self.spots(s);
            let last = spots.len().saturating_sub(1);
            let hit = spots.iter().enumerate().position(|(i, &(x, w))| {
                let from = if i == 0 { 0.0 } else { x - GAP / 2.0 };
                let to = if i == last { b.width } else { x + w + GAP / 2.0 };
                (from..to).contains(&p.x)
            });
            if let Some(i) = hit {
                shell.publish((self.on_click)(self.marks[i].0));
                shell.capture_event();
            }
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout<'_>, _cursor: mouse::Cursor, _viewport: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        let b = layout.bounds();
        let c = &self.colours;
        renderer.fill_quad(renderer::Quad { bounds: b, ..Default::default() }, c.raised);
        if s.over {
            renderer.fill_quad(renderer::Quad { bounds: b, ..Default::default() }, c.text.scale_alpha(style::HOVER));
        }
        let y = (b.y + (b.height - TALL) / 2.0).round();
        for ((x, w), &(_, kind)) in self.spots(s).into_iter().zip(&self.marks) {
            let colour = match kind {
                Kind::Current => c.accent,
                Kind::Windows => c.text_muted,
                Kind::Empty => Color { a: c.text_muted.a * EMPTY, ..c.text_muted },
            };
            renderer.fill_quad(renderer::Quad { bounds: Rectangle { x: b.x + x, y, width: w, height: TALL }, ..Default::default() }, colour);
        }
    }

    fn mouse_interaction(&self, _tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, _viewport: &Rectangle, _renderer: &Renderer) -> mouse::Interaction {
        if cursor.is_over(layout.bounds()) { mouse::Interaction::Pointer } else { mouse::Interaction::default() }
    }
}

impl<'a, Message: 'a> From<Workspaces<'a, Message>> for Element<'a, Message> {
    fn from(w: Workspaces<'a, Message>) -> Self {
        Element::new(w)
    }
}
