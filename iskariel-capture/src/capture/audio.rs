//! System-audio capture (Step 6, Phase 1) — one desktop/game audio track.
//!
//! A PipeWire stream on its OWN dedicated thread + mainloop (NOT the video capture
//! loop). It taps the default sink's MONITOR (`stream.capture.sink=true`, untargeted
//! → WirePlumber autoconnects it and follows default-sink switches), pulls
//! interleaved F32LE / 2ch / 48 kHz, and appends each buffer to a per-clip
//! [`PcmBuffer`] anchored on raw `CLOCK_MONOTONIC` — the SAME clock the video PTS
//! fallback uses (`capture/mod.rs` + [`now_mono_ns`]) — so the save-time
//! [`cut_and_fill`] can align the audio to the video clip's T0/T_end.
//!
//! WHY A DEDICATED THREAD: the audio `process` callback must never be starved. On
//! the shared video mainloop it competed with the 60 Hz NVENC encode and dropped
//! buffers under game load (measured ~0.5% xruns → audible clicks). Its own thread
//! is otherwise idle, so the OS schedules it promptly and the tap never drops. The
//! [`PcmBuffer`] crosses the seam via `Arc<Mutex>`: only the audio thread writes it
//! during a clip; the reap path reads it only AFTER `into_pcm` has stopped + joined
//! the thread, so the two never contend.

#[cfg(target_os = "linux")]
use std::cell::Cell;
#[cfg(target_os = "linux")]
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
use pipewire as pw;
#[cfg(target_os = "linux")]
use pw::properties::properties;
#[cfg(target_os = "linux")]
use pw::spa;
#[cfg(target_os = "linux")]
use spa::pod::Pod;

use crate::daemon::socket::now_mono_ns;

/// The locked Phase-1 capture format. We REQUEST exactly this (the format pod sets
/// rate + channels), so the graph adapts the monitor to it and the save-time
/// ffmpeg's `-f f32le -ar 48000 -ac 2` always matches.
pub(crate) const RATE: u32 = 48_000;
pub(crate) const CHANNELS: u32 = 2;

/// One PipeWire audio buffer: its interleaved-f32 samples + the raw `CLOCK_MONOTONIC`
/// time of the FIRST sample (rate-corrected: `now − this buffer's duration`).
pub(crate) struct PcmChunk {
    pub anchor_ns: i64,
    /// Interleaved L,R,L,R… ([`CHANNELS`] samples per frame).
    pub samples: Vec<f32>,
}

/// Per-clip append buffer of captured audio. NOT a ring — Phase 1 records on demand
/// (start → stop); the rolling replay ring is Phase 2. ~0.38 MB/s, freed at reap.
#[derive(Default)]
pub(crate) struct PcmBuffer {
    pub chunks: Vec<PcmChunk>,
}

/// Handle to a live system-audio capture running on its own thread. `into_pcm`
/// (or `Drop`) quits the audio loop, joins the thread, and yields the final buffer.
#[cfg(target_os = "linux")]
pub(crate) struct AudioCapture {
    stop_tx: pw::channel::Sender<()>,
    join: Option<std::thread::JoinHandle<()>>,
    pcm: Arc<Mutex<PcmBuffer>>,
}

#[cfg(target_os = "linux")]
impl AudioCapture {
    /// Stop the audio thread (quit its loop + join) and hand back the final buffer.
    /// After this returns the thread is gone, so the caller may read `pcm` freely.
    #[allow(dead_code)]
    pub(crate) fn into_pcm(mut self) -> Arc<Mutex<PcmBuffer>> {
        self.shutdown();
        self.pcm.clone()
    }

    /// Non-destructively cut the captured PCM to `[t0_ns, t_end_ns]` — the audio
    /// thread keeps running (the continuous tap serves replay saves AND a
    /// record-while-armed finalize without being stopped). Phase 2.
    pub(crate) fn snapshot_window(&self, t0_ns: i64, t_end_ns: i64) -> Vec<u8> {
        let buf = self.pcm.lock().unwrap_or_else(|e| e.into_inner());
        cut_and_fill(&buf.chunks, t0_ns, t_end_ns)
    }

    /// `(captured_ns, span_ns)` audio health (reap log) without stopping the thread.
    pub(crate) fn stats_window(&self) -> (i64, i64) {
        let buf = self.pcm.lock().unwrap_or_else(|e| e.into_inner());
        capture_stats(&buf.chunks)
    }

    fn shutdown(&mut self) {
        let _ = self.stop_tx.send(()); // wake the audio loop → its receiver quits it
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Start the system-audio tap on a dedicated thread. Blocks until the stream has
/// connected (or failed) so the caller knows whether audio is live. Best-effort at
/// the call site: on `Err` the daemon records video-only (a silent clip beats no clip).
#[cfg(target_os = "linux")]
pub(crate) fn start() -> Result<AudioCapture, String> {
    let pcm: Arc<Mutex<PcmBuffer>> = Arc::new(Mutex::new(PcmBuffer::default()));
    let (stop_tx, stop_rx) = pw::channel::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let pcm_thread = pcm.clone();

    let join = std::thread::Builder::new()
        .name("iskariel-capture-audio".into())
        .spawn(move || audio_thread(pcm_thread, stop_rx, ready_tx))
        .map_err(|e| format!("spawn audio thread: {e}"))?;

    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(AudioCapture { stop_tx, join: Some(join), pcm }),
        Ok(Err(e)) => {
            let _ = join.join();
            Err(e)
        }
        Err(_) => {
            let _ = stop_tx.send(());
            let _ = join.join();
            Err("audio capture init timed out".into())
        }
    }
}

/// The dedicated audio-capture thread: its OWN PipeWire mainloop, the monitor-tap
/// stream, and a stop-receiver that quits the loop. All PipeWire objects are built
/// and dropped here (the `!Send` `Rc`/stream stay thread-local); only the
/// `Arc<Mutex<PcmBuffer>>`, the stop channel, and the ready channel cross the seam.
#[cfg(target_os = "linux")]
fn audio_thread(
    pcm: Arc<Mutex<PcmBuffer>>,
    stop_rx: pw::channel::Receiver<()>,
    ready_tx: mpsc::Sender<Result<(), String>>,
) {
    pw::init();

    macro_rules! bail {
        ($tx:expr, $e:expr) => {{
            let _ = $tx.send(Err($e));
            return;
        }};
    }

    let mainloop = match pw::main_loop::MainLoopRc::new(None) {
        Ok(m) => m,
        Err(e) => bail!(ready_tx, format!("audio mainloop: {e}")),
    };
    let context = match pw::context::ContextRc::new(&mainloop, None) {
        Ok(c) => c,
        Err(e) => bail!(ready_tx, format!("audio context: {e}")),
    };
    let core = match context.connect_rc(None) {
        Ok(c) => c,
        Err(e) => bail!(ready_tx, format!("audio connect: {e}")),
    };

    let logged = Cell::new(false);
    let p_pcm = pcm.clone();

    let stream = match pw::stream::StreamRc::new(
        core.clone(),
        "iskariel-capture-audio",
        properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Game",
            // Tap the default SINK's monitor (system/game output), not a source.
            *pw::keys::STREAM_CAPTURE_SINK => "true",
            // Big capture quantum so we never drag the game's audio quantum down.
            *pw::keys::NODE_LATENCY => "1024/48000",
        },
    ) {
        Ok(s) => s,
        Err(e) => bail!(ready_tx, format!("audio stream: {e}")),
    };

    let listener = stream
        .add_local_listener_with_user_data(())
        .state_changed(|_, _, old, new| log::info!("audio stream state: {old:?} -> {new:?}"))
        .param_changed(|_, _, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((mt, ms)) = spa::param::format_utils::parse_format(param) else { return };
            if mt != spa::param::format::MediaType::Audio
                || ms != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            let mut info = spa::param::audio::AudioInfoRaw::new();
            if info.parse(param).is_ok() {
                log::info!("audio negotiated: rate={} channels={}", info.rate(), info.channels());
                if info.rate() != RATE || info.channels() != CHANNELS {
                    log::warn!(
                        "audio format {}Hz/{}ch != requested {RATE}/{CHANNELS} — cut assumes the request",
                        info.rate(),
                        info.channels()
                    );
                }
            }
        })
        .process(move |stream, _| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let d = &mut datas[0];
            let size = d.chunk().size() as usize;
            if size == 0 {
                return;
            }
            let Some(bytes) = d.data() else { return };
            let n = (size / 4).min(bytes.len() / 4);
            if n == 0 {
                return;
            }
            if !logged.replace(true) {
                let name = std::thread::current().name().unwrap_or("?").to_string();
                log::info!("audio process on thread '{name}' (dedicated audio loop)");
            }
            let mut samples = Vec::with_capacity(n);
            for i in 0..n {
                let b = i * 4;
                samples.push(f32::from_le_bytes([bytes[b], bytes[b + 1], bytes[b + 2], bytes[b + 3]]));
            }
            // Rate-corrected anchor: time of the FIRST sample = now − this buffer's
            // duration (OBS/dimtpap pattern; a naive uncorrected `now` would lag).
            let frames = (n / CHANNELS as usize) as i64;
            let dur_ns = frames * 1_000_000_000 / RATE as i64;
            let anchor_ns = now_mono_ns() as i64 - dur_ns;
            if let Ok(mut g) = p_pcm.lock() {
                g.chunks.push(PcmChunk { anchor_ns, samples });
            }
        })
        .register();
    let listener = match listener {
        Ok(l) => l,
        Err(e) => bail!(ready_tx, format!("audio listener: {e}")),
    };

    // Request F32LE / 48k / 2ch explicitly (deterministic; see RATE/CHANNELS docs).
    let mut info = spa::param::audio::AudioInfoRaw::new();
    info.set_format(spa::param::audio::AudioFormat::F32LE);
    info.set_rate(RATE);
    info.set_channels(CHANNELS);
    let obj = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: spa::param::ParamType::EnumFormat.as_raw(),
        properties: info.into(),
    };
    let pod_bytes = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .expect("serialize audio format pod")
    .0
    .into_inner();
    let Some(pod) = Pod::from_bytes(&pod_bytes) else {
        bail!(ready_tx, "bad audio pod".to_string());
    };
    let mut params = [pod];

    // Untargeted (None) → WirePlumber autoconnects the default sink's monitor and
    // follows default-sink switches. No RT_PROCESS — this thread is dedicated and
    // never blocks, so the mainloop dispatch already services buffers promptly.
    if let Err(e) = stream.connect(
        spa::utils::Direction::Input,
        None,
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    ) {
        bail!(ready_tx, format!("audio connect stream: {e}"));
    }

    // Quit this loop when the capture thread sends `()` (clip stop / shutdown).
    let _stop_recv = stop_rx.attach(mainloop.loop_(), {
        let weak = mainloop.downgrade();
        move |()| {
            if let Some(ml) = weak.upgrade() {
                ml.quit();
            }
        }
    });

    log::info!("audio capture armed (system monitor, F32LE {RATE}/{CHANNELS}) on dedicated thread");
    let _ = ready_tx.send(Ok(()));
    mainloop.run(); // blocks until the stop receiver quits it

    // Teardown: disconnect before the stream/listener drop. `_stop_recv`, `listener`,
    // `core`, `context`, `mainloop` all drop as this scope exits.
    if let Err(e) = stream.disconnect() {
        log::warn!("audio stream disconnect: {e}");
    }
    let _ = listener;
}

// ===========================================================================
// Windows WASAPI loopback capture (Game Capture SF5).
// ===========================================================================
//
// Primary: PER-PROCESS loopback on the captured game's PID via
// `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_PARAMS`
// (PROCESS_LOOPBACK + INCLUDE_TARGET_PROCESS_TREE) → a clip carries ONLY the game's
// audio (event-driven). Fallback: on any activation failure (older Windows / API
// error) → whole-system ENDPOINT loopback (the default render endpoint with
// `AUDCLNT_STREAMFLAGS_LOOPBACK`, poll-driven, since render-endpoint loopback has no
// event mode). Both feed ONE drain loop that converts the delivered frames to the
// locked 48k/2ch f32le contract (process loopback already requests 48k/2ch float → a
// no-op; endpoint loopback resamples its mix format) and anchors each chunk on the QPC
// clock (`now_mono_ns`) — the SAME domain as the video PTS, so lip-sync holds. A
// double failure returns `Err` and the session records video-only.

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use windows::core::{Interface, Ref, HRESULT, IUnknown, PCWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
#[cfg(windows)]
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
#[cfg(windows)]
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

// Win32 flag values used by value (typed as plain u32/u16 to avoid newtype churn).
#[cfg(windows)]
const AUDCLNT_STREAMFLAGS_LOOPBACK: u32 = 0x0002_0000;
#[cfg(windows)]
const AUDCLNT_STREAMFLAGS_EVENTCALLBACK: u32 = 0x0004_0000;
#[cfg(windows)]
const AUDCLNT_BUFFERFLAGS_SILENT_BIT: u32 = 0x2;
#[cfg(windows)]
const VT_BLOB: u16 = 65;
#[cfg(windows)]
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

/// Handle to a live WASAPI loopback capture on its own thread. `into_pcm`/`Drop`
/// signals the thread to stop, joins it, and yields the final buffer.
#[cfg(windows)]
pub(crate) struct AudioCapture {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    pcm: Arc<Mutex<PcmBuffer>>,
}

#[cfg(windows)]
impl AudioCapture {
    /// Non-destructively cut the captured PCM to `[t0_ns, t_end_ns]` (the tap keeps
    /// running so a record-while-armed finalize + a replay save both read it).
    pub(crate) fn snapshot_window(&self, t0_ns: i64, t_end_ns: i64) -> Vec<u8> {
        let buf = self.pcm.lock().unwrap_or_else(|e| e.into_inner());
        cut_and_fill(&buf.chunks, t0_ns, t_end_ns)
    }

    /// `(captured_ns, span_ns)` audio health (reap log) without stopping the thread.
    pub(crate) fn stats_window(&self) -> (i64, i64) {
        let buf = self.pcm.lock().unwrap_or_else(|e| e.into_inner());
        capture_stats(&buf.chunks)
    }

    /// Stop the audio thread (signal + join) and hand back the final buffer.
    #[allow(dead_code)]
    pub(crate) fn into_pcm(mut self) -> Arc<Mutex<PcmBuffer>> {
        self.shutdown();
        self.pcm.clone()
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[cfg(windows)]
impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Start WASAPI loopback capture of process `pid` on a dedicated thread. Blocks until
/// the capture client is initialized (or both activation paths fail). Best-effort at
/// the call site: on `Err` the daemon records video-only.
#[cfg(windows)]
pub(crate) fn start(pid: u32) -> Result<AudioCapture, String> {
    let pcm: Arc<Mutex<PcmBuffer>> = Arc::new(Mutex::new(PcmBuffer::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let pcm_t = pcm.clone();
    let stop_t = stop.clone();

    let join = std::thread::Builder::new()
        .name("iskariel-capture-audio".into())
        .spawn(move || audio_thread_win(pid, pcm_t, stop_t, ready_tx))
        .map_err(|e| format!("spawn audio thread: {e}"))?;

    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => Ok(AudioCapture { stop, join: Some(join), pcm }),
        Ok(Err(e)) => {
            let _ = join.join();
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            let _ = join.join();
            Err("audio capture init timed out".into())
        }
    }
}

/// The captured source format (what the IAudioClient delivers). Process loopback is
/// always 48k/2ch float (we request it); endpoint loopback is the device mix format.
#[cfg(windows)]
struct SrcFormat {
    channels: u16,
    rate: u32,
    is_float: bool,
}

#[cfg(windows)]
impl SrcFormat {
    unsafe fn from_wfx(p: *const WAVEFORMATEX) -> SrcFormat {
        let w = &*p;
        // Mix formats are virtually always 32-bit float (plain IEEE_FLOAT or
        // EXTENSIBLE+IEEE_FLOAT subtype); a 32-bit width is the reliable float signal.
        let is_float = w.wFormatTag == WAVE_FORMAT_IEEE_FLOAT || w.wBitsPerSample == 32;
        SrcFormat { channels: w.nChannels.max(1), rate: w.nSamplesPerSec.max(1), is_float }
    }
}

/// One initialized + started capture client (process or endpoint loopback). `event` is
/// `Some` for event-driven process loopback, `None` for poll-driven endpoint loopback.
#[cfg(windows)]
struct CaptureSetup {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: Option<HANDLE>,
    fmt: SrcFormat,
}

/// The `IActivateAudioInterfaceCompletionHandler` for the async process-loopback
/// activation: it just signals a manual-reset event (stored as a raw `isize` so the
/// COM object is trivially `Send + Sync`). The async op carries the result; we read it
/// from the returned operation after the event fires.
#[cfg(windows)]
#[windows::core::implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateHandler {
    done_raw: isize,
}

#[cfg(windows)]
impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateHandler_Impl {
    fn ActivateCompleted(
        &self,
        _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        // SAFETY: `done_raw` is a live manual-reset event handle for the lifetime of
        // the activation; SetEvent on it from this MTA callback is thread-safe.
        unsafe {
            let _ = SetEvent(HANDLE(self.done_raw as *mut core::ffi::c_void));
        }
        Ok(())
    }
}

/// PROPVARIANT laid out for a VT_BLOB (x64 layout: vt @0, 3×WORD reserved, then the
/// BLOB union at offset 8 — `cbSize` @8, `pBlobData` @16). Built directly and cast to
/// `*const PROPVARIANT` for `ActivateAudioInterfaceAsync` (the windows-rs PROPVARIANT
/// union is awkward to populate; only the ABI layout matters here).
#[cfg(windows)]
#[repr(C)]
struct PropVariantBlob {
    vt: u16,
    r1: u16,
    r2: u16,
    r3: u16,
    cb_size: u32,
    _pad: u32,
    p_blob_data: *mut core::ffi::c_void,
}

/// A 48k/2ch 32-bit-float `WAVEFORMATEX` — the format process loopback delivers.
#[cfg(windows)]
fn make_float_wfx(rate: u32, channels: u16) -> WAVEFORMATEX {
    let bits = 32u16;
    let block = channels * (bits / 8);
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: channels,
        nSamplesPerSec: rate,
        nAvgBytesPerSec: rate * block as u32,
        nBlockAlign: block,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}

/// Activate an `IAudioClient` for per-process loopback on `pid` (+ its process tree).
#[cfg(windows)]
fn activate_process_loopback(pid: u32) -> Result<IAudioClient, String> {
    // Manual-reset completion event; the handler signals it from an MTA thread.
    let done = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
        .map_err(|e| format!("CreateEventW(activation): {e}"))?;
    let handler: IActivateAudioInterfaceCompletionHandler =
        ActivateHandler { done_raw: done.0 as isize }.into();

    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS::default();
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.Anonymous.ProcessLoopbackParams = AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        TargetProcessId: pid,
        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    };
    let pv = PropVariantBlob {
        vt: VT_BLOB,
        r1: 0,
        r2: 0,
        r3: 0,
        cb_size: core::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        _pad: 0,
        p_blob_data: &mut params as *mut _ as *mut core::ffi::c_void,
    };
    let pv_ptr = &pv as *const PropVariantBlob as *const PROPVARIANT;

    let op = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(pv_ptr),
            &handler,
        )
    }
    .map_err(|e| format!("ActivateAudioInterfaceAsync: {e}"))?;

    let waited = unsafe { WaitForSingleObject(done, 2000) };
    unsafe {
        let _ = CloseHandle(done);
    }
    if waited != WAIT_OBJECT_0 {
        return Err("process-loopback activation timed out".into());
    }

    let mut hr = HRESULT(0);
    let mut unknown: Option<IUnknown> = None;
    unsafe { op.GetActivateResult(&mut hr, &mut unknown) }
        .map_err(|e| format!("GetActivateResult: {e}"))?;
    hr.ok().map_err(|e| format!("activation result: {e}"))?;
    unknown
        .ok_or_else(|| "activation returned no interface".to_string())?
        .cast::<IAudioClient>()
        .map_err(|e| format!("cast IAudioClient: {e}"))
}

/// Set up per-process loopback: activate → init (48k/2ch float, event-driven) → start.
#[cfg(windows)]
fn setup_process_loopback(pid: u32) -> Result<CaptureSetup, String> {
    let client = activate_process_loopback(pid)?;
    let wfx = make_float_wfx(RATE, CHANNELS as u16);
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            2_000_000, // 200 ms buffer (100 ns units)
            0,
            &wfx as *const WAVEFORMATEX,
            None,
        )
    }
    .map_err(|e| format!("Initialize(process loopback): {e}"))?;

    let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
        .map_err(|e| format!("CreateEventW(capture): {e}"))?;
    unsafe { client.SetEventHandle(event) }.map_err(|e| format!("SetEventHandle: {e}"))?;
    let capture = unsafe { client.GetService::<IAudioCaptureClient>() }
        .map_err(|e| format!("GetService(capture): {e}"))?;
    unsafe { client.Start() }.map_err(|e| format!("Start: {e}"))?;

    Ok(CaptureSetup {
        client,
        capture,
        event: Some(event),
        fmt: SrcFormat { channels: CHANNELS as u16, rate: RATE, is_float: true },
    })
}

/// Set up endpoint (whole-system) loopback: default render endpoint → init at its mix
/// format (poll-driven; render-endpoint loopback has no event mode) → start.
#[cfg(windows)]
fn setup_endpoint_loopback() -> Result<CaptureSetup, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| format!("CoCreateInstance(enumerator): {e}"))?;
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|e| format!("GetDefaultAudioEndpoint: {e}"))?;
    let client = unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) }
        .map_err(|e| format!("Activate(IAudioClient): {e}"))?;
    let fmt_ptr = unsafe { client.GetMixFormat() }.map_err(|e| format!("GetMixFormat: {e}"))?;
    let fmt = unsafe { SrcFormat::from_wfx(fmt_ptr) };
    let init = unsafe {
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt_ptr, None)
    };
    unsafe { CoTaskMemFree(Some(fmt_ptr as *const core::ffi::c_void)) };
    init.map_err(|e| format!("Initialize(endpoint loopback): {e}"))?;

    let capture = unsafe { client.GetService::<IAudioCaptureClient>() }
        .map_err(|e| format!("GetService(capture): {e}"))?;
    unsafe { client.Start() }.map_err(|e| format!("Start: {e}"))?;

    Ok(CaptureSetup { client, capture, event: None, fmt })
}

/// Try per-process loopback; on failure fall back to endpoint loopback.
#[cfg(windows)]
fn setup_capture(pid: u32) -> Result<CaptureSetup, String> {
    match setup_process_loopback(pid) {
        Ok(s) => {
            log::info!("audio: per-process WASAPI loopback on PID {pid} (48k/2ch float)");
            return Ok(s);
        }
        Err(e) => log::warn!("audio: per-process loopback failed ({e}) — falling back to endpoint loopback"),
    }
    let s = setup_endpoint_loopback()?;
    log::info!(
        "audio: endpoint (whole-system) WASAPI loopback — {}Hz/{}ch{}",
        s.fmt.rate,
        s.fmt.channels,
        if s.fmt.rate != RATE { " (resampling to 48k)" } else { "" }
    );
    Ok(s)
}

/// Extract one WASAPI buffer to interleaved 48k/2ch f32 (the locked contract): map to
/// stereo (mono → duplicate, surround → first two channels), reading float or int16
/// samples, then linear-resample to 48 kHz if the source rate differs (a no-op for the
/// common 48 kHz case). A SILENT-flagged buffer yields the right count of zeros.
#[cfg(windows)]
fn extract_stereo_48k(data: *const u8, frames: u32, fmt: &SrcFormat, silent: bool) -> Vec<f32> {
    let src_ch = fmt.channels as usize;
    let n = frames as usize;
    let mut stereo: Vec<f32> = Vec::with_capacity(n * 2);
    if silent || data.is_null() || src_ch == 0 {
        stereo.resize(n * 2, 0.0);
    } else {
        let bps = if fmt.is_float { 4 } else { 2 };
        let frame_bytes = bps * src_ch;
        for f in 0..n {
            let base = f * frame_bytes;
            let read = |ch: usize| -> f32 {
                let off = base + ch * bps;
                // SAFETY: WASAPI guarantees `frames * frame_bytes` valid bytes at `data`.
                unsafe {
                    if fmt.is_float {
                        (data.add(off) as *const f32).read_unaligned()
                    } else {
                        (data.add(off) as *const i16).read_unaligned() as f32 / 32768.0
                    }
                }
            };
            let l = read(0);
            let r = if src_ch == 1 { l } else { read(1) };
            stereo.push(l);
            stereo.push(r);
        }
    }
    if fmt.rate == RATE {
        stereo
    } else {
        resample_stereo(&stereo, fmt.rate, RATE)
    }
}

/// Linear-resample an interleaved-stereo f32 buffer from `src_rate` to `dst_rate`.
#[cfg(windows)]
fn resample_stereo(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    let in_frames = input.len() / 2;
    if in_frames == 0 {
        return Vec::new();
    }
    let out_frames = ((in_frames as u64 * dst_rate as u64) / src_rate.max(1) as u64) as usize;
    let mut out = Vec::with_capacity(out_frames * 2);
    let ratio = src_rate as f64 / dst_rate as f64;
    for i in 0..out_frames {
        let pos = i as f64 * ratio;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let i0 = idx.min(in_frames - 1);
        let i1 = (idx + 1).min(in_frames - 1);
        for ch in 0..2 {
            let a = input[i0 * 2 + ch];
            let b = input[i1 * 2 + ch];
            out.push(a + (b - a) * frac);
        }
    }
    out
}

/// The Windows audio-capture thread: COM-init (MTA), set up loopback (process →
/// endpoint fallback), then drain packets into the shared `PcmBuffer` until stopped.
#[cfg(windows)]
fn audio_thread_win(
    pid: u32,
    pcm: Arc<Mutex<PcmBuffer>>,
    stop: Arc<AtomicBool>,
    ready_tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    // SAFETY: standard COM init; the WASAPI activation handler needs an MTA apartment.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let setup = match setup_capture(pid) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    let _ = ready_tx.send(Ok(()));

    let mut logged = false;
    let nspf_out = 1_000_000_000i64 / RATE as i64;
    while !stop.load(Ordering::SeqCst) {
        match setup.event {
            // Event-driven (process loopback): wake on a filled buffer, 200 ms cap so
            // the stop flag is still polled if the game goes silent.
            Some(ev) => {
                let _ = unsafe { WaitForSingleObject(ev, 200) };
            }
            // Poll-driven (endpoint loopback): a short sleep between drains.
            None => std::thread::sleep(std::time::Duration::from_millis(10)),
        }

        // Drain every queued packet.
        loop {
            let packet = match unsafe { setup.capture.GetNextPacketSize() } {
                Ok(p) => p,
                Err(_) => break,
            };
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            if unsafe {
                setup
                    .capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
            }
            .is_err()
            {
                break;
            }
            if frames > 0 {
                if !logged {
                    logged = true;
                    log::info!("audio: first WASAPI packet ({} frames)", frames);
                }
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT_BIT != 0;
                let samples = extract_stereo_48k(data as *const u8, frames, &setup.fmt, silent);
                let out_frames = (samples.len() / 2) as i64;
                if out_frames > 0 {
                    // Rate-corrected anchor: first-sample time = now − this buffer's dur.
                    let anchor_ns = now_mono_ns() as i64 - out_frames * nspf_out;
                    if let Ok(mut g) = pcm.lock() {
                        g.chunks.push(PcmChunk { anchor_ns, samples });
                    }
                }
            }
            let _ = unsafe { setup.capture.ReleaseBuffer(frames) };
        }
    }

    // Teardown: stop the client; the COM objects drop as this scope exits.
    unsafe {
        let _ = setup.client.Stop();
    }
}

/// A gap between where we've emitted to and a chunk's anchor LARGER than this is a
/// real discontinuity (device switch, suspend, long xrun) → silence-fill it to hold
/// sync. Smaller deltas are per-buffer anchor JITTER (the `now_mono_ns()` stamp is
/// taken at callback entry, which wobbles a few ms) — so we CONCATENATE buffers
/// contiguously (capture audio is a continuous stream) and only break on a real gap.
const DISCONTINUITY_FRAMES: i64 = 2400; // 50 ms @ 48 kHz

/// Cut the captured PCM to the video clip window `[t0_ns, t_end_ns]`, returning
/// interleaved-f32 little-endian bytes ready for the PCM input (`-f f32le`).
///
/// Buffers are concatenated CONTIGUOUSLY (not stamped per-anchor — see
/// [`DISCONTINUITY_FRAMES`]); the first chunk is head-cut so its first emitted sample
/// is T0; the stream is tail-cut / silence-padded to exactly span the window; and a
/// real (>50 ms) anchor gap is silence-filled to re-sync across it. Empty `chunks`
/// (audio never arrived) → full-length silence, so the muxed track always spans the
/// clip and lip-sync holds end to end.
pub(crate) fn cut_and_fill(chunks: &[PcmChunk], t0_ns: i64, t_end_ns: i64) -> Vec<u8> {
    let ch = CHANNELS as i64;
    let nspf = ns_per_frame();
    let total_frames = round_div((t_end_ns - t0_ns).max(0), nspf).max(0);
    let mut out: Vec<f32> = Vec::with_capacity((total_frames * ch).max(0) as usize);
    let mut emitted: i64 = 0; // frames written to `out` (== out.len() / ch)

    for c in chunks {
        let frames = c.samples.len() as i64 / ch;
        if frames == 0 {
            continue;
        }
        let chunk_start = c.anchor_ns;
        let chunk_end = chunk_start + frames * nspf;
        if chunk_end <= t0_ns {
            continue; // entirely before T0
        }
        if chunk_start >= t_end_ns {
            break; // entirely after T_end
        }
        // Silence-fill ONLY a real (large) gap from where we've emitted to; small
        // jitter and overlaps are ignored so buffers join seamlessly.
        let gap = round_div(chunk_start - t0_ns, nspf) - emitted;
        if gap > DISCONTINUITY_FRAMES {
            let fill = gap.min(total_frames - emitted).max(0);
            out.extend(std::iter::repeat(0.0).take((fill * ch) as usize));
            emitted += fill;
        }
        // Head-cut the first emitted chunk's lead that precedes T0 (audio arms before
        // the first video packet, so the opening chunk usually starts before T0).
        let skip = if emitted == 0 && chunk_start < t0_ns {
            round_div(t0_ns - chunk_start, nspf).clamp(0, frames)
        } else {
            0
        };
        // Tail-cut: never exceed the clip window.
        let take = (frames - skip).min(total_frames - emitted).max(0);
        if take > 0 {
            let s = (skip * ch) as usize;
            let e = ((skip + take) * ch) as usize;
            out.extend_from_slice(&c.samples[s..e.min(c.samples.len())]);
            emitted += take;
        }
        if emitted >= total_frames {
            break;
        }
    }
    // Tail silence: audio stopped before video, or none at all → pad to full length.
    if emitted < total_frames {
        out.extend(std::iter::repeat(0.0).take(((total_frames - emitted) * ch) as usize));
    }

    let mut bytes = Vec::with_capacity(out.len() * 4);
    for s in out {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

/// `(captured_ns, span_ns)` — total sample duration vs the wall span from the first
/// buffer's anchor to the last buffer's end. `span − captured` ≈ audio dropped to
/// starvation (xruns). With the dedicated thread this should be ~0; logged at reap.
pub(crate) fn capture_stats(chunks: &[PcmChunk]) -> (i64, i64) {
    if chunks.is_empty() {
        return (0, 0);
    }
    let nspf = ns_per_frame();
    let frames = |c: &PcmChunk| c.samples.len() as i64 / CHANNELS as i64;
    let captured: i64 = chunks.iter().map(|c| frames(c) * nspf).sum();
    let first = chunks[0].anchor_ns;
    let last = &chunks[chunks.len() - 1];
    let span = (last.anchor_ns + frames(last) * nspf) - first;
    (captured, span)
}

#[inline]
fn ns_per_frame() -> i64 {
    1_000_000_000 / RATE as i64
}

#[inline]
fn round_div(num: i64, den: i64) -> i64 {
    if den == 0 {
        return 0;
    }
    (num + den / 2) / den
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(anchor_ns: i64, frames: usize, val: f32) -> PcmChunk {
        PcmChunk { anchor_ns, samples: vec![val; frames * CHANNELS as usize] }
    }
    fn frames_of(bytes: &[u8]) -> i64 {
        (bytes.len() / 4 / CHANNELS as usize) as i64
    }
    fn frame_val(bytes: &[u8], frame: usize) -> f32 {
        let b = frame * CHANNELS as usize * 4;
        f32::from_le_bytes([bytes[b], bytes[b + 1], bytes[b + 2], bytes[b + 3]])
    }

    // SF2 acceptance: an induced 200 ms stall yields a gap-filled, in-sync clip.
    #[test]
    fn stall_is_silence_filled_and_in_sync() {
        let nspf = ns_per_frame();
        let chunk_frames = RATE as usize / 10; // 100 ms
        let dur = chunk_frames as i64 * nspf;
        let stall_ns = 200 * 1_000_000; // 200 ms stall
        let t0 = 1_000_000_000;
        let a = chunk(t0, chunk_frames, 1.0);
        let b_anchor = t0 + dur + stall_ns;
        let b = chunk(b_anchor, chunk_frames, 1.0);
        let t_end = b_anchor + dur;

        let out = cut_and_fill(&[a, b], t0, t_end);
        assert_eq!(frames_of(&out), round_div(t_end - t0, nspf), "spans T0..T_end exactly");

        assert_eq!(frame_val(&out, 0), 1.0);
        assert_eq!(frame_val(&out, chunk_frames - 1), 1.0);
        let stall_frames = round_div(stall_ns, nspf);
        assert_eq!(frame_val(&out, chunk_frames + (stall_frames / 2) as usize), 0.0, "stall gap-filled");
        let b_start = chunk_frames + stall_frames as usize;
        assert_eq!(frame_val(&out, b_start + 1), 1.0);
    }

    #[test]
    fn head_cut_drops_pre_t0_audio() {
        let nspf = ns_per_frame();
        let chunk_frames = RATE as usize / 10;
        let dur = chunk_frames as i64 * nspf;
        let t0 = 1_000_000_000;
        let anchor = t0 - dur / 2; // starts 50 ms before T0
        let c = chunk(anchor, chunk_frames, 0.5);
        let t_end = anchor + dur; // ends 50 ms after T0
        let out = cut_and_fill(&[c], t0, t_end);
        assert_eq!(frames_of(&out), round_div(t_end - t0, nspf));
        assert_eq!(frame_val(&out, 0), 0.5, "first surviving frame is real audio, not silence");
    }

    #[test]
    fn tail_cut_truncates_at_t_end() {
        let nspf = ns_per_frame();
        let chunk_frames = RATE as usize / 5; // 200 ms
        let dur = chunk_frames as i64 * nspf;
        let t0 = 1_000_000_000;
        let c = chunk(t0, chunk_frames, 0.9);
        let t_end = t0 + dur / 2; // cut the chunk in half
        let out = cut_and_fill(&[c], t0, t_end);
        let frames = round_div(t_end - t0, nspf);
        assert_eq!(frames_of(&out), frames, "truncated at T_end");
        assert_eq!(frame_val(&out, 0), 0.9);
        assert_eq!(frame_val(&out, (frames - 1) as usize), 0.9, "last kept frame is real");
    }

    #[test]
    fn empty_chunks_yield_full_silence() {
        let nspf = ns_per_frame();
        let t0 = 5_000_000_000;
        let t_end = t0 + 1_000_000_000; // 1 s
        let out = cut_and_fill(&[], t0, t_end);
        assert_eq!(frames_of(&out), round_div(t_end - t0, nspf));
        assert!(out.iter().all(|&b| b == 0), "all silence");
    }
}
