//! The resident Whisper worker (Voice Transcription, SF2).
//!
//! ONE dedicated `std::thread` owns the loaded `WhisperContext` (resident — one model
//! at a time) and serves `EngineCmd`s from the daemon's control thread over a
//! `std::sync::mpsc` channel. It emits wire `Event`s (`model_loaded` / `segment` /
//! `final` / `progress` / `error`) DIRECTLY onto the broadcast bus — unlike the
//! mortar-pestle-capture daemon, STT events are self-contained payloads (no engine-state
//! snapshot to re-read), so capture's internal `EngineEvent` enum + drain task
//! collapse away here.
//!
//! Blocking by design: `whisper_full` is a long synchronous GPU/CPU call, so it runs
//! on THIS thread, never on the tokio runtime.
//!
//! CANCEL = finish-then-discard. We do NOT use whisper's abort callback: aborting
//! `whisper_full` mid-graph wedges GGML state GLOBALLY (proven on the SF2 CPU gate —
//! even a full `WhisperContext` reload doesn't recover; every subsequent transcription
//! fails to encode with `error -6`). So `cancel` instead raises a shared
//! `Arc<AtomicBool>`; the in-flight run finishes computing, and the worker then drops
//! its output and reports `cancelled`. The model stays resident + immediately usable
//! (no abort, no corruption). Trade-off: a long file's cancel waits for the run to
//! complete; a Phase-3 UI can add window-boundary cancel (encoder_begin) later.
//!
//! SF2 is file-mode only (no mic — that's Phase 2 / cpal). The whisper context is
//! created ON this thread (in `handle_load`) and never crosses a thread boundary.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tokio::sync::broadcast;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::daemon::engine::EngineCmd;
use crate::models::{download_model, ensure_model, ModelError};
use crate::protocol::{DownloadComplete, Event, Final, ModelLoaded, ProtoError, Progress, Segment};

/// whisper consumes 16 kHz mono f32 PCM (the cross-cutting audio contract).
const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// True when a GPU backend (Vulkan or CUDA) is compiled in. Explicit `any(...)` instead of
/// whisper-rs's internal `_gpu` meta-feature, so we don't lean on a semi-private feature
/// name. A CPU-only build (`default = []`) → `false`.
pub(crate) fn gpu_compiled() -> bool {
    cfg!(any(feature = "vulkan", feature = "cuda"))
}

/// The compiled GPU backend's name for `model_loaded.backend`. Vulkan and CUDA are mutually
/// exclusive in practice; if both were somehow compiled, CUDA wins (harmless). CPU-only
/// build → `"cpu"`.
pub(crate) fn gpu_backend_name() -> &'static str {
    if cfg!(feature = "cuda") {
        "cuda"
    } else if cfg!(feature = "vulkan") {
        "vulkan"
    } else {
        "cpu"
    }
}

/// Build a whisper context on a specific device. The low-level loader shared by the
/// auto-resolver and the [`crate::bench`] harness (which forces each backend to measure
/// both from one `--features vulkan` build via the runtime `use_gpu` field).
pub(crate) fn load_ctx_on(path: &Path, use_gpu: bool) -> Result<WhisperContext, whisper_rs::WhisperError> {
    let mut cparams = WhisperContextParameters::default();
    cparams.use_gpu = use_gpu;
    WhisperContext::new_with_params(path, cparams)
}

/// Load a context GPU-first with a CPU fallback, returning the backend that ACTUALLY loaded
/// (not a compile-time guess). When a GPU backend is compiled in we try the GPU; on a clean
/// `Err` (e.g. no usable device) we retry on CPU and report `"cpu"`. This catches only a
/// Rust `Err` — a hard ggml `abort()` on a GPU-less host would terminate the process before
/// the fallback, which is out of scope here (every supported host has a working Vulkan
/// device). Drives both `handle_load` and dictation's `init_speech`.
pub(crate) fn load_ctx(path: &Path) -> Result<(WhisperContext, &'static str), whisper_rs::WhisperError> {
    if gpu_compiled() {
        match load_ctx_on(path, true) {
            Ok(ctx) => return Ok((ctx, gpu_backend_name())),
            Err(e) => log::warn!("whisper: GPU load failed ({e}); retrying on CPU"),
        }
    }
    load_ctx_on(path, false).map(|ctx| (ctx, "cpu"))
}

/// Resolve a context load honoring an explicit backend choice (Phase 5 Force-CPU):
/// `None` = auto ([`load_ctx`], GPU-first with CPU fallback); `Some(false)` = force
/// CPU; `Some(true)` = force the compiled GPU backend (no fallback). Returns the
/// context + the backend that ACTUALLY loaded (for `model_loaded.backend`). Shared by
/// `handle_load` and dictation's `init_speech`.
pub(crate) fn load_ctx_choice(
    path: &Path,
    use_gpu: Option<bool>,
) -> Result<(WhisperContext, &'static str), whisper_rs::WhisperError> {
    match use_gpu {
        None => load_ctx(path),
        Some(true) => load_ctx_on(path, true).map(|ctx| (ctx, gpu_backend_name())),
        Some(false) => load_ctx_on(path, false).map(|ctx| (ctx, "cpu")),
    }
}

/// Spawn the resident whisper worker thread. Returns its `JoinHandle`; `daemon::run`
/// joins it on shutdown for a clean model teardown. The closure captures only `Send`
/// handles (mpsc `Receiver`, broadcast `Sender`, `Arc<AtomicBool>`).
pub fn spawn_worker(
    cmd_rx: Receiver<EngineCmd>,
    events: broadcast::Sender<Event>,
    cancel: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("mortar-pestle-stt-whisper".into())
        .spawn(move || run_worker(cmd_rx, events, cancel))
        .expect("spawn mortar-pestle-stt whisper worker thread")
}

/// The worker loop: block on `recv()`, run each command to completion, repeat. New
/// commands queue while a transcription runs (the worker is single-threaded by
/// design); `cancel` marks the in-flight run for discard via the shared flag.
fn run_worker(cmd_rx: Receiver<EngineCmd>, events: broadcast::Sender<Event>, cancel: Arc<AtomicBool>) {
    // The resident model (one at a time). `unload` / a fresh `load_model` drops it.
    let mut model: Option<WhisperContext> = None;
    log::info!("whisper worker ready (backend={}) — awaiting EngineCmd", gpu_backend_name());

    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            EngineCmd::LoadModel { name, use_gpu } => handle_load(&mut model, &events, &name, use_gpu),
            EngineCmd::TranscribeFile { path } => {
                handle_transcribe(model.as_ref(), &events, &cancel, &path)
            }
            EngineCmd::DownloadModel { name } => handle_download(&events, &cancel, &name),
            EngineCmd::Unload => {
                if model.take().is_some() {
                    log::info!("whisper: model unloaded");
                }
            }
            EngineCmd::Shutdown => {
                log::info!("whisper: shutdown — dropping model + exiting worker");
                break;
            }
        }
    }
}

/// `load_model {name}`: resolve `name` against the registry, fetch + SHA256-verify the
/// model on demand (SF3), load the context resident, emit `model_loaded` with the
/// verified hash. Download `progress` events stream while a fetch is in flight; an
/// already-verified cache file loads with none. An unknown name → `bad_request` (no
/// fetch); a download/verify failure → `model_download_failed` (the temp is discarded —
/// never a corrupt load). Traversal/separator names are rejected up front.
fn handle_load(
    model_slot: &mut Option<WhisperContext>,
    events: &broadcast::Sender<Event>,
    name: &str,
    use_gpu: Option<bool>,
) {
    if name.is_empty() || name.contains('/') || name.contains("..") {
        emit_error(events, "bad_request", format!("invalid model name `{name}`"));
        return;
    }

    // SF3: ensure the model is present + SHA256-verified, fetching on demand. The
    // progress closure forwards download percentage onto the bus as `progress` events
    // (reusing the transcription Progress payload); a verified cache hit emits none.
    let ensured = ensure_model(name, |pct| {
        if let Ok(data) = serde_json::to_value(Progress { pct }) {
            let _ = events.send(Event { event: "progress".to_string(), data });
        }
    });
    let ensured = match ensured {
        Ok(m) => m,
        Err(ModelError::UnknownModel(n)) => {
            emit_error(events, "bad_request", format!("unknown model `{n}` (not in the registry)"));
            return;
        }
        Err(ModelError::Download(msg)) => {
            emit_error(events, "model_download_failed", msg);
            return;
        }
    };

    log::info!("whisper: loading `{name}` from {}", ensured.path.display());

    match load_ctx_choice(&ensured.path, use_gpu) {
        Ok((ctx, backend)) => {
            *model_slot = Some(ctx);
            log::info!("whisper: model `{name}` loaded (backend={backend}, sha256={})", ensured.sha256);
            emit(
                events,
                "model_loaded",
                &ModelLoaded {
                    name: name.to_string(),
                    sha: ensured.sha256.to_string(),
                    backend: backend.to_string(),
                },
            );
        }
        Err(e) => {
            *model_slot = None;
            emit_error(events, "load_failed", format!("failed to load `{name}`: {e}"));
        }
    }
}

/// `download_model {name}` (Phase 5): fetch + SHA256-verify a model into the cache
/// WITHOUT loading it (download ≠ activate). Streams `progress` while fetching, then
/// emits a terminal `download_complete {name}`. A `cancel` raised mid-download discards
/// the temp and emits `cancelled`. Runs on the worker thread (serialized with
/// load/transcribe), so its `progress` never interleaves with another op's. An
/// already-verified cache hit completes immediately with no fetch.
fn handle_download(events: &broadcast::Sender<Event>, cancel: &Arc<AtomicBool>, name: &str) {
    if name.is_empty() || name.contains('/') || name.contains("..") {
        emit_error(events, "bad_request", format!("invalid model name `{name}`"));
        return;
    }
    // Clear any stale cancel so a prior cancellation can't abort this fresh download.
    cancel.store(false, Ordering::SeqCst);
    let result = download_model(name, cancel, |pct| {
        if let Ok(data) = serde_json::to_value(Progress { pct }) {
            let _ = events.send(Event { event: "progress".to_string(), data });
        }
    });
    match result {
        Ok(true) => {
            log::info!("model `{name}` downloaded (download-only) — not loaded");
            emit(events, "download_complete", &DownloadComplete { name: name.to_string() });
        }
        Ok(false) => emit_error(events, "cancelled", format!("download of `{name}` cancelled")),
        Err(ModelError::UnknownModel(n)) => {
            emit_error(events, "bad_request", format!("unknown model `{n}` (not in the registry)"));
        }
        Err(ModelError::Download(msg)) => emit_error(events, "model_download_failed", msg),
    }
}

/// `transcribe_file {path}`: decode → 16 kHz mono f32 → batch `whisper_full` → emit
/// each `segment`, then `final`; live `progress` via the progress callback. A cancel
/// that arrives mid-run discards the output and reports `cancelled` (see the module
/// header) — the model stays resident.
fn handle_transcribe(
    model: Option<&WhisperContext>,
    events: &broadcast::Sender<Event>,
    cancel: &Arc<AtomicBool>,
    path: &str,
) {
    let Some(ctx) = model else {
        emit_error(events, "no_model", "no model loaded — send load_model first".to_string());
        return;
    };

    // Fresh run: clear any stale cancel so a previous cancellation can't discard this one.
    cancel.store(false, Ordering::SeqCst);

    let pcm = match decode_to_16k_mono(Path::new(path)) {
        Ok(p) if !p.is_empty() => p,
        Ok(_) => {
            emit_error(events, "empty_audio", format!("no audio samples decoded from {path}"));
            return;
        }
        Err(e) => {
            emit_error(events, "decode_failed", format!("decode {path}: {e}"));
            return;
        }
    };

    run_full(ctx, events, cancel, &pcm);
}

/// Run one batch transcription: greedy `whisper_full` with timestamps on + live
/// `progress`. On success emits `segment`s then `final`; if a cancel landed during the
/// run, discards the output and emits `cancelled` instead (finish-then-discard).
fn run_full(
    ctx: &WhisperContext,
    events: &broadcast::Sender<Event>,
    cancel: &Arc<AtomicBool>,
    pcm: &[f32],
) {
    let mut state = match ctx.create_state() {
        Ok(s) => s,
        Err(e) => {
            emit_error(events, "internal", format!("create_state: {e}"));
            return;
        }
    };

    // Greedy batch params; whisper.cpp's own stdout prints suppressed (we emit
    // structured events instead). Timestamps stay on so segments carry t0/t1.
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let n_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32;
    params.set_n_threads(n_threads);

    // Live progress 0..=100, suppressed once cancelled (the run still finishes — we
    // just stop bothering the client). Deliberately NO abort callback (see module hdr).
    {
        let events = events.clone();
        let cancel = cancel.clone();
        params.set_progress_callback_safe(move |pct: i32| {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            if let Ok(data) = serde_json::to_value(Progress { pct: pct as f64 }) {
                let _ = events.send(Event { event: "progress".to_string(), data });
            }
        });
    }

    let result = state.full(params, pcm);

    // Finish-then-discard: a cancel during the run drops the output (model stays
    // resident + usable — no abort, no GGML corruption). `swap` clears it for next time.
    if cancel.swap(false, Ordering::SeqCst) {
        log::info!("whisper: transcription cancelled (run finished, output discarded)");
        emit_error(events, "cancelled", "transcription cancelled".to_string());
        return;
    }

    match result {
        Ok(()) => {
            // Segments are emitted right after `full` completes (batch mode); live
            // per-segment streaming is a trivial Phase-3 upgrade via the segment cb.
            let mut full_text = String::new();
            for seg in state.as_iter() {
                let text = seg.to_str_lossy().map(|c| c.into_owned()).unwrap_or_default();
                let t0_ms = (seg.start_timestamp().max(0) as u64) * 10;
                let t1_ms = (seg.end_timestamp().max(0) as u64) * 10;
                full_text.push_str(&text);
                emit(events, "segment", &Segment { text, t0_ms, t1_ms });
            }
            let final_text = full_text.trim().to_string();
            log::info!("whisper: transcription complete ({} chars)", final_text.len());
            emit(events, "final", &Final { text: final_text });
        }
        Err(e) => emit_error(events, "internal", format!("whisper_full failed: {e}")),
    }
}

/// Transcribe one in-memory 16 kHz mono f32 PCM slice to plain text — the dictation
/// path's per-segment + tail transcription (Phase 2 SF3, `daemon::dictation`). Unlike
/// [`run_full`] it emits NO wire events and installs NO progress/abort callback: it just
/// returns the trimmed transcript, so the dictation consumer emits the `segment` (with
/// VAD-derived `t0`/`t1`) and accumulates the terminal `final` itself. A fresh `state`
/// per call (whisper requires one per decode); the caller's resident `ctx` is reused.
///
/// Empty input → `Ok(String::new())` (no FFI round-trip). No abort callback is ever
/// installed, so GGML is never wedged (see the module header's CANCEL note).
pub fn transcribe_pcm(ctx: &WhisperContext, pcm: &[f32]) -> Result<String, String> {
    if pcm.is_empty() {
        return Ok(String::new());
    }
    let mut state = ctx.create_state().map_err(|e| format!("create_state: {e}"))?;

    // Greedy batch params — identical to the file path (`run_full`) minus the progress
    // callback (dictation segments are short; per-segment progress is just noise).
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let n_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32;
    params.set_n_threads(n_threads);

    state.full(params, pcm).map_err(|e| format!("whisper_full: {e}"))?;

    let mut text = String::new();
    for seg in state.as_iter() {
        let s = seg.to_str_lossy().map(|c| c.into_owned()).unwrap_or_default();
        text.push_str(&s);
    }
    Ok(text.trim().to_string())
}

/// Decode an audio file to 16 kHz mono f32 PCM (the whisper contract). symphonia
/// handles the container/codec (SF2: WAV/PCM only); channels are downmixed by averaging
/// and the stream is linearly resampled to 16 kHz if its native rate differs. The
/// gate WAV is already 16 kHz mono, so the fast path applies; the naive resampler is
/// replaced by `rubato` when mic capture lands in Phase 2.
pub(crate) fn decode_to_16k_mono(path: &Path) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("probe: {e}"))?;
    let mut format = probed.format;

    let track = format.default_track().ok_or("no default audio track")?;
    let track_id = track.id;
    let src_rate = track.codec_params.sample_rate.ok_or("unknown sample rate")?;
    let n_ch = track.codec_params.channels.ok_or("unknown channel layout")?.count().max(1);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("make decoder: {e}"))?;

    let mut mono: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Clean EOF — symphonia surfaces it as an UnexpectedEof IoError.
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("read packet: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                if sample_buf.is_none() {
                    let spec = *audio_buf.spec();
                    let dur = audio_buf.capacity() as u64;
                    sample_buf = Some(SampleBuffer::<f32>::new(dur, spec));
                }
                if let Some(buf) = &mut sample_buf {
                    buf.copy_interleaved_ref(audio_buf);
                    // Interleaved [ch0, ch1, ...] per frame → average to mono.
                    for frame in buf.samples().chunks(n_ch) {
                        let sum: f32 = frame.iter().copied().sum();
                        mono.push(sum / n_ch as f32);
                    }
                }
            }
            // Recoverable decode hiccup — skip this packet (symphonia idiom).
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode: {e}")),
        }
    }

    if src_rate == WHISPER_SAMPLE_RATE {
        Ok(mono)
    } else {
        Ok(resample_linear(&mono, src_rate, WHISPER_SAMPLE_RATE))
    }
}

/// Naive linear-interpolation resampler — adequate for the SF2 file-mode proof (only
/// hit for non-16 kHz inputs; the gate WAV is already 16 kHz). Phase 2's mic path
/// replaces this with `rubato` for quality resampling.
fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if input.is_empty() || from_rate == 0 || from_rate == to_rate {
        return input.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

// ── Event helpers ─────────────────────────────────────────────────────────────

/// Serialize a protocol payload struct and broadcast it as a wire `Event`. A send
/// error only means zero subscribers — dropped, exactly like the capture daemon.
fn emit<T: serde::Serialize>(events: &broadcast::Sender<Event>, name: &str, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(data) => {
            let _ = events.send(Event { event: name.to_string(), data });
        }
        Err(e) => log::warn!("whisper: failed to encode `{name}` event: {e}"),
    }
}

/// Broadcast an `error` event with a snake_case code (also logged).
fn emit_error(events: &broadcast::Sender<Event>, code: &str, message: String) {
    log::warn!("whisper: error[{code}] {message}");
    let err = ProtoError::new(code, message);
    if let Ok(data) = serde_json::to_value(err) {
        let _ = events.send(Event { event: "error".to_string(), data });
    }
}
