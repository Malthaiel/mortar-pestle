//! xdg-desktop-portal ScreenCast handshake (ashpd) + restore-token persistence.
//!
//! Promoted from the B1 interop spike. Creates a MONITOR ScreenCast session with
//! an embedded cursor and a persisted restore token (dialog-free reruns), starts
//! it, and opens the PipeWire remote fd. Runs on a process-persistent tokio
//! runtime (its own worker thread) so ashpd/zbus's cached session-bus connection
//! driver survives across clips; no async state lives on the `!Send` GL/PipeWire
//! thread (see `capture::build_clip`).

use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::OnceLock;

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode,
};

/// Portal handshake result handed to the synchronous capture path.
pub struct Portal {
    pub fd: OwnedFd,
    pub node_id: u32,
    pub width: u32,
    pub height: u32,
}

/// Run the ScreenCast handshake on the process-persistent runtime and return the
/// PipeWire node + remote fd. ashpd rides zbus's cached session-bus connection,
/// whose I/O driver task lives on that runtime; the OLD design built and DROPPED a
/// fresh runtime per call, which killed the driver, so a SECOND handshake reused a
/// dead connection and hung at its first await. Holding one runtime keeps the
/// driver alive across clips.
pub fn handshake() -> Result<Portal, String> {
    portal_runtime()
        .block_on(handshake_async())
        .map_err(|e| format!("portal handshake: {e:?}"))
}

/// The process-persistent tokio runtime hosting ashpd/zbus's cached session-bus
/// connection driver (see `handshake`). Its threads are separate from the capture
/// thread, so `block_on` just parks the caller while dbus I/O is driven elsewhere;
/// no async state touches the `!Send` GL/PipeWire thread.
///
/// `pub` so the hotkeys task (`daemon::hotkeys`) spawns its forever GlobalShortcuts
/// listener here too — sharing one runtime keeps a single zbus driver alive. Two
/// worker threads: the never-ending `Activated` stream can park on one while a
/// `block_on` ScreenCast handshake runs on the other.
pub fn portal_runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("build the persistent portal tokio runtime")
    })
}

/// ashpd ScreenCast: create session → select MONITOR sources (embedded cursor,
/// persist) → start → open the PipeWire remote. Persists the restore token so
/// reruns skip the consent dialog.
async fn handshake_async() -> Result<Portal, ashpd::Error> {
    let proxy = Screencast::new().await?;
    let session = proxy.create_session(Default::default()).await?;

    let mut opts = SelectSourcesOptions::default()
        .set_cursor_mode(CursorMode::Embedded)
        .set_sources(ashpd::enumflags2::BitFlags::from(SourceType::Monitor))
        .set_multiple(false)
        .set_persist_mode(PersistMode::ExplicitlyRevoked);
    let saved = load_token();
    if let Some(tok) = &saved {
        opts = opts.set_restore_token(tok.as_str());
        log::info!("reusing saved restore token (no consent dialog expected)");
    } else {
        log::info!("no saved restore token — the portal will show ONE consent dialog");
    }
    proxy.select_sources(&session, opts).await?;

    let streams = proxy.start(&session, None, Default::default()).await?.response()?;
    if let Some(tok) = streams.restore_token() {
        save_token(tok);
        log::info!("saved restore token for dialog-free reruns");
    }
    let stream = streams.streams().first().ok_or(ashpd::Error::NoResponse)?;
    let node_id = stream.pipe_wire_node_id();
    let (w, h) = stream.size().unwrap_or((0, 0));
    let fd = proxy.open_pipe_wire_remote(&session, Default::default()).await?;
    Ok(Portal { fd, node_id, width: w as u32, height: h as u32 })
}

/// `$XDG_STATE_HOME/iskariel-capture/restore-token` (fallback `~/.local/state/...`).
fn token_path() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let mut h = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
            h.push(".local/state");
            h
        });
    base.join("iskariel-capture").join("restore-token")
}

fn load_token() -> Option<String> {
    std::fs::read_to_string(token_path())
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn save_token(token: &str) {
    let path = token_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, token) {
        log::warn!("could not persist restore token to {}: {e}", path.display());
    }
}
