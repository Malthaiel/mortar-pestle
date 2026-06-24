//! Encode SF3 acceptance test — a 300-frame run driven entirely through the
//! `Encoder` trait object. Asserts: 300 packets, keyframes at the 2 s
//! (gop_len=120) cadence, non-empty sequence headers, empty flush. Dumps the
//! concatenated elementary stream for an ffmpeg frame-count cross-check:
//!
//!   cargo run -p nvenc-sys --example encoder300
//!   ffprobe -count_frames -select_streams v:0 -show_entries stream=nb_read_frames \
//!     -of default=noprint_wrappers=1 /tmp/iskariel-capture-300.h264

// The CUDA `NvencH264Encoder` is gated off Windows (Game Capture SF1), so this
// Linux-only SF3 acceptance example is a no-op there.
#![cfg_attr(windows, allow(dead_code, unused_imports))]

use std::io::Write;

#[cfg(not(windows))]
use nvenc_sys::encoder::{
    Codec, EncodeFlags, Encoder, EncoderConfig, InputKind, NvencH264Encoder,
};

const W: u32 = 256;
const H: u32 = 256;
const FRAMES: u64 = 300;
const GOP: u32 = 120; // 2 s @ 60 fps

fn fail(msg: &str) -> ! {
    eprintln!("FAIL: {msg}");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    eprintln!("encoder300: the NvencH264Encoder (CUDA) path is Linux-only; nothing to run on Windows.");
}

#[cfg(not(windows))]
fn main() {
    let cfg = EncoderConfig {
        codec: Codec::H264,
        width: W,
        height: H,
        fps_num: 60,
        fps_den: 1,
        input: InputKind::HostArgb,
        gop_len: GOP,
        b_frames: 0,
        rate_control: None, // SF3 path: preset defaults (CBR is SF4)
    };
    let mut concrete =
        NvencH264Encoder::open(cfg).unwrap_or_else(|e| fail(&format!("open: {e:?}")));
    // Drive everything through the trait object (SF3 acceptance criterion).
    let enc: &mut dyn Encoder = &mut concrete;

    let inputs = enc.accepted_inputs();
    if inputs.len() != 1 || inputs[0] != InputKind::HostArgb {
        fail("accepted_inputs should be exactly [HostArgb]");
    }
    let handle = enc
        .register(InputKind::HostArgb)
        .unwrap_or_else(|e| fail(&format!("register: {e:?}")));

    let headers = enc
        .sequence_headers()
        .unwrap_or_else(|e| fail(&format!("sequence_headers: {e:?}")));
    if headers.is_empty() {
        fail("sequence headers are empty");
    }

    let mut argb = vec![0u8; (W * H * 4) as usize];
    let mut packets: u64 = 0;
    let mut keyframes: Vec<u64> = Vec::new();
    let mut es: Vec<u8> = Vec::new();

    for frame in 0..FRAMES {
        // Animate so every frame differs (scrolling R, per-frame B).
        for y in 0..H {
            for x in 0..W {
                let i = ((y * W + x) * 4) as usize;
                argb[i] = (frame as u32 * 2 % 256) as u8; // B
                argb[i + 1] = (y * 255 / (H - 1)) as u8; // G
                argb[i + 2] = ((x + frame as u32) % 256) as u8; // R
                argb[i + 3] = 255; // A
            }
        }
        enc.upload_host_frame(handle, &argb)
            .unwrap_or_else(|e| fail(&format!("upload f{frame}: {e:?}")));
        let out = enc
            .encode(handle, frame, EncodeFlags::default())
            .unwrap_or_else(|e| fail(&format!("encode f{frame}: {e:?}")));
        for p in &out {
            packets += 1;
            if p.keyframe {
                keyframes.push(p.pts);
            }
            es.extend_from_slice(&p.data);
        }
    }

    let drained = enc
        .flush()
        .unwrap_or_else(|e| fail(&format!("flush: {e:?}")));
    if !drained.is_empty() {
        fail("flush returned packets (Phase 1 is B-frame-free)");
    }

    // Dump the concatenated ES for the ffmpeg frame-count cross-check.
    let path = "/tmp/iskariel-capture-300.h264";
    let mut f = std::fs::File::create(path).expect("create output");
    f.write_all(&es).expect("write output");

    // Acceptance assertions.
    if packets != FRAMES {
        fail(&format!("expected {FRAMES} packets, got {packets}"));
    }
    let expected_kf: Vec<u64> = (0..FRAMES).filter(|i| i % GOP as u64 == 0).collect();
    if keyframes != expected_kf {
        fail(&format!(
            "keyframe cadence wrong: got {keyframes:?}, expected {expected_kf:?}"
        ));
    }

    println!("PASS — {packets} frames → {packets} packets through the trait object");
    println!("  keyframes at {keyframes:?} (gop_len={GOP}, 2 s @ 60 fps)");
    println!("  sequence headers: {} bytes", headers.len());
    println!("  wrote {} bytes ES → {path}", es.len());
}
