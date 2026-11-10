//! Text turned a quarter turn clockwise, read with the head tilted: the strip's window
//! title (Caelestia's `Rotation { angle: 90 }`), moved out of the shell's `active.rs`
//! once the music box's numbers ran sideways too (Music Tab Redesign step 1).
//!
//! Drawn flat by the text engine, then the pixels turned, so it matches every other
//! text: iced's own turned text (a canvas under a rotation) outlines the letters
//! without the font's weight, so the font draws Light (iced_tiny_skia 0.14.1
//! `geometry.rs` `fill_text`, cosmic-text 0.15 `swash_outline_commands`).

use iced::advanced::graphics::text::{cosmic_text as ct, font_system, to_attributes};
use iced::advanced::image;
use iced::{Color, Font, Point, Size};

/// `words` on one line at `size`, the line `line` tall.
fn laid(fonts: &mut ct::FontSystem, words: &str, size: f32, line: f32, font: Font) -> ct::Buffer {
    let mut buffer = ct::Buffer::new(fonts, ct::Metrics::new(size, line));
    buffer.set_size(fonts, None, None);
    buffer.set_text(fonts, words, &to_attributes(font), ct::Shaping::Advanced, None);
    buffer
}

fn length(buffer: &ct::Buffer) -> f32 {
    buffer.layout_runs().map(|run| run.line_w).fold(0.0, f32::max)
}

/// How long `words` run on one line at `size`.
pub fn width(words: &str, size: f32, font: Font) -> f32 {
    let mut fonts = font_system().write().expect("font system");
    length(&laid(fonts.raw(), words, size, size, font))
}

/// A flat picture to write lines into, then turn.
pub struct Flat {
    w: usize,
    h: usize,
    /// Premultiplied colour, 0..1.
    px: Vec<[f32; 4]>,
}

impl Flat {
    /// `size` rounded up to whole pixels.
    pub fn new(size: Size) -> Self {
        let (w, h) = (size.width.ceil().max(0.0) as usize, size.height.ceil().max(0.0) as usize);
        Self { w, h, px: vec![[0.0; 4]; w * h] }
    }

    /// One line of `words` at `size`, its line `line` tall, its top left `at`.
    pub fn write(&mut self, words: &str, size: f32, line: f32, font: Font, colour: Color, at: Point) {
        let mut fonts = font_system().write().expect("font system");
        let fonts = fonts.raw();
        let buffer = laid(fonts, words, size, line, font);
        let (ox, oy) = (at.x.round() as i32, at.y.round() as i32);
        let (w, h) = (self.w as i32, self.h as i32);
        let px = &mut self.px;
        buffer.draw(fonts, &mut ct::SwashCache::new(), ct::Color::rgb(255, 255, 255), |x, y, cw, ch, c| {
            let a = colour.a * c.a() as f32 / 255.0;
            for py in (oy + y).max(0)..(oy + y + ch as i32).min(h) {
                for qx in (ox + x).max(0)..(ox + x + cw as i32).min(w) {
                    let d = &mut px[(py * w + qx) as usize];
                    *d = [colour.r * a + d[0] * (1.0 - a), colour.g * a + d[1] * (1.0 - a), colour.b * a + d[2] * (1.0 - a), a + d[3] * (1.0 - a)];
                }
            }
        });
    }

    /// The picture turned a quarter turn clockwise: a line's left end goes to the top.
    /// Drawn at whole pixels it stays sharp.
    pub fn turned(&self) -> image::Handle {
        let (w, h) = (self.w, self.h);
        let pixels: Vec<u8> = (0..w)
            .flat_map(|y| (0..h).map(move |x| (x, y)))
            .flat_map(|(x, y)| {
                let [r, g, b, a] = self.px[(h - 1 - x) * w + y];
                let straight = |c: f32| if a > 0.0 { (c / a * 255.0).round().clamp(0.0, 255.0) as u8 } else { 0 };
                [straight(r), straight(g), straight(b), (a * 255.0).round().clamp(0.0, 255.0) as u8]
            })
            .collect();
        image::Handle::from_rgba(h as u32, w as u32, pixels)
    }
}
