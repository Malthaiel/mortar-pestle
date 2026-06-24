//! Keep the in-game overlay windows above everything else (including a
//! borderless game) via KWin's scripting API.
//!
//! Background: under KWin-Wayland on this stack, neither Tauri/GTK always-on-top
//! (`_NET_WM_STATE_ABOVE`, an X11 hint Wayland ignores) nor a static
//! `kwinrulesrc` "Force keep-above" rule works — the rule's force/match integer
//! values are version-fragile and silently no-op (verified: the window stayed
//! `keepAbove: false` despite a textbook `aboverule=2` rule). What DOES work,
//! verified live (`queryWindowInfo` → `keepAbove: true, layer: 3`), is setting
//! `window.keepAbove = true` through KWin's scripting API. So on startup we load
//! a tiny KWin script that pins every window whose title contains
//! "Agentic Overlay" and stays connected to `windowAdded`, catching our overlay
//! windows as they (re)map across app restarts.
//!
//! Best-effort: a missing `qdbus` / non-KDE session is logged, never fatal — the
//! overlays still render, just without guaranteed keep-above.

use std::path::PathBuf;

/// Stable KWin-scripting plugin name — also the unload key (so an app restart
/// replaces, rather than stacks, the `windowAdded` handler).
const PLUGIN: &str = "agentic_overlay_keepabove";

/// The KWin script: pin existing matches + every future window whose caption
/// contains "Agentic Overlay". KWin 5 (`clientList`/`clientAdded`) and KWin 6
/// (`windowList`/`windowAdded`) compatible.
const SCRIPT: &str = r#"(function(){
  function pin(w){
    try{
      if(!w) return;
      var c = (w.caption!==undefined && w.caption!==null) ? (""+w.caption) : "";
      if(c.indexOf("Agentic Overlay") !== -1){
        w.keepAbove = true;
        w.skipTaskbar = true;
        w.skipSwitcher = true;
      }
    }catch(e){}
  }
  var list = (typeof workspace.windowList === "function") ? workspace.windowList()
           : (typeof workspace.clientList === "function") ? workspace.clientList() : [];
  for (var i=0;i<list.length;i++) pin(list[i]);
  if (workspace.windowAdded && workspace.windowAdded.connect) workspace.windowAdded.connect(pin);
  else if (workspace.clientAdded && workspace.clientAdded.connect) workspace.clientAdded.connect(pin);
})();
"#;

/// Run a qdbus call across the binary's common names; first success wins.
/// Returns trimmed stdout, or `None` if every candidate failed/was absent.
fn qdbus(args: &[&str]) -> Option<String> {
    for bin in ["qdbus", "qdbus-qt6", "qdbus6"] {
        if let Ok(out) = std::process::Command::new(bin).args(args).output() {
            if out.status.success() {
                return Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
            }
        }
    }
    None
}

/// Write the keep-above KWin script to the app config dir and (re)load it via
/// KWin scripting. Idempotent across restarts (unload-then-load by `PLUGIN`).
pub fn ensure_installed(app: &tauri::AppHandle) {
    let dir = match crate::commands::sidebar::app_config_root(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("overlay keep-above: no app config dir: {e:?}");
            return;
        }
    };
    let _ = std::fs::create_dir_all(&dir);
    let path: PathBuf = dir.join("overlay-keepabove.js");
    if let Err(e) = std::fs::write(&path, SCRIPT) {
        log::warn!("overlay keep-above: write script {path:?} failed: {e}");
        return;
    }

    // Drop a prior instance (best-effort) so restarts don't stack duplicate
    // windowAdded handlers, then load + start fresh.
    let _ = qdbus(&[
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting.unloadScript",
        PLUGIN,
    ]);
    let path_str = path.to_string_lossy();
    match qdbus(&[
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting.loadScript",
        &path_str,
        PLUGIN,
    ]) {
        Some(id) => {
            let _ = qdbus(&["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"]);
            log::info!("overlay keep-above: loaded KWin script (id {id}) + started");
        }
        None => log::warn!(
            "overlay keep-above: KWin scripting unavailable (qdbus/KWin missing?) — overlays won't auto-pin"
        ),
    }
}
