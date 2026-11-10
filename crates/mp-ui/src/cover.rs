//! A cover picture as every app shows it: the middle square, the rulebook's corner.

use iced::widget::image;

use crate::style;

/// `data` (a JPEG or PNG file) as `side` square, as `object-fit: cover`, its corners
/// cut round: shrunk as read, no full-size copy (a kept copy cost the shell ~6 MB,
/// measured 2026-10-31).
pub fn square(data: &[u8], side: u32) -> Option<image::Handle> {
    Some(square_of(&::image::load_from_memory(data).ok()?, side))
}

/// The same, from a picture already read (one read for several sizes).
pub fn square_of(picture: &::image::DynamicImage, side: u32) -> image::Handle {
    image::Handle::from_rgba(side, side, rounded(picture, side, style::CORNER).into_raw())
}

/// The same, kept as a small PNG file (see-through corners kept) and unpacked only while
/// it shows: for pictures held by the hundred (PNG kept 63-67% of
/// the raw size on cover photos, measured 2026-10-31). `corner` is the cut's radius:
/// `style::CORNER`, or half the side for a circle.
pub fn square_file(data: &[u8], side: u32, corner: f32) -> Option<image::Handle> {
    Some(image::Handle::from_bytes(square_png(&::image::load_from_memory(data).ok()?, side, corner)?))
}

/// `square_file`'s PNG file itself, from a picture already read (a notice's, kept on
/// disk by the shell).
pub fn square_png(picture: &::image::DynamicImage, side: u32, corner: f32) -> Option<Vec<u8>> {
    use ::image::ImageEncoder;
    use ::image::codecs::png::{CompressionType, FilterType, PngEncoder};
    let cut = rounded(picture, side, corner);
    let mut file = Vec::new();
    PngEncoder::new_with_quality(&mut file, CompressionType::Fast, FilterType::Adaptive).write_image(&cut, side, side, ::image::ExtendedColorType::Rgba8).ok()?;
    Some(file)
}

/// `picture` as `side` square with its corners cut round, `r` the radius.
fn rounded(picture: &::image::DynamicImage, side: u32, r: f32) -> ::image::RgbaImage {
    let mut out = picture.resize_to_fill(side, side, ::image::imageops::FilterType::Triangle).into_rgba8();
    let n = side as f32;
    // Square corners (the rulebook's 0): no pixel to cut.
    if r <= 0.0 {
        return out;
    }
    for (x, y, px) in out.enumerate_pixels_mut() {
        let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
        let dx = (r - cx).max(cx - (n - r)).max(0.0);
        let dy = (r - cy).max(cy - (n - r)).max(0.0);
        if dx > 0.0 && dy > 0.0 {
            let cover = (r - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0);
            px.0[3] = (px.0[3] as f32 * cover) as u8;
        }
    }
    out
}
