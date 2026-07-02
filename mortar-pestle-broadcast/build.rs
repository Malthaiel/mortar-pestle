fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    // obs.lib is the import library scripts/fetch-obs.ps1 generates from the
    // pinned official obs.dll's export table (SF0a). obs.dll is DELAY-LOADED:
    // the exe must start (help / CLI probe) without obs.dll on the loader
    // path — main() calls payload::add_dll_dirs() before the first obs_* call,
    // and the delay-load helper resolves obs.dll from that directory then.
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    println!("cargo:rustc-link-search=native={manifest}/obs/lib");
    println!("cargo:rustc-link-lib=dylib=obs");
    println!("cargo:rustc-link-arg=/DELAYLOAD:obs.dll");
    println!("cargo:rustc-link-lib=dylib=delayimp");
    // vsnprintf (obs log-handler va_list formatting) is header-inline in the
    // modern UCRT; the linkable symbol lives in legacy_stdio_definitions.
    println!("cargo:rustc-link-lib=dylib=legacy_stdio_definitions");
    println!("cargo:rerun-if-changed=obs/lib/obs.lib");
}
