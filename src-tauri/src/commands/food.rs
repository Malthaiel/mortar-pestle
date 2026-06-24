//! Offline USDA FoodData Central food search (Health Column epic, sub-plan 2).
//!
//! Read-only queries against the bundled `resources/usda_foods.db` (built by
//! `scripts/build_fdc_db.py`): an FTS5 search + a per-food nutrient fetch. The
//! DB stores per-100g amounts already projected to canonical snake_case keys +
//! a canonical unit per row (the nutrient-id -> key map lives in the builder),
//! so these commands just pass `{key, amount, unit}` through — no nutrient-id
//! map at runtime, no unit conversion.
//!
//! No network, no keyring. Opened READ-ONLY (browser.rs precedent); queries run
//! in `spawn_blocking`. The DB path resolves bundled-first with a dev source
//! fallback (anime_download.rs precedent).

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct FoodHit {
    pub fdc_id: i64,
    pub description: String,
    pub data_type: String,
}

#[derive(Serialize)]
pub struct Nutrient {
    pub key: String,
    pub amount: f64,
    pub unit: String,
}

#[derive(Serialize)]
pub struct FoodDetail {
    pub fdc_id: i64,
    pub description: String,
    pub data_type: String,
    /// Per-100g nutrients, canonical keys. Absent micros are simply missing
    /// (the UI renders "not reported", never 0).
    pub nutrients: Vec<Nutrient>,
}

/// Resolve the bundled food DB: Tauri resource dir first, dev source fallback.
fn resolve_db(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app
        .path()
        .resolve("resources/usda_foods.db", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let dev = home.join("Code/iskariel/src-tauri/resources/usda_foods.db");
        if dev.exists() {
            return Some(dev);
        }
    }
    None
}

fn open_ro(app: &AppHandle) -> Result<Connection, String> {
    let db = resolve_db(app).ok_or("usda_foods.db not found (run scripts/build_fdc_db.py)")?;
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    Ok(conn)
}

/// Turn raw user text into a safe FTS5 prefix MATCH: keep alphanumerics only
/// (so no FTS5 operator/quote can be injected), make each token a prefix term,
/// AND them together. Empty when the query has no usable tokens.
fn fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .map(|t| t.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| format!("{t}*"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
pub async fn usda_food_search(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FoodHit>, String> {
    let lim = limit.unwrap_or(40).min(200) as i64;
    tauri::async_runtime::spawn_blocking(move || {
        let q = fts_query(&query);
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = open_ro(&app)?;
        // Generics (foundation / sr_legacy) sort above branded, then BM25 rank.
        let mut stmt = conn
            .prepare(
                "SELECT f.fdc_id, f.description, f.data_type \
                 FROM foods_fts \
                 JOIN foods f ON f.fdc_id = foods_fts.rowid \
                 WHERE foods_fts MATCH ?1 \
                 ORDER BY (f.data_type = 'branded_food'), rank \
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![q, lim], |r| {
                Ok(FoodHit {
                    fdc_id: r.get(0)?,
                    description: r.get(1)?,
                    data_type: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usda_food(app: AppHandle, fdc_id: i64) -> Result<FoodDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_ro(&app)?;
        let (description, data_type): (String, String) = conn
            .query_row(
                "SELECT description, data_type FROM foods WHERE fdc_id = ?1",
                rusqlite::params![fdc_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT key, amount, unit FROM food_nutrients WHERE fdc_id = ?1")
            .map_err(|e| e.to_string())?;
        let nutrients = stmt
            .query_map(rusqlite::params![fdc_id], |r| {
                Ok(Nutrient { key: r.get(0)?, amount: r.get(1)?, unit: r.get(2)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(FoodDetail { fdc_id, description, data_type, nutrients })
    })
    .await
    .map_err(|e| e.to_string())?
}
