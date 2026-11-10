//! Pages side by side, one shown (Music Tab Redesign step 1, his ask: "the sliding
//! animation you are going to create"): Caelestia's dashboard (`modules/dashboard/
//! Content.qml` @bcbb5d5: the pages sit in a row, the view glides to the picked one's
//! place, its width and height glide to that page's size at the same time) as Windows
//! copied it (`Dashboard.jsx` `.dash-row`, a `translateX` over `--dur-spatial`), on the
//! rulebook's move time (`motion::SPATIAL`). The pages lie a gap apart, so the boxes inside never touch as
//! they pass. Caelestia's finger-drag between pages is left out (Windows left it too).
//!
//! Each page takes its own size; the view is the shown page's, gliding when it
//! changes, and cuts off what lies outside it. Only the pages in view are drawn and
//! hear the pointer.

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Operation, Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, overlay, renderer};
use iced::time::Instant;
use iced::{Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, Vector, window};

use crate::motion::{self, Tween};
use crate::style::GAP_2;

pub struct Slide<'a, Message> {
    pages: Vec<Element<'a, Message>>,
    current: usize,
}

/// `pages` left to right, `current` shown.
pub fn slide<'a, Message>(pages: Vec<Element<'a, Message>>, current: usize) -> Slide<'a, Message> {
    let current = current.min(pages.len().saturating_sub(1));
    Slide { pages, current }
}

struct State {
    now: Instant,
    shown: Option<usize>,
    /// The view's left in the row, and its size.
    x: Tween,
    w: Tween,
    h: Tween,
}

impl State {
    fn moving(&self, now: Instant) -> bool {
        self.x.moving(now) || self.w.moving(now) || self.h.moving(now)
    }
}

impl<Message> Slide<'_, Message> {
    /// The pages' places and sizes in the view: those it shows.
    fn in_view<'b>(&self, layout: Layout<'b>) -> impl Iterator<Item = (usize, Layout<'b>)> {
        let view = layout.bounds();
        layout.children().enumerate().filter(move |(_, l)| l.bounds().intersects(&view))
    }
}

impl<Message> Widget<Message, Theme, Renderer> for Slide<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        let tween = || Tween::new(0.0, motion::SPATIAL);
        tree::State::new(State { now: Instant::now(), shown: None, x: tween(), w: tween(), h: tween() })
    }

    fn children(&self) -> Vec<Tree> {
        self.pages.iter().map(Tree::new).collect()
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(&self.pages);
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Shrink, Length::Shrink)
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        let page_limits = layout::Limits::new(Size::ZERO, limits.max());
        let nodes: Vec<layout::Node> = self.pages.iter_mut().zip(&mut tree.children).map(|(page, t)| page.as_widget_mut().layout(t, renderer, &page_limits)).collect();
        let mut xs = Vec::with_capacity(nodes.len());
        let mut x = 0.0;
        for n in &nodes {
            xs.push(x);
            x += n.size().width + GAP_2;
        }
        let s = tree.state.downcast_mut::<State>();
        let Some(page) = nodes.get(self.current).map(layout::Node::size) else {
            return layout::Node::new(Size::ZERO);
        };
        let (to_x, now) = (xs[self.current], Instant::now());
        match s.shown {
            // First drawn: there at once.
            None => {
                s.x.set(to_x);
                s.w.set(page.width);
                s.h.set(page.height);
            }
            // Another page: the view glides to it.
            Some(shown) if shown != self.current => {
                s.x.go(to_x, now);
                s.w.go(page.width, now);
                s.h.go(page.height, now);
            }
            // The same page: a page before it changing width keeps it in place, its own
            // size changing glides the view (Caelestia's `Behavior`s).
            Some(_) => {
                s.x.follow(to_x);
                s.w.go(page.width, now);
                s.h.go(page.height, now);
            }
        }
        s.shown = Some(self.current);
        let at = s.now.max(now);
        let left = s.x.value(at);
        let size = limits.resolve(Length::Shrink, Length::Shrink, Size::new(s.w.value(at).round(), s.h.value(at).round()));
        let children = nodes.into_iter().zip(xs).map(|(n, x)| n.move_to(Point::new((x - left).round(), 0.0))).collect();
        layout::Node::with_children(size, children)
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, renderer: &Renderer, clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        if let Event::Window(window::Event::RedrawRequested(now)) = event {
            s.now = *now;
            if s.moving(*now) {
                shell.invalidate_layout();
                shell.request_redraw();
            }
        }
        // The pointer counts only inside the view: a page passing under the box's edge
        // can't be clicked.
        let cursor = if cursor.is_over(layout.bounds()) { cursor } else { mouse::Cursor::Unavailable };
        let shown: Vec<usize> = self.in_view(layout).map(|(i, _)| i).collect();
        for ((i, page), (t, l)) in self.pages.iter_mut().enumerate().zip(tree.children.iter_mut().zip(layout.children())) {
            // Keys and the like still reach every page; the pointer only those in view.
            let pointer = matches!(event, Event::Mouse(_) | Event::Touch(_));
            if pointer && !shown.contains(&i) {
                continue;
            }
            page.as_widget_mut().update(t, event, l, cursor, renderer, clipboard, shell, viewport);
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle) {
        let view = layout.bounds();
        let Some(clip) = view.intersection(viewport) else { return };
        let cursor = if cursor.is_over(view) { cursor } else { mouse::Cursor::Unavailable };
        renderer.with_layer(clip, |renderer| {
            for (i, l) in self.in_view(layout) {
                self.pages[i].as_widget().draw(&tree.children[i], renderer, theme, style, l, cursor, &clip);
            }
        });
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        if !cursor.is_over(layout.bounds()) {
            return mouse::Interaction::None;
        }
        self.in_view(layout).map(|(i, l)| self.pages[i].as_widget().mouse_interaction(&tree.children[i], l, cursor, viewport, renderer)).max().unwrap_or_default()
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn Operation) {
        operation.container(None, layout.bounds());
        operation.traverse(&mut |operation| {
            for ((page, t), l) in self.pages.iter_mut().zip(&mut tree.children).zip(layout.children()) {
                page.as_widget_mut().operate(t, l, renderer, operation);
            }
        });
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout<'b>, renderer: &Renderer, viewport: &Rectangle, translation: Vector) -> Option<overlay::Element<'b, Message, Theme, Renderer>> {
        overlay::from_children(&mut self.pages, tree, layout, renderer, viewport, translation)
    }
}

impl<'a, Message: 'a> From<Slide<'a, Message>> for Element<'a, Message> {
    fn from(s: Slide<'a, Message>) -> Self {
        Element::new(s)
    }
}
