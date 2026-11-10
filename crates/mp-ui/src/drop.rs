//! The in-window drop-down (approved 2026-10-31, chat 28): Windows' `CandySelect`
//! menu, which IS its right-click menu (`ContextMenuRoot`), held to the rulebook and
//! drawn like the strip's menu rows (`menu::Rows`): an icon and a name a row, the
//! hover patch under the pointed-at one (`pill::Highlight::hover`), a check on the picked (several can
//! be), a section header, a line between sections. It opens centred under its
//! button, 4 below it (`DROP_GAP`), or at the pointer for a right-click (Windows'
//! `openContextMenu` at the click); a click anywhere off it closes it (`layer`).
//! Sizes and lines Noctalia's (`lib/ui/controls/context_menu.cpp`, its popup chrome;
//! his picks 2026-11-09): rows 32, names 13, 8 in from the sides, a picture 4 from
//! its name, 6 round the rows, a section break 10; `layer`'s menu Noctalia's popup
//! shadow under it, no line round it (his ask 2026-11-09, late). The pictures stay 16
//! (the buttons' own; Noctalia's menu marks are 12).

use std::sync::atomic::{AtomicU64, Ordering};

use iced::advanced::text::{self, Paragraph as _};
use iced::widget::{column, container, image, mouse_area, opaque, pin, row, space, text as label};
use iced::{Alignment, Color, Element, Length, Padding, Pixels, Point, Renderer, Shadow, Size, Vector, border};

use crate::colours::Colours;
use crate::pill::Highlight;
use crate::style::{BODY, CONTROL_SM, CORNER, GAP_1, GAP_2, GAP_3, ICON, ICON_SM, LINE_TIGHT, MENU_INSET, MENU_RULE, SHADOW_ALPHA, SHADOW_BLUR, SHADOW_DROP, SMALL, STROKE};
use crate::{BOLD, MEDIUM};

pub use crate::icon::Pair;

/// Where the pointer is, kept by the event listener with no message: a right-click's
/// menu opens there (iced hands a right press no place, and a message a move would
/// build the window again at every pixel). x and y as bits, one number.
static POINTER: AtomicU64 = AtomicU64::new(0);

pub fn keep_pointer(at: Point) {
    POINTER.store(((at.x.to_bits() as u64) << 32) | at.y.to_bits() as u64, Ordering::Relaxed);
}

pub fn pointer() -> Point {
    let bits = POINTER.load(Ordering::Relaxed);
    Point::new(f32::from_bits((bits >> 32) as u32), f32::from_bits(bits as u32))
}

/// A right-click's menu place: its top-left corner at the pointer (Windows'
/// `openContextMenu`), above it when there is no room below.
pub fn at_pointer<M>(items: &[Item<'_, M>], at: Point, window: Size) -> Point {
    let high = height(items);
    Point::new(at.x, if at.y + high > window.height { at.y - high } else { at.y })
}

/// The menu at `at`, kept inside the window, over a layer the size of it: a click
/// anywhere off the menu sends `close`. A shadow under it (Noctalia's popup chrome);
/// `menu` alone, in a page (the recorder's), has none.
pub fn layer<'a, M: Clone + 'a>(items: Vec<Item<'a, M>>, check: Option<&Pair>, c: Colours, at: Point, window: Size, close: M) -> Element<'a, M> {
    let wide = width(&items);
    let x = at.x.clamp(0.0, (window.width - wide).max(0.0)).round();
    let y = at.y.max(0.0).round();
    let chrome = move |_: &iced::Theme| container::Style {
        background: Some(c.frame.into()),
        border: border::rounded(CORNER),
        shadow: Shadow { color: Color { a: SHADOW_ALPHA, ..Color::BLACK }, offset: Vector::new(0.0, SHADOW_DROP), blur_radius: SHADOW_BLUR },
        ..Default::default()
    };
    let shown = opaque(container(menu(items, check, c)).width(wide).style(chrome));
    mouse_area(pin(shown).x(x).y(y).width(Length::Fill).height(Length::Fill)).on_press(close.clone()).on_right_press(close).into()
}

pub struct Row<'a, M> {
    pub icon: Pair,
    /// Its name: a fixed word, or one of yours (a playlist's).
    pub label: &'a str,
    /// A small picture right after the name (the sort's direction).
    pub after: Option<Pair>,
    pub picked: bool,
    pub pick: M,
}

#[allow(clippy::large_enum_variant)] // a handful, made per frame only while open
pub enum Item<'a, M> {
    Header(&'static str),
    Row(Row<'a, M>),
}

/// The menu's width as `layer` shows it: its widest row, measured (a header is
/// always narrower).
pub fn width<M>(items: &[Item<'_, M>]) -> f32 {
    let widest = items
        .iter()
        .filter_map(|item| match item {
            Item::Row(r) => Some(text_width_at(r.label, SMALL, text::Shaping::Auto) + if r.after.is_some() { GAP_1 + ICON_SM as f32 } else { 0.0 }),
            Item::Header(_) => None,
        })
        .fold(0.0, f32::max);
    // Inset, row pad, icon, gap, name, gap, check, row pad, inset.
    (2.0 * MENU_INSET + GAP_2 + ICON as f32 + GAP_1 + widest + GAP_3 + ICON as f32 + GAP_2).ceil()
}

/// The menu's height as `layer` shows it: the inset, a row or header a small
/// control high, a section break before every header but a first one.
pub fn height<M>(items: &[Item<'_, M>]) -> f32 {
    let breaks = items.iter().skip(1).filter(|i| matches!(i, Item::Header(_))).count() as f32;
    2.0 * MENU_INSET + items.len() as f32 * CONTROL_SM + breaks * MENU_RULE
}

/// A line of body text's width, measured with the shaping it is drawn with (a
/// text widget's `Auto`, a text box's `Advanced`: kerning made "Search" a few
/// pixels wider than `Basic` measured it, and cut its last letter).
pub fn text_width(s: &str, shaping: text::Shaping) -> f32 {
    text_width_at(s, BODY, shaping)
}

/// `text_width` at another size (a menu's names, `SMALL`).
pub fn text_width_at(s: &str, size: f32, shaping: text::Shaping) -> f32 {
    <Renderer as text::Renderer>::Paragraph::with_text(text::Text {
        content: s,
        bounds: Size::INFINITE,
        size: Pixels(size),
        line_height: LINE_TIGHT.into(),
        font: MEDIUM,
        align_x: text::Alignment::Left,
        align_y: iced::alignment::Vertical::Center,
        shaping,
        wrapping: text::Wrapping::None,
    })
    .min_width()
}

pub fn menu<'a, M: Clone + 'a>(items: Vec<Item<'a, M>>, check: Option<&Pair>, c: Colours) -> Element<'a, M> {
    let mut parts: Vec<Element<'a, M>> = Vec::new();
    let mut group: Vec<Row<'a, M>> = Vec::new();
    let flush = |group: &mut Vec<Row<'a, M>>, parts: &mut Vec<Element<'a, M>>| {
        if group.is_empty() {
            return;
        }
        let rows: Vec<Row<'a, M>> = std::mem::take(group);
        let plain: Element<'a, M> = column(rows.iter().map(|r| {
            let mut name =
                row![image(r.icon.get(false)).width(ICON as f32).height(ICON as f32), label(r.label).size(SMALL).font(MEDIUM).line_height(LINE_TIGHT).color(c.text).wrapping(label::Wrapping::None)].spacing(GAP_1).align_y(Alignment::Center);
            if let Some(after) = &r.after {
                name = name.push(image(after.get(false)).width(ICON_SM as f32).height(ICON_SM as f32));
            }
            let mut line = row![name, space::horizontal()].align_y(Alignment::Center);
            if let (true, Some(check)) = (r.picked, check) {
                line = line.push(container(image(check.get(false)).width(ICON as f32).height(ICON as f32)).padding(Padding { left: GAP_3, ..Padding::ZERO }));
            }
            let cell = container(line).padding([0.0, GAP_2]).height(CONTROL_SM).width(Length::Fill).align_y(Alignment::Center);
            mouse_area(cell).on_press(r.pick.clone()).interaction(iced::mouse::Interaction::Pointer).into()
        }))
        .into();
        parts.push(Highlight::hover(plain, &c).corner(CORNER).into());
    };
    for item in items {
        match item {
            Item::Row(r) => group.push(r),
            Item::Header(h) => {
                let first = parts.is_empty() && group.is_empty();
                flush(&mut group, &mut parts);
                if !first {
                    // A section break draws one line (Windows' separator + header), on a
                    // whole pixel of Noctalia's 10 (it centres it at 4.5).
                    let line = container(space()).height(STROKE).width(Length::Fill).style(move |_| container::background(c.border));
                    parts.push(container(line).padding(Padding { top: GAP_1, ..Padding::ZERO }).height(MENU_RULE).into());
                }
                // A header: Noctalia's, bold in the second text colour.
                parts.push(container(label(h).size(SMALL).font(BOLD).line_height(LINE_TIGHT).color(c.text_muted)).padding([0.0, GAP_2]).height(CONTROL_SM).align_y(Alignment::Center).into());
            }
        }
    }
    flush(&mut group, &mut parts);
    container(column(parts)).padding(MENU_INSET).style(move |_| container::Style { background: Some(c.frame.into()), border: border::rounded(CORNER), ..Default::default() }).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn height_counts_items_and_a_break_before_each_later_header() {
        let edge = 2.0 * MENU_INSET;
        assert_eq!(height::<()>(&[]), edge);
        assert_eq!(height::<()>(&[Item::Header("a")]), edge + CONTROL_SM);
        assert_eq!(height::<()>(&[Item::Header("a"), Item::Header("b"), Item::Header("c")]), edge + 3.0 * CONTROL_SM + 2.0 * MENU_RULE);
    }
}
