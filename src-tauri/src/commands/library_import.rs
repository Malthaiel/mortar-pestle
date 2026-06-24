//! Library import engine — parse a CSV/TXT (music) or MAL XML (anime, SF6) file
//! into not-downloaded library cards, as a background job that survives drawer
//! close. Mirrors `music_download.rs`: a process-global queue + single worker,
//! NDJSON-over-stdout from the parse script, re-emitted as Tauri events
//! (`library-import-progress` / `library-import-done`) the same `app.emit` way.
//!
//! Music flow (SF5): run `import_music_parse.py` → (optionally) resolve each
//! distinct album against MusicBrainz via `music_search_releasegroups` and spawn
//! `download_album.py --metadata-only` to write its not-downloaded card →
//! write the playlist page (plain rows; album cells upgraded to wikilinks when
//! the album resolved). Dedupe rides on the script's own "already exists" skip.
//! MAL flow lands in SF6.

use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::parsers::playlists::{write_playlist, TrackRefInput};

#[cfg(unix)]
const CANCEL_GRACE_MS: u64 = 2000;
// Polite spacing between MusicBrainz resolutions (the search backend talks to
// the public MB API, which asks ~1 req/s).
const MB_THROTTLE_MS: u64 = 350;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImportState {
    Queued,
    Parsing,
    Importing,
    Done,
    Error,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    pub kind: String, // "music" (SF5) | "mal" (SF6)
    pub source: String, // file basename, for display
    pub state: ImportState,
    pub total: i64,   // distinct albums to resolve (music)
    pub index: i64,   // processed so far
    pub current_title: Option<String>,
    pub created: i64, // album cards written
    pub skipped: i64, // already in library
    pub unmatched: Vec<String>, // "Album — Artist" with no confident MB match
    pub playlist_path: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
    #[serde(skip)]
    pub file_path: String,
    #[serde(skip)]
    pub add_albums: bool,
    #[serde(skip)]
    pub initial_status: Option<String>,
    #[serde(skip)]
    pub child_pid: Option<u32>,
    #[serde(skip)]
    pub cancel_requested: bool,
}

struct ImportQueue {
    jobs: Vec<ImportJob>,
    worker_running: bool,
}

static IMPORT_STATE: Mutex<ImportQueue> = Mutex::new(ImportQueue {
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

fn resolve_script(app: &AppHandle, name: &str) -> Option<String> {
    if let Ok(p) = app
        .path()
        .resolve(format!("scripts/{name}"), tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    if let Some(home) = dirs::home_dir() {
        let dev = home.join(format!("Code/iskariel/src-tauri/scripts/{name}"));
        if dev.exists() {
            return Some(dev.to_string_lossy().into_owned());
        }
    }
    None
}

fn snapshot(job_id: &str) -> Option<ImportJob> {
    let g = IMPORT_STATE.lock().unwrap();
    g.jobs.iter().find(|j| j.id == job_id).cloned()
}

fn emit_progress(app: &AppHandle, job_id: &str) {
    if let Some(job) = snapshot(job_id) {
        let _ = app.emit("library-import-progress", &job);
    }
}

fn emit_done(app: &AppHandle, job_id: &str) {
    if let Some(job) = snapshot(job_id) {
        let _ = app.emit(
            "library-import-done",
            serde_json::json!({
                "jobId": job.id,
                "kind": job.kind,
                "summary": job.summary,
                "playlistPath": job.playlist_path,
                "unmatched": job.unmatched,
                "state": job.state,
            }),
        );
    }
}

fn with_job<F: FnOnce(&mut ImportJob)>(job_id: &str, f: F) {
    let mut g = IMPORT_STATE.lock().unwrap();
    if let Some(j) = g.jobs.iter_mut().find(|j| j.id == job_id) {
        f(j);
    }
}

fn finalize_error(app: &AppHandle, job_id: &str, msg: &str) {
    with_job(job_id, |j| {
        j.state = ImportState::Error;
        j.error = Some(msg.to_string());
        j.current_title = None;
    });
    emit_progress(app, job_id);
    emit_done(app, job_id);
}

// ── commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn library_import_enqueue(
    app: AppHandle,
    kind: String,
    file_path: String,
    add_albums: Option<bool>,
    initial_status: Option<String>,
) -> Result<String, String> {
    let id = format!("imp{}", JOB_SEQ.fetch_add(1, Ordering::SeqCst));
    let source = Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_path.clone());

    let start_worker = {
        let mut g = IMPORT_STATE.lock().unwrap();
        g.jobs.push(ImportJob {
            id: id.clone(),
            kind: kind.clone(),
            source,
            state: ImportState::Queued,
            total: 0,
            index: 0,
            current_title: None,
            created: 0,
            skipped: 0,
            unmatched: Vec::new(),
            playlist_path: None,
            summary: None,
            error: None,
            file_path,
            add_albums: add_albums.unwrap_or(false),
            initial_status,
            child_pid: None,
            cancel_requested: false,
        });
        let was_idle = !g.worker_running;
        if was_idle {
            g.worker_running = true;
        }
        was_idle
    };

    emit_progress(&app, &id);
    if start_worker {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move { run_worker(app2).await });
    }
    Ok(id)
}

#[tauri::command]
pub fn library_import_status() -> Vec<ImportJob> {
    let g = IMPORT_STATE.lock().unwrap();
    g.jobs.clone()
}

#[tauri::command]
pub fn library_import_cancel(job_id: String) -> Result<(), String> {
    let pid = {
        let mut g = IMPORT_STATE.lock().unwrap();
        let Some(job) = g.jobs.iter_mut().find(|j| j.id == job_id) else {
            return Err("no such job".into());
        };
        match job.state {
            ImportState::Queued => {
                job.state = ImportState::Cancelled;
                None
            }
            ImportState::Parsing | ImportState::Importing => {
                job.cancel_requested = true;
                job.child_pid
            }
            _ => return Err("job is not cancellable".into()),
        }
    };
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

// ── worker ─────────────────────────────────────────────────────────────────

async fn run_worker(app: AppHandle) {
    loop {
        let job_id = {
            let mut g = IMPORT_STATE.lock().unwrap();
            match g.jobs.iter().position(|j| matches!(j.state, ImportState::Queued)) {
                Some(idx) => {
                    g.jobs[idx].state = ImportState::Parsing;
                    Some(g.jobs[idx].id.clone())
                }
                None => {
                    g.worker_running = false;
                    None
                }
            }
        };
        let Some(job_id) = job_id else { break };
        emit_progress(&app, &job_id);
        let kind = snapshot(&job_id).map(|j| j.kind).unwrap_or_default();
        match kind.as_str() {
            "music" => process_music_job(&app, &job_id).await,
            "mal" => process_mal_job(&app, &job_id).await,
            other => finalize_error(&app, &job_id, &format!("unsupported import kind: {other}")),
        }
    }
}

#[derive(Clone, Default)]
struct ParsedTrack {
    title: String,
    artist: String,
    album: String,
    album_artist: String,
    duration_secs: i64,
}

fn cancelled(job_id: &str) -> bool {
    snapshot(job_id).map(|j| j.cancel_requested).unwrap_or(true)
}

async fn process_music_job(app: &AppHandle, job_id: &str) {
    let (file_path, add_albums, initial_status) = {
        let g = IMPORT_STATE.lock().unwrap();
        match g.jobs.iter().find(|j| j.id == job_id) {
            Some(j) => (j.file_path.clone(), j.add_albums, j.initial_status.clone()),
            None => return,
        }
    };

    // ── phase 1: parse the file ───────────────────────────────────────────────
    let Some(script) = resolve_script(app, "import_music_parse.py") else {
        finalize_error(app, job_id, "parse script not found (scripts/import_music_parse.py)");
        return;
    };
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script).arg("--file").arg(&file_path);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            finalize_error(app, job_id, &format!("failed to spawn python3: {e}"));
            return;
        }
    };

    let mut tracks: Vec<ParsedTrack> = Vec::new();
    let mut distinct: Vec<(String, String)> = Vec::new(); // (album, albumArtist)
    let mut kind = String::from("playlist");
    let mut parse_error: Option<String> = None;

    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match v.get("event").and_then(|x| x.as_str()) {
                Some("track") => tracks.push(ParsedTrack {
                    title: jstr(&v, "title"),
                    artist: jstr(&v, "artist"),
                    album: jstr(&v, "album"),
                    album_artist: jstr(&v, "albumArtist"),
                    duration_secs: v.get("durationSecs").and_then(|x| x.as_i64()).unwrap_or(0),
                }),
                Some("parsed") => {
                    kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("playlist").to_string();
                    if let Some(arr) = v.get("distinctAlbums").and_then(|x| x.as_array()) {
                        for a in arr {
                            distinct.push((jstr(a, "album"), jstr(a, "albumArtist")));
                        }
                    }
                }
                Some("error") => parse_error = Some(jstr(&v, "message")),
                _ => {}
            }
        }
    }
    let _ = child.wait().await;

    if let Some(msg) = parse_error {
        finalize_error(app, job_id, &msg);
        return;
    }
    if tracks.is_empty() {
        finalize_error(app, job_id, "No tracks parsed from the file.");
        return;
    }
    if cancelled(job_id) {
        with_job(job_id, |j| j.state = ImportState::Cancelled);
        emit_progress(app, job_id);
        emit_done(app, job_id);
        return;
    }

    // ── phase 2: resolve + create album cards ─────────────────────────────────
    // Single-album files always create the album; playlists only when toggled.
    let do_albums = add_albums || kind == "album";
    // album-key (lowercased album+artist) → created/existing album page path
    let mut album_paths: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();

    if do_albums && !distinct.is_empty() {
        with_job(job_id, |j| {
            j.state = ImportState::Importing;
            j.total = distinct.len() as i64;
        });
        emit_progress(app, job_id);

        let album_script = resolve_script(app, "download_album.py");
        let status = initial_status.as_deref().unwrap_or("Plan-to-Listen").to_string();

        for (i, (album, album_artist)) in distinct.iter().enumerate() {
            if cancelled(job_id) {
                with_job(job_id, |j| j.state = ImportState::Cancelled);
                emit_progress(app, job_id);
                emit_done(app, job_id);
                return;
            }
            with_job(job_id, |j| {
                j.index = i as i64;
                j.current_title = Some(format!("{album} — {album_artist}"));
            });
            emit_progress(app, job_id);

            // Resolve album → MusicBrainz release-group.
            let query = format!("{album} {album_artist}");
            let hit = match crate::commands::music_search::music_search_releasegroups(
                query,
                Some(8),
                None,
            )
            .await
            {
                Ok(hits) => hits
                    .into_iter()
                    .find(|h| album_matches(album, album_artist, &h.title, &h.artist)),
                Err(_) => None,
            };

            let Some(hit) = hit else {
                with_job(job_id, |j| j.unmatched.push(format!("{album} — {album_artist}")));
                emit_progress(app, job_id);
                tokio::time::sleep(Duration::from_millis(MB_THROTTLE_MS)).await;
                continue;
            };

            // Write the not-downloaded album card via download_album.py.
            if let Some(ref ascript) = album_script {
                match spawn_album_card(job_id, ascript, &hit.mbid, &status).await {
                    Some((path, skipped)) => {
                        album_paths.insert(
                            (album.to_lowercase(), album_artist.to_lowercase()),
                            path,
                        );
                        with_job(job_id, |j| {
                            if skipped {
                                j.skipped += 1;
                            } else {
                                j.created += 1;
                            }
                        });
                    }
                    None => {
                        with_job(job_id, |j| {
                            j.unmatched.push(format!("{album} — {album_artist} (write failed)"))
                        });
                    }
                }
            }
            with_job(job_id, |j| j.index = (i + 1) as i64);
            emit_progress(app, job_id);
            tokio::time::sleep(Duration::from_millis(MB_THROTTLE_MS)).await;
        }
    }

    // ── phase 3: write the playlist page (playlist kind only) ─────────────────
    if kind == "playlist" {
        let title = Path::new(&file_path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Imported Playlist".into());
        let refs: Vec<TrackRefInput> = tracks
            .iter()
            .map(|t| {
                let album_path = if t.album.is_empty() {
                    None
                } else {
                    album_paths
                        .get(&(t.album.to_lowercase(), t.album_artist.to_lowercase()))
                        .map(|p| strip_ext(p))
                };
                TrackRefInput {
                    wikilink: None,
                    audio_path: None,
                    title: t.title.clone(),
                    artist: Some(t.artist.clone()),
                    album_path,
                    album_title: if t.album.is_empty() { None } else { Some(t.album.clone()) },
                    duration: if t.duration_secs > 0 { Some(t.duration_secs) } else { None },
                }
            })
            .collect();
        match write_playlist(&title, refs, None, None) {
            Ok(pl) => with_job(job_id, |j| j.playlist_path = Some(pl.path.clone())),
            Err(e) => {
                // Playlist write failed but album cards may have landed — surface
                // it without nuking the album work.
                with_job(job_id, |j| {
                    j.unmatched.push(format!("playlist write failed: {e:?}"))
                });
            }
        }
    }

    // ── summary ───────────────────────────────────────────────────────────────
    let summary = {
        let g = IMPORT_STATE.lock().unwrap();
        let j = g.jobs.iter().find(|j| j.id == job_id);
        match j {
            Some(j) => {
                let mut parts = Vec::new();
                if j.playlist_path.is_some() {
                    parts.push(format!("Imported playlist ({} tracks)", tracks.len()));
                }
                if do_albums {
                    parts.push(format!("{} album{} added", j.created, plural(j.created)));
                    if j.skipped > 0 {
                        parts.push(format!("{} already in library", j.skipped));
                    }
                    let unmatched = j.unmatched.len() as i64;
                    if unmatched > 0 {
                        parts.push(format!("{unmatched} unmatched"));
                    }
                }
                if parts.is_empty() {
                    "Nothing to import.".to_string()
                } else {
                    parts.join(" · ")
                }
            }
            None => return,
        }
    };
    with_job(job_id, |j| {
        j.state = ImportState::Done;
        j.current_title = None;
        j.summary = Some(summary);
    });
    emit_progress(app, job_id);
    emit_done(app, job_id);
}

/// Spawn `download_album.py --metadata-only` for one release-group; returns
/// (albumPath, skipped) from its terminal `done` event, or None on failure.
async fn spawn_album_card(
    job_id: &str,
    script: &str,
    rg_mbid: &str,
    status: &str,
) -> Option<(String, bool)> {
    let vault = crate::commands::vault::library_vault_root();
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(script)
        .arg("--rg-mbid")
        .arg(rg_mbid)
        .arg("--vault")
        .arg(&vault)
        .arg("--metadata-only")
        .arg("--status")
        .arg(status);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    with_job(job_id, |j| j.child_pid = child.id());

    let mut result: Option<(String, bool)> = None;
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("event").and_then(|x| x.as_str()) == Some("done") {
                    let path = jstr(&v, "albumPath");
                    let skipped = v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false);
                    if !path.is_empty() {
                        result = Some((path, skipped));
                    }
                }
            }
        }
    }
    let _ = child.wait().await;
    with_job(job_id, |j| j.child_pid = None);
    result
}

// ── MAL XML import ───────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct ParsedAnime {
    mal_id: i64,
    title: String,
    status: String,
    score: f64,
    watched: i64,
    rewatches: i64,
    started: String,
    finished: String,
}

async fn process_mal_job(app: &AppHandle, job_id: &str) {
    let file_path = {
        let g = IMPORT_STATE.lock().unwrap();
        match g.jobs.iter().find(|j| j.id == job_id) {
            Some(j) => j.file_path.clone(),
            None => return,
        }
    };

    // ── phase 1: parse the XML ────────────────────────────────────────────────
    let Some(script) = resolve_script(app, "import_mal_parse.py") else {
        finalize_error(app, job_id, "parse script not found (scripts/import_mal_parse.py)");
        return;
    };
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script).arg("--file").arg(&file_path);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            finalize_error(app, job_id, &format!("failed to spawn python3: {e}"));
            return;
        }
    };

    let mut entries: Vec<ParsedAnime> = Vec::new();
    let mut parse_error: Option<String> = None;
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v.get("event").and_then(|x| x.as_str()) {
                Some("anime") => entries.push(ParsedAnime {
                    mal_id: v.get("malId").and_then(|x| x.as_i64()).unwrap_or(0),
                    title: jstr(&v, "title"),
                    status: jstr(&v, "status"),
                    score: v.get("score").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    watched: v.get("watchedEpisodes").and_then(|x| x.as_i64()).unwrap_or(0),
                    rewatches: v.get("timesWatched").and_then(|x| x.as_i64()).unwrap_or(0),
                    started: jstr(&v, "startDate"),
                    finished: jstr(&v, "finishDate"),
                }),
                Some("error") => parse_error = Some(jstr(&v, "message")),
                _ => {}
            }
        }
    }
    let _ = child.wait().await;

    if let Some(msg) = parse_error {
        finalize_error(app, job_id, &msg);
        return;
    }
    if entries.is_empty() {
        finalize_error(app, job_id, "No anime entries parsed from the file.");
        return;
    }
    if cancelled(job_id) {
        with_job(job_id, |j| j.state = ImportState::Cancelled);
        emit_progress(app, job_id);
        emit_done(app, job_id);
        return;
    }

    // ── dedupe: existing MAL ids (provider_id ∪ related_ids) ──────────────────
    let existing: HashSet<i64> = match crate::parsers::series::list_series() {
        Ok(list) => {
            let mut s = HashSet::new();
            for ser in list {
                if let Some(p) = ser.provider_id {
                    s.insert(p);
                }
                if let Some(rel) = ser.related_ids {
                    s.extend(rel);
                }
            }
            s
        }
        Err(_) => HashSet::new(),
    };

    // ── phase 2: write a card per new entry ───────────────────────────────────
    with_job(job_id, |j| {
        j.state = ImportState::Importing;
        j.total = entries.len() as i64;
    });
    emit_progress(app, job_id);

    let anime_script = resolve_script(app, "download_anime.py");
    for (i, a) in entries.iter().enumerate() {
        if cancelled(job_id) {
            with_job(job_id, |j| j.state = ImportState::Cancelled);
            emit_progress(app, job_id);
            emit_done(app, job_id);
            return;
        }
        with_job(job_id, |j| {
            j.index = i as i64;
            j.current_title = Some(a.title.clone());
        });
        emit_progress(app, job_id);

        if existing.contains(&a.mal_id) {
            with_job(job_id, |j| {
                j.skipped += 1;
                j.index = (i + 1) as i64;
            });
            continue;
        }

        if let Some(ref ascript) = anime_script {
            match spawn_anime_card(job_id, ascript, a).await {
                Some(skipped) => with_job(job_id, |j| {
                    if skipped {
                        j.skipped += 1;
                    } else {
                        j.created += 1;
                    }
                }),
                None => with_job(job_id, |j| j.unmatched.push(format!("{} (write failed)", a.title))),
            }
        }
        with_job(job_id, |j| j.index = (i + 1) as i64);
        emit_progress(app, job_id);
        // Polite to Jikan (download_anime.py fetches metadata per id).
        tokio::time::sleep(Duration::from_millis(MB_THROTTLE_MS)).await;
    }

    let summary = {
        let g = IMPORT_STATE.lock().unwrap();
        match g.jobs.iter().find(|j| j.id == job_id) {
            Some(j) => {
                let mut parts = vec![format!("{} anime added", j.created)];
                if j.skipped > 0 {
                    parts.push(format!("{} already in library", j.skipped));
                }
                if !j.unmatched.is_empty() {
                    parts.push(format!("{} failed", j.unmatched.len()));
                }
                parts.join(" · ")
            }
            None => return,
        }
    };
    with_job(job_id, |j| {
        j.state = ImportState::Done;
        j.current_title = None;
        j.summary = Some(summary);
    });
    emit_progress(app, job_id);
    emit_done(app, job_id);
}

/// Spawn `download_anime.py --metadata-only` for one MAL entry; returns
/// Some(skipped) from its terminal JSON, or None on failure.
async fn spawn_anime_card(job_id: &str, script: &str, a: &ParsedAnime) -> Option<bool> {
    let vault = crate::commands::vault::vault_root();
    let library = crate::commands::vault::library_vault_root();
    let status = if a.status.is_empty() { "Plan-to-Watch" } else { &a.status };
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(script)
        .arg("--mal-id")
        .arg(a.mal_id.to_string())
        .arg("--vault")
        .arg(&vault)
        .arg("--library")
        .arg(&library)
        .arg("--save-root")
        .arg(format!("{library}/Anime/Videos"))
        .arg("--metadata-only")
        .arg("--status")
        .arg(status)
        .arg("--score")
        .arg(a.score.to_string())
        .arg("--watched-upto")
        .arg(a.watched.to_string())
        .arg("--rewatches")
        .arg(a.rewatches.to_string())
        .arg("--started")
        .arg(&a.started)
        .arg("--finished")
        .arg(&a.finished);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    with_job(job_id, |j| j.child_pid = child.id());

    let mut result: Option<bool> = None;
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                // download_anime.py's metadata-only terminal: {"ok":true,
                // "metadataOnly":true,"skipped":bool,"seriesPath":...}
                let is_terminal = v.get("seriesPath").is_some()
                    || v.get("metadataOnly").and_then(|x| x.as_bool()) == Some(true);
                if is_terminal && v.get("ok").and_then(|x| x.as_bool()) != Some(false) {
                    result = Some(v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false));
                }
            }
        }
    }
    let _ = child.wait().await;
    with_job(job_id, |j| j.child_pid = None);
    result
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn jstr(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn plural(n: i64) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

fn strip_ext(p: &str) -> String {
    p.strip_suffix(".md").unwrap_or(p).to_string()
}

/// Normalize a title/artist for fuzzy compare: drop parenthetical qualifiers
/// (deluxe / remaster / feat …), lowercase, keep alphanumerics, collapse space.
fn norm(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ if depth == 0 => {
                if c.is_alphanumeric() {
                    out.extend(c.to_lowercase());
                } else if c.is_whitespace() || c == '-' || c == '_' || c == '&' {
                    out.push(' ');
                }
            }
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A MB hit matches when normalized titles are equal or one contains the other
/// (≥5 chars to avoid trivial substrings), AND the artist tokens overlap.
fn album_matches(q_title: &str, q_artist: &str, hit_title: &str, hit_artist: &str) -> bool {
    let qt = norm(q_title);
    let ht = norm(hit_title);
    if qt.is_empty() || ht.is_empty() {
        return false;
    }
    let title_ok = qt == ht
        || (qt.len() >= 5 && ht.contains(&qt))
        || (ht.len() >= 5 && qt.contains(&ht));
    if !title_ok {
        return false;
    }
    let qa: HashSet<String> = norm(q_artist).split_whitespace().map(String::from).collect();
    let ha: HashSet<String> = norm(hit_artist).split_whitespace().map(String::from).collect();
    qa.is_empty() || ha.is_empty() || qa.intersection(&ha).next().is_some()
}
