//! Standalone Voice Activity Detection (Voice Transcription, SF2).
//!
//! A thin wrapper over whisper-rs 0.16's built-in VAD (`WhisperVadContext` →
//! whisper.cpp's bundled Silero). It owns ONE loaded VAD context and runs detection
//! over a 16 kHz mono `f32` buffer, returning speech segments as `(t0_ms, t1_ms)`
//! pairs. It is deliberately ignorant of everything around it: no `cpal` (it takes a
//! `&[f32]` someone else captured), no daemon / wire-event knowledge (the caller maps
//! segments onto the `segment` protocol arm), and no model-registry knowledge — it
//! receives a model PATH plus tuning params (the SF3 download/cache helper fetches +
//! verifies the model and hands the resolved path in).
//!
//! ## Lifecycle
//! Build a [`VadChunker`] ONCE on `start_dictation` (the VAD model loads here, exactly
//! like the resident speech model) and reuse it across ticks — never reconstruct
//! per-tick. The underlying handle is a heap pointer freed in `Drop`
//! (`whisper_vad_free`), and `WhisperVadContext` is `Send + Sync`, so the chunker can
//! be moved onto / owned by the dictation consumer thread.
//!
//! ## Concurrency
//! Detection takes `&mut self` (whisper-rs's detect methods are `&mut`), so the owner
//! needs exclusive mutable access — own it on one thread, or `Mutex` it. Segments are
//! converted to plain `i64`/`u64` ms before returning, so the non-`Send`
//! `WhisperVadSegments` handle never leaves the producing thread.
//!
//! ## Segment time unit (the one conversion trap)
//! whisper.cpp's VAD segment timestamps come back in **centiseconds** (10s of ms) per
//! the binding's documented contract (`whisper_vad.rs` doc comments at L261/270/299/302
//! and `WhisperVadSegment::{start,end}`). We multiply by 10 to reach milliseconds. This
//! is the SAME factor the sibling full-transcription path already uses for whisper
//! segment timestamps (`whisper.rs` L245-246: `seg.start_timestamp() * 10`), which is
//! corroborating evidence the factor is right.
//!
//! VERIFY-AT-RUNTIME: this is the single load-bearing unknown that source can't settle.
//! Emit a known ~3 s utterance — if `t1_ms - t0_ms ≈ 3000`, the ×10 (centiseconds)
//! factor is correct. If the delta is ≈30000 the raw values were already ms (factor
//! must become ×1); if ≈300 they were seconds×100 mislabeled (still ×10). Pin the
//! factor empirically on first real capture; default to ×10.

use std::os::raw::c_int;

use whisper_rs::{
    WhisperError, WhisperVadContext, WhisperVadContextParams, WhisperVadParams,
};

/// Hard cap on a single VAD segment, in seconds. whisper.cpp splits any utterance
/// longer than this at a silence point >98 ms, so a 35 s utterance comes back as
/// (30 s) + (5 s) rather than one 35 s blob — bounding downstream transcription cost
/// and latency. Locked by the SF2 contract.
pub const MAX_SEGMENT_SECONDS: f32 = 30.0;

/// whisper.cpp VAD segment timestamps are centiseconds (10s of ms); ×10 → ms.
/// See the module header's VERIFY-AT-RUNTIME note — this is the load-bearing factor.
const CENTISECONDS_TO_MS: f32 = 10.0;

/// Default speech-probability threshold when the caller passes `None`
/// (`StartDictationArgs.vad_threshold` default). Matches whisper-rs's own default.
pub const DEFAULT_THRESHOLD: f32 = 0.5;

/// Default hangover (min trailing silence to END a segment) in ms when the caller
/// passes `None` (`StartDictationArgs.hangover_ms` default). Maps to
/// `WhisperVadParams.min_silence_duration_ms`.
pub const DEFAULT_HANGOVER_MS: u32 = 300;

/// A speech segment, in milliseconds from the start of the buffer fed to detection.
/// `t1_ms >= t0_ms`. The protocol's `segment` event carries exactly these two values
/// (with `text: ""` this SF — VAD only, no transcription).
pub type SegmentMs = (u64, u64);

/// Owns a loaded VAD context plus the detection params. Build once on
/// `start_dictation`, reuse across ticks.
///
/// `WhisperVadContext` is `Send + Sync`, so this whole struct is `Send` — move it onto
/// the dictation consumer thread the same way the resident speech context is handled.
#[derive(Debug)]
pub struct VadChunker {
    ctx: WhisperVadContext,
    params: WhisperVadParams,
}

impl VadChunker {
    /// Load the VAD model at `model_path` and bake in the detection params.
    ///
    /// - `threshold` → `WhisperVadParams.threshold` (speech-probability cutoff; the
    ///   caller resolves `StartDictationArgs.vad_threshold.unwrap_or(DEFAULT_THRESHOLD)`).
    /// - `hangover_ms` → `WhisperVadParams.min_silence_duration_ms` (trailing silence
    ///   required to close a segment; resolve `hangover_ms.unwrap_or(DEFAULT_HANGOVER_MS)`).
    /// - `use_gpu` → `WhisperVadContextParams.use_gpu` (the locked sidecar default is
    ///   CPU, i.e. `false`; pass `cfg!(feature = "vulkan")` to follow the speech path).
    ///
    /// Segment length is capped at [`MAX_SEGMENT_SECONDS`] here; all other VAD params
    /// keep whisper-rs's defaults (`min_speech_duration_ms` 250, `speech_pad_ms` 30,
    /// `samples_overlap` 0.1 s).
    ///
    /// # Errors
    /// Returns [`WhisperError::NullPointer`] if the model fails to load (whisper.cpp's
    /// `whisper_vad_init_from_file_with_params` returned null — bad/missing/corrupt
    /// model file). `model_path` must not contain an interior NUL byte (whisper-rs
    /// `.expect`s on that — the SF3 cache always hands a clean path).
    pub fn new(
        model_path: &str,
        threshold: f32,
        hangover_ms: u32,
        use_gpu: bool,
    ) -> Result<Self, WhisperError> {
        let mut cparams = WhisperVadContextParams::new(); // n_threads=4, gpu_device=0
        cparams.set_use_gpu(use_gpu);

        let ctx = WhisperVadContext::new(model_path, cparams)?;

        let mut params = WhisperVadParams::new();
        params.set_threshold(threshold);
        // `min_silence_duration` is the hangover: how long silence must persist before
        // a segment is considered ended. c_int == i32; cap at i32::MAX so a huge value
        // can't wrap negative.
        params.set_min_silence_duration(hangover_ms.min(i32::MAX as u32) as c_int);
        // 30 s split boundary (whisper.cpp does the actual split at a silence point).
        params.set_max_speech_duration(MAX_SEGMENT_SECONDS);

        Ok(Self { ctx, params })
    }

    /// Run the full VAD pipeline over a 16 kHz mono `f32` buffer and return EVERY
    /// detected speech segment as `(t0_ms, t1_ms)`.
    ///
    /// A pure-silence buffer yields an empty `Vec` — the caller then emits ZERO
    /// `segment` events, satisfying the "never feed silence downstream" contract.
    /// Timestamps are relative to the start of `samples` (so the caller offsets them by
    /// the buffer's absolute start when emitting against a running stream).
    ///
    /// # Errors
    /// Returns [`WhisperError`] if the underlying pipeline fails
    /// (`segments_from_samples` returns only `NullPointer`).
    pub fn detect(&mut self, samples: &[f32]) -> Result<Vec<SegmentMs>, WhisperError> {
        // Empty input → no work, no segments. (whisper.cpp would just produce nothing,
        // but short-circuiting avoids a needless FFI round-trip on idle ticks.)
        if samples.is_empty() {
            return Ok(Vec::new());
        }

        // `WhisperVadParams` is `Copy`, so passing it by value per call is free and
        // leaves `self.params` intact for the next tick.
        let segments = self.ctx.segments_from_samples(self.params, samples)?;

        // Convert + drop the non-Send `WhisperVadSegments` handle on THIS thread.
        let out = segments
            .map(|seg| (cs_to_ms(seg.start), cs_to_ms(seg.end)))
            .collect();
        Ok(out)
    }
}

/// Centiseconds (whisper.cpp VAD unit) → milliseconds, clamped non-negative.
/// See the module header's VERIFY-AT-RUNTIME note for the unit rationale.
#[inline]
fn cs_to_ms(centiseconds: f32) -> u64 {
    (centiseconds * CENTISECONDS_TO_MS).round().max(0.0) as u64
}

// ── Finalization policy ─────────────────────────────────────────────────────────
//
// POLICY (lives here so the daemon stays dumb): detection over a *growing* buffer
// re-reports the same segments every tick, plus the in-progress tail. We must emit each
// finalized segment EXACTLY ONCE. A segment counts as **finalized** when:
//
//   1. its end has been confirmed by enough trailing silence, AND
//   2. we haven't already emitted it.
//
// (1) is approximated against the current buffer length: a segment whose end is at
// least `hangover_ms` before the buffer's end has, by definition, been followed by at
// least `hangover_ms` of audio that VAD did NOT extend it into — so its boundary is
// settled and won't move on later ticks. The trailing segment (within `hangover_ms` of
// the buffer end) is still "open": more speech could extend it, so we hold it back until
// a future tick pushes it past the hangover horizon (or `flush` releases it on stop).
//
// (2) is tracked by `emitted`, a count of segments already released. Detection returns
// segments in start order and earlier boundaries don't change once finalized, so a
// monotonic count is a sufficient cursor: everything at index `< emitted` is already out.
//
// This keeps state to a single `usize`. The caller owns it and feeds it back in.

/// Tracks how many leading segments have already been emitted, so the same segment is
/// never sent twice across ticks. The caller holds one of these per dictation stream
/// and persists it between detection ticks.
///
/// Construct with [`EmitCursor::new`], then on each tick call
/// [`EmitCursor::newly_finalized`] with the freshly-detected segments + the current
/// buffer length; on stop, call [`EmitCursor::flush`] to release the still-open tail.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmitCursor {
    /// Number of segments (from the front) already emitted.
    emitted: usize,
    /// The hangover horizon (ms): a segment whose end is this far before the buffer end
    /// is considered finalized. Mirrors the chunker's `min_silence_duration_ms`.
    hangover_ms: u64,
}

impl EmitCursor {
    /// New cursor with nothing emitted yet. `hangover_ms` should match the value passed
    /// to [`VadChunker::new`] (resolve `None` to [`DEFAULT_HANGOVER_MS`]).
    pub fn new(hangover_ms: u32) -> Self {
        Self { emitted: 0, hangover_ms: hangover_ms as u64 }
    }

    /// Given ALL segments from the latest [`VadChunker::detect`] and the current
    /// buffer length in ms, return the slice of segments that are newly finalized this
    /// tick (in order, never re-emitting an earlier one) and advance the cursor.
    ///
    /// A segment is released when its `t1_ms + hangover_ms <= buffer_len_ms` (its end is
    /// past the hangover horizon) AND it sits at or beyond the emit cursor. Because
    /// finalized boundaries are stable and segments come back in start order, this walks
    /// from `emitted` forward and stops at the first not-yet-settled (open) segment.
    ///
    /// Returns owned `(t0_ms, t1_ms)` pairs ready to drop onto the `segment` arm with
    /// `text: ""`.
    pub fn newly_finalized(
        &mut self,
        segments: &[SegmentMs],
        buffer_len_ms: u64,
    ) -> Vec<SegmentMs> {
        let horizon = buffer_len_ms.saturating_sub(self.hangover_ms);
        let mut out = Vec::new();
        // Only consider segments at/after the cursor; earlier ones already went out.
        for &(t0, t1) in segments.iter().skip(self.emitted) {
            // First still-open segment ends the run: its boundary may still move, and
            // every later segment is even closer to the buffer end (start-ordered).
            if t1 > horizon {
                break;
            }
            out.push((t0, t1));
            self.emitted += 1;
        }
        out
    }

    /// On stop / final flush, release any segments not yet emitted regardless of the
    /// hangover horizon — the stream has ended, so the trailing segment's boundary is
    /// final too. Pass the same `segments` slice from the last [`VadChunker::detect`].
    pub fn flush(&mut self, segments: &[SegmentMs]) -> Vec<SegmentMs> {
        let out: Vec<SegmentMs> = segments.iter().skip(self.emitted).copied().collect();
        self.emitted = segments.len();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cs_to_ms_multiplies_by_ten_and_clamps() {
        assert_eq!(cs_to_ms(300.0), 3000); // ~3 s utterance → 3000 ms (the ×10 check)
        assert_eq!(cs_to_ms(0.0), 0);
        assert_eq!(cs_to_ms(-5.0), 0); // negatives clamp to 0
        assert_eq!(cs_to_ms(12.4), 124);
    }

    #[test]
    fn finalized_holds_open_tail_then_releases_on_horizon() {
        // Two segments; buffer is 5000 ms long; hangover 300 ms → horizon = 4700 ms.
        let segs = vec![(100u64, 1500u64), (2000u64, 4900u64)];
        let mut cur = EmitCursor::new(300);

        // First tick: seg0 (ends 1500, well before 4700) is finalized; seg1 (ends 4900,
        // past the 4700 horizon) is still open → held.
        let out = cur.newly_finalized(&segs, 5000);
        assert_eq!(out, vec![(100, 1500)]);

        // Same segments, buffer grew to 5500 ms → horizon 5200; seg1 now settled.
        let out = cur.newly_finalized(&segs, 5500);
        assert_eq!(out, vec![(2000, 4900)]);

        // Nothing left to emit.
        assert!(cur.newly_finalized(&segs, 6000).is_empty());
    }

    #[test]
    fn flush_releases_remaining_tail() {
        let segs = vec![(0u64, 1000u64), (2000u64, 4900u64)];
        let mut cur = EmitCursor::new(300);
        // Only seg0 finalized normally (seg1 within hangover of the 5000 ms buffer end).
        assert_eq!(cur.newly_finalized(&segs, 5000), vec![(0, 1000)]);
        // Stop → flush releases the held tail.
        assert_eq!(cur.flush(&segs), vec![(2000, 4900)]);
        assert!(cur.flush(&segs).is_empty());
    }

    #[test]
    fn empty_segments_emit_nothing() {
        let mut cur = EmitCursor::new(300);
        assert!(cur.newly_finalized(&[], 5000).is_empty());
        assert!(cur.flush(&[]).is_empty());
    }
}
