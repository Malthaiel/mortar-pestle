//! Sub-feature 7.5 — transcode + asset_protocol integration tests.
//!
//! All tests are gated with `#[ignore]` because they require ffmpeg on $PATH
//! and run multi-second timing-sensitive workloads. Run explicitly with:
//!
//! ```bash
//! cargo test -p iskariel --test transcode_integration -- --ignored --test-threads=1
//! ```
//!
//! The registry is process-wide singleton state, so we serialize all tests
//! through `TEST_LOCK` and reset it between cases.

use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use http::header;
use tauri::http::Request;
use tempfile::TempDir;

use app_lib::asset_protocol::{serve_subs, serve_transcode};
use app_lib::parsers::video_transcode::{
    __test_activate, __test_active_len, __test_insert, __test_registry_len, __test_reset_registry,
    __test_run_active_cap, __test_status, cache_root, compute_hash, compute_subs_hash,
    extract_subs_sync, mtime_ms_for, shutdown_active, start_or_reuse, subs_path, transcode_path,
    EntryStatus,
};

static TEST_LOCK: Mutex<()> = Mutex::new(());

fn ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create a 3-second h264+aac MKV. Used as a transcode source.
fn make_fixture_mkv(out: &std::path::Path) {
    let status = Command::new("ffmpeg")
        .args([
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-shortest",
        ])
        .arg(out)
        .status()
        .expect("ffmpeg fixture spawn");
    assert!(status.success(), "fixture MKV creation failed");
}

/// Create a 3-second MKV with an embedded SRT subtitle track.
fn make_fixture_mkv_with_subs(dir: &std::path::Path) -> std::path::PathBuf {
    let srt = dir.join("subs.srt");
    std::fs::write(
        &srt,
        "1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n",
    )
    .unwrap();
    let mkv = dir.join("fixture_subs.mkv");
    let status = Command::new("ffmpeg")
        .args([
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        ])
        .arg("-i")
        .arg(&srt)
        .args([
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-c:s", "srt",
            "-shortest",
        ])
        .arg(&mkv)
        .status()
        .expect("ffmpeg subs-fixture spawn");
    assert!(status.success(), "fixture MKV-with-subs creation failed");
    mkv
}

fn override_cache_dirs(tmp: &std::path::Path) {
    // dirs::cache_dir() honors XDG_CACHE_HOME on Linux — point it at the tmp
    // dir so `cache_root()` returns `<tmp>/iskariel/transcodes`.
    std::env::set_var("XDG_CACHE_HOME", tmp);
}

fn wait_until<F: FnMut() -> bool>(deadline: Duration, mut cond: F) -> bool {
    let start = Instant::now();
    while start.elapsed() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    cond()
}

#[test]
#[ignore]
fn transcode_writes_complete_file() {
    if !ffmpeg_available() {
        eprintln!("skipping — ffmpeg not on PATH");
        return;
    }
    let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _enter = rt.enter();
    __test_reset_registry();
    let tmp = TempDir::new().unwrap();
    override_cache_dirs(tmp.path());

    let mkv = tmp.path().join("fixture.mkv");
    make_fixture_mkv(&mkv);

    let mtime = mtime_ms_for(&mkv);
    let abs = mkv.display().to_string();
    let hash = compute_hash(&abs, Some(0), mtime);
    let out = transcode_path(&hash).unwrap();
    start_or_reuse(hash.clone(), out.clone(), abs, Some(0), Some(3.0), true).unwrap();

    let grew = wait_until(Duration::from_secs(30), || {
        std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false)
    });
    assert!(grew, "transcode file never written");

    // Eventually flips to Done.
    let done = wait_until(Duration::from_secs(30), || {
        matches!(__test_status(&hash), Some(EntryStatus::Done))
    });
    assert!(done, "transcode never completed; status = {:?}", __test_status(&hash));
    assert!(std::fs::metadata(&out).unwrap().len() > 1024);
    __test_reset_registry();
}

#[test]
#[ignore]
fn concurrent_starts_coexist() {
    if !ffmpeg_available() {
        eprintln!("skipping — ffmpeg not on PATH");
        return;
    }
    let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _enter = rt.enter();
    __test_reset_registry();
    let tmp = TempDir::new().unwrap();
    override_cache_dirs(tmp.path());

    let mkv1 = tmp.path().join("a.mkv");
    let mkv2 = tmp.path().join("b.mkv");
    make_fixture_mkv(&mkv1);
    make_fixture_mkv(&mkv2);

    let mtime1 = mtime_ms_for(&mkv1);
    let mtime2 = mtime_ms_for(&mkv2);
    let abs1 = mkv1.display().to_string();
    let abs2 = mkv2.display().to_string();
    let h1 = compute_hash(&abs1, Some(0), mtime1);
    let h2 = compute_hash(&abs2, Some(0), mtime2);

    // Two windows preparing different episodes at once (under the cap) must
    // BOTH run — h2's start no longer SIGTERMs h1's in-flight remux.
    start_or_reuse(h1.clone(), transcode_path(&h1).unwrap(), abs1, Some(0), Some(3.0), true).unwrap();
    start_or_reuse(h2.clone(), transcode_path(&h2).unwrap(), abs2, Some(0), Some(3.0), true).unwrap();

    // h1 must never be killed: it completes (or is still running), never Failed.
    let h1_done = wait_until(Duration::from_secs(30), || {
        matches!(__test_status(&h1), Some(EntryStatus::Done))
    });
    assert!(
        h1_done,
        "concurrent h1 should complete, not get killed; status = {:?}",
        __test_status(&h1)
    );
    assert!(
        !matches!(__test_status(&h1), Some(EntryStatus::Failed { .. })),
        "h1 was killed by h2's start — concurrency regression"
    );
    // h2 completes too.
    let h2_done = wait_until(Duration::from_secs(30), || {
        matches!(__test_status(&h2), Some(EntryStatus::Done))
    });
    assert!(h2_done, "h2 should complete; status = {:?}", __test_status(&h2));
    __test_reset_registry();
}

// Over-cap eviction is pure registry bookkeeping (no ffmpeg) — runs by default,
// not #[ignore]. Verifies a 4th concurrent start trims only the oldest-started.
#[test]
fn active_cap_evicts_oldest_over_budget() {
    let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    __test_reset_registry();
    let now = Instant::now();
    // MAX_ACTIVE_TRANSCODES is 3; insert 4 running children, "a" oldest-started.
    let names = ["a", "b", "c", "d"];
    for (i, &name) in names.iter().enumerate() {
        __test_insert(
            name,
            std::path::PathBuf::from(format!("/tmp/agentic-test/{name}.mp4")),
            now - Duration::from_secs((40 - i * 10) as u64),
            EntryStatus::Running,
        );
        __test_activate(name, 1000 + i as u32);
    }
    assert_eq!(__test_active_len(), 4);
    let evicted = __test_run_active_cap();
    // Only the single excess over the cap (3) is trimmed, and it's the oldest.
    assert_eq!(evicted, vec![1000]);
    assert_eq!(__test_active_len(), 3);
    __test_reset_registry();
}

#[test]
#[ignore]
fn serve_transcode_returns_range_chunk() {
    let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    __test_reset_registry();
    let tmp = TempDir::new().unwrap();
    override_cache_dirs(tmp.path());

    // Synthesize a 4 KB "transcode output" file directly (no ffmpeg needed).
    let hash = "deadbeefcafef00d";
    let path = transcode_path(hash).unwrap();
    let bytes: Vec<u8> = (0..4096).map(|i| (i & 0xff) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    __test_insert(hash, path.clone(), Instant::now(), EntryStatus::Done);

    let req = Request::builder()
        .method("GET")
        .uri(format!("/transcode/{hash}.mp4"))
        .header(header::RANGE, "bytes=0-1023")
        .body(Vec::new())
        .unwrap();
    let resp = serve_transcode(hash, &req);
    assert_eq!(resp.status(), http::StatusCode::PARTIAL_CONTENT);
    let cr = resp.headers().get(header::CONTENT_RANGE).unwrap().to_str().unwrap();
    assert_eq!(cr, "bytes 0-1023/4096");
    assert_eq!(resp.body().len(), 1024);
    assert_eq!(&resp.body()[..16], &bytes[..16]);
    __test_reset_registry();
}

#[test]
#[ignore]
fn extract_subs_writes_and_idempotent() {
    if !ffmpeg_available() {
        eprintln!("skipping — ffmpeg not on PATH");
        return;
    }
    let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    __test_reset_registry();
    let tmp = TempDir::new().unwrap();
    override_cache_dirs(tmp.path());

    let mkv = make_fixture_mkv_with_subs(tmp.path());
    let mtime = mtime_ms_for(&mkv);
    let abs = mkv.display().to_string();
    let hash = compute_subs_hash(&abs, Some(0), mtime);
    let out = subs_path(&hash).unwrap();

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(extract_subs_sync(abs.clone(), Some(0), out.clone())).unwrap();
    assert!(out.exists(), "VTT not written");
    let vtt = std::fs::read_to_string(&out).unwrap();
    assert!(vtt.starts_with("WEBVTT"), "not a WebVTT file: {}", &vtt[..40.min(vtt.len())]);
    let size_after_first = out.metadata().unwrap().len();

    // Second call must be a no-op (file already exists).
    runtime.block_on(extract_subs_sync(abs, Some(0), out.clone())).unwrap();
    let size_after_second = out.metadata().unwrap().len();
    assert_eq!(size_after_first, size_after_second);

    // serve_subs delivers it via asset_protocol.
    let req = Request::builder()
        .method("GET")
        .uri(format!("/subs/{hash}.vtt"))
        .body(Vec::new())
        .unwrap();
    let resp = serve_subs(&hash, &req);
    assert_eq!(resp.status(), http::StatusCode::OK);
    let body = std::str::from_utf8(resp.body()).unwrap();
    assert!(body.starts_with("WEBVTT"));
    __test_reset_registry();
}

#[test]
#[ignore]
fn cleanup_on_exit_wipes_dir() {
    let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    __test_reset_registry();
    let tmp = TempDir::new().unwrap();
    override_cache_dirs(tmp.path());

    // Populate the transcodes dir with two fake outputs.
    let root = cache_root().unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("aaaaaaaaaaaaaaaa.mp4"), b"x").unwrap();
    std::fs::write(root.join("bbbbbbbbbbbbbbbb.mp4"), b"y").unwrap();
    __test_insert("aaaaaaaaaaaaaaaa", root.join("aaaaaaaaaaaaaaaa.mp4"), Instant::now(), EntryStatus::Done);
    __test_insert("bbbbbbbbbbbbbbbb", root.join("bbbbbbbbbbbbbbbb.mp4"), Instant::now(), EntryStatus::Done);
    assert_eq!(__test_registry_len(), 2);

    // Mimic the RunEvent::Exit handler.
    let _ = std::fs::remove_dir_all(&root);
    shutdown_active();

    assert!(!root.exists(), "cache root should be wiped");
    assert_eq!(__test_registry_len(), 0);
}
