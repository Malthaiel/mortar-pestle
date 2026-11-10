//! Icons are drawn once into a small picture; the drawing itself is thrown away.

use iced::Color;
use iced::widget::image;
use resvg::{tiny_skia, usvg};

/// A one-colour icon (Boxicons, our logo): its shape, filled with `colour`.
pub fn svg(data: &[u8], size: u32, colour: Color) -> image::Handle {
    let tree = usvg::Tree::from_data(data, &usvg::Options::default()).expect("bundled icon");
    let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("icon size");
    let scale = size as f32 / tree.size().width();
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let [r, g, b, _] = colour.into_rgba8();
    let pixels: Vec<u8> = pixmap.pixels().iter().flat_map(|p| [r, g, b, p.alpha()]).collect();
    image::Handle::from_rgba(size, size, pixels)
}

/// The blank columns left and right of a picture's drawing (alpha under 64 counts as
/// blank), so a gap can be measured to what is drawn (his "make the space even").
pub fn side_blank(picture: &image::Handle) -> (f32, f32) {
    let image::Handle::Rgba { width, height, pixels, .. } = picture else { return (0.0, 0.0) };
    let (w, h) = (*width as usize, *height as usize);
    let inked = |x: usize| (0..h).any(|y| pixels[(y * w + x) * 4 + 3] >= 64);
    let left = (0..w).take_while(|&x| !inked(x)).count();
    if left == w {
        return (0.0, 0.0);
    }
    let right = (0..w).rev().take_while(|&x| !inked(x)).count();
    (left as f32, right as f32)
}

/// An icon in plain and lit (On Accent) colours: the two copies `pill::Highlight` draws.
#[derive(Debug, Clone)]
pub struct Pair {
    plain: image::Handle,
    lit: image::Handle,
}

impl Pair {
    pub fn new(data: &[u8], size: u32, plain: Color, lit: Color) -> Self {
        Self { plain: svg(data, size, plain), lit: svg(data, size, lit) }
    }

    pub fn get(&self, lit: bool) -> image::Handle {
        if lit { self.lit.clone() } else { self.plain.clone() }
    }
}
