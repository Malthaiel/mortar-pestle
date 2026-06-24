//! Sub-feature 8 — skills runner command surface.
//!
//! Phase A: 3 read commands (skills_list, skills_get, skills_list_runs).
//! Phase B: 4 streaming/mutating commands (skills_run, skills_subscribe_run,
//! skills_cancel_run, skills_resize_run) over Tauri 2.x `Channel<SkillEvent>`
//! + portable-pty.
//!
//! Streaming wire shape — single tagged enum, one Channel per job:
//!
//! ```json
//! { "kind": "replay",   "text": "..." }
//! { "kind": "stdout",   "text": "..." }
//! { "kind": "done",     "exit_code": 0 }
//! { "kind": "cancelled","exit_code": 130 }
//! ```
//!
//! Cancel escalates exactly like Node's `runner.js::cancelRun`:
//! Ctrl+C → 1500 ms → SIGTERM → 2000 ms → SIGKILL.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::ipc::Channel;

use crate::commands::vault::{vault_root, SkillError};
use crate::parsers::skills::{
    compose_invocation, list_skills as parsers_list_skills, load_skill_by_slug, run_log_dir,
    SkillList,
};

const RING_LIMIT: usize = 256 * 1024;
const RETENTION_AFTER_EXIT: Duration = Duration::from_secs(5 * 60);
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;
const CANCEL_GRACE_MS: u64 = 1500;
const SIGKILL_GRACE_MS: u64 = 2000;

// ─── Wire types ─────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkillEvent {
    Replay { text: String },
    Stdout { text: String },
    Done { exit_code: i32 },
    Cancelled { exit_code: i32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Completed,
    Cancelled,
}

#[derive(Serialize)]
pub struct SkillsListResponse {
    pub categories: SkillList,
}

#[derive(Serialize)]
pub struct SkillGetResponse {
    pub slug: String,
    pub category: String,
    pub command: String,
    pub description: String,
    pub destructive: bool,
    pub interactive: bool,
    pub arguments: Vec<Value>,
}

#[derive(Serialize)]
pub struct RunSummary {
    pub slug: String,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub command: String,
    #[serde(rename = "startedAt")]
    pub started_at: f64,
    pub status: JobStatus,
}

#[derive(Serialize)]
pub struct RunsListResponse {
    pub runs: Vec<RunSummary>,
}

#[derive(Serialize)]
pub struct RunStart {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub slug: String,
    pub command: String,
}

#[derive(Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

// ─── Job state + registry ──────────────────────────────────────────────────

struct JobState {
    #[allow(dead_code)]
    job_id: String,
    slug: String,
    command: String,
    started_at: f64,
    ring_buffer: Vec<u8>,
    ring_truncated: bool,
    #[allow(dead_code)]
    log_path: PathBuf,
    log_file: Option<File>,
    subscribers: Vec<Channel<SkillEvent>>,
    exit_code: Option<i32>,
    status: JobStatus,
    cols: u16,
    rows: u16,
    cancel_requested: bool,
    pty_pid: Option<u32>,
    pty_master: Option<Box<dyn MasterPty + Send>>,
    pty_writer: Option<Box<dyn Write + Send>>,
}

type JobArc = Arc<Mutex<JobState>>;

static JOBS: OnceLock<Mutex<HashMap<String, JobArc>>> = OnceLock::new();
static ACTIVE_BY_SLUG: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, JobArc>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_by_slug() -> &'static Mutex<HashMap<String, String>> {
    ACTIVE_BY_SLUG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Mirrors Node's `appendRing`: extend, drop overflow from the front, prepend
/// truncation marker on the first overflow. Marker is a one-shot prepend;
/// subsequent appends may drop it from the front as the ring rolls.
fn append_ring(buf: &mut Vec<u8>, truncated: &mut bool, chunk: &[u8]) {
    buf.extend_from_slice(chunk);
    if buf.len() > RING_LIMIT {
        let overflow = buf.len() - RING_LIMIT;
        buf.drain(..overflow);
        if !*truncated {
            const MARKER: &[u8] = b"[...truncated]\n";
            let mut new_buf = Vec::with_capacity(MARKER.len() + buf.len());
            new_buf.extend_from_slice(MARKER);
            new_buf.append(buf);
            *buf = new_buf;
            *truncated = true;
        }
    }
}

/// Append bytes to the job: ring buffer, log file, then fan-out as Stdout to
/// every live subscriber. Dead subscribers (send-fail) are pruned in place.
fn append_to_job(job_arc: &JobArc, bytes: &[u8]) {
    let Ok(mut guard) = job_arc.lock() else { return };
    let state = &mut *guard;
    append_ring(&mut state.ring_buffer, &mut state.ring_truncated, bytes);
    if let Some(f) = state.log_file.as_mut() {
        let _ = f.write_all(bytes);
    }
    let text = String::from_utf8_lossy(bytes).into_owned();
    let evt = SkillEvent::Stdout { text };
    prune_dead(&mut state.subscribers, &evt);
}

/// Best-effort fan-out. Send to each subscriber; drop any whose `.send`
/// returns Err (means the webview disconnected the underlying channel).
fn prune_dead(subscribers: &mut Vec<Channel<SkillEvent>>, evt: &SkillEvent) {
    subscribers.retain(|ch| ch.send(evt.clone()).is_ok());
}

// ─── Phase A read commands ─────────────────────────────────────────────────

#[tauri::command]
pub async fn skills_list() -> Result<SkillsListResponse, SkillError> {
    Ok(SkillsListResponse {
        categories: parsers_list_skills(),
    })
}

#[tauri::command]
pub async fn skills_get(slug: String) -> Result<SkillGetResponse, SkillError> {
    let full = load_skill_by_slug(&slug)
        .ok_or_else(|| SkillError::NotFound(format!("Skill not found: {slug}")))?;
    Ok(SkillGetResponse {
        slug: full.slug,
        category: full.category,
        command: full.command,
        description: full.description,
        destructive: full.destructive,
        interactive: full.interactive,
        arguments: full.arguments,
    })
}

#[tauri::command]
pub async fn skills_list_runs() -> Result<RunsListResponse, SkillError> {
    let active = active_by_slug().lock().map_err(|e| SkillError::Io(e.to_string()))?;
    let jobs_map = jobs().lock().map_err(|e| SkillError::Io(e.to_string()))?;
    let mut runs = Vec::new();
    for (slug, job_id) in active.iter() {
        if let Some(arc) = jobs_map.get(job_id) {
            if let Ok(state) = arc.lock() {
                runs.push(RunSummary {
                    slug: slug.clone(),
                    job_id: job_id.clone(),
                    command: state.command.clone(),
                    started_at: state.started_at,
                    status: state.status,
                });
            }
        }
    }
    Ok(RunsListResponse { runs })
}

// ─── Phase B streaming + lifecycle commands ────────────────────────────────

#[tauri::command]
pub async fn skills_run(
    slug: String,
    args: Map<String, Value>,
    on_event: Channel<SkillEvent>,
) -> Result<RunStart, SkillError> {
    let skill = load_skill_by_slug(&slug)
        .ok_or_else(|| SkillError::NotFound(format!("Unknown skill: {slug}")))?;
    if skill.interactive {
        return Err(SkillError::Interactive(format!(
            "Skill is interactive and cannot run from the web UI: {slug}"
        )));
    }
    {
        let active = active_by_slug().lock().map_err(|e| SkillError::Io(e.to_string()))?;
        if let Some(active_id) = active.get(&slug) {
            return Err(SkillError::Conflict {
                active_job_id: active_id.clone(),
            });
        }
    }

    let invocation = compose_invocation(&skill, &args)?;
    let job_id = uuid::Uuid::new_v4().to_string();

    // Header + log file open.
    let log_dir = run_log_dir();
    fs::create_dir_all(&log_dir).map_err(SkillError::from)?;
    let log_path = log_dir.join(format!("{job_id}.log"));
    let mut log_file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)?;
    let header = format!(
        "# {invocation}\r\n# started {}\r\n# cwd {}\r\n\r\n",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        vault_root()
    );
    log_file.write_all(header.as_bytes())?;

    // PTY spawn.
    let pty_pair = native_pty_system()
        .openpty(PtySize {
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| SkillError::SpawnFailed(format!("openpty: {e}")))?;
    let master = pty_pair.master;
    let slave = pty_pair.slave;

    let mut cmd = CommandBuilder::new("claude");
    cmd.arg("-p");
    cmd.arg(&invocation);
    cmd.cwd(vault_root());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "1");
    for (k, v) in std::env::vars() {
        if k == "TERM" || k == "COLORTERM" || k == "FORCE_COLOR" {
            continue;
        }
        cmd.env(k, v);
    }
    // Many shells refuse to start without HOME/PATH; CommandBuilder doesn't
    // inherit by default. The loop above covers both.

    let mut child = match slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("\r\n[runner error] failed to spawn pty: {e}\r\n");
            let _ = log_file.write_all(msg.as_bytes());
            return Err(SkillError::SpawnFailed(msg.trim().to_string()));
        }
    };
    drop(slave); // close our slave handle so master.read sees EOF on child exit

    let pty_pid = child.process_id();
    let reader = master
        .try_clone_reader()
        .map_err(|e| SkillError::SpawnFailed(format!("clone_reader: {e}")))?;
    let writer = master
        .take_writer()
        .map_err(|e| SkillError::SpawnFailed(format!("take_writer: {e}")))?;

    // Build state + register.
    let started_at = now_ms();
    let mut ring = Vec::with_capacity(8 * 1024);
    let mut truncated = false;
    append_ring(&mut ring, &mut truncated, header.as_bytes());

    let state = JobState {
        job_id: job_id.clone(),
        slug: slug.clone(),
        command: invocation.clone(),
        started_at,
        ring_buffer: ring,
        ring_truncated: truncated,
        log_path,
        log_file: Some(log_file),
        subscribers: vec![on_event],
        exit_code: None,
        status: JobStatus::Running,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cancel_requested: false,
        pty_pid,
        pty_master: Some(master),
        pty_writer: Some(writer),
    };
    let job_arc = Arc::new(Mutex::new(state));

    {
        let mut jobs_map = jobs().lock().map_err(|e| SkillError::Io(e.to_string()))?;
        jobs_map.insert(job_id.clone(), job_arc.clone());
    }
    {
        let mut active = active_by_slug().lock().map_err(|e| SkillError::Io(e.to_string()))?;
        active.insert(slug.clone(), job_id.clone());
    }

    // Read loop in a dedicated std::thread (portable-pty reader is blocking,
    // not Send-across-async). Also owns the child, calls wait() at EOF, and
    // drives the post-exit cleanup.
    let job_arc_for_thread = job_arc.clone();
    let job_id_for_thread = job_id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => append_to_job(&job_arc_for_thread, &buf[..n]),
                Err(_) => break,
            }
        }
        let exit_code: i32 = match child.wait() {
            Ok(s) => s.exit_code() as i32,
            Err(_) => -1,
        };
        do_post_exit(&job_arc_for_thread, &job_id_for_thread, exit_code);
    });

    Ok(RunStart {
        job_id,
        slug,
        command: invocation,
    })
}

/// Replay-on-attach. Pushes the channel into subscribers and immediately
/// sends `SkillEvent::Replay { text }` from the ring buffer. If status is
/// terminal, also fires the matching Done/Cancelled event so a fresh
/// subscriber doesn't get stuck waiting.
#[tauri::command]
pub async fn skills_subscribe_run(
    job_id: String,
    on_event: Channel<SkillEvent>,
) -> Result<OkResponse, SkillError> {
    let arc = {
        let jobs_map = jobs().lock().map_err(|e| SkillError::Io(e.to_string()))?;
        jobs_map
            .get(&job_id)
            .cloned()
            .ok_or_else(|| SkillError::NotFound(format!("Job not found: {job_id}")))?
    };
    let mut state = arc.lock().map_err(|e| SkillError::Io(e.to_string()))?;
    // Replay current buffer first (mirrors Node SSE replay event).
    let text = String::from_utf8_lossy(&state.ring_buffer).into_owned();
    let _ = on_event.send(SkillEvent::Replay { text });
    // If job already terminated, fire the matching tail event.
    let exit_code = state.exit_code.unwrap_or(0);
    match state.status {
        JobStatus::Cancelled => {
            let _ = on_event.send(SkillEvent::Cancelled { exit_code });
        }
        JobStatus::Completed => {
            let _ = on_event.send(SkillEvent::Done { exit_code });
        }
        JobStatus::Running => {
            state.subscribers.push(on_event);
        }
    }
    Ok(OkResponse { ok: true })
}

#[tauri::command]
pub async fn skills_cancel_run(job_id: String) -> Result<OkResponse, SkillError> {
    let arc = {
        let jobs_map = jobs().lock().map_err(|e| SkillError::Io(e.to_string()))?;
        jobs_map
            .get(&job_id)
            .cloned()
            .ok_or_else(|| SkillError::NotFound(format!("Job not found: {job_id}")))?
    };
    let pid_for_escalation: Option<u32>;
    {
        let mut state = arc.lock().map_err(|e| SkillError::Io(e.to_string()))?;
        if state.status != JobStatus::Running {
            return Ok(OkResponse { ok: true });
        }
        state.cancel_requested = true;
        if let Some(writer) = state.pty_writer.as_mut() {
            let _ = writer.write_all(b"\x03");
            let _ = writer.flush();
        }
        pid_for_escalation = state.pty_pid;
    }
    if let Some(pid) = pid_for_escalation {
        let arc_for_task = arc.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(CANCEL_GRACE_MS)).await;
            if is_still_running(&arc_for_task) {
                send_signal(pid, SignalLevel::Term);
                tokio::time::sleep(Duration::from_millis(SIGKILL_GRACE_MS)).await;
                if is_still_running(&arc_for_task) {
                    send_signal(pid, SignalLevel::Kill);
                }
            }
        });
    }
    Ok(OkResponse { ok: true })
}

#[tauri::command]
pub async fn skills_resize_run(
    job_id: String,
    cols: u16,
    rows: u16,
) -> Result<OkResponse, SkillError> {
    if cols == 0 || rows == 0 {
        return Err(SkillError::Invalid("cols and rows must be positive".into()));
    }
    let arc = {
        let jobs_map = jobs().lock().map_err(|e| SkillError::Io(e.to_string()))?;
        jobs_map
            .get(&job_id)
            .cloned()
            .ok_or_else(|| SkillError::NotFound(format!("Job not found: {job_id}")))?
    };
    let mut state = arc.lock().map_err(|e| SkillError::Io(e.to_string()))?;
    if state.status != JobStatus::Running {
        return Ok(OkResponse { ok: false });
    }
    if let Some(master) = state.pty_master.as_ref() {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SkillError::Io(e.to_string()))?;
    }
    state.cols = cols;
    state.rows = rows;
    Ok(OkResponse { ok: true })
}

// ─── Lifecycle helpers ─────────────────────────────────────────────────────

fn is_still_running(arc: &JobArc) -> bool {
    arc.lock()
        .map(|s| s.status == JobStatus::Running)
        .unwrap_or(false)
}

#[derive(Clone, Copy)]
enum SignalLevel {
    Term,
    Kill,
}

#[cfg(unix)]
fn send_signal(pid: u32, level: SignalLevel) {
    let sig = match level {
        SignalLevel::Term => libc::SIGTERM,
        SignalLevel::Kill => libc::SIGKILL,
    };
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

#[cfg(not(unix))]
fn send_signal(pid: u32, _level: SignalLevel) {
    // Windows has no SIGTERM/SIGKILL split — both levels hard-kill the tree.
    crate::commands::proc_util::terminate_pid(pid);
}

fn do_post_exit(job_arc: &JobArc, job_id: &str, exit_code: i32) {
    let slug_opt: Option<String>;
    {
        let Ok(mut guard) = job_arc.lock() else { return };
        let state = &mut *guard;
        state.exit_code = Some(exit_code);
        state.status = if state.cancel_requested {
            JobStatus::Cancelled
        } else {
            JobStatus::Completed
        };
        let footer = format!("\r\n# exit {exit_code}\r\n");
        append_ring(
            &mut state.ring_buffer,
            &mut state.ring_truncated,
            footer.as_bytes(),
        );
        if let Some(f) = state.log_file.as_mut() {
            let _ = f.write_all(footer.as_bytes());
        }
        state.log_file = None;
        state.pty_writer = None;
        state.pty_master = None;

        let evt = if state.status == JobStatus::Cancelled {
            SkillEvent::Cancelled { exit_code }
        } else {
            SkillEvent::Done { exit_code }
        };
        prune_dead(&mut state.subscribers, &evt);
        slug_opt = Some(state.slug.clone());
    }

    if let Some(slug) = slug_opt {
        if let Ok(mut active) = active_by_slug().lock() {
            if active.get(&slug).map(|s| s.as_str()) == Some(job_id) {
                active.remove(&slug);
            }
        }
    }

    // Retention: keep job in JOBS for 5 minutes so late SSE-style replay can
    // catch up, then drop. Log file persists for 7 days via prune_old_logs.
    let job_id_owned = job_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RETENTION_AFTER_EXIT).await;
        if let Ok(mut jobs_map) = jobs().lock() {
            jobs_map.remove(&job_id_owned);
        }
    });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_no_overflow() {
        let mut buf = Vec::new();
        let mut truncated = false;
        append_ring(&mut buf, &mut truncated, b"hello");
        append_ring(&mut buf, &mut truncated, b" world");
        assert_eq!(buf, b"hello world");
        assert!(!truncated);
    }

    #[test]
    fn ring_overflow_truncation_marker() {
        let mut buf = vec![b'a'; RING_LIMIT - 10];
        let mut truncated = false;
        // Push 20 bytes — total goes to RING_LIMIT + 10 → overflow 10
        append_ring(&mut buf, &mut truncated, &vec![b'b'; 20]);
        assert!(truncated);
        // Marker prepended; total length is RING_LIMIT + marker.len().
        assert_eq!(buf.len(), RING_LIMIT + b"[...truncated]\n".len());
        assert!(buf.starts_with(b"[...truncated]\n"));
    }

    #[test]
    fn ring_marker_prepended_once_only() {
        let mut buf = vec![b'a'; RING_LIMIT - 10];
        let mut truncated = false;
        append_ring(&mut buf, &mut truncated, &vec![b'b'; 20]);
        let before = buf.len();
        append_ring(&mut buf, &mut truncated, &vec![b'c'; 5]);
        // Marker is NOT prepended a second time. Buffer rolls naturally.
        assert!(truncated);
        // The marker was already at the front; another 5 bytes pushes overflow=5,
        // drains 5 from front (which drains part of the marker), so total length
        // doesn't grow much.
        assert!(buf.len() <= before + 5);
        // No second marker after the first.
        let count = buf.windows(b"[...truncated]\n".len())
            .filter(|w| *w == b"[...truncated]\n")
            .count();
        assert_eq!(count, 0, "marker should have rolled out of front, not duplicated");
    }

    #[test]
    fn skill_event_tagged_serialization() {
        let evt = SkillEvent::Stdout { text: "hello".into() };
        let s = serde_json::to_string(&evt).unwrap();
        assert_eq!(s, r#"{"kind":"stdout","text":"hello"}"#);

        let evt = SkillEvent::Done { exit_code: 42 };
        let s = serde_json::to_string(&evt).unwrap();
        assert_eq!(s, r#"{"kind":"done","exit_code":42}"#);

        let evt = SkillEvent::Cancelled { exit_code: 130 };
        let s = serde_json::to_string(&evt).unwrap();
        assert_eq!(s, r#"{"kind":"cancelled","exit_code":130}"#);

        let evt = SkillEvent::Replay { text: "prior".into() };
        let s = serde_json::to_string(&evt).unwrap();
        assert_eq!(s, r#"{"kind":"replay","text":"prior"}"#);
    }

    #[test]
    fn job_status_lowercase_serialization() {
        assert_eq!(serde_json::to_string(&JobStatus::Running).unwrap(), "\"running\"");
        assert_eq!(serde_json::to_string(&JobStatus::Completed).unwrap(), "\"completed\"");
        assert_eq!(serde_json::to_string(&JobStatus::Cancelled).unwrap(), "\"cancelled\"");
    }
}
