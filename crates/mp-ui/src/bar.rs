//! The default button bar, used wherever buttons sit in a pill (his call
//! 2026-10-31: one component copied everywhere, the strip's size): a track 40 thick
//! (`STRIP_PILL`), square since Noctalia Look step 6, its items a gap-1 apart and a
//! gap-1 in from each end, the accent pill 32 thick (`SLOT`: the track less a gap-1 each
//! side) resting on one item or none, the hovered one under Noctalia's patch
//! (`pill::Highlight`). Down a column (the strip) or across a row (the music
//! box). Raised, as the strip's; `.on(colour)` for another track (the music box's
//! bars sit in Frame, as Windows' `.icon-bar`). A `.lead` sits in the track before
//! the items, out of the pill's reach (the music box's search boxes); with no items
//! it is the whole bar, a gap-1 in from each end. A `.tail` the same, after them (the
//! internet's search box, Home before it: Windows' `LibrarySearchBar`).
//!
//! ```ignore
//! Bar::new(plain, lit, Some(0), held, &colours).across().on(colours.frame)
//! ```
//! `plain` and `lit` are the same items drawn plain (taking the pointer) and in On
//! Accent; each item `SLOT` thick across the bar (`icon` makes one).

use iced::widget::{column, container, image, row};
use iced::{Alignment, Color, Element, Padding, border};

use crate::colours::Colours;
use crate::pill::Highlight;
use crate::style::{CORNER, FADED, GAP_1, ICON, STRIP_PILL};

/// The track's thickness.
pub const THICK: f32 = STRIP_PILL;
/// An item's thickness, and the accent pill's.
pub const SLOT: f32 = THICK - 2.0 * GAP_1;

pub struct Bar<'a, Message> {
    plain: Vec<Element<'a, Message>>,
    lit: Vec<Element<'a, Message>>,
    rest: Option<usize>,
    held: Option<usize>,
    colours: Colours,
    track: Color,
    across: bool,
    lead: Option<Element<'a, Message>>,
    tail: Option<Element<'a, Message>>,
    skip: Vec<usize>,
}

impl<'a, Message: 'a> Bar<'a, Message> {
    /// `rest`: the item the accent pill rests on (none: no pill);
    /// `held`: the item whose menu shows.
    pub fn new(plain: Vec<Element<'a, Message>>, lit: Vec<Element<'a, Message>>, rest: Option<usize>, held: Option<usize>, c: &Colours) -> Self {
        Self { plain, lit, rest, held, colours: *c, track: c.raised, across: false, lead: None, tail: None, skip: Vec::new() }
    }

    pub fn across(mut self) -> Self {
        self.across = true;
        self
    }

    pub fn on(mut self, track: Color) -> Self {
        self.track = track;
        self
    }

    pub fn lead(mut self, lead: impl Into<Element<'a, Message>>) -> Self {
        self.lead = Some(lead.into());
        self
    }

    pub fn tail(mut self, tail: impl Into<Element<'a, Message>>) -> Self {
        self.tail = Some(tail.into());
        self
    }

    /// Items greyed out: no hover patch on them (draw them `faded`, with no
    /// press).
    pub fn skip(mut self, skip: Vec<usize>) -> Self {
        self.skip = skip;
        self
    }
}

/// An icon item: the picture centred in a `SLOT` square.
pub fn icon<'a, Message: 'a>(picture: image::Handle) -> Element<'a, Message> {
    container(image(picture).width(ICON as f32).height(ICON as f32)).center(SLOT).into()
}

/// An icon item out of reach: its plain picture at the rulebook's `FADED`, the same in
/// both copies.
pub fn faded<'a, Message: 'a>(picture: image::Handle) -> Element<'a, Message> {
    container(image(picture).width(ICON as f32).height(ICON as f32).opacity(FADED)).center(SLOT).into()
}

impl<'a, Message: 'a> From<Bar<'a, Message>> for Element<'a, Message> {
    fn from(b: Bar<'a, Message>) -> Self {
        let across = b.across;
        let alone = b.plain.is_empty();
        let line = |items: Vec<Element<'a, Message>>| -> Element<'a, Message> {
            if across { row(items).spacing(GAP_1).padding([0.0, GAP_1]).align_y(Alignment::Center).into() } else { column(items).spacing(GAP_1).padding([GAP_1, 0.0]).align_x(Alignment::Center).into() }
        };
        let mut pill = Highlight::new(line(b.plain), line(b.lit), b.rest, b.held, &b.colours).thick(SLOT).skip(b.skip);
        if across {
            pill = pill.across();
        }
        let content: Element<'a, Message> = match b.lead {
            Some(lead) if alone => container(lead).padding(if across { [0.0, GAP_1] } else { [GAP_1, 0.0] }).into(),
            Some(lead) if across => row![container(lead).padding(Padding { left: GAP_1, ..Padding::ZERO }), pill].align_y(Alignment::Center).into(),
            Some(lead) => column![container(lead).padding(Padding { top: GAP_1, ..Padding::ZERO }), pill].align_x(Alignment::Center).into(),
            None => pill.into(),
        };
        let content: Element<'a, Message> = match b.tail {
            Some(tail) if across => row![content, container(tail).padding(Padding { right: GAP_1, ..Padding::ZERO })].align_y(Alignment::Center).into(),
            Some(tail) => column![content, container(tail).padding(Padding { bottom: GAP_1, ..Padding::ZERO })].align_x(Alignment::Center).into(),
            None => content,
        };
        let track = b.track;
        let bar = container(content).style(move |_| container::Style { background: Some(track.into()), border: border::rounded(CORNER), ..Default::default() });
        if across { bar.height(THICK).align_y(Alignment::Center).into() } else { bar.width(THICK).align_x(Alignment::Center).into() }
    }
}
