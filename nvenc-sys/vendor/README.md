# Vendored headers

`nv-codec-headers/include/ffnvcodec/` — vendored verbatim from
[FFmpeg/nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) tag
**n13.0.19.0** (NVENCAPI 13.0), 2026-06-13. MIT-licensed (per-header copyright
notice; upstream `README` reproduced alongside as provenance).

**Nothing is linked.** `build.rs` runs `bindgen` over `nvEncodeAPI.h` to generate
Rust declarations only; the NVENC symbols are resolved at runtime via `dlopen` of
the driver's `libnvidia-encode.so.1` through its one entry point
`NvEncodeAPICreateInstance`. The crate therefore stays loadable on machines with
no NVIDIA driver.

The `dynlink_cuda*.h` / `dynlink_cuviddec.h` / `dynlink_nvcuvid.h` headers back the
**CUDA fallback arm** of the Phase-0 interop spike (B1) and are unused unless that
arm is chosen over the GL device type.

Re-vendor:
```
git clone https://github.com/FFmpeg/nv-codec-headers /tmp/nvch
git -C /tmp/nvch checkout n13.0.19.0
cp -r /tmp/nvch/include/ffnvcodec nvenc-sys/vendor/nv-codec-headers/include/
```
