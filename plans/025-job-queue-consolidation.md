# Plan 025: Extract the shared job-queue skeleton from the three download/import families

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/music_download.rs src-tauri/src/commands/library_import.rs src-tauri/src/commands/anime_download.rs modules/core/library`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L (ship per-domain; the Rust half and the frontend half are independent)
- **Risk**: MED (process-global concurrency code — a mistake strands a python child or deadlocks the queue)
- **Depends on**: none (Step 0 characterization tests are recommended first, inside this plan)
- **Category**: tech-debt
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Three engines — music download, anime download, library import — each
independently re-implement the same background-job queue: a process-global
`Mutex<{ jobs: Vec<Job>, worker_running: bool }>`, an `AtomicU64` id counter, a
`_status` command that byte-for-byte clones the job list, a `_cancel` command
that flips a queued job to Cancelled or SIGTERMs the active python child, and a
`send_signal` + SIGTERM→grace→SIGKILL kill sequence that is **character-identical
across all three files**. A fix to cancel semantics (say, the grace period, or a
Windows kill bug) today must be hand-ported to two more files, with **no test to
catch a missed port**. This plan pulls the genuinely-shared, low-risk bookkeeping
into one `job_queue.rs` so the kill sequence and status snapshot have exactly one
home, and does it incrementally so the app builds and passes tests after every
step.

**Read this honestly before starting**: the three engines are *not* as identical
as "three copies of one file". Their `Job` structs are completely different
(music tracks vs anime torrents vs import counts), and — critically — their
**state enums differ**: music is `Queued/Downloading/Done/Error/Cancelled`,
import is `Queued/Parsing/Importing/Done/Error/Cancelled`, anime is
`Queued/Preparing/Downloading/Done/Error/Cancelled`. So a single shared `Job`
type or `JobState` enum is **not** achievable without a trait, and the generic
`cancel()`/`recompute_positions()` (which must decide "is this state a
cancellable-queued / cancellable-active / terminal state?") is where the real
divergence lives. This plan therefore extracts only what is provably safe first
(the kill helper + the generic queue container + the `status` snapshot) and
scopes the trait-based `cancel`/worker generalization as a gated final step that
STOPS rather than forcing anime's already-refactored path to fit.

## Current state

### The three Rust engines (all under `src-tauri/src/commands/`)

- `music_download.rs` — music album download queue. Emits `music-download-*` events.
- `library_import.rs` — CSV/MAL-XML → library-card import queue. Emits `library-import-*`.
- `anime_download.rs` — anime torrent download queue (2-phase: prepare + poll qBittorrent). Emits `anime-download-*`.

They are declared flat in `src-tauri/src/commands/mod.rs`:

```
1  pub mod anime_download;
38 pub mod library_import;
41 pub mod music_download;
```

**The process-kill sequence is byte-identical in all three.** `music_download.rs:236-247`:

```rust
    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            send_signal(pid, libc::SIGTERM);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(CANCEL_GRACE_MS)).await;
                send_signal(pid, libc::SIGKILL);
            });
        }
        #[cfg(not(unix))]
        crate::commands::proc_util::terminate_pid(pid);
    }
```

The same block is `library_import.rs:230-241` and `anime_download.rs:270-281`.
`send_signal` (unix) is identical in all three (`music_download.rs:89-94`,
`library_import.rs:83-88`, `anime_download.rs:103-108`):

```rust
#[cfg(unix)]
fn send_signal(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}
```

`#[cfg(unix)] const CANCEL_GRACE_MS: u64 = 2000;` appears in all three
(`music_download.rs:25`, `library_import.rs:28`, `anime_download.rs:35`).

**The `_status` command is identical modulo the static's name.**

`music_download.rs:207-211`:
```rust
#[tauri::command]
pub fn music_download_status() -> Vec<DownloadJob> {
    let g = DOWNLOAD_STATE.lock().unwrap();
    g.jobs.clone()
}
```
`library_import.rs:205-209` is the same with `IMPORT_STATE`/`ImportJob`;
`anime_download.rs:226-230` is the same with `DOWNLOAD_STATE`/`DownloadJob`.

**The queue container shape is identical.** `music_download.rs:78-87`:
```rust
struct DownloadState {
    jobs: Vec<DownloadJob>,
    worker_running: bool,
}
static DOWNLOAD_STATE: Mutex<DownloadState> = Mutex::new(DownloadState {
    jobs: Vec::new(),
    worker_running: false,
});
static JOB_SEQ: AtomicU64 = AtomicU64::new(1);
```
`library_import.rs:72-81` (`ImportQueue`) and `anime_download.rs:92-101`
(`DownloadState`) are structurally identical. `snapshot(job_id)` (find-by-id +
clone) is identical too: `music_download.rs:132-135`, `library_import.rs:108-111`,
`anime_download.rs:143-146`.

### The DRIFT this plan must respect

1. **`_cancel` is inline+identical in music and library, but extracted in anime.**
   `music_download_cancel` (`music_download.rs:213-249`) and
   `library_import_cancel` (`library_import.rs:211-243`) inline the whole
   Queued→Cancelled / active→SIGTERM logic. But `anime_download_cancel`
   (`anime_download.rs:232-244`) delegates to a **reusable** `cancel_job_inner`
   (`anime_download.rs:250-282`) precisely because `anime_uninstall`
   (`anime_download.rs:457`) calls it to stop in-flight jobs before deleting
   torrents. Any generic cancel must preserve `anime_uninstall`'s ability to
   cancel a job *while already holding the queue lock* (it calls
   `cancel_job_inner(&mut guard, &jid)` at `anime_download.rs:449-459`).

2. **Only music + anime track queue positions; library does not.** Music's
   cancel Queued-branch calls `recompute_queue_positions` (`music_download.rs:223`),
   and music has `recompute_queue_positions` at `music_download.rs:117-130`. Anime
   has its own `recompute_queue_positions` at `anime_download.rs:130-141` (note:
   music sets non-active positions via `match … _ => {}` leaving stale values;
   anime explicitly zeroes them — a subtle behavioral difference, do not
   "unify" it away without checking the UI). **`library_import.rs` has no
   `recompute_queue_positions` and `ImportJob` has no `queue_position` field** —
   its cancel Queued-branch is just `job.state = ImportState::Cancelled;` with no
   recompute (`library_import.rs:219-222`).

3. **Constants diverge.** Anime adds `POLL_INTERVAL_SECS`/`MAX_EMPTY_POLLS`/
   `MAX_POLLS` (`anime_download.rs:36-38`); library adds
   `MB_THROTTLE_MS` (`library_import.rs:31`). These are domain-specific — leave
   them in their files.

### The three frontend providers (all under `modules/core/library/`)

- `music/DownloadProvider.jsx` — imports `musicApi` from `./api.js`; listens
  `music-download-progress`/`-done`; hydrate filter `state === 'queued' || 'downloading'`;
  re-broadcasts `music-library-changed`.
- `ImportProvider.jsx` — imports `libraryImportApi` from `./api.js`; listens
  `library-import-progress`/`-done`; hydrate filter `ACTIVE = {queued,parsing,importing}`;
  re-broadcasts `music-library-changed` + `video-library-changed`.
- `AnimeDownloadProvider.jsx` — imports `videoApi` from `./api.js`; listens
  `anime-download-progress`/`-done`; hydrate filter `state !== 'done' && !== 'cancelled'`;
  re-broadcasts `video-library-changed`; `enqueue` has an extra qBittorrent
  pre-flight (`AnimeDownloadProvider.jsx:80-98`).

All three share this exact skeleton (shown from `music/DownloadProvider.jsx:41-72`):
```jsx
const [jobs, setJobs] = useState([]);
useEffect(() => {                         // hydrate on mount
  let cancelled = false;
  musicApi.downloadStatus()
    .then(j => { if (!cancelled) setJobs((j || []).filter(/* active */)); })
    .catch(() => {});
  return () => { cancelled = true; };
}, []);
useEffect(() => {                         // upsert on progress, re-broadcast on done
  const upsert = (job) => setJobs(prev => { /* findIndex → replace or append */ });
  const pProgress = listen('<domain>-progress', (e) => { if (e.payload?.id) upsert(e.payload); });
  const pDone = listen('<domain>-done', (e) => { window.dispatchEvent(/* library-changed */); });
  return () => { pProgress.then(f=>f()); pDone.then(f=>f()); };
}, []);
```
Plus a `notified` ref + effect firing one `agentic:notify` per terminal job
(`music/DownloadProvider.jsx:78-95`, `AnimeDownloadProvider.jsx:57-74`,
`ImportProvider.jsx:77-92`) — the **notification payload differs per provider**
(different accent/message/action), so that effect stays per-provider.

### Conventions to honor

- Rust command modules are plain files under `src-tauri/src/commands/`, added to
  `mod.rs` (see excerpt above). A **non-command helper module** (like the new
  `job_queue.rs`) is added the same way but has **no** `#[tauri::command]` fns,
  so it needs **no** entry in `lib.rs` / `build.rs` / `capabilities/default.json`.
- Inline tests use `#[cfg(test)] mod tests { … }` in the same file — e.g.
  `src-tauri/src/commands/vault.rs:651` (`#[test]`). There is **no**
  `src-tauri/tests/` integration directory; do not create one.
- `crate::commands::proc_util::terminate_pid(pid)` and `python_cmd()` are the
  existing cross-platform process helpers — reuse them, do not reinvent.

## Commands you will need

| Purpose            | Command                                                                   | Expected on success           |
|--------------------|---------------------------------------------------------------------------|-------------------------------|
| Rust tests         | `cargo test --manifest-path src-tauri/Cargo.toml --tests`                 | exit 0, all pass              |
| Rust build check   | `cargo build --manifest-path src-tauri/Cargo.toml`                        | exit 0, no errors             |
| Web build          | `npm --prefix web run build`                                              | exit 0, `web/dist` written    |
| Dev run (manual)   | `npm run tauri dev`                                                       | Vite at 127.0.0.1:5173 + window |

> NEVER run `cargo test --lib` for this repo — it SIGTERMs. Always `--tests`.

## Scope

**In scope:**
- `src-tauri/src/commands/job_queue.rs` (create)
- `src-tauri/src/commands/mod.rs` (add `pub mod job_queue;`)
- `src-tauri/src/commands/music_download.rs`
- `src-tauri/src/commands/library_import.rs`
- `src-tauri/src/commands/anime_download.rs`
- Frontend half (independent, can ship separately):
  - `modules/core/library/useJobQueue.js` (create)
  - `modules/core/library/music/DownloadProvider.jsx`
  - `modules/core/library/ImportProvider.jsx`
  - `modules/core/library/AnimeDownloadProvider.jsx`

**Out of scope (do NOT touch):**
- `src-tauri/src/lib.rs`, `build.rs`, `capabilities/default.json` — the command
  **names and signatures do not change**, so the 3-site ACL registration stays
  intact. `job_queue.rs` exports no commands. If you find yourself editing these,
  STOP — you have changed a command surface you were not meant to.
- Anime's Phase-2 qBittorrent poll loop (`anime_download.rs:611-881`), the
  MusicBrainz/Jikan resolution logic, and every domain-specific `process_job` —
  the *work* each worker does is not shared and must not be genericized.
- `anime_uninstall` behavior (`anime_download.rs:400-609`) — it may only change
  in the mechanical sense of calling a relocated `cancel_job_inner`; its
  torrent/RSS/bin semantics must not change.

## Git workflow

- Branch: `advisor/025-job-queue-consolidation`.
- Commit per step (each step leaves the tree building + tests green).
- Commit message style — match repo, e.g. `refactor(jobs): extract shared kill_child_graceful into job_queue.rs`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0 (recommended): characterize the pure decision logic before moving it

The spawn/python/qBittorrent paths are not unit-testable without fake scripts —
**do not** try to test them. Instead pin the *pure* helpers that later steps
touch, so a regression is caught. Add a `#[cfg(test)] mod tests` block to
`music_download.rs` (model after `vault.rs:651`) covering `recompute_queue_positions`:
build a `DownloadState` with a Downloading job + two Queued jobs + one Done job,
call `recompute_queue_positions`, assert the Downloading job's `queue_position == 0`
and the two Queued jobs get `1` and `2` in order. This documents the current
behavior the generic version must reproduce.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → exit 0,
the new test passes.

### Step 1: extract the process-kill sequence into `job_queue.rs`

Create `src-tauri/src/commands/job_queue.rs` with the byte-identical kill logic,
lifted verbatim (this is a pure move — zero behavior change, zero state coupling):

```rust
//! Shared background-job-queue primitives for the download/import engines
//! (music_download, anime_download, library_import). Non-command helper module —
//! exports NO #[tauri::command], so it needs no lib.rs / build.rs / capabilities
//! registration.

#[cfg(unix)]
const CANCEL_GRACE_MS: u64 = 2000;

#[cfg(unix)]
fn send_signal(pid: u32, sig: i32) {
    unsafe { libc::kill(pid as i32, sig); }
}

/// SIGTERM a python child, SIGKILL after a grace period (unix); terminate_pid on
/// Windows. The in-flight child may finish its current unit before exiting; no
/// new work starts. Lifted verbatim from the three engines' cancel paths.
pub fn kill_child_graceful(pid: u32) {
    #[cfg(unix)]
    {
        send_signal(pid, libc::SIGTERM);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(CANCEL_GRACE_MS)).await;
            send_signal(pid, libc::SIGKILL);
        });
    }
    #[cfg(not(unix))]
    crate::commands::proc_util::terminate_pid(pid);
}
```

Add `pub mod job_queue;` to `src-tauri/src/commands/mod.rs` (alphabetical — after
`pub mod health;` / before `pub mod knowledge;`, matching the existing ordering).

Then in each of the three engines, replace the inline
`if let Some(pid) = pid { … }` kill block with
`if let Some(pid) = pid { crate::commands::job_queue::kill_child_graceful(pid); }`
and delete that file's now-unused `send_signal` fn and `#[cfg(unix)] const CANCEL_GRACE_MS`.
Target sites: `music_download.rs:236-247` (+ delete `:89-94`, `:24-25`),
`library_import.rs:230-241` (+ delete `:83-88`, `:27-28`),
`anime_download.rs:270-281` (+ delete `:103-108`, `:34-35`).

Watch for now-unused imports after the deletion — `use std::time::Duration;` may
become unused in a file if `Duration` was only used by the kill block (check each;
`library_import.rs` and `anime_download.rs` also use `Duration` for throttle/poll
sleeps, so it stays there; `music_download.rs`'s `#[cfg(unix)] use std::time::Duration;`
at line 17-18 becomes removable).

**Verify**:
`cargo build --manifest-path src-tauri/Cargo.toml` → exit 0, **no unused-import or
dead-code warnings** for the three files.
`cargo test --manifest-path src-tauri/Cargo.toml --tests` → exit 0.

### Step 2: extract a generic queue container + `status`/`snapshot`

Add to `job_queue.rs`:

```rust
use std::sync::Mutex;

/// The process-global queue shape shared by every engine: an ordered job list +
/// a single-worker-running latch.
pub struct Queue<J> {
    pub jobs: Vec<J>,
    pub worker_running: bool,
}

impl<J> Queue<J> {
    pub const fn new() -> Self {
        Queue { jobs: Vec::new(), worker_running: false }
    }
}

/// Snapshot all jobs for provider hydration (the `_status` command body).
pub fn status<J: Clone>(state: &Mutex<Queue<J>>) -> Vec<J> {
    state.lock().unwrap().jobs.clone()
}

/// Find a job by an `id`-returning predicate and clone it.
pub fn snapshot<J: Clone>(state: &Mutex<Queue<J>>, matches: impl Fn(&J) -> bool) -> Option<J> {
    state.lock().unwrap().jobs.iter().find(|j| matches(j)).cloned()
}
```

Migrate **one domain at a time**, verifying after each. Start with
`music_download.rs`:
- Replace `struct DownloadState { … }` + the `static DOWNLOAD_STATE: Mutex<DownloadState>`
  (`music_download.rs:78-86`) with
  `static DOWNLOAD_STATE: Mutex<crate::commands::job_queue::Queue<DownloadJob>> = Mutex::new(crate::commands::job_queue::Queue::new());`
- Rewrite `music_download_status` body (`:208-211`) to
  `crate::commands::job_queue::status(&DOWNLOAD_STATE)`.
- Rewrite `snapshot` (`:132-135`) to
  `crate::commands::job_queue::snapshot(&DOWNLOAD_STATE, |j| j.id == job_id)`.
- Every existing `DOWNLOAD_STATE.lock().unwrap()` still works (fields `.jobs` /
  `.worker_running` are now on `Queue`, same names) — no other change needed.

**Verify (after music)**:
`cargo build --manifest-path src-tauri/Cargo.toml` → exit 0.
`cargo test --manifest-path src-tauri/Cargo.toml --tests` → exit 0.

Then repeat for `library_import.rs` (`IMPORT_STATE` → `Queue<ImportJob>`,
`library_import_status` and `snapshot` delegated) and verify; then
`anime_download.rs` (`DOWNLOAD_STATE` → `Queue<DownloadJob>`, `anime_download_status`
and `snapshot` delegated) and verify. Anime's `cancel_job_inner`,
`recompute_queue_positions`, and `anime_uninstall` all use `guard.jobs` /
`guard.worker_running` — unchanged, they still compile against `Queue`.

### Step 3 (optional, low value — skip unless trivially clean): shared id mint

Each engine has `static JOB_SEQ: AtomicU64` + one `JOB_SEQ.fetch_add(1, …)` call
with a domain prefix (`"dl"`/`"imp"`/`"adl"`) and differing `Ordering`
(music/anime `Relaxed`, library `SeqCst`). This saves ~2 lines per file at the
cost of a helper and losing the per-domain `Ordering` intent. **Ponytail: not
worth a shared abstraction.** Leave `JOB_SEQ` per-file. (Documented so nobody
re-audits it.)

### Step 4 (GATED — the real divergence): generic cancel + recompute via a trait

This is where music and library's inline cancels *could* collapse into a shared
`cancel(&Mutex<Queue<J>>, job_id)`, but only behind a trait that maps each
domain's state enum to a lifecycle decision. Sketch:

```rust
pub enum CancelAction { AlreadyTerminal, CancelledQueued, KillActive(Option<u32>) }

pub trait JobItem {
    fn id(&self) -> &str;
    /// Decide the cancel action for this job's current state, mutating it into
    /// the Cancelled state when it was queued.
    fn cancel_in_place(&mut self) -> CancelAction;
}
```

Implement `JobItem` for music's `DownloadJob` and import's `ImportJob`, then
replace `music_download_cancel` + `library_import_cancel` bodies with a shared
`job_queue::cancel(&STATE, &job_id, /* recompute: */ true|false)`. **Preserve the
music-only `recompute_queue_positions` call** (library passes `recompute: false`
since `ImportJob` has no `queue_position`).

**STOP and scope anime OUT of Step 4** if anime's `cancel_job_inner`
(`anime_download.rs:250-282`) cannot adopt the shared `cancel` without changing
`anime_uninstall`'s behavior — `anime_uninstall` calls `cancel_job_inner` **while
already holding the queue lock** (`anime_download.rs:449-459`), whereas the shared
`cancel` acquires the lock itself. Reconciling that requires either a
lock-already-held variant or refactoring `anime_uninstall`'s locking, which risks
the "always clean up torrents" invariant. If it doesn't fit cleanly, ship Step 4
for **music + library only**, leave `anime_download.rs`'s cancel as-is, and record
anime as deferred in Maintenance notes. Do NOT force it.

**Verify (after each domain migrated in Step 4)**:
`cargo test --manifest-path src-tauri/Cargo.toml --tests` → exit 0, including the
Step 0 characterization test (proves recompute behavior is preserved).
`cargo build --manifest-path src-tauri/Cargo.toml` → exit 0.
Manual: `npm run tauri dev`, start a music download, cancel a queued item and an
active item — both must transition correctly (queued→cancelled instantly; active
python child terminates within ~2s).

### Frontend (independent — may ship as its own PR): `useJobQueue` hook

Create `modules/core/library/useJobQueue.js` capturing the shared 80% (hydrate +
upsert + listen wiring), leaving the divergent notify/enqueue in each provider:

```js
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

// Shared background-job provider skeleton. statusFn() hydrates on mount (filtered
// by isActive); progressEvent upserts by job.id; doneEvent fires onDone(payload).
export function useJobQueue({ statusFn, progressEvent, doneEvent, isActive, onDone }) {
  const [jobs, setJobs] = useState([]);
  useEffect(() => {
    let cancelled = false;
    statusFn().then(j => { if (!cancelled) setJobs((j || []).filter(isActive)); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const upsert = (job) => setJobs(prev => {
      const i = prev.findIndex(j => j.id === job.id);
      if (i === -1) return [...prev, job];
      const next = prev.slice(); next[i] = job; return next;
    });
    const pProgress = listen(progressEvent, (e) => { if (e.payload && e.payload.id) upsert(e.payload); });
    const pDone = listen(doneEvent, (e) => onDone && onDone(e.payload || {}));
    return () => { pProgress.then(f => f()).catch(() => {}); pDone.then(f => f()).catch(() => {}); };
  }, []);
  return jobs;
}
```

Migrate **one provider at a time**. `music/DownloadProvider.jsx`:
- Replace the two `useEffect`s + `useState` (`:42-72`) with
  `const jobs = useJobQueue({ statusFn: musicApi.downloadStatus, progressEvent: 'music-download-progress', doneEvent: 'music-download-done', isActive: x => x.state === 'queued' || x.state === 'downloading', onDone: (p) => window.dispatchEvent(new CustomEvent('music-library-changed', { detail: p })) });`
- Keep the `notified` ref + terminal-notification effect (`:78-95`) and
  `enqueue`/`cancel` (`:97-102`) exactly as-is.

**Verify (after each provider)**: `npm --prefix web run build` → exit 0. Then
manual `npm run tauri dev`: the migrated domain's downloads still appear, update
live, fire their completion toast, and re-list the grid on done.

Then repeat for `ImportProvider.jsx` (isActive = the `ACTIVE` set membership;
onDone dispatches BOTH `music-library-changed` and `video-library-changed`) and
`AnimeDownloadProvider.jsx` (isActive = `x.state !== 'done' && x.state !== 'cancelled'`;
onDone dispatches `video-library-changed`; keep the qBit pre-flight `enqueue`).

## Test plan

- **Step 0 characterization** (`music_download.rs` inline `#[cfg(test)] mod tests`):
  `recompute_queue_positions` assigns `0` to the Downloading job and `1,2,…` to
  Queued jobs in order. This is the regression guard for Step 4.
- After Step 4, add an analogous test asserting a Queued job → Cancelled leaves
  other queued jobs' positions renumbered (music) — the behavior the shared
  `cancel` must reproduce.
- Model all tests after `src-tauri/src/commands/vault.rs:651` (inline `#[test]`).
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all
  pass including the new tests.

## Done criteria

Machine-checkable. Whichever slices you shipped, ALL of these must hold for them:

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` exits 0 with no new warnings.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0; Step 0 test exists and passes.
- [ ] `grep -rn "send_signal" src-tauri/src/commands/` returns matches ONLY in `job_queue.rs` (Step 1 removed the three copies).
- [ ] `grep -rn "SIGKILL" src-tauri/src/commands/` returns a match ONLY in `job_queue.rs`.
- [ ] If frontend shipped: `npm --prefix web run build` exits 0; `grep -rn "findIndex(j => j.id" modules/core/library` returns matches only in `useJobQueue.js`.
- [ ] No files outside the in-scope list are modified (`git status`) — in particular `lib.rs`/`build.rs`/`capabilities/default.json` are untouched.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live code at the cited lines
  (drift since `57a6c80`).
- **Step 4 anime blocker**: anime's `cancel_job_inner` cannot adopt the shared
  `cancel` without changing `anime_uninstall`'s lock-held call site or its
  torrent-cleanup semantics. → Ship Step 4 for music + library only; report anime
  as deferred. This is an expected, acceptable outcome, not a failure.
- Any `cargo build`/`cargo test` fails twice after a reasonable fix attempt.
- Removing the per-file `send_signal`/`CANCEL_GRACE_MS` leaves a file with a
  dead-code or unused-import error you can't resolve by removing the now-unused
  `use` — report the file.
- The fix appears to require editing `lib.rs`, `build.rs`, or
  `capabilities/default.json` — that means a command surface changed, which this
  plan forbids.

## Maintenance notes

For whoever owns this after it lands:

- **The kill sequence now has one home** (`job_queue.rs::kill_child_graceful`). A
  future Windows-kill or grace-period change is a one-line edit — do not re-fork it.
- **`recompute_queue_positions` has a real behavioral difference** between music
  (`_ => {}`, leaves stale positions) and anime (`_ => j.queue_position = 0`).
  Step 4 keeps them separate deliberately; if you ever unify them, verify the
  music download panel's queue-position display against the old behavior first.
- **Anime deferred from Step 4** (if the STOP fired): its `cancel_job_inner` stays
  bespoke because `anime_uninstall` cancels under a held lock. Revisit only if
  `anime_uninstall`'s locking is refactored for another reason.
- A reviewer should scrutinize: (1) that no python child can be orphaned by the
  relocated kill path on Windows (`terminate_pid`), and (2) that the generic
  `status`/`snapshot` didn't change lock-hold duration (still clone-under-lock,
  release immediately).
- **Follow-up explicitly deferred**: the ideal end-state (a single trait-based
  `Job` skeleton the workers plug a work-closure into) is intentionally NOT
  attempted here because the three state enums and Job structs diverge; the
  per-domain `process_job` work is genuinely different. This plan stops at the
  shared bookkeeping.
