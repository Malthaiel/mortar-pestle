//! Shared NDJSON daemon transport/framing for the mortar-pestle sidecars
//! (capture, stt, broadcast).
//!
//! Two sharing tiers (see `Knowledge/Mortar & Pestle/Plans/Sidecar Daemon Dedup.md`):
//!   - 3-WAY (all 3 sidecars link): `framing`, `clock`, `pipe` [cfg(windows)].
//!   - 2-WAY (capture+stt only, broadcast EXCLUDED): `envelope`, `sock` [cfg(unix)],
//!     `hotkeys` (wire types all-platforms + a Linux GlobalShortcuts state layer).
//!
//! Per-module `pub mod` (NOT a blanket `pub use`) so a sidecar imports only the
//! tier it consumes — broadcast links the crate for `framing`/`clock`/`pipe` and
//! never pulls `envelope`/`sock`/`hotkeys` into its namespace.

pub mod clock;
pub mod envelope;
pub mod framing;
/// 2-WAY hotkey wire types (`Shortcut`/`HotkeysSnapshot`, all platforms) + the
/// Linux GlobalShortcuts state layer (`ShortcutDef`/`ShortcutsSpec`, cfg-gated).
/// See `hotkeys.rs` for the fold doctrine.
pub mod hotkeys;
#[cfg(unix)]
pub mod sock;
#[cfg(windows)]
pub mod pipe;

pub use framing::MAX_LINE_BYTES;