//! 2-WAY shared hotkey wire types + the Linux GlobalShortcuts state layer
//! (capture + stt ONLY — broadcast EXCLUDED by convention; broadcast links this
//! crate for framing/clock/pipe and never imports `hotkeys`, the same doctrine
//! as `envelope`).
//!
//! `Shortcut` + `HotkeysSnapshot` are byte-identical to the pre-fold per-sidecar
//! defs (`mortar-pestle-capture/src/daemon/protocol.rs:46-63` and
//! `mortar-pestle-stt/src/protocol.rs:217-234`) — re-exported by each sidecar's
//! `protocol.rs` via `pub use` (wire bytes unchanged: serde derives generate from
//! the struct definition, not the crate location — the same doctrine as the
//! envelope fold in Steps 0-3).
//!
//! The Linux state layer (`ShortcutDef`/`ShortcutsSpec` + the catalog helpers)
//! is the fold of both sidecars' `state.rs`, parameterized by a per-sidecar
//! `ShortcutsSpec` DATA struct — 0 type params (under the ponytail 2-non-IO-param
//! ceiling that kept `serve_conn` per-sidecar). Each sidecar declares a
//! `pub const SPEC: ShortcutsSpec` and calls the shared methods as
//! `SPEC.new_shortcuts()` / `SPEC.to_protocol(..)` / `SPEC.install_desktop_file()`.
//! `#[cfg(target_os = "linux")]`-gated: the Windows dev box compiles it out
//! (Windows uses the per-sidecar `winhook.rs`); `ashpd` is a Linux-only target
//! dep so broadcast (Windows-only) never pulls it. The state layer is verified
//! by line-by-line diff against the original per-sidecar `state.rs` — `cargo
//! check` on Windows does NOT exercise it (a compiled-out module can drift
//! silently; the diff is the catch, per the synthesized-drift lesson).

use serde::{Deserialize, Serialize};

/// One bound shortcut (wire). Byte-identical to the pre-fold per-sidecar defs.
/// `trigger_description` is what KDE ACTUALLY bound (may differ from the
/// requested default — the rebindability rule). Declaration order is the wire
/// field order (serde serializes in declaration order).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shortcut {
    pub id: String,
    pub description: String,
    pub trigger_description: String,
    pub reserved: bool,
}

/// The bound global-shortcut state (wire). `bound:false` + `last_error` when the
/// portal is unavailable. `last_error` has NO `skip_serializing_if` → `None`
/// emits `null` (mirrors the pre-fold per-sidecar defs byte-for-byte).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeysSnapshot {
    pub bound: bool,
    pub portal_version: u32,
    pub can_configure: bool,
    pub shortcuts: Vec<Shortcut>,
    pub last_error: Option<String>,
}

// ── Linux GlobalShortcuts state layer ───────────────────────────────────────
#[cfg(target_os = "linux")]
mod state_layer {
    use std::path::PathBuf;

    use ashpd::desktop::global_shortcuts::NewShortcut;

    use super::Shortcut;

    /// One reservable global shortcut. `reserved` shortcuts are bound now (so a
    /// Phase-2 activation needs no fresh consent prompt) but the daemon ignores
    /// their activations — surfaced as `reserved:true` in the snapshot for the
    /// Settings UI.
    pub struct ShortcutDef {
        pub id: &'static str,
        pub description: &'static str,
        /// XDG "shortcuts" spec trigger string — the PREFERRED default. The user
        /// may rebind, so the snapshot always carries KDE's actual
        /// `trigger_description`.
        pub preferred_trigger: &'static str,
        pub reserved: bool,
    }

    /// The per-sidecar hotkey spec — a DATA struct (0 type params). Each sidecar
    /// declares a `pub const SPEC: ShortcutsSpec` and the shared methods read off
    /// it. `active_id` is the single active shortcut id (stt = `"dictate"`;
    /// capture = `None` — it dispatches multiple active shortcuts by id in
    /// `portal.rs`).
    pub struct ShortcutsSpec {
        pub app_id: &'static str,
        pub desktop_basename: &'static str,
        pub desktop_name: &'static str,
        pub desktop_comment: &'static str,
        pub exec_fallback: &'static str,
        pub shortcuts: &'static [ShortcutDef],
        pub active_id: Option<&'static str>,
    }

    impl ShortcutsSpec {
        /// Build the ashpd `NewShortcut` list for `BindShortcuts` from the catalog.
        pub fn new_shortcuts(&self) -> Vec<NewShortcut> {
            self.shortcuts
                .iter()
                .map(|s| NewShortcut::new(s.id, s.description).preferred_trigger(s.preferred_trigger))
                .collect()
        }

        /// Look up a catalog entry by id (for the `reserved` flag + a fallback
        /// description).
        fn lookup(&self, id: &str) -> Option<&'static ShortcutDef> {
            self.shortcuts.iter().find(|s| s.id == id)
        }

        /// Map the portal's listed/bound shortcuts (id + KDE's live descriptions)
        /// into the wire `Shortcut`s, attaching each catalog `reserved` flag.
        /// Unknown ids (shouldn't happen) pass through as non-reserved with
        /// whatever KDE reported.
        pub fn to_protocol(
            &self,
            listed: &[ashpd::desktop::global_shortcuts::Shortcut],
        ) -> Vec<Shortcut> {
            listed
                .iter()
                .map(|s| {
                    let def = self.lookup(s.id());
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

        /// Self-install `<APP_ID>.desktop` to `~/.local/share/applications/` with
        /// an ABSOLUTE `Exec=<current_exe> daemon`. Idempotent; best-effort — a
        /// write failure is logged, never fatal (GlobalShortcuts still binds via
        /// the portal's automatic app-id detection; only cross-restart binding
        /// persistence needs the registration).
        pub fn install_desktop_file(&self) {
            let exec = std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| self.exec_fallback.to_owned());
            let body = format!(
                "[Desktop Entry]\n\
                 Type=Application\n\
                 Name={name}\n\
                 Comment={comment}\n\
                 Exec={exec} daemon\n\
                 Icon=dev.malthaiel.mortar-pestle\n\
                 Terminal=false\n\
                 NoDisplay=true\n\
                 X-KDE-GlobalShortcuts=true\n",
                name = self.desktop_name,
                comment = self.desktop_comment,
            );
            let dir = applications_dir();
            if let Err(e) = std::fs::create_dir_all(&dir) {
                log::warn!("hotkeys: could not create {}: {e}", dir.display());
                return;
            }
            let path = dir.join(self.desktop_basename);
            if let Err(e) = std::fs::write(&path, body) {
                log::warn!("hotkeys: could not write {}: {e}", path.display());
                return;
            }
            log::info!("hotkeys: installed {} (Exec={exec} daemon)", path.display());
            // Best-effort: nudge GIO's app-info cache so the portal resolves the
            // new file on THIS run (it monitors the dir, but update-desktop-database
            // is immediate).
            if let Some(db) = which("update-desktop-database") {
                let _ = std::process::Command::new(db).arg(&dir).status();
            }
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

    /// Minimal PATH lookup (no `which` crate dep) for the existence-guarded
    /// shell-out.
    fn which(bin: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| dir.join(bin))
            .find(|cand| cand.is_file())
    }
}

#[cfg(target_os = "linux")]
pub use state_layer::{ShortcutDef, ShortcutsSpec};

#[cfg(test)]
mod tests {
    // The wire-byte gate for the fold. Byte-identical to the pre-fold per-sidecar
    // goldens (stt `protocol::tests::hotkeys_wire_shapes` + capture's
    // `src-tauri/tests/capture_roundtrip.rs` Shortcut/HotkeysSnapshot goldens):
    // serde serializes struct fields in declaration order; `last_error` has NO
    // `skip_serializing_if` → None emits `null`. Relocating the struct to this
    // crate does NOT change the bytes (serde derives generate from the struct
    // definition, not the crate location).
    use super::{HotkeysSnapshot, Shortcut};

    #[test]
    fn shortcut_wire_shape() {
        // stt `shortcut_golden_roundtrips` golden.
        let s = Shortcut {
            id: "dictate".to_owned(),
            description: "Push-to-talk dictation".to_owned(),
            trigger_description: "Ctrl+Shift+Space".to_owned(),
            reserved: false,
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"id":"dictate","description":"Push-to-talk dictation","trigger_description":"Ctrl+Shift+Space","reserved":false}"#
        );
    }

    #[test]
    fn shortcut_standalone_golden() {
        // capture `shortcut_standalone_golden_roundtrips` golden (reserved slot).
        let s = Shortcut {
            id: "save_replay".to_owned(),
            description: "Save replay".to_owned(),
            trigger_description: String::new(),
            reserved: true,
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"id":"save_replay","description":"Save replay","trigger_description":"","reserved":true}"#
        );
    }

    #[test]
    fn hotkeys_snapshot_empty_golden() {
        // stt `hotkeys_snapshot_golden_roundtrips` golden; last_error None → null.
        let snap = HotkeysSnapshot {
            bound: true,
            portal_version: 1,
            can_configure: false,
            shortcuts: vec![],
            last_error: None,
        };
        assert_eq!(
            serde_json::to_string(&snap).unwrap(),
            r#"{"bound":true,"portal_version":1,"can_configure":false,"shortcuts":[],"last_error":null}"#
        );
    }

    #[test]
    fn hotkeys_snapshot_nested_golden() {
        // capture `hotkeys_and_shortcut_snake_case_golden_roundtrips` golden.
        let snap = HotkeysSnapshot {
            bound: true,
            portal_version: 2,
            can_configure: true,
            shortcuts: vec![Shortcut {
                id: "record".to_owned(),
                description: "Start/stop recording".to_owned(),
                trigger_description: "Ctrl+Alt+R".to_owned(),
                reserved: false,
            }],
            last_error: None,
        };
        assert_eq!(
            serde_json::to_string(&snap).unwrap(),
            r#"{"bound":true,"portal_version":2,"can_configure":true,"shortcuts":[{"id":"record","description":"Start/stop recording","trigger_description":"Ctrl+Alt+R","reserved":false}],"last_error":null}"#
        );
    }

    #[test]
    fn hotkeys_snapshot_with_error_golden() {
        // stt `hotkeys_snapshot_golden_roundtrips` nested golden; last_error Some.
        let snap = HotkeysSnapshot {
            bound: false,
            portal_version: 2,
            can_configure: true,
            shortcuts: vec![Shortcut {
                id: "dictate".to_owned(),
                description: "Push-to-talk dictation".to_owned(),
                trigger_description: "Ctrl+Shift+Space".to_owned(),
                reserved: false,
            }],
            last_error: Some("portal unavailable".to_owned()),
        };
        assert_eq!(
            serde_json::to_string(&snap).unwrap(),
            r#"{"bound":false,"portal_version":2,"can_configure":true,"shortcuts":[{"id":"dictate","description":"Push-to-talk dictation","trigger_description":"Ctrl+Shift+Space","reserved":false}],"last_error":"portal unavailable"}"#
        );
    }
}