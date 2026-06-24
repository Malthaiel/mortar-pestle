//! Sample-rate conversion, channel downmix, and RMS for the dictation capture
//! path. Pure DSP — this module owns **no** cpal device, **no** whisper, and no
//! daemon/event-bus knowledge. It takes native-rate f32 capture chunks (whatever
//! geometry `mic.rs` produces) and yields the locked audio contract: **16 kHz,
//! mono, f32 in [-1.0, 1.0]**.
//!
//! Phase 2. Two public surfaces:
//!   1. [`Resampler16k`] — stateful native_rate/native_channels → 16 kHz mono
//!      converter. Feed arbitrary-length interleaved (or single-channel) f32
//!      chunks via [`Resampler16k::push`]; it downmixes, buffers to the FFT
//!      resampler's fixed block size, and appends 16 kHz mono frames to an
//!      internal accumulator drained by [`Resampler16k::take`] / read via
//!      [`Resampler16k::buffer`].
//!   2. [`rms`] — RMS of an f32 slice, for the `vu` meter event.
//!
//! rubato note: [`FftFixedIn`] consumes **exactly** `input_frames_next()` frames
//! per `process` call and emits a *variable* (possibly zero) number of output
//! frames, buffering the remainder internally — the right shape for "feed fixed
//! chunks, drain variable output". Verified against rubato 0.15.0 source
//! (`synchro.rs:556-660`, `lib.rs:222-260`).
#![allow(dead_code)] // `take`/`len`/`is_empty` are public API for SF3's incremental drain.

use rubato::{FftFixedIn, ResampleError, Resampler, ResamplerConstructionError};

/// The locked output sample rate of the whisper audio contract.
pub const TARGET_RATE: usize = 16_000;

/// Input frames per resampler block (mono, native rate). ~43 ms at 48 kHz —
/// large enough that the FFT block cost is amortized, small enough that `push`
/// latency stays well under one `vu` frame.
const CHUNK_SIZE_IN: usize = 2048;

/// Desired internal FFT sub-chunks per block. One block per `process` call.
const SUB_CHUNKS: usize = 1;

/// Native-rate → 16 kHz mono resampler.
///
/// Downmixes to mono **before** resampling (a linear op preceding the linear
/// anti-alias filter — numerically equivalent to post-downmix up to rounding,
/// but runs a single channel through the FFT instead of N). Accumulates output
/// internally; the caller drains it on its own cadence (per-chunk for the WAV
/// dump, periodically for the `vu` meter).
pub struct Resampler16k {
    resampler: FftFixedIn<f32>,
    /// Mono native-rate frames awaiting a full `CHUNK_SIZE_IN` block.
    pending: Vec<f32>,
    /// Pre-allocated, non-interleaved process output (one inner Vec per channel;
    /// here exactly one — mono). Reused every call to avoid per-chunk heap churn.
    out_scratch: Vec<Vec<f32>>,
    /// Accumulated 16 kHz mono output, drained via [`take`](Self::take).
    accumulated: Vec<f32>,
    native_channels: u16,
}

impl Resampler16k {
    /// Build a resampler for `native_rate` Hz input with `native_channels`
    /// interleaved channels. `native_channels` is clamped to ≥ 1.
    ///
    /// # Errors
    /// Returns [`ResamplerConstructionError`] if rubato rejects the parameters —
    /// in practice only when `native_rate == 0` (`InvalidSampleRate`).
    pub fn new(
        native_rate: u32,
        native_channels: u16,
    ) -> Result<Self, ResamplerConstructionError> {
        // rubato runs a single (mono) channel; we downmix upstream of it.
        let resampler = FftFixedIn::<f32>::new(
            native_rate as usize, // sample_rate_input
            TARGET_RATE,          // sample_rate_output
            CHUNK_SIZE_IN,        // chunk_size_in (frames per process call)
            SUB_CHUNKS,
            1, // nbr_channels — mono
        )?;

        let out_scratch = resampler.output_buffer_allocate(true);
        Ok(Self {
            resampler,
            pending: Vec::new(),
            out_scratch,
            accumulated: Vec::new(),
            native_channels: native_channels.max(1),
        })
    }

    /// Feed one native-rate capture chunk.
    ///
    /// `samples` is interleaved across `native_channels` when `native_channels
    /// > 1`, or a flat mono buffer when `native_channels == 1` — i.e. exactly
    /// what cpal hands the data callback. Downmixes to mono, buffers to the
    /// resampler's fixed block size, runs as many full blocks as are ready, and
    /// appends the 16 kHz mono result to the internal accumulator.
    ///
    /// # Errors
    /// Propagates any [`ResampleError`] from rubato (none expected in steady
    /// state for valid fixed-size input).
    pub fn push(&mut self, samples: &[f32]) -> Result<(), ResampleError> {
        self.downmix_into_pending(samples);

        let need = self.resampler.input_frames_next(); // == CHUNK_SIZE_IN (constant)
        while self.pending.len() >= need {
            let block: Vec<f32> = self.pending.drain(..need).collect();
            let input: [&[f32]; 1] = [&block];
            // Zero-alloc path: reuse out_scratch; (consumed, produced) returned.
            let (_consumed, produced) =
                self.resampler.process_into_buffer(&input, &mut self.out_scratch, None)?;
            // out_scratch[0] holds `produced` valid frames at the front.
            self.accumulated.extend_from_slice(&self.out_scratch[0][..produced]);
        }
        Ok(())
    }

    /// Average interleaved channels down to mono and append to `pending`.
    fn downmix_into_pending(&mut self, samples: &[f32]) {
        let ch = self.native_channels as usize;
        if ch == 1 {
            self.pending.extend_from_slice(samples);
            return;
        }
        let frames = samples.len() / ch;
        self.pending.reserve(frames);
        for f in 0..frames {
            let base = f * ch;
            let sum: f32 = samples[base..base + ch].iter().copied().sum();
            self.pending.push(sum / ch as f32);
        }
    }

    /// Borrow the accumulated 16 kHz mono buffer without draining it.
    pub fn buffer(&self) -> &[f32] {
        &self.accumulated
    }

    /// Drain and return all accumulated 16 kHz mono frames produced so far,
    /// leaving the accumulator empty.
    pub fn take(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.accumulated)
    }

    /// Number of 16 kHz mono frames currently accumulated.
    pub fn len(&self) -> usize {
        self.accumulated.len()
    }

    /// Whether the accumulator is empty.
    pub fn is_empty(&self) -> bool {
        self.accumulated.is_empty()
    }
}

/// Root-mean-square of an f32 slice. Returns `0.0` for an empty slice. Used for
/// the `vu` meter event level.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|&s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_empty_is_zero() {
        assert_eq!(rms(&[]), 0.0);
    }

    #[test]
    fn rms_dc_equals_magnitude() {
        // RMS of a constant 0.5 signal is 0.5.
        assert!((rms(&[0.5; 100]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn rms_full_scale_sine_is_root_half() {
        // RMS of a unit-amplitude sine ≈ 1/sqrt(2) ≈ 0.7071.
        let n = 16_000usize;
        let sig: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / n as f32).sin())
            .collect();
        assert!((rms(&sig) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-3);
    }

    #[test]
    fn downmix_stereo_averages_channels() {
        // L=1.0, R=0.0 interleaved → mono 0.5 each frame. Drive a LONG stream so
        // the FFT resampler's cold-overlap warmup (output ramps from zero over
        // the first ~half block) is negligible, then measure the STEADY-STATE
        // mean over the tail — which must equal the 0.5 downmix DC level.
        let mut r = Resampler16k::new(48_000, 2).unwrap();
        // ~1 s of 48 kHz stereo: 48_000 frames = 96_000 interleaved samples.
        let stereo: Vec<f32> = (0..48_000).flat_map(|_| [1.0f32, 0.0f32]).collect();
        r.push(&stereo).unwrap();
        assert!(r.len() > 1000, "expected substantial resampled output");
        // Mean over the second half (steady state, past the filter warmup).
        let out = r.buffer();
        let tail = &out[out.len() / 2..];
        let mean: f32 = tail.iter().copied().sum::<f32>() / tail.len() as f32;
        assert!((mean - 0.5).abs() < 0.01, "downmix DC drifted: {mean}");
    }

    #[test]
    fn mono_passthrough_resamples() {
        let mut r = Resampler16k::new(48_000, 1).unwrap();
        let mono = vec![0.25f32; 4096];
        r.push(&mono).unwrap();
        assert!(r.len() > 0);
    }

    #[test]
    fn variable_chunk_sizes_buffer_correctly() {
        // Feed odd-sized chunks; the resampler must buffer across pushes.
        let mut r = Resampler16k::new(44_100, 1).unwrap();
        for _ in 0..10 {
            r.push(&vec![0.1f32; 777]).unwrap(); // 7770 frames total, not a block multiple
        }
        assert!(r.len() > 0);
    }

    #[test]
    fn take_drains_accumulator() {
        let mut r = Resampler16k::new(48_000, 1).unwrap();
        r.push(&vec![0.3f32; 8192]).unwrap();
        let first = r.take();
        assert!(!first.is_empty());
        assert!(r.is_empty(), "take should leave accumulator empty");
    }
}
