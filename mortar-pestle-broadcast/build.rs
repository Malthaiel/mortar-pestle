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
    // The link-search path above is ABSOLUTE, so it is only valid for the
    // directory this script last ran in. Narrowing rerun-if-changed to obs.lib
    // means an unchanged obs.lib lets cargo replay the CACHED output after the
    // crate moves — a relocated repo or a deleted worktree then fails to link
    // with "LNK1181: cannot open input file 'obs.lib'" while `cargo check`,
    // which never links, still passes. Re-run when the manifest dir moves.
    // (Seen 2026-07-25: a cached path from a deleted `mortar-pestle-wt`
    // worktree broke every fresh link in the relocated repo.)
    println!("cargo:rerun-if-env-changed=CARGO_MANIFEST_DIR");
}
