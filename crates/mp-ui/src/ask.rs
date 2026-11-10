//! The one pop-up box (File Explorer plan step 2): Discord's "Delete Message" window
//! (his pick 2026-11-01). A Raised card `WIDTH` wide (`bare`: no title, as wide as what it holds): a title, its words, what it's
//! about (a look at a message, a text box), and its buttons at the bottom right.
//! `over` centres it on the window faded to the frame colour (a click off it
//! closes it); `under` hangs it below a spot with nothing faded (GNOME Files'
//! rename box under the file).

use iced::widget::{button, column, container, mouse_area, opaque, row, space, stack, text};
use iced::{Color, Element, Length, Padding, Point, Size, border};

use crate::colours::Colours;
use crate::style::{BODY, CONTROL, CORNER, FADED, GAP_1, GAP_2, GAP_3, HOVER, LINE, LINE_TIGHT, TITLE};

pub const WIDTH: f32 = 440.0;

/// A pill button: `inside` on `face`, `high` tall, `pad` each side, the hover patch
/// of its own `words` colour (Chat's buttons and reactions, the boxes' choices).
pub fn press<'a, Message: Clone + 'a>(inside: impl Into<Element<'a, Message>>, high: f32, pad: f32, face: Color, words: Color, on: Message) -> Element<'a, Message> {
    let pill = button(container(inside).center_y(Length::Fill)).height(high).padding(Padding { left: pad, right: pad, ..Padding::ZERO }).on_press(on).style(move |_, s| button::Style {
        background: matches!(s, button::Status::Hovered | button::Status::Pressed).then(|| words.scale_alpha(HOVER).into()),
        border: border::rounded(CORNER),
        ..Default::default()
    });
    container(pill).style(move |_| container::Style { background: Some(face.into()), border: border::rounded(CORNER), ..Default::default() }).into()
}

/// A box's choice: its words on `face` (clear for Cancel), control height.
pub fn choice<'a, Message: Clone + 'a>(words: &'a str, face: Color, colour: Color, on: Message) -> Element<'a, Message> {
    press(text(words).size(BODY).line_height(LINE_TIGHT).color(colour), CONTROL, GAP_3, face, colour, on)
}

/// The card: title, words (muted), what it's about, the choices at the right. No
/// choices: a box that only tells, closed by a click off it or Esc (a button that
/// only closes is an X, and boxes have none).
pub fn card<'a, Message: Clone + 'a>(title: impl text::IntoFragment<'a>, words: Option<String>, inside: Option<Element<'a, Message>>, choices: Vec<Element<'a, Message>>, c: &Colours) -> Element<'a, Message> {
    let c = *c;
    let mut parts: Vec<Element<'a, Message>> = vec![text(title).size(TITLE).line_height(LINE_TIGHT).color(c.text).into()];
    if let Some(w) = words {
        parts.push(text(w).size(BODY).line_height(LINE).color(c.text_muted).into());
    }
    parts.extend(inside);
    if !choices.is_empty() {
        let mut line = vec![space().width(Length::Fill).into()];
        line.extend(choices);
        parts.push(row(line).spacing(GAP_2).into());
    }
    container(column(parts).spacing(GAP_3).padding(GAP_3).width(WIDTH)).style(move |_| raised(c)).into()
}

/// The card holding only `inside`, no title, as wide as it (the shell's capture pop-ups:
/// a row of picture tiles, its settings page sliding in).
pub fn bare<'a, Message: 'a>(inside: impl Into<Element<'a, Message>>, c: &Colours) -> Element<'a, Message> {
    let c = *c;
    container(inside).padding(GAP_3).style(move |_| raised(c)).into()
}

fn raised(c: Colours) -> container::Style {
    container::Style { background: Some(c.raised.into()), border: border::rounded(CORNER), ..Default::default() }
}

/// The card centred over the window, faded to the frame colour; a click off it is `close`.
pub fn over<'a, Message: Clone + 'a>(card: Element<'a, Message>, close: Message, c: &Colours) -> Element<'a, Message> {
    let frame = c.frame;
    let dim = container(opaque(card)).center(Length::Fill).style(move |_| container::background(frame.scale_alpha(1.0 - FADED)));
    opaque(mouse_area(dim).on_press(close))
}

/// The card hung a gap below `at` (its top centre), moved in to stay inside `window`
/// (`tall` its height, to go above `above` when there's no room below); a click off
/// it is `close`.
pub fn under<'a, Message: Clone + 'a>(card: Element<'a, Message>, at: Point, above: f32, tall: f32, window: Size, close: Message) -> Element<'a, Message> {
    let x = (at.x - WIDTH / 2.0).clamp(GAP_2, (window.width - WIDTH - GAP_2).max(GAP_2));
    let below = at.y + GAP_1;
    let y = if below + tall + GAP_2 <= window.height { below } else { (above - GAP_1 - tall).max(GAP_2) };
    let placed = container(opaque(card)).padding(Padding { left: x, top: y, ..Padding::ZERO });
    stack![opaque(mouse_area(space().width(Length::Fill).height(Length::Fill)).on_press(close)), placed].into()
}
