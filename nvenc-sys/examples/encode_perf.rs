//! Encode SF4 perf measurement — sustained 3440×1440 H.264 CBR 50 Mbps through
//! the dedicated encode thread ([`ThreadedEncoder`]). Reports **encode-only**
//! ms/frame (the `encode` call alone — excludes the host upload memcpy the
//! zero-copy GL/CUDA path won't have) and the process's NVENC VRAM via
//! nvidia-smi.
//!
//!   cargo run -p nvenc-sys --release --example encode_perf

// The CUDA `ThreadedEncoder` is gated off Windows (Game Capture SF1), so this
// Linux-only SF4 perf benchmark is a no-op there.
#![cfg_attr(windows, allow(dead_code, unused_imports))]

#[cfg(not(windows))]
use nvenc_sys::encoder::{Codec, EncoderConfig, InputKind, RateControl, ThreadedEncoder};

const W: u32 = 3440;
const H: u32 = 1440;
const FPS: u32 = 60;
const GOP: u32 = 120; // 2 s @ 60 fps
const BITRATE: u32 = 50_000_000; // 50 Mbps
const WARMUP: u64 = 30;
const MEASURE: u64 = 300;

/// This process's GPU memory (MiB) from `nvidia-smi --query-compute-apps`, if it
/// shows up as a GPU client.
fn vram_mib_for_self() -> Option<u64> {
    let pid = std::process::id().to_string();
    let out = std::process::Command::new("nvidia-smi")
        .args([
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut parts = line.split(',').map(|s| s.trim());
        if let (Some(p), Some(m)) = (parts.next(), parts.next()) {
            if p == pid {
                return m.parse().ok();
            }
        }
    }
    None
}

fn make_frame(buf: &mut [u8], frame: u64) {
    for y in 0..H {
        for x in 0..W {
            let i = ((y * W + x) * 4) as usize;
            buf[i] = (frame as u32 * 2 % 256) as u8; // B
            buf[i + 1] = (y * 255 / (H - 1)) as u8; // G
            buf[i + 2] = ((x + frame as u32) % 256) as u8; // R
            buf[i + 3] = 255; // A
        }
    }
}

#[cfg(windows)]
fn main() {
    eprintln!("encode_perf: the ThreadedEncoder (CUDA) path is Linux-only; nothing to run on Windows.");
}

#[cfg(not(windows))]
fn main() {
    let cfg = EncoderConfig {
        codec: Codec::H264,
        width: W,
        height: H,
        fps_num: FPS,
        fps_den: 1,
        input: InputKind::HostArgb,
        gop_len: GOP,
        b_frames: 0,
        rate_control: Some(RateControl::Cbr { bitrate_bps: BITRATE }),
    };
    let enc = ThreadedEncoder::spawn(cfg).unwrap_or_else(|e| {
        eprintln!("spawn failed: {e:?}");
        std::process::exit(1);
    });

    let mut buf = vec![0u8; (W * H * 4) as usize];

    // Warm up: reach steady state + force the encoder to allocate its surfaces.
    for f in 0..WARMUP {
        make_frame(&mut buf, f);
        enc.encode(buf.clone(), f, false).unwrap_or_else(|e| {
            eprintln!("warmup f{f}: {e:?}");
            std::process::exit(1);
        });
    }
    let vram = vram_mib_for_self();

    // Measured run: encode-only ns per frame.
    let mut times_ns: Vec<u128> = Vec::with_capacity(MEASURE as usize);
    let mut total_bytes: usize = 0;
    let mut keyframes = 0u64;
    for i in 0..MEASURE {
        let f = WARMUP + i;
        make_frame(&mut buf, f);
        let reply = enc.encode(buf.clone(), f, false).unwrap_or_else(|e| {
            eprintln!("encode f{f}: {e:?}");
            std::process::exit(1);
        });
        times_ns.push(reply.encode_ns);
        for p in &reply.packets {
            total_bytes += p.data.len();
            if p.keyframe {
                keyframes += 1;
            }
        }
    }

    times_ns.sort_unstable();
    let n = times_ns.len();
    let mean_ms = times_ns.iter().sum::<u128>() as f64 / n as f64 / 1e6;
    let p50_ms = times_ns[n / 2] as f64 / 1e6;
    let p99_ms = times_ns[(n * 99 / 100).min(n - 1)] as f64 / 1e6;
    let max_ms = *times_ns.last().unwrap() as f64 / 1e6;
    let avg_kb = total_bytes / n / 1024;

    println!(
        "SF4 perf — {W}x{H} H.264 CBR {} Mbps, {MEASURE} frames (encode-only, excludes host upload):",
        BITRATE / 1_000_000
    );
    println!("  ms/frame:  mean {mean_ms:.3}   p50 {p50_ms:.3}   p99 {p99_ms:.3}   max {max_ms:.3}");
    println!(
        "  budget:    {} (target <= 6.0 ms/frame to sustain 60 fps with headroom)",
        if p99_ms <= 6.0 { "PASS (p99 <= 6 ms)" } else { "OVER" }
    );
    println!(
        "  VRAM:      {} (this process, NVENC + CUDA context)",
        vram.map(|m| format!("{m} MiB")).unwrap_or_else(|| "n/a".into())
    );
    println!("  bitstream: avg {avg_kb} KB/frame, {keyframes} keyframes in {MEASURE} frames");
}
