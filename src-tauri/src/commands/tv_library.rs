//! Add a Cinemeta show to `Library/TV Shows/Catalog/` as a series card.
//!
//! The card is written in the **season-section** form `parsers/series.rs`
//! already reads for multi-entry anime franchises: one `## SEASON N` H2 per
//! season, each with its own episode table numbered from 1, and per-season
//! frontmatter (`Status Season 1`, `Watched Episodes Season 1`, ...). That form
//! maps 1-1 onto the disk layout (`<video root>/TV Shows/<Title>/Season N/`) and
//! onto what Torrentio is queried with (an IMDb id plus a season and an
//! episode), so no translation table is needed anywhere downstream.
//!
//! Unlike the Anime room there is no Python prepare step: `download_anime.py`
//! fetches MAL itself and writes its own card, but the Cinemeta record is
//! already in Rust by the time the user clicks Add.
//!
//! See `Knowledge/Mortar & Pestle/Plans/Library Migration/TV Shows Tab.md` SF3+SF4.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::cinemeta::{cinemeta_detail, CineDetail, CineEpisode};
use crate::commands::tmdb::TmdbDetail;
use crate::commands::vault::{atomic_write, library_vault_root, VaultError};
use crate::parsers::frontmatter_cache::get_frontmatter;
use crate::parsers::playlists::{cell_escape, sanitize_name, yaml_str};

const TV_CATALOG: &str = "TV Shows/Catalog";
const ANIME_CATALOG: &str = "Anime/Catalog";
const MOVIES_CATALOG: &str = "Movies/Catalog";

/// Why an add was refused. A stable machine string, not prose — the room
/// branches on it (anime → jump to the Anime room; already there → open it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    /// `anime` | `already-in-anime` | `already-in-tv` | `already-in-movies`
    pub reason: String,
    /// Catalog-relative path of the card that already owns this title, when one does.
    pub series_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub ok: bool,
    /// `TV Shows/Catalog/<Title>.md` — the same shape `video_list_series` returns.
    pub series_path: Option<String>,
    pub title: String,
    pub seasons: i64,
    pub episodes: i64,
    pub refused: Option<Refusal>,
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn catalog_dir(rel: &str) -> PathBuf {
    PathBuf::from(library_vault_root()).join(rel)
}

fn md_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".md"))
        .collect()
}

/// First card in `catalog` whose `IMDb ID` matches, as a catalog-relative path.
///
/// ponytail: the Anime sweep is belt-and-braces and finds nothing today — anime
/// cards are MAL-keyed and carry no `IMDb ID`. It costs one cached frontmatter
/// read per card and starts working the day the MAL importer records one, which
/// is cheaper than adding a title-similarity guess that would fire wrongly.
fn find_by_imdb(catalog: &str, imdb_id: &str) -> Option<String> {
    let dir = catalog_dir(catalog);
    for name in md_files(&dir) {
        let meta = get_frontmatter(&dir.join(&name));
        let hit = meta
            .get("IMDb ID")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().trim_matches('"').eq_ignore_ascii_case(imdb_id))
            .unwrap_or(false);
        if hit {
            return Some(format!("{catalog}/{name}"));
        }
    }
    None
}

/// `tt0903747` → `903747`, so `series.rs`'s `meta_i64` reads `Provider ID`.
fn numeric_id(imdb_id: &str) -> i64 {
    imdb_id.trim_start_matches("tt").parse::<i64>().unwrap_or(0)
}

/// Cinemeta dates arrive as `2008-01-20T02:00:00.000Z` or already bare. The
/// episode table's `Aired` column only matches `[\d-]+`, so a timestamp there
/// would silently drop the whole row.
fn iso_date(s: Option<&str>) -> String {
    let s = s.unwrap_or("").trim();
    if s.len() >= 10 && s.is_char_boundary(10) {
        s[..10].to_string()
    } else {
        String::new()
    }
}

/// `"2008–2013"` / `"2008-"` / `"2008"` → `2008`.
fn first_year(s: Option<&str>) -> Option<i64> {
    let s = s?;
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<i64>().ok()
}

fn season_suffix(season: i64) -> String {
    format!("Season {season}")
}

/// Group episodes by season, dropping season 0 (specials): Torrentio indexes
/// them patchily and counting them makes the episode total disagree with every
/// external source.
fn by_season(episodes: &[CineEpisode]) -> BTreeMap<i64, Vec<&CineEpisode>> {
    let mut out: BTreeMap<i64, Vec<&CineEpisode>> = BTreeMap::new();
    for ep in episodes.iter().filter(|e| e.season > 0) {
        out.entry(ep.season).or_default().push(ep);
    }
    for eps in out.values_mut() {
        eps.sort_by_key(|e| e.episode);
    }
    out
}

fn yaml_list(key: &str, items: &[String]) -> String {
    if items.is_empty() {
        return format!("{key}: []\n");
    }
    let mut s = format!("{key}:\n");
    for item in items {
        s.push_str(&format!("  - {}\n", yaml_str(item)));
    }
    s
}

/// The credit fields Cinemeta already returns and both card writers used to
/// throw away, plus -- for a film, when the user has supplied a TMDb key -- the
/// richer set Cinemeta cannot reach. Shared so a film and a show can never drift
/// apart on the fields they have in common, and so the add path and the refresh
/// path can never drift apart at all.
///
/// `Cast` is written in full: a card is the record, and trimming it here would
/// lose names nothing else stores. The pre-add page already caps its own display
/// at six (`RoomTitle.jsx`:141), which is where a cap belongs.
///
/// No `Awards` field -- Cinemeta does not carry one. That is an OMDb field, and
/// OMDb's terms bind the builder, so no user key can bring it back.
fn push_credits(fm: &mut String, d: &CineDetail, t: Option<&TmdbDetail>) {
    // TMDb's cast carries the character each actor played, which is the whole
    // reason to ask it -- so when it answered, its cast REPLACES Cinemeta's bare
    // list rather than sitting beside it (one entity, one field).
    let tmdb = t.filter(|t| t.available && !t.cast.is_empty());
    match tmdb {
        Some(t) => {
            let cast: Vec<String> = t
                .cast
                .iter()
                .map(|c| {
                    if c.role.trim().is_empty() {
                        c.name.clone()
                    } else {
                        format!("{} as {}", c.name, c.role)
                    }
                })
                .collect();
            fm.push_str(&yaml_list("Cast", &cast));
            // Parallel to `Cast` BY INDEX -- one entry per name, empty when TMDb
            // has no headshot. Written only on the TMDb branch, because Cinemeta's
            // bare list has no photos to pair with.
            let cast_imgs: Vec<String> = t.cast.iter().map(|c| c.image.clone()).collect();
            if cast_imgs.iter().any(|s| !s.is_empty()) {
                fm.push_str(&yaml_list("Cast Images", &cast_imgs));
            }
        }
        None => fm.push_str(&yaml_list("Cast", &d.cast)),
    }
    fm.push_str(&yaml_list("Writer", &d.writer));
    fm.push_str(&format!(
        "Country: {}\n",
        yaml_str(d.country.as_deref().unwrap_or(""))
    ));
    let trailer = d
        .trailer_youtube_id
        .as_deref()
        .map(|id| format!("https://www.youtube.com/watch?v={id}"))
        .unwrap_or_default();
    fm.push_str(&format!("Trailer: {}\n", yaml_str(&trailer)));
    fm.push_str(&format!(
        "Logo: {}\n",
        yaml_str(d.logo.as_deref().unwrap_or(""))
    ));
    let Some(t) = t.filter(|t| t.available) else {
        return;
    };
    // The film's TMDb id, so the page can link straight to its TMDb entry
    // instead of running a search on the IMDb id.
    if let Some(id) = t.tmdb_id {
        fm.push_str(&format!("TMDb ID: {id}\n"));
    }
    // Crew is written as "Name -- Job" rather than a nested map: `series.rs`
    // reads flat string lists, and one line per person is what the page shows.
    let crew: Vec<String> = t
        .crew
        .iter()
        .filter(|c| !c.role.trim().is_empty())
        .map(|c| format!("{} — {}", c.name, c.role))
        .collect();
    if !crew.is_empty() {
        fm.push_str(&yaml_list("Crew", &crew));
        // Same filter as `crew` above, so the two lists stay index-aligned.
        let crew_imgs: Vec<String> = t
            .crew
            .iter()
            .filter(|c| !c.role.trim().is_empty())
            .map(|c| c.image.clone())
            .collect();
        if crew_imgs.iter().any(|s| !s.is_empty()) {
            fm.push_str(&yaml_list("Crew Images", &crew_imgs));
        }
    }
    if !t.studios.is_empty() {
        fm.push_str(&yaml_list("Studios", &t.studios));
    }
    // Absent, not zero: TMDb sends 0 for "unknown", which the client already
    // filtered to None, and a row that says $0 would be a lie.
    if let Some(b) = t.budget {
        fm.push_str(&format!("Budget: {b}\n"));
    }
    if let Some(r) = t.revenue {
        fm.push_str(&format!("Box Office: {r}\n"));
    }
    if let Some(tag) = t.tagline.as_deref() {
        fm.push_str(&format!("Tagline: {}\n", yaml_str(tag)));
    }
    // Wide scene still -- the film header background.
    if let Some(bd) = t.backdrop.as_deref() {
        fm.push_str(&format!("Backdrop: {}\n", yaml_str(bd)));
    }
}

/// Every frontmatter key `push_credits` can emit. `movie_refresh_credits` strips
/// these before splicing a fresh block in, so a film that loses a field on a
/// re-fetch loses the stale line too rather than keeping it forever.
/// `Cast Images` / `Crew Images` carry the credit headshots, index-aligned with
/// `Cast` / `Crew`. Portraits were dropped 2026-09-12 and restored the same day
/// as the top half of the fused credit pairs, so these are WRITTEN again.

const CREDIT_KEYS: &[&str] = &[
    "Cast", "Cast Images", "Writer", "Country", "Trailer", "Logo", "Crew", "Crew Images",
    "Studios", "Budget", "Box Office", "Tagline", "TMDb ID", "Backdrop",
];

/// A film's card: the same frontmatter block a show gets, minus everything that
/// only means something across many episodes (`Seasons`, `Episodes`, `Airing`,
/// the per-season `Status ...` block) and with `Released` in place of the aired
/// range. No `## SEASON` sections, so `series.rs` reads it as a flat record with
/// zero episodes -- which is exactly what a film is.
///
/// Verified 2026-09-07 against a hand-written card of this exact shape:
/// `video_read_series`, `video_mark_series_status` and `video_mark_series_rating`
/// all work on it unchanged, which is why there is no `parsers/movies.rs`.
fn render_movie_card(d: &CineDetail, tmdb: Option<&TmdbDetail>) -> String {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut fm = String::from("---\n");
    fm.push_str("Type: Media-Entry\n");
    fm.push_str("Domain: Movie\n");
    fm.push_str("Provider: cinemeta\n");
    fm.push_str(&format!("Provider ID: {}\n", numeric_id(&d.imdb_id)));
    fm.push_str(&format!("IMDb ID: {}\n", yaml_str(&d.imdb_id)));
    fm.push_str(&format!("Title: {}\n", yaml_str(&d.name)));
    fm.push_str("Status: Plan-to-Watch\n");
    fm.push_str(&format!("Created: {today}\n"));
    fm.push_str(&format!("Ingested: {today}\n"));
    fm.push_str("Personal Rating: 0\n");
    match first_year(d.year.as_deref()) {
        Some(y) => fm.push_str(&format!("Year: {y}\n")),
        None => fm.push_str("Year: \"\"\n"),
    }
    fm.push_str(&yaml_list("Genres", &d.genres));
    fm.push_str(&format!(
        "Duration: {}\n",
        yaml_str(d.runtime.as_deref().unwrap_or(""))
    ));
    match d.imdb_rating.as_deref().and_then(|r| r.parse::<f64>().ok()) {
        Some(r) => fm.push_str(&format!("Online Rating: {r}\n")),
        None => fm.push_str("Online Rating: \"\"\n"),
    }
    fm.push_str(&format!(
        "Released: {}\n",
        yaml_str(&iso_date(d.released.as_deref()))
    ));
    fm.push_str(&format!("Director: {}\n", yaml_str(&d.director.join(", "))));
    push_credits(&mut fm, d, tmdb);
    fm.push_str("Local Path: \"\"\n");
    fm.push_str("Download Status: Not-Downloaded\n");
    fm.push_str(&format!(
        "Image: {}\n",
        yaml_str(d.poster.as_deref().unwrap_or(""))
    ));
    fm.push_str(&format!(
        "Background: {}\n",
        yaml_str(d.background.as_deref().unwrap_or(""))
    ));
    fm.push_str(&format!(
        "Source URL: \"https://www.imdb.com/title/{}/\"\n",
        d.imdb_id
    ));
    fm.push_str("---\n\n");

    let mut body = String::new();
    if let Some(desc) = d.description.as_deref().filter(|s| !s.trim().is_empty()) {
        body.push_str("## Plot\n\n");
        body.push_str(desc.trim());
        body.push('\n');
    }
    format!("{fm}{}", body.trim_end())
}

/// `<Title (Year)>.md` -- a film ALWAYS carries its year, unlike a show.
///
/// Two reasons. Remakes share a title far more often than shows do (three films
/// are just called `The Thing`), and the download lane names the video folder
/// from this stem, so carrying the year here is what makes the folder on disk
/// `Movies/Inception (2010)/` without the job needing a year field of its own.
fn pick_movie_filename(dir: &Path, title: &str, year: Option<i64>) -> Result<String, VaultError> {
    let base = sanitize_name(title);
    if base.is_empty() {
        return Err(VaultError::Invalid("film has no usable title".into()));
    }
    let name = match year {
        Some(y) => format!("{base} ({y})"),
        None => base,
    };
    if !dir.join(format!("{name}.md")).exists() {
        return Ok(format!("{name}.md"));
    }
    Err(VaultError::Conflict { current_mtime: 0.0 })
}

/// Build the whole card — frontmatter plus season sections.
fn render_card(d: &CineDetail, seasons: &BTreeMap<i64, Vec<&CineEpisode>>) -> String {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let total: i64 = seasons.values().map(|v| v.len() as i64).sum();
    let airing = d.status.as_deref() == Some("Continuing");
    let aired_from = iso_date(
        seasons
            .values()
            .next()
            .and_then(|v| v.first())
            .and_then(|e| e.released.as_deref())
            .or(d.released.as_deref()),
    );
    let aired_to = if airing {
        String::new()
    } else {
        iso_date(
            seasons
                .values()
                .next_back()
                .and_then(|v| v.last())
                .and_then(|e| e.released.as_deref()),
        )
    };

    let mut fm = String::from("---\n");
    fm.push_str("Type: Media-Entry\n");
    fm.push_str("Domain: TV\n");
    fm.push_str("Provider: cinemeta\n");
    fm.push_str(&format!("Provider ID: {}\n", numeric_id(&d.imdb_id)));
    fm.push_str(&format!("IMDb ID: {}\n", yaml_str(&d.imdb_id)));
    fm.push_str(&format!("Title: {}\n", yaml_str(&d.name)));
    fm.push_str("Status: Plan-to-Watch\n");
    fm.push_str(&format!("Created: {today}\n"));
    fm.push_str(&format!("Ingested: {today}\n"));
    fm.push_str("Personal Rating: 0\n");
    match first_year(d.year.as_deref()) {
        Some(y) => fm.push_str(&format!("Year: {y}\n")),
        None => fm.push_str("Year: \"\"\n"),
    }
    fm.push_str(&yaml_list("Genres", &d.genres));
    // `Seasons` is what flips `series.rs` into its season-section reader — a TV
    // show has no franchise sibling ids to trip the MAL-era `Related IDs` check.
    fm.push_str(&format!("Seasons: {}\n", seasons.len()));
    fm.push_str(&format!("Episodes: {total}\n"));
    fm.push_str(&format!(
        "Duration: {}\n",
        yaml_str(d.runtime.as_deref().unwrap_or(""))
    ));
    match d.imdb_rating.as_deref().and_then(|r| r.parse::<f64>().ok()) {
        Some(r) => fm.push_str(&format!("Online Rating: {r}\n")),
        None => fm.push_str("Online Rating: \"\"\n"),
    }
    fm.push_str(&format!("Aired From: {}\n", yaml_str(&aired_from)));
    fm.push_str(&format!("Aired To: {}\n", yaml_str(&aired_to)));
    fm.push_str(&format!("Airing: {airing}\n"));
    fm.push_str(&format!(
        "Director: {}\n",
        yaml_str(&d.director.join(", "))
    ));
    // No TMDb tier for a show: `tmdb_movie_detail` is film-only by design.
    push_credits(&mut fm, d, None);
    fm.push_str("Local Path: \"\"\n");
    fm.push_str("Download Status: Not-Downloaded\n");
    fm.push_str(&format!(
        "Image: {}\n",
        yaml_str(d.poster.as_deref().unwrap_or(""))
    ));
    fm.push_str(&format!(
        "Background: {}\n",
        yaml_str(d.background.as_deref().unwrap_or(""))
    ));
    fm.push_str(&format!(
        "Source URL: \"https://www.imdb.com/title/{}/\"\n",
        d.imdb_id
    ));
    for season in seasons.keys() {
        let s = season_suffix(*season);
        fm.push_str(&format!("Status {s}: Plan-to-Watch\n"));
        fm.push_str(&format!("Watched Episodes {s}: []\n"));
        fm.push_str(&format!("Re Watches {s}: 0\n"));
        fm.push_str(&format!("Started {s}: \"\"\n"));
        fm.push_str(&format!("Finished {s}: \"\"\n"));
    }
    fm.push_str("---\n\n");

    let mut body = String::new();
    if let Some(desc) = d.description.as_deref().filter(|s| !s.trim().is_empty()) {
        body.push_str("## Plot\n\n");
        body.push_str(desc.trim());
        body.push_str("\n\n");
    }
    for (season, eps) in seasons {
        // Uppercase: `series.rs`'s section regex only matches all-caps H2s, which
        // is how `## Plot` above stays out of the season list.
        body.push_str(&format!("## SEASON {season}\n\n### Episodes\n\n"));
        body.push_str("| #   | Title | Aired |\n| --- | ----- | ----- |\n");
        for ep in eps {
            let title = ep
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(cell_escape)
                .unwrap_or_else(|| format!("Episode {}", ep.episode));
            body.push_str(&format!(
                "| {:02} | {} | {} |\n",
                ep.episode,
                title,
                iso_date(ep.released.as_deref())
            ));
        }
        body.push('\n');
    }
    format!("{fm}{}", body.trim_end())
}

/// `<Title>.md`, matching the Anime catalog. A name already taken by a
/// *different* show (The Office UK vs US) gains its year.
fn pick_filename(dir: &Path, title: &str, year: Option<i64>) -> Result<String, VaultError> {
    let base = sanitize_name(title);
    if base.is_empty() {
        return Err(VaultError::Invalid("show has no usable title".into()));
    }
    if !dir.join(format!("{base}.md")).exists() {
        return Ok(format!("{base}.md"));
    }
    if let Some(y) = year {
        let dated = format!("{base} ({y}).md");
        if !dir.join(&dated).exists() {
            return Ok(dated);
        }
    }
    Err(VaultError::Conflict { current_mtime: 0.0 })
}

fn refuse(reason: &str, message: String, series_path: Option<String>, title: String) -> AddResult {
    AddResult {
        ok: false,
        series_path: None,
        title,
        seasons: 0,
        episodes: 0,
        refused: Some(Refusal {
            reason: reason.to_string(),
            series_path,
            message,
        }),
    }
}

// ── command ──────────────────────────────────────────────────────────────────

/// Write a Cinemeta series into the TV Shows catalog.
///
/// Refuses rather than writes when the show is anime (the Anime room owns it),
/// when its IMDb id already sits in either catalog, or when it has no real
/// season. The refusal is data, not an `Err`, because the room turns each reason
/// into a different button — but nothing is written either way, so a caller that
/// ignores `refused` still cannot create a duplicate.
#[tauri::command]
pub async fn tv_add_to_library(imdb_id: String) -> Result<AddResult, VaultError> {
    let detail = cinemeta_detail("series".to_string(), imdb_id).await?;
    let id = detail.imdb_id.clone();

    if detail.is_anime {
        return Ok(refuse(
            "anime",
            format!("{} is anime — it belongs in the Anime room.", detail.name),
            None,
            detail.name,
        ));
    }
    if let Some(path) = find_by_imdb(ANIME_CATALOG, &id) {
        return Ok(refuse(
            "already-in-anime",
            format!("{} is already in the Anime library.", detail.name),
            Some(path),
            detail.name,
        ));
    }
    if let Some(path) = find_by_imdb(TV_CATALOG, &id) {
        return Ok(refuse(
            "already-in-tv",
            format!("{} is already in the TV library.", detail.name),
            Some(path),
            detail.name,
        ));
    }

    let seasons = by_season(&detail.episodes);
    if seasons.is_empty() {
        return Ok(refuse(
            "no-episodes",
            format!("Cinemeta lists no episodes for {}.", detail.name),
            None,
            detail.name,
        ));
    }

    let dir = catalog_dir(TV_CATALOG);
    let file = pick_filename(&dir, &detail.name, first_year(detail.year.as_deref()))?;
    let card = render_card(&detail, &seasons);
    atomic_write(&dir.join(&file), card.as_bytes())?;

    Ok(AddResult {
        ok: true,
        series_path: Some(format!("{TV_CATALOG}/{file}")),
        title: detail.name,
        seasons: seasons.len() as i64,
        episodes: seasons.values().map(|v| v.len() as i64).sum(),
        refused: None,
    })
}

/// Write a Cinemeta film into the Movies catalog.
///
/// The film twin of `tv_add_to_library`, and deliberately the same shape: it
/// refuses rather than `Err`s, for the same reason (each reason becomes a
/// different button in the room). An anime film goes to the Anime room, which
/// owns it -- the same one-entity-one-page rule the TV room follows.
#[tauri::command]
pub async fn movie_add_to_library(imdb_id: String) -> Result<AddResult, VaultError> {
    let detail = cinemeta_detail("movie".to_string(), imdb_id).await?;
    let id = detail.imdb_id.clone();

    if detail.is_anime {
        return Ok(refuse(
            "anime",
            format!("{} is anime -- it belongs in the Anime room.", detail.name),
            None,
            detail.name,
        ));
    }
    if let Some(path) = find_by_imdb(ANIME_CATALOG, &id) {
        return Ok(refuse(
            "already-in-anime",
            format!("{} is already in the Anime library.", detail.name),
            Some(path),
            detail.name,
        ));
    }
    if let Some(path) = find_by_imdb(MOVIES_CATALOG, &id) {
        return Ok(refuse(
            "already-in-movies",
            format!("{} is already in the Movies library.", detail.name),
            Some(path),
            detail.name,
        ));
    }

    let dir = catalog_dir(MOVIES_CATALOG);
    std::fs::create_dir_all(&dir)?;
    let file = pick_movie_filename(&dir, &detail.name, first_year(detail.year.as_deref()))?;
    // Best-effort: no key, no network, or a TMDb outage all mean the card is
    // written with Cinemeta's thinner credits, never that the add fails.
    let tmdb = crate::commands::tmdb::tmdb_movie_detail(id.clone())
        .await
        .ok()
        .filter(|t| t.available);
    let card = render_movie_card(&detail, tmdb.as_ref());
    atomic_write(&dir.join(&file), card.as_bytes())?;

    Ok(AddResult {
        ok: true,
        series_path: Some(format!("{MOVIES_CATALOG}/{file}")),
        title: detail.name,
        // A film is one thing: no seasons, and the single "episode" is the film
        // itself, which the flat card does not enumerate.
        seasons: 0,
        episodes: 0,
        refused: None,
    })
}

/// Re-fetch a card's credits in place, leaving every other line alone.
///
/// This is the backfill path: a card written before the user had a TMDb key (or
/// before the credit fields existed at all) carries thin credits or none, and
/// re-adding the film is not an option -- it would throw away the watch status,
/// rating and local path the user has accumulated on it.
///
/// So this rewrites ONLY the keys `push_credits` owns (`CREDIT_KEYS`), splicing
/// the fresh block in where the old one was. Everything else in the frontmatter,
/// and the whole body, is untouched by construction.
#[tauri::command]
pub async fn movie_refresh_credits(path: String) -> Result<bool, VaultError> {
    let full = PathBuf::from(library_vault_root()).join(&path);
    let text = std::fs::read_to_string(&full)?;
    let Some(imdb) = frontmatter_value(&text, "IMDb ID") else {
        return Err(VaultError::Invalid(format!("{path} has no IMDb ID")));
    };

    // A show card takes the same refresh: same Cinemeta fields, same frontmatter
    // keys. Only the TMDb tier is film-only, so a show simply gets None -- one
    // command, rather than a second that would drift from this one.
    let kind = match frontmatter_value(&text, "Domain").as_deref() {
        Some("Movie") => "movie",
        _ => "series",
    };
    let detail = cinemeta_detail(kind.to_string(), imdb.clone()).await?;
    let tmdb = if kind == "movie" {
        crate::commands::tmdb::tmdb_movie_detail(imdb)
            .await
            .ok()
            .filter(|t| t.available)
    } else {
        None
    };

    let mut block = String::new();
    push_credits(&mut block, &detail, tmdb.as_ref());

    let updated = splice_credits(&text, &block);
    if updated == text {
        return Ok(false);
    }
    atomic_write(&full, updated.as_bytes())?;
    Ok(true)
}

/// A frontmatter scalar, with surrounding quotes stripped. Used for `IMDb ID`
/// (which the writers always quote) and `Domain` (which they never do); neither
/// is ever wrapped onto a second line.
fn frontmatter_value(text: &str, key: &str) -> Option<String> {
    let head = text.split("\n---").next()?;
    for line in head.lines() {
        if let Some(rest) = line.strip_prefix(key).and_then(|r| r.strip_prefix(": ")) {
            let v = rest.trim().trim_matches('"').trim();
            return (!v.is_empty()).then(|| v.to_string());
        }
    }
    None
}

/// Drop every `CREDIT_KEYS` line (and its list items) from the frontmatter, then
/// insert `block` where the first of them was -- or after `Director:` if the card
/// carried none, which is where the writers put them.
fn splice_credits(text: &str, block: &str) -> String {
    let Some(end) = text[3..].find("\n---").map(|i| i + 3) else {
        return text.to_string();
    };
    let (head, tail) = text.split_at(end);

    let mut out: Vec<String> = Vec::new();
    let mut insert_at: Option<usize> = None;
    let mut dropping = false;
    for line in head.lines() {
        // A list item under a dropped key. Any other indented line belongs to a
        // key we are keeping, so `dropping` is cleared by the next bare key.
        if dropping && line.starts_with("  - ") {
            continue;
        }
        let key = line.split_once(':').map(|(k, _)| k);
        if let Some(k) = key {
            dropping = CREDIT_KEYS.contains(&k);
            if dropping {
                insert_at.get_or_insert(out.len());
                continue;
            }
            if k == "Director" {
                // Fallback anchor: a card with no credit lines at all.
                if insert_at.is_none() {
                    out.push(line.to_string());
                    insert_at = Some(out.len());
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }

    let at = insert_at.unwrap_or(out.len());
    let fresh: Vec<String> = block.lines().map(str::to_string).collect();
    out.splice(at..at, fresh);
    format!("{}{}", out.join("\n"), tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(season: i64, episode: i64, name: &str, released: &str) -> CineEpisode {
        CineEpisode {
            season,
            episode,
            name: Some(name.to_string()),
            released: Some(released.to_string()),
            thumbnail: None,
            rating: None,
            overview: None,
        }
    }

    fn detail(episodes: Vec<CineEpisode>) -> CineDetail {
        CineDetail {
            imdb_id: "tt0903747".into(),
            kind: "series".into(),
            name: "Breaking Bad".into(),
            year: Some("2008–2013".into()),
            released: Some("2008-01-20T02:00:00.000Z".into()),
            status: Some("Ended".into()),
            runtime: Some("45 min".into()),
            description: Some("A chemistry teacher.".into()),
            imdb_rating: Some("9.5".into()),
            genres: vec!["Crime".into(), "Drama".into()],
            cast: vec!["Bryan Cranston".into(), "Aaron Paul".into()],
            director: vec!["Vince Gilligan".into()],
            writer: vec!["Vince Gilligan".into()],
            country: Some("United States".into()),
            poster: Some("https://p".into()),
            background: Some("https://b".into()),
            logo: None,
            trailer_youtube_id: Some("HhesaQXLuRY".into()),
            episodes,
            seasons: vec![],
            is_anime: false,
        }
    }

    #[test]
    fn season_zero_is_dropped_and_seasons_group() {
        let eps = vec![
            ep(0, 1, "Special", "2009-02-17T00:00:00.000Z"),
            ep(2, 1, "Seven Thirty-Seven", "2009-03-08T00:00:00.000Z"),
            ep(1, 2, "Cat's in the Bag", "2008-01-27T00:00:00.000Z"),
            ep(1, 1, "Pilot", "2008-01-20T00:00:00.000Z"),
        ];
        let grouped = by_season(&eps);
        assert_eq!(grouped.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(grouped[&1].len(), 2);
        assert_eq!(grouped[&1][0].episode, 1);
    }

    #[test]
    fn card_matches_what_series_rs_reads() {
        let d = detail(vec![
            ep(0, 1, "Special", "2009-02-17T00:00:00.000Z"),
            ep(1, 1, "Pilot", "2008-01-20T02:00:00.000Z"),
            ep(1, 2, "Cat's in the Bag", "2008-01-27T02:00:00.000Z"),
            ep(2, 1, "Seven Thirty-Seven", "2009-03-08T02:00:00.000Z"),
        ]);
        let seasons = by_season(&d.episodes);
        let card = render_card(&d, &seasons);

        // Frontmatter the reader keys off.
        assert!(card.contains("Domain: TV\n"));
        assert!(card.contains("Provider ID: 903747\n"));
        assert!(card.contains("IMDb ID: \"tt0903747\"\n"));
        assert!(card.contains("Seasons: 2\n"));
        assert!(card.contains("Episodes: 3\n"));
        assert!(card.contains("Year: 2008\n"));
        assert!(card.contains("Airing: false\n"));
        assert!(card.contains("Aired From: \"2008-01-20\"\n"));
        assert!(card.contains("Aired To: \"2009-03-08\"\n"));
        assert!(card.contains("Watched Episodes Season 2: []\n"));
        assert!(card.contains("Status Season 1: Plan-to-Watch\n"));

        // Credits: lists nest, a present scalar is quoted, a missing one is empty.
        assert!(card.contains("Cast:\n  - \"Bryan Cranston\"\n  - \"Aaron Paul\"\n"));
        assert!(card.contains("Writer:\n  - \"Vince Gilligan\"\n"));
        assert!(card.contains("Country: \"United States\"\n"));
        assert!(card.contains("Trailer: \"https://www.youtube.com/watch?v=HhesaQXLuRY\"\n"));
        assert!(card.contains("Logo: \"\"\n"));

        // Body: all-caps season H2s, dates truncated to the table's date form.
        assert!(card.contains("\n## SEASON 1\n"));
        assert!(card.contains("\n## SEASON 2\n"));
        assert!(!card.contains("SEASON 0"));
        assert!(card.contains("| 01 | Pilot | 2008-01-20 |\n"));
        assert!(!card.contains("T02:00:00"));

        // The reader must find exactly the two season sections, numbered from 1.
        let sections = crate::parsers::series::__test_sections(&card);
        assert_eq!(sections, vec!["Season 1".to_string(), "Season 2".to_string()]);
    }

    /// `splice_credits` rewrites a live card's frontmatter in place, so it gets
    /// checked in both directions: a card that already carries credit lines must
    /// have them REPLACED (never duplicated, never left stale), and a card that
    /// carries none must gain them after `Director:` -- with the body, the user's
    /// own fields, and the key order around them all untouched.
    #[test]
    fn splice_credits_replaces_in_place_and_leaves_everything_else() {
        let block = "Cast:\n  - \"New Name as Someone\"\nCountry: \"France\"\nBudget: 5\n";

        // 1. A card that already has credits, including a stale key the fresh
        //    block does not emit (`Logo`), which must NOT survive.
        let existing = "---\nTitle: \"X\"\nDirector: \"D\"\nCast:\n  - \"Old One\"\n  - \"Old Two\"\nCountry: \"United States\"\nLogo: \"http://old\"\nLocal Path: \"/v\"\nPersonal Rating: 7\n---\n\n## Plot\n\nA body with a Cast: word in it.\n";
        let out = splice_credits(existing, block);
        assert!(out.contains("Cast:\n  - \"New Name as Someone\"\n"), "{out}");
        assert!(!out.contains("Old One"), "stale list item survived: {out}");
        assert!(!out.contains("http://old"), "stale Logo survived: {out}");
        assert!(!out.contains("United States"), "stale Country survived: {out}");
        assert!(out.contains("Budget: 5\n"));
        // The user's own fields and the body are untouched.
        assert!(out.contains("Local Path: \"/v\"\n"));
        assert!(out.contains("Personal Rating: 7\n"));
        assert!(out.contains("\n## Plot\n\nA body with a Cast: word in it.\n"));
        // Credits land where they were, still ahead of Local Path.
        assert!(out.find("Cast:").unwrap() < out.find("Local Path:").unwrap());
        assert_eq!(out.matches("Country:").count(), 1);

        // 2. A card with no credit lines at all: they go in after Director.
        let bare = "---\nTitle: \"X\"\nDirector: \"D\"\nLocal Path: \"\"\n---\n\nbody\n";
        let out2 = splice_credits(bare, block);
        assert!(out2.find("Director:").unwrap() < out2.find("Cast:").unwrap(), "{out2}");
        assert!(out2.find("Cast:").unwrap() < out2.find("Local Path:").unwrap(), "{out2}");
        assert!(out2.ends_with("---\n\nbody\n"), "{out2}");
    }

    #[test]
    fn pipe_in_a_title_cannot_break_the_row() {
        let d = detail(vec![ep(1, 1, "Pipe | Dream", "2008-01-20T00:00:00.000Z")]);
        let card = render_card(&d, &by_season(&d.episodes));
        assert!(card.contains(r"| 01 | Pipe \| Dream | 2008-01-20 |"));
    }

    /// Live end-to-end: real Cinemeta over the network, a real card on disk, read
    /// back through the real `series.rs`. Ignored by default because it touches
    /// the network and writes a file; point it at a scratch vault, never the real
    /// Library:
    ///
    /// ```text
    /// AGENTIC_LIBRARY_VAULT_ROOT=<scratch> cargo test --lib     ///     tv_library::tests::live_add -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn live_add_breaking_bad_round_trips() {
        let root = std::env::var("AGENTIC_LIBRARY_VAULT_ROOT")
            .expect("point AGENTIC_LIBRARY_VAULT_ROOT at a scratch dir first");
        let rt = tokio::runtime::Runtime::new().unwrap();

        let added = rt
            .block_on(tv_add_to_library("tt0903747".into()))
            .expect("add failed");
        assert!(added.ok, "refused: {:?}", added.refused);
        let rel = added.series_path.clone().unwrap();
        println!("wrote {root}/{rel} — {} seasons, {} episodes", added.seasons, added.episodes);

        // A second add of the same show must refuse rather than duplicate.
        let again = rt.block_on(tv_add_to_library("tt0903747".into())).unwrap();
        assert!(!again.ok);
        assert_eq!(again.refused.as_ref().unwrap().reason, "already-in-tv");

        // Anime is refused by the Cinemeta flag, not by the catalog sweep.
        let frieren = rt.block_on(tv_add_to_library("tt22248376".into())).unwrap();
        assert_eq!(frieren.refused.as_ref().unwrap().reason, "anime");

        // The reader has to see it, with its seasons.
        let listed = crate::parsers::series::list_series("TV Shows").unwrap();
        let card = listed
            .iter()
            .find(|s| s.path == rel)
            .expect("card missing from list_series");
        assert!(card.franchise, "seasons did not switch the reader on");
        assert_eq!(card.season_names.as_ref().unwrap()[0], "Season 1");
        assert_eq!(card.episodes_total, Some(added.episodes));
        println!("list_series: {:?} / total {:?}", card.season_names, card.episodes_total);

        let full = crate::parsers::series::read_series(&rel).unwrap();
        let seasons = full.seasons.as_ref().expect("no seasons parsed");
        assert_eq!(seasons.len() as i64, added.seasons);
        for s in seasons {
            assert!(!s.episodes.is_empty(), "{} parsed no episodes", s.name);
            assert_eq!(s.episodes[0].n, 1, "{} does not start at episode 1", s.name);
        }
        println!(
            "read_series: {}",
            seasons
                .iter()
                .map(|s| format!("{} = {} eps", s.name, s.episodes.len()))
                .collect::<Vec<_>>()
                .join(", ")
        );

        // Ticking an episode has to land in that season's own list.
        let marked = crate::parsers::series::mark_episode_watched(&rel, 3, Some("Season 2"), None)
            .expect("mark failed");
        assert!(marked.watched_episodes.contains(&3), "S2E3 did not land: {:?}", marked.watched_episodes);
        println!("marked S2E3 → {:?}", marked.watched_episodes);
    }

    #[test]
    fn year_and_date_parsing() {
        assert_eq!(first_year(Some("2008–2013")), Some(2008));
        assert_eq!(first_year(Some("2008")), Some(2008));
        assert_eq!(first_year(Some("")), None);
        assert_eq!(iso_date(Some("2008-01-20T02:00:00.000Z")), "2008-01-20");
        assert_eq!(iso_date(Some("2008-01-20")), "2008-01-20");
        assert_eq!(iso_date(None), "");
        assert_eq!(numeric_id("tt0903747"), 903747);
    }
}
