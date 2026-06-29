//! Dev-server supervisor — Start/Stop/Restart/Status for the `iskariel-dev`
//! systemd *user* service (the `cargo tauri dev` surface) plus a Vite health
//! probe. Drives the Dev Server panel in Settings → Dev. Unlike the rest of
//! that tab this command is compiled into the production RPM (the panel is kept
//! via the VITE_DEV_TOOLS gate) so the stable build can revive a dead dev
//! window — you can't click a restart button inside a crashed dev window.

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::Command as TokioCommand;

const SERVICE: &str = "mortar-pestle-dev.service";
const DEV_URL: &str = "http://localhost:5173/";
const POLL_TIMEOUT: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServiceResult {
    /// Echoes the requested verb ("restart" | "start" | "stop" | "status").
    pub action: String,
    /// Did the systemctl verb exit 0 (always true for the no-op "status" read).
    pub ran: bool,
    /// `systemctl --user is-active` → Some(true)=active, Some(false)=inactive/failed.
    pub active: Option<bool>,
    /// HTTP status from the Vite probe, when a response came back.
    pub http_status: Option<u16>,
    /// True once localhost:5173 answered 200.
    pub serving: bool,
    /// Wall-clock for the whole action incl. polling, in ms.
    pub elapsed_ms: u64,
    /// systemctl stderr on a non-zero exit, or a poll-timeout note.
    pub error: Option<String>,
}

/// Run `systemctl --user <verb> mortar-pestle-dev.service` and capture its output.
async fn systemctl(verb: &str) -> Result<std::process::Output, String> {
    TokioCommand::new("systemctl")
        .args(["--user", verb, SERVICE])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("failed to run systemctl: {e}"))
}

/// `systemctl --user is-active` → Some(true) when the unit reports "active".
async fn is_active() -> Option<bool> {
    let out = TokioCommand::new("systemctl")
        .args(["--user", "is-active", SERVICE])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim() == "active")
}

/// One short-timeout GET of the Vite dev server. None = refused / timed out
/// (server not up yet), Some(code) = it answered.
async fn probe_once() -> Option<u16> {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .ok()?;
    client
        .get(DEV_URL)
        .send()
        .await
        .ok()
        .map(|r| r.status().as_u16())
}

#[tauri::command]
pub async fn dev_service_action(action: String) -> Result<DevServiceResult, String> {
    let start = Instant::now();

    match action.as_str() {
        // Non-destructive read: unit state + a single probe, no polling.
        "status" => {
            let active = is_active().await;
            let http_status = probe_once().await;
            Ok(DevServiceResult {
                action,
                ran: true,
                active,
                http_status,
                serving: http_status == Some(200),
                elapsed_ms: start.elapsed().as_millis() as u64,
                error: None,
            })
        }
        "stop" => {
            let out = systemctl("stop").await?;
            let error = (!out.status.success()).then(|| {
                let s = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if s.is_empty() { "systemctl stop failed".to_string() } else { s }
            });
            Ok(DevServiceResult {
                action,
                ran: out.status.success(),
                active: is_active().await,
                http_status: None,
                serving: false,
                elapsed_ms: start.elapsed().as_millis() as u64,
                error,
            })
        }
        // Restart/start, then poll Vite until it serves 200 or we time out.
        "start" | "restart" => {
            let out = systemctl(action.as_str()).await?;
            if !out.status.success() {
                let s = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let msg = if s.is_empty() { format!("systemctl {action} failed") } else { s };
                return Ok(DevServiceResult {
                    action,
                    ran: false,
                    active: is_active().await,
                    http_status: None,
                    serving: false,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    error: Some(msg),
                });
            }
            let poll_start = Instant::now();
            let http_status = loop {
                let s = probe_once().await;
                if s == Some(200) || poll_start.elapsed() >= POLL_TIMEOUT {
                    break s;
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            };
            let serving = http_status == Some(200);
            let error = (!serving)
                .then(|| format!("dev server did not answer 200 within {}s", POLL_TIMEOUT.as_secs()));
            Ok(DevServiceResult {
                action,
                ran: true,
                active: is_active().await,
                http_status,
                serving,
                elapsed_ms: start.elapsed().as_millis() as u64,
                error,
            })
        }
        other => Err(format!("unknown action: {other}")),
    }
}
