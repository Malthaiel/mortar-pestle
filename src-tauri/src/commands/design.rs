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

const ALLOWED_PREFIXES: &[&str] = &["web/src/", "web/styles/"];

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
    let mut cmd = TokioCommand::new(&resolved);
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

// ── SF11: Working-tree git surface ───────────────────────────────────────
// The Atelier agent edits files directly (Write/Edit, no Bash) and leaves
// them dirty in the working tree — there is no git step in the agent flow.
// These three commands give the in-app WorkingTreeTray a way to list, commit,
// and discard those dirty (tracked-modified) files without the user dropping
// to a terminal. Reuses the release.rs git convention: bare `git` on PATH
// with `git -C <root>` for cwd (git.exe is not a .cmd shim, unlike `claude`).
//
// v1 scope: tracked-modified only (porcelain ` M`/`MM`/`M `, skip `??`);
// discard = `git checkout --` (unstaged only — the agent never stages);
// fixed auto-generated commit message; no per-file commit.

#[derive(Serialize)]
pub struct GitDirtyFile {
    pub path: String,
    pub staged: bool,
}

#[derive(Serialize)]
pub struct GitCommitOut {
    pub sha: String,
    pub count: usize,
    pub message: String,
}

/// Run `git -C <root> status --porcelain=v1 -z` and return raw stdout, or
/// `None` if `git` is missing or <root> is not a repo (end-user installs may
/// have neither — mirror release.rs `in_git_repo` tolerance).
async fn git_porcelain(root: &Path) -> Option<String> {
    let out = TokioCommand::new("git")
        .arg("-C")
        .arg(root)
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-z")
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `--porcelain=v1 -z` output into tracked-modified files. Skips
/// untracked (`??`) and ignored (`!!`) entries. For renames/copies (`R`/`C`)
/// the next NUL token is the destination path — consume it and use it.
fn parse_dirty(stdout: &str) -> Vec<GitDirtyFile> {
    let mut files = Vec::new();
    let mut tokens = stdout.split('\0');
    while let Some(tok) = tokens.next() {
        let bytes = tok.as_bytes();
        if bytes.len() < 4 {
            continue;
        }
        let x = bytes[0] as char;
        if x == '?' || x == '!' {
            continue;
        }
        // tok = "XY <path>" — bytes[2] is a space, path starts at index 3.
        let path = &tok[3..];
        let final_path = if x == 'R' || x == 'C' {
            tokens.next().unwrap_or(path)
        } else {
            path
        };
        let staged = x != ' ' && x != '?';
        files.push(GitDirtyFile {
            path: final_path.to_string(),
            staged,
        });
    }
    files
}

#[tauri::command]
pub async fn design_git_status(_app: AppHandle) -> Result<Vec<GitDirtyFile>, DesignError> {
    let root = project_root();
    Ok(match git_porcelain(&root).await {
        Some(stdout) => parse_dirty(&stdout),
        None => Vec::new(),
    })
}

#[tauri::command]
pub async fn design_git_commit(_app: AppHandle) -> Result<GitCommitOut, DesignError> {
    let root = project_root();
    let dirty = match git_porcelain(&root).await {
        Some(stdout) => parse_dirty(&stdout),
        None => return Err(DesignError::Io("not a git repository".into())),
    };
    if dirty.is_empty() {
        return Err(DesignError::Io("nothing to commit".into()));
    }
    let count = dirty.len();
    let message = format!("feat(atelier): {count} file(s) from working tree");

    // Stage modified+deleted tracked files only (skips untracked, so the
    // commit matches exactly what the tray showed).
    let add = TokioCommand::new("git")
        .arg("-C")
        .arg(&root)
        .arg("add")
        .arg("-u")
        .output()
        .await
        .map_err(|e| DesignError::Io(format!("git add: {e}")))?;
    if !add.status.success() {
        return Err(DesignError::Io(format!(
            "git add -u failed: {}",
            String::from_utf8_lossy(&add.stderr)
        )));
    }

    let commit = TokioCommand::new("git")
        .arg("-C")
        .arg(&root)
        .arg("commit")
        .arg("-m")
        .arg(&message)
        .output()
        .await
        .map_err(|e| DesignError::Io(format!("git commit: {e}")))?;
    if !commit.status.success() {
        return Err(DesignError::Io(format!(
            "git commit failed: {}",
            String::from_utf8_lossy(&commit.stderr)
        )));
    }

    let rev = TokioCommand::new("git")
        .arg("-C")
        .arg(&root)
        .arg("rev-parse")
        .arg("--short")
        .arg("HEAD")
        .output()
        .await
        .map_err(|e| DesignError::Io(format!("git rev-parse: {e}")))?;
    let sha = String::from_utf8_lossy(&rev.stdout).trim().to_string();
    Ok(GitCommitOut { sha, count, message })
}

/// Discard (git checkout) dirty tracked files. `paths` empty = all
/// tracked-modified; non-empty = just those. Returns the count reverted.
/// Note: `git checkout --` reverts unstaged worktree modifications only —
/// it does not touch the staged index. v1 assumes the agent never stages.
#[tauri::command]
pub async fn design_git_discard(_app: AppHandle, paths: Vec<String>) -> Result<usize, DesignError> {
    let root = project_root();
    let porcelain = match git_porcelain(&root).await {
        Some(s) => s,
        None => return Ok(0),
    };
    let before = parse_dirty(&porcelain);
    if paths.is_empty() {
        if before.is_empty() {
            return Ok(0);
        }
        let out = TokioCommand::new("git")
            .arg("-C")
            .arg(&root)
            .arg("checkout")
            .arg("--")
            .arg(".")
            .output()
            .await
            .map_err(|e| DesignError::Io(format!("git checkout: {e}")))?;
        if !out.status.success() {
            return Err(DesignError::Io(format!(
                "git checkout failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        return Ok(before.len());
    }
    let mut count = 0;
    for p in &paths {
        let out = TokioCommand::new("git")
            .arg("-C")
            .arg(&root)
            .arg("checkout")
            .arg("--")
            .arg(p)
            .output()
            .await
            .map_err(|e| DesignError::Io(format!("git checkout {p}: {e}")))?;
        if out.status.success() {
            count += 1;
        }
    }
    Ok(count)
}
