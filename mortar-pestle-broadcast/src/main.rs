//! mortar-pestle-broadcast — the Broadcast engine daemon (Broadcast SP1).
//!
//! GPL-2.0-only: this crate embeds libobs and carries OBS-derived code; the
//! license boundary with the (non-GPL) app is the process boundary — see
//! README.md. The app supervises this binary and speaks NDJSON over
//! `\\.\pipe\mortar-pestle-broadcast`.

mod bindings;
mod daemon;
mod obs;
mod payload;
mod probe;

/// Resolve payload + arm the DLL search path, or exit. Every OBS-touching
/// subcommand runs through here before its first `obs_*` call.
fn arm_payload() -> std::path::PathBuf {
    let Some(root) = payload::payload_root() else {
        eprintln!("obs payload not found (env MORTAR_PESTLE_BROADCAST_OBS_DIR, beside exe, or <crate>/obs — run scripts/fetch-obs.ps1)");
        std::process::exit(3);
    };
    if let Err(e) = payload::arm_dll_search(&root) {
        eprintln!("failed to arm DLL search path at {}: {e}", root.display());
        std::process::exit(3);
    }
    root
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("init-check") => {
            // SF0a/SF2 acceptance: load obs.dll, obs_startup, full module load,
            // version logged, clean shutdown. RUST_LOG=info for the module table.
            env_logger::Builder::from_default_env().init();
            let root = arm_payload();
            log::info!("payload: {}", root.display());
            match obs::ObsCore::init(&root, &obs::VideoCfg::default()) {
                Ok(core) => {
                    println!("obs {} up (payload {})", core.version_string(), root.display());
                    // Diagnostic: linger before shutdown (module background
                    // threads — file-updater — race an instant teardown).
                    if let Ok(ms) = std::env::var("MORTAR_PESTLE_BROADCAST_LINGER_MS") {
                        if let Ok(ms) = ms.parse::<u64>() {
                            std::thread::sleep(std::time::Duration::from_millis(ms));
                        }
                    }
                    drop(core);
                    println!("shutdown clean");
                }
                Err(e) => {
                    eprintln!("init failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        Some("daemon") => {
            env_logger::Builder::from_default_env().init();
            let root = arm_payload();
            log::info!("payload: {}", root.display());
            std::process::exit(daemon::run(root));
        }
        Some("probe") => {
            let Some(op) = args.get(1) else {
                eprintln!("usage: mortar-pestle-broadcast probe <op> [json-args]");
                std::process::exit(2);
            };
            std::process::exit(probe::run(op, args.get(2).map(String::as_str)));
        }
        _ => {
            eprintln!("usage: mortar-pestle-broadcast <daemon | probe <op> [json-args] | init-check>");
            std::process::exit(2);
        }
    }
}
