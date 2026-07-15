//! Capture's hotkey spec — the per-sidecar parameters for the shared Linux
//! GlobalShortcuts state layer (`mortar_pestle_daemon::hotkeys`). The shared
//! methods (`new_shortcuts`/`to_protocol`/`install_desktop_file`) are called as
//! `state::SPEC.method(..)` from `portal.rs`/`mod.rs`. The catalog + the 6 string
//! params (app-id, desktop basename/Name/Comment, exec-fallback) are the ONLY
//! per-sidecar state; the mechanism lives in the shared crate (D5-WI-1 Step 4).
//!
//! `state` is `#[cfg(target_os = "linux")]` at the `mod` declaration in
//! `hotkeys/mod.rs`, so this whole file compiles only on Linux (the Windows arm
//! uses the per-sidecar `winhook.rs`). The shared crate's `state_layer` is the
//! matching cfg gate; ashpd is a Linux-only target dep so broadcast never pulls it.

use mortar_pestle_daemon::hotkeys::{ShortcutDef, ShortcutsSpec};

/// The capture app-id — FROZEN (KDE persists bindings under it). The dash-free
/// form passes ashpd's typed `AppID` (a dash is allowed only in the last
/// segment). DISTINCT from stt's, so KDE keeps the two engines' bindings
/// separate.
pub const SPEC: ShortcutsSpec = ShortcutsSpec {
    app_id: "dev.malthaiel.mortar-pestle.capture",
    desktop_basename: "dev.malthaiel.mortar-pestle.capture.desktop",
    desktop_name: "Mortar & Pestle Capture",
    desktop_comment: "Game Capture engine (windowless)",
    exec_fallback: "mortar-pestle-capture",
    shortcuts: SHORTCUTS,
    active_id: None,
};

/// The catalog. `record` (start/stop toggle) + `overlay` (hold-to-show the
/// in-game capture HUD: press = Activated → show, release = Deactivated → hide)
/// are ACTIVE; `save_replay` + `screenshot` are reserved (bound now, inert) for
/// Phase 2. The overlay actions themselves (clip/record/screenshot) fire by
/// mouse-click in the HUD, NOT by these reserved shortcuts.
const SHORTCUTS: &[ShortcutDef] = &[
    ShortcutDef { id: "record", description: "Start or stop recording", preferred_trigger: "CTRL+ALT+r", reserved: false },
    ShortcutDef { id: "save_replay", description: "Save instant replay", preferred_trigger: "CTRL+ALT+s", reserved: true },
    ShortcutDef { id: "screenshot", description: "Capture a screenshot", preferred_trigger: "CTRL+ALT+h", reserved: true },
    ShortcutDef { id: "overlay", description: "Show the in-game capture overlay (hold)", preferred_trigger: "SHIFT+c", reserved: false },
];