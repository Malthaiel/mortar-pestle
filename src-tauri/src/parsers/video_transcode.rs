//! Sub-feature 7.5 — ffmpeg transcode + subtitle extraction with hash-keyed
//! cache files under `~/.cache/iskariel/transcodes/`. The `iskariel-asset://`
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
//! - **Cleanup** wipes the transcodes dir on `RunEvent::Exit` and SIGTERMs
//!   all active children. Subs persist by design (tiny, repeat-watch-friendly).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use sha1::{Digest, Sha1};
use tokio::process::{Child as TokioChild, Command as TokioCommand};

use crate::commands::vault::VaultError;

const LRU_FILE_CAP: usize = 3;
const LRU_BYTE_CAP: u64 = 5 * 1024 * 1024 * 1024;
/// Max concurrent *running* ffmpeg children. Sized for the realistic
/// multi-window case (main player + popped-out player + a little headroom);
/// a new start only kills a prior remux once this many are already running.
const MAX_ACTIVE_TRANSCODES: usize = 3;

#[derive(Debug, Clone)]
pub enum EntryStatus {
    Running,
    Done,
    Failed {
        exit_code: Option<i32>,
        stderr_tail: String,
    },
}

#[derive(Debug)]
pub struct TranscodeEntry {
    pub hash: String,
    pub path: PathBuf,
    pub duration: Option<f64>,
    pub started_at: Instant,
    pub last_served_at: Instant,
    pub status: EntryStatus,
}

pub struct TranscodeRegistry {
    /// Currently-running ffmpeg children: transcode hash → child PID. Bounded
    /// by `MAX_ACTIVE_TRANSCODES`; entries are removed as supervisors finish.
    pub active: HashMap<String, u32>,
    pub entries: HashMap<String, TranscodeEntry>,
}

fn registry() -> &'static Mutex<TranscodeRegistry> {
    static CELL: OnceLock<Mutex<TranscodeRegistry>> = OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(TranscodeRegistry {
            active: HashMap::new(),
            entries: HashMap::new(),
        })
    })
}

/// Terminate a child by PID: SIGTERM on Unix, a hard `taskkill /T /F` on
/// Windows (no graceful analog).
fn signal_term(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        crate::commands::proc_util::terminate_pid(pid);
    }
}

pub fn cache_root() -> Result<PathBuf, VaultError> {
    let base = dirs::cache_dir()
        .ok_or_else(|| VaultError::Io("cache_dir() unavailable".into()))?;
    Ok(base.join("iskariel/transcodes"))
}

pub fn subs_root() -> Result<PathBuf, VaultError> {
    let base = dirs::cache_dir()
        .ok_or_else(|| VaultError::Io("cache_dir() unavailable".into()))?;
    Ok(base.join("iskariel/subs"))
}

pub fn transcode_path(hash: &str) -> Result<PathBuf, VaultError> {
    let dir = cache_root()?;
    std::fs::create_dir_all(&dir).map_err(|e| VaultError::Io(format!("mkdir transcodes: {e}")))?;
    Ok(dir.join(format!("{hash}.mp4")))
}

pub fn subs_path(hash: &str) -> Result<PathBuf, VaultError> {
    let dir = subs_root()?;
    std::fs::create_dir_all(&dir).map_err(|e| VaultError::Io(format!("mkdir subs: {e}")))?;
    Ok(dir.join(format!("{hash}.vtt")))
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
}

pub fn compute_subs_hash(abs: &str, stream: Option<i64>, mtime_ms: i64) -> String {
    let key = format!("sub:{abs}|{stream}|{mtime_ms}", stream = stream.unwrap_or(0));
    hash16(&key)
}

/// Snapshot what the asset-protocol handler needs without holding the lock.
/// Touches `last_served_at` so LRU eviction reflects recent use.
pub fn snapshot_for_serve(hash: &str) -> Option<(PathBuf, EntryStatus)> {
    let mut r = registry().lock().ok()?;
    let entry = r.entries.get_mut(hash)?;
    entry.last_served_at = Instant::now();
    Some((entry.path.clone(), entry.status.clone()))
}

/// Status snapshot only — used by the transcode command to await completion
/// before handing out the URL, without touching `last_served_at` (no bytes are
/// being served yet).
pub fn status_of(hash: &str) -> Option<EntryStatus> {
    let r = registry().lock().ok()?;
    r.entries.get(hash).map(|e| e.status.clone())
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
        args.extend([
            "-vf".into(),
            "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "18".into(),
            "-g".into(),
            format!("{}", (p.fps.round() as i64).max(1)),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
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
    let child = TokioCommand::new(crate::tool_path::resolve("ffmpeg"))
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| VaultError::Io(format!("ffmpeg spawn: {e}")))?;
    Ok(child)
}

/// Start a transcode for `hash` (or reuse an existing Done entry whose file
/// exists). Lock-discipline:
///   1. take lock → check fast-path (Done + file exists) → unlock + return
///   2. spawn ffmpeg *outside* the lock
///   3. re-lock → insert entry → add to active set → trim active over the
///      cap (oldest-started) + LRU evict → unlock → SIGTERM any trimmed
///      children → spawn supervisor task
pub fn start_or_reuse(
    hash: String,
    cache_path: PathBuf,
    abs: String,
    audio: Option<i64>,
    duration: Option<f64>,
    copy_audio: bool,
) -> Result<(), VaultError> {
    // 1. Fast-path under lock.
    {
        let r = registry().lock().map_err(|_| VaultError::Io("registry poisoned".into()))?;
        if let Some(entry) = r.entries.get(&hash) {
            if matches!(entry.status, EntryStatus::Done) && entry.path.exists() {
                return Ok(());
            }
        }
    }

    // 2. Spawn outside lock.
    let child = spawn_ffmpeg_to_file(&abs, audio, &cache_path, copy_audio, None)?;
    let new_pid = child
        .id()
        .ok_or_else(|| VaultError::Io("spawned child has no PID".into()))?;
    let started_at = Instant::now();

    // 3. Re-lock: insert entry, add to the active set, trim any excess over the
    //    concurrency cap, then LRU-evict files. The Child itself stays in scope
    //    here so we can hand it to the supervisor after we release the lock.
    let evicted_pids = {
        let mut r = registry().lock().map_err(|_| VaultError::Io("registry poisoned".into()))?;
        r.entries.insert(
            hash.clone(),
            TranscodeEntry {
                hash: hash.clone(),
                path: cache_path.clone(),
                duration,
                started_at,
                last_served_at: started_at,
                status: EntryStatus::Running,
            },
        );
        r.active.insert(hash.clone(), new_pid);
        let evicted = evict_over_active_cap(&mut r);
        lru_evict(&mut r);
        evicted
    };

    // 4. Signal any over-cap children outside the lock — each one's supervisor
    //    will see wait() return non-zero and flip its status to Failed. The
    //    common 1-2 window case trims nothing.
    for pid in evicted_pids {
        signal_term(pid);
    }

    spawn_supervisor(hash, started_at, child);
    Ok(())
}

fn spawn_supervisor(hash: String, captured_started: Instant, child: TokioChild) {
    tauri::async_runtime::spawn(async move {
        let output = child.wait_with_output().await;
        let (exit_code, stderr_tail) = match output {
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                let tail: String = stderr.chars().rev().take(400).collect::<String>()
                    .chars().rev().collect();
                (o.status.code(), tail)
            }
            Err(e) => (None, format!("wait error: {e}")),
        };

        let mut r = match registry().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // Stale-write guard: only flip status if the entry's started_at still
        // matches our captured value. A newer spawn-for-same-hash replaces it.
        {
            let Some(entry) = r.entries.get_mut(&hash) else { return };
            if entry.started_at != captured_started {
                return;
            }
            entry.status = if exit_code == Some(0) {
                EntryStatus::Done
            } else {
                EntryStatus::Failed { exit_code, stderr_tail }
            };
        }
        // We passed the started_at guard, so this child still owns the entry;
        // drop it from the running set (a no-op if it was already trimmed).
        r.active.remove(&hash);
    });
}

/// Atomic VTT extract: ffmpeg writes to `<out>.partial`, then rename. Idempotent
/// when the target file already exists (caller can pre-check). We re-check here
/// to handle racing callers — but a Tauri command is the only caller so this
/// is belt-and-suspenders.
pub async fn extract_subs_sync(
    abs: String,
    stream: Option<i64>,
    out_path: PathBuf,
) -> Result<(), VaultError> {
    if out_path.exists() {
        return Ok(());
    }
    let parent = out_path
        .parent()
        .ok_or_else(|| VaultError::Io("subs out_path has no parent".into()))?;
    std::fs::create_dir_all(parent).map_err(|e| VaultError::Io(format!("mkdir subs parent: {e}")))?;
    let partial = out_path.with_extension("vtt.partial");

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];
    args.push("-i".into());
    args.push(crate::tool_path::native_str(&abs)); // `\\?\`-strip (Windows ffprobe/ffmpeg reject verbatim)
    args.push("-map".into());
    args.push(format!("0:s:{}?", stream.unwrap_or(0).max(0)));
    args.extend([
        "-c:s".into(),
        "webvtt".into(),
        "-f".into(),
        "webvtt".into(),
        "-y".into(),
    ]);
    args.push(partial.display().to_string());

    let output = TokioCommand::new(crate::tool_path::resolve("ffmpeg"))
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("ffmpeg subs spawn: {e}")))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&partial);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(VaultError::Io(format!(
            "ffmpeg subs exit {}: {}",
            output.status,
            &stderr.chars().take(400).collect::<String>()
        )));
    }

    std::fs::rename(&partial, &out_path)
        .map_err(|e| VaultError::Io(format!("rename subs partial: {e}")))?;
    Ok(())
}

/// LRU eviction: while we exceed either cap, drop the oldest non-active entry.
/// Lock must be held by caller.
fn lru_evict(r: &mut TranscodeRegistry) {
    loop {
        let mut total_bytes: u64 = 0;
        let mut count = 0usize;
        for entry in r.entries.values() {
            if let Ok(meta) = std::fs::metadata(&entry.path) {
                total_bytes += meta.len();
            }
            count += 1;
        }
        if count <= LRU_FILE_CAP && total_bytes <= LRU_BYTE_CAP {
            return;
        }
        // Find oldest non-active (every running hash is protected).
        let oldest = r
            .entries
            .iter()
            .filter(|(h, _)| !r.active.contains_key(h.as_str()))
            .min_by_key(|(_, e)| e.last_served_at)
            .map(|(h, _)| h.clone());
        let Some(victim) = oldest else { return };
        if let Some(entry) = r.entries.remove(&victim) {
            let _ = std::fs::remove_file(&entry.path);
        }
    }
}

/// Trim the running set down to `MAX_ACTIVE_TRANSCODES`: while over budget,
/// remove the oldest-started active transcode and collect its PID for the
/// caller to SIGTERM (outside the lock). Returns the evicted PIDs — usually
/// empty (1-2 windows) and at most one per start. Lock held by caller.
fn evict_over_active_cap(r: &mut TranscodeRegistry) -> Vec<u32> {
    let mut evicted = Vec::new();
    while r.active.len() > MAX_ACTIVE_TRANSCODES {
        let oldest = r
            .active
            .keys()
            .filter_map(|h| r.entries.get(h).map(|e| (h.clone(), e.started_at)))
            .min_by_key(|(_, t)| *t)
            .map(|(h, _)| h);
        let Some(victim) = oldest else { break };
        if let Some(pid) = r.active.remove(&victim) {
            evicted.push(pid);
        }
    }
    evicted
}

/// Called from `RunEvent::Exit` — SIGTERMs every active child by PID.
pub fn shutdown_active() {
    let pids: Vec<u32> = {
        let mut r = match registry().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let pids = r.active.values().copied().collect();
        r.active.clear();
        r.entries.clear();
        pids
    };
    for p in pids {
        signal_term(p);
    }
}

// ── Test-only helpers (kept pub so integration tests can drive the registry) ──
// These are zero-cost in production; nothing in the prod path calls them.

// Poison-tolerant lock for tests — earlier tests that panicked while holding
// the lock leave it poisoned, but we want subsequent tests to recover cleanly.
fn test_lock_registry() -> std::sync::MutexGuard<'static, TranscodeRegistry> {
    registry().lock().unwrap_or_else(|p| p.into_inner())
}

#[doc(hidden)]
pub fn __test_reset_registry() {
    let pids: Vec<u32> = {
        let mut r = test_lock_registry();
        let pids = r.active.values().copied().collect();
        r.active.clear();
        r.entries.clear();
        pids
    };
    for p in pids {
        signal_term(p);
    }
}

#[doc(hidden)]
pub fn __test_registry_len() -> usize {
    test_lock_registry().entries.len()
}

#[doc(hidden)]
pub fn __test_active_hash() -> Option<String> {
    test_lock_registry().active.keys().next().cloned()
}

#[doc(hidden)]
pub fn __test_active_len() -> usize {
    test_lock_registry().active.len()
}

#[doc(hidden)]
pub fn __test_activate(hash: &str, pid: u32) {
    test_lock_registry().active.insert(hash.to_string(), pid);
}

#[doc(hidden)]
pub fn __test_run_active_cap() -> Vec<u32> {
    let mut r = test_lock_registry();
    evict_over_active_cap(&mut r)
}

#[doc(hidden)]
pub fn __test_status(hash: &str) -> Option<EntryStatus> {
    test_lock_registry().entries.get(hash).map(|e| e.status.clone())
}

#[doc(hidden)]
pub fn __test_insert(
    hash: &str,
    path: PathBuf,
    last_served_at: Instant,
    status: EntryStatus,
) {
    let mut r = test_lock_registry();
    r.entries.insert(
        hash.to_string(),
        TranscodeEntry {
            hash: hash.to_string(),
            path,
            duration: None,
            started_at: last_served_at,
            last_served_at,
            status,
        },
    );
}

#[doc(hidden)]
pub fn __test_set_active(hash: Option<String>) {
    let mut r = test_lock_registry();
    r.active.clear();
    if let Some(h) = hash {
        r.active.insert(h, 0);
    }
}

#[doc(hidden)]
pub fn __test_run_lru() {
    let mut r = test_lock_registry();
    lru_evict(&mut r);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::Duration;
    use tempfile::TempDir;

    // The registry is a process-wide singleton; serialize the tests that mutate
    // it so cargo's parallel test threads don't clobber each other's inserts.
    static REG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    fn subs_hash_disjoint_from_transcode_hash() {
        let a = compute_hash("/x/y.mkv", Some(0), 123);
        let b = compute_subs_hash("/x/y.mkv", Some(0), 123);
        assert_ne!(a, b);
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

    fn make_sparse(dir: &Path, name: &str, size: u64) -> PathBuf {
        let p = dir.join(name);
        let f = File::create(&p).unwrap();
        f.set_len(size).unwrap();
        p
    }

    #[test]
    fn lru_evict_drops_oldest() {
        let _g = REG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        __test_reset_registry();
        let td = TempDir::new().unwrap();
        let now = Instant::now();
        // 4 entries — LRU_FILE_CAP=3 → should evict oldest.
        let p_a = make_sparse(td.path(), "a.mp4", 100);
        let p_b = make_sparse(td.path(), "b.mp4", 100);
        let p_c = make_sparse(td.path(), "c.mp4", 100);
        let p_d = make_sparse(td.path(), "d.mp4", 100);
        __test_insert("a", p_a.clone(), now - Duration::from_secs(40), EntryStatus::Done);
        __test_insert("b", p_b, now - Duration::from_secs(30), EntryStatus::Done);
        __test_insert("c", p_c, now - Duration::from_secs(20), EntryStatus::Done);
        __test_insert("d", p_d, now - Duration::from_secs(10), EntryStatus::Done);
        __test_run_lru();
        assert_eq!(__test_registry_len(), 3);
        assert!(!p_a.exists(), "oldest file should be unlinked");
        __test_reset_registry();
    }

    #[test]
    fn lru_evict_respects_active_hash() {
        let _g = REG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        __test_reset_registry();
        let td = TempDir::new().unwrap();
        let now = Instant::now();
        let p_a = make_sparse(td.path(), "a.mp4", 100);
        let p_b = make_sparse(td.path(), "b.mp4", 100);
        let p_c = make_sparse(td.path(), "c.mp4", 100);
        let p_d = make_sparse(td.path(), "d.mp4", 100);
        // Mark `a` as oldest AND active — should evict `b` instead.
        __test_insert("a", p_a.clone(), now - Duration::from_secs(40), EntryStatus::Running);
        __test_insert("b", p_b.clone(), now - Duration::from_secs(30), EntryStatus::Done);
        __test_insert("c", p_c, now - Duration::from_secs(20), EntryStatus::Done);
        __test_insert("d", p_d, now - Duration::from_secs(10), EntryStatus::Done);
        __test_set_active(Some("a".into()));
        __test_run_lru();
        assert_eq!(__test_registry_len(), 3);
        assert!(p_a.exists(), "active file must survive");
        assert!(!p_b.exists(), "oldest non-active should be unlinked");
        __test_reset_registry();
    }

    #[test]
    fn lru_evict_byte_budget() {
        let _g = REG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        __test_reset_registry();
        let td = TempDir::new().unwrap();
        let now = Instant::now();
        // Three files, each just over LRU_BYTE_CAP/2 → 1 alone fits, 2 don't,
        // so we need to evict down to 1 file regardless of file-count cap.
        let big = LRU_BYTE_CAP / 2 + 1024;
        let p_a = make_sparse(td.path(), "a.mp4", big);
        let p_b = make_sparse(td.path(), "b.mp4", big);
        let p_c = make_sparse(td.path(), "c.mp4", big);
        __test_insert("a", p_a.clone(), now - Duration::from_secs(30), EntryStatus::Done);
        __test_insert("b", p_b.clone(), now - Duration::from_secs(20), EntryStatus::Done);
        __test_insert("c", p_c.clone(), now - Duration::from_secs(10), EntryStatus::Done);
        __test_run_lru();
        // After eviction, byte total must be ≤ cap. With 2× big > cap, we keep 1.
        assert_eq!(__test_registry_len(), 1);
        assert!(p_c.exists(), "newest survives");
        __test_reset_registry();
    }
}
