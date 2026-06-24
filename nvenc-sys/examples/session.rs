//! Open an NVENC session on a CUDA device and prove the function table works
//! past version query:
//!   cargo run -p nvenc-sys --example session

fn main() {
    let nv = nvenc_sys::Nvenc::load().unwrap_or_else(|e| {
        eprintln!("NVENC load failed: {e:?}");
        std::process::exit(1);
    });
    let ctx = nvenc_sys::cuda::CudaContext::new().unwrap_or_else(|e| {
        eprintln!("CUDA context failed: {e:?}");
        std::process::exit(1);
    });
    let session = nv.open_cuda_session(&ctx).unwrap_or_else(|e| {
        eprintln!("NVENC session open failed: {e:?}");
        std::process::exit(1);
    });
    match session.encode_guid_count() {
        Ok(n) => println!("NVENC session OK on CUDA device — {n} codec GUIDs supported"),
        Err(e) => {
            eprintln!("GUID count failed: {e:?}");
            std::process::exit(1);
        }
    }
}
