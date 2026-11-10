//! The shell's pop-up box, holding a `Body` (the power rows, the clock's calendar, the
//! Bluetooth and sound boxes, the Start menu, the notices, the side panel): a card that
//! floats `GAP_2` from the bar and the screen's edges (Noctalia's `floating_offset`) and
//! slides in whole from behind its edge, nothing of it shown past that edge, in 200 ms,
//! and back out on Noctalia's close ease-in (his asks 2026-11-09, Noctalia Look step 7:
//! "an animation where it slides into position. not a grow out", his picks "All of
//! them" and "From behind the bar"; "i also want the right side panel and start menu to
//! not be connected to the edges - but rather disconnected with gaps between"). The card
//! is `frame` with the popup shadow and no line (his pick "Remove both edges"), its
//! corners the windows' (niri's `geometry-corner-radius`).
//!
//! The bar's buttons' panels (`Edge::Float`): each its own surface under its button,
//! Noctalia's detached panel (`src/shell/panel/panel_manager.cpp` at `2f3e3c4f`): centred
//! on the button and kept `GAP_2` from the screen's edges, a head of its title and an X
//! (the control center's content header), down from behind the bar. The Start menu
//! (`Edge::Bottom`): bottom middle, up from behind the screen's bottom edge. The notices
//! (`Edge::Corner`) and the side panel (`Edge::Side`, one card: the notices list over the
//! recorder and switches, his ask "make the right panel one"): top right, in from behind
//! the right edge, as Noctalia's top-right notices (`notification_toast.cpp` `FromRight`).

use std::any::Any;
use std::time::Duration;

use iced::advanced::image::{self, Renderer as _};
use iced::advanced::layout::{self, Layout};
use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, renderer};
use iced::alignment::Vertical;
use iced::time::Instant;
use iced::{Color, Element, Event, Length, Point, Rectangle, Renderer, Shadow, Size, Theme, Vector, border, window};

use crate::colours::Colours;
use crate::motion::{self, Tween};
use crate::style;

/// A row (Windows' `row`): a control's height, padded gap-3, icon, gap-3, name.
const ROW: f32 = style::CONTROL;
const INSET: f32 = style::GAP_3;
const PAD: f32 = style::MENU_PAD;
/// How far a floating panel's shadow reaches past its card, as tiny-skia draws it
/// (`SHADOW_BLUR` round it, moved `SHADOW_DROP` down): its sides, above, below. The
/// surface holds the card and its shadow, as Noctalia's (`panel_surface::bleed`).
const REACH_X: f32 = style::SHADOW_BLUR;
const REACH_UP: f32 = style::SHADOW_BLUR - style::SHADOW_DROP;
const REACH_DOWN: f32 = style::SHADOW_BLUR + style::SHADOW_DROP;
/// A floating panel's head (Noctalia's content header): `CONTROL_SM` tall (the X's
/// square), `GAP_3` over the body (the control center's column gap).
const HEAD: f32 = style::CONTROL_SM + style::GAP_3;

/// Where a floating panel's surface sits from the screen's top: its card `GAP_2` under
/// the bar (Noctalia's `floating_offset`), less the shadow's reach above it.
pub const FLOAT_TOP: f32 = style::BAR + style::GAP_2 - REACH_UP;

/// The Start menu's surface for its tallest card: the card, its shadow's reach at the
/// sides and above, and `GAP_2` under it to the screen's bottom edge.
pub fn bottom_room(card: Size) -> Size {
    Size::new(card.width + 2.0 * REACH_X, card.height + REACH_UP + style::GAP_2)
}

/// The notices' surface for their card: its shadow's reach at its left and under it,
/// `GAP_2` to the screen's right edge and under the bar.
pub fn corner_room(card: Size) -> Size {
    Size::new(card.width + REACH_X + style::GAP_2, card.height + style::GAP_2 + REACH_DOWN)
}

/// The side panel's surface width for its card `card` wide (as the notices').
pub fn side_width(card: f32) -> f32 {
    corner_room(Size::new(card, 0.0)).width
}

/// The side panel's content height in a room `hole` tall (the screen under the bar): its
/// card as tall as a window's tile, `BAR_GAP` (niri's `gaps`) from the bar and the
/// bottom edge (his ask 2026-11-09: "same height as the terminal window"), less the
/// card's padding.
pub fn side_inner(hole: f32) -> f32 {
    hole - 2.0 * (style::BAR_GAP + PAD)
}

/// A floating panel's head: its title, the X's picture (Noctalia's `close`, 14), and
/// the colours its card, line, title and X take.
pub struct Head {
    pub title: &'static str,
    pub close: image::Handle,
    pub colours: Colours,
}

fn title_text<T>(content: T, width: f32) -> text::Text<T> {
    text::Text {
        content,
        bounds: Size::new(width, style::CONTROL_SM),
        size: style::TITLE.into(),
        line_height: style::LINE_TIGHT.into(),
        font: crate::BOLD,
        align_x: text::Alignment::Left,
        align_y: Vertical::Center,
        shaping: text::Shaping::Basic,
        wrapping: text::Wrapping::None,
    }
}
/// How long the box waits to close once the pointer leaves: one grace for every
/// box on the frame (`mp_ui::drawer::GRACE`).
use mp_ui::drawer::GRACE;

/// What a menu holds. It sizes itself, answers the pointer and draws inside the
/// card; the menu slides and clips it.
pub trait Body {
    type State: 'static;
    fn state(&self) -> Self::State;
    /// The content's size, inside the box's padding.
    fn size(&self, state: &mut Self::State) -> Size;
    /// `at`: the pointer from the content's top left, while it is over the box.
    fn update(&self, state: &mut Self::State, event: &Event, at: Option<Point>, now: Instant) -> Reply;
    fn draw(&self, state: &Self::State, renderer: &mut Renderer, content: Rectangle, alpha: f32, now: Instant);
    /// `draw`, told the box's shown part (the layer the menu clips to): a body that
    /// clips parts of its own (a notice card) cuts them to it, since an inner layer
    /// replaces the outer clip rather than cutting it.
    fn draw_in(&self, state: &Self::State, renderer: &mut Renderer, content: Rectangle, _clip: Rectangle, alpha: f32, now: Instant) {
        self.draw(state, renderer, content, alpha, now)
    }
    fn moving(&self, state: &Self::State, now: Instant) -> bool;
    /// Whether the pointer is on something that takes a click.
    fn clickable(&self, state: &Self::State) -> bool;
    /// Held (a slider dragged): the box stays open and keeps the pointer, wherever
    /// it goes (Windows' `busy()` close check).
    fn busy(&self, _state: &Self::State) -> bool {
        false
    }
    /// When it next needs drawing though nothing moves (a song's clock ticking).
    fn wake(&self, _state: &Self::State, _now: Instant) -> Option<Instant> {
        None
    }
}

/// What a body did with an event.
pub enum Reply {
    None,
    /// A click it handled itself.
    Used,
    /// Row `n` picked.
    Pick(usize),
    /// Asked to close (Esc).
    Close,
}

/// A `Body` with its state boxed, so one menu holds bodies of different kinds.
pub trait Page {
    fn new_state(&self) -> Box<dyn Any>;
    fn size(&self, state: &mut dyn Any) -> Size;
    fn update(&self, state: &mut dyn Any, event: &Event, at: Option<Point>, now: Instant) -> Reply;
    fn draw_in(&self, state: &dyn Any, renderer: &mut Renderer, content: Rectangle, clip: Rectangle, alpha: f32, now: Instant);
    fn moving(&self, state: &dyn Any, now: Instant) -> bool;
    fn clickable(&self, state: &dyn Any) -> bool;
    fn busy(&self, state: &dyn Any) -> bool;
    fn wake(&self, state: &dyn Any, now: Instant) -> Option<Instant>;
}

impl<B: Body> Page for B {
    fn new_state(&self) -> Box<dyn Any> {
        Box::new(self.state())
    }
    fn size(&self, s: &mut dyn Any) -> Size {
        Body::size(self, s.downcast_mut().unwrap())
    }
    fn update(&self, s: &mut dyn Any, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        Body::update(self, s.downcast_mut().unwrap(), event, at, now)
    }
    fn draw_in(&self, s: &dyn Any, renderer: &mut Renderer, content: Rectangle, clip: Rectangle, alpha: f32, now: Instant) {
        Body::draw_in(self, s.downcast_ref().unwrap(), renderer, content, clip, alpha, now)
    }
    fn moving(&self, s: &dyn Any, now: Instant) -> bool {
        Body::moving(self, s.downcast_ref().unwrap(), now)
    }
    fn clickable(&self, s: &dyn Any) -> bool {
        Body::clickable(self, s.downcast_ref().unwrap())
    }
    fn busy(&self, s: &dyn Any) -> bool {
        Body::busy(self, s.downcast_ref().unwrap())
    }
    fn wake(&self, s: &dyn Any, now: Instant) -> Option<Instant> {
        Body::wake(self, s.downcast_ref().unwrap(), now)
    }
}

#[derive(Debug, Clone)]
pub enum MenuEvent {
    Hover(bool),
    Pick(usize),
    /// The body asked to close (`Reply::Close`).
    Dismiss,
    /// The surface size the menu needs.
    Size(Size),
    /// A floating panel's surface (`Edge::Float`): its left edge on the screen and its
    /// size, the card and its shadow (its top is `FLOAT_TOP`).
    Span {
        left: f32,
        size: Size,
    },
    /// The shown menu's box: the part of the surface that takes the mouse.
    Hit(Rectangle),
    Closed,
}

/// Where a menu's card rests and the edge it slides in from behind.
#[derive(Clone, Copy, PartialEq)]
enum Edge {
    /// Under the bar, centred on its button, kept `GAP_2` from the edges of a screen
    /// `screen` wide; the surface placed and sized by the menu (`MenuEvent::Span`). Down
    /// from behind the bar.
    Float { screen: f32 },
    /// `GAP_2` over the screen's bottom edge in the surface's middle (the surface made
    /// for the tallest card, `bottom_room`), its height gliding with its bottom held. Up
    /// from behind the screen's bottom edge.
    Bottom,
    /// `GAP_2` under the bar and from the screen's right edge; the surface sized to the
    /// card by the menu (`MenuEvent::Size`, `corner_room`), since the notices change its
    /// height. In from behind the right edge.
    Corner,
    /// As `Corner`, but a window's height: the room's less `BAR_GAP` over and under (the
    /// surface comes sized, `side_width`). In from behind the right edge.
    Side,
}

pub struct Menu<'a, Message> {
    edge: Edge,
    /// What it holds: its button's middle across the screen (a floating panel's; the
    /// other edges leave it 0), and the body.
    pages: Vec<(f32, Box<dyn Page + 'a>)>,
    /// The menu showing, or the last one while the box closes.
    shown: usize,
    open: bool,
    r: f32,
    frame: Color,
    /// A floating panel's head.
    head: Option<Head>,
    on_event: Box<dyn Fn(MenuEvent) -> Message + 'a>,
}

impl<'a, Message> Menu<'a, Message> {
    pub fn new(pages: Vec<(f32, Box<dyn Page + 'a>)>, shown: usize, open: bool, r: f32, frame: Color, on_event: impl Fn(MenuEvent) -> Message + 'a) -> Self {
        // A whole-pixel corner keeps every edge on the pixel grid (see `draw`).
        Self { edge: Edge::Bottom, pages, shown, open, r: r.round(), frame, head: None, on_event: Box::new(on_event) }
    }

    /// A floating panel under the bar, centred on its button on a screen `screen`
    /// wide, with `head` over the body (the bar's buttons' menus).
    pub fn floating(self, screen: f32, head: Head) -> Self {
        Self { edge: Edge::Float { screen }, head: Some(head), ..self }
    }

    /// Up from behind the screen's bottom edge instead (the Start menu).
    pub fn from_bottom(self) -> Self {
        Self { edge: Edge::Bottom, ..self }
    }

    /// In from behind the right edge, under the bar, the surface sized to it (the notices).
    pub fn from_corner(self) -> Self {
        Self { edge: Edge::Corner, ..self }
    }

    /// The side panel instead: the room's height, in from behind the right edge.
    pub fn from_side(self) -> Self {
        Self { edge: Edge::Side, ..self }
    }

    /// A floating panel's surface's left edge on the screen: its card centred on the
    /// button, kept `GAP_2` from the screen's edges (Noctalia's `marginLeftFromAnchor`,
    /// `clampMargin` with `spaceSm`), less the shadow's reach.
    /// The surface holds the card and its shadow's reach, cut at the screen's edges, so it
    /// never asks for room past them (a card kept `GAP_2` from the edge would reach 4
    /// past it: the Bluetooth and sound panels stopped opening, his catch 2026-11-09).
    /// Gives the card's left inside the surface, and the surface's left and width.
    fn float_place(&self, s: &State, screen: f32) -> (f32, f32, f32) {
        let (middle, w) = (self.pages[s.shown].0, s.sizes[s.shown].width);
        let card = (middle - w / 2.0).min(screen - style::GAP_2 - w).max(style::GAP_2).round();
        let (left, right) = ((card - REACH_X).max(0.0), (card + w + REACH_X).min(screen));
        (card - left, left, right - left)
    }

    /// Menu `i`'s card at rest in a surface `room` big: a bar panel's inside its
    /// shadow's reach, the others `GAP_2` from their edges.
    fn boxed(&self, s: &State, i: usize, room: Size) -> Rectangle {
        let size = s.sizes[i];
        let at = match self.edge {
            Edge::Float { screen } => Point::new(self.float_place(s, screen).0, REACH_UP),
            Edge::Bottom => Point::new(((room.width - size.width) / 2.0).round(), room.height - style::GAP_2 - size.height),
            Edge::Corner => Point::new(room.width - style::GAP_2 - size.width, style::GAP_2),
            Edge::Side => Point::new(room.width - style::GAP_2 - size.width, style::BAR_GAP),
        };
        Rectangle::new(at, size)
    }

    /// How long the box waits to close: the side panel's hover grace (Windows'
    /// `useHoverIntent`); none for a menu closed on purpose, or for the notices (they
    /// close when the last leaves).
    fn grace(&self) -> Duration {
        if self.edge == Edge::Side { GRACE } else { Duration::ZERO }
    }

    /// The padding round the body (a bar panel's Noctalia's `panelPadding`) and, over
    /// it, a bar panel's head.
    fn insets(&self) -> (f32, f32) {
        if self.head.is_some() { (style::PANEL_PAD, HEAD) } else { (PAD, 0.0) }
    }

    /// Where the body's content starts in the surface: inside the card's padding, a bar
    /// panel's under its head too.
    fn content_at(&self, card: Rectangle) -> Point {
        let (pad, head) = self.insets();
        Point::new(card.x + pad, card.y + pad + head)
    }

    /// A floating panel's X, in the surface: `CONTROL_SM` square at its head's right.
    fn close_at(target: Rectangle) -> Rectangle {
        let side = style::CONTROL_SM;
        Rectangle { x: target.x + target.width - style::PANEL_PAD - side, y: target.y + style::PANEL_PAD, width: side, height: side }
    }

    /// A bar panel's head (Noctalia's `placePanelChrome`): the title in `text` (his pick
    /// over Noctalia's accent) and the X: `raised` (Noctalia's Default button), the hover
    /// patch, the picture; no line round it (his pick "Remove both edges").
    fn draw_head(&self, s: &State, head: &Head, renderer: &mut Renderer, card: Rectangle, o: Vector) {
        let c = &head.colours;
        let x = Self::close_at(card);
        let title = Rectangle { x: card.x + style::PANEL_PAD, y: card.y + style::PANEL_PAD, width: x.x - style::GAP_2 - card.x - style::PANEL_PAD, height: style::CONTROL_SM } + o;
        renderer.fill_text(title_text(head.title.to_string(), title.width), Point::new(title.x, title.center_y()), c.text, title);
        renderer.fill_quad(renderer::Quad { bounds: x + o, ..Default::default() }, c.raised);
        if s.close_over {
            renderer.fill_quad(renderer::Quad { bounds: x + o, ..Default::default() }, c.text.scale_alpha(style::HOVER));
        }
        let side = style::ICON_SM as f32;
        let spot = Rectangle { x: x.center_x() - side / 2.0, y: x.center_y() - side / 2.0, width: side, height: side } + o;
        renderer.draw_image(image::Image::new(head.close.clone()), spot, x + o);
    }
}

struct State {
    now: Instant,
    pages: Vec<Box<dyn Any>>,
    /// Each menu's whole card, padding included (a bar panel's head too).
    sizes: Vec<Size>,
    /// The menu drawn.
    shown: usize,
    /// The card's height, gliding as its content changes.
    h: Tween,
    /// 0 behind its edge .. 1 at rest.
    reveal: Tween,
    open: bool,
    /// When the pointer left: the box closes `GRACE` later.
    left: Option<Instant>,
    over: bool,
    /// The pointer on a floating panel's X.
    close_over: bool,
    sent: (Option<Size>, Option<Rectangle>),
    /// A floating panel's last `MenuEvent::Span`.
    span: Option<(f32, Size)>,
    closed: bool,
}

impl<Message> Widget<Message, Theme, Renderer> for Menu<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        let tween = |m| Tween::new(0.0, m);
        tree::State::new(State {
            now: Instant::now(),
            pages: self.pages.iter().map(|(_, page)| page.new_state()).collect(),
            sizes: Vec::new(),
            shown: self.shown,
            h: tween(motion::SPATIAL),
            reveal: tween(motion::SPATIAL),
            open: false,
            left: None,
            over: false,
            close_over: false,
            sent: (None, None),
            span: None,
            closed: false,
        })
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn layout(&mut self, tree: &mut Tree, _renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        let s = tree.state.downcast_mut::<State>();
        // A bar panel: the body under its head, at least as wide as the title, a gap and
        // the X.
        let (pad, head) = self.insets();
        let least = self.head.as_ref().map_or(0.0, |h| <Renderer as text::Renderer>::Paragraph::with_text(title_text(h.title, f32::INFINITY)).min_width() + style::GAP_2 + style::CONTROL_SM);
        // Whole pixels (see `draw`).
        s.sizes = self
            .pages
            .iter()
            .zip(&mut s.pages)
            .map(|((_, page), state)| {
                let inner = page.size(&mut **state);
                Size::new((inner.width.max(least) + 2.0 * pad).ceil(), (inner.height + head + 2.0 * pad).ceil())
            })
            .collect();
        layout::Node::new(limits.max())
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, _renderer: &Renderer, _clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, _viewport: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        let now = match event {
            Event::Window(window::Event::RedrawRequested(now)) => *now,
            _ => Instant::now(),
        };
        s.now = now;
        s.shown = self.shown;
        let room = layout.bounds().size();
        let target = self.boxed(s, self.shown, room);
        // A floating panel places and sizes its own surface: the card and its shadow,
        // grown at once, shrunk once the card's glide ends (as the corner's). Its slide
        // waits for the surface's first size; once in, a later resize can't undo it.
        let mut ready = true;
        if let Edge::Float { screen } = self.edge {
            let reach = REACH_UP + REACH_DOWN;
            let held = s.span.map_or(0.0, |(_, z)| z.height - reach);
            let h = if s.h.moving(now) { held.max(target.height) } else { target.height };
            let (_, left, width) = self.float_place(s, screen);
            let span = (left, Size::new(width, h + reach));
            if s.span != Some(span) {
                s.span = Some(span);
                shell.publish((self.on_event)(MenuEvent::Span { left: span.0, size: span.1 }));
            }
            ready = room.width + 0.5 >= span.1.width && room.height + 0.5 >= span.1.height;
        }
        let from = self.content_at(target);
        if s.sent.1 != Some(target) {
            s.sent.1 = Some(target);
            shell.publish((self.on_event)(MenuEvent::Hit(target)));
        }

        if self.open {
            s.left = None;
        } else if s.left.is_none() {
            s.left = Some(now);
        }
        let want = match s.left {
            Some(left) if now >= left + self.grace() => false,
            Some(left) => {
                shell.request_redraw_at(left + self.grace());
                true
            }
            None => true,
        };
        let open = want && (ready || s.open);
        if open && !s.open {
            // Opening: the card comes in at its full height.
            s.h.set(target.height);
        } else if open {
            s.h.go(target.height, now);
        }
        if open != s.open {
            // The slide: in on the rulebook's move, out on Noctalia's close ease-in quad.
            s.reveal.go_with(if open { 1.0 } else { 0.0 }, now, if open { motion::SPATIAL } else { motion::CLOSE });
        }
        s.open = open;
        s.closed &= !want;
        if self.edge == Edge::Corner {
            // The surface: grown at once, shrunk once the card's glide ends; held while
            // the card slides out (it keeps its height, its last notice gone).
            let extra = corner_room(Size::ZERO).height;
            let held = s.sent.0.map_or(0.0, |z| z.height - extra);
            let h = if s.h.moving(now) || !open { held.max(target.height) } else { target.height };
            let size = corner_room(Size::new(target.width, h));
            if s.sent.0 != Some(size) {
                s.sent.0 = Some(size);
                shell.publish((self.on_event)(MenuEvent::Size(size)));
            }
        }

        let o = layout.position();
        let on = |r: Rectangle| cursor.is_over(r + Vector::new(o.x, o.y));
        let over = self.pages[s.shown].1.busy(&*s.pages[s.shown]) || on(target);
        if over != s.over {
            s.over = over;
            shell.publish((self.on_event)(MenuEvent::Hover(over)));
        }
        // A floating panel's X: the hover patch at once, a press closes it.
        let close_over = self.head.is_some() && open && on(Self::close_at(target));
        if close_over != s.close_over {
            s.close_over = close_over;
            shell.request_redraw();
        }
        if close_over && matches!(event, Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))) {
            shell.publish((self.on_event)(MenuEvent::Dismiss));
            shell.capture_event();
            return;
        }
        // The side panel's content hears the pointer once its card is in: settings resting
        // under the pointer would grow out of a pill not shown yet (his catch 2026-11-04).
        let rising = self.edge == Edge::Side && open && s.reveal.moving(now);
        let at = cursor.position().filter(|_| over && !rising).map(|p| Point::new(p.x - o.x - from.x, p.y - o.y - from.y));
        match self.pages[s.shown].1.update(&mut *s.pages[s.shown], event, at, now) {
            Reply::None => {}
            // A click it handled may change its size (a notice opened), and changes what
            // shows: drawn now, not at the next pointer move (iced redraws only on asking;
            // `invalidate_layout` just marks the layout stale).
            Reply::Used => {
                shell.capture_event();
                shell.invalidate_layout();
                shell.request_redraw();
            }
            Reply::Pick(i) => {
                shell.publish((self.on_event)(MenuEvent::Pick(i)));
                shell.capture_event();
            }
            Reply::Close => {
                shell.publish((self.on_event)(MenuEvent::Dismiss));
                shell.capture_event();
            }
        }

        if !want && !s.reveal.moving(now) && !s.closed {
            s.closed = true;
            shell.publish((self.on_event)(MenuEvent::Closed));
        }
        let pages = self.pages.iter().zip(&s.pages).any(|((_, page), state)| page.moving(&**state, now));
        if pages || s.reveal.moving(now) || s.h.moving(now) {
            shell.request_redraw();
        } else if let Some(at) = self.pages[s.shown].1.wake(&*s.pages[s.shown], now).filter(|_| open) {
            shell.request_redraw_at(at);
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout<'_>, _cursor: mouse::Cursor, _viewport: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        let now = s.now;
        let reveal = s.reveal.value(now);
        if reveal <= 0.0 {
            return;
        }
        let o = Vector::new(layout.position().x, layout.position().y);
        let room = layout.bounds().size();
        // Whole pixels only: the CPU renderer redraws a drawn shape's exact bounds, so a
        // part-covered edge pixel would be left behind as a line. The card's height
        // glides as its insides change, a bottom one's bottom held.
        let full = self.boxed(s, s.shown, room);
        let h = s.h.value(now).round();
        let rest = Rectangle { y: if self.edge == Edge::Bottom { full.y + full.height - h } else { full.y }, height: h, ..full };
        // Out of sight behind its edge by its own size and the gap.
        let away = 1.0 - reveal;
        let slide = match self.edge {
            Edge::Float { .. } => Vector::new(0.0, -(away * (h + style::GAP_2)).round()),
            Edge::Bottom => Vector::new(0.0, (away * (h + style::GAP_2)).round()),
            Edge::Corner | Edge::Side => Vector::new((away * (rest.width + style::GAP_2)).round(), 0.0),
        };
        let card = rest + slide;
        // A bar panel's surface reaches over the bar (for the shadow): nothing of it shows
        // above the bar's bottom edge. The others' surfaces end at their edge.
        let top = if matches!(self.edge, Edge::Float { .. }) { style::BAR - FLOAT_TOP } else { 0.0 };
        let shown = Rectangle { x: 0.0, y: top, width: room.width, height: (room.height - top).max(0.0) } + o;
        renderer.with_layer(shown, |renderer| {
            let shadow = Shadow { color: Color { a: style::SHADOW_ALPHA, ..Color::BLACK }, offset: Vector::new(0.0, style::SHADOW_DROP), blur_radius: style::SHADOW_BLUR };
            renderer.fill_quad(renderer::Quad { bounds: card + o, border: border::rounded(self.r), shadow, ..Default::default() }, self.frame);
            if let Some(head) = &self.head {
                self.draw_head(s, head, renderer, card, o);
            }
        });
        // The content at its full card's place, moving with the slide (a bottom card's
        // sits on its bottom edge as the card's top glides: Windows' `bottom: 0`), cut to
        // the card and to what shows: a layer of its own (an inner layer replaces the
        // outer clip rather than cutting it).
        let (pad, head) = self.insets();
        let at = self.content_at(full + slide);
        let content = Rectangle { x: at.x, y: at.y, width: full.width - 2.0 * pad, height: full.height - 2.0 * pad - head } + o;
        let Some(clip) = shown.intersection(&(card + o)) else { return };
        renderer.with_layer(clip, |renderer| self.pages[s.shown].1.draw_in(&*s.pages[s.shown], renderer, content, clip, 1.0, now));
    }

    fn mouse_interaction(&self, tree: &Tree, _layout: Layout<'_>, _cursor: mouse::Cursor, _viewport: &Rectangle, _renderer: &Renderer) -> mouse::Interaction {
        let s = tree.state.downcast_ref::<State>();
        if s.close_over || self.pages[s.shown].1.clickable(&*s.pages[s.shown]) { mouse::Interaction::Pointer } else { mouse::Interaction::default() }
    }
}

impl<'a, Message: 'a> From<Menu<'a, Message>> for Element<'a, Message> {
    fn from(m: Menu<'a, Message>) -> Self {
        Element::new(m)
    }
}

#[derive(Clone)]
pub struct Row {
    pub label: String,
    /// Plain and lit (on the pill); a program's window rows have none, as Windows'.
    pub icon: Option<[image::Handle; 2]>,
}

/// A menu's rows (the power menu's, a program's windows): an icon and a name each, the
/// accent pill under the hovered one.
pub struct Rows {
    pub rows: Vec<Row>,
    pub colours: Colours,
}

impl Rows {
    /// Where a row's name starts.
    fn text_x(&self) -> f32 {
        if self.rows.iter().any(|r| r.icon.is_some()) { INSET + style::ICON as f32 + INSET } else { INSET }
    }

    /// The rows' height inside the box.
    pub fn height(rows: usize) -> f32 {
        rows as f32 * ROW
    }
}

pub struct RowsState {
    pill_y: Tween,
    pill_alpha: Tween,
    hovered: Option<usize>,
}

impl RowsState {
    pub fn new() -> Self {
        Self { pill_y: Tween::new(0.0, motion::SPATIAL_FAST), pill_alpha: Tween::new(0.0, motion::EFFECTS), hovered: None }
    }

    pub fn moving(&self, now: Instant) -> bool {
        self.pill_y.moving(now) || self.pill_alpha.moving(now)
    }
}

fn label<T>(content: T, width: f32) -> text::Text<T> {
    text::Text {
        content,
        bounds: Size::new(width, ROW),
        size: style::BODY.into(),
        line_height: style::LINE_TIGHT.into(),
        font: crate::BOLD,
        align_x: text::Alignment::Left,
        align_y: Vertical::Center,
        shaping: text::Shaping::Basic,
        wrapping: text::Wrapping::None,
    }
}

impl Body for Rows {
    type State = RowsState;

    fn state(&self) -> RowsState {
        RowsState::new()
    }

    fn size(&self, _: &mut RowsState) -> Size {
        // The widest name, measured, sets the width.
        let widest = self.rows.iter().map(|row| <Renderer as text::Renderer>::Paragraph::with_text(label(row.label.as_str(), f32::INFINITY)).min_width()).fold(0.0, f32::max);
        Size::new(self.text_x() + widest + INSET, Self::height(self.rows.len()))
    }

    fn update(&self, s: &mut RowsState, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        let hovered = at.map(|p| (p.y / ROW).floor()).filter(|i| (0.0..self.rows.len() as f32).contains(i)).map(|i| i as usize);
        if hovered != s.hovered {
            s.hovered = hovered;
            match hovered {
                Some(i) => {
                    let y = i as f32 * ROW;
                    if s.pill_alpha.value(now) < 0.01 {
                        s.pill_y.set(y)
                    } else {
                        s.pill_y.go(y, now)
                    }
                    s.pill_alpha.go(1.0, now);
                }
                None => s.pill_alpha.go(0.0, now),
            }
        }
        match (event, s.hovered) {
            (Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)), Some(i)) => Reply::Pick(i),
            _ => Reply::None,
        }
    }

    fn draw(&self, s: &RowsState, renderer: &mut Renderer, c: Rectangle, alpha: f32, now: Instant) {
        let colours = &self.colours;
        let full = Rectangle { x: c.x - PAD, y: c.y - PAD, width: c.width + 2.0 * PAD, height: c.height + 2.0 * PAD };
        let pill_alpha = s.pill_alpha.value(now).clamp(0.0, 1.0) * alpha;
        let pill = Rectangle { x: c.x, y: c.y + s.pill_y.value(now), width: c.width, height: ROW };
        if pill_alpha > 0.0 {
            let quad = renderer::Quad { bounds: pill, border: border::rounded(style::CORNER), ..Default::default() };
            renderer.fill_quad(quad, Color { a: pill_alpha, ..colours.accent });
        }
        for (i, row) in self.rows.iter().enumerate() {
            let y = c.y + i as f32 * ROW;
            // How lit: the share of the row the pill covers right now, so colours
            // ease along with its slide (his ask 2026-10-29).
            let lit = ((pill.y + ROW).min(y + ROW) - pill.y.max(y)).max(0.0) / ROW * pill_alpha;
            let side = style::ICON as f32;
            if let Some([icon, lit_icon]) = &row.icon {
                let spot = Rectangle { x: c.x + INSET, y: y + (ROW - side) / 2.0, width: side, height: side };
                renderer.draw_image(image::Image { opacity: alpha, ..image::Image::new(icon.clone()) }, spot, full);
                if lit > 0.0 {
                    renderer.draw_image(image::Image { opacity: alpha * lit, ..image::Image::new(lit_icon.clone()) }, spot, full);
                }
            }
            // Two colours only, the lit name faded in over the plain one (as the
            // icons): iced_tiny_skia 0.14.1 caches each letter per colour, so an
            // eased colour cached a new set every frame (1.3 MiB kept, 2026-10-29).
            // Fully lit, the plain one goes, or its edges would show round the lit one.
            let start = self.text_x();
            let name = Rectangle { x: c.x + start, y, width: c.width - start, height: ROW };
            let at = Point::new(name.x, name.center_y());
            if lit < 0.99 {
                renderer.fill_text(label(row.label.clone(), name.width), at, Color { a: alpha, ..colours.text }, name);
            }
            if lit > 0.0 {
                renderer.fill_text(label(row.label.clone(), name.width), at, Color { a: alpha * lit.min(1.0), ..colours.on_accent }, name);
            }
        }
    }

    fn moving(&self, s: &RowsState, now: Instant) -> bool {
        s.moving(now)
    }

    fn clickable(&self, s: &RowsState) -> bool {
        s.hovered.is_some()
    }
}
