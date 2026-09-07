// ── Video-editor export runtime — split from mod.rs, plan 026 B6.
// The live async export orchestration: ExportState / ExportStatus + the EXPORT
// mutex, progress emit, cancel, and RunEvent shutdown. The pure ffmpeg-argv /
// filter-graph library (build_export_argv, encode & audio args, layer geom,
// specs, export_tests) STAYS in mod.rs — reached here via `use super::*`. Shim
// `pub use export::*;` keeps the vedit_export_start/cancel/status command paths +
// ACL resolving and shutdown_export reachable for lib.rs's RunEvent::Exit.

use std::fs;
use std::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;

use crate::commands::vault::VaultError;
use super::*;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExportState {
    Idle,
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatus {
    pub state: ExportState,
    pub pct: f64,
    pub out_time_us: i64,
    pub total_us: i64,
    pub speed: Option<f64>,
    pub eta_secs: Option<i64>,
    pub error: Option<String>,
    pub output_path: Option<String>,
    /// The ffmpeg child. Serialized (it used to be `#[serde(skip)]`) so the
    /// Processes window can ask Windows what this render is costing.
    pub child_pid: Option<u32>,
    #[serde(skip)]
    pub cancel_requested: bool,
    #[serde(skip)]
    pub partial_path: Option<String>,
    /// LUT temps + filter script for this run — removed by the monitor task
    /// on every exit and by shutdown_export on app quit.
    #[serde(skip)]
    pub temp_paths: Vec<String>,
}

static EXPORT: Mutex<Option<ExportStatus>> = Mutex::new(None);

#[cfg(unix)]
fn export_signal(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

fn emit_export(app: &tauri::AppHandle, event: &str) {
    let snap = EXPORT.lock().unwrap().clone();
    if let Some(s) = snap {
        let _ = app.emit(event, s);
    }
}

#[tauri::command]
pub async fn vedit_export_start(app: tauri::AppHandle, spec: ExportSpec) -> Result<(), VaultError> {
    let has_regions = spec.regions.as_ref().map_or(false, |r| !r.is_empty());
    if spec.segments.is_empty() && !has_regions {
        return Err(VaultError::Invalid("nothing to export — the timeline is empty".into()));
    }
    // Delivery & Presets SF3: resolve the export encoder from the probe caps
    // before any work. None encode → the byte-identical Phase-1 path; an
    // unresolvable codec errors here (the JS remediation banner should prevent
    // reaching this, but defend so a bad preset never spawns a doomed ffmpeg).
    let resolved_encoder: Option<String> = if let Some(enc) = spec.encode.as_ref() {
        let caps = caps_cached(&app, false).await;
        match resolve_export_encoder(enc, &caps) {
            Some(name) => Some(name),
            None => {
                return Err(VaultError::Invalid(format!(
                    "no available encoder for codec '{}' — open Export presets to re-probe, or install an ffmpeg that has it",
                    enc.codec
                )));
            }
        }
    } else {
        None
    };
    let total_secs: f64 = match &spec.regions {
        Some(rs) => rs.iter().map(|r| r.dur).sum(),
        None => spec.segments.iter().map(|s| s.dur).sum(),
    };
    let total_us = (total_secs * 1_000_000.0) as i64;
    let partial = format!("{}.partial", spec.output_path);
    {
        let mut g = EXPORT.lock().unwrap();
        if matches!(g.as_ref().map(|s| &s.state), Some(ExportState::Running)) {
            return Err(VaultError::Invalid("an export is already running".into()));
        }
        *g = Some(ExportStatus {
            state: ExportState::Running,
            pct: 0.0,
            out_time_us: 0,
            total_us,
            speed: None,
            eta_secs: None,
            error: None,
            output_path: Some(spec.output_path.clone()),
            child_pid: None,
            cancel_requested: false,
            partial_path: Some(partial.clone()),
            temp_paths: Vec::new(),
        });
    }

    let (lut_paths, mut lut_files) = match materialize_luts(&spec) {
        Ok(v) => v,
        Err(e) => {
            *EXPORT.lock().unwrap() = None;
            return Err(e);
        }
    };
    // SF11: rasterized title PNGs (region-major). Their temps join lut_files so
    // every existing cleanup path removes them too.
    let (title_paths, title_files) = match materialize_titles(&spec) {
        Ok(v) => v,
        Err(e) => {
            for f in &lut_files {
                let _ = fs::remove_file(f);
            }
            *EXPORT.lock().unwrap() = None;
            return Err(e);
        }
    };
    lut_files.extend(title_files);
    // Two-pass loudnorm: measure the processed audio first when enabled (decode
    // + filter only, no encode). Falls back to single-pass dynamic on failure.
    let loud_enabled = spec.mixer.as_ref().map_or(false, |m| m.master.loudnorm.enabled);
    let measured = if loud_enabled { measure_loudnorm(&spec, &lut_paths, &title_paths).await } else { None };
    // A cancel may have arrived during the measurement pass.
    if EXPORT.lock().unwrap().as_ref().map(|s| s.cancel_requested).unwrap_or(false) {
        for f in &lut_files {
            let _ = fs::remove_file(f);
        }
        if let Some(s) = EXPORT.lock().unwrap().as_mut() {
            s.state = ExportState::Cancelled;
        }
        emit_export(&app, "vedit-export-progress");
        return Ok(());
    }
    let script = build_filter_script_for(&spec, &lut_paths, measured.as_ref(), false);
    let filter_path = std::env::temp_dir().join(format!(
        "vedit-filter-{}.txt",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    if let Err(e) = fs::write(&filter_path, &script) {
        for f in &lut_files {
            let _ = fs::remove_file(f);
        }
        *EXPORT.lock().unwrap() = None;
        return Err(VaultError::Io(format!("filter script: {e}")));
    }
    if let Some(s) = EXPORT.lock().unwrap().as_mut() {
        s.temp_paths = lut_files.iter().map(|p| p.display().to_string()).collect();
        s.temp_paths.push(filter_path.display().to_string());
    }
    let argv = build_export_argv(
        &spec,
        &title_paths,
        &filter_path.to_string_lossy(),
        &partial,
        resolved_encoder.as_deref(),
    );

    let mut child = crate::commands::proc_util::tokio_cmd(crate::tool_path::resolve("ffmpeg"))
        .args(&argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let _ = fs::remove_file(&filter_path);
            for f in &lut_files {
                let _ = fs::remove_file(f);
            }
            *EXPORT.lock().unwrap() = None;
            VaultError::Io(format!("ffmpeg spawn failed: {e}"))
        })?;

    if let Some(pid) = child.id() {
        if let Some(s) = EXPORT.lock().unwrap().as_mut() {
            s.child_pid = Some(pid);
        }
    }
    emit_export(&app, "vedit-export-progress");

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_path = spec.output_path.clone();
    let partial_clone = partial.clone();
    let filter_clone = filter_path.clone();

    // stderr tail collector (last 40 lines) for the error state.
    let tail: std::sync::Arc<Mutex<Vec<String>>> = std::sync::Arc::new(Mutex::new(Vec::new()));
    if let Some(err) = stderr {
        let tail = tail.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut t = tail.lock().unwrap();
                t.push(line);
                let drop_n = t.len().saturating_sub(40);
                if drop_n > 0 {
                    t.drain(0..drop_n);
                }
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        if let Some(out) = stdout {
            let mut lines = tokio::io::BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut dirty = false;
                {
                    let mut g = EXPORT.lock().unwrap();
                    let Some(s) = g.as_mut() else { break };
                    if let Some(v) = line.strip_prefix("out_time_us=") {
                        // NB: ffmpeg's `out_time_ms` key is ALSO microseconds
                        // (ffmpeg bug 7345) — out_time_us is the unambiguous one.
                        if let Ok(us) = v.trim().parse::<i64>() {
                            s.out_time_us = us.max(0);
                            if s.total_us > 0 {
                                s.pct = (s.out_time_us as f64 / s.total_us as f64).clamp(0.0, 1.0);
                            }
                            dirty = true;
                        }
                    } else if let Some(v) = line.strip_prefix("speed=") {
                        let sp = v.trim().trim_end_matches('x').parse::<f64>().ok();
                        s.speed = sp.filter(|x| *x > 0.0);
                        if let Some(sp) = s.speed {
                            let remain_us = (s.total_us - s.out_time_us).max(0);
                            s.eta_secs = Some(((remain_us as f64 / 1_000_000.0) / sp).ceil() as i64);
                        }
                        dirty = true;
                    }
                }
                if dirty {
                    emit_export(&app, "vedit-export-progress");
                }
            }
        }
        let exit_ok = matches!(child.wait().await.map(|st| st.success()), Ok(true));
        let cancelled = EXPORT
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.cancel_requested)
            .unwrap_or(false);
        let _ = fs::remove_file(&filter_clone);
        for f in &lut_files {
            let _ = fs::remove_file(f);
        }
        if exit_ok && !cancelled {
            let renamed = fs::rename(&partial_clone, &out_path);
            let mut g = EXPORT.lock().unwrap();
            if let Some(s) = g.as_mut() {
                match renamed {
                    Ok(()) => {
                        s.state = ExportState::Done;
                        s.pct = 1.0;
                    }
                    Err(e) => {
                        s.state = ExportState::Error;
                        s.error = Some(format!("rename failed: {e}"));
                    }
                }
            }
        } else {
            let _ = fs::remove_file(&partial_clone);
            let mut g = EXPORT.lock().unwrap();
            if let Some(s) = g.as_mut() {
                if cancelled {
                    s.state = ExportState::Cancelled;
                } else {
                    s.state = ExportState::Error;
                    let t = tail.lock().unwrap();
                    s.error = Some(if t.is_empty() {
                        "ffmpeg failed".into()
                    } else {
                        t.join("\n")
                    });
                }
            }
        }
        emit_export(&app, "vedit-export-done");
    });

    Ok(())
}

/// Flag + SIGTERM → 2 s grace → SIGKILL (anime_download cancel pattern).
#[tauri::command]
pub fn vedit_export_cancel() {
    let pid = {
        let mut g = EXPORT.lock().unwrap();
        match g.as_mut() {
            Some(s) if s.state == ExportState::Running => {
                s.cancel_requested = true;
                s.child_pid
            }
            _ => None,
        }
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        export_signal(pid, libc::SIGTERM);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            export_signal(pid, libc::SIGKILL);
        });
    }
    #[cfg(not(unix))]
    if let Some(pid) = pid {
        crate::commands::proc_util::terminate_pid(pid);
    }
}

/// Remount re-sync: the dialog adopts a job that survived navigation.
#[tauri::command]
pub fn vedit_export_status() -> Option<ExportStatus> {
    EXPORT.lock().unwrap().clone()
}

/// RunEvent::Exit cleanup beside video_transcode::shutdown_active(): kill the
/// active export and remove its .partial.
pub fn shutdown_export() {
    let (pid, partial, temps) = {
        let g = EXPORT.lock().unwrap();
        match g.as_ref() {
            Some(s) if s.state == ExportState::Running => {
                (s.child_pid, s.partial_path.clone(), s.temp_paths.clone())
            }
            _ => (None, None, Vec::new()),
        }
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        export_signal(pid, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    if let Some(pid) = pid {
        crate::commands::proc_util::terminate_pid(pid);
    }
    if let Some(p) = partial {
        let _ = fs::remove_file(p);
    }
    for t in temps {
        let _ = fs::remove_file(t);
    }
}
