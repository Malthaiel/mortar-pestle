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
#[cfg(unix)]
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

#[cfg(unix)]
const CANCEL_GRACE_MS: u64 = 2000;

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

struct DownloadState {
    jobs: Vec<DownloadJob>,
    worker_running: bool,
}

static DOWNLOAD_STATE: Mutex<DownloadState> = Mutex::new(DownloadState {
    jobs: Vec::new(),
    worker_running: false,
});
static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

#[cfg(unix)]
fn send_signal(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

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
fn recompute_queue_positions(state: &mut DownloadState) {
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
    let g = DOWNLOAD_STATE.lock().unwrap();
    g.jobs.iter().find(|j| j.id == job_id).cloned()
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
) -> Result<String, String> {
    if rg_mbid.trim().is_empty() {
        return Err("release-group MBID required".into());
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
    let g = DOWNLOAD_STATE.lock().unwrap();
    g.jobs.clone()
}

#[tauri::command]
pub fn music_download_cancel(job_id: String) -> Result<(), String> {
    let pid = {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        let Some(job) = guard.jobs.iter_mut().find(|j| j.id == job_id) else {
            return Err("no such job".into());
        };
        match job.state {
            JobState::Queued => {
                job.state = JobState::Cancelled;
                recompute_queue_positions(&mut guard);
                None
            }
            JobState::Downloading => {
                job.cancel_requested = true;
                job.child_pid
            }
            _ => return Err("job is not cancellable".into()),
        }
    };
    // Active job: SIGTERM the python child, SIGKILL after a grace period. The
    // in-flight yt-dlp child may finish its current track before exiting; no new
    // tracks start. finalize_job marks the job Cancelled when python exits.
    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            send_signal(pid, libc::SIGTERM);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(CANCEL_GRACE_MS)).await;
                send_signal(pid, libc::SIGKILL);
            });
        }
        #[cfg(not(unix))]
        crate::commands::proc_util::terminate_pid(pid);
    }
    Ok(())
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
    let (rg_mbid, only_missing, metadata_only, initial_status) = {
        let guard = DOWNLOAD_STATE.lock().unwrap();
        match guard.jobs.iter().find(|j| j.id == job_id) {
            Some(j) => (
                j.rg_mbid.clone(),
                j.only_missing,
                j.metadata_only,
                j.initial_status.clone(),
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
    cmd.arg(&script)
        .arg("--rg-mbid")
        .arg(&rg_mbid)
        .arg("--vault")
        .arg(&vault);
    if only_missing {
        cmd.arg("--only-missing");
    }
    if metadata_only {
        cmd.arg("--metadata-only");
        cmd.arg("--status")
            .arg(initial_status.as_deref().unwrap_or("Plan-to-Listen"));
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
