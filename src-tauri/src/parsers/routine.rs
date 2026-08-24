//! Routine parser — the per-day TICK STATE of the `## Routine` section in a
//! daily log.
//!
//! It no longer owns the CONFIG (which repeating items exist, and on which
//! weekdays). Planner Consolidation merged Frame and Recurring into one Routine
//! item stored in `Pulse/Schedule.md`'s `frames:` map, which is parsed and
//! written entirely in JS (`parseDailyFrame` / `buildScheduleFrontmatter` in
//! web/src/api.js). Duplicating that YAML parser here would be a second source
//! of truth for the format, so Rust deliberately reads none of it: the frontend
//! owns the item list and joins it against the tick state this returns.
//!
//! `Pulse/Recurring Tasks.md` is no longer read by anything.

use std::collections::HashMap;
use std::fs;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, VaultError};
use crate::parsers::daily::{daily_path, today_str};

#[derive(Serialize, Debug)]
pub struct RoutineItem {
    pub task: String,
    pub checked: bool,
}

#[derive(Debug, Clone)]
pub struct RoutineState {
    pub checked: bool,
    pub raw: String,
}

pub fn parse_routine_section(content: &str) -> HashMap<String, RoutineState> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^- \[(x| )\] (.+)$").unwrap());

    let mut map = HashMap::new();
    let mut in_section = false;
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed == "## Routine" {
            in_section = true;
            continue;
        }
        if !in_section {
            continue;
        }
        if trimmed.starts_with("## ") {
            in_section = false;
            continue;
        }
        if let Some(m) = re.captures(trimmed) {
            map.insert(
                m[2].trim().to_string(),
                RoutineState {
                    checked: &m[1] == "x",
                    raw: line.to_string(),
                },
            );
        }
    }
    map
}


/// Every entry currently recorded in today's `## Routine` section, as
/// `{task, checked}`.
///
/// This is TICK STATE ONLY — it does not know which repeating items are
/// supposed to exist today. That list lives in `Pulse/Schedule.md`'s frames map
/// and is resolved by the frontend, which joins it against these ticks by task
/// name. An item the user has never ticked simply has no row here and reads as
/// unchecked, which is exactly right.
///
/// Order is not meaningful (the section is read into a map); the frontend
/// orders by the frames list.
pub fn read_routine_for_today() -> Vec<RoutineItem> {
    let ds = today_str();
    let Ok(note_text) = fs::read_to_string(daily_path(&ds)) else {
        return Vec::new();
    };
    parse_routine_section(&note_text)
        .into_iter()
        .map(|(task, st)| RoutineItem {
            task,
            checked: st.checked,
        })
        .collect()
}

#[derive(Serialize, Debug)]
pub struct RoutineWriteOut {
    pub items: Vec<RoutineItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub mtime: f64,
}

/// Insert a `## Routine` section into `content` if missing. Placement matches
/// Node's `ensureRoutineSection` (server/src/vault/tasks.js:44–56): immediately
/// before `## Today's Plan` if present, else appended at end with a leading
/// blank line.
pub fn ensure_routine_section(content: &str) -> String {
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
    if lines.iter().any(|l| l.trim() == "## Routine") {
        return content.to_string();
    }
    let plan_idx = lines.iter().position(|l| l.trim() == "## Today's Plan");
    if let Some(idx) = plan_idx {
        lines.splice(idx..idx, ["".to_string(), "## Routine".to_string(), "".to_string()]);
    } else {
        if !lines.is_empty() && !lines[lines.len() - 1].trim().is_empty() {
            lines.push(String::new());
        }
        lines.push("## Routine".to_string());
        lines.push(String::new());
    }
    lines.join("\n")
}

/// Idempotent flip-or-insert for a recurring task line in today's `## Routine`
/// section. If the task isn't yet in the section it's added as `- [x] {task}`
/// (matching Node — first click marks it done immediately).
pub fn toggle_routine_task(
    task_name: &str,
    base_mtime: Option<f64>,
) -> Result<RoutineWriteOut, VaultError> {
    let ds = today_str();
    let p = daily_path(&ds);

    check_mtime(&p, base_mtime)?;

    let content = if p.exists() {
        fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?
    } else {
        String::new()
    };

    let content = ensure_routine_section(&content);
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let mut section_start: Option<usize> = None;
    let mut section_end = lines.len();
    let mut in_section = false;
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t == "## Routine" {
            in_section = true;
            section_start = Some(i);
            continue;
        }
        if in_section && t.starts_with("## ") {
            section_end = i;
            break;
        }
    }
    let Some(start) = section_start else {
        return Ok(RoutineWriteOut {
            items: read_routine_for_today(),
            error: Some("Could not place Routine section".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    };

    static LINE_RE: OnceLock<Regex> = OnceLock::new();
    let line_re = LINE_RE.get_or_init(|| Regex::new(r"^- \[(x| )\] (.+)$").unwrap());

    let mut found_idx: Option<usize> = None;
    for i in (start + 1)..section_end {
        if let Some(m) = line_re.captures(lines[i].trim()) {
            if m[2].trim() == task_name {
                found_idx = Some(i);
                break;
            }
        }
    }

    if let Some(idx) = found_idx {
        let l = &lines[idx];
        let new_l = if l.contains("- [ ]") {
            l.replacen("- [ ]", "- [x]", 1)
        } else if l.contains("- [x]") {
            l.replacen("- [x]", "- [ ]", 1)
        } else {
            l.clone()
        };
        lines[idx] = new_l;
    } else {
        let mut insert_at = start + 1;
        while insert_at < section_end && lines[insert_at].trim().starts_with("- [") {
            insert_at += 1;
        }
        lines.insert(insert_at, format!("- [x] {}", task_name));
    }

    atomic_write(&p, lines.join("\n").as_bytes())?;
    let mtime = fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0);

    Ok(RoutineWriteOut {
        items: read_routine_for_today(),
        error: None,
        mtime,
    })
}
