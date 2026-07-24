# CLAUDE.md — Mortar & Pestle

Agent orientation for this repo. Read before editing. Every claim below was
verified against the tree; if something here contradicts what you see, trust
the tree and flag the drift.

## Commands

- Install (root): `npm install`
- Install (web): `npm --prefix web install`
- Dev: `npm run tauri dev` — Vite HMR at `http://127.0.0.1:5173` + the Tauri desktop window
- Build: `npm run tauri build` — NSIS installer under `src-tauri/target/release/bundle/nsis/`
- Verify (one-command gate): `npm run verify` — runs `node scripts/verify.mjs`: the safe Rust integration-test set, both web checks, and a JS syntax gate. Green = ship-ready.
- A single Rust integration test: `cargo test --manifest-path src-tauri/Cargo.toml --test <name>` (targets: `integration`, `stt_roundtrip`, `capture_roundtrip`, `vault_io_sanity`, `health_grammar`, `transcode_integration`). NEVER `cargo test --tests` or `cargo test --lib` — BOTH SIGTERM the agent dev-sandbox (they compile the ~36 `#[cfg(test)]` lib unit-test mods). `scripts/verify.mjs` enumerates the safe `--test <name>` targets explicitly; see the hazard banner at its top. `transcode_integration` is COMPILE-ONLY there (`--no-run`): every test in it is `#[ignore]`d, and its exe cannot load on Windows at all — it is the one target importing `TaskDialogIndirect` (comctl32 v6, via `app_lib::asset_protocol` → tauri), and a manifest-less `cargo test` exe binds the legacy comctl32 5.82 in system32, dying at load with `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`. Run its real tests only with an explicit `-- --ignored --test-threads=1` (needs ffmpeg on PATH) and expect that same load failure.
- Web checks (also run by `npm run verify`): `npm --prefix web run check-themes` (WCAG-AA contrast) and `npm --prefix web run check-drag` (drag-math invariants).

## Architecture

- Tauri 2 Rust shell in `src-tauri/`. Every backend entry point is a `#[tauri::command]` reached over IPC from the frontend. No Fastify/Node sidecar.
- The only network-listening surfaces are loopback, both bound to `127.0.0.1`:
  - `src-tauri/src/media_server.rs` — axum media server; port surfaced to the frontend by the `media_server_port` command.
  - `src-tauri/src/proxy.rs` — a loopback-forward proxy (kernel-assigned port) that the sandboxed in-app browser routes ALL its network traffic through. Fail-closed https-only: it refuses any destination that resolves to loopback / private / link-local / unspecified / multicast, so a hostile page cannot reach the media server or other local services. This is the browser's real network boundary — WebKit navigation policy only sees top-level navigations, not fetch/XHR/subresource loads.
- Frontend host in `web/` — React 18.3 + Vite 6, plain JS (no TypeScript): no `typescript` dep in `web/package.json`, no `tsconfig*.json` in `web/`.
- Features are modules in `modules/{core,studio}/<name>/`, discovered via `import.meta.glob` in `web/src/module-loader.js`. A module ships `manifest.json` + an `index.js`/`index.jsx` entry. Studio-tier modules load ONLY when `import.meta.env.VITE_BUILD_TIER === 'studio'` (`module-loader.js:82`); `core` builds glob only `modules/core/*`. A per-module `platforms:` manifest gate is keyed off `import.meta.env.VITE_TARGET_OS` (`module-loader.js:114-116`).
- Three sidecar crates at the repo root — `mortar-pestle-capture/`, `mortar-pestle-stt/`, `mortar-pestle-broadcast/` (plus `nvenc-sys/`). There is no root `Cargo.toml` — NOT a Cargo workspace; each builds independently and each carries its own copy of the wire protocol. They speak NDJSON to the Tauri host over a named pipe (Windows) / Unix domain socket (Linux); the protocol is copied per crate, not shared as a library.

## Conventions

- A new `#[tauri::command]` MUST be registered in ALL 3 ACL sites or it is silently denied at runtime ("not allowed by ACL", no compile error). This is the single most common silent failure in this repo:
  1. `src-tauri/build.rs` — `tauri_build::AppManifest::new().commands(&[ ... ])` lists every command name (this manifest DEFINES the per-command permissions).
  2. `src-tauri/capabilities/default.json` — explicitly references each one as `allow-<kebab-case>`. The file's own description warns: adding a command to build.rs alone does NOT enable it (it stays ACL-blocked until listed here). A separate `capabilities/browser-content.json` covers the isolated browser webview.
  3. `src-tauri/src/lib.rs` — `.invoke_handler(tauri::generate_handler![ commands::ping, ... ])` lists the handler functions.
  Some handlers are `#[cfg(target_os = ...)]`-gated in `generate_handler!`; mirror the cfg in all three sites. Miss any one → runtime ACL denial, no compile error.
- Plain JS, no TypeScript. No `tsconfig`, no `typescript` dep.
- `sha1` = content-addressing, `sha2` = security. Both deps in `src-tauri/Cargo.toml` are intentional, not a duplicate to dedupe. (No inline source comment states this — it is project knowledge.)
- Design language/CSS: see `docs/DESIGN.md` (Token → Primitive → Pattern order, § How to use this doc). The creative/motion DESIGN.md lives in the external App vault, not this repo.

## Gotchas

- NEVER `cargo test --tests` or `cargo test --lib` — both SIGTERM the agent dev-sandbox by compiling the ~36 `#[cfg(test)]` library unit-test mods. Use `npm run verify` (the one-command gate) or a specific `cargo test --manifest-path src-tauri/Cargo.toml --test <name>`. The hazard banner at the top of `scripts/verify.mjs` documents this.
- `import.meta.env.VITE_BUILD_TIER` and `VITE_TARGET_OS` must be referenced in the exact `import.meta.env.X` form, not the optional-chaining `?.` form. The exact form is a Vite define constant and the unused branch folds at build (so studio chunks are never emitted in a core build — a source-leak guard for the closed-source studio tier). The `?.` form does NOT fold (`web/src/module-loader.js:78-82, 114-116`). Practical corollary: a brand-new module directory may need a `npm run tauri dev` restart to be picked up by `import.meta.glob` — HMR handles edits to existing files, not new directories.
- `windows` crate pinned to 0.61 (`src-tauri/Cargo.toml`) so `WebviewWindow::hwnd()`'s HWND unifies with Tauri's. Don't bump it independently of Tauri's expectation.
- `keyring` needs a per-platform backend feature (`src-tauri/Cargo.toml`: `sync-secret-service` on Unix, `windows-native` on Windows) or v3 silently becomes an in-process mock that "succeeds" but persists nothing.
- Studio-tier modules are inert in `core` builds — the `import.meta.glob` branch that would enumerate `modules/studio/*` folds away at build time, so studio code is never emitted as a dead chunk in a core build.
- `MORTAR_PESTLE_SUPABASE_URL` / `MORTAR_PESTLE_SUPABASE_ANON_KEY` are optional in dev but REQUIRED for a release build — `src-tauri/build.rs` panics a release build if either is empty (Feedback Board would ship dead); dev/debug falls back to a runtime `std::env::var` lookup.
- `web/.env` is gitignored (`.gitignore`: `.env`, `.env.local`, `.env.*`) and sets `VITE_BUILD_TIER=studio` for local studio artifacts. Do NOT read, copy, or commit it. (`.env.example` is exempt via a `!.env.example` negation so the template ships.)

## Env

See `.env.example` for the full variable surface (22 vars: 4 frontend/build-time + 18 backend). All are optional for `core` dev; the two Supabase vars are required for release builds. None are secrets that must be set to run the core app.