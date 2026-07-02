//! Dev/CI probe client: `mortar-pestle-broadcast probe <op> [json-args]`.
//! Connects to the daemon pipe, sends one request, prints the correlated
//! response (events that arrive in between go to stderr), exits 0 on ok.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;

use crate::daemon::socket::PIPE_NAME;

const ERROR_PIPE_BUSY: i32 = 231;

pub fn run(op: &str, args: Option<&str>) -> i32 {
    let args: Value = match args {
        None => Value::Null,
        Some(s) => match serde_json::from_str(s) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("args is not valid JSON: {e}");
                return 2;
            }
        },
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(async move {
        let pipe = loop {
            match ClientOptions::new().open(PIPE_NAME) {
                Ok(p) => break p,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(e) => {
                    eprintln!("connect {PIPE_NAME} failed: {e}");
                    return 3;
                }
            }
        };
        let (reader, mut writer) = tokio::io::split(pipe);
        let req = serde_json::json!({ "op": op, "id": 1, "args": args });
        if let Err(e) = writer.write_all(format!("{req}\n").as_bytes()).await {
            eprintln!("write failed: {e}");
            return 3;
        }
        let _ = writer.flush().await;

        let mut lines = BufReader::new(reader).lines();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let line = tokio::select! {
                l = lines.next_line() => match l {
                    Ok(Some(l)) => l,
                    Ok(None) => { eprintln!("pipe closed before response"); return 3; }
                    Err(e) => { eprintln!("read failed: {e}"); return 3; }
                },
                _ = tokio::time::sleep_until(deadline) => {
                    eprintln!("timed out waiting for response");
                    return 3;
                }
            };
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("event").is_some() {
                eprintln!("[event] {line}");
                continue;
            }
            if v.get("id").and_then(Value::as_u64) == Some(1) {
                println!("{}", serde_json::to_string_pretty(&v).unwrap());
                return if v.get("ok").and_then(Value::as_bool) == Some(true) { 0 } else { 1 };
            }
        }
    })
}
