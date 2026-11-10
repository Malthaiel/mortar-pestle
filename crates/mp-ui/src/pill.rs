//! The strip pills' highlight (his calls 2026-10-30): an accent pill that rests on
//! one item, or on none (a button bar), and slides, stop dead and as fast as the workspace
//! selector's, to the one whose menu shows or to a new pick. The items are drawn plain,
//! then a second, On Accent copy inside the pill's clip, so what it covers changes colour
//! as it moves (the workspace selector's way, Caelestia's `Colouriser`). Down a column (a
//! song list) or across a row (a button bar: Windows' `IconBar`, M&P Library step 3).
//! It moves as the Media tab's buttons pill (his call 2026-10-31): with nothing to rest
//! on it fades in where it lands and fades out where it was. Since Noctalia Look step 6
//! (his pick 2026-11-08) it no longer follows the pointer: the item under it gets
//! Noctalia's hover, a square patch of the text colour at `HOVER` (the top bar's), shown
//! at once, none on the pill's own item (Noctalia's `Tab` / `TabActive` buttons); a gap
//! between items belongs to the nearest one, so the patch never blinks off between them.

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, renderer};
use iced::time::Instant;
use iced::{Color, Element, Event, Length, Rectangle, Renderer, Size, Theme, border, window};

use crate::colours::Colours;
use crate::motion::{self, Tween};
use crate::style::{CORNER, HOVER};

pub struct Highlight<'a, Message> {
    /// A column of items, plain, taking the pointer.
    plain: Element<'a, Message>,
    /// The same column, laid out alike, in On Accent; none = never a pill (`hover`).
    lit: Option<Element<'a, Message>>,
    /// The item it rests on; none = no pill.
    rest: Option<usize>,
    /// The item whose menu shows, held while the pointer is on the menu.
    held: Option<usize>,
    accent: Color,
    /// The hovered item's patch.
    patch: Color,
    /// Items sit side by side, not stacked.
    across: bool,
    /// The pill's thickness, centred on the items; none = each item's own.
    thick: Option<f32>,
    /// Its corner (and the patch's); none = the rulebook's `CORNER`.
    corner: Option<f32>,
    /// Standing down: no pill (an item held to drag wears the accent itself, as
    /// Windows' `TrackList` `hold`).
    off: bool,
    /// Items out of reach (greyed out): no patch on them.
    skip: Vec<usize>,
}

impl<'a, Message> Highlight<'a, Message> {
    pub fn new(plain: impl Into<Element<'a, Message>>, lit: impl Into<Element<'a, Message>>, rest: Option<usize>, held: Option<usize>, c: &Colours) -> Self {
        Self { lit: Some(lit.into()), rest, held, ..Self::hover(plain, c) }
    }

    /// The hover patch alone, no pill ever (a drop menu's rows): no lit copy is built.
    pub fn hover(plain: impl Into<Element<'a, Message>>, c: &Colours) -> Self {
        let (accent, patch) = (c.accent, c.text.scale_alpha(HOVER));
        Self { plain: plain.into(), lit: None, rest: None, held: None, accent, patch, across: false, thick: None, corner: None, off: false, skip: Vec::new() }
    }

    pub fn across(mut self) -> Self {
        self.across = true;
        self
    }

    pub fn thick(mut self, thick: f32) -> Self {
        self.thick = Some(thick);
        self
    }

    pub fn corner(mut self, corner: f32) -> Self {
        self.corner = Some(corner);
        self
    }

    pub fn off(mut self, off: bool) -> Self {
        self.off = off;
        self
    }

    pub fn skip(mut self, skip: Vec<usize>) -> Self {
        self.skip = skip;
        self
    }
}

struct State {
    /// The pill's start and length along the items, from the widget's start.
    pill: Option<(Tween, Tween)>,
    /// How shown it is, 0 to 1.
    alpha: Tween,
    /// Where the item it is on sits across: start (from the widget's) and thickness.
    cross: (f32, f32),
    /// The item under the pointer.
    hover: Option<usize>,
    now: Option<Instant>,
}

impl<Message> Widget<Message, Theme, Renderer> for Highlight<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State { pill: None, alpha: Tween::new(0.0, motion::EFFECTS), cross: (0.0, 0.0), hover: None, now: None })
    }

    fn children(&self) -> Vec<Tree> {
        std::iter::once(&self.plain).chain(&self.lit).map(Tree::new).collect()
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(&std::iter::once(&self.plain).chain(&self.lit).collect::<Vec<_>>());
    }

    fn size(&self) -> Size<Length> {
        self.plain.as_widget().size()
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        let plain = self.plain.as_widget_mut().layout(&mut tree.children[0], renderer, limits);
        let lit = self.lit.as_mut().map(|lit| lit.as_widget_mut().layout(&mut tree.children[1], renderer, limits));
        layout::Node::with_children(plain.size(), std::iter::once(plain).chain(lit).collect())
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, renderer: &Renderer, clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let plain = layout.children().next().expect("plain");
        self.plain.as_widget_mut().update(&mut tree.children[0], event, plain, cursor, renderer, clipboard, shell, viewport);
        let s = tree.state.downcast_mut::<State>();
        let now = match event {
            Event::Window(window::Event::RedrawRequested(now)) => *now,
            _ => Instant::now(),
        };
        s.now = Some(now);
        let items: Vec<Rectangle> = plain.children().map(|item| item.bounds()).collect();
        let b = layout.bounds();
        // Anywhere on the widget: the nearest item along it, gaps included.
        let along = |r: &Rectangle, p: iced::Point| if self.across { (r.x - p.x).max(p.x - r.x - r.width) } else { (r.y - p.y).max(p.y - r.y - r.height) };
        let hovered = cursor.position_over(b).and_then(|p| (0..items.len()).min_by(|&i, &j| along(&items[i], p).total_cmp(&along(&items[j], p)))).filter(|i| !self.skip.contains(i));
        if hovered != s.hover {
            s.hover = hovered;
            shell.request_redraw();
        }
        let Some(item) = self.held.or(self.rest).filter(|_| !self.off).and_then(|i| items.get(i)) else {
            // Gone: it fades out where it is.
            s.alpha.go(0.0, now);
            if s.alpha.moving(now) {
                shell.request_redraw();
            }
            return;
        };
        let (y, h) = if self.across { (item.x - b.x, item.width) } else { (item.y - b.y, item.height) };
        s.cross = if self.across { (item.y - b.y, item.height) } else { (item.x - b.x, item.width) };
        let (py, ph) = s.pill.get_or_insert_with(|| (Tween::new(y, motion::SPATIAL), Tween::new(h, motion::SPATIAL)));
        // Unseen: it shows where it lands; seen: it slides there.
        if s.alpha.value(now) < 0.01 {
            py.set(y);
            ph.set(h);
        } else {
            py.go(y, now);
            ph.go(h, now);
        }
        s.alpha.go(1.0, now);
        if py.moving(now) || ph.moving(now) || s.alpha.moving(now) {
            shell.request_redraw();
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle) {
        let mut children = layout.children();
        let (plain, lit) = (children.next().expect("plain"), children.next());
        let s = tree.state.downcast_ref::<State>();
        let b = layout.bounds();
        let corner = self.corner.unwrap_or(CORNER);
        // Noctalia's hover, under the items: the item's square, the pill's thickness across.
        let picked = self.held.or(self.rest);
        let hovered = s.hover.filter(|&i| !self.off && Some(i) != picked).and_then(|i| plain.children().nth(i));
        if let Some(item) = hovered.map(|l| l.bounds()) {
            let patch = match (self.thick, self.across) {
                (Some(t), true) => Rectangle { y: b.y + (b.height - t) / 2.0, height: t, ..item },
                (Some(t), false) => Rectangle { x: b.x + (b.width - t) / 2.0, width: t, ..item },
                (None, _) => item,
            };
            let patch = snap(patch);
            if let Some(view) = patch.intersection(viewport) {
                renderer.with_layer(snap(view), |renderer| {
                    renderer.fill_quad(renderer::Quad { bounds: patch, border: border::rounded(corner), ..Default::default() }, self.patch);
                });
            }
        }
        self.plain.as_widget().draw(&tree.children[0], renderer, theme, style, plain, cursor, viewport);
        let (Some((py, ph)), Some(now), Some(lit_copy), Some(lit)) = (&s.pill, s.now, &self.lit, lit) else { return };
        let alpha = s.alpha.value(now).clamp(0.0, 1.0);
        if alpha <= 0.0 {
            return;
        }
        let (start, along) = (py.value(now), ph.value(now));
        let (cross, thick) = match self.thick {
            Some(t) => ((if self.across { b.height } else { b.width } - t) / 2.0, t),
            None => s.cross,
        };
        let pill = if self.across { Rectangle { x: b.x + start, y: b.y + cross, width: along, height: thick } } else { Rectangle { x: b.x + cross, y: b.y + start, width: thick, height: along } };
        // Whole pixels on screen, not just from the widget's start (a parent can sit on a
        // part pixel, as under a 45.6 header): the CPU renderer redraws a
        // shape's exact bounds, so a part-covered edge pixel stays behind as a line.
        let pill = snap(pill);
        // A layer is cut to its own bounds only, never to the one it sits in (iced's
        // `layer::Stack::push_clip`): cut to the view, or a list scrolled fast paints the
        // pill, lagging on a row gone by, past the list's edge (the music box's Tracks).
        let Some(view) = pill.intersection(viewport) else { return };
        renderer.with_layer(snap(view), |renderer| {
            renderer.fill_quad(renderer::Quad { bounds: pill, border: border::rounded(corner), ..Default::default() }, self.accent.scale_alpha(alpha));
            // iced can't fade a whole copy, so the lit one takes over halfway through
            // the fade (the Media tab fades each picture; 75 ms either way here).
            if alpha >= 0.5 {
                lit_copy.as_widget().draw(&tree.children[1], renderer, theme, style, lit, cursor, viewport);
            }
        });
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        let plain = layout.children().next().expect("plain");
        self.plain.as_widget().mouse_interaction(&tree.children[0], plain, cursor, viewport, renderer)
    }
}

/// A rectangle on whole pixels of the screen.
fn snap(r: Rectangle) -> Rectangle {
    let (x, y) = (r.x.round(), r.y.round());
    Rectangle { x, y, width: (r.x + r.width).round() - x, height: (r.y + r.height).round() - y }
}

impl<'a, Message: 'a> From<Highlight<'a, Message>> for Element<'a, Message> {
    fn from(h: Highlight<'a, Message>) -> Self {
        Element::new(h)
    }
}
