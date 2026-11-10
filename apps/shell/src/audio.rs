//! The speaker's sound box (his pick 2026-10-30: Windows' sound pop-out): Windows'
//! `web/src/components/chrome/AudioPop.jsx` 1-1 (itself Caelestia's
//! `modules/bar/popouts/AudioPopout.qml`), held to the rulebook (`style.rs`).
//! "Output device" and "Input device" pick lists (Windows' `RadioButton`, a pick
//! makes that device the one everything uses), the volume heading and Windows' flat
//! slider (`Slider flat`, the wheel 10%), here up to 150% (`sound::MAX`, his call
//! 2026-10-30). Windows' "Open settings" is left out: no
//! Settings app yet. What it shows comes from `sound.rs`; picks and the slider set it there.

use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::{Renderer as _, mouse, renderer};
use iced::alignment::Vertical;
use iced::border::Radius;
use iced::time::Instant;
use iced::{Border, Color, Event, Pixels, Point, Rectangle, Renderer, Size};

use crate::colours::Colours;
use crate::menu::{Body, Reply};
use crate::motion::{self, Tween};
use crate::sound::{self, Sound};
use crate::style::{self, GAP_3};

/// Windows' box width, a quarter larger with everything else (his call
/// 2026-10-30, was 320); a longer name ends in "..." (Windows' `text-overflow:
/// ellipsis`, his pick 2026-10-30; iced cuts none itself, so `fit` does).
pub const WIDTH: f32 = 400.0;
/// The ring (Caelestia's `StyledRadioButton`, Windows' `.c-radio-ring`): Windows'
/// 20 across, 8 dot, 10 halo past it each side, grown with the rest (his call
/// 2026-10-30) to 24 / 10 / 12; a 2 line.
const RING: f32 = 24.0;
const LINE: f32 = 2.0;
const DOT: f32 = 10.0;
const HALO: f32 = 12.0;
/// The slider's height: a control's (Windows' 36, now the rulebook's too).
const BAR: f32 = style::CONTROL;
/// The wheel's step (Caelestia's `audioIncrement`).
pub const WHEEL: f32 = 0.1;

/// The flat slider's handle stands taller than its bar, more while held: Caelestia's
/// formula on the bar's height, as Windows' `FlatSlider`.
fn handle(held: bool) -> f32 {
    let t = ((BAR - 12.0) / 16.0).clamp(0.0, 1.0);
    if held { BAR * (3.5 - 2.0 * t) } else { BAR * (3.0 - 1.8 * t) }
}

/// The box's parts, top to bottom.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Part {
    Head(usize),
    /// A device: in the microphones' list or not, its place.
    Choice(bool, usize),
    Bar,
}

/// Each part with its top and height: Windows' column, 12 padding at top and
/// bottom, 12 between parts, the second and third headings 12 further down.
fn parts(outputs: usize, inputs: usize) -> Vec<(Part, f32, f32)> {
    let mut list = vec![(Part::Head(0), 0.0)];
    list.extend((0..outputs).map(|i| (Part::Choice(false, i), 0.0)));
    list.push((Part::Head(1), GAP_3));
    list.extend((0..inputs).map(|i| (Part::Choice(true, i), 0.0)));
    list.extend([(Part::Head(2), GAP_3), (Part::Bar, 0.0)]);
    let mut y = 0.0;
    list.into_iter()
        .map(|(part, margin)| {
            let top = y + GAP_3 + margin;
            let height = match part {
                Part::Head(_) => (style::BODY * style::LINE_TIGHT).round(),
                Part::Choice(..) => RING,
                Part::Bar => BAR,
            };
            y = top + height;
            (part, top, height)
        })
        .collect()
}

/// The box's height inside the menu's padding.
pub fn height(s: &Sound) -> f32 {
    parts(s.outputs.len(), s.inputs.len()).last().map_or(0.0, |(_, top, h)| top + h) + GAP_3
}

fn words<T>(content: T, size: f32, bounds: Size) -> text::Text<T> {
    text::Text { content, bounds, size: Pixels(size), line_height: style::LINE_TIGHT.into(), font: crate::BOLD, align_x: text::Alignment::Left, align_y: Vertical::Center, shaping: text::Shaping::Basic, wrapping: text::Wrapping::None }
}

fn width(content: &str) -> f32 {
    <Renderer as text::Renderer>::Paragraph::with_text(words(content, style::SMALL, Size::INFINITE)).min_width()
}

/// `name` as it fits `room` by `width`'s measure: whole, or as many letters as fit
/// before Rubik's "...".
pub fn fit(name: &str, room: f32, mut width: impl FnMut(&str) -> f32) -> String {
    if width(name) <= room {
        return name.into();
    }
    let cut = |keep: usize| format!("{}\u{2026}", name.chars().take(keep).collect::<String>().trim_end());
    let (mut lo, mut hi) = (0, name.chars().count());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if width(&cut(mid)) <= room { lo = mid } else { hi = mid - 1 }
    }
    cut(lo)
}

fn quad(bounds: Rectangle, radius: impl Into<Radius>) -> renderer::Quad {
    renderer::Quad { bounds, border: Border { radius: radius.into(), ..Default::default() }, ..Default::default() }
}

fn mix(a: Color, b: Color, t: f32) -> Color {
    Color { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t }
}

pub struct Audio {
    pub sound: Sound,
    pub colours: Colours,
}

pub struct State {
    /// Each device's name, and as it shows (`fit`), made again when the names change.
    names: Vec<(String, String)>,
    hovered: Option<Part>,
    /// The ring under the pointer, the last one the halo was on, and its fade.
    ring: Option<Part>,
    halo_at: Option<Part>,
    halo: Tween,
    /// Each list's pick, the one before it, and the new dot's fade in.
    picked: [(String, String, Tween); 2],
    /// The volume while the slider is held: the pointer's.
    held: Option<f32>,
    /// The filled share of the bar (volume / `sound::MAX`), gliding to a new volume
    /// unless held; the handle's height.
    fill: Tween,
    handle: Tween,
}

impl Audio {
    fn list(&self, input: bool) -> &[sound::Device] {
        if input { &self.sound.inputs } else { &self.sound.outputs }
    }

    fn parts(&self) -> Vec<(Part, f32, f32)> {
        parts(self.sound.outputs.len(), self.sound.inputs.len())
    }

    /// The volume under `x`, whole percents: the handle's centre is at 6 + (width
    /// - 8) x share (Windows' invisible range input, its 4 px thumb on the handle).
    fn volume_at(x: f32) -> f32 {
        (((x - 6.0) / (WIDTH - 8.0)).clamp(0.0, 1.0) * sound::MAX * 100.0).round() / 100.0
    }

    fn shown<'a>(s: &'a State, device: &'a sound::Device) -> &'a str {
        s.names.iter().find(|(name, _)| *name == device.description).map_or(&device.description, |(_, shown)| shown)
    }
}

impl Body for Audio {
    type State = State;

    fn state(&self) -> State {
        let share = self.sound.volume.min(sound::MAX) / sound::MAX;
        let pick = |name: &String| (name.clone(), String::new(), Tween::new(1.0, motion::EFFECTS));
        State {
            names: Vec::new(),
            hovered: None,
            ring: None,
            halo_at: None,
            halo: Tween::new(0.0, motion::EFFECTS),
            picked: [pick(&self.sound.output), pick(&self.sound.input)],
            held: None,
            fill: Tween::new(share, motion::SPATIAL),
            handle: Tween::new(handle(false), motion::SPATIAL_FAST),
        }
    }

    fn size(&self, s: &mut State) -> Size {
        let devices = || self.sound.outputs.iter().chain(&self.sound.inputs);
        if !s.names.iter().map(|(name, _)| name).eq(devices().map(|d| &d.description)) {
            s.names = devices().map(|d| (d.description.clone(), fit(&d.description, WIDTH - RING - GAP_3, width))).collect();
        }
        Size::new(WIDTH, height(&self.sound))
    }

    fn update(&self, s: &mut State, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        // A new pick: its dot fades in as the old one's fades out (Windows' 150 ms).
        for (now_picked, (pick, was, fade)) in [&self.sound.output, &self.sound.input].into_iter().zip(&mut s.picked) {
            if pick != now_picked {
                *was = std::mem::replace(pick, now_picked.clone());
                fade.set(0.0);
                fade.go(1.0, now);
            }
        }
        match s.held {
            Some(v) => s.fill.set(v / sound::MAX),
            None => s.fill.go(self.sound.volume.min(sound::MAX) / sound::MAX, now),
        }
        let parts = self.parts();
        let at_part = |p: Point, ring_only: bool| {
            parts.iter().find_map(|&(part, top, h)| {
                let spot = match part {
                    Part::Choice(..) if ring_only => Rectangle::new(Point::new(0.0, top), Size::new(RING, RING)),
                    Part::Choice(..) => Rectangle::new(Point::new(0.0, top), Size::new(WIDTH, h)),
                    // The range input's height: the held handle's.
                    Part::Bar if !ring_only => Rectangle::new(Point::new(0.0, top + (h - handle(true)) / 2.0), Size::new(WIDTH, handle(true))),
                    _ => return None,
                };
                spot.contains(p).then_some(part)
            })
        };
        s.hovered = at.and_then(|p| at_part(p, false));
        // The halo shows while the pointer is on a ring itself (`.c-radio-ring:hover`).
        let ring = at.and_then(|p| at_part(p, true));
        if ring != s.ring {
            s.ring = ring;
            s.halo_at = ring.or(s.halo_at);
            s.halo.go(if ring.is_some() { style::HOVER } else { 0.0 }, now);
        }
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => match s.hovered {
                Some(Part::Choice(input, i)) => {
                    sound::choose(&self.list(input)[i].name, input);
                    Reply::Used
                }
                Some(Part::Bar) => {
                    let v = Self::volume_at(at.map_or(0.0, |p| p.x));
                    s.held = Some(v);
                    s.handle.go(handle(true), now);
                    sound::set_volume(v);
                    Reply::Used
                }
                _ => Reply::None,
            },
            // Whole percents only, so a drag sends at most one set per percent.
            Event::Mouse(mouse::Event::CursorMoved { .. }) => {
                if let (Some(held), Some(p)) = (s.held, at) {
                    let v = Self::volume_at(p.x);
                    if v != held {
                        s.held = Some(v);
                        sound::set_volume(v);
                    }
                }
                Reply::None
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) if s.held.is_some() => {
                s.held = None;
                s.handle.go(handle(false), now);
                Reply::Used
            }
            Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { y, .. } | mouse::ScrollDelta::Pixels { y, .. } }) if s.hovered == Some(Part::Bar) && *y != 0.0 => {
                sound::step(WHEEL.copysign(*y));
                Reply::Used
            }
            _ => Reply::None,
        }
    }

    fn draw(&self, s: &State, renderer: &mut Renderer, c: Rectangle, alpha: f32, now: Instant) {
        let colours = &self.colours;
        let shade = |colour: Color, a: f32| Color { a: colour.a * a, ..colour };
        for (part, top, h) in self.parts() {
            let y = c.y + top;
            match part {
                Part::Head(i) => {
                    let volume = (s.held.unwrap_or(self.sound.volume) * 100.0).round();
                    let head = match i {
                        0 => "Output device".to_string(),
                        1 => "Input device".to_string(),
                        _ if self.sound.muted => "Volume (muted)".to_string(),
                        _ => format!("Volume ({volume}%)"),
                    };
                    let r = Rectangle { x: c.x, y, width: c.width, height: h };
                    renderer.fill_text(words(head, style::BODY, r.size()), Point::new(r.x, r.center_y()), shade(colours.text, alpha), r);
                }
                Part::Choice(input, i) => {
                    let device = &self.list(input)[i];
                    let (pick, was, fade) = &s.picked[input as usize];
                    let lit = match fade.value(now).clamp(0.0, 1.0) {
                        f if device.name == *pick => f,
                        f if device.name == *was => 1.0 - f,
                        _ => 0.0,
                    };
                    let ring = Rectangle { x: c.x, y, width: RING, height: RING };
                    let halo = s.halo.value(now).clamp(0.0, 1.0) * alpha;
                    if s.halo_at == Some(part) && halo > 0.0 {
                        let r = Rectangle { x: ring.x - HALO, y: ring.y - HALO, width: RING + 2.0 * HALO, height: RING + 2.0 * HALO };
                        renderer.fill_quad(quad(r, r.width / 2.0), shade(colours.text, halo));
                    }
                    let border = Border { color: shade(mix(colours.text_muted, colours.accent, lit), alpha), width: LINE, radius: (RING / 2.0).into() };
                    renderer.fill_quad(renderer::Quad { bounds: ring, border, ..Default::default() }, Color::TRANSPARENT);
                    if lit > 0.0 {
                        let off = (RING - DOT) / 2.0;
                        let dot = Rectangle { x: ring.x + off, y: ring.y + off, width: DOT, height: DOT };
                        renderer.fill_quad(quad(dot, DOT / 2.0), shade(colours.accent, alpha * lit));
                    }
                    let name = Rectangle { x: c.x + RING + GAP_3, y, width: c.width - RING - GAP_3, height: RING };
                    let label = words(Self::shown(s, device).to_string(), style::SMALL, name.size());
                    renderer.fill_text(label, Point::new(name.x, name.center_y()), shade(colours.text, alpha), name);
                }
                Part::Bar => {
                    // Windows' `FlatSlider`: the filled bar, 4 gap, a 4 line handle, 4
                    // gap, the rest of the track with a 4 dot at its end; the track
                    // fades and thins over its last 12. Whole pixels throughout.
                    let (w, mid, r) = (c.width, y + h / 2.0, style::CORNER);
                    let fill = ((w - 8.0) * s.fill.value(now).clamp(0.0, 1.0)).max(0.0).round();
                    let rest = (w - fill - 12.0).max(0.0);
                    let fade = rest.min(12.0) / 12.0;
                    let rest_h = (h * if h <= 12.0 { fade } else { (fade * 2.0).min(1.0) }).round();
                    if fill > 0.0 {
                        let outer = r.min(fill / 2.0);
                        let radius = Radius { top_left: outer, top_right: 2.0, bottom_right: 2.0, bottom_left: outer };
                        renderer.fill_quad(quad(Rectangle { x: c.x, y, width: fill, height: h }, radius), shade(colours.accent, alpha));
                    }
                    let hh = s.handle.value(now).round();
                    let knob = Rectangle { x: c.x + fill + 4.0, y: (mid - hh / 2.0).round(), width: 4.0, height: hh };
                    renderer.fill_quad(quad(knob, 2.0), shade(colours.accent, alpha));
                    if rest > 0.0 {
                        let outer = r.min(rest / 2.0);
                        let radius = Radius { top_left: 2.0, top_right: outer, bottom_right: outer, bottom_left: 2.0 };
                        let track = Rectangle { x: c.x + w - rest, y: (mid - rest_h / 2.0).round(), width: rest, height: rest_h };
                        renderer.fill_quad(quad(track, radius), shade(colours.raised, alpha * fade));
                        let side = (fade * 4.0).round();
                        if side > 0.0 {
                            let stop = Rectangle { x: c.x + w - 2.0 * side, y: (mid - side / 2.0).round(), width: side, height: side };
                            renderer.fill_quad(quad(stop, side / 2.0), shade(colours.accent, alpha * fade));
                        }
                    }
                }
            }
        }
    }

    fn moving(&self, s: &State, now: Instant) -> bool {
        s.halo.moving(now) || s.fill.moving(now) || s.handle.moving(now) || s.picked.iter().any(|(_, _, f)| f.moving(now))
    }

    fn clickable(&self, s: &State) -> bool {
        s.hovered.is_some()
    }

    fn busy(&self, s: &State) -> bool {
        s.held.is_some()
    }
}
