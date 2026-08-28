//! Tauri-side backend shared by the in-app agents (Concierge, Analyst).
//! The `design_*` names predate the Atelier removal and are kept so the
//! frontend invoke names and the generated ACL don't churn.
//!
//! Exposes five `#[tauri::command]`s:
//!   - `agent_chat(system, messages, model)` — streams a Claude response via three
//!     Tauri events (`agent-chunk`, `agent-done`, `agent-error`).
//!   - `agent_chat_cli(...)` — the same over a spawned `claude` CLI subprocess.
//!   - `design_cli_auth_status(cli_path)` — reports whether that CLI is
//!     installed and logged in.
//!   - `design_set_api_key(key)` / `design_get_api_key() -> bool` — persists
//!     and reports presence of the Anthropic API key via the OS keychain.
//!     The getter never returns the key itself.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const SERVICE: &str = "mortar-pestle";
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

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|h| h.join("Code").join("mortar-pestle"))
                .unwrap_or_else(|| PathBuf::from("mortar-pestle"))
        })
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

/// RAII temp file holding a Claude CLI system prompt. On Windows `claude` is an
/// npm `.cmd` shim run through cmd.exe, whose command line is capped at 8191
/// chars — a large system prompt passed via `--system-prompt` overflows it and
/// surfaces as os error 206 ("filename or extension too long"). Stage it here
/// and pass `--system-prompt-file <path>` instead. The path is short; the blob
/// stays off the command line. The file is deleted on drop.
pub(crate) struct SystemPromptFile(PathBuf);
impl SystemPromptFile {
    pub(crate) fn new(content: &str) -> std::io::Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join(format!("mp-claude-sp-{}-{}.txt", std::process::id(), n));
        std::fs::write(&path, content)?;
        Ok(Self(path))
    }
    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for SystemPromptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
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
    let output = crate::commands::proc_util::tokio_cmd(&resolved)
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

    // Stage the system prompt in a temp file (see SystemPromptFile) and pass
    // --system-prompt-file so it never touches the command line.
    let sp_file = SystemPromptFile::new(&system).map_err(|e| {
        let msg = format!("failed to stage system prompt: {e}");
        let _ = app.emit("agent-error", json!({ "code": "IO", "message": &msg }));
        DesignError::Io(msg)
    })?;

    // Run the CLI from the repo root so @Component (path:line:col) mentions
    // resolve: the agent's Read/Glob/Grep are cwd-relative, and the marked
    // source paths are repo-relative (e.g. `modules/...`, `web/src/...`).
    // Guarded: in a packaged build CARGO_MANIFEST_DIR points at the build
    // machine, so skip setting cwd there (the source tree isn't on disk in
    // prod anyway) rather than fail the spawn.
    let root = project_root();
    let mut cmd = crate::commands::proc_util::tokio_cmd(&resolved);
    cmd.arg("--print")
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
        .arg("--system-prompt-file")
        .arg(sp_file.path())
        .arg("--model")
        .arg(&model_alias);
    if root.is_dir() {
        cmd.current_dir(&root);
    }
    let spawn_result = cmd
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
