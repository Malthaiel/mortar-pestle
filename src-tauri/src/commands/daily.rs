//! Sub-feature 3 — Daily readers + parser foundation.
//! Sub-feature 3.5 — Daily writers + mtime-conflict safety.
//!
//! Wraps `crate::parsers::*` in `#[tauri::command]` bindings. Reader JSON is
//! byte-equivalent to the corresponding Fastify endpoints during the parallel
//! period (diffed via `tests/daily_parity.rs`). Writers persist byte-identical
//! `.md` content (diffed via `tests/daily_writers.rs`).

use std::fs;

use tauri::AppHandle;

use crate::commands::recycle_bin;
use crate::commands::vault::{atomic_write, resolve_in, RootKind, VaultError};
use crate::parsers::daily::{
    read_daily_note, read_unorganized_items, today_str, update_plan_block, DailyNote,
    PlanBlockInput, UnorganizedOut,
};
use crate::parsers::projects::{list_projects, ProjectsOut};
use crate::parsers::quick_notes;
use crate::parsers::routine::{
    read_routine_for_today, toggle_routine_task, RoutineItem, RoutineWriteOut,
};
use crate::parsers::sessions::{
    append_freeform_note, append_session, delete_session, read_recent_notes, update_session,
    update_session_note_text, OkOut, RecentNote, SessionInput,
};
use crate::parsers::tasks::{toggle_today_task, TasksOut};
use serde::Serialize;

#[derive(Serialize)]
pub struct RoutineOut {
    pub items: Vec<RoutineItem>,
}

#[derive(Serialize)]
pub struct RecentNotesOut {
    pub notes: Vec<RecentNote>,
}

#[tauri::command]
pub fn daily_get_today() -> DailyNote {
    read_daily_note(&today_str())
}

#[tauri::command]
pub fn daily_get_routine() -> RoutineOut {
    RoutineOut {
        items: read_routine_for_today(),
    }
}

#[tauri::command]
pub fn daily_get_recent_notes(limit: Option<u32>) -> RecentNotesOut {
    let limit = limit.unwrap_or(30).clamp(1, 120);
    RecentNotesOut {
        notes: read_recent_notes(limit),
    }
}

#[tauri::command]
pub fn daily_list_projects() -> ProjectsOut {
    list_projects()
}

/// Planner "Unorganized Notes" pane — all unorganized quick-note bullets and
/// unchecked tasks across every daily log except today (see
/// `parsers::daily::read_unorganized_items`).
#[tauri::command]
pub fn daily_get_unorganized() -> UnorganizedOut {
    read_unorganized_items()
}

// ── Sub-feature 3.5 writers ─────────────────────────────────────────────────

#[tauri::command]
pub fn daily_toggle_task(
    raw_line: String,
    base_mtime: Option<f64>,
) -> Result<TasksOut, VaultError> {
    toggle_today_task(&raw_line, base_mtime)
}

#[tauri::command]
pub fn daily_toggle_routine(
    task: String,
    base_mtime: Option<f64>,
) -> Result<RoutineWriteOut, VaultError> {
    toggle_routine_task(&task, base_mtime)
}

#[tauri::command]
pub fn daily_append_session(
    ds: String,
    session: SessionInput,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    append_session(&ds, session, base_mtime)
}

#[tauri::command]
pub fn daily_update_session(
    ds: String,
    old_session_id: String,
    new_session: SessionInput,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    update_session(&ds, &old_session_id, new_session, base_mtime)
}

#[tauri::command]
pub fn daily_update_plan_block(
    ds: String,
    old_block: PlanBlockInput,
    new_block: PlanBlockInput,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    update_plan_block(&ds, old_block, new_block, base_mtime)
}

#[tauri::command]
pub fn daily_delete_session(
    app: AppHandle,
    ds: String,
    session_id: String,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    let out = delete_session(&ds, &session_id, base_mtime)?;
    if out.ok {
        if let (Some(block), Some(hint), Some(heading)) =
            (out.removed_block.as_ref(), out.line_hint, out.heading.as_ref())
        {
            // Capture the drained session block to the recycling bin (Planner
            // source). Best-effort — the session is already gone as the user asked.
            let _ = recycle_bin::trash_record(
                &app,
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
    Ok(OkOut {
        ok: out.ok,
        error: out.error,
        mtime: out.mtime,
    })
}

// ── Pulse quick-note soft-delete (routes through the recycling bin) ──────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteOut {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Trim a bullet to a bin-row label: drop the leading `- `, cap the length.
/// Char-safe (never slices a multi-byte boundary). Shared by the record-backed
/// delete surfaces.
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

/// Soft-delete a `## Quick Notes` bullet: capture the raw line into the
/// recycling bin, then remove it from the daily log. The text stale-guard
/// (ported from `locateQuickNotesBullet`) turns a desynced `index` into a safe
/// no-op instead of deleting the wrong line.
#[tauri::command]
pub fn pulse_note_delete(
    app: AppHandle,
    ds: String,
    index: u32,
    text: String,
) -> Result<NoteDeleteOut, VaultError> {
    let file_rel = format!("Pulse/Daily Logs/{ds}.md");
    let (_, abs) = resolve_in(&file_rel, RootKind::from_opt(Some("pulse")))?;
    let content = fs::read_to_string(&abs).map_err(|_| VaultError::NotFound(file_rel.clone()))?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let line_idx = match quick_notes::locate_quick_note(&lines, index as usize, &text) {
        Ok(i) => i,
        Err(e) => {
            return Ok(NoteDeleteOut {
                ok: false,
                reason: Some(e.code().to_string()),
            })
        }
    };

    let removed_line = lines[line_idx].clone();
    // Capture-before-destroy: the tombstone exists before the line is removed.
    let _ = recycle_bin::trash_record(
        &app,
        recycle_bin::Source::Pulse,
        recycle_bin::RestoreStrategy::RecordBlock,
        record_label(&removed_line),
        Some(format!("{ds} · ## Quick Notes")),
        removed_line.as_bytes(),
        recycle_bin::Payload::RecordBlock {
            root: Some("pulse".into()),
            file_rel: file_rel.clone(),
            section_heading: "## Quick Notes".into(),
            line_hint: Some(line_idx as u32),
        },
    );

    lines.remove(line_idx);
    atomic_write(&abs, lines.join("\n").as_bytes())?;
    Ok(NoteDeleteOut { ok: true, reason: None })
}

#[tauri::command]
pub fn daily_update_session_note(
    ds: String,
    session_id: String,
    note: String,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    update_session_note_text(&ds, &session_id, &note, base_mtime)
}

#[tauri::command]
pub fn daily_append_freeform_note(
    text: String,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    append_freeform_note(&text, base_mtime)
}
