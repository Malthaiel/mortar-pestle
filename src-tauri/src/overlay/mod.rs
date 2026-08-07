//! In-game overlay support — the always-on-top capture (A) + live scrim-notes (B)
//! windows that float over a borderless game.
//!
//!
//! Keep-above is `set_always_on_top` on each overlay window. The KWin Force-rule
//! installer this module used to carry was Linux/KDE-only and went with the
//! platform (2026-08-06).

/// Cross-window live-target (the active scrim/match the scrim-notes overlay
/// captures into) + the `overlay_go_live`/`_offline`/`_get_live_target` commands.
pub mod state;
