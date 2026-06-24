//! Daily-task mutation — ports `server/src/vault/tasks.js::toggleTodayTask`.

use std::fs;

use serde::Serialize;

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, VaultError};
use crate::parsers::daily::{daily_path, parse_tasks, today_str, Task};

#[derive(Serialize, Debug)]
pub struct TasksOut {
    pub tasks: Vec<Task>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub mtime: f64,
}

/// Flip the exact `- [ ]`/`- [x]` checkbox on the line that byte-matches
/// `raw_line` in today's daily note. First occurrence only. Returns the
/// refreshed task list. Preserves Node's `{ error, tasks }` shape on miss
/// (note-not-found or line-not-found) so the Planner provider can keep
/// surfacing the diagnostic.
pub fn toggle_today_task(
    raw_line: &str,
    base_mtime: Option<f64>,
) -> Result<TasksOut, VaultError> {
    let ds = today_str();
    let p = daily_path(&ds);

    if !p.exists() {
        return Ok(TasksOut {
            tasks: Vec::new(),
            error: Some("Today's note not found".to_string()),
            mtime: 0.0,
        });
    }

    check_mtime(&p, base_mtime)?;

    let content = fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?;
    let mut found = false;
    let new_lines: Vec<String> = content
        .split('\n')
        .map(|line| {
            if !found && line == raw_line {
                found = true;
                if line.contains("- [ ]") {
                    return line.replacen("- [ ]", "- [x]", 1);
                }
                if line.contains("- [x]") {
                    return line.replacen("- [x]", "- [ ]", 1);
                }
            }
            line.to_string()
        })
        .collect();

    if !found {
        let mtime = fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0);
        return Ok(TasksOut {
            tasks: parse_tasks(&content),
            error: Some("Line not found — note may have changed".to_string()),
            mtime,
        });
    }

    let next = new_lines.join("\n");
    atomic_write(&p, next.as_bytes())?;
    let mtime = fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0);

    Ok(TasksOut {
        tasks: parse_tasks(&next),
        error: None,
        mtime,
    })
}
