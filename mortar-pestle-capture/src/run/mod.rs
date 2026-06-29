//! `run` — the Phase-1 capture → encode loop + the Stage E proof harness.
//!
//! `mortar-pestle-capture run --dump-es <path.h264> --duration <secs>` captures the
//! display, hardware-encodes it (CBR 50 Mbps H.264, B-frames-off, 2 s forced-IDR),
//! writes the raw elementary stream, and prints + logs the budget stats (active
//! buffer path, delivered-vs-CFR fps, ms/frame p50/p99, RSS, VRAM) the Encode gate
//! is judged on. `mortar-pestle-capture decode-proof <es> <mp4>` shells ffmpeg to remux
//! the ES into a viewable MP4 (color/tearing eyeball = the subsumed B2/B3 verdicts).

use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io::{BufWriter, Read};
#[cfg(target_os = "linux")]
use std::process::{Command, ExitCode};
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

use crate::capture::replay_ring::ReplayRing;
#[cfg(target_os = "linux")]
use crate::capture::{CaptureSession, EncodeParams};

/// Sink for capture output — driven on the capture thread only (no `Send`/`Sync`).
/// Implemented below by [`Recorder`] (ES/FIFO write + stats) and [`TeeSink`] (ring
/// + recorder fanout). The Linux `capture::build_clip` and the Windows daemon pacer
/// both call it; it lives here (not in `capture`) so it stays cross-platform — the
/// Windows `capture` backend has no trait of its own.
pub trait FrameSink {
    /// A filled capture frame arrived (delivery-rate + dmabuf/SHM path diagnostics).
    fn on_arrival(&mut self, dmabuf: bool, monotonic_pts_ns: i64);
    /// One encoded packet was produced at a CFR tick.
    fn on_packet(
        &mut self,
        data: &[u8],
        keyframe: bool,
        cfr_index: u64,
        monotonic_pts_ns: i64,
        encode_ns: u128,
    );
}

// Phase-1 codec table (Encode Engine.md): CBR 50 Mbps @ 60 fps, 2 s forced-IDR.
#[cfg(target_os = "linux")]
const BITRATE_BPS: u32 = 50_000_000;
#[cfg(target_os = "linux")]
const GOP_LEN: u32 = 120;
#[cfg(target_os = "linux")]
const FPS_NUM: u32 = 60;
#[cfg(target_os = "linux")]
const FPS_DEN: u32 = 1;
#[cfg(target_os = "linux")]
const DEFAULT_DURATION_SECS: u64 = 600;

/// Records the encoded ES to disk and accumulates the budget stats.
///
/// Reused verbatim by the daemon (`daemon::engine`) as the per-clip `FifoSink`:
/// it writes the temp `.h264` and, via the small read-only accessors below,
/// surfaces the per-clip metadata the `saved` event needs (T0/T_end from the
/// **packet** `monotonic_pts_ns` per spec, plus the packet count). The accessors
/// are pure reads and add nothing to the `run` stats harness's behavior.
#[cfg_attr(windows, allow(dead_code))] // stats fields are read only by the Linux `run` report
pub(crate) struct Recorder {
    /// Encoded-ES sink. A file for the `run` CLI; the daemon's per-clip mux FIFO
    /// writer otherwise. `finish()` drops it (closing a FIFO → ffmpeg sees EOF).
    out: Option<Box<dyn Write>>,
    es_bytes: u64,
    arrivals: u64,
    shm_arrivals: u64,
    packets: u64,
    keyframes: u64,
    encode_ns: Vec<u128>,
    last_pts: Option<i64>,
    max_gap_ns: i64,
    min_pts: Option<i64>,
    max_pts: i64,
    /// First/last encoded-packet `monotonic_pts_ns` — T0/T_end per the `SavedClip`
    /// contract (the daemon reads these; the `run` report does not).
    first_packet_pts_ns: Option<i64>,
    last_packet_pts_ns: Option<i64>,
}

impl Recorder {
    #[cfg(target_os = "linux")]
    pub(crate) fn new(es_path: &str) -> Result<Self, String> {
        let file = File::create(es_path).map_err(|e| format!("create ES {es_path}: {e}"))?;
        Ok(Self::with_writer(Box::new(BufWriter::new(file))))
    }

    /// Tee encoded packets into an arbitrary writer — the daemon's mux FIFO. The
    /// `run` CLI uses [`new`] (a plain file); the daemon supplies the FIFO writer.
    pub(crate) fn with_writer(out: Box<dyn Write>) -> Self {
        Self {
            out: Some(out),
            es_bytes: 0,
            arrivals: 0,
            shm_arrivals: 0,
            packets: 0,
            keyframes: 0,
            encode_ns: Vec::new(),
            last_pts: None,
            max_gap_ns: 0,
            min_pts: None,
            max_pts: 0,
            first_packet_pts_ns: None,
            last_packet_pts_ns: None,
        }
    }

    pub(crate) fn finish(&mut self) {
        if let Some(w) = self.out.as_mut() {
            let _ = w.flush();
        }
        // Drop the writer: a FIFO write end closing is the mux ffmpeg's EOF signal.
        self.out = None;
    }

    /// T0 — the first encoded packet's `monotonic_pts_ns` (`None` if no packet
    /// was ever produced). Per spec this is the first `on_packet` stamp, NOT the
    /// first arrival pts.
    pub(crate) fn first_packet_pts_ns(&self) -> Option<i64> {
        self.first_packet_pts_ns
    }

    /// T_end — the last encoded packet's `monotonic_pts_ns`.
    pub(crate) fn last_packet_pts_ns(&self) -> Option<i64> {
        self.last_packet_pts_ns
    }

    /// Number of encoded packets written (0 ⇒ the clip captured nothing).
    pub(crate) fn packet_count(&self) -> u64 {
        self.packets
    }
}

impl FrameSink for Recorder {
    fn on_arrival(&mut self, dmabuf: bool, monotonic_pts_ns: i64) {
        self.arrivals += 1;
        if !dmabuf {
            self.shm_arrivals += 1;
        }
        if let Some(prev) = self.last_pts {
            let gap = monotonic_pts_ns - prev;
            if gap > self.max_gap_ns {
                self.max_gap_ns = gap;
            }
        }
        self.last_pts = Some(monotonic_pts_ns);
        self.min_pts.get_or_insert(monotonic_pts_ns);
        self.max_pts = monotonic_pts_ns.max(self.max_pts);
    }

    fn on_packet(
        &mut self,
        data: &[u8],
        keyframe: bool,
        _cfr_index: u64,
        monotonic_pts_ns: i64,
        encode_ns: u128,
    ) {
        if let Some(w) = self.out.as_mut() {
            let _ = w.write_all(data);
        }
        self.es_bytes += data.len() as u64;
        self.packets += 1;
        if keyframe {
            self.keyframes += 1;
        }
        self.encode_ns.push(encode_ns);
        // T0/T_end for the daemon's `saved` event (the `run` report ignores these).
        self.first_packet_pts_ns.get_or_insert(monotonic_pts_ns);
        self.last_packet_pts_ns = Some(monotonic_pts_ns);
    }
}

/// Multiplexing [`FrameSink`] for the encode-on-arm tee (Phase 2, R1): one NVENC
/// session fans each packet to whichever consumers are attached — the in-RAM
/// replay [`ReplayRing`] (while armed) and/or the live-recording [`Recorder`]
/// (while recording). Either or both may be present; attaching/detaching a
/// consumer is a field toggle on the capture thread, so a manual recording and
/// the replay ring run off ONE encode without rebuilding the capture session.
/// Wired into `build_clip`'s `sink` slot by the daemon in the R1b engine rewiring.
#[allow(dead_code)] // consumers attached by daemon::engine in R1b; until then unused.
pub(crate) struct TeeSink {
    ring: Option<Rc<RefCell<ReplayRing>>>,
    recorder: Option<Rc<RefCell<Recorder>>>,
}

#[allow(dead_code)]
impl TeeSink {
    pub(crate) fn new() -> Self {
        Self { ring: None, recorder: None }
    }
    /// Attach the replay ring (on `arm`). Subsequent packets are pushed to it.
    pub(crate) fn attach_ring(&mut self, ring: Rc<RefCell<ReplayRing>>) {
        self.ring = Some(ring);
    }
    /// Detach the ring (on `disarm`); it stops receiving packets.
    pub(crate) fn detach_ring(&mut self) {
        self.ring = None;
    }
    /// Attach a live recorder (on `start_clip`). Packets also tee to its FIFO.
    pub(crate) fn attach_recorder(&mut self, rec: Rc<RefCell<Recorder>>) {
        self.recorder = Some(rec);
    }
    /// Detach the recorder (on `stop_clip`), handing it back so the caller can
    /// flush its FIFO + finalize the mux. The ring (if any) keeps filling.
    pub(crate) fn detach_recorder(&mut self) -> Option<Rc<RefCell<Recorder>>> {
        self.recorder.take()
    }
    /// True while at least one consumer is attached — the capture session must run.
    pub(crate) fn has_consumers(&self) -> bool {
        self.ring.is_some() || self.recorder.is_some()
    }
}

impl FrameSink for TeeSink {
    fn on_arrival(&mut self, dmabuf: bool, monotonic_pts_ns: i64) {
        // Only the recorder tracks arrival stats; the ring stores encoded packets.
        if let Some(rec) = &self.recorder {
            rec.borrow_mut().on_arrival(dmabuf, monotonic_pts_ns);
        }
    }

    fn on_packet(
        &mut self,
        data: &[u8],
        keyframe: bool,
        cfr_index: u64,
        monotonic_pts_ns: i64,
        encode_ns: u128,
    ) {
        // Ring first (one copy into its Arc); then tee the same bytes to the live
        // recorder's FIFO. Order is irrelevant — independent consumers.
        if let Some(ring) = &self.ring {
            ring.borrow_mut()
                .push(data.to_vec(), monotonic_pts_ns, cfr_index, keyframe);
        }
        if let Some(rec) = &self.recorder {
            rec.borrow_mut()
                .on_packet(data, keyframe, cfr_index, monotonic_pts_ns, encode_ns);
        }
    }
}

#[cfg(test)]
mod tee_tests {
    use super::*;

    fn pkt(tee: &mut TeeSink, idr: bool, cfr: u64) {
        tee.on_packet(&[0u8; 16], idr, cfr, 1_000_000_000 + cfr as i64 * 16_666_666, 0);
    }

    #[test]
    fn tee_fans_to_attached_consumers_only() {
        let ring = Rc::new(RefCell::new(ReplayRing::new(usize::MAX, 3600)));
        let rec = Rc::new(RefCell::new(Recorder::with_writer(Box::new(std::io::sink()))));
        let mut tee = TeeSink::new();
        tee.attach_ring(ring.clone());
        tee.attach_recorder(rec.clone());

        // Both attached → both receive.
        pkt(&mut tee, true, 0);
        pkt(&mut tee, false, 1);
        pkt(&mut tee, false, 2);
        assert_eq!(ring.borrow().len(), 3);
        assert_eq!(rec.borrow().packet_count(), 3);

        // Detach ring → only the recorder advances.
        tee.detach_ring();
        pkt(&mut tee, true, 3);
        assert_eq!(ring.borrow().len(), 3, "ring frozen after detach");
        assert_eq!(rec.borrow().packet_count(), 4);

        // Re-attach ring, detach recorder → only the ring advances.
        tee.attach_ring(ring.clone());
        assert!(tee.detach_recorder().is_some());
        pkt(&mut tee, true, 4);
        assert_eq!(ring.borrow().len(), 4);
        assert_eq!(rec.borrow().packet_count(), 4, "recorder frozen after detach");
        assert!(tee.has_consumers());
    }
}
/// can prove stability across the whole run (not just an end-of-run snapshot).
#[cfg(target_os = "linux")]
#[derive(Default)]
struct ResourceSamples {
    rss_kb_min: u64,
    rss_kb_max: u64,
    vram_mib_min: u64,
    vram_mib_max: u64,
    vram_seen: bool,
    n: u64,
}

#[cfg(target_os = "linux")]
impl ResourceSamples {
    fn record(&mut self, rss_kb: Option<u64>, vram_mib: Option<u64>) {
        self.n += 1;
        if let Some(r) = rss_kb {
            if self.rss_kb_min == 0 || r < self.rss_kb_min {
                self.rss_kb_min = r;
            }
            self.rss_kb_max = self.rss_kb_max.max(r);
        }
        if let Some(v) = vram_mib {
            self.vram_seen = true;
            if self.vram_mib_min == 0 || v < self.vram_mib_min {
                self.vram_mib_min = v;
            }
            self.vram_mib_max = self.vram_mib_max.max(v);
        }
    }
}

/// Entry point for `mortar-pestle-capture run`.
#[cfg(target_os = "linux")]
pub fn run(args: &[String]) -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut es_path: Option<String> = None;
    let mut duration_secs = DEFAULT_DURATION_SECS;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dump-es" => es_path = it.next().cloned(),
            "--duration" => {
                if let Some(v) = it.next().and_then(|s| s.parse::<u64>().ok()) {
                    duration_secs = v;
                }
            }
            other => log::warn!("ignoring unknown arg {other:?}"),
        }
    }
    let Some(es_path) = es_path else {
        eprintln!("usage: mortar-pestle-capture run --dump-es <path.h264> [--duration <secs>]");
        return ExitCode::from(2);
    };

    let recorder = match Recorder::new(&es_path) {
        Ok(r) => Rc::new(RefCell::new(r)),
        Err(e) => {
            eprintln!("mortar-pestle-capture: {e}");
            return ExitCode::from(1);
        }
    };

    // Background resource sampler (RSS via /proc, VRAM via nvidia-smi) every 2 s.
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(ResourceSamples::default()));
    let pid = std::process::id();
    let sampler = {
        let stop = stop.clone();
        let samples = samples.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let rss = read_rss_kb();
                let vram = query_vram_mib(pid);
                if let Ok(mut s) = samples.lock() {
                    s.record(rss, vram);
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        })
    };

    let params = EncodeParams { bitrate_bps: BITRATE_BPS, gop_len: GOP_LEN, fps_num: FPS_NUM, fps_den: FPS_DEN };
    let session = CaptureSession::new(params);
    let t0 = Instant::now();
    let result = session.run(Duration::from_secs(duration_secs), recorder.clone());
    let elapsed = t0.elapsed();

    stop.store(true, Ordering::Relaxed);
    let _ = sampler.join();
    recorder.borrow_mut().finish();

    let res_samples = samples.lock().ok().map(|s| ResourceSamples {
        rss_kb_min: s.rss_kb_min,
        rss_kb_max: s.rss_kb_max,
        vram_mib_min: s.vram_mib_min,
        vram_mib_max: s.vram_mib_max,
        vram_seen: s.vram_seen,
        n: s.n,
    });

    let report = build_report(&recorder.borrow(), elapsed, res_samples.as_ref());
    let stats_path = format!("{es_path}.stats.txt");
    if let Err(e) = std::fs::write(&stats_path, &report) {
        log::warn!("could not write stats log {stats_path}: {e}");
    }
    println!("\n{report}");

    match result {
        Ok(()) => {
            println!("VERDICT: Stage E run OK — ES at {es_path}, stats at {stats_path}.");
            println!("  next: mortar-pestle-capture decode-proof {es_path} <out.mp4>  (eyeball color/tearing = B2/B3)");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("VERDICT: Stage E run FAILED — {e}\n  partial ES at {es_path}, stats at {stats_path}.");
            ExitCode::from(1)
        }
    }
}

/// Format the budget stats report (printed + written to `<es>.stats.txt`).
#[cfg(target_os = "linux")]
fn build_report(r: &Recorder, elapsed: Duration, res: Option<&ResourceSamples>) -> String {
    let secs = elapsed.as_secs_f64().max(1e-6);
    let delivered_fps = r.arrivals as f64 / secs;
    let cfr_fps = r.packets as f64 / secs;
    let pts_span_ms = r.min_pts.map_or(0.0, |min| (r.max_pts - min) as f64 / 1e6);

    let (p50_ms, p99_ms, max_ms) = percentiles_ms(&r.encode_ns);
    let path = if r.shm_arrivals == 0 && r.arrivals > 0 {
        "dmabuf (zero-copy GL) ✓"
    } else if r.arrivals == 0 {
        "NONE — no frames delivered"
    } else {
        "SHM — dmabuf NOT negotiated ✗"
    };

    let mut s = String::new();
    s.push_str("=== mortar-pestle-capture Stage E proof — budget stats ===\n");
    s.push_str(&format!("duration:        {:.1} s (wall)\n", secs));
    s.push_str(&format!("buffer path:     {path}  ({} arrivals, {} SHM)\n", r.arrivals, r.shm_arrivals));
    s.push_str(&format!("delivered fps:   {:.2}  (capture arrivals / s — B4 reading)\n", delivered_fps));
    s.push_str(&format!("cfr fps:         {:.2}  (encoded packets / s — target 60)\n", cfr_fps));
    s.push_str(&format!("packets:         {} ({} keyframes, ~1 per {} frames)\n",
        r.packets, r.keyframes, if r.keyframes > 0 { r.packets / r.keyframes } else { 0 }));
    s.push_str(&format!("PTS span:        {:.1} ms monotonic, max inter-frame gap {:.1} ms\n",
        pts_span_ms, r.max_gap_ns as f64 / 1e6));
    s.push_str(&format!("encode ms/frame: p50 {:.2}  p99 {:.2}  max {:.2}  (budget 16.67)\n", p50_ms, p99_ms, max_ms));
    let es_mb = r.es_bytes as f64 / 1e6;
    let bitrate_mbps = (r.es_bytes as f64 * 8.0 / 1e6) / secs;
    s.push_str(&format!("ES written:      {:.1} MB  (~{:.1} Mbps measured, target CBR 50)\n", es_mb, bitrate_mbps));
    match res {
        Some(rs) if rs.n > 0 => {
            s.push_str(&format!(
                "RSS:             {:.0}–{:.0} MB ({} samples; spread {:.0} MB — leak check, budget ≤300)\n",
                rs.rss_kb_min as f64 / 1024.0,
                rs.rss_kb_max as f64 / 1024.0,
                rs.n,
                (rs.rss_kb_max.saturating_sub(rs.rss_kb_min)) as f64 / 1024.0,
            ));
            if rs.vram_seen {
                s.push_str(&format!(
                    "VRAM (this pid): {}–{} MiB (spread {} MiB — leak check)\n",
                    rs.vram_mib_min,
                    rs.vram_mib_max,
                    rs.vram_mib_max.saturating_sub(rs.vram_mib_min),
                ));
            } else {
                s.push_str("VRAM (this pid): not reported by nvidia-smi compute-apps\n");
            }
        }
        _ => s.push_str("RSS/VRAM:        no samples collected\n"),
    }
    s
}

/// p50 / p99 / max of the per-frame encode times, in milliseconds.
#[cfg(target_os = "linux")]
fn percentiles_ms(ns: &[u128]) -> (f64, f64, f64) {
    if ns.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let mut v = ns.to_vec();
    v.sort_unstable();
    let at = |q: f64| v[((v.len() as f64 * q) as usize).min(v.len() - 1)] as f64 / 1e6;
    (at(0.50), at(0.99), *v.last().unwrap() as f64 / 1e6)
}

/// Resident set size in KB from `/proc/self/status` (`VmRSS`).
#[cfg(target_os = "linux")]
fn read_rss_kb() -> Option<u64> {
    let mut s = String::new();
    File::open("/proc/self/status").ok()?.read_to_string(&mut s).ok()?;
    s.lines()
        .find(|l| l.starts_with("VmRSS:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse::<u64>().ok())
}

/// Per-process VRAM (MiB) for `pid` via `nvidia-smi --query-compute-apps`.
#[cfg(target_os = "linux")]
fn query_vram_mib(pid: u32) -> Option<u64> {
    let out = Command::new("nvidia-smi")
        .args(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut parts = line.split(',').map(|p| p.trim());
        let (Some(p), Some(mem)) = (parts.next(), parts.next()) else { continue };
        if p.parse::<u32>().ok() == Some(pid) {
            return mem.parse::<u64>().ok();
        }
    }
    None
}

/// Entry point for `mortar-pestle-capture decode-proof <es> <mp4>` — remux the raw
/// H.264 ES into a viewable 60 fps MP4 via system ffmpeg (the engine shells
/// ffmpeg; it does not link any codec library).
#[cfg(target_os = "linux")]
pub fn decode_proof(args: &[String]) -> ExitCode {
    let (Some(es), Some(mp4)) = (args.first(), args.get(1)) else {
        eprintln!("usage: mortar-pestle-capture decode-proof <in.h264> <out.mp4>");
        return ExitCode::from(2);
    };
    let status = Command::new("ffmpeg")
        .args([
            "-y", "-loglevel", "error", "-r", "60", "-i", es, "-c:v", "copy",
            "-movflags", "+faststart", mp4,
        ])
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("decode-proof -> {mp4}  (open it: correct color = B2, no tearing = B3)");
            ExitCode::SUCCESS
        }
        Ok(s) => {
            eprintln!("ffmpeg failed ({s}) — the ES may be malformed");
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("spawn ffmpeg (is it installed?): {e}");
            ExitCode::from(1)
        }
    }
}
