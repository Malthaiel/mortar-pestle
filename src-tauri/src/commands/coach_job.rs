//! Coaching-notes job — the Rust-owned long half of the Game Wiki gear button.
//!
//! The three-phase coaching pipeline lives in the CONTENT vault as
//! `Infrastructure/Scripts/coaching/coach.py` and is deliberately NOT
//! reimplemented here: its three isolated `claude -p` processes are the quality
//! mechanism (phase 3 audits a draft it never wrote), and a Rust port would put
//! that isolation at risk for nothing. This module shells the script and streams
//! its stdout/stderr.
//!
//! Shape mirrors `comms_job.rs`: one job at a time in a process-lifetime
//! `OnceLock` cell, progress on a GLOBAL `coach-job-progress` event, re-attach on
//! mount via `coach_job_status`. A full run is 10–20 minutes and the popup is
//! closable mid-run, so the job MUST outlive the webview that started it.
//!
//! Two things the script does that the UI has to understand:
//!
//! 1. **Exit code 2 is a normal outcome, not a crash.** `coach.py` raises `Halt`
//!    for every gate. The human-facing one is the review gate: phase 1 found more
//!    uncertain terms than the threshold, printed them as correction-log table
//!    rows, and stopped. That lands as `status: gate` with the terms parsed out,
//!    NOT as an error. Every other Halt (turn-count drift, contamination,
//!    §10/§11 conformance, missing delta-log blocks) lands as `error` with the
//!    message verbatim — those name a file and a problem and must not be
//!    paraphrased.
//! 2. **Every run costs real money.** Per-phase cost is printed as it accrues and
//!    totalled at the end; the snapshot carries the running figure so the popup
//!    can show what has been spent so far.

use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

/// Raw output lines kept for the popup's "show details" pane. A 56-minute run
/// prints well under a hundred; the cap only stops a pathological loop from
/// growing the snapshot without bound (it ships on every progress event).
const MAX_LINES: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CoachStatus {
    Running,
    /// The review gate stopped the run (exit 2) — `gateTerms` is populated and
    /// the user resumes with `fromPhase: 2` or restarts with `noGate`.
    Gate,
    Done,
    Error,
    Cancelled,
}

/// The status snapshot — `coach_job_status`' return AND the progress-event
/// payload, so the frontend has exactly one shape to render.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachSnapshot {
    pub status: CoachStatus,
    pub scrim: String,
    pub match_n: u32,
    /// 0 before the first `Phase N —` line, then 1/2/3.
    pub phase: u8,
    /// Phase 1 chunk progress; `None` for phases 2 and 3 (single calls).
    pub chunk: Option<u32>,
    pub chunk_total: Option<u32>,
    /// Dollars billed so far this run.
    pub cost: f64,
    /// The `heard` column of each flagged correction-log row, for the tick list.
    pub gate_terms: Vec<String>,
    /// A Halt message (verbatim) or a spawn failure.
    pub error: Option<String>,
    /// Every stdout/stderr line, in order.
    pub lines: Vec<String>,
    /// Absolute path of the finished notes, parsed off the `Done.` line.
    pub deliverable: Option<String>,
    pub started_ms: u64,
}

struct CoachJob {
    scrim: String,
    match_n: u32,
    phase: u8,
    chunk: Option<u32>,
    chunk_total: Option<u32>,
    cost: f64,
    gate_terms: Vec<String>,
    error: Option<String>,
    lines: Vec<String>,
    deliverable: Option<String>,
    started_ms: u64,
    status: CoachStatus,
    cancel_requested: bool,
    pid: Option<u32>,
    /// Set while consuming the indented table rows that follow a gate header.
    in_gate_block: bool,
    /// Set by the `Done. $X this run.` line so the NEXT line is read as the path.
    expect_deliverable: bool,
}

fn cell() -> &'static Mutex<Option<CoachJob>> {
    static CELL: OnceLock<Mutex<Option<CoachJob>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn lock() -> std::sync::MutexGuard<'static, Option<CoachJob>> {
    cell().lock().unwrap_or_else(|p| p.into_inner())
}

fn snapshot(job: &CoachJob) -> CoachSnapshot {
    CoachSnapshot {
        status: job.status,
        scrim: job.scrim.clone(),
        match_n: job.match_n,
        phase: job.phase,
        chunk: job.chunk,
        chunk_total: job.chunk_total,
        cost: job.cost,
        gate_terms: job.gate_terms.clone(),
        error: job.error.clone(),
        lines: job.lines.clone(),
        deliverable: job.deliverable.clone(),
        started_ms: job.started_ms,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Line parsing ─────────────────────────────────────────────────────────────
// Formats are fixed by coach.py's own print statements; each helper names the
// line it reads so a change to the script is traceable to one function.

/// `Phase 2 — Author` / `Phase 1 — Normalizer · 1380 turns in 12 chunk(s)`
fn parse_phase(line: &str) -> Option<(u8, Option<u32>)> {
    let rest = line.strip_prefix("Phase ")?;
    let n = rest.chars().next()?.to_digit(10)? as u8;
    // The chunk total only appears on the phase 1 header.
    let total = rest
        .split_once(" turns in ")
        .and_then(|(_, tail)| tail.split_whitespace().next())
        .and_then(|w| w.parse::<u32>().ok());
    Some((n, total))
}

/// `  phase1 chunk 3/12: 9087 in / 5132 out, $0.1384, 46.7s` — the `i/n` half.
fn parse_chunk(line: &str) -> Option<(u32, u32)> {
    let after = line.split_once(" chunk ")?.1;
    let frac = after.split_once(':')?.0;
    let (i, n) = frac.split_once('/')?;
    Some((i.trim().parse().ok()?, n.trim().parse().ok()?))
}

/// The `$0.1384` in any per-call cost line. Stops at the comma that follows it,
/// so the trailing `, 46.7s` never reaches the float parser.
fn parse_cost(line: &str) -> Option<f64> {
    let after = line.split_once('$')?.1;
    let num: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    num.parse().ok()
}

/// The `heard` column of a flagged correction-log row:
/// `   | Richelist | Ritualist | Ritualist 1-6 | CORRECTED | … |`
fn parse_gate_term(line: &str) -> Option<String> {
    let t = line.trim();
    let cell = t.strip_prefix('|')?.split('|').next()?.trim();
    if cell.is_empty() {
        None
    } else {
        Some(cell.to_string())
    }
}

/// Fold one output line into the job state. Returns true when something the UI
/// renders changed, so an unremarkable line doesn't cost an IPC round trip.
fn absorb(job: &mut CoachJob, line: &str) -> bool {
    if job.lines.len() < MAX_LINES {
        job.lines.push(line.to_string());
    }
    let trimmed = line.trim_end();

    // A gate block runs from its header to the first non-table line.
    if job.in_gate_block {
        if let Some(term) = parse_gate_term(trimmed) {
            job.gate_terms.push(term);
            return true;
        }
        if !trimmed.trim().is_empty() {
            job.in_gate_block = false;
        }
    }

    if job.expect_deliverable {
        job.expect_deliverable = false;
        if !trimmed.trim().is_empty() {
            job.deliverable = Some(trimmed.trim().to_string());
            return true;
        }
    }

    // "Review gate — N uncertain terms (threshold M):" STOPS the run; the
    // near-identical "…uncertain term(s), threshold M. Continuing." does not.
    // The trailing colon is the only thing separating them.
    if trimmed.starts_with("Review gate — ") {
        if trimmed.ends_with(':') {
            job.in_gate_block = true;
            job.gate_terms.clear();
            return true;
        }
        return true;
    }

    if let Some((n, total)) = parse_phase(trimmed) {
        job.phase = n;
        job.chunk = None;
        job.chunk_total = total;
        return true;
    }

    if trimmed.starts_with("Done. $") {
        // The end-of-run total supersedes the accumulated per-call figures.
        if let Some(c) = parse_cost(trimmed) {
            job.cost = c;
        }
        job.expect_deliverable = true;
        return true;
    }

    // HALT is the script's own failure envelope (stderr). Keep it verbatim —
    // every one of them names a file and a problem.
    if let Some(msg) = trimmed.strip_prefix("HALT: ") {
        job.error = Some(msg.trim().to_string());
        return true;
    }

    // Any per-call line carries a cost; the chunk fraction rides along on phase 1.
    if trimmed.contains(" in / ") && trimmed.contains(" out, $") {
        if let Some((i, n)) = parse_chunk(trimmed) {
            job.chunk = Some(i);
            job.chunk_total = Some(n);
        }
        if let Some(c) = parse_cost(trimmed) {
            job.cost = (job.cost + c * 10_000.0).round() / 10_000.0;
        }
        return true;
    }

    false
}

fn emit_progress(app: &AppHandle) {
    let snap = {
        let g = lock();
        let Some(job) = g.as_ref() else { return };
        snapshot(job)
    };
    let _ = app.emit("coach-job-progress", &snap);
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Absolute path to `coach.py` in the content vault.
fn script_path() -> std::path::PathBuf {
    std::path::PathBuf::from(crate::commands::vault::vault_root())
        .join("Infrastructure")
        .join("Scripts")
        .join("coaching")
        .join("coach.py")
}

/// Start a coaching run. `from_phase` resumes (the review-gate continue is
/// `from_phase: 2`); `no_gate` skips the review stop entirely. A RUNNING job
/// blocks a start — the script archives rather than overwrites, but two
/// concurrent runs over one match folder would still race each other's writes.
#[tauri::command]
pub async fn coach_job_start(
    app: AppHandle,
    scrim: String,
    match_n: u32,
    from_phase: Option<u8>,
    only: Option<u8>,
    no_gate: Option<bool>,
) -> Result<(), String> {
    if scrim.trim().is_empty() {
        return Err("scrim name required".into());
    }
    let script = script_path();
    if !script.is_file() {
        return Err(format!("coach.py not found at {}", script.display()));
    }
    {
        let mut g = lock();
        if matches!(g.as_ref(), Some(j) if j.status == CoachStatus::Running) {
            return Err("a coaching run is already going".into());
        }
        *g = Some(CoachJob {
            scrim: scrim.clone(),
            match_n,
            phase: 0,
            chunk: None,
            chunk_total: None,
            cost: 0.0,
            gate_terms: Vec::new(),
            error: None,
            lines: Vec::new(),
            deliverable: None,
            started_ms: now_ms(),
            status: CoachStatus::Running,
            cancel_requested: false,
            pid: None,
            in_gate_block: false,
            expect_deliverable: false,
        });
    }

    let mut cmd = crate::commands::proc_util::python_cmd();
    // -u is load-bearing: against a pipe, Python block-buffers stdout and every
    // progress line would arrive in one lump when the process exits — which is
    // exactly the 20-minute window the streaming UI exists to fill.
    // coach.py reconfigures stdout to UTF-8 but NOT stderr, so on Windows the
    // em-dash in a `HALT:` message arrives as cp1252 mojibake — and tokio's line
    // reader ABORTS on invalid UTF-8, silently swallowing the rest of the pipe.
    // The net effect without this: every failure renders as a bare exit code
    // instead of the message naming the file and the problem. (Verified live
    // 2026-07-27.)
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.arg("-u")
        .arg(&script)
        .arg("run")
        .arg(&scrim)
        .arg(match_n.to_string());
    if let Some(f) = from_phase {
        cmd.arg("--from").arg(f.to_string());
    }
    if let Some(o) = only {
        cmd.arg("--only").arg(o.to_string());
    }
    if no_gate.unwrap_or(false) {
        cmd.arg("--no-gate");
    }
    // coach.py resolves its imports and vault paths off __file__, so cwd is only
    // hygiene — but it keeps relative paths in any future error message readable.
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn python: {e}"))?;

    if let Some(job) = lock().as_mut() {
        job.pid = child.id();
    }

    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = task_app;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        // Both pipes must be drained concurrently — reading one to EOF first
        // deadlocks as soon as the other fills its buffer.
        tokio::join!(drain(stdout, app.clone()), drain(stderr, app.clone()));
        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        settle(&app, code);
    });

    emit_progress(&app);
    Ok(())
}

/// Read one pipe to EOF, folding each line into the job. Generic because stdout
/// and stderr are distinct types — a closure would only admit one of them.
async fn drain<R: tokio::io::AsyncRead + Unpin>(pipe: Option<R>, app: AppHandle) {
    let Some(pipe) = pipe else { return };
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let changed = {
            let mut g = lock();
            match g.as_mut() {
                Some(job) => absorb(job, &line),
                None => return,
            }
        };
        if changed {
            emit_progress(&app);
        }
    }
}

/// Map the exit code onto a terminal status and emit `coach-job-done`.
fn settle(app: &AppHandle, code: i32) {
    let (snap, payload) = {
        let mut g = lock();
        let Some(job) = g.as_mut() else { return };
        job.status = if job.cancel_requested {
            CoachStatus::Cancelled
        } else if code == 0 {
            CoachStatus::Done
        } else if !job.gate_terms.is_empty() {
            // Exit 2 with terms in hand is the review gate: a stop that WANTS
            // the user, not a failure.
            CoachStatus::Gate
        } else {
            if job.error.is_none() {
                job.error = Some(format!("the pipeline stopped with exit code {code}"));
            }
            CoachStatus::Error
        };
        let snap = snapshot(job);
        (
            snap.clone(),
            serde_json::json!({
                "status": snap.status,
                "scrim": snap.scrim,
                "matchN": snap.match_n,
                "cost": snap.cost,
                "error": snap.error,
                "deliverable": snap.deliverable,
            }),
        )
    };
    let _ = app.emit("coach-job-progress", &snap);
    let _ = app.emit("coach-job-done", &payload);
}

/// The current job snapshot (`None` = never run this session). The popup's
/// re-attach probe: closing the window and re-opening the gear lands here.
#[tauri::command]
pub fn coach_job_status() -> Option<CoachSnapshot> {
    lock().as_ref().map(snapshot)
}

/// Drop a terminal job so the popup returns to its start state. A RUNNING job is
/// never cleared from here.
#[tauri::command]
pub fn coach_job_clear() {
    let mut g = lock();
    if matches!(g.as_ref(), Some(j) if j.status != CoachStatus::Running) {
        *g = None;
    }
}

/// Stop the run. Kills the whole process tree — `coach.py` spawns a `claude`
/// child per phase, and killing only the parent would leave a billed generation
/// running with nothing to consume it.
#[tauri::command]
pub fn coach_job_cancel() {
    let pid = {
        let mut g = lock();
        let Some(job) = g.as_mut() else { return };
        if job.status != CoachStatus::Running {
            return;
        }
        job.cancel_requested = true;
        job.pid
    };
    if let Some(pid) = pid {
        crate::commands::job_queue::kill_child_graceful(pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> CoachJob {
        CoachJob {
            scrim: "s".into(), match_n: 1, phase: 0, chunk: None, chunk_total: None,
            cost: 0.0, gate_terms: Vec::new(), error: None, lines: Vec::new(),
            deliverable: None, started_ms: 0, status: CoachStatus::Running,
            cancel_requested: false, pid: None, in_gate_block: false,
            expect_deliverable: false,
        }
    }

    /// Every line shape coach.py actually prints, in the order a real run emits
    /// them. Guards the one thing that silently breaks the whole popup: a print
    /// format changing in the script.
    #[test]
    fn parses_a_real_run() {
        let mut j = job();
        absorb(&mut j, "Phase 1 — Normalizer · 1380 turns in 12 chunk(s)");
        assert_eq!(j.phase, 1);
        assert_eq!(j.chunk_total, Some(12));

        absorb(&mut j, "  phase1 chunk 3/12: 9087 in / 5132 out, $0.1384, 46.7s");
        assert_eq!(j.chunk, Some(3));
        assert_eq!(j.cost, 0.1384);

        // The passing gate must NOT open a gate block.
        absorb(&mut j, "Review gate — 2 uncertain term(s), threshold 5. Continuing.");
        assert!(!j.in_gate_block);

        absorb(&mut j, "Phase 2 — Author");
        assert_eq!(j.phase, 2);
        assert_eq!(j.chunk, None);

        absorb(&mut j, "Done. $5.9012 this run.");
        absorb(&mut j, "  C:\\x\\Match 1\\Deadlock Coaching — s Match 1.md");
        assert_eq!(j.cost, 5.9012);
        assert_eq!(j.deliverable.as_deref(), Some("C:\\x\\Match 1\\Deadlock Coaching — s Match 1.md"));
    }

    #[test]
    fn stopping_gate_collects_the_heard_column() {
        let mut j = job();
        absorb(&mut j, "Review gate — 48 uncertain terms (threshold 5):");
        absorb(&mut j, "   | Richelist | Ritualist | Ritualist 1-6 | CORRECTED | phonetic |");
        absorb(&mut j, "   | T-Bolee | T-Bolee | — | UNMATCHED | unclear |");
        absorb(&mut j, "");
        assert_eq!(j.gate_terms, vec!["Richelist", "T-Bolee"]);
        // A blank line inside the block is tolerated; the next real line closes it.
        absorb(&mut j, "something else");
        assert!(!j.in_gate_block);
    }

    #[test]
    fn halt_is_kept_verbatim() {
        let mut j = job();
        absorb(&mut j, "HALT: turn count changed 1380 -> 1377 in chunk 4");
        assert_eq!(j.error.as_deref(), Some("turn count changed 1380 -> 1377 in chunk 4"));
    }
}
