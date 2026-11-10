//! The big box's Lyrics (Music Tab Redesign step 3): the playing song's words, moved
//! from the shell's Media tab (`git show 12a8e104:apps/shell/src/media.rs`, Windows'
//! `LyricList` in `LyricsPanel.jsx`): timed lines Muted, the sung one on the accent
//! pill in On Accent (the pill sliding to the next), a hovered one Text, each line's
//! colour easing; a click on a timed line jumps there; the wheel over words that
//! overflow scrolls them; plain words in Text. Both ends fade into the box's Panel.
//! It asks its own redraw at the next line's start, no message.

use std::time::Duration;

use iced::advanced::layout::{self, Layout};
use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell, mouse, renderer};
use iced::alignment::Vertical;
use iced::gradient::Linear;
use iced::time::Instant;
use iced::{Background, Color, Element, Event, Length, Pixels, Point, Radians, Rectangle, Renderer, Size, Theme, border, window};
use mp_ui::colours::Colours;
use mp_ui::motion::{self, Tween};
use mp_ui::style::{BODY, GAP_1, GAP_3, LINE};

use crate::music::now::{self, Command, Now};
use crate::music::words::{Line, Words};

/// The words' state mark (Windows' `LyricsState` dot).
const DOT: f32 = 7.0;
/// A line of words: Windows' `.lyric-line` padding 4 / 12.
const PAD: Size = Size::new(GAP_3, GAP_1);

fn words_text<T>(content: T, width: f32) -> text::Text<T> {
    text::Text {
        content,
        bounds: Size::new((width - 2.0 * PAD.width).max(1.0), f32::INFINITY),
        size: Pixels(BODY),
        line_height: LINE.into(),
        font: mp_ui::MEDIUM,
        align_x: text::Alignment::Left,
        align_y: Vertical::Top,
        shaping: text::Shaping::Advanced,
        wrapping: text::Wrapping::Word,
    }
}

fn quad(bounds: Rectangle, radius: f32) -> renderer::Quad {
    renderer::Quad { bounds, border: border::rounded(radius), ..Default::default() }
}

fn shade(c: Color, a: f32) -> Color {
    Color { a: c.a * a, ..c }
}

pub struct Lyrics<'a> {
    words: Option<&'a Words>,
    /// The playing song; none with nothing loaded.
    now: Option<&'a Now>,
    colours: Colours,
}

pub fn lyrics<'a, Message: 'a>(words: Option<&'a Words>, now: Option<&'a Now>, colours: Colours) -> Element<'a, Message> {
    Element::new(Lyrics { words, now, colours })
}

struct State {
    /// The words laid out: which words (their list's address) at which width, each
    /// line's top, height and text width, and the whole run's height.
    laid: (usize, f32, Vec<(f32, f32, f32)>, f32),
    scroll: Tween,
    sung: Option<usize>,
    /// The sung line's pill: top, width, height, shown.
    lit: [Tween; 4],
    /// Each line's colour: how far on the pill (On Accent) and under the pointer (Text).
    glow: Vec<[Tween; 2]>,
    hover: Option<usize>,
    now: Instant,
}

impl Lyrics<'_> {
    fn lines(&self) -> &[Line] {
        match self.words {
            Some(Words::Lines(l)) if self.now.is_some() => l,
            _ => &[],
        }
    }

    fn synced(&self) -> bool {
        self.lines().iter().any(|l| l.time.is_some())
    }

    /// The line being sung at `pos`.
    fn sung(&self, pos: f64) -> Option<usize> {
        self.lines().iter().rposition(|l| l.time.is_some_and(|t| t <= pos)).filter(|_| self.synced())
    }

    /// Lays the words out once per set of words and width.
    fn lay(&self, s: &mut State, width: f32) {
        let lines = self.lines();
        let id = lines.as_ptr() as usize;
        if s.laid.0 == id && s.laid.1 == width && s.laid.2.len() == lines.len() {
            return;
        }
        let synced = self.synced();
        let mut y = if synced { GAP_3 } else { 0.0 };
        let laid = lines
            .iter()
            .map(|l| {
                let b = <Renderer as text::Renderer>::Paragraph::with_text(words_text(if l.text.is_empty() { " " } else { l.text.as_str() }, width)).min_bounds();
                // An empty line is its padding alone: Windows' lone space collapses.
                let h = if l.text.is_empty() { 2.0 * PAD.height } else { (b.height + 2.0 * PAD.height).round() };
                let top = y;
                y += h;
                (top, h, if l.text.is_empty() { width } else { (b.width + 2.0 * PAD.width).ceil().min(width) })
            })
            .collect();
        s.laid = (id, width, laid, y + if synced { GAP_3 } else { 0.0 });
        s.glow = lines.iter().map(|_| [Tween::new(0.0, motion::SPATIAL), Tween::new(0.0, motion::SPATIAL)]).collect();
        (s.sung, s.hover) = (None, None);
        s.scroll.set(0.0);
        s.lit[3].set(0.0);
    }

    /// The scroll that centres line `i` in the box.
    fn centre(s: &State, i: usize, room: f32) -> f32 {
        let (top, h, _) = s.laid.2[i];
        (top + h / 2.0 - room / 2.0).clamp(0.0, (s.laid.3 - room).max(0.0))
    }

    /// The timed line under `a`.
    fn line_at(&self, s: &State, b: Rectangle, a: Point) -> Option<usize> {
        if !self.synced() || !b.contains(a) {
            return None;
        }
        let y = a.y - b.y + s.scroll.value(s.now);
        s.laid.2.iter().position(|&(top, h, w)| (top..top + h).contains(&y) && a.x - b.x < w).filter(|i| self.lines()[*i].time.is_some())
    }
}

impl<Message> Widget<Message, Theme, Renderer> for Lyrics<'_> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        let t = |m| Tween::new(0.0, m);
        tree::State::new(State {
            laid: (0, 0.0, Vec::new(), 0.0),
            scroll: t(motion::SPATIAL),
            sung: None,
            lit: [t(motion::SPATIAL), t(motion::SPATIAL), t(motion::SPATIAL), t(motion::EFFECTS)],
            glow: Vec::new(),
            hover: None,
            now: Instant::now(),
        })
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn layout(&mut self, tree: &mut Tree, _: &Renderer, limits: &layout::Limits) -> layout::Node {
        let size = limits.resolve(Length::Fill, Length::Fill, Size::ZERO);
        self.lay(tree.state.downcast_mut::<State>(), size.width);
        layout::Node::new(size)
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout<'_>, cursor: mouse::Cursor, _: &Renderer, _: &mut dyn Clipboard, shell: &mut Shell<'_, Message>, _: &Rectangle) {
        let s = tree.state.downcast_mut::<State>();
        let b = layout.bounds();
        self.lay(s, b.width);
        match event {
            Event::Window(window::Event::RedrawRequested(at)) => {
                s.now = *at;
                let pos = self.now.map_or(0.0, |p| p.position(*at));
                // The sung line moves on: its pill follows and the words scroll to it.
                let sung = self.sung(pos);
                if sung != s.sung {
                    for (i, to) in [(s.sung, 0.0), (sung, 1.0)] {
                        if let Some(g) = i.and_then(|i| s.glow.get_mut(i)) {
                            g[0].go(to, *at);
                        }
                    }
                    s.sung = sung;
                    match sung {
                        Some(i) => {
                            let (top, h, w) = s.laid.2[i];
                            let first = s.lit[3].value(*at) < 0.01;
                            for (t, v) in s.lit.iter_mut().zip([top, w, h]) {
                                if first { t.set(v) } else { t.go(v, *at) }
                            }
                            s.lit[3].go(1.0, *at);
                            let to = Self::centre(s, i, b.height);
                            s.scroll.go(to, *at);
                        }
                        None => s.lit[3].go(0.0, *at),
                    }
                }
                let moving = [s.scroll].iter().chain(&s.lit).chain(s.glow.iter().flatten()).any(|t| t.moving(*at));
                if moving {
                    shell.request_redraw();
                } else if self.now.is_some_and(|p| p.playing)
                    && let Some(t) = self.lines().iter().filter_map(|l| l.time).find(|t| *t > pos)
                {
                    shell.request_redraw_at(*at + Duration::from_secs_f64((t - pos).max(0.01)));
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { .. } | mouse::Event::CursorLeft) => {
                let hover = cursor.position().and_then(|a| self.line_at(s, b, a));
                if hover != s.hover {
                    for (i, to) in [(s.hover, 0.0), (hover, 1.0)] {
                        if let Some(g) = i.and_then(|i| s.glow.get_mut(i)) {
                            g[1].go(to, Instant::now());
                        }
                    }
                    s.hover = hover;
                    shell.request_redraw();
                }
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                if let Some(t) = cursor.position().and_then(|a| self.line_at(s, b, a)).and_then(|i| self.lines()[i].time) {
                    now::send(Command::Seek(t));
                    shell.capture_event();
                }
            }
            // Words that overflow scroll (Windows' `onWheel`); the next sung line takes
            // them back. The wheel comes in pixels (`mp_ui::scroll::smooth`).
            Event::Mouse(mouse::Event::WheelScrolled { delta }) if cursor.is_over(b) && s.laid.3 > b.height => {
                let step = match *delta {
                    mouse::ScrollDelta::Lines { y, .. } => y * (BODY * LINE + 2.0 * PAD.height),
                    mouse::ScrollDelta::Pixels { y, .. } => y,
                };
                let to = (s.scroll.value(Instant::now()) - step).clamp(0.0, s.laid.3 - b.height);
                s.scroll.set(to);
                shell.capture_event();
                shell.request_redraw();
            }
            _ => {}
        }
    }

    /// Every line even partly in the box is drawn, cut at its edges, in a layer of the
    /// box and the part shown (a nested layer replaces the outer clip, so it takes
    /// both). Then the mask, over the words too: both ends clear, solid 12% in.
    fn draw(&self, tree: &Tree, renderer: &mut Renderer, _: &Theme, _: &renderer::Style, layout: Layout<'_>, _: mouse::Cursor, viewport: &Rectangle) {
        let s = tree.state.downcast_ref::<State>();
        let c = &self.colours;
        let b = layout.bounds();
        let Some(cut) = b.intersection(viewport) else { return };
        let now = Instant::now();
        let lines = self.lines();
        if lines.is_empty() {
            let (words, colour) = match (self.now, self.words) {
                (None, _) => ("Nothing playing", c.text_muted),
                (_, Some(Words::None)) => ("No words for this song", c.text_faint),
                (_, Some(Words::Failed)) => ("Couldn't get the words", c.text),
                _ => ("Finding words", c.text_muted),
            };
            let d = Rectangle::new(Point::new((b.center_x() - DOT / 2.0).round(), b.y + GAP_3), Size::new(DOT, DOT));
            renderer.fill_quad(quad(d, DOT / 2.0), shade(c.text_faint, 0.5));
            let t = text::Text { align_x: text::Alignment::Center, wrapping: text::Wrapping::None, ..words_text(words.to_string(), b.width) };
            renderer.fill_text(t, Point::new(b.center_x(), d.y + DOT + GAP_3), colour, b);
            return;
        }
        let synced = self.synced();
        let scroll = s.scroll.value(now).round();
        let out = |y: f32, h: f32| y + h <= b.y || y >= b.y + b.height;
        renderer.with_layer(cut, |renderer| {
            let lit = s.lit[3].value(now).clamp(0.0, 1.0);
            if synced && lit > 0.0 {
                let (top, w, h) = (s.lit[0].value(now), s.lit[1].value(now), s.lit[2].value(now));
                let pill = Rectangle::new(Point::new(b.x, (b.y + top - scroll).round()), Size::new(w.round(), h.round()));
                if !out(pill.y, pill.height) {
                    renderer.fill_quad(quad(pill, pill.height.min(pill.width) / 2.0), shade(c.accent, lit));
                }
            }
            for (i, (line, &(top, h, _))) in lines.iter().zip(&s.laid.2).enumerate() {
                let y = b.y + top - scroll;
                if line.text.is_empty() || out(y, h) {
                    continue;
                }
                let at = Point::new(b.x + PAD.width, y + PAD.height);
                // A clip reaching past the layer, so the layer cuts the words
                // (iced_tiny_skia masks a text only when its clip isn't inside).
                let say = |renderer: &mut Renderer, colour: Color, a: f32| renderer.fill_text(words_text(line.text.clone(), b.width), at, shade(colour, a), *viewport);
                if !synced {
                    say(renderer, c.text, 1.0);
                    continue;
                }
                // The colour eased by opacity (the glyph cache keys by colour): the last
                // colour fully there drawn whole, the ones over it as far as they came.
                let [on, lift] = s.glow.get(i).map_or([0.0; 2], |g| [g[0].value(now), g[1].value(now)]);
                let layers = [(c.text_muted, 1.0), (c.text, lift), (c.on_accent, on)];
                let base = layers.iter().rposition(|&(_, a)| a >= 0.999).unwrap_or(0);
                for &(colour, a) in &layers[base..] {
                    if a > 0.001 {
                        say(renderer, colour, if a >= 0.999 { 1.0 } else { a });
                    }
                }
            }
        });
        // The mask: the box's Panel over both ends, solid at the edge, clear 12% in.
        let band = (0.12 * b.height).round();
        renderer.with_layer(cut, |renderer| {
            for (r, (edge, inner)) in [(Rectangle::new(b.position(), Size::new(b.width, band)), (1.0, 0.0)), (Rectangle::new(Point::new(b.x, b.y + b.height - band), Size::new(b.width, band)), (0.0, 1.0))] {
                let fade = Linear::new(Radians(std::f32::consts::PI)).add_stop(0.0, shade(c.panel, edge)).add_stop(1.0, shade(c.panel, inner));
                renderer.fill_quad(renderer::Quad { bounds: r, ..Default::default() }, Background::Gradient(fade.into()));
            }
        });
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout<'_>, cursor: mouse::Cursor, _: &Rectangle, _: &Renderer) -> mouse::Interaction {
        let s = tree.state.downcast_ref::<State>();
        match cursor.position().and_then(|a| self.line_at(s, layout.bounds(), a)) {
            Some(_) => mouse::Interaction::Pointer,
            None => mouse::Interaction::None,
        }
    }
}
