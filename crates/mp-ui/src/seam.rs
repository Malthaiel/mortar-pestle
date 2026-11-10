//! The edge between a side column and the page, held and dragged to size the column
//! (Windows' `ResizeSeam.jsx`; the Library's cover wall first, chat 49, moved here as
//! the default for every app in chat 50). The gap between the two is the edge: the
//! left-right arrow over it, two clicks hand the app a `Reset`. While held, a layer
//! over the whole window follows the pointer and keeps the arrow, and a let-go is
//! heard off the window too.
//!
//! The width never jumps: it chases where it is sent as a critically damped spring
//! (no bounce), a little behind the hand (`LAG`) and never faster than `TOP_SPEED`,
//! the app's own moves (its width back, a new window size) the same way (his asks
//! and picks, chat 50: a soft spring, every move).
//!
//! The app keeps `drop::keep_pointer` up to date (a press has no place in iced), owns
//! the width's limits and what it keeps, and maps `Message` into its own.

use iced::time::Instant;
use iced::widget::{mouse_area, space};
use iced::{Element, Length, Point, Subscription, event, mouse, window};

use crate::drop;
use crate::style::GAP_2;

/// How far behind the hand the width runs: the spring's smooth time, in seconds (a
/// hand at 1000 px a second leads by 120 px; it catches up about 0.4 s after
/// stopping). His tries, chat 50: 0.08, then doubled, then the middle of the two.
const LAG: f32 = 0.12;
/// The fastest the width moves, px a second: a fling from widest to narrowest glides.
const TOP_SPEED: f32 = 2000.0;

#[derive(Debug, Clone, Copy)]
pub enum Message {
    Grab,
    Drag(Point),
    Let,
    Reset,
    Frame(Instant),
}

/// What `update` hands back to the app.
#[derive(Debug, Clone, Copy)]
pub enum Outcome {
    /// Let go, the hand having sent it here: the app keeps it, or `go`es somewhere near.
    Let(f32),
    /// Two clicks on the edge: the app sends it back to its own width.
    Reset,
    /// The width came to rest where it was sent.
    Rest,
}

pub struct Seam {
    /// Where the width is going; where it is, how fast it moves (px a second) and when.
    to: f32,
    at: f32,
    speed: f32,
    then: Instant,
    /// Held: the pointer's x and `to` at the press.
    held: Option<(f32, f32)>,
}

impl Seam {
    pub fn new(width: f32) -> Self {
        Self { to: width, at: width, speed: 0.0, then: Instant::now(), held: None }
    }

    /// The width shown now.
    pub fn width(&self) -> f32 {
        self.at
    }

    /// Where it is going.
    pub fn to(&self) -> f32 {
        self.to
    }

    pub fn held(&self) -> bool {
        self.held.is_some()
    }

    pub fn moving(&self) -> bool {
        self.at != self.to || self.speed != 0.0
    }

    /// Sends the width to `to`, the spring carrying it there.
    pub fn go(&mut self, to: f32) {
        if !self.moving() {
            self.then = Instant::now();
        }
        self.to = to;
    }

    /// There at once (the window's first width).
    pub fn set(&mut self, to: f32) {
        (self.to, self.at, self.speed) = (to, to, 0.0);
    }

    /// The edge's messages, the hand's width held between `min` and `max`.
    pub fn update(&mut self, message: Message, min: f32, max: f32) -> Option<Outcome> {
        match message {
            Message::Grab => self.held = Some((drop::pointer().x, self.to)),
            Message::Drag(at) => {
                if let Some((x, width)) = self.held {
                    self.go((width + at.x - x).min(max).max(min));
                }
            }
            Message::Let => return self.held.take().map(|_| Outcome::Let(self.to)),
            Message::Reset => {
                self.held = None;
                return Some(Outcome::Reset);
            }
            Message::Frame(now) => {
                if !self.moving() {
                    return None;
                }
                let dt = now.saturating_duration_since(self.then).as_secs_f32();
                self.then = now;
                // A critically damped spring's exact step (no bounce), its aim never
                // further than `TOP_SPEED` carries in `LAG`: far off, it runs at
                // `TOP_SPEED` and no faster (Unity's `SmoothDamp` does the same).
                let w = 2.0 / LAG;
                let d = (self.at - self.to).clamp(-TOP_SPEED * LAG, TOP_SPEED * LAG);
                let c = self.speed + w * d;
                let e = (-w * dt).exp();
                self.at += (d + c * dt) * e - d;
                self.speed = (self.speed - w * c * dt) * e;
                // A quarter pixel off and all but still: there.
                if (self.at - self.to).abs() < 0.25 && self.speed.abs() < 10.0 {
                    self.set(self.to);
                    return Some(Outcome::Rest);
                }
            }
        }
        None
    }

    /// The edge: put it between the column and the page, the gap between them.
    pub fn edge<'a>(&self) -> Element<'a, Message> {
        mouse_area(space().width(GAP_2).height(Length::Fill)).on_press(Message::Grab).on_double_click(Message::Reset).interaction(mouse::Interaction::ResizingColumn).into()
    }

    /// While held, a layer over the whole window (on top of a `stack`): the pointer
    /// followed wherever it goes, the arrow kept.
    pub fn layer<'a>(&self) -> Option<Element<'a, Message>> {
        self.held.map(|_| mouse_area(space().width(Length::Fill).height(Length::Fill)).on_move(Message::Drag).interaction(mouse::Interaction::ResizingColumn).into())
    }

    /// Frames while the width moves; a let-go anywhere, off the window too, while held.
    pub fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            if self.moving() { window::frames().map(Message::Frame) } else { Subscription::none() },
            if self.held() { event::listen_with(|event, _, _| matches!(event, iced::Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))).then_some(Message::Let)) } else { Subscription::none() },
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Flung from wide to narrow in one move: never faster than `TOP_SPEED`, no
    /// overshoot, at rest exactly where sent.
    #[test]
    fn seam_glides_at_top_speed() {
        let mut seam = Seam::new(2000.0);
        seam.go(120.0);
        let (mut now, mut fastest, mut lowest, mut frames) = (seam.then, 0.0f32, f32::MAX, 0);
        loop {
            let before = seam.width();
            now += Duration::from_micros(4167);
            frames += 1;
            let rest = seam.update(Message::Frame(now), 0.0, f32::MAX);
            fastest = fastest.max((before - seam.width()) / 0.004167);
            lowest = lowest.min(seam.width());
            if rest.is_some() || frames > 10_000 {
                break;
            }
        }
        assert!(fastest <= TOP_SPEED * 1.001, "{fastest}");
        assert!(lowest >= 120.0 - 0.25, "{lowest}");
        assert_eq!(seam.width(), 120.0);
        // 1880 px at `TOP_SPEED`, plus the spring's start and end.
        let least = (1880.0 / TOP_SPEED / 0.004167) as u32;
        assert!((least..=least + (5.0 * LAG / 0.004167) as u32).contains(&frames), "{frames}");
    }
}
