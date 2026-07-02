//! NDJSON named-pipe server — Windows port of the capture daemon's socket.rs
//! contract: single-instance via first_pipe_instance (ERROR_ACCESS_DENIED ⇒
//! already running ⇒ exit 0 so the supervisor adopts), accept loop that
//! pre-creates the next pipe instance before serving, per-client writer task
//! merging correlated responses with the broadcast event bus.

use std::sync::mpsc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::{broadcast, oneshot};

use crate::daemon::engine::{Cmd, Reply};
use crate::daemon::protocol::{Event, ProtoError, Request, Response};

pub const PIPE_NAME: &str = r"\\.\pipe\mortar-pestle-broadcast";
const MAX_LINE_BYTES: usize = 1024 * 1024;

pub struct Ctx {
    pub cmd_tx: mpsc::Sender<Cmd>,
    pub events: broadcast::Sender<Event>,
}

/// true ⇒ another daemon owns the pipe (caller exits 0 for supervisor adopt).
pub fn already_running(err: &std::io::Error) -> bool {
    err.raw_os_error() == Some(5) // ERROR_ACCESS_DENIED with first_pipe_instance
}

/// Claim the pipe (single-instance gate) — called BEFORE libobs init.
pub fn bind_first() -> std::io::Result<NamedPipeServer> {
    ServerOptions::new().first_pipe_instance(true).create(PIPE_NAME)
}

pub async fn serve(first: NamedPipeServer, ctx: Ctx) -> std::io::Result<()> {
    let mut server = first;
    log::info!("listening on {PIPE_NAME}");

    loop {
        server.connect().await?;
        // Pre-create the next instance BEFORE serving this client, so a new
        // client can always connect (capture socket.rs accept-loop idiom).
        let next = ServerOptions::new().create(PIPE_NAME)?;
        let client = std::mem::replace(&mut server, next);
        let cmd_tx = ctx.cmd_tx.clone();
        let events = ctx.events.subscribe();
        tokio::spawn(async move {
            if let Err(e) = serve_conn(client, cmd_tx, events).await {
                log::debug!("client ended: {e}");
            }
        });
    }
}

async fn serve_conn(
    pipe: NamedPipeServer,
    cmd_tx: mpsc::Sender<Cmd>,
    mut events: broadcast::Receiver<Event>,
) -> std::io::Result<()> {
    let (reader, mut writer) = tokio::io::split(pipe);
    let mut reader = BufReader::new(reader).take(MAX_LINE_BYTES as u64);
    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::unbounded_channel::<Response>();

    let writer_task = tokio::spawn(async move {
        loop {
            let line = tokio::select! {
                resp = resp_rx.recv() => match resp {
                    Some(r) => serde_json::to_string(&r).unwrap(),
                    None => break,
                },
                evt = events.recv() => match evt {
                    Ok(e) => serde_json::to_string(&e).unwrap(),
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("client lagged {n} events, continuing");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if writer.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    let mut line = String::new();
    loop {
        line.clear();
        // .take() caps a hostile unterminated line at MAX_LINE_BYTES.
        reader.set_limit(MAX_LINE_BYTES as u64);
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => dispatch(req, &cmd_tx).await,
            Err(e) => Response::err(0, ProtoError::bad_request(format!("malformed request: {e}"))),
        };
        if resp_tx.send(resp).is_err() {
            break;
        }
    }
    writer_task.abort();
    Ok(())
}

fn need_str(args: &Value, key: &str) -> Result<String, ProtoError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ProtoError::bad_request(format!("missing string arg '{key}'")))
}

async fn dispatch(req: Request, cmd_tx: &mpsc::Sender<Cmd>) -> Response {
    let id = req.id;

    // hello answers inline — no engine round-trip (adopt-probe cheapness).
    if req.op == "hello" {
        return Response::ok(
            id,
            serde_json::json!({
                "service": "mortar-pestle-broadcast",
                "proto": crate::daemon::protocol::PROTO_VERSION,
            }),
        );
    }
    if req.op == "shutdown" {
        let (tx, rx) = oneshot::channel();
        let _ = cmd_tx.send(Cmd::Shutdown { reply: tx });
        let _ = rx.await;
        // The engine thread saves + tears down; exit after replying.
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            std::process::exit(0);
        });
        return Response::ok(id, serde_json::json!({}));
    }

    let (tx, rx): (Reply, _) = oneshot::channel();
    let args = req.args;
    let cmd = match req.op.as_str() {
        "get_state" => Ok(Cmd::GetState(tx)),
        "create_scene" => need_str(&args, "name").map(|name| Cmd::CreateScene { name, reply: tx }),
        "remove_scene" => need_str(&args, "name").map(|name| Cmd::RemoveScene { name, reply: tx }),
        "set_current_scene" => need_str(&args, "name").map(|name| Cmd::SetCurrentScene { name, reply: tx }),
        "create_source" => (|| {
            Ok(Cmd::CreateSource {
                scene: need_str(&args, "scene")?,
                id: need_str(&args, "id")?,
                name: need_str(&args, "name")?,
                settings: args.get("settings").cloned().unwrap_or(Value::Null),
                reply: tx,
            })
        })(),
        "remove_source" => (|| {
            Ok(Cmd::RemoveSource { scene: need_str(&args, "scene")?, name: need_str(&args, "name")?, reply: tx })
        })(),
        "set_source_settings" => (|| {
            Ok(Cmd::SetSourceSettings {
                scene: need_str(&args, "scene")?,
                name: need_str(&args, "name")?,
                settings: args.get("settings").cloned().unwrap_or(Value::Null),
                reply: tx,
            })
        })(),
        "start_record" => Ok(Cmd::StartRecord { reply: tx }),
        "stop_record" => Ok(Cmd::StopRecord { reply: tx }),
        other => Err(ProtoError {
            code: "not_implemented".into(),
            message: format!("unknown op '{other}'"),
        }),
    };

    let cmd = match cmd {
        Ok(c) => c,
        Err(e) => return Response::err(id, e),
    };
    if cmd_tx.send(cmd).is_err() {
        return Response::err(id, ProtoError::internal("engine thread gone"));
    }
    match rx.await {
        Ok(Ok(data)) => Response::ok(id, data),
        Ok(Err(e)) => Response::err(id, e),
        Err(_) => Response::err(id, ProtoError::internal("engine dropped reply")),
    }
}
