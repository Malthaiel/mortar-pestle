//! Shared NDJSON daemon transport/framing for the mortar-pestle sidecars
//! (capture, stt, broadcast).
//!
//! Two sharing tiers (see `Knowledge/Mortar & Pestle/Plans/Sidecar Daemon Dedup.md`):
//!   - 3-WAY (all 3 sidecars link): `framing`, `clock`, `pipe` [cfg(windows)].
//!   - 2-WAY (capture+stt only, broadcast EXCLUDED): `envelope`, `sock` [cfg(unix)].
//!
//! Per-module `pub mod` (NOT a blanket `pub use`) so a sidecar imports only the
//! tier it consumes — broadcast links the crate for `framing`/`clock`/`pipe` and
//! never pulls `envelope`/`sock` into its namespace.

pub mod clock;
pub mod envelope;
pub mod framing;
#[cfg(unix)]
pub mod sock;
#[cfg(windows)]
pub mod pipe;

pub use framing::MAX_LINE_BYTES;