# Iskariel

A personal operating system for thinking, planning, and producing — a desktop app that reads and writes a local [Obsidian](https://obsidian.md) vault. Vault browser, focus timer + planner, skills runner, media library (anime / music / video), per-session-token PTY terminal, and a built-in Claude agent.

Built with [Tauri 2](https://tauri.app) (Rust backend) wrapping a Vite-served React frontend. Windows-first. *Formerly developed under the name "Iskariel".*

## Install (Windows)

1. Download the latest `Iskariel_x.y.z_x64-setup.exe` from the [Releases page](https://github.com/Malthaiel/iskariel/releases/latest).
2. Run it. Because the installer is **not yet code-signed**, Windows SmartScreen may warn: click **More info → Run anyway**. (Code signing is planned for a later release.)
3. Iskariel checks for updates automatically and can install them in place.

### Prerequisites for the media features

Some features shell out to external tools that must be on your `PATH` (bundling them into the installer is planned):

- **ffmpeg / ffprobe** — video transcode, subtitle extraction, audio tooling.
- **yt-dlp** — music / video downloads.
- **qBittorrent** with the **Web UI** enabled — anime downloads.

The core vault, planner, timer, terminal, and agent features work without any of these.

## Build from source

Requires [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```powershell
git clone https://github.com/Malthaiel/iskariel
cd iskariel
npm install
npm --prefix web install
npm run tauri dev      # dev window with Vite HMR
npm run tauri build    # NSIS installer in src-tauri/target/release/bundle/nsis/
```

## Status

Windows is the primary platform. Four subsystems are stubbed in the current Windows build and are being ported: **Game Capture**, **in-app browser**, **STT / voice dictation**, and **in-game overlay**.

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free for any noncommercial purpose. Copyright © 2026 Malthaiel.
