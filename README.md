# Mortar & Pestle

Small native desktop apps for Linux, built for the [niri](https://github.com/niri-wm/niri) Wayland compositor. Each app is its own program, written in Rust with [iced](https://iced.rs) and drawn on the processor: no web engine, no graphics card needed.

| Program | Folder | What it is |
|---|---|---|
| `mp-shell` | `apps/shell` | The top bar: workspaces, clock, weather, network, Bluetooth, sound; its drop-down panels with the music box (library, playlists, search, downloads); the Start menu, the side panel and notifications |
| `mp-files` | `apps/files` | A file explorer |
| `mp-player` | `apps/player` | The music player the music box drives |
| `mp-theme` | `crates/mp-theme` | Writes the light or dark colour set every app reads |

`crates/mp-ui` holds what every app draws with (sizes, colours, motion, the shared parts).

## Status

Early, and built for one PC (CachyOS + niri). There are no packages or installers yet, and settings are files, not screens.

## Build

Needs Rust 1.99 or newer and the Wayland and xkbcommon libraries.

```sh
git clone https://github.com/Malthaiel/mortar-pestle
cd mortar-pestle
cargo build --release -p mp-shell    # or mp-files, mp-player, mp-theme
cargo test --workspace
```

Some features start other programs when they are installed: `curl` (weather, covers, music look-ups), `yt-dlp` (music downloads), `mpv` (opens a recording or screenshot), `gpu-screen-recorder` (screen recording). The weather shows once `~/.config/mp-shell/weather` holds a US weather station's letters (one word, as [api.weather.gov/stations](https://api.weather.gov/stations) lists them).

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE): free for any noncommercial purpose. Copyright © 2026 Malthaiel.

The folders in [`patches/`](./patches/README.md) are edited copies of other people's libraries and stay under their own licences (MIT, or MIT OR Apache-2.0).
