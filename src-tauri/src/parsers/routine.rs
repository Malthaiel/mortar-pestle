//! Routine parser — ports `parseRecurring`, `parseRoutineSection`,
//! `readRoutineForToday`, `ensureRoutineSection`, and `toggleRoutineTask`
//! from the Node side.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use chrono::{Datelike, Local, Weekday};
use regex::Regex;
use serde::Serialize;

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, pulse_vault_root, VaultError};
use crate::parsers::daily::{daily_path, today_str};

#[derive(Serialize, Debug)]
pub struct RoutineItem {
    pub task: String,
    pub checked: bool,
}

#[derive(Debug, Clone)]
pub struct RecurringEntry {
    pub day: u32,
    pub task: String,
}

#[derive(Debug, Clone)]
pub struct RoutineState {
    pub checked: bool,
    pub raw: String,
}

fn routine_path() -> PathBuf {
    PathBuf::from(format!("{}/Pulse/Recurring Tasks.md", pulse_vault_root()))
}

fn day_code(s: &str) -> Option<u32> {
    match s.to_ascii_lowercase().as_str() {
        "sun" | "sunday" => Some(0),
        "mon" | "monday" => Some(1),
        "tue" | "tues" | "tuesday" => Some(2),
        "wed" | "weds" | "wednesday" => Some(3),
        "thu" | "thur" | "thurs" | "thursday" => Some(4),
        "fri" | "friday" => Some(5),
        "sat" | "saturday" => Some(6),
        _ => None,
    }
}

pub fn parse_recurring(content: &str) -> Vec<RecurringEntry> {
    static DAY_RE: OnceLock<Regex> = OnceLock::new();
    static TASK_RE: OnceLock<Regex> = OnceLock::new();
    static SEP: OnceLock<Regex> = OnceLock::new();
    let day_re = DAY_RE.get_or_init(|| Regex::new(r"(?i)\|\s*Day\s*\|").unwrap());
    let task_re = TASK_RE.get_or_init(|| Regex::new(r"(?i)\|\s*Task\s*\|").unwrap());
    let sep = SEP.get_or_init(|| Regex::new(r"^\|[\s\-:]+\|[\s\-:]+\|$").unwrap());

    let mut items = Vec::new();
    let mut in_table = false;
    for line in content.split('\n') {
        let trimmed = line.trim();
        if !in_table {
            if trimmed.starts_with('|') && day_re.is_match(trimmed) && task_re.is_match(trimmed) {
                in_table = true;
            }
            continue;
        }
        if !trimmed.starts_with('|') {
            in_table = false;
            continue;
        }
        if sep.is_match(trimmed) {
            continue;
        }
        let parts: Vec<&str> = trimmed.split('|').collect();
        if parts.len() < 4 {
            continue;
        }
        let day_cell = parts[1].trim();
        let task_cell = parts[2].trim();
        if day_cell.is_empty() || task_cell.is_empty() {
            continue;
        }
        let Some(day) = day_code(day_cell) else {
            continue;
        };
        items.push(RecurringEntry {
            day,
            task: task_cell.to_string(),
        });
    }
    items
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

fn weekday_num(w: Weekday) -> u32 {
    // chrono: Mon=0..Sun=6; Node: Sun=0..Sat=6. Convert.
    match w {
        Weekday::Sun => 0,
        Weekday::Mon => 1,
        Weekday::Tue => 2,
        Weekday::Wed => 3,
        Weekday::Thu => 4,
        Weekday::Fri => 5,
        Weekday::Sat => 6,
    }
}

pub fn read_routine_for_today() -> Vec<RoutineItem> {
    let config_text = fs::read_to_string(routine_path()).unwrap_or_default();
    let config = parse_recurring(&config_text);
    let dow = weekday_num(Local::now().weekday());
    let ds = today_str();
    let note_text = fs::read_to_string(daily_path(&ds)).ok();
    let state_map = match &note_text {
        Some(s) => parse_routine_section(s),
        None => HashMap::new(),
    };
    config
        .into_iter()
        .filter(|it| it.day == dow)
        .map(|it| {
            let checked = state_map.get(&it.task).map(|s| s.checked).unwrap_or(false);
            RoutineItem {
                task: it.task,
                checked,
            }
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
