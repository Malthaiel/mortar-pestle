//! Music listen log — append-only JSONL of completed-track listens for the
//! "hours this month" rail stat. Each line: { timestamp, trackPath, durationSec }.
//! Stored at `<app_data>/listen-log.jsonl`. Append-only; never compacted.

use std::fs::{read_to_string, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct ListenEvent {
    timestamp: String,
    #[serde(rename = "trackPath")]
    track_path: String,
    #[serde(rename = "durationSec")]
    duration_sec: u32,
}

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(data.join("listen-log.jsonl"))
}

#[tauri::command]
pub fn music_record_listen(
    app: AppHandle,
    track_path: String,
    duration_sec: u32,
) -> Result<(), String> {
    if duration_sec == 0 {
        return Ok(());
    }
    let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let ev = ListenEvent {
        timestamp: Utc::now().to_rfc3339(),
        track_path,
        duration_sec,
    };
    let line = serde_json::to_string(&ev).map_err(|e| e.to_string())?;
    let mut f = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("open: {e}"))?;
    writeln!(f, "{}", line).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn music_listen_minutes_for_month(app: AppHandle, month: String) -> Result<f64, String> {
    let path = log_path(&app)?;
    if !path.exists() {
        return Ok(0.0);
    }
    let content = read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let mut total_sec: u64 = 0;
    for line in content.lines() {
        if let Ok(ev) = serde_json::from_str::<ListenEvent>(line) {
            if ev.timestamp.starts_with(&month) {
                total_sec += ev.duration_sec as u64;
            }
        }
    }
    Ok((total_sec as f64) / 60.0)
}
