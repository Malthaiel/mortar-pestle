//! Deadlock coaching backend commands.
//!
//! Scrim Teardown (2026-07-26) removed the scrim pages and both AI report
//! processes; what remains here is the reusable half. `deadlock_fetch_match`
//! pulls a Deadlock match's full metadata by Match ID from the public
//! deadlock-api (`/v1/matches/{id}/metadata`), returning the raw JSON verbatim.
//! `coaching_extract_audio` / `coaching_audio_track_count` serve the comms-job
//! transcription pipeline. `coaching_classify_match` is the generic one-shot AI
//! call the Analyst brain still uses, and `coaching_cancel` stops it.

use std::path::Path;
use std::path::PathBuf;

use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncBufReadExt;

use crate::commands::vault::VaultError;
use crate::parsers::video_transcode::{compute_hash_with_recipe, mtime_ms_for};

/// Highlight a GameWiki-vault file in the OS file manager (the "open in folder"
/// button on the VOD Review Report). `reveal_in_files` (media.rs) can't be reused:
/// it resolves relative paths against the *content* vault and its allowed-root gate
/// excludes the GameWiki vault. This resolves `path` against the GameWiki vault root
/// and gates the canonical result under it (the arg is an app-built relative scrim
/// path, not a user pick), then reveals via the opener plugin (same as reveal_in_files).
#[tauri::command]
pub fn coaching_reveal_path(app: tauri::AppHandle, path: String) -> Result<(), VaultError> {
    let canonical = gamewiki_resolve(&path)?;
    app.opener()
        .reveal_item_in_dir(&canonical)
        .map_err(|e| VaultError::Io(e.to_string()))
}

/// Resolve a GameWiki-relative path to its canonical on-disk path, refusing
/// anything that escapes the vault root.
fn gamewiki_resolve(path: &str) -> Result<PathBuf, VaultError> {
    if path.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    let root = std::fs::canonicalize(crate::commands::vault::gamewiki_vault_root())
        .map_err(|e| VaultError::Io(format!("gamewiki root: {e}")))?;
    let canonical = std::fs::canonicalize(root.join(path))
        .map_err(|_| VaultError::NotFound(format!("Path not found: {path}")))?;
    if !canonical.starts_with(&root) {
        return Err(VaultError::Invalid("path not under the GameWiki vault".into()));
    }
    Ok(canonical)
}

#[cfg(windows)]
fn copy_item_to_clipboard(p: &Path) -> windows::core::Result<()> {
    use windows::Win32::Foundation::{E_OUTOFMEMORY, HANDLE};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    // canonicalize() yields a \\?\ verbatim path; Explorer's paste wants the plain form.
    let s = p.to_string_lossy();
    let plain = s.strip_prefix(r"\\?\").unwrap_or(&s);
    // CF_HDROP layout: DROPFILES header, then UTF-16 paths, list ended by a double NUL.
    let wide: Vec<u16> = plain.encode_utf16().chain([0, 0]).collect();
    let header = std::mem::size_of::<DROPFILES>();
    let bytes = wide.len() * 2;
    unsafe {
        // ponytail: the block leaks (a few hundred bytes) if SetClipboardData fails;
        // add GlobalFree on that arm if it ever matters. On success Windows owns it.
        let hglob = GlobalAlloc(GMEM_MOVEABLE, header + bytes)?;
        let ptr = GlobalLock(hglob) as *mut u8;
        if ptr.is_null() {
            return Err(E_OUTOFMEMORY.into());
        }
        let df = DROPFILES { pFiles: header as u32, fWide: true.into(), ..Default::default() };
        std::ptr::copy_nonoverlapping(&df as *const DROPFILES as *const u8, ptr, header);
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr.add(header), bytes);
        // Reports "failure" once the lock count reaches zero — that is the expected case.
        let _ = GlobalUnlock(hglob);
        OpenClipboard(None)?;
        let r = EmptyClipboard()
            .and_then(|_| SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hglob.0))).map(|_| ()));
        let _ = CloseClipboard();
        r
    }
}

#[cfg(not(windows))]
fn copy_item_to_clipboard(_: &Path) -> Result<(), String> {
    Err("copying a file to the clipboard is Windows-only".into())
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
///
/// Count the audio streams in `path` via ffprobe — the reality check behind
/// [`coaching_extract_audio`]'s track guard. A probe that fails to spawn or returns
/// nothing yields 0, which makes any explicit track request fail loudly (correct:
/// we could not prove the requested track exists).
async fn audio_stream_count(path: &Path) -> Result<usize, VaultError> {
    let out = crate::commands::proc_util::tokio_cmd(crate::tool_path::resolve("ffprobe"))
        .args(["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0"])
        // `\\?\`-strip: ffprobe rejects the Windows verbatim path canonicalize() returns.
        .arg(crate::tool_path::native_str(&path.to_string_lossy()))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("ffprobe spawn: {e}")))?;
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).count())
}

/// How many audio tracks a recording has — backs the Comms/Mic Track dropdowns.
/// The guard in `coaching_extract_audio` only catches an OUT-OF-RANGE track; a
/// wrong-but-existing one still yields a silently empty transcript, so the picker
/// is populated from the file itself rather than typed free-hand.
#[tauri::command]
pub async fn coaching_audio_track_count(video: String) -> Result<usize, VaultError> {
    if video.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    let canonical = std::fs::canonicalize(PathBuf::from(&video))
        .map_err(|_| VaultError::NotFound(format!("Recording not found: {video}")))?;
    audio_stream_count(&canonical).await
}

/// How long a recording is, in seconds — the span the trim handles run over. `video_probe`
/// is the wrong tool for this: it is fenced to the configured media roots, and a coaching
/// capture lives wherever the broadcast engine put it.
#[tauri::command]
pub async fn coaching_media_duration(video: String) -> Result<f64, VaultError> {
    if video.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    let canonical = std::fs::canonicalize(PathBuf::from(&video))
        .map_err(|_| VaultError::NotFound(format!("Recording not found: {video}")))?;
    let out = crate::commands::proc_util::tokio_cmd(crate::tool_path::resolve("ffprobe"))
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        // `\?\`-strip: ffprobe rejects the Windows verbatim path canonicalize() returns.
        .arg(crate::tool_path::native_str(&canonical.to_string_lossy()))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("ffprobe spawn: {e}")))?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|_| VaultError::Io("ffprobe reported no duration for this recording".into()))
}

/// `start_secs` / `end_secs` optionally clip the pull to one window of the recording
/// (`-ss` before `-i` for a fast seek, `-t` for the length) — a two-hour VOD where only
/// the first ninety minutes are worth transcribing costs ninety minutes of STT, not two
/// hours. Both are positions in the ORIGINAL file; the caller offsets the returned
/// timestamps by `start_secs` so the transcript still points at the untrimmed recording.
/// Omitted / zero-length = the whole file, and the cache key is then byte-identical to
/// the pre-trim one.
///
/// `track` (sub-plan 6 SF2) optionally selects a single 0-based audio stream via
/// `-map 0:a:<track>` — the OBS isolated-track layout carries mic / Discord comms on
/// separate streams. Omitted / negative = the previous whole-audio downmix (sub-plan 4
/// callers are byte-identical: `track: None` folds into the cache key exactly as before).
#[tauri::command]
pub async fn coaching_extract_audio(
    video: String,
    track: Option<i32>,
    start_secs: Option<f64>,
    end_secs: Option<f64>,
) -> Result<String, VaultError> {
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

    // Fold the selected track into the cache key (compute_hash's `audio` slot) so
    // different tracks of one file don't collide. `None` → the pre-SF2 key verbatim.
    let sel = track.filter(|t| *t >= 0);
    // Clip window, normalised: a start beyond the end is a no-op rather than a negative -t.
    let start = start_secs.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
    let end = end_secs.filter(|v| v.is_finite() && *v > start);
    // A trimmed pull must not be served from (or overwrite) the whole-file wav, so the
    // window joins the cache key. No window = empty recipe = the legacy key verbatim.
    let recipe = match (start > 0.0, end) {
        (false, None) => String::new(),
        (_, e) => format!("clip{start:.3}-{}", e.map(|v| format!("{v:.3}")).unwrap_or_else(|| "end".into())),
    };
    let hash = compute_hash_with_recipe(
        &canonical.to_string_lossy(),
        sel.map(|t| t as i64),
        mtime_ms_for(&canonical),
        &recipe,
    );
    let out_path = dir.join(format!("{hash}.wav"));
    if out_path.exists() {
        return Ok(out_path.to_string_lossy().into_owned());
    }
    let partial = out_path.with_extension("wav.part");

    // Validate the requested track against the FILE before shelling ffmpeg. An
    // out-of-range `-map 0:a:<n>` dies with an opaque "Stream map '' matches no
    // streams" that names neither the track nor the file (hit live 2026-07-19:
    // `Comms Track: 4` against a 4-track VOD, i.e. valid indices 0..=3).
    //
    // The track number is a REMEMBERED GLOBAL (frontend localStorage
    // `gw-coach-tracks`) applied to every later recording, so one layout change
    // silently points it at a stream that doesn't exist.
    //
    // Deliberately NOT the tolerant `0:a:<n>?` form used by video_transcode.rs:
    // there, dropping a missing audio track still leaves a watchable video. Here
    // a tolerant map yields an EMPTY wav and therefore a silently empty
    // transcript — failing loudly is the whole point.
    if let Some(t) = sel {
        let n = audio_stream_count(&canonical).await?;
        if t as usize >= n {
            return Err(VaultError::Invalid(format!(
                "Audio track {t} doesn't exist in this recording. It has {n} audio track(s), \
                 numbered 0 to {}. Note they're counted from 0 here, while OBS labels them from 1 \
                 — so OBS track 1 is 0 here.",
                n.saturating_sub(1)
            )));
        }
    }

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];
    // Input-side seek: ffmpeg jumps to the keyframe rather than decoding and throwing away
    // everything before it. Must precede `-i`.
    if start > 0.0 {
        args.push("-ss".into());
        args.push(format!("{start:.3}"));
    }
    args.extend([
        "-i".into(),
        // `\\?\`-strip: canonicalize() hands ffmpeg a Windows verbatim path it
        // rejects as "Invalid argument". Mirrors video_transcode.rs:206/410.
        crate::tool_path::native_str(&canonical.to_string_lossy()),
    ]);
    // Length, counted from the seek point — `-to` shifts meaning depending on which side
    // of `-i` the `-ss` sits on, `-t` does not.
    if let Some(e) = end {
        args.push("-t".into());
        args.push(format!("{:.3}", e - start));
    }
    // Optional single-track select — must precede the output options.
    if let Some(t) = sel {
        args.push("-map".into());
        args.push(format!("0:a:{t}"));
    }
    args.extend([
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-f".into(),
        "wav".into(),
        "-y".into(),
        partial.display().to_string(),
    ]);

    let output = crate::commands::proc_util::tokio_cmd(crate::tool_path::resolve("ffmpeg"))
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
    /// The CLI was killed at the wall. Carries whatever text had already streamed in, so a long
    /// paid run is salvageable instead of silently discarded (the frontend persists `partial`).
    Timeout { message: String, partial: String },
    /// The user stopped the run from the UI. Carries the same salvage payload as `Timeout` —
    /// those words were already billed, so cancelling must not throw them away.
    Canceled { partial: String },
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
            DeadlockError::Timeout { message, .. } => ("TIMEOUT", message.as_str()),
            DeadlockError::Canceled { .. } => ("CANCELED", "cancelled by the user"),
        };
        let mut map = s.serialize_map(Some(3))?;
        map.serialize_entry("code", code)?;
        map.serialize_entry("message", message)?;
        if let DeadlockError::Timeout { partial, .. } | DeadlockError::Canceled { partial } = self {
            map.serialize_entry("partial", partial)?;
        }
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
// Matches CLASSIFY_CLI_TIMEOUT_SECS. Non-streaming, so the whole answer arrives at once: an
// un-capped VOD report (section length caps reverted 2026-07-20) is a long high-effort generation
// and the old 180s wall failed the draft outright rather than waiting for it.
const CLASSIFY_TIMEOUT_SECS: u64 = 20 * 60;

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
    app: tauri::AppHandle,
) -> Result<String, DeadlockError> {
    if user_prompt.trim().is_empty() {
        return Err(DeadlockError::Invalid("empty classify prompt".into()));
    }
    if backend == "claude-cli" {
        classify_via_cli(&system_prompt, &user_prompt, &model, &cli_path, &app).await
    } else {
        classify_via_api(&system_prompt, &user_prompt, &model).await
    }
}

async fn classify_via_api(system: &str, user: &str, model: &str) -> Result<String, DeadlockError> {
    let key = classify_api_key()?;
    let body = serde_json::json!({
        "model": classify_model_id(model),
        // 32k: the layered v2 analyst report (playerCards + macro + commsGrade) overflows 16k
        "max_tokens": 32000,
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

// 20 min: the schema-v2 analyst report (playerCards + macro + commsGrade + sections) is a
// 10k+ token single emission over a full VOD transcript — the old 5 min killed it mid-write,
// twice (once per retry), losing ~20 min of billed generation with nothing on disk.
const CLASSIFY_CLI_TIMEOUT_SECS: u64 = 20 * 60; // one-shot reasoning; hung CLI = kill + loud error

async fn classify_via_cli(
    system: &str,
    user: &str,
    model: &str,
    cli_path: &str,
    app: &tauri::AppHandle,
) -> Result<String, DeadlockError> {
    // No tools, default cwd: pure reasoning over the prompt.
    run_claude_cli(system, user, model, cli_path, None, None, CLASSIFY_CLI_TIMEOUT_SECS, app).await
}

/// Stop switch for whichever billed CLI run is live. Exactly one AI run happens app-wide at a
/// time (the frontend's job store enforces it), so one process-global signal is enough — and
/// `notify_waiters` only wakes waiters that are ALREADY parked, so a stale click cannot leak
/// forward and kill the next run the way a stored permit would.
static CANCEL: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Stop the running `claude` CLI call. Every billed path — first report, final report, teamfight
/// comms, analyst brain, auto-classify — funnels through `run_claude_cli`, so cancelling there
/// covers all of them instead of one button at a time. Safe to call when nothing is running.
#[tauri::command]
pub fn coaching_cancel() {
    CANCEL.notify_waiters();
}

/// Shared headless `claude --print` spawn: JSON envelope in/out, user prompt via stdin,
/// optional cwd + read-only tool allowance, hard timeout (kill_on_drop reaps the child when
/// the timed-out future is dropped), and no console flash on Windows (CREATE_NO_WINDOW).
async fn run_claude_cli(
    system: &str,
    user: &str,
    model: &str,
    cli_path: &str,
    cwd: Option<std::path::PathBuf>,
    allowed_tools: Option<&str>,
    timeout_secs: u64,
    app: &tauri::AppHandle,
) -> Result<String, DeadlockError> {
    use tokio::io::AsyncWriteExt;
    // Reuse design.rs's resolver: configured path → PATH lookup → platform
    // fallback dirs (covers launchers whose PATH omits where `claude` is installed).
    let resolved = crate::commands::design::resolve_cli_path(cli_path);
    // The CLI's own short aliases pass straight through; anything else resolves to a full model id
    // so a code-pinned model (the player brief's `opus-5`) reaches the CLI backend too instead of
    // being silently downgraded to the default Opus.
    let alias = if matches!(model, "opus" | "sonnet" | "haiku") { model } else { classify_model_id(model) };

    // Stage the system prompt in a temp file (see design::SystemPromptFile) and
    // pass --system-prompt-file so it never touches the command line — a large
    // --system-prompt arg overflows cmd.exe's 8191-char limit (os error 206).
    let sp_file = crate::commands::design::SystemPromptFile::new(system)
        .map_err(|e| DeadlockError::Network(format!("stage system prompt: {e}")))?;

    // --output-format stream-json (mirrors design.rs's agent_chat): the answer arrives as
    // text_delta events instead of one lump at the end, so a kill at the wall keeps whatever
    // streamed in — the old `json` mode discarded a fully-billed 20-minute generation.
    let mut cmd = crate::commands::proc_util::tokio_cmd(&resolved);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--no-session-persistence")
        .arg("--setting-sources")
        .arg("")
        .arg("--system-prompt-file")
        .arg(sp_file.path())
        .arg("--model")
        .arg(alias);
    if let Some(tools) = allowed_tools {
        cmd.arg("--allowed-tools").arg(tools);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
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

    // Accumulate text_delta chunks as they land. `text` is the answer-so-far at every instant, so
    // the timeout arm below can hand it back instead of throwing the run away. `emit` (when the
    // caller supplied a channel) reports bytes-so-far to the UI, which otherwise shows one frozen
    // phase word for the whole run with no way to tell working from hung.
    let mut text = String::new();
    let mut result_err: Option<DeadlockError> = None;
    let read = async {
        let Some(stdout) = child.stdout.take() else { return };
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut last_emit = 0usize;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "stream_event" => {
                    let Some(ev) = v.get("event") else { continue };
                    if ev.get("type").and_then(|t| t.as_str()) != Some("content_block_delta") { continue }
                    let Some(d) = ev.get("delta") else { continue };
                    if d.get("type").and_then(|t| t.as_str()) != Some("text_delta") { continue }
                    if let Some(s) = d.get("text").and_then(|t| t.as_str()) {
                        text.push_str(s);
                        // throttled to ~1 event per 2 KB — a per-delta emit floods the IPC bridge
                        if text.len() - last_emit >= 2048 {
                            last_emit = text.len();
                            let _ = app.emit("coaching-progress", serde_json::json!({ "chars": text.len() }));
                        }
                    }
                }
                "result" => {
                    if v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) {
                        let msg = v.get("result").and_then(|s| s.as_str()).unwrap_or("claude error");
                        result_err = Some(DeadlockError::Upstream(format!("claude: {msg}")));
                    } else if text.trim().is_empty() {
                        // non-streaming fallback: some CLI versions only fill the final result
                        if let Some(s) = v.get("result").and_then(|s| s.as_str()) { text.push_str(s); }
                    }
                }
                _ => {}
            }
        }
    };

    // A cancel races the read. Whichever lands first ends the run; returning drops `child`, and
    // kill_on_drop reaps the CLI process — the same reaping the timeout arm has always relied on.
    // The race has to yield a plain bool rather than returning from inside the select, because the
    // `read` future holds `&mut text` until the whole timeout expression is dropped.
    let raced = async {
        tokio::select! {
            () = read => false,
            () = CANCEL.notified() => true,
        }
    };
    let canceled =
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), raced).await {
            Ok(c) => c,
            Err(_) => {
                return Err(DeadlockError::Timeout {
                    message: format!(
                        "claude timed out after {timeout_secs}s (killed) — {} characters had been written",
                        text.len()
                    ),
                    partial: text,
                })
            }
        };
    if canceled {
        return Err(DeadlockError::Canceled { partial: text });
    }
    if let Some(e) = result_err {
        return Err(e);
    }
    if text.trim().is_empty() {
        return Err(DeadlockError::Upstream("claude returned empty result".into()));
    }
    Ok(text)
}
