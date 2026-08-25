//! Anime download engine — sequential, background, survives navigation.
//!
//! Mirrors `music_download.rs`'s job-queue scaffolding but the acquisition model
//! differs: torrents are asynchronous, so each job runs in two phases.
//!
//!   Phase 1 (Preparing): spawn `scripts/download_anime.py` ONCE. It enriches via
//!   Jikan, writes/patches the title card + episode table + cover, resolves a
//!   magnet via Nyaa, and RETURNS that magnet. It prints one terminal JSON object
//!   (ok / ambiguous / error) and exits — it never waits for the torrent. This
//!   worker then hands the magnet to the built-in engine (`commands/torrent.rs`).
//!
//!   Phase 2 (Downloading): the worker polls the engine for that torrent's id
//!   every few seconds, aggregates progress %, and marks the job Done
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

use crate::commands::job_queue;
use crate::commands::qbit::qbit_env;
use crate::commands::vault::{self, atomic_write};

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
    /// Still the RSS rule name (`mal-<id>`) qBittorrent registers for airing
    /// series. It is NOT how torrents are found any more — the built-in engine
    /// has no tags; see `torrent_id`.
    pub tag: String,
    /// The built-in engine's id for this job's torrent, set once the magnet is
    /// added. Phase 2 polls on it.
    ///
    /// ponytail: one id, because one job resolves exactly one magnet (a batch
    /// pack counts as one torrent). SF3's RSS poller adds later episodes
    /// independently, so make this a Vec only when a job really owns several.
    #[serde(skip)]
    pub torrent_id: Option<usize>,
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

static DOWNLOAD_STATE: Mutex<job_queue::Queue<DownloadJob>> = Mutex::new(job_queue::Queue::new());
static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

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
        let dev = home.join("Code/mortar-pestle/src-tauri/scripts/download_anime.py");
        if dev.exists() {
            return Some(dev.to_string_lossy().into_owned());
        }
    }
    None
}

fn recompute_queue_positions(state: &mut job_queue::Queue<DownloadJob>) {
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
    job_queue::snapshot(&DOWNLOAD_STATE, |j| j.id == job_id)
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
            torrent_id: None,
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
    job_queue::status(&DOWNLOAD_STATE)
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
fn cancel_job_inner(guard: &mut job_queue::Queue<DownloadJob>, job_id: &str) {
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
        job_queue::kill_child_graceful(pid);
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
    let script = vault::script_path("nyaa_search.py");
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
/// stdout JSON.
///
/// ponytail: only `remove-rss` still needs this — airing series keep using
/// qBittorrent's RSS rule engine until SF3 replaces it with a Rust poller.
/// Deleting this function is SF4's job, not this one's.
async fn qbit_run(app: &AppHandle, args: &[&str]) -> Result<serde_json::Value, String> {
    let script = vault::script_path("qbittorrent_client.py");
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

/// Uninstall a library entry: cancel its job, remove its torrents from the
/// built-in engine (+files when `delete_files`), drop the airing RSS rule,
/// delete the local video folder (collision- and path-guarded), the cover, and
/// the card last. Keyed on the CARD (`series_path`) so a multi-id franchise
/// entry removes as one unit.
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

    // No reachability probe any more: the engine is in-process, so there is no
    // "is it up" question to answer before deleting anything.

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

    // Remove torrents (and their files when requested). The built-in engine has
    // no tags, so a series' torrents are the ones writing into its folder.
    // Nothing is persisted across restarts, so this finds nothing after one —
    // correct, since a finished torrent was already paused and holds nothing.
    if let Some(lp) = &local_path {
        // `Local Path` on the card is stored RELATIVE to the library root, while
        // the engine records an absolute output folder — comparing them raw finds
        // nothing and silently strands the torrents. Resolved the same way the
        // video-folder deletion below does.
        let lp_abs = if Path::new(lp).is_absolute() {
            PathBuf::from(lp)
        } else {
            PathBuf::from(vault::library_vault_root()).join(lp)
        };
        match crate::commands::torrent::delete_under(&app, &lp_abs, delete_files).await {
            Ok(n) => report.removed_torrents += n,
            Err(e) => report.warnings.push(format!("torrent removal failed: {e}")),
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

    // (see `video_bin_key` below for the safety rule)
    // Video folder — only on "Delete everything", and only a safe, unshared path
    // that is a STRICT descendant of the effective video root (never the root
    // itself). The root is the user's configured folder when set, else the
    // library's Anime/Videos — so a custom root on another drive deletes just
    // like the default one. The recorded key stays library-relative when the
    // folder is inside the library (unchanged tombstone shape for every
    // pre-existing bin item); a custom root outside it records the absolute
    // path, which `recycle_bin::resolve_folder_target` restores verbatim.
    let mut video_folder: Option<(String, PathBuf)> = None;
    if delete_files {
        if let Some(lp) = &local_path {
            let lp_abs = if Path::new(lp).is_absolute() {
                PathBuf::from(lp)
            } else {
                library.join(lp)
            };
            let video_root = crate::commands::video_config::anime_video_root(
                &app,
                &library.to_string_lossy(),
            );
            let ingested_dir = card_abs
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| library.join("Anime/Catalog"));
            if let Some(key) = video_bin_key(&lp_abs, &video_root, &library) {
                if local_path_is_shared(&ingested_dir, &card_abs, lp) {
                    report
                        .warnings
                        .push(format!("kept files: {lp} is shared with another library entry"));
                } else if lp_abs.is_dir() {
                    video_folder = Some((key, lp_abs));
                } else {
                    report.deleted_files = true; // nothing on disk to bin
                }
            } else {
                report
                    .warnings
                    .push(format!("kept files: refusing to bin unsafe path {lp}"));
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
    // Card + cover now live in the writable Library vault (Library Migration
    // Phase 2); --vault must be the CONTENT vault so the script finds
    // Infrastructure/Scripts/ (nyaa_search.py, qbittorrent_client.py) — not the
    // active vault, which is whatever the user has open. --library is the
    // catalog base.
    let vault = vault::content_vault_root();
    let library = vault::library_vault_root();
    let save_root = crate::commands::video_config::anime_video_root(app, &library);

    // A configured video root on an unplugged/renamed drive must BLOCK, never
    // silently fall back to the library default — the files would land somewhere
    // the user didn't choose. `create_dir_all` doubles as the writability probe
    // (it's a no-op when the folder already exists).
    if !metadata_only {
        if let Err(e) = std::fs::create_dir_all(&save_root) {
            log::warn!("[anime_download] video root unavailable {save_root:?}: {e}");
            finalize_error(
                app,
                job_id,
                "Your anime video folder isn't available — reconnect the drive or change it in Settings → Library → Anime.",
            );
            return;
        }
    }

    // ── Phase 1 — Prepare (one-shot script → terminal JSON) ──────────────────
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script)
        .arg("--mal-id").arg(mal_id.to_string())
        .arg("--vault").arg(&vault)
        .arg("--library").arg(&library)
        .arg("--save-root").arg(&save_root)
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
    let mut stderr = String::new();
    if let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) {
        let _ = tokio::join!(
            out.read_to_string(&mut stdout),
            err.read_to_string(&mut stderr),
        );
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
    let (series_path, local_path) = {
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
        (j.series_path.clone(), j.local_path.clone())
    };

    // The script resolved a magnet; the built-in engine does the add. An explicit
    // output folder makes it write flat into the series folder, which is what the
    // episode scan below expects.
    let Some(magnet) = result.get("magnet").and_then(|x| x.as_str()).map(String::from) else {
        finalize_error(app, job_id, "the download script resolved no magnet");
        return;
    };
    let added = match crate::commands::torrent::add(app, magnet, local_path.clone()).await {
        Ok(a) => a,
        Err(e) => {
            finalize_error(app, job_id, &e);
            return;
        }
    };
    {
        let mut guard = DOWNLOAD_STATE.lock().unwrap();
        if let Some(j) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
            j.torrent_id = Some(added.id);
            j.save_path = local_path.clone();
        }
    }
    let torrent_id = added.id;
    emit_progress(app, job_id);

    // ── Phase 2 — Poll the built-in engine until the torrent completes ──────
    let mut empty_polls = 0u32;
    let mut polls = 0u32;
    loop {
        if was_cancelled(job_id) {
            finalize_simple(app, job_id, JobState::Cancelled, series_path.clone());
            return;
        }
        match crate::commands::torrent::stats_for(app, &[torrent_id]).await {
            Err(e) => {
                finalize_error(app, job_id, &e);
                return;
            }
            Ok(torrents) => {
                if torrents.is_empty() {
                    // The engine no longer knows this id — it was removed out from
                    // under us. Retried a few times before giving up.
                    empty_polls += 1;
                    if empty_polls >= MAX_EMPTY_POLLS {
                        finalize_error(app, job_id, "the torrent for this title is no longer in the engine");
                        return;
                    }
                } else {
                    empty_polls = 0;
                    if let Some(err) = torrents.iter().find_map(|t| t.error.clone()) {
                        finalize_error(app, job_id, &err);
                        return;
                    }
                    let total_size: f64 = torrents.iter().map(|t| t.size as f64).sum();
                    let pct = if total_size > 0.0 {
                        torrents.iter().map(|t| t.progress * t.size as f64).sum::<f64>() / total_size * 100.0
                    } else {
                        // Metadata still resolving: no size to weight by.
                        0.0
                    };
                    let done_count = torrents.iter().filter(|t| t.finished).count() as i64;
                    let all_done = done_count as usize == torrents.len();
                    // Aggregate live metrics: total size, summed speed, slowest
                    // ETA the engine actually measured (None = stalled, skipped).
                    let dl_speed: f64 = torrents.iter().map(|t| t.dlspeed as f64).sum();
                    let eta_secs = torrents.iter().filter_map(|t| t.eta).map(|e| e as i64).max();
                    {
                        let mut guard = DOWNLOAD_STATE.lock().unwrap();
                        if let Some(j) = guard.jobs.iter_mut().find(|j| j.id == job_id) {
                            j.progress_pct = pct;
                            j.files_done = done_count;
                            j.files_total = torrents.len() as i64;
                            j.size_bytes = Some(total_size as i64);
                            j.dl_speed = Some(dl_speed);
                            j.eta_secs = eta_secs;
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
/// children only — an explicit output folder makes the engine write flat.
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

/// Rewrite the card's `Download Status:` line (field-level; never touches
/// Status / Personal Rating / Watched Episodes). `Complete` on success,
/// `Failed` when the job errors so a dead card never lingers at `Queued`.
fn set_download_status(series_rel: &str, status: &str) {
    set_card_field(series_rel, "Download Status", status);
}

/// Field-level rewrite of one `Key: value` frontmatter line on a series card.
/// Rewrites nothing when the key is absent — a card that never had the field
/// keeps its exact shape rather than growing one.
fn set_card_field(series_rel: &str, key: &str, value: &str) -> bool {
    let abs = PathBuf::from(vault::library_vault_root()).join(series_rel);
    let Ok(text) = std::fs::read_to_string(&abs) else {
        return false;
    };
    let prefix = format!("{key}:");
    let mut replaced = false;
    let mut lines: Vec<String> = Vec::new();
    for l in text.lines() {
        if !replaced && l.starts_with(&prefix) {
            lines.push(format!("{key}: {value}"));
            replaced = true;
        } else {
            lines.push(l.to_string());
        }
    }
    if !replaced {
        return false;
    }
    let mut new = lines.join("\n");
    if text.ends_with('\n') {
        new.push('\n');
    }
    if let Err(e) = atomic_write(&abs, new.as_bytes()) {
        log::warn!("set_card_field: failed to write {}: {e:?}", abs.display());
        return false;
    }
    true
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

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    pub moved: u32,
    pub skipped: u32,
    pub failed: u32,
    pub warnings: Vec<String>,
}

/// Card `Local Path` value in the same convention `download_anime.py` writes:
/// library-relative while the folder is inside the library, absolute otherwise,
/// and **double-quoted** like its `yaml_scalar()` — an unquoted Windows path is
/// a YAML accident waiting for the first title with a `:` or a leading `[`.
fn card_local_path(abs: &Path, library: &Path) -> String {
    let s = match abs.strip_prefix(library) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => abs.to_string_lossy().into_owned(),
    };
    serde_json::to_string(&s).unwrap_or_else(|_| format!("\"{s}\""))
}

/// Move every COMPLETED series' video folder into the current video root.
///
/// Copy → verify (file count + total bytes) → delete the original, per series,
/// so a crash mid-move never loses data: the worst case is a duplicate the next
/// run skips as "already there". Still-downloading series are left alone, as are
/// folders shared by two cards and any destination that already exists.
///
/// Completion is read from the card's `Download Status`, not from qBittorrent —
/// the same source the download engine writes at `progress >= 0.999`, and it
/// works with qBittorrent closed.
#[tauri::command]
pub async fn anime_move_videos(app: AppHandle) -> Result<MoveReport, String> {
    let library = PathBuf::from(vault::library_vault_root());
    let new_root = crate::commands::video_config::anime_video_root(&app, &library.to_string_lossy());
    std::fs::create_dir_all(&new_root).map_err(|_| {
        "Your anime video folder isn't available — reconnect the drive or change it in Settings → Library → Anime."
            .to_string()
    })?;

    let series = crate::parsers::series::list_series().map_err(|e| format!("{e:?}"))?;

    // A folder referenced by two cards is shared — never move it out from under
    // the other one. Counting the resolved paths beats string-comparing raw card
    // values: it also catches a relative and an absolute pointing at one folder.
    let mut refs: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for s in &series {
        if let Some(lp) = &s.local_path {
            *refs.entry(lp.trim_end_matches('/').to_string()).or_insert(0) += 1;
        }
    }

    let mut report = MoveReport::default();
    let total = series.len();
    for (i, s) in series.iter().enumerate() {
        let _ = app.emit(
            "anime-move-progress",
            serde_json::json!({ "index": i, "total": total, "currentTitle": s.title }),
        );
        let Some(lp) = &s.local_path else { continue };
        let src = PathBuf::from(lp);
        if !src.is_dir() {
            continue;
        }
        // Already in the right place (or nested under it) — nothing to do.
        if src.starts_with(&new_root) {
            continue;
        }
        if s.download_status.as_deref() != Some("Complete") {
            report.skipped += 1;
            report.warnings.push(format!("{}: still downloading", s.title));
            continue;
        }
        if refs.get(lp.trim_end_matches('/')).copied().unwrap_or(0) > 1 {
            report.skipped += 1;
            report
                .warnings
                .push(format!("{}: folder is shared with another library entry", s.title));
            continue;
        }
        let Some(leaf) = src.file_name() else { continue };
        let dst = new_root.join(leaf);
        if dst.exists() {
            report.skipped += 1;
            report
                .warnings
                .push(format!("{}: a folder of that name is already there", s.title));
            continue;
        }

        let (want_count, want_bytes) = crate::commands::recycle_bin::dir_stats(&src);
        if let Err(e) = crate::commands::recycle_bin::copy_dir_recursive(&src, &dst) {
            let _ = std::fs::remove_dir_all(&dst);
            report.failed += 1;
            report.warnings.push(format!("{}: copy failed ({e:?})", s.title));
            continue;
        }
        let (got_count, got_bytes) = crate::commands::recycle_bin::dir_stats(&dst);
        if (got_count, got_bytes) != (want_count, want_bytes) {
            let _ = std::fs::remove_dir_all(&dst);
            report.failed += 1;
            report.warnings.push(format!(
                "{}: copy did not verify ({got_count} files/{got_bytes} bytes vs {want_count}/{want_bytes}) — original kept",
                s.title
            ));
            continue;
        }
        // Card first: a crash between here and the delete leaves the card pointing
        // at the new copy, which is the one that survives.
        set_card_field(&s.path, "Local Path", &card_local_path(&dst, &library));
        if let Err(e) = std::fs::remove_dir_all(&src) {
            report
                .warnings
                .push(format!("{}: moved, but the old folder could not be removed ({e})", s.title));
        }
        report.moved += 1;
    }
    let _ = app.emit("anime-move-progress", serde_json::json!({ "index": total, "total": total }));
    log::info!(
        "[anime_move_videos] moved={} skipped={} failed={}",
        report.moved, report.skipped, report.failed
    );
    Ok(report)
}

/// Decide whether a series' video folder may be binned, and under what key.
///
/// Returns `None` — meaning "refuse to bin, leave the files alone" — unless
/// `lp_abs` is a **strict descendant** of the effective video root (the user's
/// configured folder, else `<library>/Anime/Videos`). The root itself never
/// qualifies: binning it would swallow every series at once.
///
/// The key is what the recycling-bin tombstone records for restore. It stays
/// library-relative while the folder is inside the library (identical to the
/// pre-custom-folder behaviour, so old bin items keep restoring), and is the
/// absolute path otherwise — `recycle_bin::resolve_folder_target` accepts both.
fn video_bin_key(lp_abs: &Path, video_root: &Path, library: &Path) -> Option<String> {
    let rest = lp_abs.strip_prefix(video_root).ok()?;
    if rest.as_os_str().is_empty() {
        return None; // the root itself
    }
    Some(match lp_abs.strip_prefix(library) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string(),
        Err(_) => lp_abs.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::{card_local_path, video_bin_key};
    use std::path::Path;

    #[test]
    fn card_local_path_matches_the_download_script_convention() {
        let lib = Path::new("/lib");
        // Inside the library → library-relative, forward slashes, quoted.
        assert_eq!(card_local_path(Path::new("/lib/Anime/Videos/Frieren"), lib), "\"Anime/Videos/Frieren\"");
        // Outside → absolute, quoted.
        assert_eq!(card_local_path(Path::new("/mnt/vids/Frieren"), lib), "\"/mnt/vids/Frieren\"");
        // A title with a colon must not end up as a bare YAML scalar.
        assert_eq!(
            card_local_path(Path::new("/mnt/vids/Steins;Gate: 0"), lib),
            "\"/mnt/vids/Steins;Gate: 0\"",
        );
    }

    #[test]
    fn default_root_keeps_library_relative_keys() {
        let lib = Path::new("/lib");
        let root = Path::new("/lib/Anime/Videos");
        assert_eq!(
            video_bin_key(Path::new("/lib/Anime/Videos/Frieren"), root, lib).as_deref(),
            Some("Anime/Videos/Frieren"),
        );
    }

    #[test]
    fn the_root_itself_is_never_binned() {
        let lib = Path::new("/lib");
        assert_eq!(video_bin_key(Path::new("/lib/Anime/Videos"), Path::new("/lib/Anime/Videos"), lib), None);
        assert_eq!(video_bin_key(Path::new("/mnt/vids"), Path::new("/mnt/vids"), lib), None);
    }

    #[test]
    fn paths_outside_the_root_are_refused() {
        let lib = Path::new("/lib");
        let root = Path::new("/lib/Anime/Videos");
        // Elsewhere in the library, and a sibling that merely shares a prefix.
        assert_eq!(video_bin_key(Path::new("/lib/Anime/Catalog/Frieren.md"), root, lib), None);
        assert_eq!(video_bin_key(Path::new("/lib/Anime/VideosOld/Frieren"), root, lib), None);
        // Under the OLD default while a custom root is configured.
        assert_eq!(video_bin_key(Path::new("/lib/Anime/Videos/Frieren"), Path::new("/mnt/vids"), lib), None);
    }

    #[test]
    fn custom_root_outside_the_library_records_an_absolute_key() {
        let lib = Path::new("/lib");
        let root = Path::new("/mnt/vids");
        assert_eq!(
            video_bin_key(Path::new("/mnt/vids/Frieren"), root, lib).as_deref(),
            Some("/mnt/vids/Frieren"),
        );
    }

    #[test]
    fn nested_series_folders_still_resolve() {
        let lib = Path::new("/lib");
        let root = Path::new("/mnt/vids");
        assert_eq!(
            video_bin_key(Path::new("/mnt/vids/Frieren/Season 1"), root, lib).as_deref(),
            Some("/mnt/vids/Frieren/Season 1"),
        );
    }
}
