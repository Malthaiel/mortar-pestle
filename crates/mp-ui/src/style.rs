//! The rulebook (Noctalia Look, his picks 2026-11-08): the sizes of hooxoo's
//! Noctalia setup, measured on the picture where it shows them (2560x1440 at 1:1),
//! and Noctalia's own code numbers where it doesn't (`noctalia-dev/noctalia` at
//! `2f3e3c4f`, `lib/ui/style.h`), as the repo's CLAUDE.md § Native UI rulebook
//! lists them. More than three of a kind where Noctalia has more (his pick). Every
//! size, weight, gap and corner the apps draw comes from here; colours come from
//! mp-theme's `colours.toml` (`colours.rs`). A value not here gets asked for,
//! never invented.

use iced::font::Weight;

/// Text: Noctalia's mini, caption, body, title, header (`fontSize*`: 11 / 13 / 14 /
/// 16 / 20). `SMALL`, `BODY`, `TITLE` keep their names on caption, body, title.
pub const MINI: f32 = 11.0;
pub const SMALL: f32 = 13.0;
pub const BODY: f32 = 14.0;
pub const TITLE: f32 = 16.0;
pub const HEADER: f32 = 20.0;
/// The top bar's text: 15 on the picture (Ioskeley Mono, 9 px a letter, matched
/// by drawing it beside the clock).
pub const BAR_TEXT: f32 = 15.0;
/// Ioskeley Mono Medium everywhere (Noctalia's bar `font_weight` 500); Bold in the
/// strip's menus and its clock (his calls 2026-10-29, not yet redone).
pub const WEIGHT: Weight = Weight::Medium;
pub const MENU_WEIGHT: Weight = Weight::Bold;
/// Line heights: running text (`body`), and rows + the strip clock (`row`, `.strip-clock`).
pub const LINE: f32 = 1.45;
pub const LINE_TIGHT: f32 = 1.2;
/// Gaps and padding: Noctalia's `spaceXs` / `Sm` / `Md` / `Lg`.
pub const GAP_1: f32 = 4.0;
pub const GAP_2: f32 = 8.0;
pub const GAP_3: f32 = 12.0;
pub const GAP_4: f32 = 16.0;
/// Icons: Noctalia's row glyph (body 14), its button and bar glyph (`baseGlyphSize`
/// 16, the picture's bar), its header glyph (20).
pub const ICON_SM: u32 = 14;
pub const ICON: u32 = 16;
pub const ICON_LG: u32 = 20;
/// The one corner: none. The picture is square everywhere (Noctalia's
/// `corner_radius_scale` 0).
pub const CORNER: f32 = 0.0;
/// Buttons, rows, text boxes: Noctalia's `controlHeight`; its small and large too.
pub const CONTROL_SM: f32 = 32.0;
pub const CONTROL: f32 = 38.0;
pub const CONTROL_LG: f32 = 44.0;
/// A hover: a patch of the face's own text colour, Noctalia's bar hover fill
/// (`kWidgetHoverFillAlpha` 0.1, `src/shell/bar/bar.cpp`).
pub const HOVER: f32 = 0.1;
/// Out of reach (another month's day): `opacity: 0.4`.
pub const FADED: f32 = 0.4;
/// The top bar (Noctalia Look step 2), the picture's numbers: 38 tall across the top
/// of each screen; its boxes (Noctalia's capsules) 24 tall in its middle, padded 10
/// inside (hooxoo's `capsule_padding`), and pictures sharing a box are `BAR_PAD` apart.
pub const BAR: f32 = 38.0;
pub const BAR_BOX: f32 = 24.0;
pub const BAR_PAD: f32 = 10.0;
/// The blank above and below the bar's boxes, also beside every box and bare picture
/// (to its drawing: from the screen's ends and from each other) and between windows
/// (niri's `gaps`): his ask 2026-11-09, "the space above/bellow/left/right of all the
/// pills/icons is the same", then windows to 7 too so they line up with the boxes.
pub const BAR_GAP: f32 = (BAR - BAR_BOX) / 2.0;
/// A hover patch over one picture in a shared box stops this short of the box's top
/// and bottom (Noctalia's `kGroupHoverCrossInset`).
pub const BAR_INSET: f32 = 2.0;
/// The old strip's pill, 40 (Caelestia's, his call 2026-10-30): now only a button
/// bar's track (`bar::Bar`), not yet redone (Noctalia Look step 7).
pub const STRIP_PILL: f32 = 40.0;
/// A menu's inset (`--menu-pad`).
pub const MENU_PAD: f32 = GAP_2;
/// The inset round a floating bar panel's insides: Noctalia's `panelPadding` (Noctalia
/// Look step 7).
pub const PANEL_PAD: f32 = 14.0;
/// A drop menu (`drop::menu`, Noctalia's `lib/ui/controls/context_menu.cpp`): the
/// inset round its rows (`kMenuPadding`) and a section break's height
/// (`kSeparatorHeight`, the line in it).
pub const MENU_INSET: f32 = 6.0;
pub const MENU_RULE: f32 = 10.0;
/// A line round a box or a menu: Noctalia's `borderWidth`.
pub const STROKE: f32 = 1.0;
/// The shadow under a drop menu: Noctalia's popup shadow (`[shell.shadow]` defaults,
/// `lib/ui/surface_shadow.h`): black at 0.55, 2 down, blurred 12.
pub const SHADOW_ALPHA: f32 = 0.55;
pub const SHADOW_DROP: f32 = 2.0;
pub const SHADOW_BLUR: f32 = 12.0;
/// A scroll bar: Noctalia's `scrollbarWidth` (Windows' too), its groove and handle
/// drawn at this share of their colours (`scrollbarTrackColor` / `ThumbColor`).
pub const SCROLL_BAR: f32 = 6.0;
pub const SCROLL_ALPHA: f32 = 0.5;
