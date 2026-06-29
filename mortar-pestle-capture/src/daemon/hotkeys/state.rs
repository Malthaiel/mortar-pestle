//! Static hotkey catalog, app-id, and the `.desktop` self-install (sub-plan 5 SF3).
//!
//! The GlobalShortcuts portal keys every binding by an app-id, and the host
//! `org.freedesktop.host.portal.Registry` resolves that app-id to an INSTALLED
//! `.desktop` via GIO — which REJECTS any `.desktop` whose `Exec` program is not
//! resolvable on PATH (the rejection surfaces from the portal as the opaque
//! "App info not found"). So the daemon self-installs `<APP_ID>.desktop` with an
//! ABSOLUTE `Exec=<current_exe> daemon` — correct in dev (target/debug) AND in the
//! bundled RPM (where the binary lives under resources/, off PATH).
//!
//! App-id is the DASH-FREE `dev.malthaiel.mortar-pestle.capture`. Spike-confirmed: the KDE
//! portal accepts both the dashed (`dev.malthaiel.mortar-pestle.capture`) and dash-free
//! forms, but only the dash-free one passes ashpd's typed `AppID` validation (a dash
//! is allowed only in the last segment), so we register via the clean typed
//! `register_host_app_with_connection` instead of a raw zbus proxy. FROZEN once
//! bound — KDE persists the user's triggers under this exact string.

use std::path::PathBuf;

use ashpd::desktop::global_shortcuts::NewShortcut;

use crate::daemon::protocol::Shortcut;

/// The GlobalShortcuts app-id — FROZEN (KDE persists bindings under it).
pub const APP_ID: &str = "dev.malthaiel.mortar-pestle.capture";

/// `<APP_ID>.desktop` — the host Registry resolves the app-id to this file.
pub const DESKTOP_BASENAME: &str = "dev.malthaiel.mortar-pestle.capture.desktop";

/// One reservable global shortcut. `reserved` shortcuts are bound now (so a Phase-2
/// activation needs no fresh consent prompt) but the daemon ignores their
/// activations — surfaced as `reserved:true` in the snapshot for the Settings UI.
pub struct ShortcutDef {
    pub id: &'static str,
    pub description: &'static str,
    /// XDG "shortcuts" spec trigger string — the PREFERRED default. The user may
    /// rebind, so the snapshot always carries KDE's actual `trigger_description`.
    pub preferred_trigger: &'static str,
    pub reserved: bool,
}

/// The catalog. `record` (start/stop toggle) + `overlay` (hold-to-show the
/// in-game capture HUD: press = Activated → show, release = Deactivated → hide)
/// are ACTIVE; `save_replay` + `screenshot` are reserved (bound now, inert) for
/// Phase 2. The overlay actions themselves (clip/record/screenshot) fire by
/// mouse-click in the HUD, NOT by these reserved shortcuts.
pub const SHORTCUTS: &[ShortcutDef] = &[
    ShortcutDef { id: "record", description: "Start or stop recording", preferred_trigger: "CTRL+ALT+r", reserved: false },
    ShortcutDef { id: "save_replay", description: "Save instant replay", preferred_trigger: "CTRL+ALT+s", reserved: true },
    ShortcutDef { id: "screenshot", description: "Capture a screenshot", preferred_trigger: "CTRL+ALT+h", reserved: true },
    ShortcutDef { id: "overlay", description: "Show the in-game capture overlay (hold)", preferred_trigger: "SHIFT+c", reserved: false },
];

/// Build the ashpd `NewShortcut` list for `BindShortcuts` from the catalog.
pub fn new_shortcuts() -> Vec<NewShortcut> {
    SHORTCUTS
        .iter()
        .map(|s| NewShortcut::new(s.id, s.description).preferred_trigger(s.preferred_trigger))
        .collect()
}

/// Look up a catalog entry by id (for the `reserved` flag + a fallback description).
fn lookup(id: &str) -> Option<&'static ShortcutDef> {
    SHORTCUTS.iter().find(|s| s.id == id)
}

/// Map the portal's listed/bound shortcuts (id + KDE's live descriptions) into the
/// wire `Shortcut`s, attaching each catalog `reserved` flag. Unknown ids (shouldn't
/// happen) pass through as non-reserved with whatever KDE reported.
pub fn to_protocol(listed: &[ashpd::desktop::global_shortcuts::Shortcut]) -> Vec<Shortcut> {
    listed
        .iter()
        .map(|s| {
            let def = lookup(s.id());
            let kde_desc = s.description();
            Shortcut {
                id: s.id().to_owned(),
                description: if kde_desc.is_empty() {
                    def.map(|d| d.description.to_owned()).unwrap_or_default()
                } else {
                    kde_desc.to_owned()
                },
                trigger_description: s.trigger_description().to_owned(),
                reserved: def.map(|d| d.reserved).unwrap_or(false),
            }
        })
        .collect()
}

/// Self-install `<APP_ID>.desktop` to `~/.local/share/applications/` with an
/// ABSOLUTE `Exec=<current_exe> daemon`. Idempotent; best-effort — a write failure
/// is logged, never fatal (GlobalShortcuts still binds via the portal's automatic
/// app-id detection; only cross-restart binding persistence needs the registration).
pub fn install_desktop_file() {
    let exec = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "mortar-pestle-capture".to_owned());
    let body = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Mortar & Pestle Capture\n\
         Comment=Game Capture engine (windowless)\n\
         Exec={exec} daemon\n\
         Icon=dev.malthaiel.mortar-pestle\n\
         Terminal=false\n\
         NoDisplay=true\n\
         X-KDE-GlobalShortcuts=true\n"
    );
    let dir = applications_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("hotkeys: could not create {}: {e}", dir.display());
        return;
    }
    let path = dir.join(DESKTOP_BASENAME);
    if let Err(e) = std::fs::write(&path, body) {
        log::warn!("hotkeys: could not write {}: {e}", path.display());
        return;
    }
    log::info!("hotkeys: installed {} (Exec={exec} daemon)", path.display());
    // Best-effort: nudge GIO's app-info cache so the portal resolves the new file
    // on THIS run (it monitors the dir, but update-desktop-database is immediate).
    if let Some(db) = which("update-desktop-database") {
        let _ = std::process::Command::new(db).arg(&dir).status();
    }
}

/// `$XDG_DATA_HOME/applications` (fallback `~/.local/share/applications`).
fn applications_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let mut h = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
            h.push(".local/share");
            h
        });
    base.join("applications")
}

/// Minimal PATH lookup (no `which` crate dep) for the existence-guarded shell-out.
fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|cand| cand.is_file())
}
