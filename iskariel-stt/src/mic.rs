//! cpal microphone capture — and *only* mic capture.
//!
//! Voice Transcription epic, Phase 2 SF1. This module owns opening the default
//! input device, normalizing every sample format to `f32` in `[-1.0, 1.0]`, and
//! streaming native-rate interleaved frames (plus the device geometry) to a
//! consumer. Resampling to the 16 kHz mono whisper audio contract, channel
//! downmix, RMS/`vu` computation, and the gate WAV dump all live in
//! `resample.rs` and the daemon engine — *not here*.
//!
//! ## Threading model (load-bearing)
//!
//! The cpal `Stream` is **not `Send`** and **stops capturing when dropped**. It
//! must be built, `.play()`-ed, and kept alive on a single dedicated thread, and
//! dropped on that same thread. So [`MicCapture::open`] spawns one owner thread
//! that:
//!   1. opens the default input device + reads its default config,
//!   2. hands the open result (geometry, or a [`MicError`]) back to the caller
//!      over a one-shot channel so `open()` can return synchronously and the
//!      daemon can map a failure to `error{code:"no_input_device"}` *before*
//!      acking,
//!   3. builds + plays the stream, then parks until told to stop,
//!   4. drops the stream (stopping capture) and exits.
//!
//! The data callback itself runs on cpal's own internal high-priority audio
//! thread; the owner thread only holds the handle alive. Normalized frames flow
//! out over the [`std::sync::mpsc`] `Sender` the caller supplies. Stopping is a
//! flag flip + unpark + join via [`MicHandle::stop`]; the handle also stops the
//! stream on `Drop`, so a dropped handle never leaks the capture thread.
#![allow(dead_code)] // `AudioChunk` geometry fields document chunks for SF2/SF3 consumers.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
// `Sample` provides the `f32::from_sample(x)` associated fn — the normalization
// path that maps every integer/float format to f32 in [-1.0, 1.0] (re-exported
// from `dasp_sample`; it carries the `FromSample` bound internally).
use cpal::{Sample, SampleFormat, StreamConfig};

/// One block of capture audio, normalized to `f32` and tagged with the geometry
/// the consumer needs to resample without ever touching the cpal device.
///
/// `samples` is **interleaved** native-rate `f32` in `[-1.0, 1.0]`, length
/// `frames * channels`. `sample_rate` / `channels` are the device-native values
/// (typically 48 kHz, 1–2 ch) and are constant for the lifetime of one capture.
#[derive(Debug, Clone)]
pub struct AudioChunk {
    /// Interleaved f32 samples in `[-1.0, 1.0]`; `len == frames * channels`.
    pub samples: Vec<f32>,
    /// Device-native channel count (interleave stride).
    pub channels: u16,
    /// Device-native sample rate in Hz.
    pub sample_rate: u32,
}

/// Why opening the mic failed. The daemon maps **every** variant to the protocol
/// `error{code:"no_input_device"}` (with this `Display` as the message); the
/// distinction is for logging, never for crashing.
#[derive(Debug)]
pub enum MicError {
    /// `default_input_device()` returned `None` — no capture device at all.
    NoInputDevice,
    /// The device exists but `default_input_config()` failed.
    DefaultConfig(cpal::DefaultStreamConfigError),
    /// The device + config are fine but `build_input_stream` failed.
    BuildStream(cpal::BuildStreamError),
    /// `stream.play()` failed.
    Play(cpal::PlayStreamError),
    /// The owner thread died before reporting its open result.
    ThreadGone,
}

impl fmt::Display for MicError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MicError::NoInputDevice => f.write_str("no default input device available"),
            MicError::DefaultConfig(e) => write!(f, "no default input config: {e}"),
            MicError::BuildStream(e) => write!(f, "failed to build input stream: {e}"),
            MicError::Play(e) => write!(f, "failed to start input stream: {e}"),
            MicError::ThreadGone => f.write_str("mic capture thread exited before reporting status"),
        }
    }
}

impl std::error::Error for MicError {}

impl MicError {
    /// The protocol `error.code` for this open failure (Phase 2 SF3). A missing device
    /// or a config-probe failure ⇒ `no_input_device` (no usable capture device); a
    /// build/play failure on an enumerated device ⇒ `device_busy` (most often another
    /// process holds the input exclusively, or it vanished mid-open). The `Display`
    /// message carries the backend detail in every case.
    pub fn code(&self) -> &'static str {
        match self {
            MicError::NoInputDevice | MicError::DefaultConfig(_) | MicError::ThreadGone => {
                "no_input_device"
            }
            MicError::BuildStream(_) | MicError::Play(_) => "device_busy",
        }
    }
}

/// Native device geometry, reported back from a successful [`MicCapture::open`].
#[derive(Debug, Clone, Copy)]
pub struct MicFormat {
    /// Device-native sample rate in Hz (e.g. `48000`).
    pub sample_rate: u32,
    /// Device-native channel count (e.g. `1` or `2`).
    pub channels: u16,
    /// The hardware sample format that is being normalized to f32.
    pub sample_format: SampleFormat,
}

/// Live handle to a running capture. Keeps the cpal `Stream` alive on its owner
/// thread; dropping the handle (or calling [`stop`](MicHandle::stop)) stops the
/// stream and joins the thread.
pub struct MicHandle {
    /// Native device geometry, surfaced for the consumer / resampler.
    pub format: MicFormat,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MicHandle {
    /// Native sample rate in Hz (convenience accessor).
    pub fn sample_rate(&self) -> u32 {
        self.format.sample_rate
    }

    /// Native channel count (convenience accessor).
    pub fn channels(&self) -> u16 {
        self.format.channels
    }

    /// Stop capture: flip the stop flag, unpark the owner thread (which drops the
    /// cpal `Stream`, stopping capture), and join it. Idempotent — a second call
    /// is a no-op. The consumer sees its `Receiver` close once all `Sender`s are
    /// dropped, and finishes draining.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            handle.thread().unpark();
            // The owner thread only parks; join returns promptly once unparked.
            let _ = handle.join();
        }
    }
}

impl Drop for MicHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Entry point: open the default input device and stream normalized frames.
pub struct MicCapture;

impl MicCapture {
    /// Open the default input device and start streaming [`AudioChunk`]s to
    /// `frames_tx`. Returns once the device is open (a few ms) with a
    /// [`MicHandle`] carrying the native geometry, or a [`MicError`] the caller
    /// maps to `error{code:"no_input_device"}` — **this never panics or crashes**
    /// on a missing/unopenable device.
    ///
    /// `frames_tx` is the consumer end of the audio pipeline (the daemon's
    /// resample/`vu` loop). Frames stop arriving when the handle is stopped or
    /// dropped; the consumer should drain until the channel closes.
    pub fn open(frames_tx: Sender<AudioChunk>) -> Result<MicHandle, MicError> {
        let stop = Arc::new(AtomicBool::new(false));
        // One-shot channel to hand the open result back from the owner thread so
        // `open()` can return synchronously (and the daemon can ack or error
        // before any frames flow). SyncSender(1) so the send never blocks.
        let (ready_tx, ready_rx): (
            SyncSender<Result<MicFormat, MicError>>,
            std::sync::mpsc::Receiver<Result<MicFormat, MicError>>,
        ) = std::sync::mpsc::sync_channel(1);

        let stop_thread = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("iskariel-stt-mic".into())
            .spawn(move || mic_thread(frames_tx, stop_thread, ready_tx))
            .map_err(|_| MicError::ThreadGone)?;

        // Block only until the device is opened (or open failed).
        match ready_rx.recv() {
            Ok(Ok(format)) => Ok(MicHandle {
                format,
                stop,
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                // Owner thread reported failure and is exiting; join to reap it.
                let _ = thread.join();
                Err(e)
            }
            // Sender dropped without a value: the thread panicked/exited early.
            Err(_) => {
                let _ = thread.join();
                Err(MicError::ThreadGone)
            }
        }
    }
}

/// The dedicated owner thread: open device, report status, build+play, park
/// until stop, then drop the stream (stopping capture) on this thread.
fn mic_thread(
    frames_tx: Sender<AudioChunk>,
    stop: Arc<AtomicBool>,
    ready_tx: SyncSender<Result<MicFormat, MicError>>,
) {
    let host = cpal::default_host();

    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            let _ = ready_tx.send(Err(MicError::NoInputDevice));
            return;
        }
    };

    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(MicError::DefaultConfig(e)));
            return;
        }
    };

    let format = MicFormat {
        sample_rate: supported.sample_rate().0,
        channels: supported.channels(),
        sample_format: supported.sample_format(),
    };
    // `cfg.into()` ≡ `cfg.config()` → buffer_size: BufferSize::Default.
    let config: StreamConfig = supported.into();

    let stream = match build_capture_stream(&device, &config, format, frames_tx) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(MicError::BuildStream(e)));
            return;
        }
    };

    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(MicError::Play(e)));
        return; // `stream` drops here, on this thread.
    }

    // Device is live — report success so `open()` can return.
    if ready_tx.send(Ok(format)).is_err() {
        // Caller hung up (e.g. open() aborted): nothing to capture for; bail and
        // drop the stream.
        return;
    }

    // Keep the stream alive on THIS thread until asked to stop. cpal runs the
    // data callback on its own high-priority thread; we only hold the handle.
    while !stop.load(Ordering::Relaxed) {
        std::thread::park_timeout(Duration::from_millis(100));
    }
    drop(stream); // stops capture, on the thread that built it.
}

/// Build an input stream for the device's sample format, normalizing every
/// supported format to `f32` in `[-1.0, 1.0]` via `dasp_sample::from_sample`
/// (which handles mid-range origins for unsigned formats correctly, so we never
/// hand-roll `(x - 32768)/32768`). `SampleFormat` is `#[non_exhaustive]`, so the
/// match has a mandatory catch-all.
fn build_capture_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    format: MicFormat,
    frames_tx: Sender<AudioChunk>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    let err_fn = |e: cpal::StreamError| eprintln!("iskariel-stt: cpal stream error: {e}");
    let (channels, sample_rate) = (format.channels, format.sample_rate);

    // Generic data-callback factory: &[T] → normalized interleaved f32, pushed
    // out as an AudioChunk. Each closure is `FnMut(&[T], &InputCallbackInfo)`.
    macro_rules! make_cb {
        ($t:ty) => {{
            let tx = frames_tx.clone();
            move |data: &[$t], _: &cpal::InputCallbackInfo| {
                let mut samples = Vec::with_capacity(data.len());
                for &s in data {
                    samples.push(f32::from_sample(s));
                }
                // Consumer gone (stop in progress) → silently drop the chunk.
                let _ = tx.send(AudioChunk {
                    samples,
                    channels,
                    sample_rate,
                });
            }
        }};
    }

    match format.sample_format {
        // The three formats named in the contract.
        SampleFormat::F32 => {
            device.build_input_stream::<f32, _, _>(config, make_cb!(f32), err_fn, None)
        }
        SampleFormat::I16 => {
            device.build_input_stream::<i16, _, _>(config, make_cb!(i16), err_fn, None)
        }
        SampleFormat::U16 => {
            device.build_input_stream::<u16, _, _>(config, make_cb!(u16), err_fn, None)
        }
        // Other formats cpal may hand back — `from_sample` normalizes them too,
        // so handle them rather than fail (f32::from_sample on f32/f64 is a
        // harmless identity/cast).
        SampleFormat::I8 => {
            device.build_input_stream::<i8, _, _>(config, make_cb!(i8), err_fn, None)
        }
        SampleFormat::I32 => {
            device.build_input_stream::<i32, _, _>(config, make_cb!(i32), err_fn, None)
        }
        SampleFormat::I64 => {
            device.build_input_stream::<i64, _, _>(config, make_cb!(i64), err_fn, None)
        }
        SampleFormat::U8 => {
            device.build_input_stream::<u8, _, _>(config, make_cb!(u8), err_fn, None)
        }
        SampleFormat::U32 => {
            device.build_input_stream::<u32, _, _>(config, make_cb!(u32), err_fn, None)
        }
        SampleFormat::U64 => {
            device.build_input_stream::<u64, _, _>(config, make_cb!(u64), err_fn, None)
        }
        SampleFormat::F64 => {
            device.build_input_stream::<f64, _, _>(config, make_cb!(f64), err_fn, None)
        }
        // `#[non_exhaustive]` catch-all: a format this cpal build added that we
        // don't know about. Refuse cleanly instead of crashing.
        other => {
            eprintln!("iskariel-stt: unsupported sample format: {other}");
            Err(cpal::BuildStreamError::StreamConfigNotSupported)
        }
    }
}
