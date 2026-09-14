//! Comms job — the Rust-owned long half of the coaching write-out (CoachPopup's
//! "Write it out", `kind: "writeout"`) and the older Extract Comms path.
//!
//! Why this exists: the pipeline used to live in frontend JS, driving per-step
//! invokes over per-call Channels. A webview reload (the dev overlay reloads on
//! every Shift+C show; a Vite page reload; a real user closing the window)
//! destroyed the orchestrator mid-flight while the STT engine kept transcribing
//! unconsumed. This module moves the long half — extract WAVs → silence-probe
//! the mic → load model → transcribe mic + comms → diarize — into a Rust task
//! whose state lives in a process-lifetime cell (the `overlay::state::cell()`
//! idiom), so it survives ANY webview teardown. The frontend re-attaches on
//! mount via `comms_job_status` and follows live progress on the GLOBAL
//! `comms-job-progress` event (the `stt_download_model` survive-unmount pattern).
//!
//! `kind: "writeout"` skips diarization and finishes on its own: it merges both
//! tracks into speaker turns (`coach_transcript`, stamps offset by the trim
//! start) and writes `<scrimPath>/00-transcript.md` itself, so no page has to be
//! alive when it ends. Other kinds keep the take-once `comms_job_take` hand-off;
//! its ScrimViewer consumer was deleted in the Scrim Teardown, so nothing calls
//! it today.
//!
//! One job at a time: the engine is single-job anyway. Starting over a
//! done-but-unconsumed job replaces it (the user moved on; WAV extraction is
//! cached so only the STT pass is lost) — only a RUNNING job blocks a start.
//!
//! Blocker 3 (silent mic) lives here too: after extracting an isolated mic track,
//! a windowed-RMS probe skips its transcription pass when nothing resembling
//! speech is found (a spectating coach's mic is near-silent — a full whisper pass
//! over it doubled extraction time for nothing).

use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::stt::client::{Diarization, Final, Progress, ProtoError, Segment, SttClient};
use crate::stt::supervisor;

/// Silence gate (blocker 3): the mic track is skipped when NO 300 ms window's
/// RMS exceeds this dBFS. Speech windows sit well above −40 dBFS even for a
/// quiet talker; keyboard bleed and room noise sit below.
/// ponytail: fixed threshold, expose as a setting if a real mic ever trips it.
const MIC_SILENCE_DBFS: f64 = -40.0;
/// Probe window: 300 ms @ 16 kHz mono (the `coaching_extract_audio` contract).
const MIC_PROBE_WINDOW_SAMPLES: usize = 4800;

// ── Wire types (camelCase to the frontend) ───────────────────────────────────

/// One transcribed span — the JS `{t0Ms, t1Ms, text}` segment shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegOut {
    pub t0_ms: u64,
    pub t1_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarSegOut {
    pub t0_ms: u64,
    pub t1_ms: u64,
    pub cluster_id: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarClusterOut {
    pub cluster_id: i32,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarOut {
    pub num_speakers: i32,
    pub segments: Vec<DiarSegOut>,
    pub clusters: Vec<DiarClusterOut>,
}

/// The finished job's raw results — everything the JS post-processing needs.
/// `diarization: None` = the legacy single-downmix run (no comms track set).
/// `comms_final_text` backs the legacy "no segments but a final text" fallback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommsJobResult {
    pub mic_segments: Vec<SegOut>,
    pub comms_segments: Vec<SegOut>,
    pub comms_final_text: String,
    pub diarization: Option<DiarOut>,
    pub mic_skipped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

/// The status snapshot (`comms_job_status` + the progress/done event payloads).
/// Meta is flattened so JS filters on `payload.scrimPath` directly. NO `result`
/// here — segments + embeddings can be large; they travel once, via `take`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub status: JobStatus,
    pub phase: String,
    pub pct: Option<f64>,
    pub scrim_path: String,
    /// `"match"` (per-match Extract Comms) or `"vod"` (scrim-level VOD comms).
    pub kind: String,
    pub match_n: Option<u32>,
    pub error: Option<String>,
    pub mic_skipped: bool,
}

// ── The job cell (overlay::state idiom) ──────────────────────────────────────

struct CommsJob {
    scrim_path: String,
    kind: String,
    match_n: Option<u32>,
    phase: String,
    pct: Option<f64>,
    status: JobStatus,
    error: Option<String>,
    cancel_requested: bool,
    mic_skipped: bool,
    result: Option<CommsJobResult>,
}

fn cell() -> &'static Mutex<Option<CommsJob>> {
    static CELL: OnceLock<Mutex<Option<CommsJob>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn lock() -> std::sync::MutexGuard<'static, Option<CommsJob>> {
    cell().lock().unwrap_or_else(|p| p.into_inner())
}

fn snapshot(job: &CommsJob) -> JobSnapshot {
    JobSnapshot {
        status: job.status,
        phase: job.phase.clone(),
        pct: job.pct,
        scrim_path: job.scrim_path.clone(),
        kind: job.kind.clone(),
        match_n: job.match_n,
        error: job.error.clone(),
        mic_skipped: job.mic_skipped,
    }
}

fn cancel_requested() -> bool {
    lock().as_ref().map(|j| j.cancel_requested).unwrap_or(false)
}

/// Update phase/pct on the live job and push the global progress event.
fn set_progress(app: &AppHandle, phase: Option<&str>, pct: Option<f64>) {
    let snap = {
        let mut g = lock();
        let Some(job) = g.as_mut() else { return };
        if let Some(p) = phase {
            job.phase = p.to_string();
        }
        job.pct = pct;
        snapshot(job)
    };
    let _ = app.emit("comms-job-progress", &snap);
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Everything the job task needs, captured at start. `comms_track: None` = the
/// legacy single-downmix run (whole-audio transcript, no mic pass, no diarize).
struct JobParams {
    video: String,
    comms_track: Option<i32>,
    mic_track: Option<i32>,
    model: String,
    max_speakers: i32,
    /// Trim handles, in seconds into the recording. `None`/`None` = the whole file,
    /// which keeps the pre-trim cache key so existing extracted WAVs still hit.
    start_secs: Option<f64>,
    end_secs: Option<f64>,
    /// `kind: "writeout"` only — the name the mic track is labelled with. NOT
    /// optional to coach.py: it binds phase 2 with "the coach is the speaker
    /// labelled <coach_label>, every other label is the Student", so a missing
    /// one files the coach's own words as the student's.
    coach_label: Option<String>,
}

/// `comms_job_start` — begin the Rust-owned extraction job. Errors when a job is
/// already RUNNING; a terminal (done/error/cancelled) job is replaced.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn comms_job_start(
    app: AppHandle,
    video: String,
    comms_track: Option<i32>,
    mic_track: Option<i32>,
    model: String,
    max_speakers: i32,
    scrim_path: String,
    kind: String,
    match_n: Option<u32>,
    start_secs: Option<f64>,
    end_secs: Option<f64>,
    coach_label: Option<String>,
) -> Result<(), String> {
    if video.is_empty() {
        return Err("recording path required".into());
    }
    if supervisor::client().is_none() {
        return Err("stt engine not running".into());
    }
    {
        let mut g = lock();
        if matches!(g.as_ref(), Some(j) if j.status == JobStatus::Running) {
            return Err("a comms extraction is already running".into());
        }
        *g = Some(CommsJob {
            scrim_path,
            kind,
            match_n,
            phase: "Extracting audio".into(),
            pct: None,
            status: JobStatus::Running,
            error: None,
            cancel_requested: false,
            mic_skipped: false,
            result: None,
        });
    }
    let params = JobParams { video, comms_track, mic_track, model, max_speakers, start_secs, end_secs, coach_label };
    tauri::async_runtime::spawn(run_job(app, params));
    Ok(())
}

/// `comms_job_status` — the current job snapshot (`None` = no job). The mount
/// re-attach probe: a `running` job restores the busy UI, a `done` one is taken.
#[tauri::command]
pub fn comms_job_status() -> Option<JobSnapshot> {
    lock().as_ref().map(snapshot)
}

/// `comms_job_take` — consume a DONE job's results, clearing the cell. Take-once
/// under the mutex: when both the main window and the overlay mount ScrimViewer,
/// only one consumer gets the result (the other sees `None` and no-ops).
#[tauri::command]
pub fn comms_job_take() -> Option<CommsJobResult> {
    let mut g = lock();
    if !matches!(g.as_ref(), Some(j) if j.status == JobStatus::Done) {
        return None;
    }
    g.take().and_then(|j| j.result)
}

/// `comms_job_clear` — drop a terminal (error/cancelled/done) job after the
/// frontend has surfaced it. A RUNNING job is never cleared from here.
#[tauri::command]
pub fn comms_job_clear() {
    let mut g = lock();
    if matches!(g.as_ref(), Some(j) if j.status != JobStatus::Running) {
        *g = None;
    }
}

/// `comms_job_cancel` — flag the job cancelled + raise the engine's cancel (the
/// in-flight transcribe/diarize op finishes-then-discards, unblocking the task,
/// which then observes the flag and terminates as `cancelled`).
#[tauri::command]
pub async fn comms_job_cancel() -> Result<(), String> {
    {
        let mut g = lock();
        if let Some(job) = g.as_mut() {
            if job.status == JobStatus::Running {
                job.cancel_requested = true;
                job.phase = "Cancelling".into();
                job.pct = None;
            }
        }
    }
    if let Some(client) = supervisor::client() {
        let _ = client.request("cancel", Value::Null).await;
    }
    Ok(())
}

// ── The job task ─────────────────────────────────────────────────────────────

/// Drive the pipeline, then settle the cell + emit the terminal
/// `comms-job-done {ok, cancelled, error, scrimPath, kind, matchN}` event.
async fn run_job(app: AppHandle, params: JobParams) {
    let outcome = drive(&app, &params).await;
    let (payload, snap) = {
        let mut g = lock();
        let Some(job) = g.as_mut() else { return };
        match outcome {
            Ok(result) => {
                job.mic_skipped = result.mic_skipped;
                job.result = Some(result);
                job.status = JobStatus::Done;
                job.phase = "Done".into();
                job.pct = None;
            }
            Err(_) if job.cancel_requested => {
                job.status = JobStatus::Cancelled;
                job.phase = "Cancelled".into();
                job.pct = None;
            }
            Err(e) => {
                job.status = JobStatus::Error;
                job.error = Some(e);
                job.phase = "Failed".into();
                job.pct = None;
            }
        }
        let snap = snapshot(job);
        (
            serde_json::json!({
                "ok": job.status == JobStatus::Done,
                "cancelled": job.status == JobStatus::Cancelled,
                "error": job.error,
                "scrimPath": job.scrim_path,
                "kind": job.kind,
                "matchN": job.match_n,
                "micSkipped": job.mic_skipped,
            }),
            snap,
        )
    };
    let _ = app.emit("comms-job-progress", &snap);
    let _ = app.emit("comms-job-done", &payload);
}

/// The pipeline body. Every step checks the cancel flag; any engine error (or a
/// cancel-provoked one) bubbles as `Err` and `run_job` maps it by the flag.
async fn drive(app: &AppHandle, p: &JobParams) -> Result<CommsJobResult, String> {
    let client = supervisor::client().ok_or_else(|| "stt engine not running".to_string())?;
    let bail = || -> Result<(), String> {
        if cancel_requested() {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    };
    // Phase labels differ per kind only cosmetically (match: mic/comms, vod: coach/team,
    // writeout: the coaching write-out, whose words the user reads in its own window).
    let kind = {
        let g = lock();
        g.as_ref().map(|j| j.kind.clone()).unwrap_or_default()
    };
    let vod = kind == "vod";
    // The coaching write-out takes the SAME two-track pass but no diarization: the
    // track split already says who spoke (mic = the coach, by construction), and
    // sherpa put four real people into 26 clusters when it was asked anyway.
    let writeout = kind == "writeout";
    let (mic_label, comms_label) = if writeout {
        ("Listening to you", "Listening to everyone else")
    } else if vod {
        ("Transcribing coach", "Transcribing team")
    } else {
        ("Transcribing mic", "Transcribing comms")
    };

    // 1. Extract WAVs (cached by path+mtime+track on the coaching side).
    set_progress(app, Some(if writeout { "Pulling the two sounds apart" } else { "Extracting audio" }), None);
    let diarize_mode = p.comms_track.is_some();
    let mic_wav = if diarize_mode && p.mic_track.is_some() {
        Some(
            crate::commands::coaching::coaching_extract_audio(p.video.clone(), p.mic_track, p.start_secs, p.end_secs)
                .await
                .map_err(vault_err)?,
        )
    } else {
        None
    };
    let comms_wav =
        crate::commands::coaching::coaching_extract_audio(p.video.clone(), if diarize_mode { p.comms_track } else { None }, p.start_secs, p.end_secs)
            .await
            .map_err(vault_err)?;
    bail()?;

    // 2. Silence-probe the isolated mic track (blocker 3) BEFORE burning a
    //    whisper pass on it. Probe errors fail open (transcribe anyway).
    let mut mic_skipped = false;
    if let Some(ref wav) = mic_wav {
        set_progress(app, Some("Checking mic"), None);
        mic_skipped = wav_is_silent(wav).unwrap_or(false);
        if mic_skipped {
            log::info!("comms job: mic track silent (< {MIC_SILENCE_DBFS} dBFS), skipping its transcription");
        }
    }
    bail()?;

    // 3. Load the whisper model (the engine does not auto-load).
    set_progress(app, Some(if writeout { "Getting the listener ready" } else { "Loading model" }), None);
    run_op(
        &client,
        "load_model",
        serde_json::json!({ "name": p.model }),
        |event, _data| event == "model_loaded",
    )
    .await?;
    bail()?;

    // 4. Transcribe mic (isolated-track mode only, unless silent).
    let mut mic_segments: Vec<SegOut> = Vec::new();
    if let Some(ref wav) = mic_wav {
        if !mic_skipped {
            transcribe(app, &client, wav, mic_label, &mut mic_segments).await?;
            bail()?;
        }
    }

    // 5. Transcribe comms (or the legacy whole-audio downmix).
    let mut comms_segments: Vec<SegOut> = Vec::new();
    let comms_final_text =
        transcribe(app, &client, &comms_wav, if diarize_mode { comms_label } else { "Transcribing" }, &mut comms_segments)
            .await?;
    bail()?;

    // 6. Diarize the comms track (isolated-track mode only).
    let mut diarization: Option<DiarOut> = None;
    if diarize_mode && !writeout {
        // sherpa's diarize is one opaque C call — no progress events exist (the C API's
        // callback isn't bound by the Rust wrapper), so the label carries the ETA instead.
        set_progress(app, Some("Identifying speakers (takes a few minutes)"), None);
        let mut out: Option<DiarOut> = None;
        {
            let out = &mut out;
            let mut last_pct = -1i64;
            run_op(
                &client,
                "diarize_file",
                serde_json::json!({ "path": comms_wav, "max_speakers": p.max_speakers }),
                |event, data| match event {
                    "progress" => {
                        if let Ok(pr) = serde_json::from_value::<Progress>(data) {
                            let rounded = pr.pct.round() as i64;
                            if rounded != last_pct {
                                last_pct = rounded;
                                set_progress(app, None, Some(pr.pct));
                            }
                        }
                        false
                    }
                    "diarization" => {
                        if let Ok(d) = serde_json::from_value::<Diarization>(data) {
                            *out = Some(DiarOut {
                                num_speakers: d.num_speakers,
                                segments: d
                                    .segments
                                    .into_iter()
                                    .map(|s| DiarSegOut { t0_ms: s.t0_ms, t1_ms: s.t1_ms, cluster_id: s.cluster_id })
                                    .collect(),
                                clusters: d
                                    .clusters
                                    .into_iter()
                                    .map(|c| DiarClusterOut { cluster_id: c.cluster_id, embedding: c.embedding })
                                    .collect(),
                            });
                        }
                        true
                    }
                    _ => false,
                },
            )
            .await?;
        }
        bail()?;
        diarization = out;
    }

    // 7. The write-out saves its own `00-transcript.md`. It used to be handed back
    //    to the popup to merge and save; the popup is exactly the thing that may no
    //    longer exist by now, which is the whole reason this job moved into Rust.
    if writeout {
        set_progress(app, Some("Saving"), None);
        // A track that exists but holds the wrong thing yields silence, and silence
        // would save a half-empty transcript that reads as a real one.
        if mic_segments.is_empty() {
            return Err("Nothing was said on your own sound track — is that the one your voice goes to?".into());
        }
        if comms_segments.is_empty() {
            return Err("Nothing was said on the other sound track — is that the one everyone else goes to?".into());
        }
        let (folder, coach) = {
            let g = lock();
            let job = g.as_ref().ok_or_else(|| "job vanished".to_string())?;
            (job.scrim_path.clone(), p.coach_label.clone().unwrap_or_else(|| "Coach".into()))
        };
        // ffmpeg hands back a wav that starts at zero, so a trimmed run shifts every
        // stamp by the trim start — the transcript then points at the ORIGINAL
        // recording, which is the file anyone scrubs to check a line.
        let offset_ms = (p.start_secs.unwrap_or(0.0).max(0.0) * 1000.0).round() as u64;
        let body = coach_transcript(&mic_segments, &comms_segments, &coach, offset_ms);
        crate::commands::vault::vault_write_file(
            format!("{folder}/00-transcript.md"),
            body,
            None,
            Some("deadlock".into()),
        )
        .map_err(vault_err)?;
    }

    Ok(CommsJobResult { mic_segments, comms_segments, comms_final_text, diarization, mic_skipped })
}

/// Everyone who is not the coach is one Student — METHOD-A §8a merges them, so
/// telling them apart buys the pipeline nothing.
const STUDENT_LABEL: &str = "Student";

/// ms → `m:ss`, minutes uncapped. `\d+` in method.py's `TURN_RE`, so an hour-long
/// review keeps counting up to `72:15` rather than restarting at `12:15`.
fn stamp(ms: u64) -> String {
    let total = ms / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

/// The `00-transcript.md` body — a contract with
/// `Citadel/Infrastructure/Scripts/coaching/method.py`, whose
/// `TURN_RE = ^\s*\d+:\d{2}\s*$` counts turns by finding bare timestamp lines. A turn is
/// EXACTLY three lines (timestamp, speaker, text) and nothing else may look like a
/// timestamp. Ported from `coachTranscribe.js` + `mergeTranscripts`, whose selftest
/// assertions are the `tests` module below verbatim.
///
/// The mic pass is the coach by construction (its track carries nothing else), so the
/// speaker comes from the TRACK, never from voice matching — diarization put four real
/// people into 26 clusters when it was asked to decide instead.
fn coach_transcript(mic: &[SegOut], comms: &[SegOut], coach_label: &str, offset_ms: u64) -> String {
    let mut rows: Vec<(u64, &str, &str)> = Vec::with_capacity(mic.len() + comms.len());
    for s in mic {
        rows.push((s.t0_ms + offset_ms, coach_label, s.text.as_str()));
    }
    for s in comms {
        rows.push((s.t0_ms + offset_ms, STUDENT_LABEL, s.text.as_str()));
    }
    // Stable, so a tie keeps the mic line first — the JS `Array.sort` it replaces was
    // stable over `[...mic, ...comms]` too.
    rows.sort_by_key(|r| r.0);
    let mut out = String::new();
    for (t0, who, text) in rows {
        // whisper emits blank segments for spans the VAD passed but the decoder found
        // nothing in, and a wordless turn still counts as a turn to method.py.
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        out.push_str(&stamp(t0));
        out.push('\n');
        out.push_str(who.trim());
        out.push('\n');
        out.push_str(text);
        out.push('\n');
    }
    out
}

/// One transcription pass: stream `segment`/`progress` into the cell + the global
/// event until the terminal `final`. Returns the final full-transcript text.
async fn transcribe(
    app: &AppHandle,
    client: &SttClient,
    wav: &str,
    label: &str,
    segments: &mut Vec<SegOut>,
) -> Result<String, String> {
    set_progress(app, Some(label), Some(0.0));
    let start_len = segments.len();
    let mut final_text = String::new();
    {
        let final_text = &mut final_text;
        let mut last_pct = -1i64;
        run_op(
            client,
            "transcribe_file",
            serde_json::json!({ "path": wav }),
            |event, data| match event {
                "segment" => {
                    if let Ok(s) = serde_json::from_value::<Segment>(data) {
                        segments.push(SegOut { t0_ms: s.t0_ms, t1_ms: s.t1_ms, text: s.text });
                    }
                    false
                }
                "progress" => {
                    if let Ok(pr) = serde_json::from_value::<Progress>(data) {
                        // Emit on whole-percent changes only — the engine's progress
                        // cadence is per-segment and would spam every webview.
                        let rounded = pr.pct.round() as i64;
                        if rounded != last_pct {
                            last_pct = rounded;
                            set_progress(app, None, Some(pr.pct));
                        }
                    }
                    false
                }
                "final" => {
                    if let Ok(f) = serde_json::from_value::<Final>(data) {
                        *final_text = f.text;
                    }
                    true
                }
                _ => false,
            },
        )
        .await?;
    }
    // Transport-integrity check: the engine builds `final` by concatenating every
    // segment it emitted, so the segments collected here must reproduce it exactly.
    // Any mismatch means events were lost in transit (a 256-cap daemon bus once
    // silently dropped ~770 of 1102 segments — 29 minutes of comms) — fail loud
    // rather than persist a transcript with invisible holes.
    let joined: String = segments[start_len..].iter().map(|s| s.text.as_str()).collect();
    if joined.trim() != final_text {
        return Err(format!(
            "transcript incomplete: collected {} segments ({} chars) but the engine's final text is {} chars — events lost in transit, re-run the extraction",
            segments.len() - start_len,
            joined.trim().len(),
            final_text.len()
        ));
    }
    Ok(final_text)
}

/// Subscribe → request → pump the engine event bus until `on_event` reports the
/// terminal event (returns `true`) or an engine `error` arrives. The stt.rs relay
/// loop's recv()/Lagged/Closed handling, minus the per-call Channel.
async fn run_op<F>(client: &SttClient, op: &str, args: Value, mut on_event: F) -> Result<(), String>
where
    F: FnMut(&str, Value) -> bool,
{
    use tokio::sync::broadcast::error::RecvError;

    // Subscribe BEFORE the request so no early event is missed (house rule).
    let mut rx = client.subscribe();
    client.request(op, args).await.map_err(|e| e.to_string())?;
    loop {
        match rx.recv().await {
            Ok(ev) => {
                if ev.event == "error" {
                    let msg = serde_json::from_value::<ProtoError>(ev.data)
                        .map(|e| e.message)
                        .unwrap_or_else(|_| "stt engine error".into());
                    return Err(msg);
                }
                if on_event(ev.event.as_str(), ev.data) {
                    return Ok(());
                }
            }
            // Fell behind the bus — the gap may have held `segment` events, so the
            // transcript would be silently corrupt (a 256-cap bus once ate 29 min of
            // comms). Fail the job loudly; EVENT_BUS_CAP is sized so this never fires.
            Err(RecvError::Lagged(n)) => {
                return Err(format!("stt event bus overflow: dropped {n} events (transcript would be incomplete — re-run the job)"));
            }
            Err(RecvError::Closed) => return Err("stt engine disconnected".into()),
        }
    }
}

/// Stringify a `VaultError` for this module's `Result<_, String>` boundary (the
/// coaching extract helper is reused as a plain fn, so its typed error lands here).
fn vault_err(e: crate::commands::vault::VaultError) -> String {
    serde_json::to_value(&e)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| format!("{e:?}"))
}

// ── Silence probe (blocker 3) ────────────────────────────────────────────────

/// True when NO 300 ms window in the 16 kHz mono s16 WAV rises above
/// [`MIC_SILENCE_DBFS`]. Streams the data chunk (an hour of comms is ~115 MB);
/// early-returns `false` on the first loud window. Non-16-bit or malformed WAVs
/// fail open (`Err` → caller transcribes anyway).
fn wav_is_silent(path: &str) -> Result<bool, String> {
    use std::io::{BufReader, Read, Seek, SeekFrom};

    let f = std::fs::File::open(path).map_err(|e| format!("open wav: {e}"))?;
    let mut r = BufReader::new(f);

    let mut hdr = [0u8; 12];
    r.read_exact(&mut hdr).map_err(|e| format!("wav header: {e}"))?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }

    // Chunk walk: verify fmt says PCM s16, then probe the data chunk.
    let mut bits_per_sample = 0u16;
    loop {
        let mut chunk = [0u8; 8];
        if r.read_exact(&mut chunk).is_err() {
            return Err("no data chunk".into());
        }
        let id = [chunk[0], chunk[1], chunk[2], chunk[3]];
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        match &id {
            b"fmt " => {
                let mut fmt = vec![0u8; size.min(64) as usize];
                r.read_exact(&mut fmt).map_err(|e| format!("fmt chunk: {e}"))?;
                bits_per_sample = u16::from_le_bytes([fmt[14], fmt[15]]);
                if size > fmt.len() as u64 {
                    r.seek(SeekFrom::Current((size - fmt.len() as u64) as i64))
                        .map_err(|e| format!("fmt skip: {e}"))?;
                }
                if size % 2 == 1 {
                    let _ = r.seek(SeekFrom::Current(1));
                }
            }
            b"data" => {
                if bits_per_sample != 16 {
                    return Err(format!("unsupported bits/sample {bits_per_sample}"));
                }
                return Ok(data_is_silent(&mut r, size));
            }
            _ => {
                // Skip unknown chunks (LIST etc.), honoring RIFF word padding.
                let skip = size + (size % 2);
                r.seek(SeekFrom::Current(skip as i64)).map_err(|e| format!("chunk skip: {e}"))?;
            }
        }
    }
}

/// Windowed-RMS scan over an s16 mono data chunk.
fn data_is_silent<R: std::io::Read>(r: &mut R, data_bytes: u64) -> bool {
    let mut remaining = data_bytes;
    let mut buf = vec![0u8; MIC_PROBE_WINDOW_SAMPLES * 2];
    while remaining > 0 {
        let want = buf.len().min(remaining as usize);
        if r.read_exact(&mut buf[..want]).is_err() {
            break; // truncated file — judge on what we saw
        }
        remaining -= want as u64;
        let mut sum_sq = 0f64;
        let n = want / 2;
        for i in 0..n {
            let s = i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]) as f64 / 32768.0;
            sum_sq += s * s;
        }
        if n > 0 {
            let rms = (sum_sq / n as f64).sqrt();
            let dbfs = 20.0 * rms.max(1e-10).log10();
            if dbfs > MIC_SILENCE_DBFS {
                return false; // heard something — not silent
            }
        }
    }
    true
}

// ── The method.py format contract ────────────────────────────────────────────
// These assertions ARE the contract, ported verbatim from the JS selftest they
// replace (`coachTranscribe.selftest.mjs`): if one fails, a real coaching run
// either miscounts its turns or silently truncates.
#[cfg(test)]
mod tests {
    use super::*;

    fn seg(t0_ms: u64, text: &str) -> SegOut {
        SegOut { t0_ms, t1_ms: t0_ms + 500, text: text.to_string() }
    }

    /// method.py's own turn counter: `^\s*\d+:\d{2}\s*$`.
    fn looks_like_a_stamp(line: &str) -> bool {
        let l = line.trim();
        let Some((m, s)) = l.split_once(':') else { return false };
        !m.is_empty()
            && m.chars().all(|c| c.is_ascii_digit())
            && s.len() == 2
            && s.chars().all(|c| c.is_ascii_digit())
    }

    #[test]
    fn stamps_count_past_an_hour() {
        assert_eq!(stamp(0), "0:00");
        assert_eq!(stamp(6_000), "0:06");
        assert_eq!(stamp(65_000), "1:05");
        // Minutes do NOT wrap at 60.
        assert_eq!(stamp(4_335_000), "72:15");
    }

    #[test]
    fn interleaves_both_tracks_in_time_order() {
        let mic = [
            seg(0, "okay so what you want here is a fight you can leave"),
            seg(6_000, "same mistake again"),
        ];
        let comms = [seg(4_000, "my builds are awful")];
        let body = coach_transcript(&mic, &comms, "Malthaiel", 0);
        let lines: Vec<&str> = body.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(
            lines,
            vec![
                "0:00", "Malthaiel", "okay so what you want here is a fight you can leave",
                "0:04", "Student", "my builds are awful",
                "0:06", "Malthaiel", "same mistake again",
            ]
        );
        // Three lines per turn, exactly one of them a timestamp to method.py.
        assert_eq!(lines.len() % 3, 0);
        assert_eq!(lines.iter().filter(|l| looks_like_a_stamp(l)).count(), 3);
    }

    #[test]
    fn drops_wordless_turns_and_trims() {
        let mic = [seg(0, "my builds are awful"), seg(9_000, "   ")];
        let comms = [seg(6_000, "  okay, general lesson then  ")];
        let body = coach_transcript(&mic, &comms, "Speaker 1", 0);
        let lines: Vec<&str> = body.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(
            lines,
            vec!["0:00", "Speaker 1", "my builds are awful", "0:06", "Student", "okay, general lesson then"]
        );
    }

    #[test]
    fn no_segments_is_an_empty_body_not_a_stray_turn() {
        assert_eq!(coach_transcript(&[], &[], "Malthaiel", 0), "");
    }

    /// A trimmed run must stamp against the ORIGINAL recording: the 2026-09-10 live
    /// run over 30:00-35:00 wrote `4:53` where the recording says `34:53`.
    #[test]
    fn trimmed_run_stamps_point_at_the_original_recording() {
        let mic = [seg(173_000, "same mistake again")];
        let comms = [seg(2_000, "my builds are awful")];
        let body = coach_transcript(&mic, &comms, "Malthaiel", 1_800_000);
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(
            lines,
            vec!["30:02", "Student", "my builds are awful", "32:53", "Malthaiel", "same mistake again"]
        );
    }
}
