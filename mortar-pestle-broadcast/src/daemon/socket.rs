//! NDJSON named-pipe server — Windows port of the capture daemon's socket.rs
//! contract: single-instance via first_pipe_instance (ERROR_ACCESS_DENIED ⇒
//! already running ⇒ exit 0 so the supervisor adopts), accept loop that
//! pre-creates the next pipe instance before serving, per-client writer task
//! merging correlated responses with the broadcast event bus.

use std::sync::mpsc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::{broadcast, oneshot};

use mortar_pestle_daemon::{framing, pipe};

use crate::daemon::engine::{Cmd, Reply};
use crate::daemon::protocol::{Event, ProtoError, Request, Response};

pub const PIPE_NAME: &str = r"\\.\pipe\mortar-pestle-broadcast";

pub struct Ctx {
    pub cmd_tx: mpsc::Sender<Cmd>,
    pub events: broadcast::Sender<Event>,
}

pub async fn serve(first: NamedPipeServer, ctx: Ctx) -> std::io::Result<()> {
    let mut server = first;
    log::info!("listening on {PIPE_NAME}");

    loop {
        server.connect().await?;
        // Pre-create the next instance BEFORE serving this client, so a new
        // client can always connect (capture socket.rs accept-loop idiom).
        // `pipe::accept_next` does the pre-create + hands back the connected
        // instance alongside the next one to listen on.
        let (client, next) = pipe::accept_next(PIPE_NAME, server)?;
        server = next;
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
    let mut reader = BufReader::new(reader).take(framing::MAX_LINE_BYTES as u64);
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
            if framing::write_line(&mut writer, &line).await.is_err() {
                break;
            }
        }
    });

    let mut line = String::new();
    loop {
        line.clear();
        // .take() caps a hostile unterminated line at MAX_LINE_BYTES.
        reader.set_limit(framing::MAX_LINE_BYTES as u64);
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
            Err(e) => Response::err(framing::extract_id::<u64>(trimmed), ProtoError::bad_request(format!("malformed request: {e}"))),
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

fn need_u64(args: &Value, key: &str) -> Result<u64, ProtoError> {
    args.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ProtoError::bad_request(format!("missing number arg '{key}'")))
}

fn need_i64(args: &Value, key: &str) -> Result<i64, ProtoError> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| ProtoError::bad_request(format!("missing number arg '{key}'")))
}

fn need_bool(args: &Value, key: &str) -> Result<bool, ProtoError> {
    args.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| ProtoError::bad_request(format!("missing bool arg '{key}'")))
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn opt_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
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
                transform: args.get("transform").cloned().unwrap_or(Value::Null),
                crop: args.get("crop").cloned().unwrap_or(Value::Null),
                visible: args.get("visible").and_then(Value::as_bool),
                locked: args.get("locked").and_then(Value::as_bool),
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
                replace: args.get("replace").and_then(Value::as_bool).unwrap_or(false),
                reply: tx,
            })
        })(),
        "rename_scene" => (|| {
            Ok(Cmd::RenameScene { name: need_str(&args, "name")?, new_name: need_str(&args, "new_name")?, reply: tx })
        })(),
        "rename_item" => (|| {
            Ok(Cmd::RenameItem {
                scene: need_str(&args, "scene")?,
                item: need_i64(&args, "item")?,
                new_name: need_str(&args, "new_name")?,
                reply: tx,
            })
        })(),
        "duplicate_scene" => need_str(&args, "name").map(|name| Cmd::DuplicateScene { name, reply: tx }),
        "reorder_scenes" => (|| {
            let order = args
                .get("order")
                .and_then(Value::as_array)
                .ok_or_else(|| ProtoError::bad_request("missing array arg 'order'"))?
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| ProtoError::bad_request("'order' must be scene names"))?;
            Ok(Cmd::ReorderScenes { order, reply: tx })
        })(),
        "remove_item" => (|| {
            Ok(Cmd::RemoveItem { scene: need_str(&args, "scene")?, item: need_i64(&args, "item")?, reply: tx })
        })(),
        "set_item_visible" => (|| {
            Ok(Cmd::SetItemVisible {
                scene: need_str(&args, "scene")?,
                item: need_i64(&args, "item")?,
                visible: need_bool(&args, "visible")?,
                reply: tx,
            })
        })(),
        "set_item_locked" => (|| {
            Ok(Cmd::SetItemLocked {
                scene: need_str(&args, "scene")?,
                item: need_i64(&args, "item")?,
                locked: need_bool(&args, "locked")?,
                reply: tx,
            })
        })(),
        "reorder_items" => (|| {
            let order = args
                .get("order")
                .and_then(Value::as_array)
                .ok_or_else(|| ProtoError::bad_request("missing array arg 'order'"))?
                .iter()
                .map(|v| {
                    let item = v.get("item").and_then(Value::as_i64)?;
                    let group = v.get("group").and_then(Value::as_i64);
                    Some((item, group))
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| ProtoError::bad_request("'order' entries need {item, group?}"))?;
            Ok(Cmd::ReorderItems { scene: need_str(&args, "scene")?, order, reply: tx })
        })(),
        "create_group" => (|| {
            Ok(Cmd::CreateGroup { scene: need_str(&args, "scene")?, name: need_str(&args, "name")?, reply: tx })
        })(),
        "ungroup" => (|| {
            Ok(Cmd::Ungroup { scene: need_str(&args, "scene")?, item: need_i64(&args, "item")?, reply: tx })
        })(),
        "add_existing" => (|| {
            Ok(Cmd::AddExisting {
                scene: need_str(&args, "scene")?,
                source_name: need_str(&args, "source_name")?,
                reply: tx,
            })
        })(),
        "transform_commit" => (|| {
            Ok(Cmd::TransformCommit {
                scene: need_str(&args, "scene")?,
                item: need_i64(&args, "item")?,
                transform: args.get("transform").cloned().unwrap_or(Value::Null),
                crop: args.get("crop").cloned().unwrap_or(Value::Null),
                reply: tx,
            })
        })(),
        "set_transform" => (|| {
            Ok(Cmd::SetTransform {
                scene: need_str(&args, "scene")?,
                item: need_i64(&args, "item")?,
                transform: args.get("transform").cloned().unwrap_or(Value::Null),
                crop: args.get("crop").cloned().unwrap_or(Value::Null),
                reply: tx,
            })
        })(),
        "select_item" => (|| {
            Ok(Cmd::SelectItem { scene: need_str(&args, "scene")?, item: opt_i64(&args, "item"), reply: tx })
        })(),
        "hover_item" => Ok(Cmd::HoverItem {
            scene: opt_str(&args, "scene"),
            item: opt_i64(&args, "item"),
            reply: tx,
        }),
        "set_snap_guides" => (|| {
            let guides = args
                .get("guides")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|g| {
                            let axis = match g.get("axis").and_then(Value::as_str)? {
                                "v" => 0u8,
                                "h" => 1u8,
                                _ => return None,
                            };
                            let pos = g.get("pos").and_then(Value::as_f64)? as f32;
                            Some((axis, pos))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(Cmd::SetSnapGuides { guides, reply: tx })
        })(),
        "get_source_settings" => (|| {
            Ok(Cmd::GetSourceSettings { scene: need_str(&args, "scene")?, item: need_i64(&args, "item")?, reply: tx })
        })(),
        "get_properties" => (|| {
            Ok(Cmd::GetProperties { scene: need_str(&args, "scene")?, item: need_i64(&args, "item")?, reply: tx })
        })(),
        "click_property_button" => (|| {
            Ok(Cmd::ClickPropertyButton {
                scene: need_str(&args, "scene")?,
                item: need_i64(&args, "item")?,
                prop: need_str(&args, "prop")?,
                reply: tx,
            })
        })(),
        "list_input_types" => Ok(Cmd::ListInputTypes { reply: tx }),
        "list_encoders" => Ok(Cmd::ListEncoders { reply: tx }),
        "get_output_settings" => Ok(Cmd::GetOutputSettings { reply: tx }),
        "set_output_settings" => Ok(Cmd::SetOutputSettings {
            patch: args.get("patch").cloned().unwrap_or(Value::Null),
            reply: tx,
        }),
        "get_encoder_properties" => need_str(&args, "encoder_id")
            .map(|encoder_id| Cmd::GetEncoderProperties { encoder_id, reply: tx }),
        "set_encoder_settings" => Ok(Cmd::SetEncoderSettings {
            settings: args.get("settings").cloned().unwrap_or(Value::Null),
            reply: tx,
        }),
        "screenshot" => Ok(Cmd::Screenshot {
            scene: opt_str(&args, "scene"),
            item: opt_i64(&args, "item"),
            picker: opt_str(&args, "picker"),
            width: need_u64(&args, "width").unwrap_or(320) as u32,
            reply: tx,
        }),
        "picker_open" => need_str(&args, "kind").map(|kind| Cmd::PickerOpen { kind, reply: tx }),
        "picker_close" => Ok(Cmd::PickerClose { reply: tx }),
        "load_browser_module" => Ok(Cmd::LoadBrowserModule { reply: tx }),
        "start_record" => Ok(Cmd::StartRecord {
            dir: opt_str(&args, "dir"),
            stem: opt_str(&args, "stem"),
            reply: tx,
        }),
        "stop_record" => Ok(Cmd::StopRecord { reply: tx }),
        "pause_record" => need_bool(&args, "paused").map(|paused| Cmd::PauseRecord { paused, reply: tx }),
        "split_record" => Ok(Cmd::SplitRecord { reply: tx }),
        "get_stream_services" => Ok(Cmd::GetStreamServices { reply: tx }),
        "get_stream_service" => Ok(Cmd::GetStreamService { reply: tx }),
        "set_stream_service" => Ok(Cmd::SetStreamService {
            service: args.get("service").cloned().unwrap_or(Value::Null),
            reply: tx,
        }),
        "start_stream" => Ok(Cmd::StartStream { reply: tx }),
        "stop_stream" => Ok(Cmd::StopStream { reply: tx }),
        "get_stream_stats" => Ok(Cmd::GetStreamStats { reply: tx }),
        "start_replay" => Ok(Cmd::StartReplay { reply: tx }),
        "stop_replay" => Ok(Cmd::StopReplay { reply: tx }),
        "save_replay" => Ok(Cmd::SaveReplay { reply: tx }),
        "display_create" => (|| {
            Ok(Cmd::DisplayCreate {
                id: need_str(&args, "id")?,
                hwnd: need_u64(&args, "hwnd")?,
                width: need_u64(&args, "width")? as u32,
                height: need_u64(&args, "height")? as u32,
                reply: tx,
            })
        })(),
        "display_resize" => (|| {
            Ok(Cmd::DisplayResize {
                id: need_str(&args, "id")?,
                width: need_u64(&args, "width")? as u32,
                height: need_u64(&args, "height")? as u32,
                reply: tx,
            })
        })(),
        "display_destroy" => need_str(&args, "id").map(|id| Cmd::DisplayDestroy { id, reply: tx }),
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
