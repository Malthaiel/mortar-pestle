//! SF3 of Design Mode plan — Tauri-side backend for the in-app Atelier
//! agent + scoped read/write surface for the design environment.
//!
//! Exposes five `#[tauri::command]`s:
//!   - `agent_chat(system, messages, model)` — streams a Claude response via three
//!     Tauri events (`agent-chunk`, `agent-done`, `agent-error`).
//!   - `design_set_api_key(key)` / `design_get_api_key() -> bool` — persists
//!     and reports presence of the Anthropic API key via the OS keychain
//!     (libsecret on Linux). The getter never returns the key itself.
//!   - `design_read_file(rel_path)` / `design_write_file(rel_path, content)` —
//!     scope-locked read/write under `web/src/` + `web/styles/` only; reuses
//!     `vault::atomic_write` for the writer.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

use crate::commands::vault;

const SERVICE: &str = "iskariel";
const ACCOUNT: &str = "anthropic";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
/// Map the UI model alias (`opus`/`sonnet`/`haiku`, from `settings.agents.model`)
/// to a full Anthropic API model ID. The raw Messages API requires the full ID;
/// only the CLI path (`agent_chat_cli`) accepts the bare alias.
fn resolve_api_model(alias: &str) -> &'static str {
    match alias {
        "sonnet" => "claude-sonnet-4-6",
        "haiku" => "claude-haiku-4-5",
        _ => "claude-opus-4-8", // "opus" and any unexpected value
    }
}

const ALLOWED_PREFIXES: &[&str] = &["web/src/", "web/styles/"];

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|h| h.join("Code").join("iskariel"))
                .unwrap_or_else(|| PathBuf::from("iskariel"))
        })
}

fn check_path(rel: &str) -> Result<PathBuf, DesignError> {
    if rel.is_empty() || rel.contains('\0') || rel.contains("..") {
        return Err(DesignError::Invalid(format!("invalid path: {rel}")));
    }
    let allowed = ALLOWED_PREFIXES.iter().any(|p| rel.starts_with(p));
    if !allowed {
        return Err(DesignError::Invalid(format!(
            "path not in allowlist (web/src/, web/styles/): {rel}"
        )));
    }
    Ok(project_root().join(rel))
}

#[derive(Debug)]
pub enum DesignError {
    Invalid(String),
    NotFound(String),
    Auth(String),
    Network(String),
    Io(String),
}

impl Serialize for DesignError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(2))?;
        match self {
            DesignError::Invalid(msg) => {
                m.serialize_entry("code", "INVALID")?;
                m.serialize_entry("message", msg)?;
            }
            DesignError::NotFound(msg) => {
                m.serialize_entry("code", "NOT_FOUND")?;
                m.serialize_entry("message", msg)?;
            }
            DesignError::Auth(msg) => {
                m.serialize_entry("code", "AUTH")?;
                m.serialize_entry("message", msg)?;
            }
            DesignError::Network(msg) => {
                m.serialize_entry("code", "NETWORK")?;
                m.serialize_entry("message", msg)?;
            }
            DesignError::Io(msg) => {
                m.serialize_entry("code", "IO")?;
                m.serialize_entry("message", msg)?;
            }
        }
        m.end()
    }
}

impl From<std::io::Error> for DesignError {
    fn from(e: std::io::Error) -> Self {
        DesignError::Io(e.to_string())
    }
}

impl From<reqwest::Error> for DesignError {
    fn from(e: reqwest::Error) -> Self {
        DesignError::Network(e.to_string())
    }
}

impl From<vault::VaultError> for DesignError {
    fn from(e: vault::VaultError) -> Self {
        match e {
            vault::VaultError::Invalid(m) => DesignError::Invalid(m),
            vault::VaultError::NotFound(m) => DesignError::NotFound(m),
            vault::VaultError::NotFile => DesignError::Invalid("Not a file".into()),
            vault::VaultError::Conflict { .. } => DesignError::Invalid("Conflict".into()),
            vault::VaultError::ManifestUnavailable => {
                DesignError::Invalid("Manifest unavailable".into())
            }
            vault::VaultError::Io(m) => DesignError::Io(m),
        }
    }
}

fn load_api_key() -> Result<String, DesignError> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        if let Ok(k) = entry.get_password() {
            if !k.is_empty() {
                return Ok(k);
            }
        }
    }
    std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| DesignError::Auth("No API key in keychain or ANTHROPIC_API_KEY env".into()))
}

#[tauri::command]
pub fn design_set_api_key(key: String) -> Result<(), DesignError> {
    if key.trim().is_empty() {
        return Err(DesignError::Invalid("empty key".into()));
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| DesignError::Io(format!("keyring open: {e}")))?;
    entry
        .set_password(&key)
        .map_err(|e| DesignError::Io(format!("keyring set: {e}")))
}

#[tauri::command]
pub fn design_get_api_key() -> bool {
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        if let Ok(k) = entry.get_password() {
            return !k.is_empty();
        }
    }
    std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

#[tauri::command]
pub fn design_read_file(rel_path: String) -> Result<String, DesignError> {
    let abs = check_path(&rel_path)?;
    if !abs.is_file() {
        return Err(DesignError::NotFound(rel_path));
    }
    fs::read_to_string(&abs).map_err(Into::into)
}

#[tauri::command]
pub fn design_write_file(rel_path: String, content: String) -> Result<(), DesignError> {
    let abs = check_path(&rel_path)?;
    vault::atomic_write(&abs, content.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn agent_chat(
    app: AppHandle,
    system: String,
    messages: Value,
    model: String,
) -> Result<(), DesignError> {
    let key = match load_api_key() {
        Ok(k) => k,
        Err(e) => {
            let _ = app.emit(
                "agent-error",
                json!({ "code": "AUTH", "message": format!("{e:?}") }),
            );
            return Err(e);
        }
    };

    let body = json!({
        "model": resolve_api_model(&model),
        "max_tokens": 16000,
        "stream": true,
        "system": system,
        "messages": messages,
    });

    let resp = reqwest::Client::new()
        .post(ANTHROPIC_URL)
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(DesignError::from)?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let code = if status.as_u16() == 401 { "AUTH" } else { "NETWORK" };
        let msg = format!("{status}: {text}");
        let _ = app.emit("agent-error", json!({ "code": code, "message": msg.clone() }));
        return Err(if code == "AUTH" {
            DesignError::Auth(msg)
        } else {
            DesignError::Network(msg)
        });
    }

    let mut stream = resp.bytes_stream().eventsource();
    while let Some(event) = stream.next().await {
        let event = match event {
            Ok(e) => e,
            Err(e) => {
                let _ = app.emit(
                    "agent-error",
                    json!({ "code": "NETWORK", "message": e.to_string() }),
                );
                return Err(DesignError::Network(e.to_string()));
            }
        };
        let parsed: Value = match serde_json::from_str(&event.data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let typ = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match typ {
            "content_block_delta" => {
                let text = parsed
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                if !text.is_empty() {
                    let _ = app.emit("agent-chunk", json!({ "text": text }));
                }
            }
            "message_stop" => {
                let _ = app.emit("agent-done", ());
            }
            "error" => {
                let _ = app.emit("agent-error", parsed.clone());
            }
            _ => {}
        }
    }

    Ok(())
}

// ── Claude Code CLI subprocess backend (v1.5.0) ──────────────────────────
// Alternative auth path for Claude Pro/Max subscribers who don't have an
// Anthropic API key. Spawns the installed `claude` binary with
// `--output-format stream-json` and re-emits its events into the existing
// `agent-chunk` / `agent-done` / `agent-error` contract so the React side
// (useAgentChat.js) needs no awareness of which backend is active.

/// Resolve the `claude` binary. A non-empty Settings override wins; otherwise look it up
/// on PATH, then fall back to common user install locations. The systemd-launched dev
/// service (and the packaged app) often has a minimal PATH that omits ~/.local/bin — where
/// `claude` is installed — so a bare "claude" spawn fails with NotFound even though it's
/// installed + logged in. pub(crate) so coaching.rs's classify reuses the same resolution.
pub(crate) fn resolve_cli_path(setting_override: &str) -> String {
    let trimmed = setting_override.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    // Windows: `claude` is an npm `.cmd` shim — the bare name won't auto-probe
    // `.cmd`, so resolve it explicitly. std::process::Command runs a full-path
    // `.cmd` via cmd.exe automatically (Rust ≥ 1.77).
    #[cfg(windows)]
    {
        let names = ["claude.cmd", "claude.exe", "claude.bat"];
        if let Ok(path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path) {
                for name in names {
                    let cand = dir.join(name);
                    if cand.is_file() {
                        return cand.to_string_lossy().into_owned();
                    }
                }
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            for name in names {
                let cand = Path::new(&appdata).join("npm").join(name);
                if cand.is_file() {
                    return cand.to_string_lossy().into_owned();
                }
            }
        }
        "claude.cmd".to_string()
    }
    #[cfg(not(windows))]
    {
        if let Ok(path) = std::env::var("PATH") {
            for dir in path.split(':').filter(|d| !d.is_empty()) {
                let cand = Path::new(dir).join("claude");
                if cand.is_file() {
                    return cand.to_string_lossy().into_owned();
                }
            }
        }
        if let Some(home) = dirs::home_dir() {
            for rel in ["bin/claude", ".local/bin/claude", ".bun/bin/claude", ".npm-global/bin/claude"] {
                let cand = home.join(rel);
                if cand.is_file() {
                    return cand.to_string_lossy().into_owned();
                }
            }
        }
        "claude".to_string()
    }
}

fn flatten_messages_to_prompt(messages: &Value) -> String {
    let Some(arr) = messages.as_array() else {
        return String::new();
    };
    arr.iter()
        .filter_map(|msg| {
            let role = msg.get("role")?.as_str()?;
            let content = msg.get("content")?.as_str()?;
            Some(format!("[{}]\n{}", role.to_uppercase(), content))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[derive(Serialize)]
pub struct CliAuthStatus {
    installed: bool,
    #[serde(rename = "loggedIn")]
    logged_in: bool,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
    email: Option<String>,
    #[serde(rename = "resolvedPath")]
    resolved_path: String,
}

#[tauri::command]
pub async fn design_cli_auth_status(cli_path: String) -> CliAuthStatus {
    let resolved = resolve_cli_path(&cli_path);
    let output = TokioCommand::new(&resolved)
        .arg("auth")
        .arg("status")
        .output()
        .await;
    match output {
        Err(_) => CliAuthStatus {
            installed: false,
            logged_in: false,
            subscription_type: None,
            email: None,
            resolved_path: resolved,
        },
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let parsed: Value = serde_json::from_str(&stdout).unwrap_or(Value::Null);
            CliAuthStatus {
                installed: true,
                logged_in: parsed
                    .get("loggedIn")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                subscription_type: parsed
                    .get("subscriptionType")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                email: parsed
                    .get("email")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                resolved_path: resolved,
            }
        }
    }
}

#[tauri::command]
pub async fn agent_chat_cli(
    app: AppHandle,
    system: String,
    messages: Value,
    model: String,
    cli_path: String,
) -> Result<(), DesignError> {
    let resolved = resolve_cli_path(&cli_path);
    let prompt = flatten_messages_to_prompt(&messages);
    if prompt.is_empty() {
        return Err(DesignError::Invalid("no messages".into()));
    }

    let model_alias = if matches!(model.as_str(), "opus" | "sonnet" | "haiku") {
        model
    } else {
        "opus".to_string()
    };

    let spawn_result = TokioCommand::new(&resolved)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--no-session-persistence")
        .arg("--setting-sources")
        .arg("")
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .arg("--allowed-tools")
        .arg("Read Glob Grep Edit Write")
        .arg("--system-prompt")
        .arg(&system)
        .arg("--model")
        .arg(&model_alias)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            let is_missing = e.kind() == std::io::ErrorKind::NotFound;
            let (code, err) = if is_missing {
                let msg = format!("`claude` binary not found at path: {resolved}. Install Claude Code or set Settings → Design → Claude CLI path.");
                ("AUTH", DesignError::Auth(msg))
            } else {
                let msg = format!("failed to spawn `claude`: {e}");
                ("IO", DesignError::Io(msg))
            };
            let _ = app.emit(
                "agent-error",
                json!({ "code": code, "message": format!("{err:?}") }),
            );
            return Err(err);
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
            let _ = app.emit(
                "agent-error",
                json!({ "code": "IO", "message": e.to_string() }),
            );
            return Err(DesignError::Io(e.to_string()));
        }
        drop(stdin);
    }

    let mut auth_or_net_error: Option<DesignError> = None;

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let parsed: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let top_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match top_type {
                "stream_event" => {
                    let Some(event) = parsed.get("event") else {
                        continue;
                    };
                    let ev_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match ev_type {
                        "content_block_delta" => {
                            let Some(delta) = event.get("delta") else {
                                continue;
                            };
                            let delta_type =
                                delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if delta_type == "text_delta" {
                                if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                    if !text.is_empty() {
                                        let _ = app
                                            .emit("agent-chunk", json!({ "text": text }));
                                    }
                                }
                            }
                        }
                        "message_stop" => {
                            let _ = app.emit("agent-done", ());
                        }
                        _ => {}
                    }
                }
                "result" => {
                    let is_error = parsed
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if is_error {
                        let status = parsed
                            .get("api_error_status")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let result_text = parsed
                            .get("result")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown CLI error");
                        let code = if status == 401 { "AUTH" } else { "NETWORK" };
                        let msg = format!("claude CLI: {result_text} (status {status})");
                        let _ = app.emit(
                            "agent-error",
                            json!({ "code": code, "message": msg.clone() }),
                        );
                        auth_or_net_error = Some(if code == "AUTH" {
                            DesignError::Auth(msg)
                        } else {
                            DesignError::Network(msg)
                        });
                    }
                }
                _ => {}
            }
        }
    }

    let _ = child.wait().await;
    match auth_or_net_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

// ── SF10: Pending edits persistence ──────────────────────────────────────
// Mirrors the sidebar_get_order / sidebar_set_order pattern: a single JSON
// file at `<app_config>/design-pending.json`, write-serialized via Mutex,
// committed atomically via `vault::atomic_write`. The web side
// (usePendingEdits.js) load-on-mount and debounce-saves on every overrides
// change so uncommitted edits survive across sessions.

static PENDING_WRITE_LOCK: Mutex<()> = Mutex::new(());

const PENDING_FILE: &str = "design-pending.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingEdit {
    pub id: String,
    pub component: String,
    pub source: String,
    /// "var" → CSS-variable override (commit-to-source supported)
    /// "prop" → direct property override (raw px / color, no commit)
    pub target: String,
    pub property: String,
    /// CSS-variable name (`--radius-md`) when target=="var", or
    /// CSS-property name (`padding`) when target=="prop".
    pub name: String,
    pub value: String,
    pub sel_class: String,
}

fn pending_file(app: &AppHandle) -> Result<PathBuf, DesignError> {
    Ok(crate::commands::sidebar::app_config_root(app)
        .map_err(DesignError::from)?
        .join(PENDING_FILE))
}

fn load_pending(path: &Path) -> Vec<PendingEdit> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_else(|e| {
        log::warn!("design-pending.json parse failed ({e}) — treating as empty");
        Vec::new()
    })
}

fn persist_pending(path: &Path, edits: &[PendingEdit]) -> Result<(), DesignError> {
    let mut text = serde_json::to_string_pretty(edits)
        .map_err(|e| DesignError::Io(format!("serialize design-pending.json: {e}")))?;
    text.push('\n');
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| DesignError::Io(format!("mkdir {parent:?}: {e}")))?;
    }
    vault::atomic_write(path, text.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn design_pending_get(app: AppHandle) -> Result<Vec<PendingEdit>, DesignError> {
    let path = pending_file(&app)?;
    Ok(load_pending(&path))
}

#[tauri::command]
pub fn design_pending_set(app: AppHandle, edits: Vec<PendingEdit>) -> Result<(), DesignError> {
    let _guard = PENDING_WRITE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let path = pending_file(&app)?;
    persist_pending(&path, &edits)
}
