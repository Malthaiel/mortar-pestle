//! Static hotkey catalog, app-id, and the `.desktop` self-install (Voice
//! Transcription Phase 5 SF5). Faithful clone of `iskariel-capture`'s hotkeys/state
//! with the STT app-id + a single push-to-talk shortcut.
//!
//! The GlobalShortcuts portal keys every binding by an app-id, and the host
//! `org.freedesktop.host.portal.Registry` resolves that app-id to an INSTALLED
//! `.desktop` via GIO — which REJECTS any `.desktop` whose `Exec` program is not
//! resolvable (the rejection surfaces as the opaque "App info not found"). So the
//! daemon self-installs `<APP_ID>.desktop` with an ABSOLUTE `Exec=<current_exe>
//! daemon` — correct in dev (target/{debug,release}) AND in the bundled RPM.
//!
//! App-id is the DASH-FREE `dev.malthaiel.iskariel.stt` (a dash is allowed only in
//! the last segment of ashpd's typed `AppID`). DISTINCT from capture's
//! `dev.malthaiel.iskariel.capture`, so KDE keeps the two engines' bindings separate.
//! FROZEN once bound — KDE persists the user's trigger under this exact string.

use std::path::PathBuf;

use ashpd::desktop::global_shortcuts::NewShortcut;

use crate::protocol::Shortcut;

/// The GlobalShortcuts app-id — FROZEN (KDE persists the binding under it).
pub const APP_ID: &str = "dev.malthaiel.iskariel.stt";

/// `<APP_ID>.desktop` — the host Registry resolves the app-id to this file.
pub const DESKTOP_BASENAME: &str = "dev.malthaiel.iskariel.stt.desktop";

/// One reservable global shortcut.
pub struct ShortcutDef {
    pub id: &'static str,
    pub description: &'static str,
    /// XDG "shortcuts" spec trigger string — the PREFERRED default. The user may
    /// rebind, so the snapshot always carries KDE's actual `trigger_description`.
    pub preferred_trigger: &'static str,
    pub reserved: bool,
}

/// The catalog. `dictate` is the only shortcut — HOLD-to-talk: press (`Activated`)
/// starts dictation, release (`Deactivated`) stops it. Preferred `CTRL+SHIFT+SPACE`
/// (the compositor may honor / ignore / reassign — the snapshot carries the truth).
pub const SHORTCUTS: &[ShortcutDef] = &[
    ShortcutDef { id: "dictate", description: "Push-to-talk dictation", preferred_trigger: "CTRL+SHIFT+SPACE", reserved: false },
];

/// The id of the push-to-talk shortcut (the only ACTIVE one).
pub const DICTATE_ID: &str = "dictate";

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
/// wire `Shortcut`s, attaching each catalog `reserved` flag.
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
/// ABSOLUTE `Exec=<current_exe> daemon`. Idempotent; best-effort.
pub fn install_desktop_file() {
    let exec = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "iskariel-stt".to_owned());
    let body = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Iskariel Voice\n\
         Comment=Voice transcription engine (windowless)\n\
         Exec={exec} daemon\n\
         Icon=dev.malthaiel.iskariel\n\
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
    // Best-effort: nudge GIO's app-info cache so the portal resolves the new file.
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
