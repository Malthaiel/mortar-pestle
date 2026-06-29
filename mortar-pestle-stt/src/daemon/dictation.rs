//! Live mic dictation (Voice Transcription epic, Phase 2).
//!
//! `start_dictation` opens the default input device (via `crate::mic`), spawns a
//! dedicated consumer thread that resamples each native-rate capture chunk to the
//! locked 16 kHz mono f32 contract (`crate::resample`), computes the input level
//! (RMS) over fixed windows, and streams `vu` events onto the daemon's broadcast
//! bus at ~25 Hz. The consumer also runs VAD (`crate::vad`) over the accumulated
//! buffer and — SF3 — transcribes each finalized VAD segment through a resident
//! speech `WhisperContext`, emitting `segment {text, t0_ms, t1_ms}` per utterance.
//! `stop_dictation` stops the mic; the consumer then drains, flushes + transcribes
//! the trailing segment, and emits a terminal `final {text:<full transcript>}`.
//!
//! ## Why a dedicated thread, not the whisper worker (load-bearing)
//!
//! Dictation is open-ended + non-blocking; routing it through `EngineCmd` would
//! occupy the single blocking whisper thread for the whole session. So the mic +
//! consumer run on their own threads, and only `Send` control handles
//! ([`DictationHandle`]) live on the (cloneable, `Send`) [`ControlContext`]. The
//! `!Send` `cpal::Stream` never leaves `mic`'s owner thread.
//!
//! ## The cpal-callback → broadcast bridge
//!
//! `mic`'s cpal data callback pushes [`AudioChunk`]s over a `std::sync::mpsc`
//! channel; THIS module's consumer thread owns the `Receiver` and is the only
//! emitter of `vu`/`segment`/`final`. So the bridge from cpal's realtime audio
//! thread to the async event bus is just that sync channel + a normal
//! `broadcast::Sender::send` (the exact `send` the whisper worker uses) — no
//! cpal-side async, no per-frame work on the audio thread beyond the format-
//! normalize `mic` already does.
//!
//! ## Two coexisting whisper contexts (SF3)
//!
//! During a session the consumer thread owns BOTH the VAD [`VadChunker`]
//! (`WhisperVadContext`, speech-activity) and a speech [`WhisperContext`]
//! (transcription). They coexist for the session's lifetime, born on and confined to
//! the consumer thread (each transcription runs a fresh state off the resident speech
//! ctx — see `whisper::transcribe_pcm`). Both are loaded fetch-on-demand on the
//! consumer thread (never in `start`, which must ack fast), and BOTH degrade
//! gracefully to `None` on a load failure: dictation still streams `vu` (and empty-
//! text VAD `segment`s if only the speech model failed) and still emits the terminal
//! `final` — the daemon NEVER panics on a model problem.

use std::sync::mpsc::Receiver;

use tokio::sync::broadcast;
use whisper_rs::WhisperContext;

use crate::daemon::engine::{ControlContext, DictationHandle};
use crate::mic::{AudioChunk, MicCapture};
use crate::models::{ensure_model, ModelError};
use crate::protocol::{DictationCommitted, DictationStarted, Event, Final, ProtoError, Progress, Segment, Vu};
use crate::resample::{rms, Resampler16k, TARGET_RATE};
use crate::vad::{EmitCursor, SegmentMs, VadChunker, DEFAULT_HANGOVER_MS, DEFAULT_THRESHOLD};
use crate::whisper::{load_ctx_choice, transcribe_pcm};

/// Who initiated a dictation — drives the terminal routing. A `Hotkey` session also
/// emits `dictation_committed` so the host appends the transcript to today's Quick
/// Notes (the daemon can't write the vault); a `Client` session relies on its
/// per-call Channel for the `final` and never auto-appends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictationSource {
    Client,
    Hotkey,
}

impl DictationSource {
    fn as_str(self) -> &'static str {
        match self {
            DictationSource::Client => "client",
            DictationSource::Hotkey => "hotkey",
        }
    }
}

/// `vu` emission rate (Hz). One RMS level per ~40 ms window — fast enough for a
/// live meter, slow enough that the bus never floods (cpal callbacks fire faster).
const VU_HZ: usize = 25;

/// 16 kHz mono frames per `vu` window (≈ 640 @ 25 Hz). RMS is computed over each
/// full window of freshly-resampled output.
const VU_WINDOW: usize = TARGET_RATE / VU_HZ;

/// 16 kHz mono frames per millisecond (= 16). Maps a VAD `(t0_ms, t1_ms)` onto the
/// accumulated sample buffer when slicing a segment for transcription.
const FRAMES_PER_MS: usize = TARGET_RATE / 1000;

/// The VAD model registry name (Voice Transcription SF2). Hardcoded: the VAD model is
/// an implementation detail of dictation, NOT exposed on the wire —
/// `StartDictationArgs.model` is the *speech* model (consumed in SF3), never the VAD one.
const VAD_MODEL: &str = "silero-v5.1.2";

/// Re-run VAD once per this many NEW 16 kHz frames (= 1 s @ 16 kHz). SF2 re-runs
/// detection over the WHOLE accumulated buffer each tick — O(total_audio) per tick, so
/// O(n²) over a long session, which is fine for short dictation utterances (the gate is
/// correctness, not throughput). A later phase swaps this for incremental probabilities
/// or a sliding window anchored at the last finalized segment so each tick processes
/// only new audio. Keyed on accumulated FRAME count (robust to cpal's variable chunk
/// size), exactly like the `vu` cursor.
const VAD_TICK_FRAMES: usize = TARGET_RATE;

/// `start_dictation {model, vad_threshold?, hangover_ms?}` — open the mic and begin
/// streaming `vu` + VAD-segmented transcription. NON-BLOCKING: returns immediately after
/// the device opens (a few ms; `mic::MicCapture::open` reports its open result
/// synchronously). `vad_threshold`/`hangover_ms` tune VAD (resolved to
/// [`DEFAULT_THRESHOLD`]/[`DEFAULT_HANGOVER_MS`] when `None`); `model` is the SPEECH model
/// loaded on the consumer thread (SF3). `conn_id` records the owning connection so a
/// socket disconnect releases only THIS session's mic.
///
/// - Already dictating → `busy` (the caller never starts a second session).
/// - Mic open failed → emit `error {code}` (`no_input_device` / `device_busy`, per
///   [`crate::mic::MicError::code`]) on the bus (the host relay catches it →
///   `Done{ok:false}`) and still ACK; the daemon stays alive — it NEVER panics/exits on
///   a missing/busy device.
/// - Success → spawn the consumer thread, stash the `Send` handle, ACK.
///
/// The VAD + speech model download + context loads happen on the CONSUMER thread (not
/// here), so `start` never blocks on a possible first-run fetch — see [`consume`].
///
/// Returns `Ok(())` on a clean start (or a handled open-failure that emitted an error
/// event); `Err(ProtoError)` only for `busy`, so the dispatcher acks vs error-responds
/// accordingly.
pub fn start(
    ctx: &ControlContext,
    conn_id: u64,
    model: String,
    vad_threshold: Option<f32>,
    hangover_ms: Option<u32>,
    use_gpu: Option<bool>,
    source: DictationSource,
) -> Result<(), ProtoError> {
    if ctx.is_dictating() {
        return Err(ProtoError::new("busy", "dictation already running"));
    }

    // cpal callback → consumer channel. `mic` clones the Sender into the data
    // callback; when the stream drops (on stop), the last Sender drops and the
    // consumer's `recv()` returns Err — its drain/finalize trigger.
    let (frames_tx, frames_rx) = std::sync::mpsc::channel::<AudioChunk>();

    let handle = match MicCapture::open(frames_tx) {
        Ok(h) => h,
        Err(e) => {
            // Map the open failure to its protocol code (no_input_device / device_busy)
            // and emit on the bus so the already-subscribed host relay sees it; the
            // daemon keeps running. `frames_rx` drops here (no consumer spawned).
            emit_error(&ctx.events, e.code(), e.to_string());
            return Ok(());
        }
    };

    let native_rate = handle.sample_rate();
    let native_channels = handle.channels();
    let events = ctx.events.clone();

    let consumer = std::thread::Builder::new()
        .name("mortar-pestle-stt-dictation".into())
        .spawn(move || {
            consume(
                frames_rx,
                events,
                native_rate,
                native_channels,
                model,
                vad_threshold,
                hangover_ms,
                use_gpu,
                source,
            )
        })
        .map_err(|e| ProtoError::new("internal", format!("spawn dictation consumer: {e}")))?;

    // Defensive: `is_dictating` already gated this, but if a prior handle lingered,
    // dropping it stops its mic (Drop → stop). The new handle is now the session.
    if let Some(prev) = ctx.set_dictation(conn_id, DictationHandle { mic: handle, consumer }) {
        drop(prev);
    }
    // Announce the live session so the host reflects the recording state — important
    // for a HOTKEY session it didn't initiate over a per-call Channel.
    emit_started(&ctx.events, source);
    Ok(())
}

/// `stop_dictation` — stop the live mic; the consumer thread then drains, flushes +
/// transcribes the trailing segment, and emits a terminal `final {text}`. Idempotent: a
/// no-op (still acks) when nothing is running. NON-BLOCKING on the consumer: `mic.stop()`
/// joins only the mic's own owner thread (a quick park-unpark), then closes the capture
/// channel; the consumer tears itself down + emits `final` asynchronously, which ends the
/// host relay loop.
pub fn stop(ctx: &ControlContext) {
    if let Some(mut handle) = ctx.take_dictation() {
        // Drops the cpal Stream on its owner thread → capture stops → the capture
        // channel closes → the consumer's `recv()` returns Err → it finalizes.
        handle.mic.stop();
        // Detach the consumer (it emits `final` on its own as the channel closes).
        // Dropping the JoinHandle does not join — non-blocking.
        drop(handle.consumer);
    }
    // No session → nothing to do; the dispatcher still acks (idempotent stop).
}

/// Release the mic IFF `conn_id` owns the live session — the socket-disconnect hook
/// (`socket::handle_client`), so a client that drops without `stop_dictation` never leaks
/// the input stream, while a transient probe (or another client) disconnecting can't tear
/// down a session it didn't start. Taking + dropping the handle stops the mic
/// (`MicHandle` Drop) and detaches the consumer, exactly like [`stop`]; the consumer
/// still emits its terminal `final` as the channel closes.
pub fn release_owned(ctx: &ControlContext, conn_id: u64) {
    if let Some(handle) = ctx.take_dictation_if_owner(conn_id) {
        drop(handle);
    }
}

/// The consumer thread: resample each native-rate chunk to 16 kHz mono, emit `vu` RMS at
/// ~`VU_HZ`, run VAD periodically over the accumulated buffer, transcribe each newly-
/// finalized segment through the resident speech context, and emit `segment {text,
/// t0_ms, t1_ms}`; on channel close flush + transcribe the trailing segment and emit the
/// terminal `final {text:<full transcript>}`. The accumulated 16 kHz buffer is retained
/// whole (not drained) so each VAD pass + segment slice sees the full session; `vu` reads
/// only the freshly-produced tail via a cursor.
///
/// Both whisper models are fetched-on-demand (reusing `models::ensure_model`) + built
/// ONCE here, before the recv loop — never per tick. A load failure on EITHER degrades
/// gracefully (an `error` is emitted; `vu` keeps streaming; the terminal `final` still
/// fires) — the daemon NEVER panics.
fn consume(
    frames_rx: Receiver<AudioChunk>,
    events: broadcast::Sender<Event>,
    native_rate: u32,
    native_channels: u16,
    model: String,
    vad_threshold: Option<f32>,
    hangover_ms: Option<u32>,
    use_gpu: Option<bool>,
    source: DictationSource,
) {
    let mut resampler = match Resampler16k::new(native_rate, native_channels) {
        Ok(r) => r,
        Err(e) => {
            // Near-impossible for a real device (only `native_rate == 0`); refuse
            // cleanly rather than panic. Emit error + a terminal `final` so the host
            // relay still ends. Drain the channel so the mic owner never blocks.
            emit_error(&events, "internal", format!("resampler init: {e}"));
            while frames_rx.recv().is_ok() {}
            emit_final(&events, String::new());
            return;
        }
    };

    // Resolve the VAD tuning once (defaults when the caller omitted them).
    let threshold = vad_threshold.unwrap_or(DEFAULT_THRESHOLD);
    let hangover = hangover_ms.unwrap_or(DEFAULT_HANGOVER_MS);

    // VAD + speech: fetch-on-demand + build ONCE, here on the consumer thread (start()
    // must ack fast — it cannot block on a possible first-run fetch). `None` on any
    // failure → graceful degrade (still streams `vu`, still emits `final`).
    let mut vad = init_vad(&events, threshold, hangover);
    let speech = init_speech(&events, &model, use_gpu);

    // Tracks which finalized segments have already been emitted (per the vad module's
    // finalization policy); matched to the same hangover the chunker uses.
    let mut emit_cursor = EmitCursor::new(hangover);
    // Accumulated 16 kHz frame count at the last VAD tick (cadence cursor).
    let mut vad_cursor: usize = 0;
    // How many accumulated 16 kHz frames have already been folded into a `vu` event.
    let mut vu_cursor: usize = 0;
    // The running transcript — each finalized segment's text, space-joined for `final`.
    let mut transcript = String::new();

    // Block until the mic stops (stream drop closes the channel → `recv()` Err).
    while let Ok(chunk) = frames_rx.recv() {
        if let Err(e) = resampler.push(&chunk.samples) {
            // A steady-state resample error is not expected for valid fixed input;
            // log + keep going (don't tear down the whole session over one chunk).
            log::warn!("dictation: resample push failed: {e}");
            continue;
        }
        // Emit one `vu` per full VU_WINDOW of NEW 16 kHz output.
        let produced = resampler.buffer().len();
        while produced - vu_cursor >= VU_WINDOW {
            let window = &resampler.buffer()[vu_cursor..vu_cursor + VU_WINDOW];
            emit_vu(&events, rms(window) as f64);
            vu_cursor += VU_WINDOW;
        }

        // VAD tick: once per ~1 s of NEW audio, re-run detection over the whole
        // buffer and transcribe + emit any NEWLY-finalized segments (the trailing
        // in-progress segment is held until a later tick or the final flush below).
        if let Some(chunker) = vad.as_mut() {
            if produced - vad_cursor >= VAD_TICK_FRAMES {
                vad_cursor = produced;
                let newly = vad_newly_finalized(chunker, &mut emit_cursor, resampler.buffer(), false);
                for (t0_ms, t1_ms) in newly {
                    transcribe_and_emit_segment(
                        &events,
                        speech.as_ref(),
                        resampler.buffer(),
                        t0_ms,
                        t1_ms,
                        &mut transcript,
                    );
                }
            }
        }
    }

    // Channel closed (mic stopped). Final VAD pass: flush the held trailing segment
    // (it has no post-hangover silence, so it can only be released on stop).
    if let Some(chunker) = vad.as_mut() {
        let newly = vad_newly_finalized(chunker, &mut emit_cursor, resampler.buffer(), true);
        for (t0_ms, t1_ms) in newly {
            transcribe_and_emit_segment(
                &events,
                speech.as_ref(),
                resampler.buffer(),
                t0_ms,
                t1_ms,
                &mut transcript,
            );
        }
    }

    // Flush the trailing partial window as a final `vu` so the meter doesn't freeze
    // mid-level.
    let tail = &resampler.buffer()[vu_cursor..];
    if !tail.is_empty() {
        emit_vu(&events, rms(tail) as f64);
    }

    log::info!(
        "dictation: stopped — {} frames captured, transcript {} chars",
        resampler.buffer().len(),
        transcript.len()
    );

    // Terminal event(s). A HOTKEY-driven session also emits `dictation_committed` so
    // the host appends the transcript to today's Quick Notes (the daemon can't write
    // the vault); a client session's per-call Channel owns the `final` instead.
    if matches!(source, DictationSource::Hotkey) {
        emit_committed(&events, transcript.clone());
    }
    emit_final(&events, transcript);
}

// ── Event helpers (same broadcast `send` path the whisper worker uses) ───────────

/// Emit a `vu {rms}` event. `rms` is `f64` to match the protocol's float convention
/// (`Progress.pct`). A send error only means zero subscribers — harmless.
fn emit_vu(events: &broadcast::Sender<Event>, rms: f64) {
    if let Ok(data) = serde_json::to_value(Vu { rms }) {
        let _ = events.send(Event { event: "vu".to_string(), data });
    }
}

/// Emit the terminal `final {text}` — the full session transcript (empty on a degraded
/// session). Ends the host relay loop.
fn emit_final(events: &broadcast::Sender<Event>, text: String) {
    if let Ok(data) = serde_json::to_value(Final { text }) {
        let _ = events.send(Event { event: "final".to_string(), data });
    }
}

/// Emit `dictation_started {source}` — the host shows the recording state (esp. for a
/// hotkey-driven session it didn't initiate via a Channel).
fn emit_started(events: &broadcast::Sender<Event>, source: DictationSource) {
    if let Ok(data) = serde_json::to_value(DictationStarted { source: source.as_str().to_string() }) {
        let _ = events.send(Event { event: "dictation_started".to_string(), data });
    }
}

/// Emit `dictation_committed {text}` — a HOTKEY session's terminal transcript for the
/// host's daily-log sink (UI-driven dictation never emits this).
fn emit_committed(events: &broadcast::Sender<Event>, text: String) {
    if let Ok(data) = serde_json::to_value(DictationCommitted { text }) {
        let _ = events.send(Event { event: "dictation_committed".to_string(), data });
    }
}

/// Emit a `segment {text, t0_ms, t1_ms}` — a VAD-bound utterance with its transcript
/// (SF3). `text` is empty only when the speech model failed to load or the slice didn't
/// transcribe. Same broadcast `send` the other emitters use.
fn emit_segment(events: &broadcast::Sender<Event>, text: &str, t0_ms: u64, t1_ms: u64) {
    if let Ok(data) = serde_json::to_value(Segment { text: text.to_string(), t0_ms, t1_ms }) {
        let _ = events.send(Event { event: "segment".to_string(), data });
    }
}

// ── Transcription wiring (Voice Transcription SF3) ───────────────────────────────

/// Slice a finalized VAD segment out of the accumulated 16 kHz buffer, transcribe it (if
/// the speech model loaded), emit `segment {text, t0_ms, t1_ms}`, and append the text to
/// the running `transcript` for the terminal `final`. A transcription failure logs +
/// emits an empty-text segment (the VAD bound still surfaces); never fatal.
fn transcribe_and_emit_segment(
    events: &broadcast::Sender<Event>,
    speech: Option<&WhisperContext>,
    buffer: &[f32],
    t0_ms: u64,
    t1_ms: u64,
    transcript: &mut String,
) {
    let text = transcribe_slice(speech, buffer, t0_ms, t1_ms);
    if !text.is_empty() {
        if !transcript.is_empty() {
            transcript.push(' ');
        }
        transcript.push_str(&text);
    }
    emit_segment(events, &text, t0_ms, t1_ms);
}

/// Map a VAD `(t0_ms, t1_ms)` onto the 16 kHz mono buffer and transcribe that slice to
/// text. Returns `""` when no speech model is loaded, the slice is empty, or transcription
/// fails (logged) — the caller still emits the `segment` so its VAD timing surfaces.
fn transcribe_slice(speech: Option<&WhisperContext>, buffer: &[f32], t0_ms: u64, t1_ms: u64) -> String {
    let Some(ctx) = speech else {
        return String::new();
    };
    // 16 kHz mono: frame index = ms * 16. Clamp to the buffer (the trailing flush can
    // pass a `t1_ms` at/just past the buffer end).
    let start = (t0_ms as usize).saturating_mul(FRAMES_PER_MS).min(buffer.len());
    let end = (t1_ms as usize).saturating_mul(FRAMES_PER_MS).min(buffer.len());
    if end <= start {
        return String::new();
    }
    match transcribe_pcm(ctx, &buffer[start..end]) {
        Ok(text) => text,
        Err(e) => {
            log::warn!("dictation: segment transcription failed: {e}");
            String::new()
        }
    }
}

// ── Model wiring (Voice Transcription SF2 + SF3) ─────────────────────────────────

/// Fetch-on-demand + build the VAD [`VadChunker`] once on the consumer thread. Returns
/// `None` on ANY failure (download/verify, or model load) after emitting a descriptive
/// `error` event on the bus, so the caller degrades to vu-only — NEVER a panic.
///
/// Download `progress` is forwarded onto the bus reusing the existing `progress` event
/// (exactly as the whisper worker does on a model fetch); a verified cache hit emits
/// none. `use_gpu: false` matches the locked CPU VAD default (the speech path follows
/// `whisper::load_ctx`, GPU-first).
fn init_vad(events: &broadcast::Sender<Event>, threshold: f32, hangover_ms: u32) -> Option<VadChunker> {
    let ensured = match ensure_model(VAD_MODEL, |pct| {
        if let Ok(data) = serde_json::to_value(Progress { pct }) {
            let _ = events.send(Event { event: "progress".to_string(), data });
        }
    }) {
        Ok(m) => m,
        Err(ModelError::UnknownModel(n)) => {
            // A registry regression (the entry was removed) — surface it, don't panic.
            emit_error(events, "vad_init_failed", format!("vad model `{n}` not in registry"));
            return None;
        }
        Err(ModelError::Download(msg)) => {
            emit_error(events, "model_download_failed", msg);
            return None;
        }
    };

    match VadChunker::new(&ensured.path.to_string_lossy(), threshold, hangover_ms, false) {
        Ok(chunker) => Some(chunker),
        Err(e) => {
            emit_error(events, "vad_init_failed", format!("vad model load failed: {e}"));
            None
        }
    }
}

/// Fetch-on-demand + load the SPEECH [`WhisperContext`] once on the consumer thread
/// (SF3), mirroring `whisper::handle_load` (same `ensure_model` + `progress` forwarding +
/// `whisper::load_ctx` GPU-first selection). Returns `None` on ANY failure after emitting
/// an `error` — the session then streams `vu` + empty-text VAD `segment`s and still emits
/// the terminal `final`; the daemon NEVER panics on a model problem.
fn init_speech(events: &broadcast::Sender<Event>, model: &str, use_gpu: Option<bool>) -> Option<WhisperContext> {
    let ensured = match ensure_model(model, |pct| {
        if let Ok(data) = serde_json::to_value(Progress { pct }) {
            let _ = events.send(Event { event: "progress".to_string(), data });
        }
    }) {
        Ok(m) => m,
        Err(ModelError::UnknownModel(n)) => {
            emit_error(events, "bad_request", format!("unknown speech model `{n}` (not in the registry)"));
            return None;
        }
        Err(ModelError::Download(msg)) => {
            emit_error(events, "model_download_failed", msg);
            return None;
        }
    };

    match load_ctx_choice(&ensured.path, use_gpu) {
        Ok((ctx, backend)) => {
            log::info!("dictation: speech model `{model}` loaded (backend={backend})");
            Some(ctx)
        }
        Err(e) => {
            emit_error(events, "load_failed", format!("failed to load speech model `{model}`: {e}"));
            None
        }
    }
}

/// Run one VAD pass over the WHOLE accumulated 16 kHz buffer and return the segments that
/// newly finalized this pass (each returned exactly once via `cursor`). `is_final` (stop)
/// releases the held trailing segment regardless of the hangover horizon. A detect error
/// is logged + yields no segments (never fatal — `vu` and `final` still flow). The caller
/// transcribes + emits each returned segment.
fn vad_newly_finalized(
    chunker: &mut VadChunker,
    cursor: &mut EmitCursor,
    buffer: &[f32],
    is_final: bool,
) -> Vec<SegmentMs> {
    let segments = match chunker.detect(buffer) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("dictation: VAD detect failed: {e}");
            return Vec::new();
        }
    };
    // 16 kHz mono → ms: frames * 1000 / 16_000. The cursor's horizon math is in ms.
    let buffer_len_ms = (buffer.len() as u64 * 1000) / TARGET_RATE as u64;
    if is_final {
        cursor.flush(&segments)
    } else {
        cursor.newly_finalized(&segments, buffer_len_ms)
    }
}

/// Broadcast an `error` event with a snake_case code (also logged). Mirrors
/// `whisper::emit_error` — kept local so dictation has no cross-module coupling.
fn emit_error(events: &broadcast::Sender<Event>, code: &str, message: String) {
    log::warn!("dictation: error[{code}] {message}");
    if let Ok(data) = serde_json::to_value(ProtoError::new(code, message)) {
        let _ = events.send(Event { event: "error".to_string(), data });
    }
}
