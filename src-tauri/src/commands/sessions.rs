//! Sessions backend store (Planner Overhaul D5 / sub-plan 6).
//!
//! Sessions live HERE — in `<app_config>/sessions.json` — not in the daily-log
//! markdown. Schema:
//!   { "version":1, "migratedAt":"<iso>|null",
//!     "days": { "YYYY-MM-DD": [ {task,category,start,end,durMin,notes,type,createdAt} ] } }
//! - No stored `id`: it is computed on read as `HH:MM:::HH:MM:::task` — the
//!   content-derived key `blockPull.js` recomputes via `toHM` (padded HH:MM), so
//!   provider find-by-id and Planner undo matching survive with zero churn.
//! - `category == task` (bug-compatible with the legacy markdown writer).
//!
//! Mirrors `commands/sidebar.rs`'s store posture (const `Mutex`, `app_config_root`,
//! load→mutate→persist under lock, `atomic_write`). The `## Session Notes` H2 in
//! the daily .md is regenerated from this store after note-bearing mutations and
//! the new mtime is returned so the api can `rememberMtime()` it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::sidebar::app_config_root;
use crate::commands::vault::{atomic_write, mtime_ms, VaultError};
use crate::parsers::daily::{daily_path, today_str};
use crate::parsers::sessions::{normalize_hour, OkOut, RecentNote, Session, SessionInput};

/// Serializes load→mutate→persist across rapid writes (mirrors sidebar's WRITE_LOCK).
static SESSIONS_LOCK: Mutex<()> = Mutex::new(());

const STORE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StoredSession {
    pub task: String,
    pub category: String,
    pub start: String, // padded "HH:MM"
    pub end: String,   // padded "HH:MM" ("24:00" end-of-day sentinel preserved)
    #[serde(rename = "durMin")]
    pub dur_min: u32,
    #[serde(default)]
    pub notes: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Store {
    pub version: u32,
    #[serde(rename = "migratedAt", default, skip_serializing_if = "Option::is_none")]
    pub migrated_at: Option<String>,
    #[serde(default)]
    pub days: BTreeMap<String, Vec<StoredSession>>,
}

fn empty_store() -> Store {
    Store { version: STORE_VERSION, migrated_at: None, days: BTreeMap::new() }
}

/// AppConfig path. `pub` so SF3's boot migration can root the store the same way.
pub fn sessions_file(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(app_config_root(app)?.join("sessions.json"))
}

/// Load the store. Missing/corrupt → an empty store (logged; next write heals).
/// `pub` (not `pub(crate)`) so SF2's consumer repoint + SF3's migration + the
/// integration test can drive it with a bare `&Path` (no `AppHandle`).
pub fn load_store(path: &Path) -> Store {
    let Ok(text) = fs::read_to_string(path) else {
        return empty_store();
    };
    let mut store = match serde_json::from_str::<Store>(&text) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("sessions.json parse failed ({e}) — treating as empty; next write auto-heals");
            return empty_store();
        }
    };
    // Heal legacy midnight ends. A session ending exactly at midnight was
    // written as end "00:00" by the old create path (a `% 24` wrap on 1440),
    // which the renderer/timer read as start-of-day (0 mins) → a
    // negative-height sliver (the block visibly "disappeared"). The canonical
    // end-of-day sentinel is "24:00" (1440), which `duration_mins` already
    // treats as midnight, so durMin is unchanged. Rewrite in-memory; the next
    // mutating command persists the healed form (same auto-heal model above).
    for list in store.days.values_mut() {
        for s in list.iter_mut() {
            if s.end == "00:00" && s.start != "00:00" {
                s.end = "24:00".to_string();
            }
        }
    }
    store
}

pub fn persist_store(path: &Path, store: &Store) -> Result<(), VaultError> {
    let mut text = serde_json::to_string_pretty(store)
        .map_err(|e| VaultError::Io(format!("serialize sessions.json: {e}")))?;
    text.push('\n');
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| VaultError::Io(format!("mkdir {parent:?}: {e}")))?;
    }
    atomic_write(path, text.as_bytes())
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Pad "H:MM"/"HH:MM" → "HH:MM" so the computed id matches the frontend's `toHM`
/// (which `padStart(2,'0')`s). Leaves a non-`H:MM` string untouched (defensive).
fn pad_hm(s: &str) -> String {
    match s.split_once(':') {
        Some((h, m)) if !h.is_empty() && h.chars().all(|c| c.is_ascii_digit()) => {
            format!("{:0>2}:{}", h, m)
        }
        _ => s.to_string(),
    }
}

/// Content-derived id `HH:MM:::HH:MM:::task` on the padded stored strings — the
/// same string `blockPull.js` recomputes (`toHM(start):::toHM(end):::task`).
fn computed_id(s: &StoredSession) -> String {
    format!("{}:::{}:::{}", s.start, s.end, s.task)
}

fn note_bearing(s: &StoredSession) -> bool {
    !s.notes.trim().is_empty()
}

fn to_session(s: &StoredSession) -> Session {
    Session {
        id: computed_id(s),
        task: s.task.clone(),
        category: s.category.clone(),
        start: s.start.clone(),
        end: s.end.clone(),
        dur_min: s.dur_min,
        notes: s.notes.clone(),
        kind: s.kind.clone(),
    }
}

/// Minutes between padded HH:MM, wrapping past midnight (matches the legacy
/// `duration_mins`; "24:00" → 1440).
fn duration_mins(start: &str, end: &str) -> u32 {
    let parse = |s: &str| -> i64 {
        let mut it = s.splitn(2, ':');
        let h: i64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let m: i64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        h * 60 + m
    };
    let mut d = parse(end) - parse(start);
    if d < 0 {
        d += 24 * 60;
    }
    d.max(0) as u32
}

/// Lenient match of a stored record against a content-derived id, mirroring
/// `find_session_bullet`'s hour-normalized compare (tolerates padded vs un-padded
/// hour in the incoming id). A `false` on a malformed id IS the desync guard —
/// every mutating command returns `{ok:false,"Session not found"}` without
/// writing when no record matches.
fn session_matches(s: &StoredSession, id: &str) -> bool {
    let parts: Vec<&str> = id.split(":::").collect();
    if parts.len() < 3 {
        return false;
    }
    let Some((sh, sm)) = parts[0].split_once(':') else { return false };
    let Some((eh, em)) = parts[1].split_once(':') else { return false };
    let task = parts[2..].join(":::");
    let Some((ssh, ssm)) = s.start.split_once(':') else { return false };
    let Some((seh, sem)) = s.end.split_once(':') else { return false };
    normalize_hour(sh) == normalize_hour(ssh)
        && sm == ssm
        && normalize_hour(eh) == normalize_hour(seh)
        && em == sem
        && task == s.task
}

fn make_record(input: SessionInput, kind: &str, created_at: &str) -> StoredSession {
    let start = pad_hm(&input.start);
    let end = pad_hm(&input.end);
    StoredSession {
        dur_min: duration_mins(&start, &end),
        category: input.task.clone(), // bug-compatible: category == task
        task: input.task,
        start,
        end,
        notes: input.notes.unwrap_or_default().trim().to_string(),
        kind: kind.to_string(),
        created_at: created_at.to_string(),
    }
}

// ── inner fns (bare `&Path`, no AppHandle → unit-testable) ───────────────────

/// Sessions per day within `[from, to]` (inclusive, ISO string compare), as IPC
/// `Session`s (computed id). Days with no sessions are omitted.
pub fn get_range_inner(path: &Path, from: &str, to: &str) -> BTreeMap<String, Vec<Session>> {
    let store = load_store(path);
    let mut out = BTreeMap::new();
    for (ds, list) in store.days.iter() {
        if ds.as_str() >= from && ds.as_str() <= to && !list.is_empty() {
            out.insert(ds.clone(), list.iter().map(to_session).collect());
        }
    }
    out
}

pub fn append_inner(
    path: &Path,
    ds: &str,
    input: SessionInput,
    created_at: &str,
) -> Result<StoredSession, VaultError> {
    let _g = SESSIONS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(path);
    let rec = make_record(input, "focus", created_at);
    store.days.entry(ds.to_string()).or_default().push(rec.clone());
    persist_store(path, &store)?;
    Ok(rec)
}

/// `Ok(None)` = no record matched (desync). `Ok(Some(old))` = replaced; returns
/// the OLD record so the caller can decide whether the Session-Notes section
/// changed. `type`/`createdAt` are preserved from the old record.
pub fn update_inner(
    path: &Path,
    ds: &str,
    old_id: &str,
    input: SessionInput,
) -> Result<Option<StoredSession>, VaultError> {
    let _g = SESSIONS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(path);
    let Some(list) = store.days.get_mut(ds) else { return Ok(None) };
    let Some(pos) = list.iter().position(|s| session_matches(s, old_id)) else { return Ok(None) };
    let old = list[pos].clone();
    let mut rec = make_record(input, &old.kind, &old.created_at);
    rec.dur_min = duration_mins(&rec.start, &rec.end);
    list[pos] = rec;
    persist_store(path, &store)?;
    Ok(Some(old))
}

/// `Ok(None)` = no match (desync). `Ok(Some(removed))` = the removed record (for
/// the recycle bin). Prunes the day key when its list goes empty.
pub fn delete_inner(path: &Path, ds: &str, id: &str) -> Result<Option<StoredSession>, VaultError> {
    let _g = SESSIONS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(path);
    let Some(list) = store.days.get_mut(ds) else { return Ok(None) };
    let Some(pos) = list.iter().position(|s| session_matches(s, id)) else { return Ok(None) };
    let removed = list.remove(pos);
    if list.is_empty() {
        store.days.remove(ds);
    }
    persist_store(path, &store)?;
    Ok(Some(removed))
}

/// `Ok(None)` = no match (desync). `Ok(Some(updated))` = the record after setting
/// its note (empty `note` clears it).
pub fn update_note_inner(
    path: &Path,
    ds: &str,
    id: &str,
    note: &str,
) -> Result<Option<StoredSession>, VaultError> {
    let _g = SESSIONS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(path);
    let Some(list) = store.days.get_mut(ds) else { return Ok(None) };
    let Some(pos) = list.iter().position(|s| session_matches(s, id)) else { return Ok(None) };
    list[pos].notes = note.trim().to_string();
    let updated = list[pos].clone();
    persist_store(path, &store)?;
    Ok(Some(updated))
}

/// Insert a full record back into the store (recycle-bin restore path, SF2).
pub fn insert_inner(path: &Path, ds: &str, rec: StoredSession) -> Result<(), VaultError> {
    let _g = SESSIONS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(path);
    store.days.entry(ds.to_string()).or_default().push(rec);
    persist_store(path, &store)
}

/// Recent note-bearing sessions across days within the last `limit` days,
/// newest-first by `dateStr`+start. Keeps the legacy `RecentNote{session,dateStr,idx}`
/// shape; `idx` is the record's position within its day's array.
pub fn recent_notes_inner(path: &Path, limit: u32) -> Vec<RecentNote> {
    let store = load_store(path);
    let cutoff = (Local::now().date_naive() - chrono::Duration::days(limit as i64))
        .format("%Y-%m-%d")
        .to_string();
    let mut out: Vec<RecentNote> = Vec::new();
    for (ds, list) in store.days.iter() {
        if ds.as_str() < cutoff.as_str() {
            continue;
        }
        for (idx, s) in list.iter().enumerate() {
            if note_bearing(s) {
                out.push(RecentNote { session: to_session(s), date_str: ds.clone(), idx });
            }
        }
    }
    out.sort_by(|a, b| {
        let ak = format!("{}T{}", a.date_str, a.session.start);
        let bk = format!("{}T{}", b.date_str, b.session.start);
        bk.cmp(&ak)
    });
    out
}

// ── `## Session Notes` regen (the daily .md side) ────────────────────────────

/// Replace the `## Session Notes` section body with `bullets`, creating the
/// heading at its canonical slot (before `## Plan Fence`, else replacing a legacy
/// `## Sessions`, else EOF) when absent. Every other line is byte-preserved.
fn splice_session_notes(lines: &mut Vec<String>, bullets: &[String]) {
    let is_h2 = |l: &str| l.trim_start().starts_with("## ");
    let head = match lines.iter().position(|l| l.trim() == "## Session Notes") {
        Some(i) => i,
        None => {
            let at = lines
                .iter()
                .position(|l| l.trim() == "## Plan Fence")
                .or_else(|| {
                    lines.iter().position(|l| {
                        let t = l.trim();
                        t == "## Sessions" || t == "## Session" || t == "### Sessions"
                    })
                })
                .unwrap_or(lines.len());
            let mut ins = Vec::new();
            if at > 0 && !lines[at - 1].trim().is_empty() {
                ins.push(String::new());
            }
            let hpos = at + ins.len();
            ins.push("## Session Notes".to_string());
            ins.push(String::new());
            lines.splice(at..at, ins);
            hpos
        }
    };
    let mut body_end = head + 1;
    while body_end < lines.len() && !is_h2(&lines[body_end]) {
        body_end += 1;
    }
    let mut repl = vec![String::new()];
    repl.extend(bullets.iter().cloned());
    if !bullets.is_empty() {
        repl.push(String::new());
    }
    lines.splice(head + 1..body_end, repl);
}

/// Regenerate `ds`'s `## Session Notes` from the store and return the new md
/// mtime (so the api can `rememberMtime()` it). Bullets: `- HH:MM–HH:MM Task — note`
/// (en-dash between times; multi-line notes flattened with " / "). The section is
/// app-owned — hand-edits inside it are regenerated away.
///
/// ponytail: fresh read-modify-write right before the atomic_write keeps the
/// clobber window vs a concurrent plan-block edit minimal — the same posture as
/// the legacy session writers; a per-daily-file lock is the upgrade if it ever matters.
pub fn regen_session_notes(store_path: &Path, ds: &str) -> Result<f64, VaultError> {
    let store = load_store(store_path);
    let bullets = session_note_bullets(&store, ds);

    let p = daily_path(ds);
    let content = if p.exists() {
        fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?
    } else {
        String::new()
    };
    let mut lines: Vec<String> = content.split('\n').map(String::from).collect();
    splice_session_notes(&mut lines, &bullets);
    atomic_write(&p, lines.join("\n").as_bytes())?;
    Ok(fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0))
}

// ── commands (thin wrappers: resolve path → inner → regen-if-noted → emit) ───

/// App-config writes are invisible to the file watcher, so every mutation emits
/// `day` (+ `today` when `ds` is today) to drive `useVault`'s reload path.
fn emit_day(app: &AppHandle, ds: &str) {
    let _ = app.emit("day", ds.to_string());
    if ds == today_str() {
        let _ = app.emit("today", String::new());
    }
}

#[tauri::command]
pub fn sessions_get_range(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<BTreeMap<String, Vec<Session>>, VaultError> {
    let path = sessions_file(&app)?;
    Ok(get_range_inner(&path, &from, &to))
}

#[tauri::command]
pub fn sessions_append(app: AppHandle, ds: String, session: SessionInput) -> Result<OkOut, VaultError> {
    let path = sessions_file(&app)?;
    let created = Local::now().to_rfc3339();
    let rec = append_inner(&path, &ds, session, &created)?;
    let mtime = if note_bearing(&rec) { regen_session_notes(&path, &ds)? } else { 0.0 };
    emit_day(&app, &ds);
    Ok(OkOut { ok: true, error: None, mtime })
}

#[tauri::command]
pub fn sessions_update(
    app: AppHandle,
    ds: String,
    old_session_id: String,
    new_session: SessionInput,
) -> Result<OkOut, VaultError> {
    let path = sessions_file(&app)?;
    let new_has_note = new_session.notes.as_ref().is_some_and(|n| !n.trim().is_empty());
    match update_inner(&path, &ds, &old_session_id, new_session)? {
        None => Ok(OkOut { ok: false, error: Some("Session not found".into()), mtime: 0.0 }),
        Some(old) => {
            let mtime = if new_has_note || note_bearing(&old) {
                regen_session_notes(&path, &ds)?
            } else {
                0.0
            };
            emit_day(&app, &ds);
            Ok(OkOut { ok: true, error: None, mtime })
        }
    }
}

#[tauri::command]
pub fn sessions_delete(app: AppHandle, ds: String, session_id: String) -> Result<OkOut, VaultError> {
    let path = sessions_file(&app)?;
    match delete_inner(&path, &ds, &session_id)? {
        None => Ok(OkOut { ok: false, error: Some("Session not found".into()), mtime: 0.0 }),
        Some(removed) => {
            // Route the delete through the recycle bin (Planner source) for undo parity.
            let note = removed.notes.replace('\n', " / ");
            let bullet = if note.is_empty() {
                format!("- {}\u{2013}{} {}", removed.start, removed.end, removed.task)
            } else {
                format!("- {}\u{2013}{} {} \u{2014} {}", removed.start, removed.end, removed.task, note)
            };
            let _ = crate::commands::recycle_bin::trash_record(
                &app,
                crate::commands::recycle_bin::Source::Planner,
                crate::commands::recycle_bin::RestoreStrategy::SessionRecord,
                format!("{}\u{2013}{} {}", removed.start, removed.end, removed.task),
                Some(format!("{ds} \u{00b7} Session")),
                bullet.as_bytes(),
                crate::commands::recycle_bin::Payload::SessionRecord {
                    ds: ds.clone(),
                    session: removed.clone(),
                },
            );
            let mtime = if note_bearing(&removed) { regen_session_notes(&path, &ds)? } else { 0.0 };
            emit_day(&app, &ds);
            Ok(OkOut { ok: true, error: None, mtime })
        }
    }
}

#[tauri::command]
pub fn sessions_update_note(
    app: AppHandle,
    ds: String,
    session_id: String,
    note: String,
) -> Result<OkOut, VaultError> {
    let path = sessions_file(&app)?;
    match update_note_inner(&path, &ds, &session_id, &note)? {
        None => Ok(OkOut { ok: false, error: Some("Session not found".into()), mtime: 0.0 }),
        Some(_) => {
            // A note was set or cleared → the Session-Notes section changed.
            let mtime = regen_session_notes(&path, &ds)?;
            emit_day(&app, &ds);
            Ok(OkOut { ok: true, error: None, mtime })
        }
    }
}

// ── Migration (boot-time, one-shot) ─────────────────────────────────────────

/// Bullets for a day's note-bearing sessions: `- HH:MM–HH:MM Task — note`
/// (en-dash between times; multi-line notes flattened with " / ").
fn session_note_bullets(store: &Store, ds: &str) -> Vec<String> {
    store
        .days
        .get(ds)
        .map(|list| {
            list.iter()
                .filter(|s| note_bearing(s))
                .map(|s| {
                    let note = s.notes.replace('\n', " / ");
                    format!("- {}\u{2013}{} {} \u{2014} {}", s.start, s.end, s.task, note)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn session_to_stored(s: &Session) -> StoredSession {
    StoredSession {
        task: s.task.clone(),
        category: s.category.clone(),
        start: s.start.clone(),
        end: s.end.clone(),
        dur_min: s.dur_min,
        notes: s.notes.clone(),
        kind: s.kind.clone(),
        created_at: String::new(),
    }
}

fn is_iso_date(s: &str) -> bool {
    s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s[0..4].bytes().all(|b| b.is_ascii_digit())
        && s[5..7].bytes().all(|b| b.is_ascii_digit())
        && s[8..10].bytes().all(|b| b.is_ascii_digit())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), VaultError> {
    fs::create_dir_all(dst).map_err(|e| VaultError::Io(format!("backup mkdir {dst:?}: {e}")))?;
    for entry in fs::read_dir(src).map_err(|e| VaultError::Io(e.to_string()))?.flatten() {
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &dest)?;
        } else {
            fs::copy(&path, &dest).map_err(|e| VaultError::Io(format!("backup copy {path:?}: {e}")))?;
        }
    }
    Ok(())
}

/// Replace a legacy `## Sessions` section in place with `## Session Notes` (keeps
/// its slot), else ensure `## Session Notes` exists (all-logs-always).
fn migrate_session_notes(lines: &mut Vec<String>, bullets: &[String]) {
    let legacy = lines.iter().position(|l| {
        let t = l.trim();
        t == "## Sessions" || t == "## Session" || t == "### Sessions"
    });
    match legacy {
        Some(h) => {
            // Stop the legacy block at the next H2 OR a code fence — a bare ```plan
            // fence with no `## Plan Fence` heading (a malformed log) must survive.
            let mut body_end = h + 1;
            while body_end < lines.len() {
                let t = lines[body_end].trim_start();
                if t.starts_with("## ") || t.starts_with("```") {
                    break;
                }
                body_end += 1;
            }
            let mut repl = vec!["## Session Notes".to_string(), String::new()];
            repl.extend(bullets.iter().cloned());
            if !bullets.is_empty() {
                repl.push(String::new());
            }
            lines.splice(h..body_end, repl);
        }
        None => splice_session_notes(lines, bullets),
    }
}

/// One-shot boot migration: move sessions out of the daily-log markdown into
/// `sessions.json`, backing up the whole Daily Logs dir first, count-verifying per
/// day before any strip, and aborting losslessly (delete the store, leave the md
/// untouched) on any mismatch. Idempotent: a no-op once `sessions.json` exists.
/// MUST run after `init_active_vault` (pulse root resolved) and before
/// `watcher::spawn` (the strips won't storm events).
pub fn migrate_from_markdown(app: &AppHandle) -> Result<bool, VaultError> {
    let store_path = sessions_file(app)?;
    if store_path.exists() {
        return Ok(false); // already migrated
    }
    let logs_dir = match daily_path("0000-00-00").parent() {
        Some(d) => d.to_path_buf(),
        None => return Err(VaultError::Invalid("no daily-logs dir".into())),
    };
    let now = Local::now();
    if !logs_dir.exists() {
        // No logs at all — seed an empty migrated store and finish.
        persist_store(
            &store_path,
            &Store { version: STORE_VERSION, migrated_at: Some(now.to_rfc3339()), days: BTreeMap::new() },
        )?;
        return Ok(true);
    }

    // 1. Backup the entire Daily Logs dir (outside the watched vault). Abort on failure.
    let backup_dir = app_config_root(app)?
        .join("backups")
        .join(format!("daily-logs-{}", now.format("%Y%m%d-%H%M%S")));
    copy_dir_all(&logs_dir, &backup_dir)?;

    // 2. Parse every iso-date log into the store.
    let mut store = Store { version: STORE_VERSION, migrated_at: Some(now.to_rfc3339()), days: BTreeMap::new() };
    let mut parsed_counts: Vec<(String, usize)> = Vec::new();
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&logs_dir).map_err(|e| VaultError::Io(e.to_string()))?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if !is_iso_date(stem) {
            continue;
        }
        let content = fs::read_to_string(&path).unwrap_or_default();
        let recs: Vec<StoredSession> =
            crate::parsers::sessions::parse_sessions(&content).iter().map(session_to_stored).collect();
        if !recs.is_empty() {
            parsed_counts.push((stem.to_string(), recs.len()));
            store.days.insert(stem.to_string(), recs);
        }
        files.push((stem.to_string(), path));
    }

    // 3. Write the store, then count-verify per day BEFORE any strip.
    persist_store(&store_path, &store)?;
    let loaded = load_store(&store_path);
    for (ds, pc) in &parsed_counts {
        let sc = loaded.days.get(ds).map(|v| v.len()).unwrap_or(0);
        if sc != *pc {
            let _ = fs::remove_file(&store_path);
            log::error!(
                "sessions migration count mismatch {ds}: parsed {pc} != stored {sc}; aborting, daily logs left intact (backup {backup_dir:?})"
            );
            return Err(VaultError::Invalid(format!("sessions migration count mismatch for {ds}")));
        }
    }

    // 4. Strip `## Sessions` → `## Session Notes` (body from the store) in each log.
    for (ds, path) in &files {
        let content = fs::read_to_string(path).unwrap_or_default();
        let mut lines: Vec<String> = content.split('\n').map(String::from).collect();
        let bullets = session_note_bullets(&store, ds);
        migrate_session_notes(&mut lines, &bullets);
        atomic_write(path, lines.join("\n").as_bytes())?;
    }
    log::info!(
        "sessions migration complete: {} day(s) with sessions, {} log(s) swept (backup {backup_dir:?})",
        store.days.len(),
        files.len()
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_store_path() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("mp-sessions-test-{}-{}.json", std::process::id(), n))
    }

    fn input(task: &str, start: &str, end: &str, notes: Option<&str>) -> SessionInput {
        SessionInput {
            task: task.into(),
            start: start.into(),
            end: end.into(),
            notes: notes.map(String::from),
        }
    }

    #[test]
    fn load_store_heals_legacy_midnight_end() {
        let p = temp_store_path();
        // The old create path wrote a midnight end as "00:00" (a `% 24` wrap on
        // 1440), which the renderer/timer read as start-of-day (0 mins) → the
        // block drew as a negative-height sliver and visibly "disappeared".
        append_inner(&p, "2026-07-23", input("Coaching", "23:00", "00:00", None), "ts").unwrap();
        // durMin was always correct on disk (duration_mins wraps past midnight):
        assert_eq!(load_store(&p).days["2026-07-23"][0].dur_min, 60);
        // load_store rewrites the end to the canonical "24:00" sentinel in-memory.
        let s = &load_store(&p).days["2026-07-23"][0];
        assert_eq!(s.end, "24:00");
        assert_eq!(s.dur_min, 60); // unchanged — duration_mins treats 24:00 as midnight too
        // A session that merely *starts* at 00:00 keeps its real end (untouched).
        append_inner(&p, "2026-07-23", input("Early", "00:00", "00:30", None), "ts").unwrap();
        let day = &load_store(&p).days["2026-07-23"];
        assert_eq!(day.iter().find(|s| s.task == "Early").unwrap().end, "00:30");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn append_get_range_and_computed_id() {
        let p = temp_store_path();
        append_inner(&p, "2026-06-30", input("Write Plan", "09:00", "10:30", None), "ts").unwrap();
        append_inner(&p, "2026-06-30", input("Review", "11:00", "11:25", Some("good")), "ts").unwrap();
        let map = get_range_inner(&p, "2026-06-01", "2026-06-30");
        let day = map.get("2026-06-30").unwrap();
        assert_eq!(day.len(), 2);
        assert_eq!(day[0].id, "09:00:::10:30:::Write Plan"); // computed, padded
        assert_eq!(day[0].category, "Write Plan"); // bug-compatible: category == task
        assert_eq!(day[0].dur_min, 90);
        assert_eq!(day[1].notes, "good");
        assert!(get_range_inner(&p, "2026-07-01", "2026-07-31").is_empty()); // out of range
        let store = load_store(&p);
        assert_eq!(store.version, 1);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn update_delete_note_and_desync() {
        let p = temp_store_path();
        append_inner(&p, "2026-06-30", input("A", "09:00", "10:00", None), "ts").unwrap();
        // update — lenient un-padded id match ("9:00" matches stored "09:00")
        assert!(update_inner(&p, "2026-06-30", "9:00:::10:00:::A", input("A2", "09:00", "10:15", None))
            .unwrap()
            .is_some());
        let day = get_range_inner(&p, "2026-06-30", "2026-06-30").remove("2026-06-30").unwrap();
        assert_eq!(day[0].task, "A2");
        assert_eq!(day[0].id, "09:00:::10:15:::A2");
        // desync — a non-matching id returns None and writes nothing
        assert!(update_inner(&p, "2026-06-30", "00:00:::00:00:::ghost", input("x", "0:00", "0:01", None))
            .unwrap()
            .is_none());
        // note set
        assert!(update_note_inner(&p, "2026-06-30", "09:00:::10:15:::A2", "hello").unwrap().is_some());
        assert_eq!(get_range_inner(&p, "2026-06-30", "2026-06-30")["2026-06-30"][0].notes, "hello");
        // delete returns the record and prunes the empty day
        assert!(delete_inner(&p, "2026-06-30", "09:00:::10:15:::A2").unwrap().is_some());
        assert!(get_range_inner(&p, "2026-06-30", "2026-06-30").is_empty());
        assert!(delete_inner(&p, "2026-06-30", "09:00:::10:15:::A2").unwrap().is_none()); // gone
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn migrate_session_notes_replaces_in_place() {
        let mut lines: Vec<String> = "## Upcoming\n\n## Sessions\n\n- old bullet\n\n## Plan Fence\n"
            .split('\n')
            .map(String::from)
            .collect();
        migrate_session_notes(&mut lines, &["- new note bullet".to_string()]);
        let out = lines.join("\n");
        assert!(out.contains("## Session Notes"));
        assert!(!out.contains("## Sessions"));
        assert!(out.contains("- new note bullet"));
        assert!(!out.contains("- old bullet")); // legacy session data dropped from md
        let h2: Vec<&str> = out.lines().filter(|l| l.starts_with("## ")).collect();
        assert_eq!(h2, vec!["## Upcoming", "## Session Notes", "## Plan Fence"]); // slot + order kept
    }

    #[test]
    fn migrate_session_notes_inserts_when_absent() {
        let mut lines: Vec<String> =
            "## Upcoming\n\n## Plan Fence\n".split('\n').map(String::from).collect();
        migrate_session_notes(&mut lines, &[]); // empty day still gets the section (all-logs-always)
        let joined = lines.join("\n");
        let h2: Vec<&str> = joined.lines().filter(|l| l.starts_with("## ")).collect();
        assert_eq!(h2, vec!["## Upcoming", "## Session Notes", "## Plan Fence"]);
    }

    #[test]
    fn migrate_session_notes_preserves_trailing_fence() {
        // Malformed log: a bare ```plan fence with no `## Plan Fence` heading.
        let mut lines: Vec<String> = "## Upcoming\n\n## Sessions\n\n```plan\n```\n"
            .split('\n')
            .map(String::from)
            .collect();
        migrate_session_notes(&mut lines, &[]);
        let out = lines.join("\n");
        assert!(out.contains("## Session Notes"));
        assert!(out.contains("```plan")); // the bare fence is NOT consumed
        assert!(!out.contains("## Sessions"));
    }
}
