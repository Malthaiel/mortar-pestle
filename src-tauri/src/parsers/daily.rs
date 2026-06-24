//! Daily-note parsing primitives + `read_daily_note`.
//!
//! Ports helpers from the now-removed Node sidecar (`server/src/vault/parsers.js` + `server/src/vault/notes.js::readDailyNote`).
//! Output JSON must remain byte-identical to the Node side — diffed via the
//! parity harness at `src-tauri/tests/daily_parity.rs`.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use chrono::Local;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, pulse_vault_root, RootKind, VaultError};
use crate::parsers::sessions::{parse_sessions, OkOut, Session};
use crate::render;

pub fn today_str() -> String {
    if let Ok(v) = std::env::var("AGENTIC_TODAY") {
        if !v.is_empty() {
            return v;
        }
    }
    let d = Local::now();
    d.format("%Y-%m-%d").to_string()
}

pub fn fmt_local_hhmm(d: chrono::DateTime<Local>) -> String {
    d.format("%H:%M").to_string()
}

pub fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn daily_dir() -> PathBuf {
    PathBuf::from(format!("{}/Pulse/Daily Logs", pulse_vault_root()))
}

pub fn daily_path(ds: &str) -> PathBuf {
    daily_dir().join(format!("{}.md", ds))
}

#[derive(Serialize, Debug)]
pub struct Task {
    pub raw: String,
    pub checked: bool,
    pub display: String,
    pub project: Option<String>,
    pub section: String,
    pub priority: String,
}

#[derive(Serialize, Debug)]
pub struct PlanBlock {
    pub start: String,
    pub end: String,
    pub title: String,
    pub kind: String,
}

#[derive(Serialize, Debug)]
pub struct DailyNote {
    pub exists: bool,
    pub ds: String,
    pub content: String,
    #[serde(rename = "bodyHtml")]
    pub body_html: String,
    pub tasks: Vec<Task>,
    #[serde(rename = "planBlocks")]
    pub plan_blocks: Vec<PlanBlock>,
    pub sessions: Vec<Session>,
    /// Unix ms; populated from filesystem mtime. `0.0` when `exists: false`.
    /// Web client passes this back as `base_mtime` on writes for conflict
    /// detection.
    pub mtime: f64,
}

fn resolve_wikilinks(text: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
    re.replace_all(text, |c: &regex::Captures| {
        let link = &c[1];
        link.rsplit('/').next().unwrap_or(link).to_string()
    })
    .into_owned()
}

fn target_h2_section(h2: &str) -> Option<&'static str> {
    match h2 {
        "## Daily Tasks" => Some("daily"),
        "## Overdue Tasks" => Some("overdue"),
        "## Today's Tasks" => Some("today"),
        _ => None,
    }
}

fn parse_task_line(raw: &str, section: &str, priority: &str) -> Option<Task> {
    static RE: OnceLock<Regex> = OnceLock::new();
    static PROJ: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^- \[(x| )\] (.+)$").unwrap());
    let proj = PROJ.get_or_init(|| Regex::new(r"^(.*?)\s+\(([^)]+)\)\s*$").unwrap());
    let trimmed = raw.trim();
    let m = re.captures(trimmed)?;
    let checked = &m[1] == "x";
    let mut content = m[2].to_string();
    let mut project: Option<String> = None;
    if let Some(p) = proj.captures(&content) {
        let new_content = p[1].to_string();
        project = Some(p[2].to_string());
        content = new_content;
    }
    let display = resolve_wikilinks(&content);
    let project = project.map(|p| resolve_wikilinks(&p));
    Some(Task {
        raw: raw.to_string(),
        checked,
        display,
        project,
        section: section.to_string(),
        priority: priority.to_string(),
    })
}

pub fn parse_tasks(content: &str) -> Vec<Task> {
    let mut tasks = Vec::new();
    let mut in_section: Option<&'static str> = None;
    let mut current_priority = "none";
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with("## ") {
            in_section = target_h2_section(trimmed);
            current_priority = "none";
            continue;
        }
        if in_section.is_none() {
            continue;
        }
        if trimmed == "### High Priority" {
            current_priority = "high";
            continue;
        }
        if trimmed == "### Medium Priority" {
            current_priority = "medium";
            continue;
        }
        if trimmed == "### Low Priority" {
            current_priority = "low";
            continue;
        }
        if trimmed.starts_with("### ") {
            continue;
        }
        if trimmed.starts_with("- [") {
            if let Some(t) = parse_task_line(line, in_section.unwrap(), current_priority) {
                tasks.push(t);
            }
        }
    }
    tasks
}

/// Parse one trimmed plan-fence line into a normalized 24h `PlanBlock`. Accepts
/// `H:MM AM H:MM PM Title` and `HH:MM HH:MM Title` forms. The writer matches
/// fence lines against this same normalization.
pub fn parse_plan_line(trimmed: &str) -> Option<PlanBlock> {
    static WITH_AMPM: OnceLock<Regex> = OnceLock::new();
    static NO_AMPM: OnceLock<Regex> = OnceLock::new();
    let with_ampm = WITH_AMPM.get_or_init(|| {
        Regex::new(r"(?i)^(\d{1,2}):(\d{2})\s+(AM|PM)\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+(.+)$").unwrap()
    });
    let no_ampm =
        NO_AMPM.get_or_init(|| Regex::new(r"^(\d{1,2}):(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$").unwrap());
    if let Some(c) = with_ampm.captures(trimmed) {
        return Some(PlanBlock {
            start: format!("{}:{}", to_24h(&c[1], &c[3]), &c[2]),
            end: format!("{}:{}", to_24h(&c[4], &c[6]), &c[5]),
            title: c[7].trim().to_string(),
            kind: "planned".to_string(),
        });
    }
    if let Some(c) = no_ampm.captures(trimmed) {
        return Some(PlanBlock {
            start: format!("{}:{}", pad2(&c[1]), &c[2]),
            end: format!("{}:{}", pad2(&c[3]), &c[4]),
            title: c[5].trim().to_string(),
            kind: "planned".to_string(),
        });
    }
    None
}

pub fn parse_plan_blocks(content: &str) -> Vec<PlanBlock> {
    static FENCE: OnceLock<Regex> = OnceLock::new();
    let fence = FENCE.get_or_init(|| Regex::new(r"(?s)```plan\s*\n(.*?)```").unwrap());
    let mut blocks = Vec::new();
    let Some(m) = fence.captures(content) else {
        return blocks;
    };
    for raw in m[1].split('\n') {
        if let Some(b) = parse_plan_line(raw.trim()) {
            blocks.push(b);
        }
    }
    blocks
}

fn pad2(s: &str) -> String {
    if s.len() >= 2 {
        s.to_string()
    } else {
        format!("0{}", s)
    }
}

fn to_24h(h: &str, meridian: &str) -> String {
    let hr: i32 = h.parse().unwrap_or(0);
    let m = meridian.to_ascii_uppercase();
    let h24 = if m == "AM" {
        if hr == 12 {
            0
        } else {
            hr
        }
    } else if hr == 12 {
        12
    } else {
        hr + 12
    };
    format!("{:02}", h24)
}

#[derive(Deserialize, Debug)]
pub struct PlanBlockInput {
    pub start: String,
    pub end: String,
    pub title: String,
}

/// Re-time a single plan block in `ds`'s plan fence (move or resize). Finds the
/// fence line whose parsed (start, end, title) equals `old` and rewrites it as a
/// canonical `HH:MM HH:MM Title` line. Plan blocks are today-only, so the frontend
/// only ever passes today's `ds`. Returns `{ ok: false }` if nothing matched.
pub fn update_plan_block(
    ds: &str,
    old: PlanBlockInput,
    new: PlanBlockInput,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    let p = daily_path(ds);
    check_mtime(&p, base_mtime)?;
    if !p.exists() {
        return Ok(OkOut {
            ok: false,
            error: Some("daily note not found".to_string()),
            mtime: 0.0,
        });
    }
    let content = fs::read_to_string(&p).map_err(|e| VaultError::Io(e.to_string()))?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
    let mut in_fence = false;
    let mut replaced = false;
    for line in lines.iter_mut() {
        let t = line.trim();
        if !in_fence {
            if t == "```plan" {
                in_fence = true;
            }
            continue;
        }
        if t.starts_with("```") {
            in_fence = false;
            continue;
        }
        if replaced {
            continue;
        }
        if let Some(b) = parse_plan_line(t) {
            if b.start == old.start && b.end == old.end && b.title == old.title {
                *line = format!("{} {} {}", new.start, new.end, new.title);
                replaced = true;
            }
        }
    }
    if !replaced {
        return Ok(OkOut {
            ok: false,
            error: Some("plan block not found".to_string()),
            mtime: 0.0,
        });
    }
    let new_content = lines.join("\n");
    atomic_write(&p, new_content.as_bytes())?;
    let mtime = fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0);
    Ok(OkOut {
        ok: true,
        error: None,
        mtime,
    })
}

/// Read today's daily note (or arbitrary `ds = "YYYY-MM-DD"`).
pub fn read_daily_note(ds: &str) -> DailyNote {
    let p = daily_path(ds);
    if !p.exists() {
        return DailyNote {
            exists: false,
            ds: ds.to_string(),
            content: String::new(),
            body_html: String::new(),
            tasks: Vec::new(),
            plan_blocks: Vec::new(),
            sessions: Vec::new(),
            mtime: 0.0,
        };
    }
    let content = fs::read_to_string(&p).unwrap_or_default();
    let rel = format!("Pulse/Daily Logs/{}", ds);
    let body_html = render::render_path_in(&rel, RootKind::Pulse)
        .map(|r| r.html)
        .unwrap_or_default();
    let mtime = fs::metadata(&p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    DailyNote {
        exists: true,
        ds: ds.to_string(),
        tasks: parse_tasks(&content),
        plan_blocks: parse_plan_blocks(&content),
        sessions: parse_sessions(&content),
        content,
        body_html,
        mtime,
    }
}

// ── Unorganized inbox scan (Planner "Unorganized Notes" pane) ────────────────
// Scans every daily log except today, newest-file first, for two things:
//   • Tasks  — every UNCHECKED `- [ ]` line anywhere in the log EXCEPT inside
//     YAML frontmatter, fenced code blocks, or the `## Vault Activity` section.
//     `line` is 0-based (content split on '\n') so it feeds `vault_toggle_task`.
//   • Notes  — plain (non-checkbox) bullets under the first `## Quick Notes`.
//     `index` is the bullet's ordinal among ALL that section's `- ` bullets
//     (checkbox bullets included, so they still consume an ordinal), keeping it
//     aligned with the web client's `quickNotesBulletLines` /
//     `locateQuickNotesBullet` text-verified note actions (delete/move/carry/
//     stub + undo). A checkbox bullet under Quick Notes is surfaced by the task
//     scan, never here — clean dedup.
#[derive(Serialize, Debug)]
pub struct UnorgTask {
    pub path: String,
    pub line: usize,
    pub text: String,
    #[serde(rename = "sourceDate")]
    pub source_date: String,
}

#[derive(Serialize, Debug)]
pub struct UnorgNote {
    #[serde(rename = "sourceDate")]
    pub source_date: String,
    pub index: usize,
    pub text: String,
}

#[derive(Serialize, Debug)]
pub struct UnorganizedOut {
    pub tasks: Vec<UnorgTask>,
    pub notes: Vec<UnorgNote>,
}

pub fn read_unorganized_items() -> UnorganizedOut {
    static DATE_RE: OnceLock<Regex> = OnceLock::new();
    static TASK_RE: OnceLock<Regex> = OnceLock::new();
    static BULLET_RE: OnceLock<Regex> = OnceLock::new();
    static QN_RE: OnceLock<Regex> = OnceLock::new();
    static H2_RE: OnceLock<Regex> = OnceLock::new();
    static CHECKBOX_REM: OnceLock<Regex> = OnceLock::new();
    let date_re = DATE_RE.get_or_init(|| Regex::new(r"^(\d{4}-\d{2}-\d{2})\.md$").unwrap());
    // Unchecked-or-checked task marker on any dash/star/plus bullet.
    let task_re = TASK_RE.get_or_init(|| Regex::new(r"^[-*+]\s+\[([ xX])\]\s?(.*)$").unwrap());
    // Quick Notes bullet predicate — dash only, mirrors web `quickNotesBulletLines`.
    let bullet_re = BULLET_RE.get_or_init(|| Regex::new(r"^-\s+(.*)$").unwrap());
    let qn_re = QN_RE.get_or_init(|| Regex::new(r"^##\s+Quick Notes\s*$").unwrap());
    let h2_re = H2_RE.get_or_init(|| Regex::new(r"^##\s+").unwrap());
    // Bullet remainder (post `- `) that is itself a checkbox → belongs to Tasks.
    let checkbox_rem = CHECKBOX_REM.get_or_init(|| Regex::new(r"^\[[ xX]\]").unwrap());

    let today = today_str();
    let mut dates: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(daily_dir()) {
        for entry in rd.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if let Some(c) = date_re.captures(name) {
                    let ds = c[1].to_string();
                    if ds != today {
                        dates.push(ds);
                    }
                }
            }
        }
    }
    dates.sort();
    dates.reverse(); // newest-first

    let mut tasks: Vec<UnorgTask> = Vec::new();
    let mut notes: Vec<UnorgNote> = Vec::new();

    for ds in &dates {
        let content = match fs::read_to_string(daily_path(ds)) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let rel = format!("Pulse/Daily Logs/{}.md", ds);
        let lines: Vec<&str> = content.split('\n').collect();

        // Task scan — whole file minus frontmatter / fences / Vault Activity.
        let mut in_frontmatter = false;
        let mut in_fence = false;
        let mut in_vault_activity = false;
        for (i, raw) in lines.iter().enumerate() {
            let trimmed = raw.trim();
            if i == 0 && trimmed == "---" {
                in_frontmatter = true;
                continue;
            }
            if in_frontmatter {
                if trimmed == "---" {
                    in_frontmatter = false;
                }
                continue;
            }
            if trimmed.starts_with("```") {
                in_fence = !in_fence;
                continue;
            }
            if in_fence {
                continue;
            }
            if trimmed.starts_with("## ") {
                in_vault_activity = trimmed.eq_ignore_ascii_case("## Vault Activity");
                continue;
            }
            if in_vault_activity {
                continue;
            }
            if let Some(c) = task_re.captures(trimmed) {
                if &c[1] == " " {
                    let text = resolve_wikilinks(c[2].trim());
                    if !text.is_empty() {
                        tasks.push(UnorgTask {
                            path: rel.clone(),
                            line: i,
                            text,
                            source_date: ds.clone(),
                        });
                    }
                }
            }
        }

        // Note scan — non-checkbox `- ` bullets under the first `## Quick Notes`.
        if let Some(h) = lines.iter().position(|l| qn_re.is_match(l)) {
            let start = h + 1;
            let mut end = start;
            while end < lines.len() && !h2_re.is_match(lines[end]) {
                end += 1;
            }
            let mut ord = 0usize;
            for line in &lines[start..end] {
                if let Some(c) = bullet_re.captures(line.trim()) {
                    let rem = c[1].trim();
                    if rem.is_empty() {
                        continue;
                    }
                    if !checkbox_rem.is_match(rem) {
                        notes.push(UnorgNote {
                            source_date: ds.clone(),
                            index: ord,
                            text: rem.to_string(),
                        });
                    }
                    ord += 1;
                }
            }
        }
    }

    UnorganizedOut { tasks, notes }
}
