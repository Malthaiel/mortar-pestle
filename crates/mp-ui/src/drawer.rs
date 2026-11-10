//! The top box, holding any widgets (Music Tab Redesign step 1): the shell's top bar
//! (`menu.rs` `Edge::Top`, Windows' `.strip-menu.is-top`) for a program of its own,
//! the music box. The box hangs from the frame's top band in the middle of its
//! surface, joined to the band by two inward curves (`shape`), as tall and wide as
//! its content and the menu's padding round it. Opening, it drops (`motion::SPATIAL`)
//! and its content fades in (`motion::EFFECTS`); the content hangs from the top and is
//! cut to the dropped part. Asked to close, it waits the hover menus' grace first.
//!
//! iced has no group fade, so the fade is a veil of the box's own colour over the
//! content going clear: over an opaque box the same picture as the content fading in.
//!
//! The surface should be as big as the largest box plus a corner each side; the box
//! tells where it is (`Event::Hit`) so the program can let the pointer through
//! everywhere else.
//!
//! `.over(layer)`: a layer from the content's top left to the surface's far corner,
//! drawn over the content and never cut to the box, for menus taller than the box
//! (the music box's main page is about 300 tall; a song's menu with your playlists
//! runs longer). Placed by the content's corner, so a menu set at a place in the
//! content stays there when the surface changes size.

use std::time::Duration;

use iced::advanced::graphics::geometry::Renderer as _;
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Operation, Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, overlay, renderer};
use iced::time::Instant;
use iced::widget::canvas::Frame;
use iced::{Color, Element, Event as IcedEvent, Length, Point, Rectangle, Renderer, Size, Theme, Vector, border, window};

use crate::motion::{self, Tween};
use crate::shape::{growth, join, rounded_bottom};
use crate::style::MENU_PAD;

/// How long a box waits to close once the pointer leaves (Windows' `useHoverIntent`
/// grace, his pick 2026-10-29), so the pointer can cross the frame to it.
pub const GRACE: Duration = Duration::from_millis(200);
/// A box that shrank is let go of the pointer once its size has held this long, so a
/// glide sends a few region changes, not one a frame.
const SETTLE: Duration = Duration::from_millis(100);

/// The music box's content width (Music Tab Redesign step 2): the shell's music box
/// lays its pages out this wide, and the shell's hover zone in the top band is the box's
/// width (Windows' `.dash-zone` took the box's). Even, so the box sits on the same pixel
/// in a surface the compositor centres and in one spanning the screen (`layout`).
pub const MUSIC: f32 = 1440.0;

#[derive(Debug, Clone, Copy)]
pub enum Event {
    /// The pointer on the box or off it.
    Hover(bool),
    /// The part of the surface that should take the pointer.
    Hit(Rectangle),
    /// Shut and drawn away: the surface can go.
    Closed,
}

pub struct Drawer<'a, Message> {
    content: Element<'a, Message>,
    /// Always there (a blank by default), so a menu coming or going never starts the
    /// content afresh (iced's `Tree::diff` by children).
    over: Element<'a, Message>,
    open: bool,
    r: f32,
    frame: Color,
    on_event: Box<dyn Fn(Event) -> Message + 'a>,
}

/// `content` in the top box, `open` or closing; `r` the windows' corner (niri's),
/// `frame` the frame's colour.
pub fn drawer<'a, Message: 'a>(content: impl Into<Element<'a, Message>>, open: bool, r: f32, frame: Color, on_event: impl Fn(Event) -> Message + 'a) -> Drawer<'a, Message> {
    // A whole-pixel corner keeps every edge on the pixel grid.
    Drawer { content: content.into(), over: iced::widget::space().into(), open, r: r.round(), frame, on_event: Box::new(on_event) }
}

impl<'a, Message: 'a> Drawer<'a, Message> {
    /// A layer over the content, from its top left to the surface's far corner, not
    /// cut to the box: menus.
    pub fn over(mut self, layer: impl Into<Element<'a, Message>>) -> Self {
        self.over = layer.into();
        self
    }
}

struct State {
    now: Instant,
    /// The whole box, padding included, in the surface.
    boxed: Rectangle,
    /// 0 shut .. 1 open (Caelestia's `1 - offsetScale`), and the content's fade.
    reveal: Tween,
    fade: Tween,
    open: bool,
    /// When it was asked to close: it closes `GRACE` later.
    left: Option<Instant>,
    over: bool,
    /// The region last sent, the box's last size and since when it has held.
    hit: Option<Rectangle>,
    since: (Rectangle, Instant),
    closed: bool,
}

fn contains(outer: Rectangle, inner: Rectangle) -> bool {
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
}

impl<Message> Widget<Message, Theme, Renderer> for Drawer<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        let now = Instant::now();
        tree::State::new(State {
            now,
            boxed: Rectangle::default(),
            reveal: Tween::new(0.0, motion::SPATIAL),
            fade: Tween::new(0.0, motion::EFFECTS),
            open: false,
            left: None,
            over: false,
            hit: None,
            since: (Rectangle::default(), now),
            closed: true,
        })
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content), Tree::new(&self.over)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(&[&self.content, &self.over]);
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        let room = limits.max();
        let inner = Size::new((room.width - 2.0 * (self.r + MENU_PAD)).max(0.0), (room.height - 2.0 * MENU_PAD).max(0.0));
        let content = self.content.as_widget_mut().layout(&mut tree.children[0], renderer, &layout::Limits::new(Size::ZERO, inner));
        let c = content.size();
        let size = Size::new((c.width + 2.0 * MENU_PAD).ceil(), (c.height + 2.0 * MENU_PAD).ceil());
        // Floored as the compositor centres a surface (whole halves), so a box in a
        // surface its own size plus the corners sits where it does in one spanning the
        // screen (the music box's while you type).
        let boxed = Rectangle::new(Point::new(((room.width - size.width) / 2.0).floor(), 0.0), size);
        tree.state.downcast_mut::<State>().boxed = boxed;
        let corner = Point::new(boxed.x + MENU_PAD, MENU_PAD);
        let rest = Size::new((room.width - corner.x).max(0.0), (room.height - corner.y).max(0.0));
        let over = self.over.as_widget_mut().layout(&mut tree.children[1], renderer, &layout::Limits::new(Size::ZERO, rest));
        layout::Node::with_children(room, vec![content.move_to(corner), over.move_to(corner)])
    }

    fn update(&mut self, tree: &mut Tree, event: &IcedEvent, layout: Layout<'_>, cursor: mouse::Cursor, renderer: &Renderer, clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        let now = match event {
            IcedEvent::Window(window::Event::RedrawRequested(now)) => *now,
            _ => Instant::now(),
        };
        s.now = now;
        let o = layout.position();
        let target = s.boxed + Vector::new(o.x, o.y);

        if self.open {
            s.left = None;
        } else if s.left.is_none() {
            s.left = Some(now);
        }
        let open = match s.left {
            Some(left) if now >= left + GRACE => false,
            Some(left) => {
                shell.request_redraw_at(left + GRACE);
                true
            }
            None => true,
        };
        let to = if open { 1.0 } else { 0.0 };
        s.reveal.go(to, now);
        s.fade.go(to, now);
        s.open = open;
        s.closed &= !open;

        // The region: grown at once, shrunk once the size holds.
        if s.since.0 != target {
            s.since = (target, now);
        }
        match s.hit {
            Some(hit) if hit == target => {}
            Some(hit) if contains(hit, target) => {
                if now >= s.since.1 + SETTLE {
                    s.hit = Some(target);
                    shell.publish((self.on_event)(Event::Hit(target)));
                } else {
                    shell.request_redraw_at(s.since.1 + SETTLE);
                }
            }
            hit => {
                let grown = hit.map_or(target, |h| h.union(&target));
                s.hit = Some(grown);
                shell.publish((self.on_event)(Event::Hit(grown)));
            }
        }

        let over = cursor.is_over(target);
        if over != s.over {
            s.over = over;
            shell.publish((self.on_event)(Event::Hover(over)));
        }

        if !open && !s.reveal.moving(now) && !s.closed {
            s.closed = true;
            shell.publish((self.on_event)(Event::Closed));
        }
        if s.reveal.moving(now) || s.fade.moving(now) {
            shell.request_redraw();
        }

        let mut children = layout.children();
        let (child, over) = (children.next().expect("content"), children.next().expect("over"));
        // The layer over the content hears the pointer first, as a stack's top layer
        // does (iced's `Stack::update`): a press it takes stops there, and where it
        // shows something the content below is not under the pointer.
        self.over.as_widget_mut().update(&mut tree.children[1], event, over, cursor, renderer, clipboard, shell, viewport);
        if shell.is_event_captured() {
            return;
        }
        let cursor = match self.over.as_widget().mouse_interaction(&tree.children[1], over, cursor, viewport, renderer) {
            mouse::Interaction::None => cursor,
            _ => cursor.levitate(),
        };
        self.content.as_widget_mut().update(&mut tree.children[0], event, child, cursor, renderer, clipboard, shell, viewport);
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout<'_>, cursor: mouse::Cursor, _viewport: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        let now = s.now;
        let b = s.boxed;
        // Whole pixels only (see `shape`): the box drops from the band.
        let shown = Rectangle { height: (b.height * s.reveal.value(now)).round(), ..b };
        if shown.width < 1.0 || shown.height < 1.0 {
            return;
        }
        let (curve, corner) = growth(shown.height, self.r);
        let mut frame = Frame::new(renderer, layout.bounds().size());
        frame.fill(&rounded_bottom(shown, corner), self.frame);
        if curve >= 1.0 {
            let (left, right, down) = (Vector::new(-1.0, 0.0), Vector::new(1.0, 0.0), Vector::new(0.0, 1.0));
            frame.fill(&join(Point::new(shown.x, 0.0), left, down, curve), self.frame);
            frame.fill(&join(Point::new(shown.x + shown.width, 0.0), right, down, curve), self.frame);
        }
        let o = Vector::new(layout.position().x, layout.position().y);
        renderer.with_translation(o, |renderer| renderer.draw_geometry(frame.into_geometry()));

        // The content cut to the dropped part (the layer does the cutting: a text's own
        // clip only marks what to redraw), the veil over it while it fades in.
        let clip = shown + o;
        let veil = 1.0 - s.fade.value(now).clamp(0.0, 1.0);
        let child = layout.children().next().expect("content");
        renderer.with_layer(clip, |renderer| {
            self.content.as_widget().draw(&tree.children[0], renderer, theme, style, child, cursor, &clip);
            if veil > 0.0 {
                let radius = border::Radius { top_left: 0.0, top_right: 0.0, bottom_right: corner, bottom_left: corner };
                let quad = renderer::Quad { bounds: clip, border: border::rounded(radius), ..Default::default() };
                renderer.fill_quad(quad, Color { a: self.frame.a * veil, ..self.frame });
            }
        });
        let over = layout.children().nth(1).expect("over");
        let all = layout.bounds();
        renderer.with_layer(all, |renderer| self.over.as_widget().draw(&tree.children[1], renderer, theme, style, over, cursor, &all));
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        let mut children = layout.children();
        let (child, over) = (children.next().expect("content"), children.next().expect("over"));
        let on_over = self.over.as_widget().mouse_interaction(&tree.children[1], over, cursor, viewport, renderer);
        if on_over != mouse::Interaction::None {
            return on_over;
        }
        self.content.as_widget().mouse_interaction(&tree.children[0], child, cursor, viewport, renderer)
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn Operation) {
        let mut children = layout.children();
        let (child, over) = (children.next().expect("content"), children.next().expect("over"));
        self.content.as_widget_mut().operate(&mut tree.children[0], child, renderer, operation);
        self.over.as_widget_mut().operate(&mut tree.children[1], over, renderer, operation);
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout<'b>, renderer: &Renderer, viewport: &Rectangle, translation: Vector) -> Option<overlay::Element<'b, Message, Theme, Renderer>> {
        let child = layout.children().next().expect("content");
        self.content.as_widget_mut().overlay(&mut tree.children[0], child, renderer, viewport, translation)
    }
}

impl<'a, Message: 'a> From<Drawer<'a, Message>> for Element<'a, Message> {
    fn from(d: Drawer<'a, Message>) -> Self {
        Element::new(d)
    }
}
