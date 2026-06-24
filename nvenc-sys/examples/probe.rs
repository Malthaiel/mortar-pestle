//! Live NVENC probe — run on a machine with an NVIDIA driver:
//!   cargo run -p nvenc-sys --example probe
//!
//! Proves the full chain works end-to-end: vendored header -> bindgen ->
//! dlopen(libnvidia-encode.so.1) -> NvEncodeAPIGetMaxSupportedVersion +
//! NvEncodeAPICreateInstance.

fn main() {
    match nvenc_sys::probe() {
        Ok(caps) => {
            let maj = caps.driver_max_version >> 4;
            let min = caps.driver_max_version & 0xF;
            println!(
                "NVENC OK — driver max API {maj}.{min} (packed {}), header 13.0 (packed {})",
                caps.driver_max_version, caps.header_version
            );
        }
        Err(e) => {
            eprintln!("NVENC probe failed: {e:?}");
            std::process::exit(1);
        }
    }
}
