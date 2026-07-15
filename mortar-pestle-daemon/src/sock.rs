//! 2-WAY shared Unix-domain socket bind/probe [cfg(unix)] — capture + stt only.
//! Broadcast is Windows-only and compiles this module out. The `Liveness`
//! closure keeps the per-sidecar probe predicate distinct (capture checks
//! `ok:true` + a `data.state` field, stt checks `ok:true` alone) — NOT unified
//! into one enum.
//!
//! Faithful parameterized mirror of `mortar-pestle-capture/src/daemon/socket.rs`
//! bind/probe semantics: bind FIRST (fast path, no probe), probe only on
//! `AddrInUse`, 0700 parent dir, 2 s probe timeout, unlink+rebind with a
//! retry-once for the lost cold-start race. Probe request rides the shared
//! `envelope::Request` (id `"probe"`), byte-identical to the pre-fold wire.
//!
//! NOTE: this module is `cfg(unix)` and is NOT compiled on the Windows dev box.
//! A Linux build / CI exercises it; a Windows `cargo check` skips it.

use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::envelope::Request;

/// Per-sidecar liveness predicate for the cold-start probe, applied to the raw
/// reply `Value`. Capture: `ok:true` + `data.state` present; stt: `ok:true`.
/// Broadcast has no Unix arm (structural `pipe::already_running` instead).
pub type Liveness = Box<dyn Fn(&Value) -> bool + Send + Sync>;

/// Resolve the daemon socket path: `$XDG_RUNTIME_DIR/mortar-pestle/<filename>`
/// (fallback `/tmp/mortar-pestle/<filename>`). The `mortar-pestle` parent dir is
/// SHARED across sidecars; only the filename differs.
pub fn socket_path(filename: &str) -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    runtime.join("mortar-pestle").join(filename)
}

/// Bind the control socket, single-instance. Returns the bound listener, or
/// `Ok(None)` when a live daemon already owns the socket — the caller exits 0
/// so the supervisor adopts the incumbent.
///
/// Order: ensure parent dir (0700) → try bind. On `AddrInUse`, probe the
/// existing socket with `probe_op`; a `live` reply ⇒ live daemon (`None`); any
/// connect/parse failure ⇒ stale socket ⇒ unlink + rebind (retry the
/// unlink+bind ONCE on a lost cold-start race).
pub async fn bind_or_probe(
    path: &PathBuf,
    probe_op: &str,
    probe_args: Value,
    live: Liveness,
) -> io::Result<Option<UnixListener>> {
    if let Some(parent) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }

    match UnixListener::bind(path) {
        Ok(listener) => Ok(Some(listener)),
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            if probe_live_daemon(path, probe_op, probe_args, &live).await {
                log::info!("daemon already running at {}", path.display());
                Ok(None)
            } else {
                log::warn!("stale socket at {} — unlinking + rebinding", path.display());
                let _ = std::fs::remove_file(path);
                match UnixListener::bind(path) {
                    Ok(listener) => Ok(Some(listener)),
                    // A lost cold-start race: another instance re-created the socket
                    // file between our unlink and bind. Retry the unlink+bind ONCE
                    // more before giving up (the live-probe path above is untouched).
                    Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                        log::warn!("rebind raced at {} — unlinking + retrying once", path.display());
                        let _ = std::fs::remove_file(path);
                        UnixListener::bind(path).map(Some)
                    }
                    Err(e) => Err(e),
                }
            }
        }
        Err(e) => Err(e),
    }
}

/// Connect to an existing socket and send the probe request; `true` iff a live
/// daemon answers a reply satisfying `live` within 2 s. Any connect, write,
/// read, or parse failure ⇒ `false` ⇒ treat as stale.
pub async fn probe_live_daemon(
    path: &PathBuf,
    probe_op: &str,
    probe_args: Value,
    live: &Liveness,
) -> bool {
    let probe = async {
        let mut stream = UnixStream::connect(path).await.ok()?;
        let req = serde_json::to_string(&Request {
            op: probe_op.to_owned(),
            id: "probe".into(),
            args: probe_args,
        })
        .ok()?;
        stream.write_all(req.as_bytes()).await.ok()?;
        stream.write_all(b"\n").await.ok()?;
        stream.flush().await.ok()?;

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.ok()?;
        if n == 0 {
            return None;
        }
        let v: Value = serde_json::from_str(line.trim()).ok()?;
        if live(&v) {
            Some(())
        } else {
            None
        }
    };

    matches!(
        tokio::time::timeout(Duration::from_secs(2), probe).await,
        Ok(Some(()))
    )
}
