//! Music download engine — sequential, background, survives navigation.
//!
//! `music_download_enqueue` pushes a job onto a process-global queue and starts
//! a single worker (if idle). The worker processes **one album at a time**
//! (decision #5): it spawns `scripts/download_album.py`, reads the script's
//! NDJSON progress on stdout, mirrors it into the job state, and re-emits Tauri
//! events (`music-download-progress` / `music-download-done`) that survive
//! navigation — the same `app.emit` model `build.rs` uses, NOT a `Channel`
//! (which would die with the calling component).
//!
//! `music_download_status` snapshots all jobs for provider hydration on mount;
//! `music_download_cancel` drops a queued job or SIGTERMs the active child.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::commands::job_queue::{self, CancelAction, JobItem};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Downloading,
    Done,
    Error,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailedTrack {
    pub n: i64,
    pub title: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub rg_mbid: String,
    pub title: String,
    pub artist: String,
    pub cover: Option<String>,
    pub state: JobState,
    pub track_index: i64,
    pub track_total: i64,
    pub track_title: Option<String>,
    pub queue_position: i64,
    pub failed: Vec<FailedTrack>,
    pub album_path: Option<String>,
    pub error: Option<String>,
    pub size_bytes: Option<i64>,
    pub dl_speed: Option<f64>,
    pub eta_secs: Option<i64>,
    pub save_path: Option<String>,
    /// Per-song download of an album track (`--only-track N`). None = whole album.
    pub track_n: Option<i64>,
    /// Loose single (no release group): the YouTube upload to download. Set with
    /// an empty `rg_mbid` — that pair is what makes a job a `--single` run.
    pub watch_url: Option<String>,
    /// Vault-relative .opus of a finished single — what the Saved Tracks
    /// auto-append reads off the done event.
    pub audio_path: Option<String>,
    #[serde(skip)]
    pub child_pid: Option<u32>,
    #[serde(skip)]
    pub only_missing: bool,
    #[serde(skip)]
    pub cancel_requested: bool,
    /// Add-to-Library / import mode: the script writes the album page only (no
    /// audio). Serialized so the UI can label these jobs "Adding to library".
    pub metadata_only: bool,
    /// Initial frontmatter Status for metadata-only cards (quick-status menu).
    #[serde(skip)]
    pub initial_status: Option<String>,
}

static DOWNLOAD_STATE: Mutex<job_queue::Queue<DownloadJob>> = Mutex::new(job_queue::Queue::new());
static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

/// Resolve the download script: bundled resource first, dev fallback to the
/// source tree (dev runs from source, not the bundle — flagged in the plan as
/// the `BaseDirectory::Resource` footgun with no prior repo precedent).
fn resolve_script(app: &AppHandle) -> Option<String> {
    if let Ok(p) = app
        .path()
        .resolve("scripts/download_album.py", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    if let Some(home) = dirs::home_dir() {
        let dev = home.join("Code/mortar-pestle/src-tauri/scripts/download_album.py");
        if dev.exists() {
            return Some(dev.to_string_lossy().into_owned());
        }
    }
    None
}

/// (1-based) position among queued jobs; 0 for the active one.
fn recompute_queue_positions(state: &mut job_queue::Queue<DownloadJob>) {
    let mut pos = 1;
    for j in state.jobs.iter_mut() {
        match j.state {
            JobState::Downloading => j.queue_position = 0,
            JobState::Queued => {
                j.queue_position = pos;
                pos += 1;
            }
            _ => {}
        }
    }
}

fn snapshot(job_id: &str) -> Option<DownloadJob> {
    job_queue::snapshot(&DOWNLOAD_STATE, |j| j.id == job_id)
}

fn emit_progress(app: &AppHandle, job_id: &str) {
    if let Some(job) = snapshot(job_id) {
        let _ = app.emit("music-download-progress", &job);
    }
}

fn emit_done(app: &AppHandle, job_id: &str, album_path: Option<String>) {
    let _ = app.emit(
        "music-download-done",
        serde_json::json!({ "jobId": job_id, "albumPath": album_path }),
    );
}

#[tauri::command]
pub async fn music_download_enqueue(
    app: AppHandle,
    rg_mbid: String,
    title: String,
    artist: String,
    cover: Option<String>,
    only_missing: Option<bool>,
    metadata_only: Option<bool>,
    initial_status: Option<String>,
    track_n: Option<i64>,
    watch_url: Option<String>,
) -> Result<String, String> {
    let watch_url = watch_url.filter(|u| !u.trim().is_empty());
    // No release group = a loose single, which needs its own source instead.
    if rg_mbid.trim().is_empty() && watch_url.is_none() && (title.trim().is_empty() || artist.trim().is_empty()) {
        return Err("release-group MBID required (or watchUrl / artist + title for a single)".into());
    }
    let id = format!("dl{}", JOB_SEQ.fetch_add(1, Ordering::Relaxed));
    let should_start = {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        guard.jobs.push(DownloadJob {
            id: id.clone(),
            rg_mbid,
            title,
            artist,
            cover,
            state: JobState::Queued,
            track_index: 0,
            track_total: 0,
            track_title: None,
            queue_position: 0,
            failed: Vec::new(),
            album_path: None,
            error: None,
            size_bytes: None,
            dl_speed: None,
            eta_secs: None,
            save_path: None,
            track_n: track_n.filter(|n| *n > 0),
            watch_url,
            audio_path: None,
            child_pid: None,
            only_missing: only_missing.unwrap_or(false),
            cancel_requested: false,
            metadata_only: metadata_only.unwrap_or(false),
            initial_status,
        });
        recompute_queue_positions(&mut guard);
        if !guard.worker_running {
            guard.worker_running = true;
            true
        } else {
            false
        }
    };
    emit_progress(&app, &id);
    if should_start {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move { run_worker(app2).await });
    }
    Ok(id)
}

#[tauri::command]
pub fn music_download_status() -> Vec<DownloadJob> {
    job_queue::status(&DOWNLOAD_STATE)
}

impl JobItem for DownloadJob {
    fn id(&self) -> &str {
        &self.id
    }
    fn cancel_in_place(&mut self) -> CancelAction {
        match self.state {
            JobState::Queued => {
                self.state = JobState::Cancelled;
                CancelAction::Queued
            }
            JobState::Downloading => {
                self.cancel_requested = true;
                CancelAction::Active(self.child_pid)
            }
            _ => CancelAction::Terminal,
        }
    }
}

#[tauri::command]
pub fn music_download_cancel(job_id: String) -> Result<(), String> {
    // Queued → Cancelled (then renumber positions under the held lock); active →
    // SIGTERM the yt-dlp child, SIGKILL after a grace period. The in-flight child
    // may finish its current track before exiting; no new tracks start.
    // finalize_job marks the job Cancelled when python exits.
    if let Some(pid) = job_queue::cancel(&DOWNLOAD_STATE, &job_id, recompute_queue_positions)? {
        job_queue::kill_child_graceful(pid);
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamResolve {
    pub stream_url: String,
    pub watch_url: String,
}

/// Resolve one not-downloaded track to a direct, playable googlevideo URL —
/// the interactive counterpart to the download queue (never routed through the
/// sequential worker: resolve is per-click, fast, parallel-safe). A cached
/// watch URL in the album page's `Track Sources` map skips the YouTube search;
/// when the search runs, the script writes the found URL back into that map so
/// the next play is fast. Stream URLs are IP + time-bound — callers re-resolve
/// on every play and never persist them.
///
/// A `watch_url` (a loose YouTube search hit, no album card behind it) short-
/// circuits all of that: the script resolves that exact upload, nothing is
/// cached or written back.
#[tauri::command]
pub async fn music_stream_resolve(
    app: AppHandle,
    album_path: Option<String>,
    n: Option<i64>,
    watch_url: Option<String>,
    artist: Option<String>,
    album_title: Option<String>,
    track_title: Option<String>,
    duration_sec: Option<i64>,
) -> Result<StreamResolve, String> {
    let Some(script) = resolve_script(&app) else {
        return Err("download script not found (scripts/download_album.py)".into());
    };

    if let Some(url) = watch_url.filter(|u| !u.is_empty()) {
        let mut cmd = crate::commands::proc_util::python_cmd();
        cmd.arg(&script).arg("--resolve").arg("--watch-url").arg(&url);
        return run_resolve_cmd(cmd).await;
    }

    // A playlist row names its album card and title but not the album's track
    // number (its n is the playlist position): find n by title, so it takes the
    // card path below (remembered watch URL, no search). No card, or no title
    // match, falls through to the search.
    let n = n.or_else(|| {
        let (ap, tt) = (album_path.as_deref()?, track_title.as_deref()?.trim());
        let album = crate::parsers::albums::read_album(ap).ok()?;
        album.tracks.iter().find(|t| t.title.trim().eq_ignore_ascii_case(tt)).map(|t| t.n)
    });
    let album_path = album_path.filter(|_| n.is_some());

    // No album card on disk — a Browse-preview track, which exists only as
    // MusicBrainz metadata. Hand the script the search inputs directly; there's
    // no page to read a cached watch URL from or to write one back to.
    if album_path.is_none() {
        let (Some(artist), Some(title)) = (
            artist.filter(|s| !s.is_empty()),
            track_title.filter(|s| !s.is_empty()),
        ) else {
            return Err(
                "music_stream_resolve needs albumPath + n, watchUrl, or artist + trackTitle".into(),
            );
        };
        let mut cmd = crate::commands::proc_util::python_cmd();
        cmd.arg(&script)
            .arg("--resolve")
            .arg("--artist")
            .arg(&artist)
            .arg("--track-title")
            .arg(&title);
        if let Some(at) = album_title.filter(|s| !s.is_empty()) {
            cmd.arg("--album-title").arg(&at);
        }
        if let Some(d) = duration_sec.filter(|d| *d > 0) {
            cmd.arg("--duration-sec").arg(d.to_string());
        }
        return run_resolve_cmd(cmd).await;
    }

    let album_path = album_path.ok_or("music_stream_resolve needs albumPath + n or watchUrl")?;
    let n = n.ok_or("music_stream_resolve needs albumPath + n or watchUrl")?;

    // Album context: artist/title/duration for the search path, cached watch
    // URL + exact Track Sources key for the fast path / writeback.
    let album = crate::parsers::albums::read_album(&album_path).map_err(|e| format!("{e:?}"))?;
    let track = album
        .tracks
        .iter()
        .find(|t| t.n == n)
        .ok_or_else(|| format!("track {n} not found in {album_path}"))?;

    // The cached-URL lookup + writeback both live in the python script (it
    // owns the page format; the app's frontmatter parser can't read nested
    // maps like `Track Sources`). Rust just hands it the page + track number
    // plus the search inputs used when nothing is cached.
    let abs = std::path::PathBuf::from(crate::commands::vault::library_vault_root())
        .join(&album_path);
    if album.artist.is_empty() {
        return Err("album card has no artist to search with".into());
    }
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script)
        .arg("--resolve")
        .arg("--album-page")
        .arg(abs.as_os_str())
        .arg("--track-n")
        .arg(n.to_string())
        .arg("--artist")
        .arg(&album.artist)
        .arg("--album-title")
        .arg(&album.title)
        .arg("--track-title")
        .arg(&track.title);
    if let Some(d) = track.duration {
        cmd.arg("--duration-sec").arg(d.to_string());
    }
    run_resolve_cmd(cmd).await
}

/// Run a prepared `--resolve` invocation and read its NDJSON back.
async fn run_resolve_cmd(mut cmd: tokio::process::Command) -> Result<StreamResolve, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn python3: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut err_msg: Option<String> = None;
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match v.get("event").and_then(|x| x.as_str()) {
            Some("resolve") => {
                let stream = v.get("streamUrl").and_then(|x| x.as_str()).unwrap_or("");
                let watch = v.get("watchUrl").and_then(|x| x.as_str()).unwrap_or("");
                if !stream.is_empty() {
                    return Ok(StreamResolve {
                        stream_url: stream.into(),
                        watch_url: watch.into(),
                    });
                }
            }
            Some("error") => {
                err_msg = v.get("message").and_then(|x| x.as_str()).map(String::from);
            }
            _ => {}
        }
    }
    Err(err_msg.unwrap_or_else(|| {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no output");
        // Carry the child's exit status: a helper that ran and failed is a small
        // code, a helper killed mid-flight (app relaunch) is a large one. Without
        // it both land on the screen as the same bare "no output".
        format!("stream resolve failed ({}): {tail}", out.status)
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeHit {
    pub watch_url: String,
    pub title: String,
    pub uploader: String,
    pub duration: Option<f64>,
}

/// Free-text YouTube search — the second catalogue behind the Music search bar
/// (MusicBrainz is the first). Shells out to the same download script, which
/// owns the yt-dlp invocation; results are metadata only, nothing is downloaded
/// and no stream is resolved until a hit is actually played.
#[tauri::command]
pub async fn music_search_youtube(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<YoutubeHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let Some(script) = resolve_script(&app) else {
        return Err("download script not found (scripts/download_album.py)".into());
    };
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script)
        .arg("--search")
        .arg(q)
        .arg("--limit")
        .arg(limit.unwrap_or(15).clamp(1, 50).to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn python3: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut err_msg: Option<String> = None;
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match v.get("event").and_then(|x| x.as_str()) {
            Some("search") => {
                let arr = v.get("results").and_then(|x| x.as_array());
                return Ok(arr
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|r| {
                                let url = r.get("watchUrl").and_then(|x| x.as_str())?;
                                Some(YoutubeHit {
                                    watch_url: url.to_string(),
                                    title: r
                                        .get("title")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    uploader: r
                                        .get("uploader")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    duration: r.get("duration").and_then(|x| x.as_f64()),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default());
            }
            Some("error") => {
                err_msg = v.get("message").and_then(|x| x.as_str()).map(String::from);
            }
            _ => {}
        }
    }
    Err(err_msg.unwrap_or_else(|| {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no output");
        format!("YouTube search failed ({}): {tail}", out.status)
    }))
}

async fn run_worker(app: AppHandle) {
    loop {
        let job_id = {
            let mut guard = DOWNLOAD_STATE.lock().unwrap();
            match guard.jobs.iter().position(|j| matches!(j.state, JobState::Queued)) {
                Some(idx) => {
                    guard.jobs[idx].state = JobState::Downloading;
                    let id = guard.jobs[idx].id.clone();
                    recompute_queue_positions(&mut guard);
                    Some(id)
                }
                None => {
                    guard.worker_running = false;
                    None
                }
            }
        };
        let Some(job_id) = job_id else { break };
        emit_progress(&app, &job_id);
        process_job(&app, &job_id).await;
    }
}

async fn process_job(app: &AppHandle, job_id: &str) {
    let (rg_mbid, only_missing, metadata_only, initial_status, track_n, watch_url, title, artist) = {
        let guard = DOWNLOAD_STATE.lock().unwrap();
        match guard.jobs.iter().find(|j| j.id == job_id) {
            Some(j) => (
                j.rg_mbid.clone(),
                j.only_missing,
                j.metadata_only,
                j.initial_status.clone(),
                j.track_n,
                j.watch_url.clone(),
                j.title.clone(),
                j.artist.clone(),
            ),
            None => return,
        }
    };

    let Some(script) = resolve_script(app) else {
        finalize_error(app, job_id, "download script not found (scripts/download_album.py)");
        return;
    };
    // Albums + tracks now live in the writable Library vault (Library Migration
    // Phase 2); download_album.py uses --vault only as the catalog base.
    let vault = crate::commands::vault::library_vault_root();

    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script).arg("--vault").arg(&vault);
    if rg_mbid.trim().is_empty() {
        // Loose single — no release group, so no album page and no MusicBrainz.
        cmd.arg("--single");
        if let Some(u) = watch_url.as_deref().filter(|u| !u.is_empty()) {
            cmd.arg("--watch-url").arg(u);
        }
        if !artist.is_empty() {
            cmd.arg("--artist").arg(&artist);
        }
        if !title.is_empty() {
            cmd.arg("--track-title").arg(&title);
        }
    } else {
        cmd.arg("--rg-mbid").arg(&rg_mbid);
        if let Some(n) = track_n {
            cmd.arg("--only-track").arg(n.to_string());
        }
        if only_missing {
            cmd.arg("--only-missing");
        }
        if metadata_only {
            cmd.arg("--metadata-only");
            cmd.arg("--status")
                .arg(initial_status.as_deref().unwrap_or("Plan-to-Listen"));
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            finalize_error(app, job_id, &format!("failed to spawn python3: {e}"));
            return;
        }
    };
    {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        if let Some(j) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
            j.child_pid = child.id();
        }
    }
    emit_progress(app, job_id);

    // Drain stdout (NDJSON events) to EOF, then stderr (low-volume diagnostics —
    // yt-dlp/ffmpeg output is captured inside the script, so the script's own
    // stderr never fills the pipe before stdout closes).
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            handle_event(app, job_id, &line);
        }
    }
    let mut err_tail = String::new();
    if let Some(err) = child.stderr.take() {
        let mut lines = BufReader::new(err).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                err_tail = line;
            }
        }
    }
    let exit = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
    finalize_job(app, job_id, exit, &err_tail);
}

fn handle_event(app: &AppHandle, job_id: &str, line: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let event = v.get("event").and_then(|x| x.as_str()).unwrap_or("");
    {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        let Some(job) = guard.jobs.iter_mut().find(|j| j.id == job_id) else {
            return;
        };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        match event {
            "release" => {
                job.track_total = v.get("trackTotal").and_then(|x| x.as_i64()).unwrap_or(0);
                if let Some(p) = s("albumPath") {
                    job.album_path = Some(p);
                }
                if let Some(c) = s("cover") {
                    if !c.is_empty() {
                        job.cover = Some(c);
                    }
                }
                if let Some(t) = s("title") {
                    job.title = t;
                }
                if let Some(a) = s("artist") {
                    job.artist = a;
                }
            }
            "track" => {
                let n = v.get("n").and_then(|x| x.as_i64()).unwrap_or(0);
                job.track_index = n;
                job.track_title = s("title");
                if v.get("status").and_then(|x| x.as_str()) == Some("fail") {
                    job.failed.push(FailedTrack {
                        n,
                        title: s("title").unwrap_or_default(),
                    });
                }
            }
            "progress" => {
                if let Some(sp) = v.get("speed").and_then(|x| x.as_f64()) {
                    job.dl_speed = Some(sp);
                }
                job.eta_secs = v.get("eta").and_then(|x| x.as_i64());
                if let Some(b) = v.get("albumBytes").and_then(|x| x.as_i64()) {
                    job.size_bytes = Some(b);
                }
            }
            "done" => {
                if let Some(p) = s("albumPath") {
                    job.album_path = Some(p);
                }
                if let Some(sp) = s("savePath") {
                    job.save_path = Some(sp);
                }
                if let Some(ap) = s("audioPath") {
                    job.audio_path = Some(ap);
                }
                if let Some(u) = s("watchUrl") {
                    job.watch_url = Some(u);
                }
                if let Some(b) = v.get("sizeBytes").and_then(|x| x.as_i64()) {
                    job.size_bytes = Some(b);
                }
            }
            "error" => {
                job.error = s("message");
            }
            _ => {}
        }
    }
    emit_progress(app, job_id);
}

/// Persist a terminal job into the shared downloads history (best-effort). Reads
/// the in-process job clone so the `#[serde(skip)]` `only_missing` retry arg is
/// captured even though it never reaches JS via the live job.
fn record_history(app: &AppHandle, job_id: &str) {
    let Some(j) = snapshot(job_id) else { return };
    let state = match j.state {
        JobState::Done => "done",
        JobState::Error => "error",
        JobState::Cancelled => "cancelled",
        _ => return, // not terminal — nothing to record
    };
    let args = serde_json::json!({
        "kind": "music",
        "rgMbid": j.rg_mbid,
        "title": j.title,
        "artist": j.artist,
        "cover": j.cover,
        "onlyMissing": j.only_missing,
        "metadataOnly": j.metadata_only,
        "initialStatus": j.initial_status,
        "trackN": j.track_n,
        "watchUrl": j.watch_url,
    });
    crate::commands::downloads_history::record(
        app,
        crate::commands::downloads_history::HistoryRecord {
            id: j.id.clone(),
            source: "music".into(),
            title: j.title.clone(),
            subtitle: if j.metadata_only {
                format!("{} · Added to library", j.artist)
            } else {
                j.artist.clone()
            },
            state: state.into(),
            cover: j.cover.clone(),
            finished_at: crate::commands::downloads_history::now_ms(),
            open_path: j.album_path.clone(),
            reveal_path: j.save_path.clone(),
            size_bytes: j.size_bytes,
            save_path: j.save_path.clone(),
            failed_count: j.failed.len() as i64,
            error: j.error.clone(),
            args,
        },
    );
}

fn finalize_job(app: &AppHandle, job_id: &str, exit: i32, err_tail: &str) {
    let album_path = {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        let Some(job) = guard.jobs.iter_mut().find(|j| j.id == job_id) else {
            return;
        };
        job.child_pid = None;
        if job.cancel_requested {
            job.state = JobState::Cancelled;
        } else if exit == 0 {
            job.state = JobState::Done;
        } else {
            job.state = JobState::Error;
            if job.error.is_none() {
                job.error = Some(if err_tail.is_empty() {
                    format!("download exited with code {exit}")
                } else {
                    err_tail.to_string()
                });
            }
        }
        job.album_path.clone()
    };
    emit_progress(app, job_id);
    emit_done(app, job_id, album_path);
    record_history(app, job_id);
}

fn finalize_error(app: &AppHandle, job_id: &str, msg: &str) {
    {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        if let Some(job) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
            job.state = JobState::Error;
            job.error = Some(msg.to_string());
            job.child_pid = None;
        }
    }
    emit_progress(app, job_id);
    emit_done(app, job_id, None);
    record_history(app, job_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, state: JobState) -> DownloadJob {
        DownloadJob {
            id: id.into(),
            rg_mbid: String::new(),
            title: String::new(),
            artist: String::new(),
            cover: None,
            state,
            track_index: 0,
            track_total: 0,
            track_title: None,
            queue_position: -1,
            failed: Vec::new(),
            album_path: None,
            error: None,
            size_bytes: None,
            dl_speed: None,
            eta_secs: None,
            save_path: None,
            track_n: None,
            watch_url: None,
            audio_path: None,
            child_pid: None,
            only_missing: false,
            cancel_requested: false,
            metadata_only: false,
            initial_status: None,
        }
    }

    // Regression guard for the shared job-queue refactor: recompute assigns 0 to
    // the active (Downloading) job and 1,2,… to Queued jobs in order, and leaves
    // terminal jobs untouched (the music-only `_ => {}` arm — a behavior anime
    // deliberately diverges from by zeroing them).
    #[test]
    fn recompute_positions_active_zero_queued_sequential() {
        let mut q = job_queue::Queue::new();
        q.jobs = vec![
            mk("a", JobState::Downloading),
            mk("b", JobState::Queued),
            mk("c", JobState::Queued),
            mk("d", JobState::Done),
        ];
        recompute_queue_positions(&mut q);
        assert_eq!(q.jobs[0].queue_position, 0);
        assert_eq!(q.jobs[1].queue_position, 1);
        assert_eq!(q.jobs[2].queue_position, 2);
        assert_eq!(q.jobs[3].queue_position, -1);
    }
}
