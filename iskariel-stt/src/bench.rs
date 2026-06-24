//! `iskariel-stt bench` — the Phase 4 performance harness (Voice Transcription).
//!
//! Loads each speech model on both backends (GPU + CPU, both reachable from one
//! `--features vulkan` build via the runtime `use_gpu` field) and measures batch RTF,
//! resident RSS, and VRAM against the bundled `jfk.wav` fixture, printing a markdown table
//! ready to paste into the Overview's Cross-cutting contracts.
//!
//! Synchronous + standalone — it never touches the socket/daemon. It reuses the model
//! registry ([`crate::models::ensure_model`]), the decoder ([`crate::whisper::decode_to_16k_mono`]),
//! the low-level loader ([`crate::whisper::load_ctx_on`]), and [`crate::whisper::transcribe_pcm`].
//! VRAM is read HOST-SIDE via `nvidia-smi`: a WebView/WebGL query reports a masked GPU
//! identity ("Apple GPU"), so GPU memory must be measured from the host, not from JS.

use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::time::Instant;

use crate::models::ensure_model;
use crate::whisper::{decode_to_16k_mono, gpu_backend_name, gpu_compiled, load_ctx_on, transcribe_pcm};

/// Speech models measured (the registry's three speech models — the VAD model is not a
/// transcription model). Order = lightest → heaviest.
const MODELS: &[&str] = &["base.en", "small", "large-v3-turbo-q5_0"];

/// Timed transcription repetitions per (model, backend) cell. The fastest is reported as
/// RTF (least scheduler noise), with the median alongside. One warm-up run (kernel/graph
/// compile, allocator warm) precedes these and is discarded.
const TIMED_RUNS: usize = 5;

/// The bundled fixture (~11 s of JFK audio). Resolved against the crate root at compile
/// time so the harness works regardless of the caller's CWD.
const FIXTURE: &str = "tests/fixtures/jfk.wav";

/// One measured (model, backend) cell.
struct Row {
    model: &'static str,
    backend: &'static str,
    rtf: f64,
    best_ms: f64,
    median_ms: f64,
    load_ms: f64,
    /// Resident RSS attributable to this model (resident − idle), MB.
    model_rss_mb: u64,
    /// Per-model VRAM delta (MiB) on a GPU row; `None` on CPU rows or when nvidia-smi is absent.
    vram_mib: Option<u64>,
}

pub fn run(_args: &[String]) -> ExitCode {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);

    // Decode once — the same 16 kHz mono PCM feeds every cell. Audio duration is derived
    // from the sample count (exact), not hardcoded.
    let pcm = match decode_to_16k_mono(&fixture) {
        Ok(p) if !p.is_empty() => p,
        Ok(_) => {
            eprintln!("bench: fixture decoded to empty PCM: {}", fixture.display());
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("bench: decode {} failed: {e}", fixture.display());
            return ExitCode::FAILURE;
        }
    };
    let audio_secs = pcm.len() as f64 / 16_000.0;

    let n_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let idle_rss_mb = vmrss_mb();
    let gpu_name = nvidia_smi_name().unwrap_or_else(|| "n/a".to_string());

    // GPU rows only when a GPU backend is compiled in; always measure CPU.
    let backends: &[bool] = if gpu_compiled() { &[true, false] } else { &[false] };

    eprintln!(
        "bench: fixture {:.1}s · idle RSS {} MB · GPU {} · CPU {} threads · {} run(s)/cell",
        audio_secs, idle_rss_mb, gpu_name, n_threads, TIMED_RUNS
    );

    let mut rows: Vec<Row> = Vec::new();

    for &name in MODELS {
        eprintln!("bench: ensuring model `{name}` (may fetch ~hundreds of MB on first run)…");
        let ensured = match ensure_model(name, |pct| eprint!("\r  download {pct:.0}%   ")) {
            Ok(m) => m,
            Err(_) => {
                eprintln!("bench: model `{name}` unavailable — skipping");
                continue;
            }
        };

        for &use_gpu in backends {
            let backend = if use_gpu { gpu_backend_name() } else { "cpu" };

            let vram_before = if use_gpu { nvidia_smi_used_mib() } else { None };
            let t = Instant::now();
            let ctx = match load_ctx_on(&ensured.path, use_gpu) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("bench: load `{name}` on {backend} failed: {e}");
                    continue;
                }
            };
            let load_ms = t.elapsed().as_secs_f64() * 1000.0;
            let model_rss_mb = vmrss_mb().saturating_sub(idle_rss_mb);
            let vram_after = if use_gpu { nvidia_smi_used_mib() } else { None };
            let vram_mib = match (vram_before, vram_after) {
                (Some(b), Some(a)) => Some(a.saturating_sub(b)),
                _ => None,
            };

            // Warm-up (discarded): the first run pays kernel/graph compile + allocator warm.
            let _ = transcribe_pcm(&ctx, &pcm);

            let mut times_ms: Vec<f64> = Vec::with_capacity(TIMED_RUNS);
            for _ in 0..TIMED_RUNS {
                let t = Instant::now();
                if let Err(e) = transcribe_pcm(&ctx, &pcm) {
                    eprintln!("bench: transcribe `{name}` on {backend} failed: {e}");
                }
                times_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            times_ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let best_ms = times_ms[0];
            let median_ms = times_ms[times_ms.len() / 2];
            let rtf = (best_ms / 1000.0) / audio_secs;

            eprintln!("bench: {name} / {backend} → RTF {rtf:.3} ({best_ms:.0} ms best, {median_ms:.0} median)");
            rows.push(Row { model: name, backend, rtf, best_ms, median_ms, load_ms, model_rss_mb, vram_mib });

            drop(ctx); // free VRAM before the next cell
        }
    }

    print_table(&rows, audio_secs, idle_rss_mb, &gpu_name, n_threads);
    ExitCode::SUCCESS
}

/// Resident set size (MB) from `/proc/self/status` `VmRSS:` — no external crate. `0` if the
/// field can't be read (non-Linux / parse failure); the footer marks RSS a Linux measurement.
fn vmrss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kib| kib.parse::<u64>().ok())
        })
        .map(|kib| kib / 1024)
        .unwrap_or(0)
}

/// Total GPU memory used (MiB), host-side via `nvidia-smi`. `None` when nvidia-smi is absent
/// or errors. This is GLOBAL usage (all processes), so per-model VRAM is a before/after diff
/// taken with no other GPU-heavy app running (stop the dev sidecar first).
fn nvidia_smi_used_mib() -> Option<u64> {
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.used", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().and_then(|l| l.trim().parse::<u64>().ok())
}

/// GPU product name, host-side via `nvidia-smi`. `None` when nvidia-smi is absent or errors.
fn nvidia_smi_name() -> Option<String> {
    let out = Command::new("nvidia-smi").args(["--query-gpu=name", "--format=csv,noheader"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string())
}

/// Emit the markdown table + a provenance footer to stdout (the harness's deliverable;
/// progress chatter goes to stderr).
fn print_table(rows: &[Row], audio_secs: f64, idle_rss_mb: u64, gpu_name: &str, n_threads: usize) {
    println!();
    println!("| model | backend | RTF | transcribe best/median (ms) | load (ms) | model RSS (MB) | VRAM (MiB) |");
    println!("|---|---|---|---|---|---|---|");
    for r in rows {
        let vram = r.vram_mib.map(|v| v.to_string()).unwrap_or_else(|| "—".to_string());
        println!(
            "| {} | {} | {:.3} | {:.0} / {:.0} | {:.0} | {} | {} |",
            r.model, r.backend, r.rtf, r.best_ms, r.median_ms, r.load_ms, r.model_rss_mb, vram
        );
    }
    println!();
    println!(
        "_Measured on a {:.1}s clip · idle sidecar RSS {} MB · GPU {} · CPU {} threads · RTF = best transcribe ÷ audio (lower is faster)._",
        audio_secs, idle_rss_mb, gpu_name, n_threads
    );
    println!(
        "_Press-to-talk time-to-final ≈ the warm batch transcribe above (batch proxy; real utterances are shorter and the model is preloaded, so live latency ≤ this)._"
    );
}
