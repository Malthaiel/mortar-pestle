//! Pure-Rust port of the `## Quick Notes` section locators in `web/src/api.js`
//! (`findQuickNotesRange` / `quickNotesBulletLines` / `locateQuickNotesBullet`).
//! Tauri-free: the daily-log delete command locates a quick-note bullet for
//! recycling-bin capture without dragging `AppHandle` into the parser layer.
//! Indices line up with the parsed `index` from `read_unorganized_items`
//! because the bullet predicate is identical (trimmed `- ` prefix, non-empty
//! body; checkbox bullets still count).

/// Errors mirror the JS `locateQuickNotesBullet` codes so the frontend's
/// existing stale-projection handling keeps working unchanged.
pub enum QuickNoteLocateErr {
    NoSection,
    IndexOob,
    TextMismatch,
}

impl QuickNoteLocateErr {
    pub fn code(&self) -> &'static str {
        match self {
            QuickNoteLocateErr::NoSection => "NO_SECTION",
            QuickNoteLocateErr::IndexOob => "INDEX_OOB",
            QuickNoteLocateErr::TextMismatch => "TEXT_MISMATCH",
        }
    }
}

/// `/^##\s+Quick Notes\s*$/` — the section header line. `pub` so the daily-log
/// SINK (`sessions::append_quick_note`) detects the section with the SAME lenient
/// predicate the delete/read path uses — otherwise a weirdly-spaced header would be
/// found by one and not the other, and the appender would create a duplicate section.
pub fn is_quick_notes_header(l: &str) -> bool {
    let Some(after) = l.strip_prefix("##") else {
        return false;
    };
    let lead = after.trim_start();
    lead.len() < after.len() && lead.trim_end() == "Quick Notes"
}

/// `/^##\s+/` — an H2 heading (terminates the section). A `### ` line does NOT
/// match (after `##` comes `#`, not whitespace), matching the JS regex. `pub` so
/// the daily-log sink shares the same section-boundary rule as the delete path.
pub fn is_h2(l: &str) -> bool {
    l.strip_prefix("##")
        .map(|after| after.starts_with(char::is_whitespace))
        .unwrap_or(false)
}

/// (body_start, body_end) of the `## Quick Notes` section body, or None.
fn quick_notes_range(lines: &[String]) -> Option<(usize, usize)> {
    let header = lines.iter().position(|l| is_quick_notes_header(l))?;
    let mut end = header + 1;
    while end < lines.len() && !is_h2(&lines[end]) {
        end += 1;
    }
    Some((header + 1, end))
}

/// Raw line indices of quick-note bullets in `[start, end)`. Mirrors
/// `quickNotesBulletLines`: a trimmed `-\s+` prefix with a non-empty body.
fn bullet_line_indices(lines: &[String], start: usize, end: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for (k, line) in lines.iter().enumerate().take(end).skip(start) {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix('-') {
            if rest.starts_with(char::is_whitespace) && !rest.trim().is_empty() {
                out.push(k);
            }
        }
    }
    out
}

/// `t.trim().replace(/^-\s+/, '').trim()` — the displayed note text.
fn bullet_body(line: &str) -> String {
    let t = line.trim();
    let body = t.strip_prefix('-').map(str::trim_start).unwrap_or(t);
    body.trim().to_string()
}

/// Map a parsed-bullet `index` → its raw line number, verifying the text
/// (stale-projection guard — a desynced index errors instead of removing the
/// wrong line).
pub fn locate_quick_note(
    lines: &[String],
    index: usize,
    expected_text: &str,
) -> Result<usize, QuickNoteLocateErr> {
    let (body_start, body_end) = quick_notes_range(lines).ok_or(QuickNoteLocateErr::NoSection)?;
    let idxs = bullet_line_indices(lines, body_start, body_end);
    let line_idx = *idxs.get(index).ok_or(QuickNoteLocateErr::IndexOob)?;
    if bullet_body(&lines[line_idx]) != expected_text {
        return Err(QuickNoteLocateErr::TextMismatch);
    }
    Ok(line_idx)
}
