//! Sessions parser + 5 session writers (+ freeform-note writer).
//! Ports `parseSessions` / `readRecentNotes` / `appendSession` /
//! `updateSession` / `deleteSession` / `updateSessionNoteText` /
//! `appendFreeformNote` from the Node side.

use std::fs;
use std::sync::OnceLock;

use chrono::{Duration, Local};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, VaultError};
use crate::parsers::daily::{daily_path, escape_regex, fmt_local_hhmm, today_str};

#[derive(Serialize, Debug, Clone)]
pub struct Session {
    pub id: String,
    pub task: String,
    pub category: String,
    pub start: String,
    pub end: String,
    #[serde(rename = "durMin")]
    pub dur_min: u32,
    pub notes: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Debug)]
pub struct RecentNote {
    #[serde(flatten)]
    pub session: Session,
    #[serde(rename = "dateStr")]
    pub date_str: String,
    pub idx: usize,
}

pub fn parse_sessions(content: &str) -> Vec<Session> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // Em-dash (U+2013) separator, matches Node.
        Regex::new(r"^- (\d{1,2}):(\d{2})\u{2013}(\d{1,2}):(\d{2})\s+(.+?)\s+\((.+?),\s*(\d+)m\)$")
            .unwrap()
    });
    let lines: Vec<&str> = content.split('\n').collect();
    let mut sessions = Vec::new();
    let mut in_section = false;
    let mut i = 0;
    while i < lines.len() {
        let trim = lines[i].trim();
        if trim == "## Sessions" || trim == "## Session" || trim == "### Sessions" {
            in_section = true;
            i += 1;
            continue;
        }
        if !in_section {
            i += 1;
            continue;
        }
        if trim.starts_with("## ") && trim != "## Session" && trim != "## Sessions" {
            in_section = false;
            i += 1;
            continue;
        }
        if let Some(m) = re.captures(lines[i]) {
            let sh = &m[1];
            let sm = &m[2];
            let eh = &m[3];
            let em = &m[4];
            let task = m[5].to_string();
            let category = m[6].to_string();
            let dur_min: u32 = m[7].parse().unwrap_or(0);
            // Collect indented sub-note lines.
            let mut notes = String::new();
            let mut j = i + 1;
            while j < lines.len()
                && lines[j].starts_with("  ")
                && !lines[j].trim().starts_with("- ")
            {
                if !notes.is_empty() {
                    notes.push('\n');
                }
                notes.push_str(lines[j].trim());
                j += 1;
            }
            sessions.push(Session {
                id: format!("{}:{}:::{}:{}:::{}", sh, sm, eh, em, task),
                task: task.trim().to_string(),
                category: category.trim().to_string(),
                start: format!("{:0>2}:{}", sh, sm),
                end: format!("{:0>2}:{}", eh, em),
                dur_min,
                notes,
                kind: "focus".to_string(),
            });
        }
        i += 1;
    }
    sessions
}

#[derive(Deserialize, Debug)]
pub struct SessionInput {
    pub task: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct OkOut {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub mtime: f64,
}

/// `delete_session`'s richer return: the `OkOut` fields plus the drained block
/// (for recycling-bin capture). Internal — the command wrapper maps it back to
/// `OkOut` so the frontend contract is unchanged.
#[derive(Debug)]
pub struct DeleteSessionOut {
    pub ok: bool,
    pub error: Option<String>,
    pub mtime: f64,
    /// The drained session block (bullet + indented sub-notes), verbatim — the
    /// faithful bin copy. `None` when nothing was deleted.
    pub removed_block: Option<String>,
    /// The bullet's line index at delete time (restore placement hint).
    pub line_hint: Option<u32>,
    /// The section heading the bullet lived under (canonical or legacy variant).
    pub heading: Option<String>,
}

fn duration_mins(start: &str, end: &str) -> Result<i64, VaultError> {
    let parse = |s: &str| -> Result<(i64, i64), VaultError> {
        let parts: Vec<&str> = s.splitn(2, ':').collect();
        if parts.len() != 2 {
            return Err(VaultError::Invalid(format!("Bad HH:MM: {}", s)));
        }
        let h: i64 = parts[0]
            .parse()
            .map_err(|_| VaultError::Invalid(format!("Bad hour: {}", parts[0])))?;
        let m: i64 = parts[1]
            .parse()
            .map_err(|_| VaultError::Invalid(format!("Bad minute: {}", parts[1])))?;
        Ok((h, m))
    };
    let (sh, sm) = parse(start)?;
    let (eh, em) = parse(end)?;
    let mut dur = (eh * 60 + em) - (sh * 60 + sm);
    if dur < 0 {
        dur += 24 * 60;
    }
    Ok(dur)
}

fn normalize_hour(h: &str) -> String {
    let stripped = h.trim_start_matches('0');
    if stripped.is_empty() {
        "0".to_string()
    } else {
        stripped.to_string()
    }
}

/// Lenient session-bullet locator. Accepts ID HH in both padded (`09:30`) and
/// un-padded (`9:30`) forms — Rust's `parse_sessions` returns the raw digits
/// captured from the file (`{}` not `{:0>2}`, sessions.rs:85), but defensive
/// matching insulates writers from any future drift on either side.
///
/// DESYNC-SAFETY CONTRACT: a `None` return is the guard against hand-edited /
/// malformed session bullets. Now that today's daily log is editable in-app, a
/// user can reshape a `- HH:MM–HH:MM Task (Cat, Xm)` bullet by hand so its ID no
/// longer matches. Every writer (`update_session`, `delete_session`,
/// `update_session_note_text`) MUST treat `None` as "bullet not found" and
/// return `OkOut { ok: false, error: "Session not found", .. }` WITHOUT mutating
/// the file — never fall through to a write. That is what prevents an in-app
/// edit/delete from corrupting or orphaning the session. Do NOT remove the
/// `let Some(..) = .. else { return ok:false }` branches in a refactor.
fn find_session_bullet(lines: &[String], session_id: &str) -> Option<usize> {
    let parts: Vec<&str> = session_id.split(":::").collect();
    if parts.len() < 3 {
        return None;
    }
    let start_parts: Vec<&str> = parts[0].splitn(2, ':').collect();
    let end_parts: Vec<&str> = parts[1].splitn(2, ':').collect();
    if start_parts.len() != 2 || end_parts.len() != 2 {
        return None;
    }
    let sh = normalize_hour(start_parts[0]);
    let sm = start_parts[1];
    let eh = normalize_hour(end_parts[0]);
    let em = end_parts[1];
    let task = parts[2..].join(":::");
    let task_re = escape_regex(&task);
    let em_dash = '\u{2013}';
    let pattern = format!(
        "^- 0?{}:{}{}0?{}:{}\\s+{}\\s+\\(",
        sh, sm, em_dash, eh, em, task_re
    );
    let re = Regex::new(&pattern).ok()?;
    for (i, line) in lines.iter().enumerate() {
        if re.is_match(line) {
            return Some(i);
        }
    }
    None
}

/// Find the end-exclusive index of the indented sub-notes block that follows
/// `bullet_idx`. Matches Node: `lines[i].startsWith('  ') && !lines[i].trim().startsWith('- ')`.
fn note_block_end(lines: &[String], bullet_idx: usize) -> usize {
    let mut end = bullet_idx + 1;
    while end < lines.len()
        && lines[end].starts_with("  ")
        && !lines[end].trim().starts_with("- ")
    {
        end += 1;
    }
    end
}

/// The nearest session heading at or above `bullet_idx`, so a restored block
/// returns under the same heading the user had (the canonical/legacy variants
/// `parse_sessions` recognizes). Falls back to canonical `## Sessions`.
fn session_heading_above(lines: &[String], bullet_idx: usize) -> String {
    for l in lines[..bullet_idx].iter().rev() {
        let t = l.trim();
        if t == "## Sessions" || t == "## Session" || t == "### Sessions" {
            return t.to_string();
        }
    }
    "## Sessions".to_string()
}

fn read_or_create(p: &std::path::Path) -> Result<String, VaultError> {
    if p.exists() {
        fs::read_to_string(p).map_err(|e| VaultError::Io(e.to_string()))
    } else {
        Ok(String::new())
    }
}

fn write_and_mtime(p: &std::path::Path, content: &str) -> Result<f64, VaultError> {
    atomic_write(p, content.as_bytes())?;
    Ok(fs::metadata(p).map(|m| mtime_ms(&m)).unwrap_or(0.0))
}

fn ensure_sessions_heading(lines: &mut Vec<String>) -> usize {
    // Prefer canonical `## Sessions` (plural); accept `## Session` (singular)
    // as a legacy fallback so old daily logs still get appended to in-place.
    let mut plural_idx: Option<usize> = None;
    let mut singular_idx: Option<usize> = None;
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t == "## Sessions" && plural_idx.is_none() {
            plural_idx = Some(i);
            break;
        }
        if t == "## Session" && singular_idx.is_none() {
            singular_idx = Some(i);
        }
    }
    if let Some(i) = plural_idx.or(singular_idx) {
        return i;
    }
    // Create: insert before `## Tracker` (with `---` separator stripping per
    // Node), else append at end.
    let mut insert_at = lines.len();
    for (i, l) in lines.iter().enumerate() {
        if l.trim() == "## Tracker" {
            let mut j: isize = i as isize - 1;
            while j >= 0 && lines[j as usize].trim().is_empty() {
                j -= 1;
            }
            insert_at = if j >= 0 && lines[j as usize].trim() == "---" {
                j as usize
            } else {
                i
            };
            break;
        }
    }
    lines.splice(
        insert_at..insert_at,
        [
            String::new(),
            "## Sessions".to_string(),
            String::new(),
        ],
    );
    insert_at + 1
}

/// Append a session to `ds`'s daily note. Auto-creates today's note if
/// missing. Returns `{ ok, mtime }` (Node returns `{ ok: true }` — the new
/// `mtime` field is additive for the conflict-cache contract).
pub fn append_session(
    ds: &str,
    session: SessionInput,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    let p = daily_path(ds);
    check_mtime(&p, base_mtime)?;
    let content = read_or_create(&p)?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let dur = duration_mins(&session.start, &session.end)?;
    let bullet = format!(
        "- {}\u{2013}{} {} ({}, {}m)",
        session.start, session.end, session.task, session.task, dur
    );
    let mut bullet_lines = vec![bullet];
    if let Some(notes) = session.notes.as_ref() {
        let trimmed = notes.trim();
        if !trimmed.is_empty() {
            for l in trimmed.split('\n') {
                bullet_lines.push(format!("  {}", l));
            }
        }
    }

    let session_idx = ensure_sessions_heading(&mut lines);

    let mut insert_line = session_idx + 1;
    while insert_line < lines.len() && !lines[insert_line].trim().starts_with("## ") {
        insert_line += 1;
    }
    let bl_count = bullet_lines.len();
    lines.splice(insert_line..insert_line, bullet_lines);
    let _ = bl_count;

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut { ok: true, error: None, mtime })
}

pub fn update_session(
    ds: &str,
    old_session_id: &str,
    new_session: SessionInput,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    let p = daily_path(ds);
    if !p.exists() {
        return Ok(OkOut {
            ok: false,
            error: Some("Note not found".to_string()),
            mtime: 0.0,
        });
    }
    check_mtime(&p, base_mtime)?;
    let content = fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let Some(bullet_idx) = find_session_bullet(&lines, old_session_id) else {
        return Ok(OkOut {
            ok: false,
            error: Some("Session not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    };
    let end_i = note_block_end(&lines, bullet_idx);

    let dur = duration_mins(&new_session.start, &new_session.end)?;
    let new_bullet = format!(
        "- {}\u{2013}{} {} ({}, {}m)",
        new_session.start, new_session.end, new_session.task, new_session.task, dur
    );
    let mut replacement = vec![new_bullet];
    if let Some(notes) = new_session.notes.as_ref() {
        let trimmed = notes.trim();
        if !trimmed.is_empty() {
            for l in trimmed.split('\n') {
                replacement.push(format!("  {}", l));
            }
        }
    }

    lines.splice(bullet_idx..end_i, replacement);
    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut { ok: true, error: None, mtime })
}

pub fn delete_session(
    ds: &str,
    session_id: &str,
    base_mtime: Option<f64>,
) -> Result<DeleteSessionOut, VaultError> {
    let p = daily_path(ds);
    if !p.exists() {
        return Ok(DeleteSessionOut {
            ok: false,
            error: Some("Note not found".to_string()),
            mtime: 0.0,
            removed_block: None,
            line_hint: None,
            heading: None,
        });
    }
    check_mtime(&p, base_mtime)?;
    let content = fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let Some(bullet_idx) = find_session_bullet(&lines, session_id) else {
        return Ok(DeleteSessionOut {
            ok: false,
            error: Some("Session not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
            removed_block: None,
            line_hint: None,
            heading: None,
        });
    };
    let block_end = note_block_end(&lines, bullet_idx);
    // Capture the bullet + sub-notes verbatim (raw em-dash + indentation) BEFORE
    // draining — the faithful bin copy. Excludes the trailing blank the drain
    // also eats (a layout separator, not part of the session).
    let removed_block = lines[bullet_idx..block_end].join("\n");
    let heading = session_heading_above(&lines, bullet_idx);

    let mut end_i = block_end;
    if end_i < lines.len() && lines[end_i].trim().is_empty() {
        end_i += 1;
    }

    lines.drain(bullet_idx..end_i);
    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(DeleteSessionOut {
        ok: true,
        error: None,
        mtime,
        removed_block: Some(removed_block),
        line_hint: Some(bullet_idx as u32),
        heading: Some(heading),
    })
}

pub fn update_session_note_text(
    ds: &str,
    session_id: &str,
    note_text: &str,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    let p = daily_path(ds);
    if !p.exists() {
        return Ok(OkOut {
            ok: false,
            error: Some("Note not found".to_string()),
            mtime: 0.0,
        });
    }
    check_mtime(&p, base_mtime)?;
    let content = fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let Some(bullet_idx) = find_session_bullet(&lines, session_id) else {
        return Ok(OkOut {
            ok: false,
            error: Some("Session not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    };
    let end_i = note_block_end(&lines, bullet_idx);

    let trimmed = note_text.trim();
    let new_subs: Vec<String> = if trimmed.is_empty() {
        Vec::new()
    } else {
        trimmed.split('\n').map(|l| format!("  {}", l)).collect()
    };

    lines.splice(bullet_idx + 1..end_i, new_subs);
    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut { ok: true, error: None, mtime })
}

pub fn append_freeform_note(text: &str, base_mtime: Option<f64>) -> Result<OkOut, VaultError> {
    let ds = today_str();
    let p = daily_path(&ds);
    if !p.exists() {
        return Ok(OkOut {
            ok: false,
            error: Some("Today's note not found".to_string()),
            mtime: 0.0,
        });
    }
    check_mtime(&p, base_mtime)?;
    let content = fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let ts = fmt_local_hhmm(Local::now());
    let bullet = format!("- {} {}", ts, text.trim());

    let notes_idx = lines.iter().position(|l| l.trim() == "## Notes");
    let notes_idx = match notes_idx {
        Some(i) => i,
        None => {
            lines.push(String::new());
            lines.push("## Notes".to_string());
            lines.push(String::new());
            lines.len() - 2
        }
    };

    let mut insert_line = notes_idx + 1;
    while insert_line < lines.len() && !lines[insert_line].trim().starts_with("## ") {
        insert_line += 1;
    }
    lines.insert(insert_line, bullet);

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut { ok: true, error: None, mtime })
}

/// Append a plain `- <text>` bullet under `ds`'s `## Quick Notes`, creating the
/// section (at its canonical slot) — and the daily page itself — when absent.
///
/// Host-side SINK for a GLOBAL push-to-talk dictation (`dictation_committed`): the
/// app is typically UNFOCUSED, so the JS `appendToDaySection` path can't be relied
/// on to run; the always-on Rust relay writes the transcript here instead. Mirrors
/// the JS `appendSectionLine('Quick Notes', …)` splice (insert after the last
/// bullet; keep a blank before a following H2) + the existing `append_session`
/// posture of tolerating a missing page (`read_or_create`, never lose the
/// transcript). NO mtime gate — the relay is the sole out-of-band writer and the
/// file watcher re-syncs the frontend cache after the write (it emits `day`/`today`
/// for a `Pulse/Daily Logs/*.md` change). No timestamp prefix: a dictated note is a
/// plain bullet (unlike `append_freeform_note`, which stamps `## Notes`).
pub fn append_quick_note(ds: &str, text: &str) -> Result<OkOut, VaultError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(OkOut { ok: false, error: Some("empty transcript".to_string()), mtime: 0.0 });
    }
    let p = daily_path(ds);
    let content = read_or_create(&p)?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    // Find `## Quick Notes` with the SAME lenient predicate the delete path uses.
    let header = match lines
        .iter()
        .position(|l| crate::parsers::quick_notes::is_quick_notes_header(l))
    {
        Some(i) => i,
        None => {
            // Absent → create it before Tasks/Upcoming/Sessions (the JS canonical
            // anchors), else at EOF; a lead blank when the prior line has content.
            let mut at = lines.len();
            'find: for anchor in ["## Tasks", "## Upcoming", "## Sessions"] {
                for (i, l) in lines.iter().enumerate() {
                    if l.trim() == anchor {
                        at = i;
                        break 'find;
                    }
                }
            }
            let mut ins: Vec<String> = Vec::new();
            if at > 0 && !lines[at - 1].trim().is_empty() {
                ins.push(String::new());
            }
            let header_pos = at + ins.len();
            ins.push("## Quick Notes".to_string());
            ins.push(String::new());
            lines.splice(at..at, ins);
            header_pos
        }
    };

    // Body = [header+1, next H2). Insert after the last bullet, else at body end.
    let mut body_end = header + 1;
    while body_end < lines.len() && !crate::parsers::quick_notes::is_h2(&lines[body_end]) {
        body_end += 1;
    }
    let last_bullet = (header + 1..body_end).rev().find(|&i| {
        let t = lines[i].trim();
        t.strip_prefix('-')
            .map(|r| r.starts_with(char::is_whitespace) && !r.trim().is_empty())
            .unwrap_or(false)
    });
    let at = last_bullet.map(|i| i + 1).unwrap_or(body_end);
    let gap = at < lines.len() && crate::parsers::quick_notes::is_h2(&lines[at]);
    lines.insert(at, format!("- {}", trimmed));
    if gap {
        lines.insert(at + 1, String::new());
    }

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut { ok: true, error: None, mtime })
}

pub fn read_recent_notes(limit: u32) -> Vec<RecentNote> {
    let mut results: Vec<RecentNote> = Vec::new();
    let today = Local::now().date_naive();
    for i in 0..limit as i64 {
        let d = today - Duration::days(i);
        let ds = d.format("%Y-%m-%d").to_string();
        let p = daily_path(&ds);
        let content = match fs::read_to_string(&p) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let sessions = parse_sessions(&content);
        for (j, s) in sessions.iter().enumerate() {
            if !s.notes.trim().is_empty() {
                results.push(RecentNote {
                    session: s.clone(),
                    date_str: ds.clone(),
                    idx: j,
                });
            }
        }
    }
    // Sort newest-first by `${dateStr}T${start}`, descending — matches Node's
    // `bTime.localeCompare(aTime)`.
    results.sort_by(|a, b| {
        let a_key = format!("{}T{}", a.date_str, a.session.start);
        let b_key = format!("{}T{}", b.date_str, b.session.start);
        b_key.cmp(&a_key)
    });
    results
}
