//! Sub-feature 7.5 — ffmpeg transcode + subtitle extraction with hash-keyed
//! cache files under `~/.cache/mortar-pestle/transcodes/`. The `mortar-pestle-asset://`
//! scheme is extended (in `asset_protocol.rs`) with `/transcode/<hash>.mp4`
//! and `/subs/<hash>.vtt` virtual paths that Range-serve the completed files.
//!
//! Design notes:
//! - **Bounded concurrent ffmpeg** — up to `MAX_ACTIVE_TRANSCODES` remuxes run
//!   at once, so two player windows (main + popped-out) can prepare different
//!   episodes simultaneously without one start SIGTERMing the other's in-flight
//!   child. Only the *excess* over the cap is trimmed (oldest-started first).
//!   One complete transcode per (file, audio); playback seeks are native.
//! - **ffmpeg writes direct to file** (`-f mp4 <out>`) — no pipe-then-tee.
//! - **Same-hash fast-path** reuses a finished entry; a same-hash re-spawn is
//!   guarded by `started_at` so the older supervisor won't clobber the newer.
//! - **Lock-discipline** — ffmpeg spawn happens *outside* the registry lock.
//! - **Stale-write guard** — supervisor compares captured `started_at` with
//!   the current entry's `started_at` before flipping status.
//! - **LRU eviction** (3 files OR 5 GB) excludes every active hash and runs
//!   on every insert; Linux unlink-while-open is safe for in-flight reads.
//! - **Cleanup** SIGTERMs all active children on `RunEvent::Exit`. The cache
//!   itself persists: the next launch calls [`adopt_cache_from_disk`], which
//!   re-registers the complete files (handing them back to the LRU) and removes
//!   a killed run's `.partial` staging files. Subs persist the same way.

use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};
use tokio::process::Child as TokioChild;

use crate::commands::vault::VaultError;


#[derive(Debug, Clone)]
pub enum EntryStatus {
    Running,
    Done,
    Failed {
        exit_code: Option<i32>,
        stderr_tail: String,
    },
}

pub fn cache_root() -> Result<PathBuf, VaultError> {
    let base = dirs::cache_dir()
        .ok_or_else(|| VaultError::Io("cache_dir() unavailable".into()))?;
    Ok(base.join("mortar-pestle/transcodes"))
}

pub fn transcode_path(hash: &str) -> Result<PathBuf, VaultError> {
    let dir = cache_root()?;
    std::fs::create_dir_all(&dir).map_err(|e| VaultError::Io(format!("mkdir transcodes: {e}")))?;
    Ok(dir.join(format!("{hash}.mp4")))
}

pub fn mtime_ms_for(canonical: &Path) -> i64 {
    std::fs::metadata(canonical)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash16(input: &str) -> String {
    let mut h = Sha1::new();
    h.update(input.as_bytes());
    let digest = h.finalize();
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    hex
}

pub fn compute_hash(abs: &str, audio: Option<i64>, mtime_ms: i64) -> String {
    compute_hash_with_recipe(abs, audio, mtime_ms, "")
}

/// Recipe-suffixed cache key (Color Grading SF2). An empty recipe produces the
/// EXACT legacy `abs|audio|mtime` key — every existing ≤1080p proxy stays
/// addressable byte-for-byte. A non-empty recipe (e.g. "p1080" for the 1080p
/// preview re-encode) appends `|recipe`, so a >1080p source imported before
/// the proxy lane simply orphans its old copy-remux cache file (accounted in
/// the 20 GB budget, never wrongly served).
pub fn compute_hash_with_recipe(abs: &str, audio: Option<i64>, mtime_ms: i64, recipe: &str) -> String {
    let mut key = format!("{abs}|{audio}|{mtime_ms}", audio = audio.unwrap_or(0));
    if !recipe.is_empty() {
        key.push('|');
        key.push_str(recipe);
    }
    hash16(&key)
}

/// 1080p preview-proxy re-encode recipe (Color Grading SF2). `None` keeps the
/// `-c:v copy` remux. The GPU Display Path decision clamps preview ≤1080p —
/// frames above that never enter the WebGL upload path — so >1080p imports
/// re-encode: scaled into 1920×1080, libx264 veryfast crf 18, and a ~1 s GOP
/// (`-g ≈ fps`) that also bounds accurate-seek scrub latency. Source
/// colorimetry tags re-attach across the re-encode (the YUV-domain scale
/// never converts matrices, but container tags must survive for the color
/// phase's matrix pinning).
pub struct ProxyScale {
    pub fps: f64,
    pub color_space: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub color_range: Option<String>,
    /// Video encoder to use. `None` = libx264 (the editor lane's default).
    /// The player lane passes a hardware encoder when the caps probe proved
    /// one works, since it re-encodes whole 24-minute episodes.
    pub encoder: Option<String>,
    /// Playback tuning instead of editor tuning: no 1-second GOP (that exists
    /// only to bound editor scrub latency, and inflates a whole-episode encode
    /// several-fold) and a slightly looser CRF. The editor lane passes false.
    pub playback: bool,
}

/// Build the ffmpeg argv (exposed for testing argv assembly). `proxy: None`
/// is the original `-c:v copy` remux (player lane always; editor lane for
/// ≤1080p sources); `Some` is the 1080p preview re-encode.
fn build_transcode_argv(
    abs: &str,
    audio: Option<i64>,
    out_path: &Path,
    copy_audio: bool,
    proxy: Option<&ProxyScale>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        // Overwrite without asking: the lane stages to `<hash>.mp4.partial`, and a
        // leftover partial from a SIGTERMed run would otherwise make ffmpeg block on
        // an interactive "overwrite?" prompt with nothing attached to answer it.
        "-y".into(),
    ];
    args.push("-i".into());
    // `\\?\`-strip: canonicalize() hands the editor remux (and player transcode)
    // a verbatim path that ffmpeg rejects as "Invalid argument" on Windows.
    args.push(crate::tool_path::native_str(abs));
    args.push("-map".into());
    args.push("0:v:0".into());
    args.push("-map".into());
    let a = audio.unwrap_or(0).max(0);
    args.push(format!("0:a:{a}?"));
    if let Some(p) = proxy {
        let enc = p.encoder.as_deref().unwrap_or("libx264");
        args.extend([
            "-vf".into(),
            "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2".into(),
            "-c:v".into(),
            enc.into(),
        ]);
        // Rate control is encoder-specific: NVENC rejects -crf/-preset veryfast
        // outright, and x264 has no -cq. Matches the export lane's convention
        // in commands/video_editor/mod.rs.
        if enc.ends_with("_nvenc") {
            args.extend([
                "-preset".into(),
                "p4".into(),
                "-rc".into(),
                "vbr".into(),
                "-cq".into(),
                if p.playback { "24".into() } else { "20".into() },
                "-b:v".into(),
                "0".into(),
            ]);
        } else {
            args.extend([
                "-preset".into(),
                "veryfast".into(),
                "-crf".into(),
                if p.playback { "20".into() } else { "18".into() },
            ]);
        }
        // 1 s GOP bounds the editor's accurate-seek scrub latency. The player
        // seeks natively in a finished file, so it keeps the encoder default —
        // a 1 s GOP over a whole episode multiplies the output size for no gain.
        if !p.playback {
            args.extend(["-g".into(), format!("{}", (p.fps.round() as i64).max(1))]);
        }
        args.extend(["-pix_fmt".into(), "yuv420p".into()]);
        // Machine-readable progress on stdout. Only the re-encode lane asks for
        // it: a copy remux finishes before a spinner would even render, and
        // stdout stays null there so nothing has to drain it.
        args.extend(["-progress".into(), "pipe:1".into(), "-nostats".into()]);
        for (flag, val) in [
            ("-colorspace", &p.color_space),
            ("-color_primaries", &p.color_primaries),
            ("-color_trc", &p.color_transfer),
            ("-color_range", &p.color_range),
        ] {
            if let Some(v) = val {
                args.extend([flag.to_string(), v.clone()]);
            }
        }
    } else {
        args.extend(["-c:v".into(), "copy".into()]);
    }
    // Source audio that's already AAC-LC is remuxed as-is (no generational
    // re-encode / CPU cost); anything else is normalized to AAC-LC for WebKit.
    if copy_audio {
        args.extend(["-c:a".into(), "copy".into()]);
    } else {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    // Whole-file remux to a complete, seekable MP4 with `moov` moved to the
    // front (+faststart). A real container duration is what lets WebKitGTK seek
    // natively and avoids the premature-EOF 'ended' that the old
    // fragmented/empty_moov streaming output triggered ~every 8s. The command
    // waits for completion before the URL is served.
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
    ]);
    args.push(out_path.display().to_string());
    args
}

/// Build the ffmpeg argv for a container remux that KEEPS EVERY TRACK
/// (`-map 0 -c copy`). Distinct from [`build_transcode_argv`], which single-maps
/// `0:a:{n}` and would silently DROP a Broadcast recording's 2nd audio track
/// (desktop → track 1, mic → track 2). Used by the auto-remux runner (mkv → mp4,
/// SP4 S4) and the SP4 S6 remux utility. Stream-copy only — no re-encode.
pub(crate) fn build_remux_argv(abs: &str, out_path: &Path) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        // `\\?\`-strip: ffmpeg rejects the Windows verbatim path form.
        crate::tool_path::native_str(abs),
        "-map".into(),
        "0".into(),
        "-c".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        // Explicit muxer: the .partial staging name hides the extension, so
        // ffmpeg can't infer the format and dies with "Invalid argument".
        "-f".into(),
        "mp4".into(),
        out_path.display().to_string(),
    ]
}

#[cfg(test)]
mod remux_argv_tests {
    use super::*;
    use std::path::Path;

    fn playback_proxy(encoder: Option<&str>) -> ProxyScale {
        ProxyScale {
            fps: 23.976,
            color_space: None,
            color_primaries: None,
            color_transfer: None,
            color_range: None,
            encoder: encoder.map(String::from),
            playback: true,
        }
    }

    /// The Frieren S2 bug: HEVC Main 10 was stream-copied into MP4, so WebView2
    /// showed a black picture while AAC audio and VTT subs played fine.
    #[test]
    fn reencode_argv_is_encoder_appropriate() {
        let x264 = playback_proxy(None);
        let a = build_transcode_argv("in.mkv", None, Path::new("out.mp4"), true, Some(&x264));
        let j = a.join(" ");
        // Never stream-copy a source that reached the re-encode lane.
        assert!(!j.contains("-c:v copy"));
        assert!(j.contains("-c:v libx264"));
        assert!(j.contains("-crf 20")); // playback CRF, not the editor's 18
        assert!(j.contains("-pix_fmt yuv420p")); // 10-bit in must be 8-bit out
        assert!(!j.contains("-g ")); // no 1 s GOP on a whole-episode encode

        let nv = playback_proxy(Some("h264_nvenc"));
        let b = build_transcode_argv("in.mkv", None, Path::new("out.mp4"), true, Some(&nv));
        let j = b.join(" ");
        assert!(j.contains("-c:v h264_nvenc"));
        // NVENC rejects both of these outright — the bug this branch prevents.
        assert!(!j.contains("-crf"));
        assert!(!j.contains("veryfast"));
        assert!(j.contains("-rc vbr -cq 24"));

        // Editor lane must be byte-identical to before: crf 18 + 1 s GOP.
        let ed = ProxyScale { playback: false, ..playback_proxy(None) };
        let c = build_transcode_argv("in.mkv", None, Path::new("out.mp4"), true, Some(&ed));
        let j = c.join(" ");
        assert!(j.contains("-crf 18"));
        assert!(j.contains("-g 24"));
    }

    #[test]
    fn remux_keeps_all_tracks() {
        let args = build_remux_argv("in.mkv", Path::new("out.mp4"));
        // -map 0 selects ALL streams — the reason this exists vs build_transcode_argv.
        assert!(args.windows(2).any(|w| w[0] == "-map" && w[1] == "0"));
        // must NOT single-map one audio stream (the track-2-dropping trap).
        assert!(!args.iter().any(|a| a.starts_with("0:a:")));
        assert!(args.windows(2).any(|w| w[0] == "-c" && w[1] == "copy"));
        assert!(args.iter().any(|a| a == "+faststart"));
        // .partial staging output → format must be explicit, not extension-guessed.
        assert!(args.windows(2).any(|w| w[0] == "-f" && w[1] == "mp4"));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn transcode_argv_overwrites_a_stale_partial() {
        // No -y => ffmpeg blocks on an interactive overwrite prompt when a partial
        // from a SIGTERMed run is still on disk, and the job hangs forever.
        let args = build_transcode_argv("in.mkv", None, Path::new("out.mp4.partial"), true, None);
        assert!(args.iter().any(|a| a == "-y"));
        assert!(build_remux_argv("in.mkv", Path::new("out.mp4.partial")).iter().any(|a| a == "-y"));
    }
}

/// pub(crate): the editor remux lane (parsers/editor_proxy.rs) reuses this
/// spawn (same argv builder) without the player lane's kill-prior semantics.
/// `proxy` is the editor lane's 1080p re-encode recipe; the player lane
/// always passes None.
pub(crate) fn spawn_ffmpeg_to_file(
    abs: &str,
    audio: Option<i64>,
    out_path: &Path,
    copy_audio: bool,
    proxy: Option<&ProxyScale>,
) -> Result<TokioChild, VaultError> {
    let args = build_transcode_argv(abs, audio, out_path, copy_audio, proxy);
    let child = crate::commands::proc_util::tokio_cmd(crate::tool_path::resolve("ffmpeg"))
        .args(&args)
        .stdin(std::process::Stdio::null())
        // Piped only for the re-encode lane, which emits `-progress` lines there.
        .stdout(if proxy.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| VaultError::Io(format!("ffmpeg spawn: {e}")))?;
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_stable_across_calls() {
        let a = compute_hash("/x/y.mkv", Some(0), 123);
        let b = compute_hash("/x/y.mkv", Some(0), 123);
        assert_eq!(a, b);
    }

    #[test]
    fn hash_differs_on_audio_change() {
        let a = compute_hash("/x/y.mkv", Some(0), 123);
        let b = compute_hash("/x/y.mkv", Some(1), 123);
        assert_ne!(a, b);
    }

    #[test]
    fn hash_differs_on_mtime() {
        let a = compute_hash("/x/y.mkv", Some(0), 123);
        let b = compute_hash("/x/y.mkv", Some(0), 124);
        assert_ne!(a, b);
    }

    #[test]
    fn hash_is_16_lowercase_hex() {
        let h = compute_hash("/x/y.mkv", Some(0), 123);
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn empty_recipe_hash_is_legacy_key() {
        // Every existing ≤1080p proxy must stay addressable byte-for-byte.
        let legacy = compute_hash("/x/y.mkv", Some(0), 123);
        let recipe = compute_hash_with_recipe("/x/y.mkv", Some(0), 123, "");
        assert_eq!(legacy, recipe);
    }

    #[test]
    fn p1080_recipe_hash_differs() {
        let copy = compute_hash_with_recipe("/x/y.mkv", Some(0), 123, "");
        let p1080 = compute_hash_with_recipe("/x/y.mkv", Some(0), 123, "p1080");
        assert_ne!(copy, p1080);
    }

    #[test]
    fn build_transcode_argv_proxy_scale_reencodes() {
        let proxy = ProxyScale {
            fps: 23.976,
            color_space: Some("bt709".into()),
            color_primaries: Some("bt709".into()),
            color_transfer: None,
            color_range: Some("tv".into()),
            encoder: None,
            playback: false,
        };
        let argv = build_transcode_argv("/v.mkv", Some(0), Path::new("/tmp/o.mp4"), false, Some(&proxy));
        let cv = argv.iter().position(|s| s == "-c:v").expect("has -c:v");
        assert_eq!(argv[cv + 1], "libx264");
        let vf = argv.iter().position(|s| s == "-vf").expect("has -vf");
        assert!(argv[vf + 1].contains("scale=1920:1080"));
        assert!(argv[vf + 1].contains("force_divisible_by=2"));
        let g = argv.iter().position(|s| s == "-g").expect("has -g");
        assert_eq!(argv[g + 1], "24", "GOP ≈ 1 s of rounded fps");
        let cs = argv.iter().position(|s| s == "-colorspace").expect("re-tags colorspace");
        assert_eq!(argv[cs + 1], "bt709");
        assert!(argv.iter().all(|s| s != "-color_trc"), "absent tags are not fabricated");
        let cr = argv.iter().position(|s| s == "-color_range").expect("re-tags range");
        assert_eq!(argv[cr + 1], "tv");
    }

    #[test]
    fn build_transcode_argv_none_proxy_is_copy() {
        let argv = build_transcode_argv("/v.mkv", Some(0), Path::new("/tmp/o.mp4"), true, None);
        let cv = argv.iter().position(|s| s == "-c:v").expect("has -c:v");
        assert_eq!(argv[cv + 1], "copy");
        assert!(argv.iter().all(|s| s != "-vf"), "no scale filter on the copy path");
        assert!(argv.iter().all(|s| s != "-g"), "no GOP flag on the copy path");
    }

    #[test]
    fn build_transcode_argv_has_faststart_no_fragment() {
        let argv = build_transcode_argv("/v.mkv", Some(0), Path::new("/tmp/o.mp4"), false, None);
        let mv = argv.iter().position(|s| s == "-movflags").expect("has -movflags");
        assert_eq!(argv[mv + 1], "+faststart");
        assert!(argv.iter().all(|s| s != "-ss"), "no pre-input seek");
        assert!(
            argv.iter().all(|s| !s.contains("frag_keyframe")),
            "not a fragmented MP4"
        );
    }

    #[test]
    fn build_transcode_argv_maps_audio_index() {
        let argv = build_transcode_argv("/v.mkv", Some(2), Path::new("/tmp/o.mp4"), false, None);
        let mappings: Vec<&String> = argv.iter().filter(|s| s.starts_with("0:a:")).collect();
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0], "0:a:2?");
    }

    #[test]
    fn build_transcode_argv_copies_audio_when_aac_lc() {
        let argv = build_transcode_argv("/v.mkv", Some(0), Path::new("/tmp/o.mp4"), true, None);
        let ca = argv.iter().position(|s| s == "-c:a").expect("has -c:a");
        assert_eq!(argv[ca + 1], "copy");
        assert!(argv.iter().all(|s| s != "-b:a"), "no audio bitrate flag when copying");
    }

    #[test]
    fn build_transcode_argv_reencodes_audio_when_not_aac_lc() {
        let argv = build_transcode_argv("/v.mkv", Some(0), Path::new("/tmp/o.mp4"), false, None);
        let ca = argv.iter().position(|s| s == "-c:a").expect("has -c:a");
        assert_eq!(argv[ca + 1], "aac");
        assert!(argv.iter().any(|s| s == "-b:a"), "bitrate set when re-encoding");
    }

}
