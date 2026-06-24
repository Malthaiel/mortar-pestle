//! In-game overlay support — the always-on-top capture (A) + live scrim-notes (B)
//! windows that float over a borderless game.
//!
//! - [`kwin_rule`] auto-installs the KWin "Keep Above" window rule (Tauri/GTK
//!   always-on-top is an X11 hint KWin-Wayland ignores, so a compositor Force
//!   rule is the real keep-above mechanism).

pub mod kwin_rule;
/// Cross-window live-target (the active scrim/match the scrim-notes overlay
/// captures into) + the `overlay_go_live`/`_offline`/`_get_live_target` commands.
pub mod state;
