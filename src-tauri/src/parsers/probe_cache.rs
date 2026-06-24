//! ffprobe wrapper with a 30 s in-memory mtime-keyed cache.
//!
//! Ported from the now-removed Node sidecar (`server/src/video/probe.js`). Sub-feature 7 of the Desktop-Only
//! Migration. Used by `video_probe` to discover audio + subtitle tracks +
//! chapters before remuxing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::commands::vault::VaultError;

const TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
pub struct VideoStream {
    pub codec: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// avg_frame_rate (num/den), falling back to r_frame_rate when avg is
    /// 0/0 (some containers). Editor frame-stepping needs this — browsers
    /// don't expose framerate.
    pub fps: Option<f64>,
    /// Colorimetry tags (absent on untagged sources). The Color Grading
    /// phase pins the export graph's YUV↔RGB conversions to these so ffmpeg
    /// uses the same matrix WebKit picked for the preview upload; untagged
    /// sources fall back to the browser heuristic (HD→bt709, SD→bt601)
    /// JS-side. The 1080p proxy lane re-attaches them across its re-encode.
    pub color_space: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub color_range: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioStream {
    pub index: usize,
    pub language: String,
    pub title: Option<String>,
    pub codec: Option<String>,
    pub profile: Option<String>,
    pub channels: Option<i64>,
    pub default: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubtitleStream {
    pub index: usize,
    pub language: String,
    pub title: Option<String>,
    pub codec: Option<String>,
    pub default: bool,
    pub forced: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Chapter {
    pub id: Option<i64>,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub duration: Option<f64>,
    /// Container start_time (format.start_time). The editor's import-time
    /// proxy-parity check stores src−proxy as `startTimeOffset`.
    pub start_time: Option<f64>,
    pub video: Vec<VideoStream>,
    pub audio: Vec<AudioStream>,
    pub subtitles: Vec<SubtitleStream>,
    pub chapters: Vec<Chapter>,
}

struct CacheEntry {
    fetched_at: Instant,
    mtime_ms: u128,
    data: ProbeResult,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CacheEntry>> {
    static CELL: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mtime_ms_for(p: &Path) -> u128 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn tag_of<'a>(s: &'a Value, key: &str) -> Option<&'a str> {
    let tags = s.get("tags")?;
    if let Some(v) = tags.get(key).and_then(|x| x.as_str()) {
        return Some(v);
    }
    let upper = key.to_uppercase();
    tags.get(upper).and_then(|x| x.as_str())
}

fn disposition_flag(s: &Value, key: &str) -> bool {
    s.get("disposition")
        .and_then(|d| d.get(key))
        .and_then(|v| v.as_i64())
        .map(|n| n != 0)
        .unwrap_or(false)
}

/// "num/den" → f64 fps; rejects 0/0 and other degenerate values.
fn rational_fps(raw: Option<&str>) -> Option<f64> {
    let (num, den) = raw?.split_once('/')?;
    let n: f64 = num.parse().ok()?;
    let d: f64 = den.parse().ok()?;
    if n > 0.0 && d > 0.0 {
        Some(n / d)
    } else {
        None
    }
}

fn parse_fps(s: &Value) -> Option<f64> {
    rational_fps(s.get("avg_frame_rate").and_then(|v| v.as_str()))
        .or_else(|| rational_fps(s.get("r_frame_rate").and_then(|v| v.as_str())))
}

pub fn summarize(data: &Value) -> ProbeResult {
    let streams: Vec<&Value> = data
        .get("streams")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();

    let mut video = Vec::new();
    let mut audio_in = Vec::new();
    let mut subs_in = Vec::new();
    for s in streams {
        match s.get("codec_type").and_then(|v| v.as_str()) {
            Some("video") => video.push(s),
            Some("audio") => audio_in.push(s),
            Some("subtitle") => subs_in.push(s),
            _ => {}
        }
    }

    let color_str = |s: &Value, key: &str| {
        s.get(key)
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty() && *v != "unknown")
            .map(String::from)
    };
    let video_out = video
        .iter()
        .map(|s| VideoStream {
            codec: s.get("codec_name").and_then(|v| v.as_str()).map(String::from),
            width: s.get("width").and_then(|v| v.as_i64()),
            height: s.get("height").and_then(|v| v.as_i64()),
            fps: parse_fps(s),
            color_space: color_str(s, "color_space"),
            color_primaries: color_str(s, "color_primaries"),
            color_transfer: color_str(s, "color_transfer"),
            color_range: color_str(s, "color_range"),
        })
        .collect();

    let audio_out = audio_in
        .iter()
        .enumerate()
        .map(|(i, s)| AudioStream {
            index: i,
            language: tag_of(s, "language").unwrap_or("und").to_string(),
            title: tag_of(s, "title").map(String::from),
            codec: s.get("codec_name").and_then(|v| v.as_str()).map(String::from),
            profile: s.get("profile").and_then(|v| v.as_str()).map(String::from),
            channels: s.get("channels").and_then(|v| v.as_i64()),
            default: disposition_flag(s, "default"),
        })
        .collect();

    let subs_out = subs_in
        .iter()
        .enumerate()
        .map(|(i, s)| SubtitleStream {
            index: i,
            language: tag_of(s, "language").unwrap_or("und").to_string(),
            title: tag_of(s, "title").map(String::from),
            codec: s.get("codec_name").and_then(|v| v.as_str()).map(String::from),
            default: disposition_flag(s, "default"),
            forced: disposition_flag(s, "forced"),
        })
        .collect();

    let chapters = data
        .get("chapters")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|c| {
                    let id = c.get("id").and_then(|v| v.as_i64());
                    let title = c
                        .get("tags")
                        .and_then(|t| t.get("title").or_else(|| t.get("TITLE")))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .unwrap_or_else(|| match id {
                            Some(n) => format!("Chapter {n}"),
                            None => "Chapter".to_string(),
                        });
                    Chapter {
                        id,
                        start: c
                            .get("start_time")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<f64>().ok())
                            .or_else(|| c.get("start_time").and_then(|v| v.as_f64())),
                        end: c
                            .get("end_time")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<f64>().ok())
                            .or_else(|| c.get("end_time").and_then(|v| v.as_f64())),
                        title,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let duration = data
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| d.is_finite());

    let start_time = data
        .get("format")
        .and_then(|f| f.get("start_time"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| d.is_finite());

    ProbeResult {
        duration,
        start_time,
        video: video_out,
        audio: audio_out,
        subtitles: subs_out,
        chapters,
    }
}

fn run_ffprobe(abs: &Path) -> Result<Value, VaultError> {
    let output = Command::new(crate::tool_path::resolve("ffprobe"))
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_chapters",
            "-show_format",
        ])
        // Strip `\\?\` — ffprobe rejects the verbatim path canonicalize() returns
        // on Windows (the source probe AND the editor proxy re-probe both hit this).
        .arg(crate::tool_path::native_path(abs))
        .output()
        .map_err(|e| VaultError::Io(format!("ffprobe spawn: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(VaultError::Io(format!(
            "ffprobe exit {}: {}",
            output.status,
            &stderr.chars().take(300).collect::<String>()
        )));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| VaultError::Io(format!("ffprobe json parse: {e}")))
}

pub fn probe(abs: &Path) -> Result<ProbeResult, VaultError> {
    let canonical = std::fs::canonicalize(abs)
        .map_err(|_| VaultError::NotFound(abs.display().to_string()))?;
    let mtime = mtime_ms_for(&canonical);
    let now = Instant::now();

    if let Ok(mut map) = cache().lock() {
        if let Some(hit) = map.get(&canonical) {
            if hit.mtime_ms == mtime && now.duration_since(hit.fetched_at) < TTL {
                return Ok(hit.data.clone());
            }
        }
        // Drop the stale entry while we hold the lock — fresh fetch below.
        map.remove(&canonical);
    }

    let raw = run_ffprobe(&canonical)?;
    let data = summarize(&raw);
    if let Ok(mut map) = cache().lock() {
        map.insert(
            canonical.clone(),
            CacheEntry {
                fetched_at: now,
                mtime_ms: mtime,
                data: data.clone(),
            },
        );
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summarize_audio_subtitle_chapters() {
        let raw = json!({
            "format": { "duration": "120.5" },
            "streams": [
                { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080 },
                { "codec_type": "audio", "codec_name": "aac", "channels": 2,
                  "tags": { "language": "eng", "title": "Stereo" },
                  "disposition": { "default": 1 } },
                { "codec_type": "subtitle", "codec_name": "subrip",
                  "tags": { "language": "eng" },
                  "disposition": { "default": 0, "forced": 0 } },
            ],
            "chapters": [
                { "id": 0, "start_time": "0.0", "end_time": "60.0",
                  "tags": { "title": "Opening" } }
            ]
        });
        let out = summarize(&raw);
        assert_eq!(out.duration, Some(120.5));
        assert_eq!(out.video.len(), 1);
        assert_eq!(out.video[0].codec.as_deref(), Some("h264"));
        assert_eq!(out.video[0].color_space, None); // untagged source
        assert_eq!(out.audio.len(), 1);
        assert_eq!(out.audio[0].language, "eng");
        assert!(out.audio[0].default);
        assert_eq!(out.subtitles.len(), 1);
        assert_eq!(out.chapters.len(), 1);
        assert_eq!(out.chapters[0].title, "Opening");
    }

    #[test]
    fn summarize_handles_missing_tags() {
        let raw = json!({
            "format": {},
            "streams": [
                { "codec_type": "audio", "codec_name": "opus" }
            ]
        });
        let out = summarize(&raw);
        assert_eq!(out.audio[0].language, "und");
        assert_eq!(out.audio[0].title, None);
    }

    #[test]
    fn summarize_captures_colorimetry_tags() {
        let raw = json!({
            "format": {},
            "streams": [
                { "codec_type": "video", "codec_name": "h264", "width": 720, "height": 480,
                  "color_space": "smpte170m", "color_primaries": "smpte170m",
                  "color_transfer": "bt709", "color_range": "tv" },
                { "codec_type": "video", "codec_name": "h264",
                  "color_space": "unknown", "color_range": "" },
            ]
        });
        let out = summarize(&raw);
        assert_eq!(out.video[0].color_space.as_deref(), Some("smpte170m"));
        assert_eq!(out.video[0].color_primaries.as_deref(), Some("smpte170m"));
        assert_eq!(out.video[0].color_transfer.as_deref(), Some("bt709"));
        assert_eq!(out.video[0].color_range.as_deref(), Some("tv"));
        // "unknown" / empty strings normalize to None, same as absent.
        assert_eq!(out.video[1].color_space, None);
        assert_eq!(out.video[1].color_range, None);
    }
}
