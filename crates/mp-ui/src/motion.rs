//! Motion as Noctalia has it (his pick 2026-11-08, Noctalia Look): its times
//! (`lib/ui/style.h` `animFast` 100 / `animNormal` 200 / `animSlow` 400 ms) on its
//! most used curve, `EaseOutCubic` (57 of its 86 eased moves at `2f3e3c4f`;
//! `lib/render/animation/animation.cpp`: 1 - (1 - t)^3), here as its CSS twin
//! `cubic-bezier(0.33, 1, 0.68, 1)`. Moves still stop dead, no bounce (his call
//! 2026-10-29). A move glides from wherever it is, like a CSS transition.

use std::time::Duration;

use iced::time::Instant;

/// A cubic-bezier curve and how long it takes.
#[derive(Debug, Clone, Copy)]
pub struct Motion {
    ms: u64,
    curve: [f32; 4],
}

/// Noctalia's ease-out cubic.
const OUT_CUBIC: [f32; 4] = [0.33, 1.0, 0.68, 1.0];
/// Moves, growth, slides, panels: `animNormal`, Noctalia's most used time (38 of 63).
pub const SPATIAL: Motion = Motion { ms: 200, curve: OUT_CUBIC };
/// The hover pill and other quick follows: `animFast`.
pub const SPATIAL_FAST: Motion = Motion { ms: 100, curve: OUT_CUBIC };
/// Fades: `animNormal`, what most of Noctalia's opacity changes take (3 of 5).
pub const EFFECTS: Motion = Motion { ms: 200, curve: OUT_CUBIC };
/// The long one: `animSlow`.
pub const SLOW: Motion = Motion { ms: 400, curve: OUT_CUBIC };
/// Noctalia's ease-in quad (t squared), its CSS twin `cubic-bezier(0.11, 0, 0.5, 0)`.
const IN_QUAD: [f32; 4] = [0.11, 0.0, 0.5, 0.0];
/// A floating panel closing: `animNormal` on the ease-in quad (`panel_manager.cpp`
/// `closePanel`), so it leaves slowly at first, then fast.
pub const CLOSE: Motion = Motion { ms: 200, curve: IN_QUAD };

impl Motion {
    /// How long it takes: what a part that moves by its own rule (a slowing to a stop)
    /// borrows so it keeps the rulebook's time.
    pub fn duration(self) -> Duration {
        Duration::from_millis(self.ms)
    }

    /// How far along its curve a move is `p` of the way through its time: for a part
    /// that moves on a loop rather than to a target (a blink).
    pub fn at(self, p: f32) -> f32 {
        bezier(self.curve, p.clamp(0.0, 1.0))
    }
}

/// One coordinate of a cubic-bezier from 0 to 1 at `t`, and its rate of change.
fn at(a: f32, b: f32, t: f32) -> f32 {
    3.0 * a * t * (1.0 - t).powi(2) + 3.0 * b * t * t * (1.0 - t) + t.powi(3)
}

fn rate(a: f32, b: f32, t: f32) -> f32 {
    3.0 * a * (1.0 - t).powi(2) + 6.0 * (b - a) * t * (1.0 - t) + 3.0 * (1.0 - b) * t * t
}

/// The t where x(t) = p.
fn solve(x1: f32, x2: f32, p: f32) -> f32 {
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..24 {
        let t = (lo + hi) / 2.0;
        if at(x1, x2, t) < p { lo = t } else { hi = t }
    }
    (lo + hi) / 2.0
}

/// CSS-style cubic-bezier: find t where x(t) = p, return y(t).
pub fn bezier([x1, y1, x2, y2]: [f32; 4], p: f32) -> f32 {
    at(y1, y2, solve(x1, x2, p))
}

/// The curve's slope at `p` (its speed there, as a share of the whole move per the
/// whole time): Chromium's `TimingFunction::Velocity`.
pub(crate) fn slope([x1, y1, x2, y2]: [f32; 4], p: f32) -> f32 {
    let t = solve(x1, x2, p);
    let dx = rate(x1, x2, t);
    if dx.abs() < 1e-6 { 0.0 } else { rate(y1, y2, t) / dx }
}

/// A value that glides to each new target from wherever it is now.
#[derive(Debug, Clone, Copy)]
pub struct Tween {
    from: f32,
    to: f32,
    start: Instant,
    motion: Motion,
}

impl Tween {
    pub fn new(value: f32, motion: Motion) -> Self {
        Self { from: value, to: value, start: Instant::now(), motion }
    }

    pub fn value(&self, now: Instant) -> f32 {
        let p = (now.saturating_duration_since(self.start).as_secs_f32() * 1000.0 / self.motion.ms as f32).min(1.0);
        self.from + (self.to - self.from) * bezier(self.motion.curve, p)
    }

    pub fn go(&mut self, to: f32, now: Instant) {
        if to != self.to {
            *self = Self { from: self.value(now), to, start: now, motion: self.motion };
        }
    }

    /// `go` on another motion: the calendar's month leaves fast and arrives slower.
    pub fn go_with(&mut self, to: f32, now: Instant, motion: Motion) {
        *self = Self { from: self.value(now), to, start: now, motion };
    }

    /// Both ends moved so the glide ends at `to`, how far along it is kept: one going to
    /// a place that itself moves (a cover gliding to a slot as the covers resize).
    pub fn follow(&mut self, to: f32) {
        (self.from, self.to) = (self.from + to - self.to, to);
    }

    /// Jump there, no glide.
    pub fn set(&mut self, to: f32) {
        (self.from, self.to) = (to, to);
    }

    pub fn moving(&self, now: Instant) -> bool {
        now < self.start + Duration::from_millis(self.motion.ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bezier_starts_at_0_ends_at_1_and_eases_out() {
        assert!(bezier(OUT_CUBIC, 0.0).abs() < 1e-3);
        assert!((bezier(OUT_CUBIC, 1.0) - 1.0).abs() < 1e-3);
        // Ease-out: past halfway in distance at half its time.
        assert!(bezier(OUT_CUBIC, 0.5) > 0.5);
    }

    #[test]
    fn tween_glides_from_where_it_is_and_stops_dead() {
        let t0 = Instant::now();
        let mut t = Tween::new(10.0, SPATIAL);
        t.go(20.0, t0);
        let mid = t.value(t0 + SPATIAL.duration() / 2);
        assert!(mid > 15.0 && mid < 20.0);
        assert!(t.moving(t0 + SPATIAL.duration() / 2));
        assert!((t.value(t0 + SPATIAL.duration()) - 20.0).abs() < 1e-2);
        // A new target mid-glide starts from the value shown, no jump.
        let now = t0 + SPATIAL.duration() / 2;
        t.go(0.0, now);
        assert!((t.value(now) - mid).abs() < 1e-3);
        // `follow` keeps how far along it is; `set` jumps.
        t.follow(5.0);
        assert!((t.value(now) - (mid + 5.0)).abs() < 1e-3);
        t.set(3.0);
        assert_eq!(t.value(now), 3.0);
    }
}
