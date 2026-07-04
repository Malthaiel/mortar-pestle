# Plan 015: Drain child stderr and stop swallowing the download status write

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md` **if that file exists** (it may not yet — do not create it).
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/library_import.rs src-tauri/src/commands/anime_download.rs`
> If either file changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Three background job engines spawn Python helper scripts and read their pipes.
Two of them can **deadlock**, and one **silently swallows a write failure**:

- **Deadlock (A).** A child process whose stdout you drain to EOF while never
  servicing its stderr pipe will block forever once it writes more than the OS
  pipe buffer (~64 KB) to stderr — a large traceback or verbose warnings is
  enough. The child blocks on the stderr write, never closes stdout, and the Rust
  reader awaits stdout EOF forever. There is no timeout on these reads, so the job
  hangs indefinitely with no signal to the user. `library_import.rs` pipes stderr
  at four spawn sites and **never reads it**; `anime_download.rs` reads stdout to
  EOF and *then* stderr **sequentially**, so the second pipe isn't serviced while
  the first drains — same failure mode.
- **Swallowed write (B).** When an anime download completes,
  `set_download_status` rewrites the card's `Download Status:` line but discards
  the write `Result` (`let _ = atomic_write(...)`). If that write fails, the job
  reports success while the card's status line stays stale (`Queued`/incomplete)
  with **no log, no signal** — a silent lie on the card.

These are cheap, mechanical fixes at the exact sites, and they harden the two
import/download engines that routinely shell out to Python.

## Current state

### Finding A1 — `library_import.rs`: stderr piped but never drained (4 sites)

`grep -n "stderr" src-tauri/src/commands/library_import.rs` returns **exactly
four** lines, all identical, and there is **no** `child.stderr.take()` anywhere in
the file (verified — the grep of `stderr` returns only these four spawn-config
lines):

```
302:    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
536:    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
590:    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
756:    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
```

Each site drains **only** stdout to EOF, then `child.wait().await`. Example —
`process_music_job` phase 1 (`library_import.rs:316-343`):

```rust
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // ... parse NDJSON on stdout ...
        }
    }
    let _ = child.wait().await;   // stderr never touched → deadlock if it fills
```

The four sites and their scripts:

| Line | Function | Script |
|---|---|---|
| 302 | `process_music_job` phase 1 | `import_music_parse.py` |
| 536 | `spawn_album_card` | `download_album.py --metadata-only` |
| 590 | `process_mal_job` phase 1 | `import_mal_parse.py` |
| 756 | `spawn_anime_card` | `download_anime.py --metadata-only` |

**stderr is genuinely unused** here: these engines surface errors via **stdout
NDJSON** — the scripts emit `{"event":"error","message":...}` on stdout, parsed at
`library_import.rs:338` and `:616`. Nothing reads stderr, so nulling it discards
nothing that's currently consumed and removes the deadlock.

### Finding A2 — `anime_download.rs`: stdout-then-stderr drained sequentially

`process_job` phase 1 reads stdout fully, **then** stderr fully
(`anime_download.rs:712-720`):

```rust
    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut stdout).await;   // drains stdout to EOF ...
    }
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr).await;   // ... only THEN starts stderr
    }
    let _ = child.wait().await;
```

If the child fills its stderr pipe buffer while the first `read_to_string` is
still draining stdout, the child blocks on the stderr write and never closes
stdout — the first read awaits forever. Here stderr **is** used: its tail becomes
the error message when the script prints no parseable result
(`anime_download.rs:739` `let tail = stderr.lines().last()...`), so it must be
**drained concurrently**, not nulled.

This is the **only** sequential-drain spot in `anime_download.rs`. The other three
child spawns in that file already avoid it: `anime_torrent_search`
(`anime_download.rs:308`), `qbit_run` (`:350`), and `poll_state` (`:937`) all set
`.stderr(Stdio::null())` and use `cmd.output().await`, which reads both pipes
concurrently internally. Leave those alone.

### Finding B — `anime_download.rs`: swallowed status write

`set_download_status` rewrites the card's `Download Status:` line and drops the
`Result` (`anime_download.rs:974-997`):

```rust
fn set_download_status(series_rel: &str, status: &str) {
    let abs = PathBuf::from(vault::library_vault_root()).join(series_rel);
    let Ok(text) = std::fs::read_to_string(&abs) else { return };
    // ... rebuild lines, replacing the "Download Status:" line ...
    let mut new = lines.join("\n");
    if text.ends_with('\n') { new.push('\n'); }
    let _ = atomic_write(&abs, new.as_bytes());   // Result discarded — silent on failure
}
```

Called on completion with `"Complete"` (`anime_download.rs:866`) and on failure
with `"Failed"` (`:1084`). A failed write here means the card lies about its state
with no trace. `atomic_write` returns `Result<(), VaultError>`
(`src-tauri/src/commands/vault.rs:413`); `VaultError` is `Debug` (already
formatted with `{e:?}` at `manifest_gen.rs:205`). The `log` crate is already in
use throughout this file (e.g. `anime_download.rs:1069` `log::warn!`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | compiles; all tests pass. **NEVER pass `--lib`** — it SIGTERMs in this repo. |
| Rust compile check | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0, no errors |
| Grep gates | `grep -n "<pattern>" <file>` | as stated per step |

`tokio::join!` is available — `src-tauri/Cargo.toml:30` enables the `macros`
feature. `AsyncReadExt` (for `read_to_string`) is already imported at
`anime_download.rs:29`.

## Scope

**In scope** (the only files you may modify):
- `src-tauri/src/commands/library_import.rs` — null the 4 unused stderr pipes.
- `src-tauri/src/commands/anime_download.rs` — concurrent drain in `process_job`;
  log the swallowed write in `set_download_status`.

**Out of scope** (do NOT touch):
- `src-tauri/src/commands/music_download.rs` — this is the **documented-safe
  baseline**. Its `process_job` uses the same sequential stdout-then-stderr drain
  (`music_download.rs:330-347`) but carries a comment asserting the script keeps
  yt-dlp/ffmpeg output internal so stderr never fills first
  (`music_download.rs:330-332`). Leave it. (Optionally, you may add a one-line
  comment there cross-referencing this invariant — nothing else.)
- The Python scripts themselves.
- The other three concurrent-safe spawns in `anime_download.rs`
  (`anime_torrent_search`, `qbit_run`, `poll_state`) — already correct.

## Git workflow

- Conventional Commits (from `git log`). Suggested: `fix(download): drain child
  stderr and log status write failure`.
- Present the three edits as **independent** — each can land and be verified on
  its own. Branch `advisor/015-child-process-io` unless the operator says
  otherwise. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Null the unused stderr pipes in `library_import.rs` (Finding A1)

At **all four** sites (lines 302, 536, 590, 756), change `.stderr(Stdio::piped())`
to `.stderr(Stdio::null())`. The line is byte-identical at each site:

```rust
// before
cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
// after
cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
```

Do all four (they are the same bug in the same file — fix once, everywhere it
routes). Errors still reach the user via stdout NDJSON, unchanged.

**Verify**:
- `grep -n "stderr(Stdio::piped())" src-tauri/src/commands/library_import.rs` →
  **0 matches**.
- `grep -n "stderr(Stdio::null())" src-tauri/src/commands/library_import.rs` →
  **4 matches**.
- `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0.

### Step 2: Drain stdout + stderr concurrently in `anime_download.rs` `process_job` (Finding A2)

Replace the sequential read block (`anime_download.rs:712-720`) with a concurrent
`tokio::join!` so neither pipe can wedge the other:

```rust
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) {
        let _ = tokio::join!(
            out.read_to_string(&mut stdout),
            err.read_to_string(&mut stderr),
        );
    }
    let _ = child.wait().await;
```

The two futures borrow separate buffers (`stdout`, `stderr`) — no aliasing, it
compiles. `tokio::join!` polls both to completion, so a full stderr pipe drains in
parallel with stdout. (Both pipes are always piped at
`anime_download.rs:693-695`, so both `take()`s are `Some`; the combined `if let`
guard matches current behavior.)

**Verify**:
- `grep -n "tokio::join!" src-tauri/src/commands/anime_download.rs` → **1 match**.
- `grep -c "read_to_string" src-tauri/src/commands/anime_download.rs` → still
  **2** (both reads preserved, now concurrent).
- `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0.

### Step 3: Log the swallowed status write in `anime_download.rs` `set_download_status` (Finding B)

Replace the discard at `anime_download.rs:996`:

```rust
// before
    let _ = atomic_write(&abs, new.as_bytes());
// after
    if let Err(e) = atomic_write(&abs, new.as_bytes()) {
        log::warn!("set_download_status: failed to write {}: {e:?}", abs.display());
    }
```

Best-effort stays best-effort (no early return, no error propagation) — but the
failure is no longer silent. `log::warn!` is already used in this file
(`anime_download.rs:1069`); `VaultError` is `Debug`.

**Verify**:
- `grep -n "let _ = atomic_write" src-tauri/src/commands/anime_download.rs` →
  **0 matches**.
- `grep -n "set_download_status: failed to write" src-tauri/src/commands/anime_download.rs`
  → **1 match**.
- `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0.

## Test plan

- **No new automated tests.** The deadlock reproduces only with a child that
  writes **>64 KB to stderr while its stdout stays open** — there is no fixture or
  harness for spawning such a child in this repo, and building one (a throwaway
  Python script + a live spawn) is out of proportion to a mechanical pipe-config
  fix. **State this explicitly** rather than inventing a brittle test. The fixes
  are verified by compile + the grep gates above; the behavioral guarantee is
  structural (a nulled or concurrently-drained pipe cannot wedge).
- Run the existing suite to confirm nothing regressed:
  `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass.
- Optional sanity (not required): trigger a normal MAL import and a normal anime
  download in `npm run tauri dev`; both should complete as before (the fixes are
  transparent on the happy path).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` exits 0.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0; all
      existing tests pass.
- [ ] `grep -n "stderr(Stdio::piped())" src-tauri/src/commands/library_import.rs`
      → 0 matches; `stderr(Stdio::null())` → 4 matches.
- [ ] `grep -n "tokio::join!" src-tauri/src/commands/anime_download.rs` → 1 match.
- [ ] `grep -n "let _ = atomic_write" src-tauri/src/commands/anime_download.rs`
      → 0 matches.
- [ ] `music_download.rs` is unchanged except (optionally) a single added comment
      line (`git diff --stat src-tauri/src/commands/music_download.rs`).
- [ ] No files outside the in-scope list modified (`git status`).

## STOP conditions

Stop and report (do not improvise) if:

- **The cited lines no longer match** — e.g. `anime_download.rs:712-720` already
  drains concurrently, `library_import.rs` already nulls or drains stderr, or
  `set_download_status` already handles the `Result`. The bug was fixed
  independently; mark this plan's row REJECTED with that note instead of editing.
- The `library_import.rs` grep for `stderr` returns **more than four** lines, or
  any `child.stderr.take()` appears there — that means a site now *consumes*
  stderr and nulling it would drop consumed output. Report which site; do NOT
  null a stderr that is read.
- `tokio::join!` fails to compile (would indicate the `macros` feature was removed
  from `Cargo.toml` — check `src-tauri/Cargo.toml:30`).
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this next:

- The **root cause is "spawn a child, pipe a stream, forget to drain it"** — a
  recurring shape across these engines. New Python-helper spawns should either
  `.stderr(Stdio::null())` (when stderr is unused) or drain both pipes
  concurrently (`tokio::join!` or `cmd.output().await`) — **never** drain
  sequentially unless the script guarantees bounded stderr, as
  `music_download.rs:330-332` documents for its one case.
- `music_download.rs` is deliberately left on the sequential drain because its
  comment records why it's safe (script keeps yt-dlp/ffmpeg output internal). If
  that script ever starts letting subprocess output reach its own stderr, that
  file inherits the A2 deadlock and should get the same `tokio::join!` treatment.
- A reviewer should confirm Step 1 didn't remove a stderr read anywhere (it
  didn't — none existed) and that Step 2 preserved both reads (still 2
  `read_to_string`), just made them concurrent.
