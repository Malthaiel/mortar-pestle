//! What every native app draws with: the rulebook (`style`), mp-theme's colours,
//! motion, the one pop-up box, one-colour icons, covers, the sliding accent pill, hold-and-drag order, the default button bar, the in-window menu, the
//! scrolling list, the edge that sizes a side column, where a widget was laid out, the desktop's Open window, the frame's boxes
//! and the top box that holds widgets, pages that slide, the tab row, the on / off switch, text turned sideways, and the font (Ioskeley Mono).

pub mod ask;
pub mod bar;
pub mod colours;
pub mod cover;
pub mod drag;
pub mod drawer;
pub mod drop;
pub mod icon;
pub mod measured;
pub mod motion;
pub mod pill;
pub mod portal;
pub mod scroll;
pub mod seam;
pub mod shape;
pub mod slide;
pub mod style;
pub mod switch;
pub mod turned;

use iced::Font;

/// Ioskeley Mono, the one font (Noctalia Look, 2026-11-08): two static weights,
/// trimmed (`assets/README.md`). `FONT_TTF` is the Medium every measure reads.
pub const FONT_TTF: &[u8] = include_bytes!("../assets/IoskeleyMono-Medium.ttf");
pub const BOLD_TTF: &[u8] = include_bytes!("../assets/IoskeleyMono-Bold.ttf");
pub const FONT: Font = Font::with_name("Ioskeley Mono");
pub const MEDIUM: Font = Font { weight: style::WEIGHT, ..FONT };
pub const BOLD: Font = Font { weight: style::MENU_WEIGHT, ..FONT };

/// Points the drawing kit's font lookup at `~/.config/mp-shell/fonts.conf`, which
/// names only our own folder, so the start doesn't read every font in
/// `/usr/share/fonts` (388 MB from disk, measured 2026-10-30). Call first thing
/// in `main`, before any thread starts. The shell's service sets it itself.
pub fn only_our_font() {
    let conf = colours::config_dir().join("mp-shell/fonts.conf");
    if std::env::var_os("FONTCONFIG_FILE").is_none() && conf.is_file() {
        // SAFETY: called at the very start of main, while this is the only thread.
        unsafe { std::env::set_var("FONTCONFIG_FILE", conf) };
    }
}
