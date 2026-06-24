//! Anime download engine — sequential, background, survives navigation.
//!
//! Mirrors `music_download.rs`'s job-queue scaffolding but the acquisition model
//! differs: qBittorrent is asynchronous, so each job runs in two phases.
//!
//!   Phase 1 (Preparing): spawn `scripts/download_anime.py` ONCE. It enriches via
//!   Jikan, writes/patches the title card + episode table + cover, resolves a
//!   magnet via Nyaa, and queues it into qBittorrent tagged `mal-<id>`. It prints
//!   one terminal JSON object (ok / ambiguous / error) and exits — it never waits
//!   for the torrent.
//!
//!   Phase 2 (Downloading): the worker polls `qbittorrent_client.py state --tag
//!   mal-<id>` every few seconds, aggregates progress %, and marks the job Done
//!   when every torrent completes — then writes `Download Status: Complete` back
//!   to the card and emits `anime-download-done`, which the provider re-broadcasts
//!   as `video-library-changed` so the Downloaded tab re-lists.
//!
//! Events (`anime-download-progress` / `-done` / `-ambiguous`) use `app.emit` so
//! they survive navigation, exactly like the music engine.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;

use crate::commands::qbit::qbit_env;
use crate::commands::vault::{self, atomic_write};

#[cfg(unix)]
const CANCEL_GRACE_MS: u64 = 2000;
const POLL_INTERVAL_SECS: u64 = 5;
const MAX_EMPTY_POLLS: u32 = 12; // ~60s for torrents to register before giving up
const MAX_POLLS: u32 = 5000; // runaway guard (~7h at 5s)

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Preparing,
    Downloading,
    Done,
    Error,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub mal_id: i64,
    pub title: String,
    pub audio: String,
    pub image: Option<String>,
    pub airing: bool,
    pub anime_type: String,
    pub episodes_total: Option<i64>,
    pub tag: String,
    pub local_path: Option<String>,
    pub series_path: Option<String>,
    pub state: JobState,
    pub progress_pct: f64,
    pub files_done: i64,
    pub files_total: i64,
    pub queue_position: i64,
    pub error: Option<String>,
    pub size_bytes: Option<i64>,
    pub dl_speed: Option<f64>,
    pub eta_secs: Option<i64>,
    pub save_path: Option<String>,
    #[serde(skip)]
    pub child_pid: Option<u32>,
    #[serde(skip)]
    pub cancel_requested: bool,
    /// Explicit magnet chosen via the torrent picker; forwarded to
    /// download_anime.py as --download-source to skip the Nyaa auto-search.
    #[serde(skip)]
    pub download_source: Option<String>,
    /// Add-to-Library / import mode: the script writes the card + cover and
    /// skips Nyaa/qBittorrent; the job finalizes Done at the terminal JSON (no
    /// Phase 2). Serialized so the UI can label these jobs "Adding to library".
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

/// Resolve the download script: bundled resource first, dev fallback to source.
fn resolve_script(app: &AppHandle) -> Option<String> {
    use tauri::Manager;
    if let Ok(p) = app
        .path()
        .resolve("scripts/download_anime.py", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    if let Some(home) = dirs::home_dir() {
        let dev = home.join("Code/iskariel/src-tauri/scripts/download_anime.py");
        if dev.exists() {
            return Some(dev.to_string_lossy().into_owned());
        }
    }
    None
}

fn recompute_queue_positions(state: &mut DownloadState) {
    let mut pos = 1;
    for j in state.jobs.iter_mut() {
        match j.state {
            JobState::Queued => {
                j.queue_position = pos;
                pos += 1;
            }
            _ => j.queue_position = 0,
        }
    }
}

fn snapshot(job_id: &str) -> Option<DownloadJob> {
    let g = DOWNLOAD_STATE.lock().unwrap();
    g.jobs.iter().find(|j| j.id == job_id).cloned()
}

fn emit_progress(app: &AppHandle, job_id: &str) {
    if let Some(job) = snapshot(job_id) {
        let _ = app.emit("anime-download-progress", &job);
    }
}

fn emit_done(app: &AppHandle, job_id: &str, series_path: Option<String>) {
    let _ = app.emit(
        "anime-download-done",
        serde_json::json!({ "jobId": job_id, "seriesPath": series_path }),
    );
}

#[tauri::command]
pub async fn anime_download_enqueue(
    app: AppHandle,
    mal_id: i64,
    title: String,
    audio: Option<String>,
    image: Option<String>,
    airing: Option<bool>,
    anime_type: Option<String>,
    episodes: Option<i64>,
    download_source: Option<String>,
    metadata_only: Option<bool>,
    initial_status: Option<String>,
) -> Result<String, String> {
    if mal_id <= 0 {
        return Err("valid MAL ID required".into());
    }
    let id = format!("adl{}", JOB_SEQ.fetch_add(1, Ordering::Relaxed));
    log::info!("[anime_download] enqueue mal-{mal_id} job {id}");
    let should_start = {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        guard.jobs.push(DownloadJob {
            id: id.clone(),
            mal_id,
            title,
            audio: audio.unwrap_or_else(|| "sub".into()),
            image,
            airing: airing.unwrap_or(false),
            anime_type: anime_type.unwrap_or_else(|| "TV".into()),
            episodes_total: episodes,
            tag: format!("mal-{mal_id}"),
            local_path: None,
            series_path: None,
            state: JobState::Queued,
            progress_pct: 0.0,
            files_done: 0,
            files_total: 0,
            queue_position: 0,
            error: None,
            size_bytes: None,
            dl_speed: None,
            eta_secs: None,
            save_path: None,
            child_pid: None,
            cancel_requested: false,
            download_source,
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
pub fn anime_download_status() -> Vec<DownloadJob> {
    let g = DOWNLOAD_STATE.lock().unwrap();
    g.jobs.clone()
}

#[tauri::command]
pub fn anime_download_cancel(job_id: String) -> Result<(), String> {
    let mut guard = DOWNLOAD_STATE.lock().unwrap();
    match guard.jobs.iter().find(|j| j.id == job_id).map(|j| j.state.clone()) {
        None => return Err("no such job".into()),
        Some(JobState::Done | JobState::Error | JobState::Cancelled) => {
            return Err("job is not cancellable".into())
        }
        _ => {}
    }
    cancel_job_inner(&mut guard, &job_id);
    Ok(())
}

/// Cancel a job in place: Queued → Cancelled; Preparing/Downloading → request
/// cancel + SIGTERM (then SIGKILL after a grace period) the prepare child.
/// Lenient — a no-op if the job is missing or already terminal — so
/// `anime_uninstall` can reuse it without pre-checking state.
fn cancel_job_inner(guard: &mut DownloadState, job_id: &str) {
    let pid = {
        let Some(job) = guard.jobs.iter_mut().find(|j| j.id == job_id) else {
            return;
        };
        match job.state {
            JobState::Queued => {
                job.state = JobState::Cancelled;
                None
            }
            JobState::Preparing | JobState::Downloading => {
                job.cancel_requested = true;
                job.child_pid
            }
            _ => return,
        }
    };
    recompute_queue_positions(guard);
    // Kill the prepare child if one is running; the poll loop checks
    // `cancel_requested` at its top, so a Downloading job stops on next tick.
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
}

/// Read-only torrent search for the picker: run `nyaa_search.py --list` and hand
/// the ranked candidate list back to the UI. No side effects (no card, no qBit) —
/// the user picks a magnet, which then rides `anime_download_enqueue(downloadSource)`.
#[tauri::command]
pub async fn anime_torrent_search(
    title: String,
    english_title: Option<String>,
    anime_type: Option<String>,
    audio: Option<String>,
) -> Result<serde_json::Value, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("title required".into());
    }
    let script = PathBuf::from(vault::vault_root()).join("Infrastructure/Scripts/nyaa_search.py");
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script)
        .arg("--title").arg(&title)
        .arg("--english-title").arg(english_title.unwrap_or_default())
        .arg("--type").arg(anime_type.unwrap_or_else(|| "TV".into()))
        .arg("--audio").arg(audio.unwrap_or_else(|| "sub".into()))
        .arg("--list")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn nyaa_search.py: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(v) if v.get("candidates").is_some() => Ok(v),
        Ok(v) => Ok(serde_json::json!({
            "candidates": [],
            "error": v.get("error").and_then(|x| x.as_str()).unwrap_or("no_results"),
        })),
        Err(_) => Ok(serde_json::json!({ "candidates": [], "error": "no_results" })),
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    pub ok: bool,
    pub removed_torrents: usize,
    pub deleted_files: bool,
    pub removed_rss: bool,
    pub card_deleted: bool,
    pub warnings: Vec<String>,
}

/// Run qbittorrent_client.py with the app's QBIT_* env. `Ok(Value)` is the parsed
/// stdout JSON; `Err` carries a reachability/auth failure — used to BLOCK uninstall
/// before anything is deleted so torrents are never stranded.
async fn qbit_run(app: &AppHandle, args: &[&str]) -> Result<serde_json::Value, String> {
    let script =
        PathBuf::from(vault::vault_root()).join("Infrastructure/Scripts/qbittorrent_client.py");
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script);
    for a in args {
        cmd.arg(a);
    }
    for (k, v) in qbit_env(app) {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn qbittorrent_client.py: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|_| "qBittorrent helper returned no JSON".to_string())?;
    if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        return Err(match err {
            "auth_failed" | "network_error" => {
                "qBittorrent isn’t reachable — start it in Settings → Anime, then retry.".to_string()
            }
            other => format!("qBittorrent error: {other}"),
        });
    }
    Ok(v)
}

/// Scan sibling cards for a shared `Local Path` so uninstall never deletes a
/// folder another entry still references.
fn local_path_is_shared(ingested_dir: &Path, this_card: &Path, target: &str) -> bool {
    let want = target.trim_end_matches('/');
    let Ok(entries) = std::fs::read_dir(ingested_dir) else {
        return false;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p == this_card || p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let (meta, _) = crate::parsers::frontmatter::parse_frontmatter(&text);
        if let Some(lp) = meta.get("Local Path").and_then(|v| v.as_str()) {
            if !lp.is_empty() && lp.trim_end_matches('/') == want {
                return true;
            }
        }
    }
    false
}

/// Uninstall a library entry: cancel its job, remove its qBittorrent torrents
/// (+files when `delete_files`), drop the airing RSS rule, delete the local video
/// folder (collision- and path-guarded), the cover, and the card last. Keyed on
/// the CARD (`series_path`) so a multi-id franchise entry removes as one unit.
/// BLOCKS up front if qBittorrent is unreachable so torrents are never stranded.
#[tauri::command]
pub async fn anime_uninstall(
    app: AppHandle,
    series_path: String,
    delete_files: bool,
) -> Result<UninstallReport, String> {
    let card_abs = PathBuf::from(vault::library_vault_root()).join(&series_path);
    let text = std::fs::read_to_string(&card_abs)
        .map_err(|e| format!("can't read card {series_path}: {e}"))?;
    let (meta, _body) = crate::parsers::frontmatter::parse_frontmatter(&text);

    let local_path = meta
        .get("Local Path")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty());
    let airing = meta.get("Airing").and_then(|v| v.as_bool()).unwrap_or(false);
    let title = meta.get("Title").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // id-set = Provider ID ∪ Related IDs (franchise cards carry several).
    let mut ids: Vec<i64> = Vec::new();
    if let Some(pid) = meta.get("Provider ID").and_then(|v| v.as_i64()) {
        ids.push(pid);
    }
    if let Some(arr) = meta.get("Related IDs").and_then(|v| v.as_array()) {
        for v in arr {
            if let Some(n) = v.as_i64() {
                if !ids.contains(&n) {
                    ids.push(n);
                }
            }
        }
    }

    let mut report = UninstallReport {
        ok: false,
        removed_torrents: 0,
        deleted_files: false,
        removed_rss: false,
        card_deleted: false,
        warnings: Vec::new(),
    };

    // BLOCK before deleting anything if qBittorrent is down (per the "always clean
    // up torrents" decision). A bare `state` lists all torrents → cheap probe.
    qbit_run(&app, &["state"]).await?;

    // Stop any in-flight job for these ids before pulling its torrents.
    {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        let job_ids: Vec<String> = guard
            .jobs
            .iter()
            .filter(|j| ids.contains(&j.mal_id))
            .map(|j| j.id.clone())
            .collect();
        for jid in job_ids {
            cancel_job_inner(&mut guard, &jid);
        }
    }

    // Remove torrents (and their files when requested), per id/tag.
    for id in &ids {
        let tag = format!("mal-{id}");
        let arr = match qbit_run(&app, &["state", "--tag", &tag]).await {
            Ok(v) => v,
            Err(e) => {
                report.warnings.push(format!("torrent lookup for {tag} failed: {e}"));
                continue;
            }
        };
        let hashes: Vec<String> = arr
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|t| t.get("hash").and_then(|h| h.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if hashes.is_empty() {
            continue;
        }
        let joined = hashes.join("|");
        let mut dargs = vec!["delete", "--hashes", joined.as_str()];
        if delete_files {
            dargs.push("--delete-files");
        }
        match qbit_run(&app, &dargs).await {
            Ok(_) => report.removed_torrents += hashes.len(),
            Err(e) => report.warnings.push(format!("torrent delete for {tag} failed: {e}")),
        }
    }

    // Airing RSS rule(s).
    if airing {
        for id in &ids {
            let tag = format!("mal-{id}");
            match qbit_run(&app, &["remove-rss", "--rule-name", &tag]).await {
                Ok(_) => report.removed_rss = true,
                Err(e) => report.warnings.push(format!("RSS rule {tag} removal failed: {e}")),
            }
        }
    }

    // ── Card + cover + (optional) video → recycling bin, one restorable item ──
    // The torrents + RSS rule removed above CAN'T be restored; that's recorded as
    // the bin item's irreversible-warning. Replaces the former hard-deletes.
    let library = PathBuf::from(vault::library_vault_root());

    // Cover sidecar (stem from the card filename, matching how it was written).
    let mut sidecars: Vec<(String, PathBuf)> = Vec::new();
    if let Some(stem) = Path::new(&series_path).file_stem().and_then(|s| s.to_str()) {
        let cover_rel = format!("Anime/Assets/{stem}.jpg");
        let cover_abs = library.join(&cover_rel);
        if cover_abs.exists() {
            sidecars.push((cover_rel, cover_abs));
        }
    }

    // Video folder — only on "Delete everything", and only a safe, unshared path
    // under the library's Anime/Videos/. Otherwise it's left in place.
    let mut video_folder: Option<(String, PathBuf)> = None;
    if delete_files {
        if let Some(lp) = &local_path {
            let lp_abs = if Path::new(lp).is_absolute() {
                PathBuf::from(lp)
            } else {
                library.join(lp)
            };
            let rel = lp_abs
                .strip_prefix(&library)
                .ok()
                .map(|r| r.to_string_lossy().replace('\\', "/"));
            let ingested_dir = card_abs
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| library.join("Anime/Catalog"));
            match rel {
                Some(rel)
                    if rel.starts_with("Anime/Videos/")
                        && rel.trim_end_matches('/') != "Anime/Videos" =>
                {
                    if local_path_is_shared(&ingested_dir, &card_abs, lp) {
                        report
                            .warnings
                            .push(format!("kept files: {lp} is shared with another library entry"));
                    } else if lp_abs.is_dir() {
                        video_folder = Some((rel.trim_end_matches('/').to_string(), lp_abs));
                    } else {
                        report.deleted_files = true; // nothing on disk to bin
                    }
                }
                _ => report
                    .warnings
                    .push(format!("kept files: refusing to bin unsafe path {lp}")),
            }
        }
    }

    // Irreversible side effects (torrents / RSS) → the bin item's warning text.
    let mut ext_parts: Vec<String> = Vec::new();
    if report.removed_torrents > 0 {
        ext_parts.push(format!(
            "{} qBittorrent torrent{}",
            report.removed_torrents,
            if report.removed_torrents == 1 { "" } else { "s" }
        ));
    }
    if report.removed_rss {
        ext_parts.push("the airing RSS rule".to_string());
    }
    let external = (!ext_parts.is_empty()).then(|| {
        format!(
            "Removed {} from qBittorrent — not restorable (re-downloading needs a new torrent search).",
            ext_parts.join(" and ")
        )
    });

    let video_present = video_folder.is_some();
    match crate::commands::recycle_bin::trash_anime(
        &app,
        Some("library".into()),
        &series_path,
        &card_abs,
        &sidecars,
        video_folder,
        external,
    ) {
        Ok(()) => {
            report.card_deleted = true;
            if video_present {
                report.deleted_files = true;
            }
        }
        Err(e) => report
            .warnings
            .push(format!("recycling-bin capture failed: {e:?}")),
    }
    report.ok = report.card_deleted;
    log::info!(
        "[anime_uninstall] {title:?} ({} ids) torrents={} files={} rss={} card={} warns={}",
        ids.len(),
        report.removed_torrents,
        report.deleted_files,
        report.removed_rss,
        report.card_deleted,
        report.warnings.len()
    );
    Ok(report)
}

async fn run_worker(app: AppHandle) {
    loop {
        let job_id = {
            let mut guard = DOWNLOAD_STATE.lock().unwrap();
            match guard.jobs.iter().position(|j| matches!(j.state, JobState::Queued)) {
                Some(idx) => {
                    guard.jobs[idx].state = JobState::Preparing;
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

/// Fields the prepare phase needs.
#[allow(clippy::type_complexity)]
fn job_prep_args(
    job_id: &str,
) -> Option<(i64, String, bool, String, Option<String>, bool, Option<String>)> {
    let g = DOWNLOAD_STATE.lock().unwrap();
    g.jobs.iter().find(|j| j.id == job_id).map(|j| {
        (
            j.mal_id,
            j.audio.clone(),
            j.airing,
            j.anime_type.clone(),
            j.download_source.clone(),
            j.metadata_only,
            j.initial_status.clone(),
        )
    })
}

async fn process_job(app: &AppHandle, job_id: &str) {
    let Some((mal_id, audio, airing, anime_type, download_source, metadata_only, initial_status)) =
        job_prep_args(job_id)
    else {
        return;
    };
    let Some(script) = resolve_script(app) else {
        finalize_error(app, job_id, "download script not found (scripts/download_anime.py)");
        return;
    };
    let vault = vault::vault_root();
    // Card + cover now live in the writable Library vault (Library Migration
    // Phase 2); --vault stays content so the script finds Infrastructure/Scripts/
    // (nyaa_search.py, qbittorrent_client.py), --library is the catalog base.
    let library = vault::library_vault_root();

    // ── Phase 1 — Prepare (one-shot script → terminal JSON) ──────────────────
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script)
        .arg("--mal-id").arg(mal_id.to_string())
        .arg("--vault").arg(&vault)
        .arg("--library").arg(&library)
        .arg("--save-root").arg(Path::new(&library).join("Anime").join("Videos"))
        .arg("--audio").arg(&audio)
        .arg("--type").arg(&anime_type);
    if airing {
        cmd.arg("--airing");
    }
    if metadata_only {
        cmd.arg("--metadata-only");
        cmd.arg("--status")
            .arg(initial_status.as_deref().unwrap_or("Plan-to-Watch"));
    }
    // Picker-chosen magnet → download_anime.py skips its Nyaa auto-search.
    if let Some(src) = download_source.as_deref().filter(|s| s.starts_with("magnet:")) {
        cmd.arg("--download-source").arg(src);
    }
    for (k, v) in qbit_env(app) {
        cmd.env(k, v);
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

    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut stdout).await;
    }
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr).await;
    }
    let _ = child.wait().await;
    {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        if let Some(j) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
            j.child_pid = None;
        }
    }

    if was_cancelled(job_id) {
        finalize_simple(app, job_id, JobState::Cancelled, None);
        return;
    }

    // Parse the last JSON line the script printed.
    let parsed = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok());
    let Some(result) = parsed else {
        let tail = stderr.lines().last().unwrap_or("").trim();
        finalize_error(
            app,
            job_id,
            if tail.is_empty() { "download script produced no result" } else { tail },
        );
        return;
    };

    // The script writes the title card before it resolves a magnet and reports
    // the card path even on failure — record it now so finalize_error can mark
    // the card Failed instead of leaving it stuck at Queued.
    if let Some(sp) = result.get("seriesPath").and_then(|x| x.as_str()) {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        if let Some(j) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
            j.series_path = Some(sp.to_string());
        }
    }

    if result.get("ambiguous").and_then(|x| x.as_bool()) == Some(true) {
        let candidates = result.get("candidates").cloned().unwrap_or(serde_json::json!([]));
        let _ = app.emit(
            "anime-download-ambiguous",
            serde_json::json!({ "jobId": job_id, "candidates": candidates }),
        );
        finalize_error(
            app,
            job_id,
            "Multiple torrents matched — press Retry and pick a source.",
        );
        return;
    }
    if let Some(code) = result.get("error").and_then(|x| x.as_str()) {
        let detail = result.get("detail").and_then(|x| x.as_str()).unwrap_or("");
        let msg = match code {
            "auth_failed" => "qBittorrent authentication failed — check Settings.".to_string(),
            "no_results" => format!("No torrent found. {detail}"),
            "jikan_failed" => format!("MyAnimeList lookup failed: {detail}"),
            "jikan_no_data" => format!("MyAnimeList has no entry for {detail}."),
            _ => format!("{code}: {detail}"),
        };
        finalize_error(app, job_id, &msg);
        return;
    }

    // Metadata-only add: the card (+ cover) IS the job — finalize Done at the
    // terminal JSON; there is no torrent to poll.
    if result.get("metadataOnly").and_then(|x| x.as_bool()) == Some(true) {
        let sp = result.get("seriesPath").and_then(|x| x.as_str()).map(String::from);
        finalize_simple(app, job_id, JobState::Done, sp);
        return;
    }

    // ok — record what the script resolved, transition to Downloading.
    let (tag, series_path, local_path) = {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        let Some(j) = guard.jobs.iter_mut().find(|j| j.id == job_id) else {
            return;
        };
        j.state = JobState::Downloading;
        j.local_path = result.get("savePath").and_then(|x| x.as_str()).map(String::from);
        j.series_path = result.get("seriesPath").and_then(|x| x.as_str()).map(String::from);
        if let Some(fe) = result.get("filesExpected").and_then(|x| x.as_i64()) {
            j.files_total = fe;
        }
        (j.tag.clone(), j.series_path.clone(), j.local_path.clone())
    };
    emit_progress(app, job_id);

    // ── Phase 2 — Poll qBittorrent until every tagged torrent completes ──────
    let mut empty_polls = 0u32;
    let mut polls = 0u32;
    loop {
        if was_cancelled(job_id) {
            finalize_simple(app, job_id, JobState::Cancelled, series_path.clone());
            return;
        }
        match poll_state(app, &tag).await {
            Err(e) => {
                finalize_error(app, job_id, &e);
                return;
            }
            Ok(torrents) => {
                if torrents.is_empty() {
                    empty_polls += 1;
                    if empty_polls >= MAX_EMPTY_POLLS {
                        finalize_error(app, job_id, "no torrents registered for this title in qBittorrent");
                        return;
                    }
                } else {
                    empty_polls = 0;
                    let total_size: f64 = torrents.iter().map(|t| t.size).sum();
                    let pct = if total_size > 0.0 {
                        torrents.iter().map(|t| t.progress * t.size).sum::<f64>() / total_size * 100.0
                    } else {
                        torrents.iter().map(|t| t.progress).sum::<f64>() / torrents.len() as f64 * 100.0
                    };
                    let done_count = torrents.iter().filter(|t| t.progress >= 0.999).count() as i64;
                    let all_done = done_count as usize == torrents.len();
                    // Aggregate live metrics: total size, summed speed, slowest
                    // finite ETA (8_640_000 = qBittorrent's ∞ sentinel).
                    let dl_speed: f64 = torrents.iter().map(|t| t.dlspeed).sum();
                    let eta_secs = torrents.iter()
                        .map(|t| t.eta)
                        .filter(|&e| e >= 0 && e < 8_640_000)
                        .max();
                    let save_path = torrents.iter().find_map(|t| t.save_path.clone());
                    {
                        let mut guard = DOWNLOAD_STATE.lock().unwrap();
                        if let Some(j) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
                            j.progress_pct = pct;
                            j.files_done = done_count;
                            j.files_total = torrents.len() as i64;
                            j.size_bytes = Some(total_size as i64);
                            j.dl_speed = Some(dl_speed);
                            j.eta_secs = eta_secs;
                            if j.save_path.is_none() {
                                j.save_path = save_path;
                            }
                        }
                    }
                    emit_progress(app, job_id);
                    if all_done {
                        if let Some(lp) = &local_path {
                            cleanup_download_extras(lp);
                        }
                        if let Some(rel) = &series_path {
                            set_download_status(rel, "Complete");
                        }
                        finalize_simple(app, job_id, JobState::Done, series_path.clone());
                        return;
                    }
                }
            }
        }
        polls += 1;
        if polls >= MAX_POLLS {
            finalize_error(app, job_id, "download timed out (still incomplete after the poll cap)");
            return;
        }
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
    }
}

/// Remove worthless extras folders (creditless NC/NCOP/NCED, menus, scans,
/// samples, previews) left inside a finished download — they waste space and
/// would otherwise be scanned for episodes. Conservative: only these exact
/// names, and never Specials/Extras/Bonus (possible real content). Direct
/// children only — qBittorrent writes flat with contentLayout=NoSubfolder.
fn cleanup_download_extras(local_path: &str) {
    let Ok(entries) = std::fs::read_dir(local_path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let lname = name.to_string_lossy().trim().to_ascii_lowercase();
        let junk = matches!(
            lname.as_str(),
            "nc" | "ncs" | "ncop" | "nced" | "creditless"
                | "menu" | "menus" | "scan" | "scans"
                | "sample" | "samples" | "preview" | "previews"
        );
        if junk {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn was_cancelled(job_id: &str) -> bool {
    let g = DOWNLOAD_STATE.lock().unwrap();
    g.jobs.iter().find(|j| j.id == job_id).map(|j| j.cancel_requested).unwrap_or(false)
}

/// One torrent's live stats from a qBittorrent poll.
struct TorrentStat {
    progress: f64,
    size: f64,
    dlspeed: f64,
    eta: i64,
    save_path: Option<String>,
}

/// Poll qBittorrent for the tag. Returns per-torrent (progress 0..1, size, dl
/// speed, eta secs, save_path). `Err` carries a fatal condition (auth / spawn);
/// an empty `Ok` means "no torrents yet" (magnet still resolving).
async fn poll_state(app: &AppHandle, tag: &str) -> Result<Vec<TorrentStat>, String> {
    let script = PathBuf::from(vault::vault_root())
        .join("Infrastructure/Scripts/qbittorrent_client.py");
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(script)
        .arg("state")
        .arg("--tag")
        .arg(tag)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in qbit_env(app) {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("poll spawn failed: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = match serde_json::from_str(text.trim()) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()), // transient garbage → treat as no data yet
    };
    if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        if err == "auth_failed" {
            return Err("qBittorrent authentication failed — check Settings.".into());
        }
        return Ok(Vec::new());
    }
    let Some(arr) = v.as_array() else {
        return Ok(Vec::new());
    };
    Ok(arr
        .iter()
        .map(|t| TorrentStat {
            progress: t.get("progress").and_then(|x| x.as_f64()).unwrap_or(0.0),
            size: t.get("size").and_then(|x| x.as_f64()).unwrap_or(0.0),
            dlspeed: t.get("dlspeed").and_then(|x| x.as_f64()).unwrap_or(0.0),
            eta: t.get("eta").and_then(|x| x.as_i64()).unwrap_or(0),
            save_path: t.get("save_path").and_then(|x| x.as_str()).map(String::from),
        })
        .collect())
}

/// Rewrite the card's `Download Status:` line (field-level; never touches
/// Status / Personal Rating / Watched Episodes). `Complete` on success,
/// `Failed` when the job errors so a dead card never lingers at `Queued`.
fn set_download_status(series_rel: &str, status: &str) {
    let abs = PathBuf::from(vault::library_vault_root()).join(series_rel);
    let Ok(text) = std::fs::read_to_string(&abs) else {
        return;
    };
    let mut replaced = false;
    let mut lines: Vec<String> = Vec::new();
    for l in text.lines() {
        if !replaced && l.starts_with("Download Status:") {
            lines.push(format!("Download Status: {status}"));
            replaced = true;
        } else {
            lines.push(l.to_string());
        }
    }
    if !replaced {
        return;
    }
    let mut new = lines.join("\n");
    if text.ends_with('\n') {
        new.push('\n');
    }
    let _ = atomic_write(&abs, new.as_bytes());
}

/// Persist a terminal job into the shared downloads history (best-effort). Reads
/// the in-process job clone so the `#[serde(skip)]` `download_source` retry arg
/// is captured even though it never reaches JS via the live job.
fn record_history(app: &AppHandle, job_id: &str) {
    let Some(j) = snapshot(job_id) else { return };
    let state = match j.state {
        JobState::Done => "done",
        JobState::Error => "error",
        JobState::Cancelled => "cancelled",
        _ => return,
    };
    let args = serde_json::json!({
        "kind": "video",
        "malId": j.mal_id,
        "title": j.title,
        "audio": j.audio,
        "image": j.image,
        "airing": j.airing,
        "animeType": j.anime_type,
        "episodes": j.episodes_total,
        "downloadSource": j.download_source,
        "metadataOnly": j.metadata_only,
        "initialStatus": j.initial_status,
    });
    crate::commands::downloads_history::record(
        app,
        crate::commands::downloads_history::HistoryRecord {
            id: j.id.clone(),
            source: "video".into(),
            title: j.title.clone(),
            subtitle: if j.metadata_only {
                "Added to library".into()
            } else {
                format!("{} · {}", j.anime_type, j.audio)
            },
            state: state.into(),
            cover: j.image.clone(),
            finished_at: crate::commands::downloads_history::now_ms(),
            open_path: j.series_path.clone(),
            reveal_path: j.local_path.clone(),
            size_bytes: j.size_bytes,
            save_path: j.save_path.clone().or_else(|| j.local_path.clone()),
            failed_count: 0,
            error: j.error.clone(),
            args,
        },
    );
}

fn finalize_simple(app: &AppHandle, job_id: &str, state: JobState, series_path: Option<String>) {
    let is_done = state == JobState::Done;
    {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        if let Some(job) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
            job.child_pid = None;
            if is_done {
                job.progress_pct = 100.0;
            }
            job.state = state;
        }
    }
    if is_done {
        log::info!("[anime_download] job {job_id} complete");
    }
    emit_progress(app, job_id);
    emit_done(app, job_id, series_path);
    record_history(app, job_id);
}

fn finalize_error(app: &AppHandle, job_id: &str, msg: &str) {
    log::warn!("[anime_download] job {job_id} failed: {msg}");
    let series_path = {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        match guard.jobs.iter_mut().find(|j| j.id == job_id) {
            Some(job) => {
                job.state = JobState::Error;
                job.error = Some(msg.to_string());
                job.child_pid = None;
                job.series_path.clone()
            }
            None => None,
        }
    };
    // Mark a written card Failed so its badge stops lying about "Queued".
    if let Some(rel) = series_path {
        set_download_status(&rel, "Failed");
    }
    emit_progress(app, job_id);
    emit_done(app, job_id, None);
    record_history(app, job_id);
}
