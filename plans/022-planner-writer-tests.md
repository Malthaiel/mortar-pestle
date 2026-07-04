# Plan 022: Restore planner daily-writer coverage lost in the Fastify deletion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` if that file exists — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/parsers/daily.rs src-tauri/src/parsers/sessions.rs src-tauri/src/parsers/quick_notes.rs src-tauri/tests/integration.rs`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline-and-ci.md` (establishes the SIGTERM-safe `--test integration` invocation and the `verify.mjs` aggregate that already runs the `integration` target).
- **Category**: tests
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

`src-tauri/tests/integration.rs` is the **harness-independent successor** to the
Fastify-era parity tests (`daily_writers.rs`, `daily_parity.rs`,
`sidebar_writers.rs`, `vault_io_parity.rs`) that retire when SF12 of the
Desktop-Only Migration deletes the Node baseline harness. Its own header states
the porting protocol (integration.rs:15–19):

> Pre-SF12 gate: `cargo test …` must include this file's coverage of **every
> writer command surface that has a parity counterpart**.

But only **4** tests were ported (toggle-task, freeform-note ×2, sidebar-order).
Several read-modify-write writers now have **zero** coverage, contradicting the
file's own protocol:

- `parsers::daily::update_plan_block` — the fenced-block splice (find one plan
  line inside a ` ```plan ` fence, rewrite it, leave the rest byte-for-byte).
- `parsers::sessions::delete_session` — the multi-line **block drain** that also
  returns the drained block + line hint + heading (the exact data the recycle
  bin's `RecordBlock` tombstone captures — get this wrong and a "deleted" session
  is unrecoverable or the wrong lines vanish).
- `parsers::quick_notes::locate_quick_note` — the **stale-projection guard**:
  when a frontend index no longer matches the on-disk text it must error, not
  delete the wrong bullet (wired at `commands/daily.rs:198`).

This plan ports those three writer contracts into `integration.rs` following the
protocol the file already documents, closing the regression.

## Current state

Facts inlined — the executor has not seen this repo.

### The test file and its pattern

`src-tauri/tests/integration.rs` — temp-vault integration tests. Reusable
scaffold already in the file:

- `const FIXTURE_DS: &str = "2026-05-15";`
- `fn setup_vault(initial_daily_content: &str) -> Vault` — creates a temp dir,
  writes `initial_daily_content` to `<tmp>/Pulse/Daily Logs/2026-05-15.md`, and
  sets `AGENTIC_VAULT_ROOT` to the temp root. Returns a `Vault { _dir, daily_path }`.
- `fn set_today(ds: &str)` — sets `AGENTIC_TODAY`.
- `mod common;` → `common::env_lock()` — hold it whenever a test mutates the
  process-global `AGENTIC_VAULT_ROOT` / `AGENTIC_TODAY`.

All target parsers resolve the daily file through `daily_path(ds)`, which the
existing ported test proves resolves to `<AGENTIC_VAULT_ROOT>/Pulse/Daily Logs/<ds>.md`.
So **reuse `setup_vault` verbatim** — do not invent a new fixture harness.

Modules are publicly reachable (`src-tauri/src/parsers/mod.rs`:
`pub mod daily; pub mod sessions; pub mod quick_notes;`).

### `update_plan_block` — fenced-block splice (daily.rs:252–308)

Signature and behavior (`PlanBlockInput { start, end, title }`, all `String`):

```rust
pub fn update_plan_block(ds: &str, old: PlanBlockInput, new: PlanBlockInput, base_mtime: Option<f64>) -> Result<OkOut, VaultError>
```

It scans lines, enters a fence on a trimmed ` ```plan ` line, and — for the
**first** fence line whose parsed `(start, end, title)` equals `old` — rewrites
it to `format!("{} {} {}", new.start, new.end, new.title)`, sets `replaced = true`,
and skips all further matches. Returns `OkOut { ok: false, error: Some("plan block not found"), .. }`
if nothing matched, `Some("daily note not found")` if the file is absent.
`OkOut { ok, error, mtime }` — `error` is `Option<String>`. A plan line inside the
fence has the canonical form `HH:MM HH:MM Title` (per `parse_plan_line`,
daily.rs:174–181).

### `delete_session` — block drain + capture (sessions.rs:387–439)

```rust
pub fn delete_session(ds: &str, session_id: &str, base_mtime: Option<f64>) -> Result<DeleteSessionOut, VaultError>
```

`session_id` format is `"<start>:::<end>:::<task>"` (parsed by `find_session_bullet`,
sessions.rs:183–214: split on `":::"`, needs ≥3 parts). It computes `note_block_end`
(the bullet **plus** its `  `-indented sub-note lines), captures that whole block
verbatim, then drains it (also eating one trailing blank). Returns:

```rust
pub struct DeleteSessionOut { pub ok: bool, pub error: Option<String>, pub mtime: f64,
    pub removed_block: Option<String>, pub line_hint: Option<u32>, pub heading: Option<String> }
```

`heading` comes from `session_heading_above` → `"## Sessions"` (canonical),
`"## Session"`, or `"### Sessions"`, else default `"## Sessions"`.

`append_session` (sessions.rs:301–338) is the natural fixture builder — it writes
a bullet `- <start>–<end> <task> (<task>, <dur>m)` (en-dash `\u{2013}`) and, when
`notes` is `Some(non-empty)`, one `  <line>` sub-line per note line (verified
sessions.rs:316–324), and auto-creates a `## Sessions` heading. So an
append-then-delete round-trip produces a genuine **multi-line** block to drain,
with an id you control:

```rust
pub struct SessionInput { pub task: String, pub start: String, pub end: String, pub notes: Option<String> }
pub fn append_session(ds: &str, session: SessionInput, base_mtime: Option<f64>) -> Result<OkOut, VaultError>
```

### `locate_quick_note` — pure stale-projection guard (quick_notes.rs:83–95)

This one is **pure** — no filesystem, no env, no lock:

```rust
pub fn locate_quick_note(lines: &[String], index: usize, expected_text: &str) -> Result<usize, QuickNoteLocateErr>
```

It finds the `## Quick Notes` section body, lists its bullet line indices
(trimmed `-␠…` with a non-empty body), takes the `index`-th, and — the guard —
returns `Err(QuickNoteLocateErr::TextMismatch)` if that bullet's displayed body
≠ `expected_text`. Errors: `NoSection` (no `## Quick Notes` header),
`IndexOob` (index past the bullet count), `TextMismatch` (desynced index — the
guard that stops deleting the WRONG line). The error type exposes a `.code()`
method returning `"NO_SECTION"` / `"INDEX_OOB"` / `"TEXT_MISMATCH"`
(quick_notes.rs:17–25). Section body ends at the next `## ` H2; a `### ` line does
NOT terminate it; checkbox bullets (`- [ ] x`) still count. It is wired as the
stale-guard at `src-tauri/src/commands/daily.rs:198`.

### The SIGTERM-safe cargo invocation (IMPORTANT — read `plans/002`)

Do **NOT** run `cargo test --tests` or `cargo test --lib` — per
`plans/002-verification-baseline-and-ci.md` (lines 86–104) both re-include the
library unit tests that **SIGTERM the dev sandbox**. Run this file's target
explicitly: `cargo test --manifest-path src-tauri/Cargo.toml --test integration`.
`integration` is already enumerated in `scripts/verify.mjs`, so **no verify.mjs
edit is needed** by this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 57a6c80..HEAD -- src-tauri/src/parsers/ src-tauri/tests/integration.rs` | no output (unchanged) |
| Run the integration target | `cargo test --manifest-path src-tauri/Cargo.toml --test integration` | `test result: ok. 10 passed; 0 failed` (4 existing + 6 new) |
| Confirm the 6 new tests exist | `grep -cE "fn integration_(locate_quick_note|update_plan_block|delete_session)" src-tauri/tests/integration.rs` | `6` |
| Full aggregate | `node scripts/verify.mjs` | exit 0, `✓ verify passed` |

## Scope

**In scope** (the only file you may modify):
- `src-tauri/tests/integration.rs` — **append** the six new tests (and the two
  `use` lines they need). Do not alter the four existing tests.

**Out of scope** (do NOT touch):
- Any `src-tauri/src/**` file — this plan pins existing writer behavior; it must
  not change it. If a writer looks buggy, that is a *finding to report*, not a
  fix to make here.
- `scripts/verify.mjs` — the `integration` target is already wired.
- `append_session` / `update_session` / `toggle_routine_task` **source** — see
  Maintenance notes for the deferred follow-on tests (same pattern), but do not
  add or change source here.

## Git workflow

- Branch: `advisor/022-planner-writer-tests` (or the repo's convention from `git branch -a`).
- Commit per logical unit; match the repo's commit style (`git log --oneline -10`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the imports

At the top of `src-tauri/tests/integration.rs`, alongside the existing `use`
lines, add:

```rust
use app_lib::parsers::daily::{update_plan_block, PlanBlockInput};
use app_lib::parsers::quick_notes::locate_quick_note;
use app_lib::parsers::sessions::{append_session, delete_session, SessionInput};
```

(If any import fails to resolve, the symbol moved/renamed — treat as a STOP
condition.)

**Verify**: after Step 2, `cargo test --manifest-path src-tauri/Cargo.toml --test integration` compiles.

### Step 2: Append the six tests

Append the block below to the end of `integration.rs`. (It is shown inside a
four-backtick fence because one fixture embeds a ` ```plan ` code fence.)

````rust
// ─── locate_quick_note: pure stale-projection guard (quick_notes.rs) ─────────
// No vault/env needed — operates on a &[String].

fn qn_lines() -> Vec<String> {
    "\
## Quick Notes

- Buy milk
- Call dentist

## Sessions
"
    .lines()
    .map(String::from)
    .collect()
}

#[test]
fn integration_locate_quick_note_happy_path() {
    let lines = qn_lines();
    // index 1 → second bullet "Call dentist"; text matches → Ok(raw line idx).
    let idx = locate_quick_note(&lines, 1, "Call dentist").expect("should locate");
    assert_eq!(lines[idx].trim(), "- Call dentist");
}

#[test]
fn integration_locate_quick_note_text_mismatch_is_stale_guard() {
    let lines = qn_lines();
    // Index still in range, but the on-disk text differs from the frontend's
    // projection → must refuse (never delete the wrong line).
    let err = locate_quick_note(&lines, 0, "Bought milk").unwrap_err();
    assert_eq!(err.code(), "TEXT_MISMATCH");
}

#[test]
fn integration_locate_quick_note_oob_and_no_section() {
    let lines = qn_lines();
    assert_eq!(locate_quick_note(&lines, 9, "x").unwrap_err().code(), "INDEX_OOB");

    let no_section: Vec<String> = "## Sessions\n\n- not a quick note\n".lines().map(String::from).collect();
    assert_eq!(locate_quick_note(&no_section, 0, "x").unwrap_err().code(), "NO_SECTION");
}

// ─── update_plan_block: fenced-block splice (daily.rs) ───────────────────────

#[test]
fn integration_update_plan_block_rewrites_only_the_matched_line() {
    let _g = common::env_lock();
    set_today(FIXTURE_DS);
    let initial = "\
---
Type: Daily-Log
Date: 2026-05-15
---

## Today's Plan

```plan
09:00 10:00 Morning
10:00 11:30 Deep work
11:30 12:00 Email
```
";
    let v = setup_vault(initial);

    let r = update_plan_block(
        FIXTURE_DS,
        PlanBlockInput { start: "10:00".into(), end: "11:30".into(), title: "Deep work".into() },
        PlanBlockInput { start: "10:15".into(), end: "11:45".into(), title: "Deep work v2".into() },
        None,
    )
    .unwrap();

    assert!(r.ok, "expected ok, got error {:?}", r.error);
    let content = std::fs::read_to_string(&v.daily_path).unwrap();
    assert!(content.contains("10:15 11:45 Deep work v2"), "matched line rewritten\n{content}");
    // Siblings untouched.
    assert!(content.contains("09:00 10:00 Morning"), "first line intact\n{content}");
    assert!(content.contains("11:30 12:00 Email"), "last line intact\n{content}");
    // Old text of the matched line is gone.
    assert!(!content.contains("10:00 11:30 Deep work\n"), "old line replaced\n{content}");
}

#[test]
fn integration_update_plan_block_missing_block_reports_not_found() {
    let _g = common::env_lock();
    set_today(FIXTURE_DS);
    let initial = "\
---
Type: Daily-Log
---

## Today's Plan

```plan
09:00 10:00 Morning
```
";
    setup_vault(initial);

    let r = update_plan_block(
        FIXTURE_DS,
        PlanBlockInput { start: "13:00".into(), end: "14:00".into(), title: "Nope".into() },
        PlanBlockInput { start: "13:00".into(), end: "14:30".into(), title: "Nope".into() },
        None,
    )
    .unwrap();

    assert!(!r.ok);
    assert_eq!(r.error.as_deref(), Some("plan block not found"));
}

// ─── delete_session: multi-line block drain + capture (sessions.rs) ──────────

#[test]
fn integration_delete_session_drains_whole_block_keeps_siblings() {
    let _g = common::env_lock();
    set_today(FIXTURE_DS);
    // Empty vault; append two sessions (the first with a sub-note → a multi-line
    // block), then delete the first by its "<start>:::<end>:::<task>" id.
    let v = setup_vault("---\nType: Daily-Log\n---\n");

    append_session(
        FIXTURE_DS,
        SessionInput { task: "Task A".into(), start: "09:00".into(), end: "10:30".into(),
            notes: Some("recall the API shape".into()) },
        None,
    )
    .unwrap();
    append_session(
        FIXTURE_DS,
        SessionInput { task: "Task B".into(), start: "11:00".into(), end: "11:30".into(), notes: None },
        None,
    )
    .unwrap();

    let r = delete_session(FIXTURE_DS, "09:00:::10:30:::Task A", None).unwrap();

    assert!(r.ok, "expected ok, got {:?}", r.error);
    let block = r.removed_block.expect("removed_block captured");
    assert!(block.contains("Task A"), "captured block has the bullet\n{block}");
    assert!(block.contains("recall the API shape"), "captured block has the sub-note (multi-line)\n{block}");
    assert!(r.line_hint.is_some(), "line hint for restore placement");
    assert_eq!(r.heading.as_deref(), Some("## Sessions"));

    let content = std::fs::read_to_string(&v.daily_path).unwrap();
    // Block-drain, not just bullet-removal: the sub-note line is gone too.
    assert!(!content.contains("recall the API shape"), "sub-note drained\n{content}");
    // Sibling session preserved.
    assert!(content.contains("Task B"), "second session intact\n{content}");
}
````

Notes:
- `set_today(FIXTURE_DS)` is harmless for the `ds`-taking writers (they use the
  explicit `FIXTURE_DS`), and is included only for parity with the existing
  tests. The three `locate_quick_note` tests need neither `env_lock` nor
  `set_today` (pure).
- The session bullet uses an en-dash (`\u{2013}`); assertions use ASCII
  substrings (`"Task A"`, the note text) so you never type the en-dash.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --test integration`
→ `test result: ok. 10 passed; 0 failed` (4 existing + 6 new). If a concurrent
plan also extended this file the total may be higher — in that case confirm the
six new `integration_(locate_quick_note|update_plan_block|delete_session)_*`
tests are among the passers.

### Step 3: Confirm the aggregate still passes

**Verify**: `node scripts/verify.mjs` → exit 0, `✓ verify passed`, with the
`integration` run reporting the six new tests passing. (If `verify.mjs` does not
exist yet, plan 002 has not run — report that and rely on the Step 2 command as
the gate.)

## Test plan

- Extend `src-tauri/tests/integration.rs` with 6 tests:
  - `locate_quick_note`: happy path, **text-mismatch stale guard** (the core
    safety contract), index-OOB + no-section errors.
  - `update_plan_block`: fenced-line splice rewrites only the matched line and
    leaves siblings byte-identical; a non-matching block reports
    `"plan block not found"`.
  - `delete_session`: append-then-delete round-trip proves the whole multi-line
    block (bullet + sub-note) drains, the sibling session survives, and
    `removed_block` / `line_hint` / `heading` (the recycle-bin capture contract)
    are populated.
- Structural pattern mirrored: the existing tests in the same file (temp-vault +
  `common::env_lock`).
- Verification: `cargo test … --test integration` → 10 passed.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --test integration` → `0 failed`, and the 6 new tests pass.
- [ ] `grep -cE "fn integration_(locate_quick_note|update_plan_block|delete_session)" src-tauri/tests/integration.rs` → `6`.
- [ ] No `src-tauri/src/**` file modified (`git status`).
- [ ] `git diff src-tauri/tests/integration.rs` shows only additions (the 4 original tests unchanged).
- [ ] `node scripts/verify.mjs` exits 0 (or, if it does not exist yet, this is reported per STOP conditions).
- [ ] `plans/README.md` status row updated (only if that index exists).

## STOP conditions

Stop and report back (do not improvise) if:

- Any of `update_plan_block`, `delete_session`, `append_session`,
  `locate_quick_note`, `PlanBlockInput`, `SessionInput`, `DeleteSessionOut`, or
  `QuickNoteLocateErr::code` has moved/renamed or changed signature vs the
  "Current state" excerpts (drift since 57a6c80) — do NOT guess a new shape.
- A test fails because the writer's **actual** behavior differs from what the
  excerpts imply (e.g. `delete_session` leaves the sub-note behind, or
  `update_plan_block` rewrites more than one line). That is a **real finding** —
  report the observed vs expected behavior; do NOT edit `src-tauri/src/**` to make
  the test pass (out of scope), and do NOT weaken the assertion to hide it.
- `cargo test … --test integration` SIGTERMs — confirm you did not use `--lib`
  or `--tests`; if the exact `--test integration` form still dies, report it.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this after it lands:

- **Deferred follow-on tests (same pattern, not done here to keep this plan
  focused):** `append_session` (bullet + note formatting), `update_session`
  (id-matched re-time), and `routine::toggle_routine_task` (uses `today_str()` →
  needs `set_today` **and** `setup_vault`, and a `## Routine` fixture) also have
  zero coverage. Add them to `integration.rs` with the same `setup_vault` +
  `env_lock` scaffold; `toggle_routine_task` needs its routine-item fixture shape
  read from `parsers/routine.rs` first.
- **The command-layer ordering invariant is intentionally out of scope.** These
  are *parser-unit* tests. The multi-write batch invariant — all session/plan ops
  ordered before frame-override writes, enforced at the `commands/daily.rs`
  orchestration layer — is a separate surface; a batch-level test belongs in a
  command-layer harness, not here.
- **What a reviewer should scrutinize**: that each assertion pins *current*
  behavior (characterization), and that the delete-session test truly proves
  block-drain (the `!content.contains(sub-note)` assertion), not merely bullet
  removal.
