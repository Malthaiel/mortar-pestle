//! 3-WAY shared Windows named-pipe mechanics [cfg(windows)]. All 3 sidecars
//! link this. The CALL SITE (when to call `bind_first` relative to libobs init)
//! stays per-sidecar in each `mod.rs run()` — broadcast calls `bind_first`
//! BEFORE `engine::spawn` (bind-before-libobs); capture/stt call it inside
//! `serve()`. This module owns the mechanism; the caller owns the ordering.

use std::io;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

/// true ⇒ another daemon owns the pipe (caller exits 0 so the supervisor adopts
/// the incumbent — the adopted-daemon bounce). `ERROR_ACCESS_DENIED` (5) is the
/// `first_pipe_instance` collision signal.
pub fn already_running(err: &io::Error) -> bool {
    err.raw_os_error() == Some(5)
}

/// Claim the pipe as the single instance (`first_pipe_instance(true)`). Called
/// BEFORE any engine init in broadcast (bind-before-libobs ordering).
pub fn bind_first(pipe_name: &str) -> io::Result<NamedPipeServer> {
    ServerOptions::new().first_pipe_instance(true).create(pipe_name)
}

/// Pre-create the next pipe instance, then hand off the currently-connected
/// server to the caller. The pre-create idiom ensures a new client can always
/// connect while this one is being served (capture/stt/broadcast accept-loop
/// invariant). Returns `(connected_server, next_server_to_listen_on)`.
pub fn accept_next(pipe_name: &str, server: NamedPipeServer) -> io::Result<(NamedPipeServer, NamedPipeServer)> {
    let next = create_next(pipe_name)?;
    // `server` is the connected instance; caller serves it, then loops on `next`.
    Ok((server, next))
}

/// Create a subsequent (non-first) listening instance — the accept loop's
/// re-arm primitive, also used to recover from a failed `connect()`.
pub fn create_next(pipe_name: &str) -> io::Result<NamedPipeServer> {
    ServerOptions::new().create(pipe_name)
}