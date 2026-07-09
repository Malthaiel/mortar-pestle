// ── Media probe + encoder capability detection — split from mod.rs, plan 026 B4.
// canonical_file + vedit_probe (ffprobe metadata) and the encoder-caps probe
// (1-frame test-encode per encoder, cached under app_config_root). Shim
// `pub use probe::*;` keeps vedit_probe/vedit_encoder_probe paths + ACL resolving;
// PROBE_*_ENCODERS stay in mod.rs (shared with export encode_args).

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::commands::vault::VaultError;
use crate::parsers::probe_cache;
use super::{PROBE_AUDIO_ENCODERS, PROBE_VIDEO_ENCODERS};

pub fn canonical_file(path: &str) -> Result<PathBuf, VaultError> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(VaultError::Invalid("expected an absolute path".into()));
    }
    let canonical =
        fs::canonicalize(&p).map_err(|_| VaultError::NotFound(path.to_string()))?;
    if !canonical.is_file() {
        return Err(VaultError::NotFile);
    }
    Ok(canonical)
}

#[tauri::command]
pub fn vedit_probe(path: String) -> Result<probe_cache::ProbeResult, VaultError> {
    let canonical = canonical_file(&path)?;
    probe_cache::probe(&canonical)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncoderCaps {
    /// encoder name → did a 1-frame test-encode succeed.
    pub encoders: std::collections::BTreeMap<String, bool>,
    pub ffmpeg_path: String,
    pub ffmpeg_version: String,
}

/// First line of `ffmpeg -version` (an SF2 cache-key component); "" on failure.
async fn ffmpeg_version_line(ffmpeg: &str) -> String {
    match tokio::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-version"])
        .output()
        .await
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string(),
        Err(_) => String::new(),
    }
}

/// Run one ffmpeg invocation to a null muxer, time-boxed. true = clean exit 0.
async fn probe_test_encode(ffmpeg: &str, args: &[&str]) -> bool {
    let child = tokio::process::Command::new(ffmpeg)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => return false,
    };
    match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => status.success(),
        Ok(Err(_)) => false,
        Err(_) => {
            // Timed out — a wedged encoder. Kill it and report unavailable.
            let _ = child.start_kill();
            false
        }
    }
}

/// Test-encode every matrix encoder against a 1-frame (video) / 0.1 s (audio)
/// synthetic source. The truthful capability map behind the preset system.
async fn run_encoder_probe() -> EncoderCaps {
    let ffmpeg = crate::tool_path::resolve("ffmpeg");
    let ffmpeg_version = ffmpeg_version_line(&ffmpeg).await;
    let mut encoders = std::collections::BTreeMap::new();
    for enc in PROBE_VIDEO_ENCODERS {
        let ok = probe_test_encode(
            &ffmpeg,
            &[
                "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
                "-frames:v", "1", "-c:v", enc, "-f", "null", "-",
            ],
        )
        .await;
        encoders.insert((*enc).to_string(), ok);
    }
    for enc in PROBE_AUDIO_ENCODERS {
        let ok = probe_test_encode(
            &ffmpeg,
            &[
                "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-t", "0.1", "-c:a", enc, "-f", "null", "-",
            ],
        )
        .await;
        encoders.insert((*enc).to_string(), ok);
    }
    EncoderCaps { encoders, ffmpeg_path: ffmpeg, ffmpeg_version }
}

/// Path of the probe cache: a serialized `EncoderCaps` keyed (by its own
/// `ffmpeg_path` + `ffmpeg_version` fields) to the ffmpeg it was measured
/// against. Lives beside the other app-config stores (sidebar.json, etc.).
fn caps_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, VaultError> {
    Ok(crate::commands::sidebar::app_config_root(app)?.join("video-export-caps.json"))
}

/// Encoder caps with the SF2 disk cache: returns the cached verdict when the
/// resolved ffmpeg path + version still match; otherwise (or when `force`)
/// re-runs the full test-encode probe and rewrites the cache. The cheap `ffmpeg
/// -version` call is the invalidation key — an upgraded or relocated ffmpeg
/// re-probes automatically; a GPU/driver swap needs `force`. Shared by the probe
/// command (SF1–SF2) and the export path (SF3).
pub async fn caps_cached(app: &tauri::AppHandle, force: bool) -> EncoderCaps {
    let ffmpeg = crate::tool_path::resolve("ffmpeg");
    let cache_path = caps_cache_path(app).ok();
    if !force {
        if let Some(cp) = &cache_path {
            if let Ok(txt) = fs::read_to_string(cp) {
                if let Ok(cached) = serde_json::from_str::<EncoderCaps>(&txt) {
                    let version = ffmpeg_version_line(&ffmpeg).await;
                    if cached.ffmpeg_path == ffmpeg && cached.ffmpeg_version == version {
                        return cached;
                    }
                }
            }
        }
    }
    let caps = run_encoder_probe().await;
    // Best-effort cache write — the probe result still returns if the write fails.
    if let Some(cp) = &cache_path {
        if let Ok(txt) = serde_json::to_string_pretty(&caps) {
            let _ = fs::write(cp, txt);
        }
    }
    caps
}

/// Runtime encoder capability probe (Delivery & Presets SF1–SF2).
#[tauri::command]
pub async fn vedit_encoder_probe(
    app: tauri::AppHandle,
    force: bool,
) -> Result<EncoderCaps, VaultError> {
    Ok(caps_cached(&app, force).await)
}
