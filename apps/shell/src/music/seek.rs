//! The main page's seek bar (Music Tab Redesign step 3), moved from the shell's Media
//! tab (`git show 12a8e104:apps/shell/src/media.rs`, Windows' `.dash-seek`): the
//! time, the groove, the length, Muted. Pressed on the groove it is held and dragged,
//! the song jumping there on release. While a song plays it asks its own redraw at
//! the clock's next second, no message. The times at the artist's size under the
//! song's title (his ask 2026-11-06).

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use iced::advanced::layout::{self, Layout};
use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, renderer};
use iced::alignment::Vertical;
use iced::time::Instant;
use iced::{Element, Event, Length, Pixels, Point, Rectangle, Renderer, Size, Theme, window};
use mp_ui::bar::SLOT;
use mp_ui::colours::Colours;
use mp_ui::style::{BODY, GAP_3, LINE_TIGHT, SMALL};

use crate::music::now::{self, Command, Now};

/// The groove: Noctalia's media tab slider (`media_tab.cpp` `trackHeight` 7;
/// `lib/ui/controls/slider.cpp`: the track `OutlineVariant` (our `border`), the played
/// part `Primary`; Noctalia Look step 6). No knob (his ask 2026-11-08: "remove the
/// dot"), and square as everything else (his ask 2026-11-08: "sharp corners", over
/// Noctalia's round ends).
const GROOVE: f32 = 7.0;

/// The row's height: one line of body text (the times drawn smaller in it, so the
/// playing box keeps its size).
pub const ROW: f32 = (BODY * LINE_TIGHT).round();

/// The times' size: the playing artist's.
const SIZE: f32 = SMALL;

fn line<T>(content: T, bounds: Size, align_x: text::Alignment) -> text::Text<T> {
    text::Text { content, bounds, size: Pixels(SIZE), line_height: LINE_TIGHT.into(), font: mp_ui::MEDIUM, align_x, align_y: Vertical::Center, shaping: text::Shaping::Advanced, wrapping: text::Wrapping::None }
}

/// The font, for its digits' widths and the blank before each drawing.
static FACE: LazyLock<ttf_parser::Face<'static>> = LazyLock::new(|| ttf_parser::Face::parse(mp_ui::FONT_TTF, 0).expect("bundled font"));

/// A letter's width and the blank before its drawing, at the times' size.
fn metrics(c: char) -> (f32, f32) {
    let f = &*FACE;
    let px = |units: Option<i32>| units.unwrap_or(0) as f32 * SIZE / f.units_per_em() as f32;
    let g = f.glyph_index(c);
    (px(g.and_then(|g| f.glyph_hor_advance(g)).map(i32::from)), px(g.and_then(|g| f.glyph_hor_side_bearing(g)).map(i32::from)))
}

/// The font's widest digit (Rubik's digits differed, a 1 7 px wide at body size, an 8 11;
/// Ioskeley Mono's are one width, so this is its first).
static WIDEST: LazyLock<char> = LazyLock::new(|| ('0'..='9').max_by(|a, b| metrics(*a).0.total_cmp(&metrics(*b).0)).unwrap_or('0'));

/// Room for either time of a song `length` long: its length's shape in the widest
/// digit, so no time of the song spills out and none leaves more than a digit's
/// difference free (Malthaiel's ask 2026-11-04: the left time flush with the box's
/// edge, as the cover is on the right). No length known: "99:59", the shell's
/// Media tab's room.
fn times(length: f64) -> f32 {
    // Kept for the song playing: it was shaped again on every mouse move, draw and
    // cursor check.
    static LAST: Mutex<Option<(u64, f32)>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, wide)) = last.filter(|(l, _)| *l == length.to_bits()) {
        return wide;
    }
    let wide = shape_times(length);
    *last = Some((length.to_bits(), wide));
    wide
}

fn shape_times(length: f64) -> f32 {
    let longest = if length > 0.0 { length } else { 5999.0 };
    let shape: String = clock(longest).chars().map(|c| if c.is_ascii_digit() { *WIDEST } else { c }).collect();
    let wide = <Renderer as text::Renderer>::Paragraph::with_text(line(shape.as_str(), Size::INFINITE, text::Alignment::Left)).min_width();
    (wide + 1.0).ceil()
}

/// The blank under the times' numbers in the row, from the font's own cap height (the
/// shell clock's `figure_blank`), whole pixels: what the playing box adds over the
/// row so the numbers' ink sits as far off its bottom as the buttons' track is off
/// its top (Malthaiel's ask 2026-11-04).
pub fn below() -> f32 {
    let f = &*FACE;
    let cap = f.capital_height().unwrap_or(f.ascender()) as f32 / f.units_per_em() as f32;
    ((ROW - SIZE * LINE_TIGHT) / 2.0 + SIZE * (LINE_TIGHT - cap) / 2.0).round()
}

/// `m:ss`, or `h:mm:ss` past an hour.
pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

/// The groove between the two times.
fn groove(b: Rectangle, times: f32) -> Rectangle {
    let x = b.x + times + GAP_3;
    Rectangle::new(Point::new(x, (b.center_y() - GROOVE / 2.0).round()), Size::new((b.width - 2.0 * (times + GAP_3)).max(0.0), GROOVE))
}

fn quad(bounds: Rectangle) -> renderer::Quad {
    renderer::Quad { bounds, ..Default::default() }
}

pub struct Seek<'a> {
    now: &'a Now,
    colours: Colours,
}

pub fn seek<'a, Message: 'a>(now: &'a Now, colours: Colours) -> Element<'a, Message> {
    Element::new(Seek { now, colours })
}

/// Where it is held, in seconds.
#[derive(Default)]
struct State {
    held: Option<f64>,
}

impl Seek<'_> {
    fn can_seek(&self) -> bool {
        self.now.loaded() && self.now.length > 0.0
    }
}

impl<Message> Widget<Message, Theme, Renderer> for Seek<'_> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fixed(ROW))
    }

    fn layout(&mut self, _: &mut Tree, _: &Renderer, limits: &layout::Limits) -> layout::Node {
        layout::Node::new(limits.resolve(Length::Fill, Length::Fixed(ROW), Size::ZERO))
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, _: &Renderer, _: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, _: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        let b = layout.bounds();
        let length = self.now.length;
        let g = groove(b, times(length));
        let to = |p: Point| ((p.x - g.x) / g.width.max(1.0)).clamp(0.0, 1.0) as f64 * length;
        match event {
            Event::Window(window::Event::RedrawRequested(at)) if self.now.playing && s.held.is_none() => {
                let pos = self.now.position(*at);
                shell.request_redraw_at(*at + Duration::from_secs_f64((pos.floor() + 1.0 - pos).max(0.01)));
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) if self.can_seek() => {
                if let Some(p) = cursor.position_over(Rectangle { y: b.y, height: b.height, ..g }) {
                    s.held = Some(to(p));
                    shell.capture_event();
                    shell.request_redraw();
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) if s.held.is_some() => {
                s.held = Some(to(*position));
                shell.request_redraw();
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                if let Some(to) = s.held.take() {
                    now::send(Command::Seek(to));
                    shell.capture_event();
                    shell.request_redraw();
                }
            }
            _ => {}
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, _: &Theme, _: &renderer::Style, layout: Layout<'_>, _: mouse::Cursor, _: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        let c = &self.colours;
        let b = layout.bounds();
        let times = times(self.now.length);
        let pos = s.held.unwrap_or_else(|| self.now.position(Instant::now()));
        let (from, to) = if self.now.loaded() { (clock(pos), clock(self.now.length)) } else { (clock(0.0), clock(0.0)) };
        let room = Size::new(times, b.height);
        // The time played starts at the row's left end, its drawing flush with it.
        let lead = from.chars().next().map_or(0.0, |c| metrics(c).1);
        renderer.fill_text(line(from, room, text::Alignment::Left), Point::new(b.x - lead, b.center_y()), c.text_muted, b);
        renderer.fill_text(line(to, room, text::Alignment::Left), Point::new(b.x + b.width - times, b.center_y()), c.text_muted, b);
        let g = groove(b, times);
        renderer.fill_quad(quad(g), c.border);
        if self.now.length > 0.0 {
            let fill = (g.width * (pos / self.now.length).clamp(0.0, 1.0) as f32).round();
            if fill > 0.0 {
                renderer.fill_quad(quad(Rectangle { width: fill, ..g }), c.accent);
            }
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, _: &Rectangle, _: &Renderer) -> mouse::Interaction {
        let b = layout.bounds();
        let g = groove(b, times(self.now.length));
        let held = tree.state.downcast_ref::<State>().held.is_some();
        if held || (self.can_seek() && cursor.is_over(Rectangle { y: b.y, height: b.height, ..g })) { mouse::Interaction::Pointer } else { mouse::Interaction::None }
    }
}

/// The volume line's length: Spotify's (its volume bar's groove, 93 on a photo of the
/// app, 2026-11-08).
const VOLUME: f32 = 93.0;

/// The playing bar's volume at its far right (his ask 2026-11-08, Spotify's): the
/// seek bar's groove, the player's volume filled in `accent`, as tall as a bar button
/// to grab. Pressed it jumps there and follows the held pointer, each move sent
/// (Spotify's).
pub struct Volume<Message> {
    volume: f64,
    colours: Colours,
    on_change: fn(f64) -> Message,
}

pub fn volume<'a, Message: 'a>(volume: f64, colours: Colours, on_change: fn(f64) -> Message) -> Element<'a, Message> {
    Element::new(Volume { volume, colours, on_change })
}

/// Pressed and not yet let go.
#[derive(Default)]
struct Held(bool);

/// The volume under `x`.
fn share(b: Rectangle, x: f32) -> f64 {
    ((x - b.x) / b.width.max(1.0)).clamp(0.0, 1.0) as f64
}

impl<Message> Widget<Message, Theme, Renderer> for Volume<Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<Held>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(Held::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fixed(VOLUME), Length::Fixed(SLOT))
    }

    fn layout(&mut self, _: &mut Tree, _: &Renderer, limits: &layout::Limits) -> layout::Node {
        layout::Node::new(limits.resolve(Length::Fixed(VOLUME), Length::Fixed(SLOT), Size::ZERO))
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, _: &Renderer, _: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, _: &Rectangle) {
        let held = &mut tree.state.downcast_mut::<Held>().0;
        let b = layout.bounds();
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                if let Some(p) = cursor.position_over(b) {
                    *held = true;
                    shell.publish((self.on_change)(share(b, p.x)));
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) if *held => shell.publish((self.on_change)(share(b, position.x))),
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) if *held => {
                *held = false;
                shell.capture_event();
            }
            _ => {}
        }
    }

    fn draw(&self, _: &Tree, renderer: &mut Renderer, _: &Theme, _: &renderer::Style, layout: Layout<'_>, _: mouse::Cursor, _: &Rectangle) {
        let b = layout.bounds();
        let g = Rectangle::new(Point::new(b.x, (b.center_y() - GROOVE / 2.0).round()), Size::new(b.width, GROOVE));
        renderer.fill_quad(quad(g), self.colours.border);
        let fill = (g.width * self.volume.clamp(0.0, 1.0) as f32).round();
        if fill > 0.0 {
            renderer.fill_quad(quad(Rectangle { width: fill, ..g }), self.colours.accent);
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, _: &Rectangle, _: &Renderer) -> mouse::Interaction {
        if tree.state.downcast_ref::<Held>().0 || cursor.is_over(layout.bounds()) { mouse::Interaction::Pointer } else { mouse::Interaction::None }
    }
}
