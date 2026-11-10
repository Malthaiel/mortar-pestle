//! Hold and drag to put items in order (M&P Library plan, step 4 piece C: a
//! playlist's songs and the cover wall's Custom order; new part approved chat 37).
//! Windows' `DraggableSidebarList` in its slot-snap mode, the one its playlist and
//! cover grid used: press and hold 180 ms and the item lifts, a quick click still
//! goes to the item, moving 10 px first lets the hold go. The held item never
//! leaves the run: it steps from slot to slot as the pointer reaches another item,
//! the others sliding out of its way, every move one glide from wherever it is
//! (FLIP). Letting go is one message with where it went; the app saves the order
//! and hands the items back in it, which is where they already sit.
//! A column, or rows of `across` (a grid), laid out as `column` / `row` would; or,
//! `sideways`, columns of `across` filled top to bottom, then left to right, as wide
//! as they reach (the music box's cover wall, scrolling sideways: his ask
//! 2026-11-08). The first `pinned` items stay put and nothing lands before them.

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Operation, Tree, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, overlay, renderer};
use iced::time::{Duration, Instant};
use iced::{Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, Vector, window};

use crate::motion::{self, Tween};

/// Windows' `HOLD_MS` and `MOVE_THRESHOLD`.
pub const HOLD: Duration = Duration::from_millis(180);
const SLIP: f32 = 10.0;
/// A step's glide: the rulebook's quick move. `GLIDE_TIME` is how long after a drop
/// moves still glide.
const GLIDE: motion::Motion = motion::SPATIAL_FAST;
const GLIDE_TIME: Duration = Duration::from_millis(300);

type OnLift<'a, Message> = Box<dyn Fn(usize) -> Message + 'a>;
type OnDrop<'a, Message> = Box<dyn Fn(usize, usize) -> Message + 'a>;

pub struct Reorder<'a, Message> {
    items: Vec<Element<'a, Message>>,
    across: usize,
    sideways: bool,
    spacing: f32,
    pinned: usize,
    /// An item lifted (its place in `items`); one let go: from, to (its slot).
    on_drag: Option<(OnLift<'a, Message>, OnDrop<'a, Message>)>,
}

impl<'a, Message> Reorder<'a, Message> {
    pub fn new(items: Vec<Element<'a, Message>>) -> Self {
        Self { items, across: 1, sideways: false, spacing: 0.0, pinned: 0, on_drag: None }
    }

    /// Rows of `n` side by side.
    pub fn across(mut self, n: usize) -> Self {
        self.across = n.max(1);
        self
    }

    /// Columns of `n` instead (`across`'s count), filled top to bottom.
    pub fn sideways(mut self, n: usize) -> Self {
        self.sideways = true;
        self.across(n)
    }

    pub fn spacing(mut self, spacing: f32) -> Self {
        self.spacing = spacing;
        self
    }

    pub fn pinned(mut self, n: usize) -> Self {
        self.pinned = n;
        self
    }

    /// Items lift only with these: told when one lifts, and where it went.
    pub fn on_drag(mut self, lift: impl Fn(usize) -> Message + 'a, drop: impl Fn(usize, usize) -> Message + 'a) -> Self {
        self.on_drag = Some((Box::new(lift), Box::new(drop)));
        self
    }
}

#[derive(Default)]
struct State {
    /// The item pressed, where and when: it lifts at `HOLD` unless the pointer slips.
    press: Option<(usize, Point, Instant)>,
    /// The item the press went down on, and whether a button inside it took the
    /// press: a release over another item is no click, nor one after a button's
    /// press (the button had its click; the item's own on release would fire too).
    down: Option<(usize, bool)>,
    held: Option<usize>,
    /// Slot to item while one is held; the items' own order otherwise.
    order: Vec<usize>,
    /// Each item's drawn place from the widget's corner, gliding to its laid-out one.
    spots: Vec<(Tween, Tween)>,
    /// Items a row at the last layout: a new count glides every item to its new slot.
    across: usize,
    /// Moves glide while one is held and until a drop's last glide ends; else jump.
    glide_until: Option<Instant>,
    /// Let go: the app's next build hands the items over in the new order.
    dropped: bool,
    now: Option<Instant>,
}

impl State {
    fn gliding(&self, now: Instant) -> bool {
        self.held.is_some() || self.glide_until.is_some_and(|t| now < t)
    }
}

/// Windows' `pickSlot` in slot-snap: the slot whose item is nearest the pointer, the
/// held one's measured to its box (not its centre), so a pointer between two
/// centres doesn't flip them at every wobble; only a nearer one takes it.
fn pick(order: &[usize], items: &[Rectangle], at: usize, p: Point, grid: bool, pinned: usize) -> usize {
    let measure = |dx: f32, dy: f32| if grid { dx * dx + dy * dy } else { dy.abs() };
    let outside = |v: f32, lo: f32, hi: f32| (lo - v).max(0.0).max(v - hi);
    let held = items[order[at]];
    let mut best = (at, measure(outside(p.x, held.x, held.x + held.width), outside(p.y, held.y, held.y + held.height)));
    for (slot, &item) in order.iter().enumerate().skip(pinned) {
        let r = items[item];
        let d = measure(p.x - r.center_x(), p.y - r.center_y());
        if slot != at && d < best.1 {
            best = (slot, d);
        }
    }
    best.0
}

impl<Message> iced::advanced::Widget<Message, Theme, Renderer> for Reorder<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn children(&self) -> Vec<Tree> {
        self.items.iter().map(Tree::new).collect()
    }

    fn diff(&self, tree: &mut Tree) {
        let s = tree.state.downcast_mut::<State>();
        // The items now come in the order they were let go in: their glides go with them.
        if std::mem::take(&mut s.dropped) {
            let order = std::mem::take(&mut s.order);
            if order.len() == s.spots.len() {
                let spots: Vec<(Tween, Tween)> = order.iter().map(|&i| s.spots[i]).collect();
                s.spots = spots;
            }
        }
        tree.diff_children(&self.items);
    }

    fn size(&self) -> Size<Length> {
        Size::new(if self.sideways { Length::Shrink } else { Length::Fill }, Length::Shrink)
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        let s = tree.state.downcast_mut::<State>();
        let n = self.items.len();
        // Items added at the end (a list built further as it scrolls) join behind,
        // a held one keeping its slot; any other change starts over.
        let had = s.order.len();
        if had < n {
            s.order.extend(had..n);
        } else if had != n {
            s.order = (0..n).collect();
        }
        let width = limits.max().width;
        let loose = layout::Limits::new(Size::ZERO, Size::new(width, f32::INFINITY));
        let mut nodes: Vec<layout::Node> = self.items.iter_mut().zip(&mut tree.children).map(|(item, t)| item.as_widget_mut().layout(t, renderer, &loose)).collect();
        // Each slot's item placed as a row of a column would: left to right, rows
        // as tall as their tallest; sideways, the same turned: top to bottom, columns
        // as wide as their widest.
        let turn = |p: Point| if self.sideways { Point::new(p.y, p.x) } else { p };
        let (mut y, mut long): (f32, f32) = (0.0, 0.0);
        for (r, slots) in s.order.chunks(self.across).enumerate() {
            if r > 0 {
                y += self.spacing;
            }
            let mut x = 0.0;
            let mut tall: f32 = 0.0;
            for &item in slots {
                let size = turn(Point::new(nodes[item].size().width, nodes[item].size().height));
                nodes[item].move_to_mut(turn(Point::new(x, y)));
                x += size.x + self.spacing;
                tall = tall.max(size.y);
            }
            long = long.max(x - self.spacing);
            y += tall;
        }
        let now = Instant::now();
        let gliding = s.gliding(now);
        // A new count a row (the cover wall widened or narrowed): the drop's glide.
        let regrid = s.across != self.across && !s.spots.is_empty();
        s.across = self.across;
        s.spots.truncate(n);
        for (i, node) in nodes.iter().enumerate() {
            let p = node.bounds().position();
            match s.spots.get_mut(i) {
                Some((x, y)) if gliding || regrid => {
                    x.go(p.x, now);
                    y.go(p.y, now);
                }
                // A glide under way rides along with a slot that moves as the items resize.
                Some((x, y)) if x.moving(now) || y.moving(now) => {
                    x.follow(p.x);
                    y.follow(p.y);
                }
                Some((x, y)) => {
                    x.set(p.x);
                    y.set(p.y);
                }
                None => s.spots.push((Tween::new(p.x, GLIDE), Tween::new(p.y, GLIDE))),
            }
        }
        let size = if self.sideways { limits.resolve(Length::Shrink, Length::Shrink, Size::new(y, long.max(0.0))) } else { limits.resolve(Length::Fill, Length::Shrink, Size::new(width, y)) };
        layout::Node::with_children(size, nodes)
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn Operation) {
        operation.container(None, layout.bounds());
        operation.traverse(&mut |operation| {
            for ((item, t), l) in self.items.iter_mut().zip(&mut tree.children).zip(layout.children()) {
                item.as_widget_mut().operate(t, l, renderer, operation);
            }
        });
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, renderer: &Renderer, clipboard: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        let now = match event {
            Event::Window(window::Event::RedrawRequested(now)) => *now,
            _ => Instant::now(),
        };
        s.now = Some(now);
        let items: Vec<Rectangle> = layout.children().map(|l| l.bounds()).collect();
        let over = |p: Point| items.iter().position(|r| r.contains(p));
        let movable = self.on_drag.is_some();
        // A release with no press on an item (something dragged here from elsewhere,
        // as a file onto a pinned folder) is no click: the items don't hear it. Not
        // taken, so the rest of the window still does.
        let mut deaf = false;
        match event {
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                let down = s.down.take();
                s.press = None;
                if let Some(item) = s.held.take() {
                    // The drop: no click goes to the item under it.
                    let to = s.order.iter().position(|&i| i == item).unwrap_or(item);
                    if let Some((_, drop)) = &self.on_drag {
                        shell.publish(drop(item, to));
                    }
                    s.dropped = true;
                    s.glide_until = Some(now + GLIDE_TIME);
                    shell.capture_event();
                    shell.request_redraw();
                    return;
                }
                // A click is a press and a release on one item, the press its own.
                if movable
                    && let Some((item, taken)) = down
                    && (taken || cursor.position().and_then(over) != Some(item))
                {
                    shell.capture_event();
                    return;
                }
                deaf = movable && down.is_none();
            }
            Event::Mouse(mouse::Event::CursorMoved { .. }) => {
                let p = cursor.position();
                if let (Some((_, at, _)), Some(p)) = (s.press, p)
                    && at.distance(p) > SLIP
                {
                    s.press = None;
                }
                if let (Some(item), Some(p)) = (s.held, p)
                    && let Some(at) = s.order.iter().position(|&i| i == item)
                {
                    let to = pick(&s.order, &items, at, p, self.across > 1 || self.sideways, self.pinned);
                    if to != at {
                        s.order.remove(at);
                        s.order.insert(to, item);
                        shell.invalidate_layout();
                        shell.request_redraw();
                    }
                }
            }
            _ => {}
        }
        for ((item, t), l) in self.items.iter_mut().zip(&mut tree.children).zip(layout.children()).filter(|_| !deaf) {
            item.as_widget_mut().update(t, event, l, cursor, renderer, clipboard, shell, viewport);
        }
        let s = tree.state.downcast_mut::<State>();
        // A press nothing inside took (a button in an item takes its own) starts the hold.
        if let Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) = event
            && movable
            && let Some(p) = cursor.position_over(layout.bounds())
            && let Some(item) = over(p)
        {
            let taken = shell.is_event_captured();
            s.down = Some((item, taken));
            if !taken && item >= self.pinned {
                s.press = Some((item, p, now));
            }
        }
        if let Some((item, _, at)) = s.press {
            if now >= at + HOLD {
                s.press = None;
                s.held = Some(item);
                if let Some((lift, _)) = &self.on_drag {
                    shell.publish(lift(item));
                }
                shell.request_redraw();
            } else {
                shell.request_redraw_at(at + HOLD);
            }
        }
        if s.spots.iter().any(|(x, y)| x.moving(now) || y.moving(now)) {
            shell.request_redraw();
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        if tree.state.downcast_ref::<State>().held.is_some() {
            return mouse::Interaction::Grabbing;
        }
        self.items.iter().zip(&tree.children).zip(layout.children()).map(|((item, t), l)| item.as_widget().mouse_interaction(t, l, cursor, viewport, renderer)).max().unwrap_or_default()
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout<'_>, cursor: mouse::Cursor, viewport: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        let now = s.now.unwrap_or_else(Instant::now);
        let corner = layout.bounds().position();
        let moving = s.gliding(now);
        let places: Vec<Layout<'_>> = layout.children().collect();
        let draw = |i: usize, renderer: &mut Renderer| {
            let (Some(item), Some(t), Some(l)) = (self.items.get(i), tree.children.get(i), places.get(i).copied()) else { return };
            let b = l.bounds();
            // Gliding, on whole pixels (the CPU renderer repaints a shape's exact bounds,
            // so a part-covered edge pixel would stay behind as a line); at rest, its own.
            let shift = match s.spots.get(i) {
                Some((x, y)) if moving || x.moving(now) || y.moving(now) => Vector::new((corner.x + x.value(now)).round() - b.x, (corner.y + y.value(now)).round() - b.y),
                _ => Vector::ZERO,
            };
            if !(b + shift).intersects(viewport) {
                return;
            }
            renderer.with_translation(shift, |renderer| item.as_widget().draw(t, renderer, theme, style, l, cursor, viewport));
        };
        // The held item over the rest.
        for i in (0..self.items.len()).filter(|&i| s.held != Some(i)) {
            draw(i, renderer);
        }
        if let Some(i) = s.held {
            draw(i, renderer);
        }
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout<'b>, renderer: &Renderer, viewport: &Rectangle, translation: Vector) -> Option<overlay::Element<'b, Message, Theme, Renderer>> {
        overlay::from_children(&mut self.items, tree, layout, renderer, viewport, translation)
    }
}

impl<'a, Message: 'a> From<Reorder<'a, Message>> for Element<'a, Message> {
    fn from(r: Reorder<'a, Message>) -> Self {
        Element::new(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Rectangle> {
        (0..4).map(|i| Rectangle { x: 0.0, y: i as f32 * 40.0, width: 100.0, height: 40.0 }).collect()
    }

    #[test]
    fn pick_keeps_the_held_slot_until_another_item_is_nearer() {
        let (order, items) = ([0, 1, 2, 3], rows());
        // Still inside the held row's box: it stays, however near the next centre.
        assert_eq!(pick(&order, &items, 1, Point::new(50.0, 79.0), false, 0), 1);
        // 15 past its box, 5 from the next row's centre: that slot takes it.
        assert_eq!(pick(&order, &items, 1, Point::new(50.0, 95.0), false, 0), 2);
    }

    #[test]
    fn pick_never_lands_before_a_pinned_item() {
        let (order, items) = ([0, 1, 2, 3], rows());
        assert_eq!(pick(&order, &items, 2, Point::new(50.0, 20.0), false, 0), 0);
        assert_eq!(pick(&order, &items, 2, Point::new(50.0, 20.0), false, 1), 1);
    }
}
