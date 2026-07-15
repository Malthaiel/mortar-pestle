//! STT's hotkey spec — the per-sidecar parameters for the shared Linux
//! GlobalShortcuts state layer (`mortar_pestle_daemon::hotkeys`). The shared
//! methods are called as `state::SPEC.method(..)` from `portal.rs`/`mod.rs`. The
//! catalog + the 6 string params + the single active shortcut id are the ONLY
//! per-sidecar state; the mechanism lives in the shared crate (D5-WI-1 Step 4).
//!
//! `state` is `#[cfg(target_os = "linux")]` at the `mod` declaration in
//! `hotkeys/mod.rs`, so this whole file compiles only on Linux (the Windows arm
//! uses the per-sidecar `winhook.rs`). The shared crate's `state_layer` is the
//! matching cfg gate; ashpd is a Linux-only target dep so broadcast never pulls it.

use mortar_pestle_daemon::hotkeys::{ShortcutDef, ShortcutsSpec};

/// The STT app-id — FROZEN (KDE persists the binding under it). DISTINCT from
/// capture's `dev.malthaiel.mortar-pestle.capture`, so KDE keeps the two engines'
/// bindings separate.
pub const SPEC: ShortcutsSpec = ShortcutsSpec {
    app_id: "dev.malthaiel.mortar-pestle.stt",
    desktop_basename: "dev.malthaiel.mortar-pestle.stt.desktop",
    desktop_name: "Mortar & Pestle Voice",
    desktop_comment: "Voice transcription engine (windowless)",
    exec_fallback: "mortar-pestle-stt",
    shortcuts: SHORTCUTS,
    active_id: Some(DICTATE_ID),
};

/// The catalog. `dictate` is the only shortcut — HOLD-to-talk: press (`Activated`)
/// starts dictation, release (`Deactivated`) stops it. Preferred `CTRL+SHIFT+SPACE`
/// (the compositor may honor / ignore / reassign — the snapshot carries the truth).
const SHORTCUTS: &[ShortcutDef] = &[
    ShortcutDef { id: "dictate", description: "Push-to-talk dictation", preferred_trigger: "CTRL+SHIFT+SPACE", reserved: false },
];

/// The id of the push-to-talk shortcut (the only ACTIVE one). Kept as a const so
/// `portal.rs` references `state::DICTATE_ID` unchanged. `winhook.rs` has its own
/// `DICTATE_ID` (the Windows arm is self-contained — it does not reach `state`).
pub const DICTATE_ID: &str = "dictate";