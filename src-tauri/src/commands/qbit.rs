//! qBittorrent connection settings + daemon control for the Anime download
//! pipeline. Host/user persist in `qbit.json` under the app config dir; the
//! password lives in the OS keyring (mirrors `design.rs`). `qbit_env` injects
//! `QBIT_HOST/USER/PASS` into every spawn of the vault helper scripts
//! (`qbittorrent_client.py`, `download_anime.py`) so they authenticate.

use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;

use crate::commands::vault::{self, VaultError};

const QBIT_SERVICE: &str = "iskariel";
const QBIT_ACCOUNT: &str = "qbittorrent";
const QBIT_CONFIG_FILE: &str = "qbit.json";
const DEFAULT_HOST: &str = "http://localhost:8080";
const DEFAULT_USER: &str = "admin";

fn default_host() -> String {
    DEFAULT_HOST.to_string()
}
fn default_user() -> String {
    DEFAULT_USER.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QbitStored {
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_user")]
    user: String,
}
impl Default for QbitStored {
    fn default() -> Self {
        Self {
            host: default_host(),
            user: default_user(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QbitConfig {
    pub host: String,
    pub user: String,
    pub has_pass: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QbitStatus {
    pub daemon_running: bool,
    pub connected: bool,
    pub error: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(crate::commands::sidebar::app_config_root(app)?.join(QBIT_CONFIG_FILE))
}

fn load_stored(app: &AppHandle) -> QbitStored {
    let Ok(path) = config_path(app) else {
        return QbitStored::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return QbitStored::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn stored_password() -> String {
    if let Ok(entry) = keyring::Entry::new(QBIT_SERVICE, QBIT_ACCOUNT) {
        if let Ok(p) = entry.get_password() {
            return p;
        }
    }
    std::env::var("QBIT_PASS").unwrap_or_default()
}

fn qbit_script() -> PathBuf {
    PathBuf::from(vault::vault_root()).join("Infrastructure/Scripts/qbittorrent_client.py")
}

/// `QBIT_*` env pairs for spawning the vault helper scripts. Public so
/// `anime_download` injects the same auth into `download_anime.py`.
pub fn qbit_env(app: &AppHandle) -> Vec<(String, String)> {
    let s = load_stored(app);
    let mut env = vec![
        ("QBIT_HOST".to_string(), s.host),
        ("QBIT_USER".to_string(), s.user),
    ];
    let pass = stored_password();
    if !pass.is_empty() {
        env.push(("QBIT_PASS".to_string(), pass));
    }
    env
}

#[tauri::command]
pub fn qbit_get_config(app: AppHandle) -> Result<QbitConfig, VaultError> {
    let s = load_stored(&app);
    Ok(QbitConfig {
        host: s.host,
        user: s.user,
        has_pass: !stored_password().is_empty(),
    })
}

#[tauri::command]
pub fn qbit_set_config(
    app: AppHandle,
    host: String,
    user: String,
    pass: Option<String>,
) -> Result<(), VaultError> {
    let stored = QbitStored {
        host: if host.trim().is_empty() {
            default_host()
        } else {
            host.trim().to_string()
        },
        user: if user.trim().is_empty() {
            default_user()
        } else {
            user.trim().to_string()
        },
    };
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| VaultError::Io(format!("mkdir {parent:?}: {e}")))?;
    }
    let mut text = serde_json::to_string_pretty(&stored)
        .map_err(|e| VaultError::Io(format!("serialize qbit.json: {e}")))?;
    text.push('\n');
    vault::atomic_write(&path, text.as_bytes())?;
    // Password → keyring, only when a non-empty value is provided. An empty /
    // omitted `pass` leaves the existing keyring entry untouched (write-only UI).
    if let Some(p) = pass {
        if !p.is_empty() {
            let entry = keyring::Entry::new(QBIT_SERVICE, QBIT_ACCOUNT)
                .map_err(|e| VaultError::Io(format!("keyring open: {e}")))?;
            entry
                .set_password(&p)
                .map_err(|e| VaultError::Io(format!("keyring set: {e}")))?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
async fn daemon_running() -> bool {
    TokioCommand::new("pgrep")
        .arg("-x")
        .arg("qbittorrent-nox")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

// Windows: qBittorrent ships GUI-only (no headless `-nox`). Detect the GUI
// process via `tasklist`; the Web UI it exposes (which must be enabled in the
// qBittorrent settings) is what `qbittorrent_client.py` talks to.
#[cfg(windows)]
async fn daemon_running() -> bool {
    match TokioCommand::new("tasklist")
        .args(["/FI", "IMAGENAME eq qbittorrent.exe", "/NH"])
        .output()
        .await
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .to_ascii_lowercase()
            .contains("qbittorrent.exe"),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn qbit_exe_windows() -> String {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("qbittorrent.exe");
            if cand.is_file() {
                return cand.to_string_lossy().into_owned();
            }
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        let cand = std::path::Path::new(&pf).join("qBittorrent").join("qbittorrent.exe");
        if cand.is_file() {
            return cand.to_string_lossy().into_owned();
        }
    }
    "qbittorrent.exe".to_string()
}

#[tauri::command]
pub async fn qbit_status(app: AppHandle) -> Result<QbitStatus, VaultError> {
    if !daemon_running().await {
        return Ok(QbitStatus {
            daemon_running: false,
            connected: false,
            error: Some("qBittorrent daemon is not running.".into()),
        });
    }
    // Probe the Web UI via a cheap authenticated call. `qbittorrent_client.py`
    // exits 0 (ok) / 1 (auth) / 2 (network).
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(qbit_script())
        .arg("list-rss")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in qbit_env(&app) {
        cmd.env(k, v);
    }
    let code = cmd
        .status()
        .await
        .map_err(|e| VaultError::Io(format!("spawn qbittorrent_client.py: {e}")))?
        .code();
    let (connected, error) = match code {
        Some(0) => (true, None),
        Some(1) => (
            false,
            Some("Authentication failed — check the qBittorrent username/password.".into()),
        ),
        _ => (false, Some("Cannot reach the qBittorrent Web UI.".into())),
    };
    Ok(QbitStatus {
        daemon_running: true,
        connected,
        error,
    })
}

#[tauri::command]
pub async fn qbit_start_daemon() -> Result<(), VaultError> {
    if daemon_running().await {
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        TokioCommand::new("qbittorrent-nox")
            .arg("-d")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| VaultError::Io(format!("start qbittorrent-nox: {e}")))?;
    }
    #[cfg(windows)]
    {
        // Launch the GUI (Web UI must be enabled in its settings for control).
        let exe = qbit_exe_windows();
        TokioCommand::new(&exe)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| VaultError::Io(format!("start {exe}: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn qbit_stop_daemon() -> Result<(), VaultError> {
    #[cfg(not(windows))]
    {
        TokioCommand::new("pkill")
            .arg("-x")
            .arg("qbittorrent-nox")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| VaultError::Io(format!("stop qbittorrent-nox: {e}")))?;
    }
    #[cfg(windows)]
    {
        TokioCommand::new("taskkill")
            .args(["/IM", "qbittorrent.exe", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| VaultError::Io(format!("stop qbittorrent.exe: {e}")))?;
    }
    Ok(())
}
