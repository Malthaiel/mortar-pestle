//! OBS payload location + DLL search-path arming.
//!
//! obs.dll is delay-loaded (build.rs `/DELAYLOAD`), so nothing OBS touches the
//! loader until the first `obs_*` call — but that call only succeeds after
//! [`arm_dll_search`] has put `<payload>/bin/64bit` on the default-dirs search
//! path. Never PATH, never SetDllDirectory (per OBS PR #11569 hardening).

use std::path::{Path, PathBuf};

/// Resolve the OBS payload root (the dir holding `bin/64bit/obs.dll`,
/// `obs-plugins/64bit/`, `data/`): env override → walk up from the exe
/// (covers both "obs/ beside the exe" in a bundle and the dev layout, where
/// the exe sits at `<crate>/target/{debug,release}/` and the payload at
/// `<crate>/obs/`).
pub fn payload_root() -> Option<PathBuf> {
    let has_dll = |p: &Path| p.join("bin/64bit/obs.dll").exists();

    if let Ok(dir) = std::env::var("MORTAR_PESTLE_BROADCAST_OBS_DIR") {
        let p = PathBuf::from(dir);
        if has_dll(&p) {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    for anc in exe.parent()?.ancestors() {
        let cand = anc.join("obs");
        if has_dll(&cand) {
            return Some(cand);
        }
    }
    None
}

/// Add `<root>/bin/64bit` to the process default DLL directories and set the
/// cwd to the payload root. Must run before the first delay-loaded `obs_*`
/// call; obs.dll's own static imports (avcodec etc.) resolve from the same
/// added directory when it loads.
#[cfg(windows)]
pub fn arm_dll_search(root: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{
        AddDllDirectory, SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
    };

    let bin = root.join("bin").join("64bit");
    let wide: Vec<u16> = bin.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        if SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if AddDllDirectory(wide.as_ptr()).is_null() {
            return Err(std::io::Error::last_os_error());
        }
    }

    // OBS resolves its helper exes BESIDE the running engine binary via
    // os_get_executable_path — NOT here in bin/64bit. Copy them next to
    // current_exe() so the replay-buffer + ffmpeg-record muxer (obs-ffmpeg-mux)
    // and the hw-encoder probes (obs-*-test) don't hit `CreateProcessW 2`.
    // ponytail: copy-if-absent only — won't refresh a stale dest, but a dev
    // cargo-clean and a fresh install both re-copy from a clean tree, so no drift.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dest_dir) = exe.parent() {
            if dest_dir != bin {
                for name in [
                    "obs-ffmpeg-mux.exe",
                    "obs-nvenc-test.exe",
                    "obs-qsv-test.exe",
                    "obs-amf-test.exe",
                ] {
                    let dest = dest_dir.join(name);
                    if !dest.exists() {
                        if let Err(e) = std::fs::copy(bin.join(name), &dest) {
                            log::warn!("obs helper copy {name} failed: {e}");
                        }
                    }
                }
            }
        }
    }

    // cwd = bin/64bit, exactly how obs64.exe runs: obs.dll's compiled-in data
    // path is the RELATIVE "../../data", resolved against the cwd (core
    // effect files fail to load from any other directory).
    std::env::set_current_dir(&bin)?;
    Ok(())
}
