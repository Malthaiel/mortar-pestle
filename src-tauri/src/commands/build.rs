// Rebuild App — spawns `npm` builds from inside the running app and streams
// stdout/stderr + phase + done events to the frontend. Single-build invariant
// via a global Mutex. Re-attach friendly: build_app_status returns a snapshot
// (running flag, phase, last 200 lines, elapsed) so a fresh BuildSection
// mount during an in-flight build hydrates from disk-of-truth state instead
// of starting blank.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(unix)]
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

const REPO_RELATIVE: &str = "Code/iskariel";
const OUTPUT_TAIL_CAP: usize = 200;
#[cfg(unix)]
const CANCEL_GRACE_MS: u64 = 2000;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BuildMode {
    Web,
    App,
    Release,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BuildPhase {
    Web,
    Rust,
    Bundle,
    Done,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildSnapshot {
    pub running: bool,
    pub mode: BuildMode,
    pub phase: Option<BuildPhase>,
    pub output_tail: Vec<String>,
    pub started_at_ms: u64,
    pub last_exit_code: Option<i32>,
    pub last_elapsed_ms: Option<u64>,
    pub repo_ok: bool,
}

struct BuildJobState {
    mode: BuildMode,
    phase: Option<BuildPhase>,
    output_tail: Vec<String>,
    started_at_ms: u64,
    running: bool,
    last_exit_code: Option<i32>,
    last_elapsed_ms: Option<u64>,
    child_pid: Option<u32>,
    cancel_requested: bool,
}

static BUILD_STATE: Mutex<Option<BuildJobState>> = Mutex::new(None);

fn repo_root() -> Option<PathBuf> {
    let path = dirs::home_dir()?.join(REPO_RELATIVE);
    if path.join("package.json").is_file() {
        Some(path)
    } else {
        None
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Resolves the `npm` executable path. Catches the installed-app case where the
// desktop launcher's PATH may not include node/npm even though the user can run
// npm fine from a shell.
//
// Windows: npm is a `.cmd` shim, which `Command::new` does NOT auto-probe (only
// `.exe` is appended), so a bare `"npm"` silently fails — resolve `npm.cmd`
// explicitly (PATH → ProgramFiles\nodejs → %APPDATA%\npm).
// Unix: probe common install dirs, then scan `~/.nvm/versions/node/*/bin/npm`.
#[cfg(windows)]
fn resolve_npm() -> String {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("npm.cmd");
            if cand.is_file() {
                return cand.to_string_lossy().into_owned();
            }
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        let cand = std::path::Path::new(&pf).join("nodejs").join("npm.cmd");
        if cand.is_file() {
            return cand.to_string_lossy().into_owned();
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let cand = std::path::Path::new(&appdata).join("npm").join("npm.cmd");
        if cand.is_file() {
            return cand.to_string_lossy().into_owned();
        }
    }
    "npm.cmd".to_string()
}

#[cfg(not(windows))]
fn resolve_npm() -> String {
    let mut candidates: Vec<String> = vec![
        "/usr/bin/npm".to_string(),
        "/usr/local/bin/npm".to_string(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.local/bin/npm"));
        candidates.push(format!("{home}/.fnm/aliases/default/bin/npm"));
        // nvm: pick the first node-version dir whose bin/npm exists.
        let nvm_dir = std::path::Path::new(&home).join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            for entry in entries.flatten() {
                let candidate = entry.path().join("bin/npm");
                if candidate.is_file() {
                    candidates.push(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    for c in &candidates {
        if std::path::Path::new(c).is_file() {
            return c.clone();
        }
    }
    "npm".to_string()
}

fn command_for(mode: BuildMode) -> (String, Vec<&'static str>) {
    let npm = resolve_npm();
    match mode {
        BuildMode::Web => (npm, vec!["--prefix", "web", "run", "build"]),
        BuildMode::App => (npm, vec!["exec", "tauri", "build", "--", "--no-bundle"]),
        BuildMode::Release => (npm, vec!["run", "tauri", "build"]),
    }
}

#[cfg(unix)]
fn send_signal(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

fn detect_phase(line: &str, mode: BuildMode) -> Option<BuildPhase> {
    let l = line.to_ascii_lowercase();
    if l.contains("vite v") || (l.contains("vite") && l.contains("build")) {
        return Some(BuildPhase::Web);
    }
    let t = l.trim_start();
    if t.starts_with("compiling ") || t.starts_with("finished ") {
        return Some(BuildPhase::Rust);
    }
    if matches!(mode, BuildMode::Release) && (l.contains("bundling") || l.contains(".rpm")) {
        return Some(BuildPhase::Bundle);
    }
    None
}

fn append_tail(state: &mut BuildJobState, line: String) {
    state.output_tail.push(line);
    let len = state.output_tail.len();
    if len > OUTPUT_TAIL_CAP {
        let drop = len - OUTPUT_TAIL_CAP;
        state.output_tail.drain(0..drop);
    }
}

fn maybe_advance_phase(state: &mut BuildJobState, line: &str) -> Option<BuildPhase> {
    let detected = detect_phase(line, state.mode)?;
    if Some(detected) == state.phase {
        return None;
    }
    state.phase = Some(detected);
    Some(detected)
}

#[tauri::command]
pub fn build_app_status() -> BuildSnapshot {
    let repo_ok = repo_root().is_some();
    let guard = BUILD_STATE.lock().unwrap();
    if let Some(s) = guard.as_ref() {
        BuildSnapshot {
            running: s.running,
            mode: s.mode,
            phase: s.phase,
            output_tail: s.output_tail.clone(),
            started_at_ms: s.started_at_ms,
            last_exit_code: s.last_exit_code,
            last_elapsed_ms: s.last_elapsed_ms,
            repo_ok,
        }
    } else {
        BuildSnapshot {
            running: false,
            mode: BuildMode::App,
            phase: None,
            output_tail: Vec::new(),
            started_at_ms: 0,
            last_exit_code: None,
            last_elapsed_ms: None,
            repo_ok,
        }
    }
}

#[tauri::command]
pub async fn build_app_start(app: AppHandle, mode: BuildMode) -> Result<(), String> {
    let repo = repo_root().ok_or_else(|| {
        format!(
            "source repo not found at $HOME/{REPO_RELATIVE} (no package.json)"
        )
    })?;

    {
        let mut guard = BUILD_STATE.lock().unwrap();
        if let Some(s) = guard.as_ref() {
            if s.running {
                return Err("a build is already running".to_string());
            }
        }
        *guard = Some(BuildJobState {
            mode,
            phase: None,
            output_tail: Vec::new(),
            started_at_ms: now_ms(),
            running: true,
            last_exit_code: None,
            last_elapsed_ms: None,
            child_pid: None,
            cancel_requested: false,
        });
    }

    let (program, args) = command_for(mode);
    let spawn_result = TokioCommand::new(&program)
        .args(&args)
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .spawn();

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn `{program}` failed: {e}");
            {
                let mut guard = BUILD_STATE.lock().unwrap();
                if let Some(s) = guard.as_mut() {
                    s.running = false;
                    s.last_exit_code = Some(-1);
                    s.last_elapsed_ms = Some(0);
                }
            }
            let _ = app.emit(
                "build-done",
                serde_json::json!({
                    "exitCode": -1,
                    "elapsedMs": 0,
                    "mode": mode,
                    "error": msg.clone(),
                }),
            );
            return Err(msg);
        }
    };

    // Capture child PID for cancellation. None if the platform doesn't expose
    // it; cancellation degrades to "not implemented" in that case.
    let captured_pid = child.id();
    {
        let mut guard = BUILD_STATE.lock().unwrap();
        if let Some(s) = guard.as_mut() {
            s.child_pid = captured_pid;
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_stdout = app.clone();
    let app_stderr = app.clone();
    let app_done = app.clone();
    let started_at = now_ms();

    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let new_phase = {
                    let mut guard = BUILD_STATE.lock().unwrap();
                    let Some(s) = guard.as_mut() else { break };
                    append_tail(s, line.clone());
                    maybe_advance_phase(s, &line)
                };
                let _ = app_stdout.emit("build-stdout", serde_json::json!({ "line": line }));
                if let Some(p) = new_phase {
                    let _ = app_stdout.emit("build-phase", serde_json::json!({ "phase": p }));
                }
            }
        });
    }

    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let new_phase = {
                    let mut guard = BUILD_STATE.lock().unwrap();
                    let Some(s) = guard.as_mut() else { break };
                    append_tail(s, line.clone());
                    maybe_advance_phase(s, &line)
                };
                let _ = app_stderr.emit("build-stderr", serde_json::json!({ "line": line }));
                if let Some(p) = new_phase {
                    let _ = app_stderr.emit("build-phase", serde_json::json!({ "phase": p }));
                }
            }
        });
    }

    tokio::spawn(async move {
        let exit_code = match child.wait().await {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => -1,
        };
        let elapsed_ms = now_ms().saturating_sub(started_at);
        {
            let mut guard = BUILD_STATE.lock().unwrap();
            if let Some(s) = guard.as_mut() {
                s.running = false;
                s.last_exit_code = Some(exit_code);
                s.last_elapsed_ms = Some(elapsed_ms);
                s.phase = Some(BuildPhase::Done);
            }
        }
        let _ = app_done.emit(
            "build-done",
            serde_json::json!({
                "exitCode": exit_code,
                "elapsedMs": elapsed_ms,
                "mode": mode,
            }),
        );
    });

    Ok(())
}

#[tauri::command]
pub fn build_app_cancel() -> Result<(), String> {
    let (pid_opt, was_running) = {
        let mut guard = BUILD_STATE.lock().unwrap();
        let Some(s) = guard.as_mut() else {
            return Err("no build to cancel".to_string());
        };
        if !s.running {
            return Err("no build is running".to_string());
        }
        s.cancel_requested = true;
        (s.child_pid, true)
    };
    let _ = was_running;
    let Some(pid) = pid_opt else {
        return Err("build cancellation unavailable: child pid not captured".to_string());
    };

    #[cfg(unix)]
    {
        send_signal(pid, libc::SIGTERM);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(CANCEL_GRACE_MS)).await;
            let still_running = {
                let guard = BUILD_STATE.lock().unwrap();
                guard.as_ref().map(|s| s.running).unwrap_or(false)
            };
            if still_running {
                send_signal(pid, libc::SIGKILL);
            }
        });
        Ok(())
    }
    #[cfg(not(unix))]
    {
        crate::commands::proc_util::terminate_pid(pid);
        Ok(())
    }
}
