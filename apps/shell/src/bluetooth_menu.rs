//! The Bluetooth box (Left Strip Return plan step 4, his ask 2026-11-05): Caelestia's
//! `modules/bar/popouts/Bluetooth.qml` (@bcbb5d5) held to the rulebook, as `audio.rs` is
//! the sound box. The title; "Enabled" and "Discovering" with a switch each
//! (`mp_ui::switch`); how many devices BlueZ knows and how many are connected; up to five
//! of them, connected first, then paired, then by name: the device's picture, its name,
//! its battery while connected, a round connect / disconnect button (filled accent while
//! connected, a turning ring while a call waits) and, for one paired with its keys kept,
//! a forget button. Each row fades in and grows from 0.7 as it comes. Caelestia's "Open
//! settings" is left out (no Settings app, his call). What it shows comes from
//! `bluetooth.rs`; its presses go back there as asks.

use std::collections::HashMap;

use iced::advanced::graphics::geometry::Renderer as _;
use iced::advanced::image::{self, Renderer as _};
use iced::advanced::text::{self, Paragraph as _, Renderer as _};
use iced::advanced::{Renderer as _, mouse, renderer};
use iced::alignment::Vertical;
use iced::time::Instant;
use iced::widget::canvas::{Frame, LineCap, Path, Stroke, path::Arc};
use iced::{Color, Event, Pixels, Point, Radians, Rectangle, Renderer, Size, Transformation, Vector, border};
use mp_ui::switch::{self, Switch};

use crate::bluetooth::{self, Ask, Bluetooth, Device};
use crate::colours::Colours;
use crate::icon;
use crate::menu::{Body, Reply};
use crate::motion::{self, Tween};
use crate::style::{self, GAP_1, GAP_2, GAP_3};

/// The sound box's width, so the box keeps its width gliding between the two
/// (Caelestia's 300 is its own size).
const WIDTH: f32 = crate::audio::WIDTH;
/// Caelestia lists at most five devices.
pub const MOST: usize = 5;
/// A switch's row and a device's: a control's height (the switch's and the round
/// buttons').
const ROW: f32 = style::CONTROL;
const ICON: f32 = style::ICON as f32;

/// A device's picture by BlueZ's picture name, Caelestia's `Icons.bluetoothIconRules`
/// (a name containing any of the words), in Boxicons Filled: headphones, a speaker, a
/// phone, a mouse, a keyboard, else Bluetooth's own.
pub const DEVICES: [&[u8]; 6] = [
    include_bytes!("../assets/bx-headphone.svg"),
    include_bytes!("../assets/bx-speaker.svg"),
    include_bytes!("../assets/bx-mobile.svg"),
    include_bytes!("../assets/bx-mouse.svg"),
    include_bytes!("../assets/bx-keyboard.svg"),
    include_bytes!("../assets/bx-bluetooth.svg"),
];

pub fn kind(icon: &str) -> usize {
    const RULES: [&[&str]; 5] = [&["headset", "headphones"], &["audio"], &["phone"], &["mouse"], &["keyboard"]];
    RULES.iter().position(|words| words.iter().any(|w| icon.contains(w))).unwrap_or(RULES.len())
}

/// The battery by its share: Caelestia's `getBatteryIcon` draws six bars and a full one;
/// Boxicons has three bars and a full one.
const BATTERY: [&[u8]; 4] = [include_bytes!("../assets/bx-battery-1.svg"), include_bytes!("../assets/bx-battery-2.svg"), include_bytes!("../assets/bx-battery-3.svg"), include_bytes!("../assets/bx-battery-full.svg")];

fn battery(percent: u8) -> usize {
    if percent >= 100 { 3 } else { (percent as usize * 3 / 100).min(2) }
}

/// The box's pictures in their colours, drawn with the strip's.
pub struct Pictures {
    devices: Vec<image::Handle>,
    /// Muted, and in `error` under 20% (Caelestia's).
    battery: [Vec<image::Handle>; 2],
    /// Connect (Text) and disconnect (On Accent, on the filled button).
    link: image::Handle,
    unlink: image::Handle,
    trash: image::Handle,
}

impl Pictures {
    pub fn new(c: &Colours) -> Self {
        let draw = |svg: &[u8], colour| icon::svg(svg, style::ICON, colour);
        let set = |svgs: &[&[u8]], colour: Color| svgs.iter().map(|svg| draw(svg, colour)).collect::<Vec<_>>();
        Self {
            devices: set(&DEVICES, c.text),
            battery: [set(&BATTERY, c.text_muted), set(&BATTERY, c.error)],
            link: draw(include_bytes!("../assets/bx-link.svg"), c.text),
            unlink: draw(include_bytes!("../assets/bx-unlink.svg"), c.on_accent),
            trash: draw(include_bytes!("../assets/bx-trash.svg"), c.text),
        }
    }
}

/// The devices listed, Caelestia's order: connected, paired, then by name.
pub fn listed(bt: &Bluetooth) -> Vec<(&str, &Device)> {
    let mut all: Vec<_> = bt.devices().collect();
    all.sort_by(|(_, a), (_, b)| b.connected.cmp(&a.connected).then(b.paired.cmp(&a.paired)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    all.truncate(MOST);
    all
}

/// The box's parts, top to bottom.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Part {
    Title,
    Switch(usize),
    Count,
    Device(usize),
}

/// Each part with its top and height: Caelestia's column, its small spacing (gap-2)
/// between parts and as much again over the count; the sound box's gap-3 at top and
/// bottom.
fn parts(rows: usize) -> Vec<(Part, f32, f32)> {
    let mut list = vec![(Part::Title, 0.0), (Part::Switch(0), 0.0), (Part::Switch(1), 0.0), (Part::Count, GAP_2)];
    list.extend((0..rows).map(|i| (Part::Device(i), 0.0)));
    let mut y = GAP_3 - GAP_2;
    list.into_iter()
        .map(|(part, margin)| {
            let top = y + GAP_2 + margin;
            let height = match part {
                Part::Title => (style::BODY * style::LINE_TIGHT).round(),
                Part::Count => (style::SMALL * style::LINE_TIGHT).round(),
                Part::Switch(_) | Part::Device(_) => ROW,
            };
            y = top + height;
            (part, top, height)
        })
        .collect()
}

/// The box's height inside the menu's padding, `rows` devices listed.
pub fn height(rows: usize) -> f32 {
    parts(rows).last().map_or(0.0, |(_, top, h)| top + h) + GAP_3
}

fn words<T>(content: T, size: f32, bounds: Size) -> text::Text<T> {
    text::Text { content, bounds, size: Pixels(size), line_height: style::LINE_TIGHT.into(), font: crate::BOLD, align_x: text::Alignment::Left, align_y: Vertical::Center, shaping: text::Shaping::Basic, wrapping: text::Wrapping::None }
}

fn width(content: &str) -> f32 {
    <Renderer as text::Renderer>::Paragraph::with_text(words(content, style::BODY, Size::INFINITE)).min_width()
}

/// A press spot: a switch, or a device's (its path) connect or forget button.
#[derive(Debug, Clone, PartialEq)]
enum Spot {
    Switch(usize),
    Connect(String),
    Forget(String),
}

/// A device row's places left to right (Caelestia's row, its small spacing between):
/// the picture, the name with a gap-1 each side, the battery while connected, the
/// connect button, the forget button when paired with its keys kept.
struct Places {
    name: (f32, f32),
    battery: Option<f32>,
    connect: f32,
    forget: Option<f32>,
}

fn places(d: &Device) -> Places {
    let mut right = WIDTH;
    let mut take = |w: f32| {
        right -= w;
        let x = right;
        right -= GAP_2;
        x
    };
    let forget = d.bonded.then(|| take(ROW));
    let connect = take(ROW);
    // Caelestia's `battery_alert` for a connected device that tells none has no
    // Boxicon: no picture and no room for one then (Malthaiel's pick 2026-11-05).
    let battery = (d.connected && d.battery.is_some()).then(|| take(ICON));
    let left = ICON + GAP_2 + GAP_1;
    Places { name: (left, (right + GAP_2 - GAP_1 - left).max(0.0)), battery, connect, forget }
}

/// The ring turning while a call waits (Caelestia's `CircularIndicator`, Material's
/// "advance" motion: 5.4 s, four sweeps of a growing then shrinking arc on Material's
/// fast-out-slow-in curve), a gap-1 line, the rest of the ring Raised, as the sound
/// box's slider track; drawn in a `side` square.
fn ring(frame: &mut Frame, side: f32, since: Instant, now: Instant, accent: Color, track: Color) {
    const EXPAND: [f32; 4] = [0.0, 1350.0, 2700.0, 4050.0];
    const COLLAPSE: [f32; 4] = [667.0, 2017.0, 3367.0, 4717.0];
    let curve = |from: f32, t: f32| motion::bezier([0.4, 0.0, 0.2, 1.0], ((t - from) / 667.0).clamp(0.0, 1.0));
    let t = (now.saturating_duration_since(since).as_secs_f32() * 1000.0) % 5400.0;
    let turn = 1520.0 * t / 5400.0;
    let (mut start, mut end) = (turn - 20.0, turn);
    for i in 0..4 {
        end += curve(EXPAND[i], t) * 250.0;
        start += curve(COLLAPSE[i], t) * 250.0;
    }
    let line = GAP_1;
    let radius = (side - line) / 2.0;
    let centre = Point::new(side / 2.0, side / 2.0);
    let value = ((end - start) / 360.0).clamp(1.0 / 360.0, 1.0);
    // Caelestia's ring starts at the top; the gap each side of the arc is its spacing
    // and line along the ring.
    let from = (start - 90.0).to_radians();
    let sweep = value * std::f32::consts::TAU;
    let gap = (GAP_2 + line) / radius;
    let arc = |a: f32, b: f32| Path::new(|p| p.arc(Arc { center: centre, radius, start_angle: Radians(a), end_angle: Radians(b) }));
    let stroke = |colour: Color| Stroke::default().with_color(colour).with_width(line).with_line_cap(LineCap::Round);
    let rest = std::f32::consts::TAU - sweep - 2.0 * gap;
    if rest > 0.0 {
        frame.stroke(&arc(from + sweep + gap, from + sweep + gap + rest), stroke(track));
    }
    frame.stroke(&arc(from, from + sweep), stroke(accent));
}

pub struct Menu<'a> {
    pub bt: Bluetooth,
    pub colours: Colours,
    pub pictures: &'a Pictures,
}

pub struct State {
    switches: [Switch; 2],
    hovered: Option<Spot>,
    pressed: Option<Spot>,
    /// The round button the patch is on, or was last on, and its fade.
    patch_at: Option<Spot>,
    patch: Tween,
    /// Each row as it came in: its fade and its growth, by path.
    rows: HashMap<String, (Tween, Tween)>,
    /// Each listed name and as it shows (`audio::fit`), by path.
    names: HashMap<String, (String, f32, String)>,
}

impl Menu<'_> {
    /// Enabled and Discovering, as BlueZ tells them (off without a controller).
    fn on(&self) -> [bool; 2] {
        let a = self.bt.adapter();
        [a.is_some_and(|a| a.powered), a.is_some_and(|a| a.discovering)]
    }

    fn spot(&self, p: Point) -> Option<Spot> {
        let size = switch::size();
        let square = |x: f32, top: f32| Rectangle::new(Point::new(x, top), Size::new(ROW, ROW)).contains(p);
        let listed = listed(&self.bt);
        parts(listed.len()).into_iter().find_map(|(part, top, h)| match part {
            Part::Switch(i) => Rectangle::new(Point::new(WIDTH - size.width, top + (h - size.height) / 2.0), size).contains(p).then_some(Spot::Switch(i)),
            Part::Device(i) => {
                let (path, d) = listed[i];
                let at = places(d);
                // No presses while a call waits (Caelestia's `disabled: loading`).
                if square(at.connect, top) && d.busy.is_none() { Some(Spot::Connect(path.into())) } else { at.forget.filter(|&x| square(x, top)).map(|_| Spot::Forget(path.into())) }
            }
            _ => None,
        })
    }

    fn press(&self, spot: Spot) {
        let ask = match spot {
            Spot::Switch(0) => Ask::Power(!self.on()[0]),
            Spot::Switch(_) => Ask::Look(!self.on()[1]),
            Spot::Connect(path) => {
                let connected = self.bt.devices().any(|(p, d)| p == path && d.connected);
                Ask::Connect(path, !connected)
            }
            Spot::Forget(path) => Ask::Forget(path),
        };
        bluetooth::send(ask);
    }
}

impl Body for Menu<'_> {
    type State = State;

    fn state(&self) -> State {
        let [power, look] = self.on();
        State { switches: [Switch::new(power), Switch::new(look)], hovered: None, pressed: None, patch_at: None, patch: Tween::new(0.0, motion::EFFECTS), rows: HashMap::new(), names: HashMap::new() }
    }

    fn size(&self, s: &mut State) -> Size {
        let listed = listed(&self.bt);
        s.names.retain(|path, _| listed.iter().any(|(p, _)| p == path));
        for (path, d) in &listed {
            let room = places(d).name.1;
            let fresh = s.names.get(*path).is_none_or(|(name, was, _)| *name != d.name || *was != room);
            if fresh {
                s.names.insert(path.to_string(), (d.name.clone(), room, crate::audio::fit(&d.name, room, width)));
            }
        }
        Size::new(WIDTH, height(listed.len()))
    }

    fn update(&self, s: &mut State, event: &Event, at: Option<Point>, now: Instant) -> Reply {
        let spot = at.and_then(|p| self.spot(p));
        let on = self.on();
        for (i, switch) in s.switches.iter_mut().enumerate() {
            let here = |x: &Option<Spot>| *x == Some(Spot::Switch(i));
            switch.set(on[i], here(&spot), here(&s.pressed) && here(&spot), now);
        }
        // A row new to the list fades in and grows from 0.7 (Caelestia's DefaultEffects
        // fade and default move: the rulebook's).
        for (path, _) in listed(&self.bt) {
            s.rows.entry(path.into()).or_insert_with(|| {
                let (mut fade, mut grow) = (Tween::new(0.0, motion::EFFECTS), Tween::new(0.7, motion::SPATIAL));
                fade.go(1.0, now);
                grow.go(1.0, now);
                (fade, grow)
            });
        }
        // The round buttons' patch (Caelestia's `StateLayer`: 8% while under the pointer).
        let button = spot.clone().filter(|x| !matches!(x, Spot::Switch(_)));
        if button != s.hovered.clone().filter(|x| !matches!(x, Spot::Switch(_))) {
            if button.is_some() {
                s.patch_at = button.clone();
            }
            s.patch.go(if button.is_some() { style::HOVER } else { 0.0 }, now);
        }
        s.hovered = spot.clone();
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) if spot.is_some() => {
                s.pressed = spot;
                Reply::Used
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) if s.pressed.is_some() => {
                if let Some(p) = s.pressed.take().filter(|p| Some(p) == spot.as_ref()) {
                    self.press(p);
                }
                Reply::Used
            }
            _ => Reply::None,
        }
    }

    fn draw(&self, s: &State, renderer: &mut Renderer, c: Rectangle, alpha: f32, now: Instant) {
        let colours = &self.colours;
        let shade = |colour: Color, a: f32| Color { a: colour.a * a, ..colour };
        let listed = listed(&self.bt);
        for (part, top, h) in parts(listed.len()) {
            let y = c.y + top;
            let line = Rectangle { x: c.x, y, width: c.width, height: h };
            let say = |renderer: &mut Renderer, what: String, size: f32, colour: Color, r: Rectangle| {
                renderer.fill_text(words(what, size, r.size()), Point::new(r.x, r.center_y()), shade(colour, alpha), r);
            };
            match part {
                Part::Title => say(renderer, "Bluetooth".into(), style::BODY, colours.text, line),
                Part::Switch(i) => {
                    let size = switch::size();
                    say(renderer, ["Enabled", "Discovering"][i].into(), style::BODY, colours.text, Rectangle { width: c.width - size.width - GAP_3, ..line });
                    s.switches[i].draw(renderer, Point::new(c.x + c.width - size.width, y + (h - size.height) / 2.0), colours, alpha, now);
                }
                Part::Count => {
                    let all = self.bt.devices().count();
                    let connected = self.bt.devices().filter(|(_, d)| d.connected).count();
                    let mut count = format!("{all} device{} available", if all == 1 { "" } else { "s" });
                    if connected > 0 {
                        count += &format!(" ({connected} connected)");
                    }
                    say(renderer, count, style::SMALL, colours.text_muted, line);
                }
                Part::Device(i) => {
                    let (path, d) = listed[i];
                    let (fade, grow) = s.rows.get(path).map_or((1.0, 1.0), |(f, g)| (f.value(now).clamp(0.0, 1.0), g.value(now)));
                    let a = alpha * fade;
                    let at = places(d);
                    // Grown about the row's centre.
                    let mid = Vector::new(line.center_x(), line.center_y());
                    let scale = Transformation::translate(mid.x, mid.y) * Transformation::scale(grow) * Transformation::translate(-mid.x, -mid.y);
                    renderer.with_transformation(scale, |renderer| {
                        let square = |x: f32, side: f32| Rectangle { x: c.x + x, y: y + (ROW - side) / 2.0, width: side, height: side };
                        let picture = |renderer: &mut Renderer, handle: &image::Handle, spot: Rectangle, a: f32| {
                            renderer.draw_image(image::Image { opacity: a, ..image::Image::new(handle.clone()) }, spot, line);
                        };
                        picture(renderer, &self.pictures.devices[kind(&d.icon)], square(0.0, ICON), a);
                        let name = s.names.get(path).map_or(d.name.clone(), |(_, _, shown)| shown.clone());
                        let r = Rectangle { x: c.x + at.name.0, y, width: at.name.1, height: ROW };
                        renderer.fill_text(words(name, style::BODY, r.size()), Point::new(r.x, r.center_y()), shade(colours.text, a), r);
                        if let (Some(x), Some(percent)) = (at.battery, d.battery) {
                            picture(renderer, &self.pictures.battery[(percent < 20) as usize][battery(percent)], square(x, ICON), a);
                        }
                        let round = |renderer: &mut Renderer, x: f32, fill: Option<Color>, patch: Color, spot: Spot| {
                            let r = square(x, ROW);
                            if let Some(fill) = fill {
                                renderer.fill_quad(renderer::Quad { bounds: r, border: border::rounded(ROW / 2.0), ..Default::default() }, shade(fill, a));
                            }
                            let p = s.patch.value(now).clamp(0.0, 1.0);
                            if s.patch_at.as_ref() == Some(&spot) && p > 0.0 {
                                renderer.fill_quad(renderer::Quad { bounds: r, border: border::rounded(ROW / 2.0), ..Default::default() }, shade(patch, a * p));
                            }
                        };
                        let (fill, patch) = if d.connected { (Some(colours.accent), colours.on_accent) } else { (None, colours.text) };
                        round(renderer, at.connect, fill, patch, Spot::Connect(path.into()));
                        match d.busy {
                            Some(since) => {
                                let mut frame = Frame::new(renderer, Size::new(ROW, ROW));
                                ring(&mut frame, ROW, since, now, shade(colours.accent, a), shade(colours.raised, a));
                                let o = Vector::new(c.x + at.connect, y);
                                renderer.with_translation(o, |renderer| renderer.draw_geometry(frame.into_geometry()));
                            }
                            None => {
                                let link = if d.connected { &self.pictures.unlink } else { &self.pictures.link };
                                picture(renderer, link, square(at.connect + (ROW - ICON) / 2.0, ICON), a);
                            }
                        }
                        if let Some(x) = at.forget {
                            round(renderer, x, None, colours.text, Spot::Forget(path.into()));
                            picture(renderer, &self.pictures.trash, square(x + (ROW - ICON) / 2.0, ICON), a);
                        }
                    });
                }
            }
        }
    }

    fn moving(&self, s: &State, now: Instant) -> bool {
        s.switches.iter().any(|w| w.moving(now)) || s.patch.moving(now) || s.rows.values().any(|(f, g)| f.moving(now) || g.moving(now)) || self.bt.devices().any(|(_, d)| d.busy.is_some())
    }

    fn clickable(&self, s: &State) -> bool {
        s.hovered.is_some()
    }
}
