//! Deadlock Scrim Coaching backend commands.
//!
//! `coaching_read_image` reads a user-picked image (the scoreboard screenshot,
//! chosen via the file dialog) and returns it as a `data:` URL so the ScrimViewer
//! can show it inline. Unlike the `mortar-pestle-asset://` scheme — which rejects any
//! path outside the vault / media roots (`asset_protocol::is_under_allowed_root`)
//! — this serves the file wherever it lives, because the path came from an
//! explicit user file-pick (trusted) and never widens the asset allowlist. Capped
//! so a pathological file can't be base64'd into the DOM.
//!
//! `deadlock_fetch_match` pulls a Deadlock match's full metadata by Match ID from
//! the public deadlock-api (`/v1/matches/{id}/metadata`), returning the raw JSON
//! verbatim — the data half of the ScrimViewer's per-match "Run Process" button.

use std::path::Path;
use std::path::PathBuf;

use tauri_plugin_opener::OpenerExt;
use tokio::process::Command as TokioCommand;

use crate::commands::vault::VaultError;
use crate::parsers::video_transcode::{compute_hash, mtime_ms_for};

const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024; // 25 MB

/// Standard base64 (RFC 4648, `+/`, `=` padding). Hand-rolled to avoid pulling a
/// dependency for one small encode; base64 is a trivial, non-security encoding.
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub fn coaching_read_image(path: String) -> Result<String, VaultError> {
    if path.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    let canonical = std::fs::canonicalize(PathBuf::from(&path))
        .map_err(|_| VaultError::NotFound(format!("Image not found: {path}")))?;
    let meta = std::fs::metadata(&canonical).map_err(|e| VaultError::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(VaultError::NotFile);
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(VaultError::Invalid("image too large (max 25 MB)".into()));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| VaultError::Io(e.to_string()))?;
    Ok(format!("data:{};base64,{}", mime_for(&canonical), base64_encode(&bytes)))
}

/// Open a user-picked recording (`.mp4`) in the OS default application. No allowlist
/// gate — the path came from an explicit file-pick and a scrim recording legitimately
/// lives outside the vault. Launches the external app only; serves nothing to the webview.
#[tauri::command]
pub fn coaching_open_path(app: tauri::AppHandle, path: String) -> Result<(), VaultError> {
    if path.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    let canonical = std::fs::canonicalize(PathBuf::from(&path))
        .map_err(|_| VaultError::NotFound(format!("Path not found: {path}")))?;
    if !canonical.is_file() {
        return Err(VaultError::NotFile);
    }
    app.opener()
        .open_path(canonical.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| VaultError::Io(e.to_string()))
}

// ── Comms Extraction (audio → 16 kHz mono WAV) ───────────────────────────────
// Deadlock Scrim Coaching sub-plan 4. A match's Scrim Recording `.mp4` carries the
// coached team's voice comms; `coaching_extract_audio` shells system ffmpeg to a
// disposable 16 kHz mono WAV in the cache dir — the only format the `mortar-pestle-stt`
// sidecar (`stt_transcribe_file`) decodes (WAV/PCM). Extracting here keeps the STT
// engine untouched and is robust to any source codec; the frontend feeds the returned
// path straight to `stt_transcribe_file`. Mirrors the `video_transcode` ffmpeg lane.

/// Comms WAVs older than this are evicted on the next extraction (best-effort).
const COMMS_CACHE_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60; // 7 days

/// `<cache>/mortar-pestle/comms/`, created on demand. Mirrors `video_transcode::cache_root`.
fn comms_cache_dir() -> Result<PathBuf, VaultError> {
    let base = dirs::cache_dir().ok_or_else(|| VaultError::Io("cache_dir() unavailable".into()))?;
    let dir = base.join("mortar-pestle/comms");
    std::fs::create_dir_all(&dir).map_err(|e| VaultError::Io(format!("mkdir comms cache: {e}")))?;
    Ok(dir)
}

/// Best-effort eviction of stale comms WAVs and orphaned `.wav.part` files (crashed
/// runs). The just-written WAV has a fresh mtime, so the age filter always skips it.
fn prune_comms_cache(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !matches!(path.extension().and_then(|e| e.to_str()), Some("wav") | Some("part")) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age.as_secs() > COMMS_CACHE_MAX_AGE_SECS)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Extract a recording's audio to a disposable 16 kHz mono WAV and return its path.
/// Canonicalizes + `is_file`-guards the user-picked recording (trusted file-pick, like
/// `coaching_read_image`), then shells system ffmpeg (`-vn -ac 1 -ar 16000 -f wav`) to
/// `<cache>/mortar-pestle/comms/<hash>.wav`, writing `<hash>.wav.part` first and renaming
/// atomically on success. The cache key is the recording's canonical path + mtime, so a
/// re-extract of the same file is a no-op fast-path (the heavy, re-runnable pass is STT,
/// not extraction). Mirrors `video_transcode::extract_subs_sync`.
#[tauri::command]
pub async fn coaching_extract_audio(video: String) -> Result<String, VaultError> {
    if video.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    let canonical = std::fs::canonicalize(PathBuf::from(&video))
        .map_err(|_| VaultError::NotFound(format!("Recording not found: {video}")))?;
    if !canonical.is_file() {
        return Err(VaultError::NotFile);
    }

    let dir = comms_cache_dir()?;
    prune_comms_cache(&dir);

    let hash = compute_hash(&canonical.to_string_lossy(), None, mtime_ms_for(&canonical));
    let out_path = dir.join(format!("{hash}.wav"));
    if out_path.exists() {
        return Ok(out_path.to_string_lossy().into_owned());
    }
    let partial = out_path.with_extension("wav.part");

    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        canonical.to_string_lossy().into_owned(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-f".into(),
        "wav".into(),
        "-y".into(),
        partial.display().to_string(),
    ];

    let output = TokioCommand::new(crate::tool_path::resolve("ffmpeg"))
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("ffmpeg comms spawn: {e}")))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&partial);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(VaultError::Io(format!(
            "ffmpeg comms exit {}: {}",
            output.status,
            &stderr.chars().take(400).collect::<String>()
        )));
    }

    std::fs::rename(&partial, &out_path)
        .map_err(|e| VaultError::Io(format!("rename comms partial: {e}")))?;
    Ok(out_path.to_string_lossy().into_owned())
}

// ── Match Data Ingestion ────────────────────────────────────────────────────
// Pulls a Deadlock match's full metadata by Match ID from the public deadlock-api
// and hands it back to the ScrimViewer verbatim. The endpoint is public — no API
// key (a key would only lift the 100 req/10s-per-IP rate limit, irrelevant here).

const DEADLOCK_API_BASE: &str = "https://api.deadlock-api.com";
const FETCH_TIMEOUT_SECS: u64 = 20;

/// Typed errors for `deadlock_fetch_match`, serialized as `{ code, message }` so the
/// frontend can branch on `e.code` (mirrors `VaultError`'s wire shape).
#[derive(Debug)]
pub enum DeadlockError {
    Invalid(String),
    NotFound(String),
    RateLimited(String),
    Network(String),
    Upstream(String),
    Auth(String),
}

impl serde::Serialize for DeadlockError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let (code, message) = match self {
            DeadlockError::Invalid(m) => ("INVALID", m.as_str()),
            DeadlockError::NotFound(m) => ("NOT_FOUND", m.as_str()),
            DeadlockError::RateLimited(m) => ("RATE_LIMITED", m.as_str()),
            DeadlockError::Network(m) => ("NETWORK", m.as_str()),
            DeadlockError::Upstream(m) => ("UPSTREAM", m.as_str()),
            DeadlockError::Auth(m) => ("AUTH", m.as_str()),
        };
        let mut map = s.serialize_map(Some(2))?;
        map.serialize_entry("code", code)?;
        map.serialize_entry("message", message)?;
        map.end()
    }
}

/// Fetch a Deadlock match's full metadata by Match ID from the public deadlock-api
/// (`GET /v1/matches/{id}/metadata`). Returns the raw JSON verbatim as
/// `serde_json::Value` so no field is dropped ("pull literally everything"); the
/// ScrimViewer renders a structured view over it and persists the raw block.
#[tauri::command]
pub async fn deadlock_fetch_match(match_id: String) -> Result<serde_json::Value, DeadlockError> {
    let id = match_id.trim();
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(DeadlockError::Invalid(format!(
            "Match ID must be a number (got {match_id:?})"
        )));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent("mortar-pestle/1.0 (deadlock-scrim-coaching)")
        .build()
        .map_err(|e| DeadlockError::Network(format!("HTTP client init failed: {e}")))?;

    let url = format!("{DEADLOCK_API_BASE}/v1/matches/{id}/metadata");
    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_timeout() {
            DeadlockError::Network(format!("Request timed out after {FETCH_TIMEOUT_SECS}s"))
        } else {
            DeadlockError::Network(format!("Network error: {e}"))
        }
    })?;

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(DeadlockError::NotFound(format!("No match found for Match ID {id}")));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(DeadlockError::RateLimited(
            "deadlock-api rate limit hit — wait a moment and try again".into(),
        ));
    }
    if !status.is_success() {
        return Err(DeadlockError::Upstream(format!(
            "deadlock-api returned HTTP {}",
            status.as_u16()
        )));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| DeadlockError::Upstream(format!("Malformed JSON from deadlock-api: {e}")))
}

// ── Auto Classification (sub-plan 5) ─────────────────────────────────────────
// Headless, single-shot Claude call for AI move-classification: send a system prompt +
// a moments-digest user prompt, return the model's raw text (the frontend's
// parseClassifications turns it into validated suggestions). Deliberately NOT the
// design.rs agent_chat path — that streams into the global agent-* chat events and grants
// Read/Write/Edit tools. This is non-streaming, emits no events, and runs with NO tools:
// pure reasoning over the data we pass. Two backends mirror the design surface
// (settings.agents.authBackend): the Anthropic API key, or the `claude` CLI.

const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const CLASSIFY_TIMEOUT_SECS: u64 = 180; // a reasoned classify can run a while; non-streaming

/// settings.agents.model alias → Anthropic model id (defaults to the current best Opus).
fn classify_model_id(alias: &str) -> &'static str {
    match alias {
        "sonnet" => "claude-sonnet-4-6",
        "haiku" => "claude-haiku-4-5",
        _ => "claude-opus-4-8",
    }
}

/// Anthropic key from the OS keychain (same service/account as design.rs) or env.
/// Inlined here (vs reusing design::load_api_key) to keep this command self-contained
/// on DeadlockError — no cross-module error mapping.
fn classify_api_key() -> Result<String, DeadlockError> {
    if let Ok(entry) = keyring::Entry::new("mortar-pestle", "anthropic") {
        if let Ok(k) = entry.get_password() {
            if !k.is_empty() {
                return Ok(k);
            }
        }
    }
    std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| DeadlockError::Auth("No Anthropic API key in keychain or ANTHROPIC_API_KEY".into()))
}

/// Propose move classifications for a match. Returns the model's raw text; the frontend
/// parses + validates the JSON array. NO tools, no streaming, no events.
#[tauri::command]
pub async fn coaching_classify_match(
    system_prompt: String,
    user_prompt: String,
    backend: String,
    model: String,
    cli_path: String,
) -> Result<String, DeadlockError> {
    if user_prompt.trim().is_empty() {
        return Err(DeadlockError::Invalid("empty classify prompt".into()));
    }
    if backend == "claude-cli" {
        classify_via_cli(&system_prompt, &user_prompt, &model, &cli_path).await
    } else {
        classify_via_api(&system_prompt, &user_prompt, &model).await
    }
}

async fn classify_via_api(system: &str, user: &str, model: &str) -> Result<String, DeadlockError> {
    let key = classify_api_key()?;
    let body = serde_json::json!({
        "model": classify_model_id(model),
        "max_tokens": 16000,
        "thinking": { "type": "adaptive" },
        "output_config": { "effort": "high" },
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CLASSIFY_TIMEOUT_SECS))
        .build()
        .map_err(|e| DeadlockError::Network(format!("HTTP client init: {e}")))?;
    let resp = client
        .post(ANTHROPIC_MESSAGES_URL)
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                DeadlockError::Network(format!("Anthropic timed out after {CLASSIFY_TIMEOUT_SECS}s"))
            } else {
                DeadlockError::Network(format!("Anthropic request: {e}"))
            }
        })?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(DeadlockError::Auth("Anthropic rejected the API key (401)".into()));
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(DeadlockError::Upstream(format!(
            "Anthropic HTTP {}: {}",
            status.as_u16(),
            text.chars().take(400).collect::<String>()
        )));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| DeadlockError::Upstream(format!("Malformed Anthropic JSON: {e}")))?;
    // Adaptive thinking yields thinking blocks before text; keep only text blocks.
    let text = v
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(DeadlockError::Upstream("Anthropic returned no text content".into()));
    }
    Ok(text)
}

async fn classify_via_cli(
    system: &str,
    user: &str,
    model: &str,
    cli_path: &str,
) -> Result<String, DeadlockError> {
    use tokio::io::AsyncWriteExt;
    // Reuse design.rs's resolver: configured path → PATH lookup → ~/.local/bin fallback
    // (the systemd dev service's PATH omits ~/.local/bin where `claude` lives).
    let resolved = crate::commands::design::resolve_cli_path(cli_path);
    let alias = if matches!(model, "opus" | "sonnet" | "haiku") { model } else { "opus" };

    // --print --output-format json → one { type:"result", result, is_error } object.
    // No --allowed-tools, no --permission-mode bypassPermissions: pure reasoning.
    let mut child = TokioCommand::new(&resolved)
        .arg("--print")
        .arg("--output-format")
        .arg("json")
        .arg("--no-session-persistence")
        .arg("--setting-sources")
        .arg("")
        .arg("--system-prompt")
        .arg(system)
        .arg("--model")
        .arg(alias)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                DeadlockError::Auth(format!("`claude` binary not found at: {resolved}"))
            } else {
                DeadlockError::Network(format!("spawn claude: {e}"))
            }
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(user.as_bytes())
            .await
            .map_err(|e| DeadlockError::Network(format!("write claude stdin: {e}")))?;
        drop(stdin);
    }

    let out = child
        .wait_with_output()
        .await
        .map_err(|e| DeadlockError::Network(format!("claude wait: {e}")))?;
    if !out.status.success() {
        return Err(DeadlockError::Upstream(format!("claude exited {}", out.status)));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| DeadlockError::Upstream(format!("Malformed claude JSON: {e}")))?;
    if v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) {
        let msg = v.get("result").and_then(|s| s.as_str()).unwrap_or("claude error");
        return Err(DeadlockError::Upstream(format!("claude: {msg}")));
    }
    let text = v.get("result").and_then(|s| s.as_str()).unwrap_or("").to_string();
    if text.trim().is_empty() {
        return Err(DeadlockError::Upstream("claude returned empty result".into()));
    }
    Ok(text)
}
