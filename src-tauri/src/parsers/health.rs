//! Health Column daily-log sections — parser + per-day writers (Health Column
//! epic, sub-plan 3 Nutrition; `## Workout` / `## Cardio` are contract-level
//! stubs for sub-plans 4–5).
//!
//! Clones `parsers/sessions.rs`: the same lenient section scan, the same
//! `OkOut` / rich-delete-block / `check_mtime` / `atomic_write` writer flow, and
//! the same DESYNC-SAFETY guard — `find_meal_bullet` returning `None` means
//! "bullet not found", and every writer returns `ok: false` WITHOUT mutating the
//! file rather than falling through to a write (a hand-edited `## Nutrition Log`
//! bullet must never be silently corrupted).
//!
//! SNAPSHOT CONTRACT: a logged bullet stores the display NAME + computed TOTALS
//! + an inline MICRO TAIL, and carries NO meal id / fdc_id / reference. Logging
//! freezes the numbers as text; editing a Library meal definition can therefore
//! never rewrite a past day's bullet, because nothing here re-derives a logged
//! value from a live definition. Saved-meal and ad-hoc ("quick add") logs are
//! byte-indistinguishable by construction.
//!
//! Grammar (em-dash `—` U+2014 name/meta · middle-dot `·` U+00B7 macro group ·
//! pipe `|` macro→micro tail; `→` U+2192 is reserved for Workout/Cardio):
//!
//! ```text
//! ## Nutrition Log
//!
//! - 13:05 — Chicken & Rice Bowl — 612 kcal · 48p / 71c / 14f | fiber=6g sodium=540mg sugar=4g/2g
//!   + Vitamin D3 — 25mcg · vitamin_d=25mcg
//!   + Creatine — 5g
//! ```

use std::fs;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, VaultError};
use crate::parsers::daily::{daily_path, escape_regex};
use crate::parsers::sessions::OkOut;

// Separators (kept as named consts so the format + parse sides can never drift).
const EM: char = '\u{2014}'; // — em-dash (NOT sessions' en-dash U+2013)
const MID: char = '\u{00B7}'; // · middle dot
const ARROW: char = '\u{2192}'; // → target → actual split (Workout / Cardio)
const CROSS: char = '\u{00D7}'; // × sets × reps (Workout)

// ─── Data ────────────────────────────────────────────────────────────────────

/// One `key=amt<unit>` token in a micro tail. Units are baked into the file, so
/// the log is unit-safe and no nutrient-id map is needed at read time.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MicroTok {
    pub key: String,
    pub amount: f64,
    pub unit: String,
}

/// Total / added sugar. `None` ⇒ "not reported" (`na`), never zero.
/// `natural_sugar` is computed (`max(0, total − added)`) and NEVER stored.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Sugar {
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub added: Option<f64>,
}

/// A supplement attached to a meal (nested `+` sub-bullet). Dose is free-text
/// ("25mcg", "5g"); it carries its own micros (not from FDC). Dose-only (no
/// micro tail) is allowed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Supplement {
    pub name: String,
    #[serde(default)]
    pub dose: Option<String>,
    #[serde(default)]
    pub micros: Vec<MicroTok>,
}

/// A logged meal — also the write payload (`parse_nutrition_log` returns these;
/// `log_meal` / `edit_meal_log` consume them). All numbers are frozen totals.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MealLogEntry {
    #[serde(default)]
    pub time: Option<String>,
    pub name: String,
    pub kcal: f64,
    pub protein: f64,
    pub carb: f64,
    pub fat: f64,
    #[serde(default)]
    pub sugar: Sugar,
    #[serde(default)]
    pub micros: Vec<MicroTok>,
    #[serde(default)]
    pub supplements: Vec<Supplement>,
}

/// Re-identifies a logged bullet for edit/delete by its frozen time + name
/// (there is no stored id to drift).
#[derive(Deserialize, Debug, Clone)]
pub struct MealTarget {
    #[serde(default)]
    pub time: Option<String>,
    pub name: String,
}

/// A health delete's richer return — `OkOut` plus the drained block for
/// recycle-bin capture (mirrors `sessions::DeleteSessionOut`). Reused across all
/// three health sections (`delete_meal_log` / `delete_workout` / `delete_cardio`).
/// The command wrapper maps it back to `OkOut` so the frontend contract is
/// unchanged.
#[derive(Debug)]
pub struct DeleteMealOut {
    pub ok: bool,
    pub error: Option<String>,
    pub mtime: f64,
    /// The drained block, verbatim — the faithful bin copy (a meal head + its
    /// supplement sub-bullets, a whole `## Workout` block, or one cardio line).
    /// `None` when nothing was deleted.
    pub removed_block: Option<String>,
    /// The block's line index at delete time (restore placement hint).
    pub line_hint: Option<u32>,
    /// The section heading the block lived under (`## Nutrition Log` /
    /// `## Workout` / `## Cardio`).
    pub heading: Option<String>,
}

// ─── Fitness data (Workout / Cardio) ──────────────────────────────────────────

/// One exercise line under a `### DayLabel`. `sets`/`reps`/`weight` are the FROZEN
/// target snapshotted from the split at log time; `actual` is the verbatim
/// right-of-`→` text (free-form, never re-parsed); `done` is the checkbox. Also
/// the `edit_workout` payload.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ExerciseLog {
    pub name: String,
    pub sets: u32,
    /// Free-text reps — "8", "8-12", "AMRAP" (sub-plan 4). Snapshot-frozen.
    pub reps: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

/// The whole `## Workout` block for a day: a day label + its exercise checklist.
/// Also the `log_workout` payload (the snapshot the UI freezes from the split).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WorkoutLogEntry {
    pub day_label: String,
    pub exercises: Vec<ExerciseLog>,
}

/// One logged cardio segment — frozen `(kind, minutes, zone)` target + verbatim
/// `actual`. Also the `log_cardio` payload.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CardioLogEntry {
    #[serde(rename = "type")]
    pub kind: String,
    pub minutes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

/// Re-identifies a logged cardio bullet for edit/delete by its frozen fields
/// (there is no stored id to drift).
#[derive(Deserialize, Debug, Clone)]
pub struct CardioTarget {
    #[serde(rename = "type")]
    pub kind: String,
    pub minutes: u32,
    #[serde(default)]
    pub zone: Option<String>,
}

// ─── Number formatting (round-trip-safe) ──────────────────────────────────────

/// One decimal, trailing `.0` stripped: 6.0→"6", 3.2→"3.2", 540.0→"540",
/// 0.4→"0.4". Reformatting a parsed canonical value reproduces it exactly.
fn fmt_amt(x: f64) -> String {
    let s = format!("{:.1}", x);
    match s.strip_suffix(".0") {
        Some(stripped) => stripped.to_string(),
        None => s,
    }
}

fn fmt_sugar_side(v: Option<f64>) -> String {
    match v {
        None => "na".to_string(),
        Some(x) => format!("{}g", fmt_amt(x)),
    }
}

fn fmt_micro(m: &MicroTok) -> String {
    format!("{}={}{}", m.key, fmt_amt(m.amount), m.unit)
}

/// Meal micro tail: space-separated micros, then the always-last sugar token.
fn format_meal_tail(micros: &[MicroTok], sugar: &Sugar) -> String {
    let mut toks: Vec<String> = micros.iter().map(fmt_micro).collect();
    toks.push(format!(
        "sugar={}/{}",
        fmt_sugar_side(sugar.total),
        fmt_sugar_side(sugar.added)
    ));
    toks.join(" ")
}

fn format_supplement(s: &Supplement) -> String {
    let mut line = format!("  + {}", s.name.trim());
    if let Some(dose) = s.dose.as_ref().map(|d| d.trim()).filter(|d| !d.is_empty()) {
        line.push_str(&format!(" {} {}", EM, dose));
    }
    if !s.micros.is_empty() {
        let tail: Vec<String> = s.micros.iter().map(fmt_micro).collect();
        line.push_str(&format!(" {} {}", MID, tail.join(" ")));
    }
    line
}

/// The full meal block: head bullet + one indented `+` line per supplement.
fn format_meal_block(e: &MealLogEntry) -> Vec<String> {
    let mut head = String::from("- ");
    if let Some(t) = e.time.as_ref().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        head.push_str(&format!("{} {} ", t, EM));
    }
    head.push_str(&format!(
        "{} {} {} kcal {} {}p / {}c / {}f | {}",
        e.name.trim(),
        EM,
        fmt_amt(e.kcal),
        MID,
        fmt_amt(e.protein),
        fmt_amt(e.carb),
        fmt_amt(e.fat),
        format_meal_tail(&e.micros, &e.sugar),
    ));
    let mut block = vec![head];
    for s in &e.supplements {
        block.push(format_supplement(s));
    }
    block
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/// Split a `<num><unit>` chunk at the first non-numeric char ("3.2mg" →
/// (3.2, "mg")). Returns `None` if there is no leading number.
fn split_amount_unit(s: &str) -> Option<(f64, String)> {
    let end = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(s.len());
    let amount: f64 = s[..end].parse().ok()?;
    Some((amount, s[end..].to_string()))
}

fn parse_micro_tok(tok: &str) -> Option<MicroTok> {
    let (key, rest) = tok.split_once('=')?;
    let (amount, unit) = split_amount_unit(rest)?;
    Some(MicroTok {
        key: key.to_string(),
        amount,
        unit,
    })
}

/// One side of a sugar token: "na" → `None` (not reported), "4g" → `Some(4.0)`.
fn parse_sugar_side(s: &str) -> Option<f64> {
    if s == "na" {
        return None;
    }
    split_amount_unit(s).map(|(a, _)| a)
}

/// Parse a micro tail into (micros, sugar). The `sugar=t/a` token is pulled out;
/// everything else that looks like `key=amt<unit>` becomes a micro. Unknown
/// tokens are ignored (tolerant of hand edits / future keys).
fn parse_meal_tail(tail: &str) -> (Vec<MicroTok>, Sugar) {
    let mut micros = Vec::new();
    let mut sugar = Sugar::default();
    for tok in tail.split_whitespace() {
        if let Some(rest) = tok.strip_prefix("sugar=") {
            if let Some((t, a)) = rest.split_once('/') {
                sugar = Sugar {
                    total: parse_sugar_side(t),
                    added: parse_sugar_side(a),
                };
            }
        } else if let Some(m) = parse_micro_tok(tok) {
            micros.push(m);
        }
    }
    (micros, sugar)
}

fn head_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^- (?:(\d{1,2}:\d{2}) \u{2014} )?(.+?) \u{2014} ([\d.]+) kcal \u{00B7} ([\d.]+)p / ([\d.]+)c / ([\d.]+)f(?: \| (.+))?$",
        )
        .unwrap()
    })
}

fn supp_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^  \+ (.+?)(?: \u{2014} (.+?))?(?: \u{00B7} (.+))?$").unwrap())
}

/// Parse the `## Nutrition Log` section. Lenient: returns `[]` when the section
/// is absent (mirrors `parse_sessions`); no-ops cleanly on the thousands of
/// existing daily logs that never had the section.
pub fn parse_nutrition_log(content: &str) -> Vec<MealLogEntry> {
    let head = head_re();
    let supp = supp_re();
    let lines: Vec<&str> = content.split('\n').collect();
    let mut out: Vec<MealLogEntry> = Vec::new();
    let mut in_section = false;
    let mut i = 0;
    while i < lines.len() {
        let trim = lines[i].trim();
        if trim == "## Nutrition Log" {
            in_section = true;
            i += 1;
            continue;
        }
        if !in_section {
            i += 1;
            continue;
        }
        if trim.starts_with("## ") {
            in_section = false;
            i += 1;
            continue;
        }
        if let Some(m) = head.captures(lines[i]) {
            let time = m.get(1).map(|x| x.as_str().to_string());
            let name = m[2].trim().to_string();
            let kcal = m[3].parse().unwrap_or(0.0);
            let protein = m[4].parse().unwrap_or(0.0);
            let carb = m[5].parse().unwrap_or(0.0);
            let fat = m[6].parse().unwrap_or(0.0);
            let (micros, sugar) = m
                .get(7)
                .map(|t| parse_meal_tail(t.as_str()))
                .unwrap_or_default();

            // Collect nested supplement sub-bullets (`  + …`).
            let mut supplements = Vec::new();
            let mut j = i + 1;
            while j < lines.len()
                && lines[j].starts_with("  ")
                && !lines[j].trim().starts_with("- ")
            {
                if let Some(sm) = supp.captures(lines[j]) {
                    supplements.push(Supplement {
                        name: sm[1].trim().to_string(),
                        dose: sm.get(2).map(|x| x.as_str().trim().to_string()),
                        micros: sm
                            .get(3)
                            .map(|t| parse_meal_tail(t.as_str()).0)
                            .unwrap_or_default(),
                    });
                }
                j += 1;
            }
            out.push(MealLogEntry {
                time,
                name,
                kcal,
                protein,
                carb,
                fat,
                sugar,
                micros,
                supplements,
            });
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

// ─── Fitness parsing (Workout / Cardio) ───────────────────────────────────────
// Read-side parity for the JS `fitnessLog.js` parsers (the day read is JS-side).
// `@weight` stops before the arrow (`[^→]+?`) so a trailing `→ actual` isn't
// swallowed. `done = checkbox != " "`.

fn exercise_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^- \[([ xX])\] (.+?) \u{2014} (\d+)\u{00D7}([^\s@\u{2192}]+)(?: @([^\u{2192}]+?))?(?: \u{2192} (.+))?$",
        )
        .unwrap()
    })
}

fn day_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^###\s+(.+?)\s*$").unwrap())
}

fn cardio_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^- \[([ xX])\] (.+?) \u{2014} (\d+)m(?: \(([^)]+)\))?(?: \u{2192} (.+))?$")
            .unwrap()
    })
}

/// Parse the `## Workout` section into day blocks. Lenient: `[]` when absent
/// (mirrors `parse_nutrition_log`). A `### Label` opens a new block; exercise
/// bullets push onto the current block (a synthetic empty-label block absorbs any
/// bullets that precede a `###`, so a hand-edited section still round-trips).
pub fn parse_workout(content: &str) -> Vec<WorkoutLogEntry> {
    let day = day_re();
    let ex = exercise_re();
    let mut out: Vec<WorkoutLogEntry> = Vec::new();
    let mut in_section = false;
    for line in content.split('\n') {
        let trim = line.trim();
        if trim == "## Workout" {
            in_section = true;
            continue;
        }
        if !in_section {
            continue;
        }
        if trim.starts_with("## ") {
            in_section = false;
            continue;
        }
        if let Some(c) = day.captures(line) {
            out.push(WorkoutLogEntry {
                day_label: c[1].trim().to_string(),
                exercises: Vec::new(),
            });
        } else if let Some(c) = ex.captures(line) {
            if out.is_empty() {
                out.push(WorkoutLogEntry {
                    day_label: String::new(),
                    exercises: Vec::new(),
                });
            }
            out.last_mut().unwrap().exercises.push(ExerciseLog {
                name: c[2].trim().to_string(),
                sets: c[3].parse().unwrap_or(0),
                reps: c[4].to_string(),
                weight: c.get(5).map(|m| m.as_str().trim().to_string()),
                done: &c[1] != " ",
                actual: c.get(6).map(|m| m.as_str().trim().to_string()),
            });
        }
    }
    out
}

/// Parse the `## Cardio` section into segments. Lenient: `[]` when absent.
pub fn parse_cardio(content: &str) -> Vec<CardioLogEntry> {
    let re = cardio_re();
    let mut out: Vec<CardioLogEntry> = Vec::new();
    let mut in_section = false;
    for line in content.split('\n') {
        let trim = line.trim();
        if trim == "## Cardio" {
            in_section = true;
            continue;
        }
        if !in_section {
            continue;
        }
        if trim.starts_with("## ") {
            in_section = false;
            continue;
        }
        if let Some(c) = re.captures(line) {
            out.push(CardioLogEntry {
                kind: c[2].trim().to_string(),
                minutes: c[3].parse().unwrap_or(0),
                zone: c.get(4).map(|m| m.as_str().trim().to_string()),
                done: &c[1] != " ",
                actual: c.get(5).map(|m| m.as_str().trim().to_string()),
            });
        }
    }
    out
}

// ─── Locators (DESYNC-SAFE) ───────────────────────────────────────────────────

/// Locate a meal head bullet by its frozen time + name. A `None` return is the
/// guard against hand-edited / malformed bullets: writers MUST treat it as
/// "not found" and return `ok: false` WITHOUT writing. Do not remove the
/// `let Some(..) = .. else { return ok:false }` branches in a refactor.
fn find_meal_bullet(lines: &[String], time: Option<&str>, name: &str) -> Option<usize> {
    let name_re = escape_regex(name.trim());
    let pattern = match time.map(|t| t.trim()).filter(|t| !t.is_empty()) {
        Some(t) => format!("^- {} {} {} {} ", escape_regex(t), EM, name_re, EM),
        None => format!("^- {} {} ", name_re, EM),
    };
    let re = Regex::new(&pattern).ok()?;
    lines.iter().position(|l| re.is_match(l))
}

/// End-exclusive index of the nested supplement block following `bullet_idx`
/// (indented `  ` lines that aren't a new `- ` top bullet) — same rule as
/// `sessions::note_block_end`.
fn meal_block_end(lines: &[String], bullet_idx: usize) -> usize {
    let mut end = bullet_idx + 1;
    while end < lines.len()
        && lines[end].starts_with("  ")
        && !lines[end].trim().starts_with("- ")
    {
        end += 1;
    }
    end
}

// ─── File helpers ─────────────────────────────────────────────────────────────

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

/// Find `## Nutrition Log`, else create it at END-OF-FILE (verified: no
/// daily-log reader hard-counts the canonical 7 sections, so appending after
/// them is safe). Returns the heading's line index.
fn ensure_health_heading(lines: &mut Vec<String>) -> usize {
    if let Some(i) = lines.iter().position(|l| l.trim() == "## Nutrition Log") {
        return i;
    }
    while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.push(String::new());
    lines.push("## Nutrition Log".to_string());
    lines.push(String::new());
    lines.len() - 2
}

// ─── Writers ──────────────────────────────────────────────────────────────────

/// Append a meal to `ds`'s daily log (auto-creates the section, and the file if
/// missing). Snapshot: the block is formatted from the frozen `entry` numbers.
pub fn log_meal(ds: &str, entry: MealLogEntry, base_mtime: Option<f64>) -> Result<OkOut, VaultError> {
    let p = daily_path(ds);
    check_mtime(&p, base_mtime)?;
    let content = read_or_create(&p)?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let heading_idx = ensure_health_heading(&mut lines);
    let mut insert_line = heading_idx + 1;
    while insert_line < lines.len() && !lines[insert_line].trim().starts_with("## ") {
        insert_line += 1;
    }
    lines.splice(insert_line..insert_line, format_meal_block(&entry));

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut {
        ok: true,
        error: None,
        mtime,
    })
}

/// Replace a logged meal's block in place (located by frozen time + name).
pub fn edit_meal_log(
    ds: &str,
    target: MealTarget,
    new_entry: MealLogEntry,
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

    let Some(idx) = find_meal_bullet(&lines, target.time.as_deref(), &target.name) else {
        return Ok(OkOut {
            ok: false,
            error: Some("Meal not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    };
    let end_i = meal_block_end(&lines, idx);
    lines.splice(idx..end_i, format_meal_block(&new_entry));

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut {
        ok: true,
        error: None,
        mtime,
    })
}

/// Delete a logged meal's block, capturing it verbatim for recycle-bin restore.
pub fn delete_meal_log(
    ds: &str,
    target: MealTarget,
    base_mtime: Option<f64>,
) -> Result<DeleteMealOut, VaultError> {
    let p = daily_path(ds);
    if !p.exists() {
        return Ok(DeleteMealOut {
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

    let Some(idx) = find_meal_bullet(&lines, target.time.as_deref(), &target.name) else {
        return Ok(DeleteMealOut {
            ok: false,
            error: Some("Meal not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
            removed_block: None,
            line_hint: None,
            heading: None,
        });
    };
    let block_end = meal_block_end(&lines, idx);
    // Capture the block verbatim BEFORE draining (the faithful bin copy);
    // exclude the trailing blank the drain also eats (a layout separator).
    let removed_block = lines[idx..block_end].join("\n");

    let mut end_i = block_end;
    if end_i < lines.len() && lines[end_i].trim().is_empty() {
        end_i += 1;
    }
    lines.drain(idx..end_i);

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(DeleteMealOut {
        ok: true,
        error: None,
        mtime,
        removed_block: Some(removed_block),
        line_hint: Some(idx as u32),
        heading: Some("## Nutrition Log".to_string()),
    })
}

// ─── Fitness formatting (Workout / Cardio) ────────────────────────────────────

fn fmt_exercise(e: &ExerciseLog) -> String {
    let mut s = format!(
        "- [{}] {} {} {}{}{}",
        if e.done { "x" } else { " " },
        e.name.trim(),
        EM,
        e.sets,
        CROSS,
        e.reps.trim()
    );
    if let Some(w) = e.weight.as_ref().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        s.push_str(&format!(" @{w}"));
    }
    if let Some(a) = e.actual.as_ref().map(|a| a.trim()).filter(|a| !a.is_empty()) {
        s.push_str(&format!(" {} {}", ARROW, a));
    }
    s
}

/// The full `## Workout` block body: the `### DayLabel` line + one bullet per
/// exercise (targets frozen inline at log time).
fn format_workout_block(w: &WorkoutLogEntry) -> Vec<String> {
    let mut out = vec![format!("### {}", w.day_label.trim())];
    out.extend(w.exercises.iter().map(fmt_exercise));
    out
}

fn fmt_cardio(c: &CardioLogEntry) -> String {
    let mut s = format!(
        "- [{}] {} {} {}m",
        if c.done { "x" } else { " " },
        c.kind.trim(),
        EM,
        c.minutes
    );
    if let Some(z) = c.zone.as_ref().map(|z| z.trim()).filter(|z| !z.is_empty()) {
        s.push_str(&format!(" ({z})"));
    }
    if let Some(a) = c.actual.as_ref().map(|a| a.trim()).filter(|a| !a.is_empty()) {
        s.push_str(&format!(" {} {}", ARROW, a));
    }
    s
}

// ─── Fitness heading helpers (clone `ensure_health_heading`) ───────────────────

fn ensure_workout_heading(lines: &mut Vec<String>) -> usize {
    if let Some(i) = lines.iter().position(|l| l.trim() == "## Workout") {
        return i;
    }
    while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.push(String::new());
    lines.push("## Workout".to_string());
    lines.push(String::new());
    lines.len() - 2
}

fn ensure_cardio_heading(lines: &mut Vec<String>) -> usize {
    if let Some(i) = lines.iter().position(|l| l.trim() == "## Cardio") {
        return i;
    }
    while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.push(String::new());
    lines.push("## Cardio".to_string());
    lines.push(String::new());
    lines.len() - 2
}

// ─── Workout writers ──────────────────────────────────────────────────────────

/// Seed/replace today's `## Workout` block from a chosen split day. THE snapshot
/// moment — every target is frozen inline. Idempotent: re-seeding drains the
/// whole existing body first, so "Start workout" can't duplicate the block.
pub fn log_workout(
    ds: &str,
    entry: WorkoutLogEntry,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    let p = daily_path(ds);
    check_mtime(&p, base_mtime)?;
    let content = read_or_create(&p)?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let heading_idx = ensure_workout_heading(&mut lines);
    let mut body_end = heading_idx + 1;
    while body_end < lines.len() && !lines[body_end].trim().starts_with("## ") {
        body_end += 1;
    }
    lines.splice(heading_idx + 1..body_end, format_workout_block(&entry));

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut {
        ok: true,
        error: None,
        mtime,
    })
}

/// Toggle/annotate ONE exercise in the `## Workout` block, located by its
/// position among the section's exercise bullets + a frozen-name re-check. The
/// DESYNC guard: an out-of-range index or a name that no longer matches returns
/// `ok:false` WITHOUT writing (a hand-edited bullet is never blind-overwritten).
pub fn edit_workout(
    ds: &str,
    index: usize,
    exercise: ExerciseLog,
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

    // Section's exercise-bullet line indices, in file order.
    let ex = exercise_re();
    let mut ex_idxs: Vec<usize> = Vec::new();
    let mut in_section = false;
    for (i, line) in lines.iter().enumerate() {
        let trim = line.trim();
        if trim == "## Workout" {
            in_section = true;
            continue;
        }
        if in_section && trim.starts_with("## ") {
            break;
        }
        if in_section && ex.is_match(line) {
            ex_idxs.push(i);
        }
    }
    let Some(&li) = ex_idxs.get(index) else {
        return Ok(OkOut {
            ok: false,
            error: Some("Exercise not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    };
    // Frozen-name re-check — the desync guard.
    let name_ok = ex
        .captures(&lines[li])
        .map(|c| c[2].trim() == exercise.name.trim())
        .unwrap_or(false);
    if !name_ok {
        return Ok(OkOut {
            ok: false,
            error: Some("Exercise changed on disk".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    }
    lines[li] = fmt_exercise(&exercise);

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut {
        ok: true,
        error: None,
        mtime,
    })
}

/// Delete the entire `## Workout` block (heading + body), capturing it verbatim
/// for recycle-bin restore. `ok:false` (no capture) when the section is absent.
pub fn delete_workout(ds: &str, base_mtime: Option<f64>) -> Result<DeleteMealOut, VaultError> {
    let p = daily_path(ds);
    if !p.exists() {
        return Ok(DeleteMealOut {
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

    let Some(heading_idx) = lines.iter().position(|l| l.trim() == "## Workout") else {
        return Ok(DeleteMealOut {
            ok: false,
            error: Some("Workout not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
            removed_block: None,
            line_hint: None,
            heading: None,
        });
    };
    let mut body_end = heading_idx + 1;
    while body_end < lines.len() && !lines[body_end].trim().starts_with("## ") {
        body_end += 1;
    }
    let removed_block = lines[heading_idx..body_end].join("\n");
    let mut end_i = body_end;
    if end_i < lines.len() && lines[end_i].trim().is_empty() {
        end_i += 1;
    }
    lines.drain(heading_idx..end_i);

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(DeleteMealOut {
        ok: true,
        error: None,
        mtime,
        removed_block: Some(removed_block),
        line_hint: Some(heading_idx as u32),
        heading: Some("## Workout".to_string()),
    })
}

// ─── Cardio writers (clone the meal writers; flat, no nested sub-bullets) ──────

/// `## Cardio` bullet line indices, in file order — for index-addressed edit/
/// delete (mirrors `edit_workout`'s `ex_idxs`). The render order in `day.cardio`
/// (parseCardioLog) matches this scan, so a row's list index maps 1:1 to a line.
fn cardio_bullet_idxs(lines: &[String]) -> Vec<usize> {
    let cre = cardio_re();
    let mut out: Vec<usize> = Vec::new();
    let mut in_section = false;
    for (i, line) in lines.iter().enumerate() {
        let trim = line.trim();
        if trim == "## Cardio" {
            in_section = true;
            continue;
        }
        if in_section && trim.starts_with("## ") {
            break;
        }
        if in_section && cre.is_match(line) {
            out.push(i);
        }
    }
    out
}

/// Frozen-identity re-check: does `line` parse as a cardio bullet with exactly
/// this `(kind, minutes, zone)`? The desync guard for the index-addressed ops —
/// two byte-identical bullets are addressed by position, but if the row at that
/// position changed on disk since the read, the op aborts (`ok:false`) instead
/// of rewriting the wrong segment.
fn cardio_frozen_match(line: &str, kind: &str, minutes: u32, zone: Option<&str>) -> bool {
    cardio_re()
        .captures(line)
        .map(|c| {
            let want = zone.map(|z| z.trim()).filter(|z| !z.is_empty());
            let got = c.get(4).map(|m| m.as_str().trim()).filter(|z| !z.is_empty());
            c[2].trim() == kind.trim()
                && c[3].parse::<u32>().ok() == Some(minutes)
                && got == want
        })
        .unwrap_or(false)
}

/// Append a cardio segment to today's `## Cardio` section (auto-creating it).
pub fn log_cardio(
    ds: &str,
    entry: CardioLogEntry,
    base_mtime: Option<f64>,
) -> Result<OkOut, VaultError> {
    let p = daily_path(ds);
    check_mtime(&p, base_mtime)?;
    let content = read_or_create(&p)?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();

    let heading_idx = ensure_cardio_heading(&mut lines);
    let mut insert_line = heading_idx + 1;
    while insert_line < lines.len() && !lines[insert_line].trim().starts_with("## ") {
        insert_line += 1;
    }
    lines.splice(insert_line..insert_line, std::iter::once(fmt_cardio(&entry)));

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut {
        ok: true,
        error: None,
        mtime,
    })
}

/// Replace a logged cardio segment in place. Addressed by its render-list `index`
/// (the i-th `## Cardio` bullet) with a frozen `(kind, minutes, zone)` re-check —
/// mirrors `edit_workout`. Index addressing disambiguates byte-identical bullets;
/// the re-check is the desync guard. `ok:false` (no write) on out-of-range or drift.
pub fn edit_cardio(
    ds: &str,
    index: usize,
    new_entry: CardioLogEntry,
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

    let idxs = cardio_bullet_idxs(&lines);
    let Some(&li) = idxs.get(index) else {
        return Ok(OkOut {
            ok: false,
            error: Some("Cardio not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    };
    if !cardio_frozen_match(
        &lines[li],
        &new_entry.kind,
        new_entry.minutes,
        new_entry.zone.as_deref(),
    ) {
        return Ok(OkOut {
            ok: false,
            error: Some("Cardio changed on disk".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
        });
    }
    lines[li] = fmt_cardio(&new_entry);

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(OkOut {
        ok: true,
        error: None,
        mtime,
    })
}

/// Delete a logged cardio segment, capturing it verbatim for recycle-bin restore.
/// Addressed by render-list `index` with a frozen `(kind, minutes, zone)` re-check
/// (the `target`) — same disambiguation + desync guard as `edit_cardio`.
pub fn delete_cardio(
    ds: &str,
    index: usize,
    target: CardioTarget,
    base_mtime: Option<f64>,
) -> Result<DeleteMealOut, VaultError> {
    let p = daily_path(ds);
    if !p.exists() {
        return Ok(DeleteMealOut {
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

    let idxs = cardio_bullet_idxs(&lines);
    let Some(&li) = idxs.get(index) else {
        return Ok(DeleteMealOut {
            ok: false,
            error: Some("Cardio not found".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
            removed_block: None,
            line_hint: None,
            heading: None,
        });
    };
    if !cardio_frozen_match(
        &lines[li],
        &target.kind,
        target.minutes,
        target.zone.as_deref(),
    ) {
        return Ok(DeleteMealOut {
            ok: false,
            error: Some("Cardio changed on disk".to_string()),
            mtime: fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0),
            removed_block: None,
            line_hint: None,
            heading: None,
        });
    }
    let removed_block = lines[li].clone();
    lines.remove(li);

    let mtime = write_and_mtime(&p, &lines.join("\n"))?;
    Ok(DeleteMealOut {
        ok: true,
        error: None,
        mtime,
        removed_block: Some(removed_block),
        line_hint: Some(li as u32),
        heading: Some("## Cardio".to_string()),
    })
}
