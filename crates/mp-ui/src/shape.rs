//! The frame's boxes (moved out of the shell's `menu.rs` once a second program drew
//! one, the music box; Music Tab Redesign step 1): a box grown out of a frame edge,
//! rounded where it stands free, and the inward curves joining it to the edge.
//! Caelestia's bar popout and drawers are the model (@b51fdb3); the corner is the
//! windows' (niri's `geometry-corner-radius`), whole pixels so every edge sits on the
//! pixel grid (the processor's renderer redraws a shape's exact bounds, so a
//! part-covered edge pixel would be left behind as a line).

use iced::widget::canvas::Path;
use iced::{Point, Rectangle, Vector};

/// The first `geometry-corner-radius` in niri's config (its window rule): the
/// windows' corner, which the frame's boxes share. 0 when unset, niri's own default.
/// Moved out of the shell once the music box drew one too.
pub fn corner_radius() -> f32 {
    std::fs::read_to_string(crate::colours::config_dir().join("niri/config.kdl")).ok().and_then(|file| file.lines().find_map(|l| l.trim().strip_prefix("geometry-corner-radius ")?.trim().parse().ok())).unwrap_or(0.0)
}

/// The curves' and corners' size while a box is `grown` long out of its edge, corner
/// `r`: under two corners' growth the curves and the corners share it, so the edge
/// stays one S from the band into the box (his catch 2026-10-29).
pub fn growth(grown: f32, r: f32) -> (f32, f32) {
    let curve = r.min((grown / 2.0).floor());
    (curve, r.min(grown - curve))
}

/// A box with its bottom corners rounded (the top bar's).
pub fn rounded_bottom(b: Rectangle, r: f32) -> Path {
    let (x1, y1) = (b.x + b.width, b.y + b.height);
    Path::new(|p| {
        p.move_to(Point::new(b.x, b.y));
        p.line_to(Point::new(x1, b.y));
        p.line_to(Point::new(x1, y1 - r));
        p.arc_to(Point::new(x1, y1), Point::new(x1 - r, y1), r);
        p.line_to(Point::new(b.x + r, y1));
        p.arc_to(Point::new(b.x, y1), Point::new(b.x, y1 - r), r);
        p.close();
    })
}

/// The inward curve joining an edge (the strip's, the screen's bottom) to the box
/// side that meets it at `at`: `along` runs along the edge away from the box,
/// `up` along the box's side away from the edge. It overlaps the box by 1 px so
/// no seam shows.
pub fn join(at: Point, along: Vector, up: Vector, r: f32) -> Path {
    Path::new(|p| {
        p.move_to(at + along * r);
        p.arc_to(at, at + up * r, r);
        p.line_to(at + up * r - along);
        p.line_to(at - along);
        p.close();
    })
}

#[cfg(test)]
mod tests {
    use super::growth;

    #[test]
    fn growth_shares_a_short_box_between_curve_and_corner() {
        assert_eq!(growth(0.0, 12.0), (0.0, 0.0));
        assert_eq!(growth(10.0, 12.0), (5.0, 5.0));
        assert_eq!(growth(100.0, 12.0), (12.0, 12.0));
        assert_eq!(growth(100.0, 0.0), (0.0, 0.0));
    }
}
