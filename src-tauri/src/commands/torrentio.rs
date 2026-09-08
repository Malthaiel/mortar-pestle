//! Torrentio torrent search for the Movies / TV Shows rooms.
//!
//! The films-and-TV sibling of `anime_download::anime_torrent_search`, and
//! deliberately the same shape: run a Python searcher with `--list`, hand the
//! ranked candidate list straight to the UI, no side effects. The user picks a
//! magnet, which then rides the download enqueue — exactly the flow the Anime
//! room's torrent picker already implements, so the picker is reused unchanged.
//!
//! Backed by `Infrastructure/Scripts/torrentio_search.py` (which also carries
//! the EZTV fallback and the `fileIdx` pack detection). See
//! `Knowledge/Mortar & Pestle/Plans/Library Migration/TV Shows Tab.md` SF6/SF7.

use std::process::Stdio;

use crate::commands::vault;

/// Read-only candidate search for the picker. `kind` is `"movie"` or
/// `"series"`; a series needs `season` + `episode`.
///
/// Returns the script's `{ candidates, title_used }` payload verbatim, or
/// `{ candidates: [], error }` — never an `Err`, because a dead index is an
/// empty picker with a reason in it, not a crash for the user to interpret.
#[tauri::command]
pub async fn torrentio_torrent_search(
    app: tauri::AppHandle,
    imdb_id: String,
    kind: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
    min_seeds: Option<i64>,
) -> Result<serde_json::Value, String> {
    let imdb_id = imdb_id.trim().to_string();
    // Shape-checked here as well as in the script: this value is about to become
    // a process argument, and the script is the second line of defence, not the
    // first.
    if !(imdb_id.starts_with("tt")
        && imdb_id.len() > 2
        && imdb_id[2..].chars().all(|c| c.is_ascii_digit()))
    {
        return Err(format!("not an IMDb id: {imdb_id}"));
    }
    let kind = match kind.as_deref() {
        Some("movie") => "movie",
        Some("series") => "series",
        // Mirror the script's default: a season number means a series.
        None if season.is_some() => "series",
        None => "movie",
        Some(other) => return Err(format!("unknown kind: {other}")),
    };
    if kind == "series" && (season.is_none() || episode.is_none()) {
        return Err("a series search needs a season and an episode".into());
    }

    // No index ships with the app; both addresses are the user's own. All-empty
    // is a fresh install's correct state, so it answers with the same empty
    // picker shape a dead index gets, pointed at Settings instead.
    let sources = crate::commands::video_config::torrent_sources(&app);
    if sources.torrentio.is_empty() && sources.eztv.is_empty() {
        return Ok(serde_json::json!({
            "candidates": [],
            "error": "no_source_configured",
        }));
    }

    let script = vault::script_path("torrentio_search.py");
    let mut cmd = crate::commands::proc_util::python_cmd();
    cmd.arg(&script)
        .arg("--imdb-id")
        .arg(&imdb_id)
        .arg("--kind")
        .arg(kind)
        .arg("--torrentio-base")
        .arg(&sources.torrentio)
        .arg("--eztv-base")
        .arg(&sources.eztv);
    if let Some(s) = season {
        cmd.arg("--season").arg(s.to_string());
    }
    if let Some(e) = episode {
        cmd.arg("--episode").arg(e.to_string());
    }
    if let Some(m) = min_seeds {
        cmd.arg("--min-seeds").arg(m.to_string());
    }
    cmd.arg("--list")
        // A child whose stdout isn't UTF-8 aborts the reader silently; the
        // script's payload is ASCII-escaped JSON, but the flag costs nothing
        // and the failure it prevents is invisible.
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn torrentio_search.py: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(v) if v.get("candidates").is_some() => Ok(v),
        Ok(v) => Ok(serde_json::json!({
            "candidates": [],
            "error": v.get("error").and_then(|x| x.as_str()).unwrap_or("no_results"),
        })),
        Err(_) => Ok(serde_json::json!({ "candidates": [], "error": "no_results" })),
    }
}
