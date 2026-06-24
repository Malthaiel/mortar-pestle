//! Health Column commands — one per-day op-dispatch writer + a Library folder
//! lister (Health Column epic, sub-plan 3 Nutrition).
//!
//! `daily_health_op` is the SINGLE write surface for every per-day health
//! mutation (caps the 3-place registration tax vs. ~15 per-action commands).
//! All day reads and all Library page CRUD stay JS-side
//! (`vault_read_file`/`vault_write_file`, `root:'pulse'`/`'library'`).
//!
//! Health Library pages live at `Health/{Meals,Supplements,Goals}/<name>.md`
//! under the Library vault (`library_vault_root()` already ends in `/Library`,
//! so the rel path carries NO `Library/` prefix — same convention as
//! `series.rs`'s `Anime/Catalog`).

use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::recycle_bin;
use crate::commands::vault::{library_vault_root, VaultError};
use crate::parsers::health::{
    delete_cardio, delete_meal_log, delete_workout, edit_cardio, edit_meal_log, edit_workout,
    log_cardio, log_meal, log_workout, CardioLogEntry, CardioTarget, DeleteMealOut, ExerciseLog,
    MealLogEntry, MealTarget, WorkoutLogEntry,
};
use crate::parsers::sessions::OkOut;

/// Bin-row label from a bullet line (drop leading `- `, cap length, char-safe).
/// Local copy of `daily::record_label` (which is private to that module).
fn record_label(raw_line: &str) -> String {
    let body = raw_line.trim().trim_start_matches('-').trim();
    const MAX: usize = 60;
    if body.chars().count() <= MAX {
        body.to_string()
    } else {
        let head: String = body.chars().take(MAX - 1).collect();
        format!("{head}…")
    }
}

#[derive(Deserialize)]
struct EditPayload {
    target: MealTarget,
    entry: MealLogEntry,
}

#[derive(Deserialize)]
struct EditWorkoutPayload {
    index: usize,
    exercise: ExerciseLog,
}

#[derive(Deserialize)]
struct EditCardioPayload {
    index: usize,
    entry: CardioLogEntry,
}

#[derive(Deserialize)]
struct DeleteCardioPayload {
    index: usize,
    target: CardioTarget,
}

/// Best-effort recycle-bin capture of a drained health block (shared by the
/// meal / workout / cardio delete arms). No-op unless the delete succeeded and
/// produced a block — the row is already gone as the user asked, so a bin
/// failure never fails the delete.
fn capture_to_bin(app: &AppHandle, ds: &str, out: &DeleteMealOut) {
    if !out.ok {
        return;
    }
    if let (Some(block), Some(hint), Some(heading)) =
        (out.removed_block.as_ref(), out.line_hint, out.heading.as_ref())
    {
        let _ = recycle_bin::trash_record(
            app,
            recycle_bin::Source::Planner,
            recycle_bin::RestoreStrategy::RecordBlock,
            record_label(block.lines().next().unwrap_or("")),
            Some(format!("{ds} · {heading}")),
            block.as_bytes(),
            recycle_bin::Payload::RecordBlock {
                root: Some("pulse".into()),
                file_rel: format!("Pulse/Daily Logs/{ds}.md"),
                section_heading: heading.clone(),
                line_hint: Some(hint),
            },
        );
    }
}

/// Op-dispatch for every per-day health write. `op` selects the action; the flat
/// `payload` is op-specific JSON (NOT a serde-tagged enum — JS ergonomics).
/// Mirrors the session-writer contract: `check_mtime` first (inside the parser
/// fns), `OkOut{ok,error,mtime}` back, `ok:false` (never a throw) on
/// conflict/desync, atomic write. Deletes capture the drained block to the
/// recycling bin (Planner source) — capture-before-destroy, best-effort.
#[tauri::command]
pub fn daily_health_op(
    app: AppHandle,
    ds: String,
    op: String,
    payload: Value,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    match op.as_str() {
        "log_meal" => {
            let entry: MealLogEntry = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("log_meal payload: {e}")))?;
            log_meal(&ds, entry, base_mtime)
        }
        "edit_meal_log" => {
            let p: EditPayload = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("edit_meal_log payload: {e}")))?;
            edit_meal_log(&ds, p.target, p.entry, base_mtime)
        }
        "delete_meal_log" => {
            let target: MealTarget = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("delete_meal_log payload: {e}")))?;
            let out = delete_meal_log(&ds, target, base_mtime)?;
            capture_to_bin(&app, &ds, &out);
            Ok(OkOut {
                ok: out.ok,
                error: out.error,
                mtime: out.mtime,
            })
        }
        "log_workout" => {
            let entry: WorkoutLogEntry = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("log_workout payload: {e}")))?;
            log_workout(&ds, entry, base_mtime)
        }
        "edit_workout" => {
            let p: EditWorkoutPayload = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("edit_workout payload: {e}")))?;
            edit_workout(&ds, p.index, p.exercise, base_mtime)
        }
        "delete_workout" => {
            let out = delete_workout(&ds, base_mtime)?;
            capture_to_bin(&app, &ds, &out);
            Ok(OkOut {
                ok: out.ok,
                error: out.error,
                mtime: out.mtime,
            })
        }
        "log_cardio" => {
            let entry: CardioLogEntry = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("log_cardio payload: {e}")))?;
            log_cardio(&ds, entry, base_mtime)
        }
        "edit_cardio" => {
            let p: EditCardioPayload = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("edit_cardio payload: {e}")))?;
            edit_cardio(&ds, p.index, p.entry, base_mtime)
        }
        "delete_cardio" => {
            let p: DeleteCardioPayload = serde_json::from_value(payload)
                .map_err(|e| VaultError::Invalid(format!("delete_cardio payload: {e}")))?;
            let out = delete_cardio(&ds, p.index, p.target, base_mtime)?;
            capture_to_bin(&app, &ds, &out);
            Ok(OkOut {
                ok: out.ok,
                error: out.error,
                mtime: out.mtime,
            })
        }
        other => Err(VaultError::Invalid(format!("unknown health op: {other}"))),
    }
}

/// List `.md` page filenames under `Health/<sub>/` in the Library vault (`sub` ∈
/// {"Meals","Supplements","Goals"}). Library *listing* has no shared IPC (create/
/// rename/delete already accept `root:'library'`). NotFound → empty (folders are
/// created lazily on first save). `sub` is sanitized to a single path segment.
#[tauri::command]
pub fn health_list_dir(sub: String) -> Result<Vec<String>, VaultError> {
    if sub.is_empty() || sub.contains('/') || sub.contains('\\') || sub.contains("..") {
        return Err(VaultError::Invalid(format!("bad health subfolder: {sub}")));
    }
    let dir = std::path::PathBuf::from(library_vault_root())
        .join("Health")
        .join(&sub);
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(VaultError::Io(e.to_string())),
    };
    let mut names: Vec<String> = read
        .flatten()
        .filter_map(|ent| {
            let name = ent.file_name().to_string_lossy().into_owned();
            (name.ends_with(".md") && !name.starts_with('.')).then_some(name)
        })
        .collect();
    names.sort();
    Ok(names)
}
