//! `mortar-pestle-stt` — the speech-to-text engine.
//!
//! Scaffold (Voice Transcription epic, SF1). A windowless transcription engine:
//! a long-running Unix-socket NDJSON control surface that, in later sub-features,
//! drives local Whisper inference (model load + file/stream transcription).
//!
//! SF1 lands ONLY the autonomously-testable daemon layer over the frozen wire
//! protocol — a NO-OP ECHO daemon. `echo` round-trips its payload (the SF1
//! handshake the gate proves); `load_model`/`transcribe_file`/`cancel`/`unload`
//! are typed but STUBBED (`not_implemented`) until SF2/SF3. No whisper-rs yet.

mod bench;
mod daemon;
mod mic;
mod models;
mod protocol;
mod resample;
mod vad;
mod whisper;

use std::process::ExitCode;

const USAGE: &str = "\
usage: mortar-pestle-stt <command>

commands:
  daemon          Long-running control daemon (Unix-socket NDJSON)
  bench           Phase 4 perf harness: batch RTF / RSS / VRAM per model × backend (markdown table)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // The long-running control daemon (SF1: echo handshake).
        Some("daemon") => daemon::run(&args[1..]),
        // Phase 4 measurement harness (windowless, no socket).
        Some("bench") => bench::run(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

