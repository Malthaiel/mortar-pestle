//! The on / off switch (Left Strip Return plan step 4, his OK at planning): Caelestia's
//! `components/controls/StyledSwitch.qml` (@bcbb5d5), held to the rulebook. A round
//! track a control tall and 1.7 times as wide; a round thumb a gap-1 shorter, half a
//! gap-1 in from the end it rests on, gliding across and a fifth wider while pressed;
//! inside the thumb two round-ended lines, an X while off, a tick while on, one flat
//! line while pressed. On: track accent, thumb on-accent, lines accent. Off: track
//! raised (Caelestia's highest surface), thumb text-faint (mp-theme's text-faint is
//! Material's outline, which Caelestia's thumb takes), lines raised. The rulebook's hover
//! patch (`style::HOVER`) on the thumb while it is under the pointer or pressed.
//!
//! Its owner keeps it, tells it what is on, hovered and pressed (`set`), and draws it
//! where it laid it out (`draw`): a strip menu's page draws itself. In an element tree
//! (the shell's capture settings, Left Strip Return step 5) `toggle` is the widget
//! round it.

use iced::advanced::graphics::geometry::Renderer as _;
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, renderer};
use iced::time::Instant;
use iced::widget::canvas::{Frame, LineCap, Path, Stroke};
use iced::{Color, Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, Vector, border, window};

use crate::colours::Colours;
use crate::motion::{self, Tween};
use crate::style::{CONTROL, GAP_1, GAP_3, HOVER};

/// The track's size: a control's height (Caelestia's: body text and a small padding
/// each side), 1.7 times as wide, in whole pixels.
pub fn size() -> Size {
    Size::new((CONTROL * 1.7).round(), CONTROL)
}

/// The thumb's height, and its width at rest (round).
const THUMB: f32 = CONTROL - GAP_1;
/// The lines' square inside the thumb (Caelestia: the thumb less a medium padding).
const MARK: f32 = THUMB - GAP_3;

/// The two lines' ends (start, end, start, end) as shares of the mark's square.
fn mark(on: bool, pressed: bool) -> [(f32, f32); 4] {
    match (pressed, on) {
        (true, true) => [(0.2, 0.5), (0.4, 0.5), (0.4, 0.5), (0.8, 0.5)],
        (true, false) => [(0.2, 0.5), (0.8, 0.5), (0.2, 0.5), (0.8, 0.5)],
        (false, true) => [(0.15, 0.5), (0.4, 0.7), (0.4, 0.7), (0.85, 0.2)],
        (false, false) => [(0.15, 0.15), (0.85, 0.85), (0.15, 0.85), (0.85, 0.15)],
    }
}

fn mix(a: Color, b: Color, t: f32) -> Color {
    Color { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t }
}

pub struct Switch {
    /// What it was last told.
    on: bool,
    pressed: bool,
    /// The thumb's left and width (Caelestia's FastSpatial: the rulebook's fast move).
    x: Tween,
    w: Tween,
    /// 0 off .. 1 on, for the colours (a fade).
    lit: Tween,
    /// The patch on the thumb.
    patch: Tween,
    /// The lines going from `from` to `to`.
    from: [(f32, f32); 4],
    to: [(f32, f32); 4],
    mark: Tween,
}

impl Switch {
    pub fn new(on: bool) -> Self {
        let lit = if on { 1.0 } else { 0.0 };
        Self {
            on,
            pressed: false,
            x: Tween::new(Self::left(on, THUMB), motion::SPATIAL_FAST),
            w: Tween::new(THUMB, motion::SPATIAL_FAST),
            lit: Tween::new(lit, motion::EFFECTS),
            patch: Tween::new(0.0, motion::EFFECTS),
            from: mark(on, false),
            to: mark(on, false),
            mark: Tween::new(1.0, motion::SPATIAL_FAST),
        }
    }

    /// The thumb's left for its width: against the right end while on.
    fn left(on: bool, w: f32) -> f32 {
        if on { size().width - w - GAP_1 / 2.0 } else { GAP_1 / 2.0 }
    }

    fn lines(&self, now: Instant) -> [(f32, f32); 4] {
        let p = self.mark.value(now);
        std::array::from_fn(|i| (self.from[i].0 + (self.to[i].0 - self.from[i].0) * p, self.from[i].1 + (self.to[i].1 - self.from[i].1) * p))
    }

    /// What is on, and whether the pointer is on it and holds it down.
    pub fn set(&mut self, on: bool, hovered: bool, pressed: bool, now: Instant) {
        if (on, pressed) != (self.on, self.pressed) {
            self.from = self.lines(now);
            self.to = mark(on, pressed);
            self.mark.set(0.0);
            self.mark.go(1.0, now);
            (self.on, self.pressed) = (on, pressed);
        }
        let w = if pressed { THUMB * 1.2 } else { THUMB };
        self.w.go(w, now);
        self.x.go(Self::left(on, w), now);
        self.lit.go(if on { 1.0 } else { 0.0 }, now);
        self.patch.go(if hovered || pressed { HOVER } else { 0.0 }, now);
    }

    pub fn moving(&self, now: Instant) -> bool {
        [self.x, self.w, self.lit, self.patch, self.mark].iter().any(|t| t.moving(now))
    }

    /// Drawn with its top left at `at`, faded by `alpha`. Whole pixels, as the menus'
    /// shapes (the CPU drawing redraws a shape's exact bounds).
    pub fn draw(&self, renderer: &mut Renderer, at: Point, c: &Colours, alpha: f32, now: Instant) {
        let lit = self.lit.value(now).clamp(0.0, 1.0);
        let shade = |colour: Color| Color { a: colour.a * alpha, ..colour };
        let size = size();
        let track = Rectangle::new(at, size);
        renderer.fill_quad(renderer::Quad { bounds: track, border: border::rounded(size.height / 2.0), ..Default::default() }, shade(mix(c.raised, c.accent, lit)));

        let thumb = Rectangle { x: (at.x + self.x.value(now)).round(), y: at.y + (size.height - THUMB) / 2.0, width: self.w.value(now).round(), height: THUMB };
        let round = border::rounded(THUMB / 2.0);
        renderer.fill_quad(renderer::Quad { bounds: thumb, border: round, ..Default::default() }, shade(mix(c.text_faint, c.on_accent, lit)));
        let patch = self.patch.value(now).clamp(0.0, 1.0);
        if patch > 0.0 {
            let colour = if self.on { c.accent } else { c.text };
            renderer.fill_quad(renderer::Quad { bounds: thumb, border: round, ..Default::default() }, Color { a: patch * alpha, ..colour });
        }

        // The lines, in the mark's square at the thumb's centre.
        let lines = self.lines(now);
        let point = |(x, y): (f32, f32)| Point::new(x * MARK, y * MARK);
        let path = Path::new(|b| {
            b.move_to(point(lines[0]));
            b.line_to(point(lines[1]));
            b.move_to(point(lines[2]));
            b.line_to(point(lines[3]));
        });
        let stroke = Stroke::default().with_color(shade(mix(c.raised, c.accent, lit))).with_width((MARK * 0.15).round()).with_line_cap(LineCap::Round);
        let mut frame = Frame::new(renderer, Size::new(MARK, MARK));
        frame.stroke(&path, stroke);
        let o = Vector::new(thumb.center_x() - MARK / 2.0, thumb.center_y() - MARK / 2.0);
        renderer.with_translation(o, |renderer| renderer.draw_geometry(frame.into_geometry()));
    }
}

/// The switch as a widget: `on` drawn, `flip` sent on a release over it after a press
/// on it (the Bluetooth box's rule).
pub fn toggle<'a, Message: Clone + 'a>(on: bool, c: &Colours, flip: Message) -> Element<'a, Message> {
    Element::new(Toggle { on, colours: *c, flip })
}

struct Toggle<Message> {
    on: bool,
    colours: Colours,
    flip: Message,
}

struct State {
    switch: Switch,
    pressed: bool,
    now: Instant,
}

impl<Message: Clone> Widget<Message, Theme, Renderer> for Toggle<Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State { switch: Switch::new(self.on), pressed: false, now: Instant::now() })
    }

    fn size(&self) -> Size<Length> {
        let s = size();
        Size::new(Length::Fixed(s.width), Length::Fixed(s.height))
    }

    fn layout(&mut self, _tree: &mut Tree, _renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        let s = size();
        layout::atomic(limits, s.width, s.height)
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, _renderer: &Renderer, _clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, _viewport: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        s.now = match event {
            Event::Window(window::Event::RedrawRequested(now)) => *now,
            _ => Instant::now(),
        };
        let over = cursor.is_over(layout.bounds());
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) if over => {
                s.pressed = true;
                shell.capture_event();
            }
            // The release is left to others (a taken one starves the widgets after).
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) if s.pressed => {
                s.pressed = false;
                if over {
                    shell.publish(self.flip.clone());
                }
            }
            _ => {}
        }
        s.switch.set(self.on, over, s.pressed && over, s.now);
        if s.switch.moving(s.now) {
            shell.request_redraw();
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout<'_>, _cursor: mouse::Cursor, _viewport: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        s.switch.draw(renderer, layout.bounds().position(), &self.colours, 1.0, s.now);
    }

    fn mouse_interaction(&self, _tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, _viewport: &Rectangle, _renderer: &Renderer) -> mouse::Interaction {
        if cursor.is_over(layout.bounds()) { mouse::Interaction::Pointer } else { mouse::Interaction::default() }
    }
}
