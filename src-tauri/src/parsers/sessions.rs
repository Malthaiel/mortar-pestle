//! Sessions parser + the unrelated `## Notes` / `## Quick Notes` writers.
//!
//! The session WRITERS + `read_recent_notes` moved to the `sessions.json` store
//! (`commands::sessions`, Planner Overhaul D5). This module keeps `parse_sessions`
//! (the boot migration uses it), the shared `Session` / `RecentNote` types +
//! `normalize_hour`, and `append_freeform_note` / `append_quick_note`.

use std::fs;
use std::sync::OnceLock;

use chrono::Local;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, VaultError};
use crate::parsers::daily::{daily_path, fmt_local_hhmm, today_str};

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

pub(crate) fn normalize_hour(h: &str) -> String {
    let stripped = h.trim_start_matches('0');
    if stripped.is_empty() {
        "0".to_string()
    } else {
        stripped.to_string()
    }
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

pub fn append_freeform_note(text: &str, base_mtime: Option<f64>) -> Result<OkOut, VaultError> {
    let ds = today_str();
    let p = daily_path(&ds);
    // A missing note used to bounce the write and DROP what the user typed. Create it from the
    // same skeleton `daily_get_today` uses, then append into it. A note we just made has no prior
    // version to conflict with, so the mtime check is skipped for that case only.
    let created = !p.exists();
    if created {
        crate::parsers::daily::ensure_daily_note(&ds);
    }
    if !p.exists() {
        return Ok(OkOut {
            ok: false,
            error: Some("Today's note not found".to_string()),
            mtime: 0.0,
        });
    }
    if !created {
        check_mtime(&p, base_mtime)?;
    }
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
