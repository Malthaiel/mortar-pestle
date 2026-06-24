//! Encode SF2 probe contract — a 1-frame NVENC test encode:
//! open a CUDA NVENC session, encode one ARGB gradient as forced-IDR H.264, and
//! dump the elementary stream to disk. Run, then decode/verify with ffmpeg:
//!
//!   cargo run -p nvenc-sys --example encode
//!   ffmpeg -i /tmp/iskariel-capture-test.h264 -frames:v 1 -y /tmp/iskariel-capture-test.png
//!
//! A `00 00 00 01 67 …` header (start code + NAL type 7 = SPS) proves the output
//! is a standalone-decodable H.264 access unit, not a listing-only "capability".

use std::io::Write;

const W: u32 = 256;
const H: u32 = 256;
const OUT: &str = "/tmp/iskariel-capture-test.h264";

fn main() {
    // ARGB (word-order [B, G, R, A]) diagonal-gradient test pattern:
    // R ramps with x, G ramps with y, B flat — easy to eyeball after decode.
    let mut argb = vec![0u8; (W * H * 4) as usize];
    for y in 0..H {
        for x in 0..W {
            let i = ((y * W + x) * 4) as usize;
            argb[i] = 128; // B
            argb[i + 1] = (y * 255 / (H - 1)) as u8; // G
            argb[i + 2] = (x * 255 / (W - 1)) as u8; // R
            argb[i + 3] = 255; // A
        }
    }

    let die = |stage: &str, e: nvenc_sys::NvencError| -> ! {
        eprintln!("{stage} failed: {e:?}");
        std::process::exit(1);
    };

    let nv = nvenc_sys::Nvenc::load().unwrap_or_else(|e| die("NVENC load", e));
    let ctx = nvenc_sys::cuda::CudaContext::new().unwrap_or_else(|e| die("CUDA context", e));
    let session = nv.open_cuda_session(&ctx).unwrap_or_else(|e| die("session open", e));
    session
        .initialize_h264(W, H, 60, 1)
        .unwrap_or_else(|e| die("initialize", e));
    let es = session
        .test_encode_h264_argb(W, H, &argb)
        .unwrap_or_else(|e| die("encode", e));

    let mut f = std::fs::File::create(OUT).expect("create output file");
    f.write_all(&es).expect("write elementary stream");

    let head: Vec<String> = es.iter().take(8).map(|b| format!("{b:02x}")).collect();
    println!("encoded {}x{} ARGB → {} bytes, wrote {OUT}", W, H, es.len());
    println!("first bytes: {}  (expect `00 00 00 01 67` = start code + SPS)", head.join(" "));
    println!("decode: ffmpeg -i {OUT} -frames:v 1 -y /tmp/iskariel-capture-test.png");
}
