# Plan 003: Strip the Windows `\\?\` verbatim prefix before ffmpeg (and audit the opener call sites)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md` **if that file exists** (it may not yet — do not create it).
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/coaching.rs src-tauri/src/commands/media.rs src-tauri/src/tool_path.rs src-tauri/src/parsers/video_transcode.rs`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The Deadlock Scrim Coaching "Extract Comms" step shells out to system `ffmpeg`
to pull a recording's audio into a 16 kHz mono WAV for speech-to-text. On
Windows, `std::fs::canonicalize` returns an extended-length **verbatim** path
(`\\?\C:\Users\...\clip.mp4`). ffmpeg (and ffprobe) reject that form with
`Error opening input: Invalid argument` and exit non-zero, so
`coaching_extract_audio` returns an `Io` error and the entire downstream STT
transcription never runs — the feature is dead on every Windows machine. The
repo already has the exact fix helper (`crate::tool_path::native_str`) applied
in three sibling ffmpeg/ffprobe lanes; this one call site was missed. One-line
change, mirrored from an in-repo exemplar.

## Current state

### The bug — `src-tauri/src/commands/coaching.rs`

`coaching_extract_audio` (async `#[tauri::command]`, lines ~142-203)
canonicalizes the user-picked recording, then builds the ffmpeg argv. The
`-i` input value is pushed **verbatim** — no `native_str` strip:

```rust
// coaching.rs:147
    let canonical = std::fs::canonicalize(PathBuf::from(&video))
        .map_err(|_| VaultError::NotFound(format!("Recording not found: {video}")))?;
```

```rust
// coaching.rs:156  (hash key — deliberately the verbatim string; leave as-is)
    let hash = compute_hash(&canonical.to_string_lossy(), None, mtime_ms_for(&canonical));
```

```rust
// coaching.rs:163-178  (the argv — line 168 is the bug)
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        canonical.to_string_lossy().into_owned(),   // ← line 168: verbatim path, ffmpeg rejects it
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "16000".into(),
        "-f".into(),
        "wav".into(),
        "-y".into(),
        partial.display().to_string(),              // ← line 177: cache path, NOT canonicalized — leave as-is
    ];
```

The output `partial` path (line 177) is built under `dirs::cache_dir()`
(`comms_cache_dir()`, line 103) and is never canonicalized, so it carries no
`\\?\` prefix. **Do not touch it.** Only the `-i` value (line 168) is wrong.

The hash key (line 156) is computed from the verbatim string and must **stay**
verbatim — it is an internal cache key never handed to ffmpeg, and keeping it
verbatim matches the sibling lane (see exemplar below). Changing it would
needlessly re-key every cached comms WAV.

### The helper — `src-tauri/src/tool_path.rs:26-37`

```rust
/// Strip the `\\?\` extended-length (verbatim) prefix that `fs::canonicalize`
/// returns on Windows. ffmpeg AND ffprobe both reject the verbatim form
/// ("Error opening input: Invalid argument") ...
pub fn native_str(s: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") { return format!(r"\\{rest}"); }
        if let Some(rest) = s.strip_prefix(r"\\?\") { return rest.to_string(); }
    }
    s.to_string()
}
```

`native_str` takes `&str`, returns `String`, and is a no-op off-Windows and on
already-plain paths. There is also `native_path(&Path) -> PathBuf` for `Path`
arguments (used by the opener audit in Step 2).

### The exemplar to mirror — `src-tauri/src/parsers/video_transcode.rs`

The player/editor remux lane does exactly the right thing. Match this pattern
**including the comment**:

```rust
// video_transcode.rs:203-206
    args.push("-i".into());
    // `\\?\`-strip: canonicalize() hands the editor remux (and player transcode)
    // a verbatim path that ffmpeg rejects as "Invalid argument" on Windows.
    args.push(crate::tool_path::native_str(abs));
```

```rust
// video_transcode.rs:409-410
    args.push("-i".into());
    args.push(crate::tool_path::native_str(&abs)); // `\\?\`-strip (Windows ffprobe/ffmpeg reject verbatim)
```

Note in the exemplar the ffmpeg **-i** arg is `native_str`-stripped while the
cache key upstream (`media.rs:169`, `canonical.display().to_string()`) stays
verbatim — precisely the asymmetry to preserve in coaching.rs.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/coaching.rs` | empty (no drift) |
| Compile | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0, no errors |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | all pass |
| Confirm no verbatim `-i` remains | `grep -n "canonical.to_string_lossy().into_owned()" src-tauri/src/commands/coaching.rs` | only line ~87 (the opener, handled in Step 2) — NOT line ~168 |

**Never** run `cargo test --lib` — it SIGTERMs in this repo. Always `--tests`.

Run all `cargo` commands from the repo root
(`C:\Users\malth\Code\mortar-pestle`); the manifest path is relative to it.

## Scope

**In scope** (the only files you should modify):
- `src-tauri/src/commands/coaching.rs` — Step 1 (line ~168 ffmpeg fix) and, only
  if Step 2's investigation shows a failure, the opener at line ~87.
- `src-tauri/src/commands/media.rs` — only if Step 2's investigation shows the
  opener rejects verbatim paths (lines ~305, ~334).

**Out of scope** (do NOT touch, even though they look related):
- `src-tauri/src/parsers/video_transcode.rs`, `parsers/probe_cache.rs`,
  `media_server.rs` — already apply `native_str`/`native_path` correctly; they
  are the exemplars, not targets.
- `src-tauri/src/commands/stt.rs:661` (`stt_reveal_model`) and
  `src-tauri/src/commands/broadcast.rs:157` (`broadcast_open_log`) — these
  opener calls pass **constructed** paths (`model_cache_path(...)` /
  `engine_log_path()`), never `canonicalize`d, so they carry no `\\?\` prefix.
  Not affected. Leave them.
- The entire `mortar-pestle-broadcast/` subtree — it is dirty in the working tree
  (an unrelated in-progress Linux port). Do not stage or commit it.
- `coaching.rs` line ~419 stale systemd comment — that belongs to Plan 016.
- The hash key at `coaching.rs:156` — must stay verbatim (see Current state).

## Git workflow

- Branch: `advisor/003-coaching-verbatim-paths` off the current HEAD.
- One commit for the ffmpeg fix; a second commit only if Step 2 lands an opener
  change. Conventional-commit style, e.g.
  `fix(coaching): strip \\?\ verbatim prefix before ffmpeg -i on Windows`.
- The working tree is already dirty under `mortar-pestle-broadcast/`. Commit **only**
  your in-scope files — use explicit `git add <path>` per file, never `git add -A`
  (a repo commit helper bundles the whole dirty tree; do not use it here).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Strip the verbatim prefix on the ffmpeg `-i` argument

In `src-tauri/src/commands/coaching.rs`, replace the line-168 argv element
(currently `canonical.to_string_lossy().into_owned(),`) with a `native_str`
wrap, mirroring `video_transcode.rs:206` including the explanatory comment:

```rust
        "-i".into(),
        // `\\?\`-strip: canonicalize() hands ffmpeg a Windows verbatim path it
        // rejects as "Invalid argument". Mirrors video_transcode.rs:206/410.
        crate::tool_path::native_str(&canonical.to_string_lossy()),
```

`native_str` returns `String`, so it slots directly into the `Vec<String>` (no
`.into()`). Leave line 156 (hash) and line 177 (output `partial`) unchanged.

**Verify**:
- `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass.
- `grep -n "native_str" src-tauri/src/commands/coaching.rs` → shows your new
  line inside `coaching_extract_audio`.

> **Headless cannot prove the runtime fix.** Compilation confirms only that the
> call is well-formed. The real proof is a Windows GUI run: `npm run tauri dev`,
> open the Deadlock Scrim Coaching viewer, run **Extract Comms** on a real `.mp4`
> recording, and confirm it produces a WAV and proceeds to transcription instead
> of erroring with `ffmpeg comms exit ... Invalid argument`. State explicitly in
> your report whether you performed this manual check or could not (no GUI / no
> sample recording).

### Step 2: Investigate the opener call sites (do NOT blindly change)

The Tauri opener plugin is handed canonicalized (verbatim) paths in three
places. Explorer/ShellExecute have historically rejected verbatim paths, but
these are exercised core features, so the opener **may** tolerate the prefix.
Determine empirically before changing anything:

Call sites (all pass a `\\?\` path on Windows):
- `coaching.rs:86-88` — `app.opener().open_path(canonical.to_string_lossy().into_owned(), None::<&str>)`
- `media.rs:333-335` — `app.opener().open_path(canonical.to_string_lossy().into_owned(), None::<&str>)`
- `media.rs:304-306` — `app.opener().reveal_item_in_dir(&canonical)`

**Investigate on Windows** (`npm run tauri dev`): trigger each —
1. `open_path`: in the Library, open a media file whose canonical path resolves
   with the `\\?\` prefix (any normal `C:\Users\...` file qualifies).
2. `reveal_in_files` → `reveal_item_in_dir`: use a tree sidebar "Reveal in
   files" on a single file.

Then branch:

- **If the opener works** (file opens / Explorer highlights it): add a one-line
  comment at each of the three sites recording that the opener tolerates
  verbatim paths, so this isn't re-flagged. Example:
  `// opener tolerates the \\?\ verbatim path (verified 2026-07 Win11); no native_str needed.`
  Make **no** functional change. This is the expected outcome.

- **If any opener call fails** on the verbatim path: wrap that site's path,
  reusing the same helpers:
  - `open_path` sites (`coaching.rs:87`, `media.rs:334`):
    `open_path(crate::tool_path::native_str(&canonical.to_string_lossy()), None::<&str>)`
  - `reveal_item_in_dir` site (`media.rs:305`):
    `reveal_item_in_dir(&crate::tool_path::native_path(&canonical))`
    (`native_path` takes `&Path`, returns `PathBuf`.)

**Verify**: `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0. Report
which branch you took and the observed opener behavior on Windows.

## Test plan

- No new unit test is warranted: `native_str`'s prefix-stripping is already
  covered by `tool_path.rs::native_str_strips_verbatim_prefix_on_windows`
  (lines 71-87), and the coaching fix is a one-line reuse of that verified
  helper — the failure mode is a real-ffmpeg/real-file runtime condition that a
  headless unit test cannot reproduce. (Adding an argv-builder test would
  require extracting the inline `args` vec into a helper — out of scope for a
  P0 one-liner; note it as a maintenance follow-up if you think it's worth it.)
- Regression coverage is the manual Windows GUI check in Step 1.
- Existing suite must stay green: `cargo test --manifest-path src-tauri/Cargo.toml --tests`.

## Done criteria

ALL must hold:

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` exits 0.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0.
- [ ] `coaching.rs` line ~168 ffmpeg `-i` value is wrapped in
      `crate::tool_path::native_str`.
- [ ] Step 2 investigation is done and its outcome (tolerant → comments, or
      failing → wrapped) is recorded in the report.
- [ ] No files outside the in-scope list are modified — `git status` shows only
      your in-scope file(s) plus the pre-existing `mortar-pestle-broadcast/` dirt you
      did not create.
- [ ] Report states whether the Windows GUI Extract-Comms check was performed.

## STOP conditions

Stop and report (do not improvise) if:

- `coaching.rs` around lines 147-178 no longer matches the "Current state"
  excerpt (the argv shape or the `-i` line has changed since `57a6c80`).
- `crate::tool_path::native_str` no longer exists or changed signature.
- `cargo check` or `cargo test` fails twice after a reasonable fix attempt.
- Step 2 investigation is impossible (no Windows GUI available): land Step 1,
  leave the opener sites untouched, and report Step 2 as deferred — do NOT guess.

## Maintenance notes

- `coaching.rs` is also edited by **Plan 016** (a stale systemd comment at line
  ~419). The two edits touch disjoint lines, but if both plans run, re-read the
  file before editing so neither clobbers the other. This P0 plan should land
  first.
- Any future ffmpeg/ffprobe/opener call that starts from `fs::canonicalize` on
  Windows needs the same `native_str`/`native_path` treatment — this is now the
  fourth such site. If a fifth appears, consider whether the canonicalize +
  strip belongs in a shared helper.
- Reviewer should confirm the hash key (line 156) and output path (line 177)
  were left verbatim, and that only the `-i` value changed.
