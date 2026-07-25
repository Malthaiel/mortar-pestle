//! Harness-independent Rust integration tests for daily-writer commands.
//!
//! Pattern: temp-vault + call underlying parser function + assert on file
//! content directly. NO dependency on Node-generated baseline fixtures.
//!
//! Why this exists:
//!   The existing parity tests (daily_writers.rs, vault_io_parity.rs, etc.)
//!   byte-diff Rust output against captured Node baselines. They retire when
//!   Sub-feature 12 of Desktop-Only Migration deletes Fastify + the harness
//!   that produced the baselines. This file is the harness-independent
//!   successor: each test asserts on the FUNCTIONAL contract of the writer
//!   (what should the file look like after the call), not on byte-parity
//!   with a Node implementation that will no longer exist.
//!
//! Porting protocol:
//!   - Sub-features 4-11 each port one representative writer test here
//!     before SF12 ships. Pre-SF12 gate: `cargo test --tests` must include
//!     this file's coverage of every writer command surface that has a
//!     parity counterpart.
//!   - Pattern per test:
//!       1. Inline a minimal daily-log fixture as a literal string (or
//!          accept an empty vault for net-new coverage like freeform notes).
//!       2. Acquire `common::env_lock()` to serialize AGENTIC_VAULT_ROOT
//!          mutations across tests.
//!       3. `set_today(FIXTURE_DS)` so today_str() resolves deterministically.
//!       4. Call the underlying `app_lib::parsers::*` function directly.
//!          Do NOT go through the `#[tauri::command]` wrapper - same logic,
//!          fewer moving parts.
//!       5. Read the resulting file with `fs::read_to_string`. Assert on
//!          structural properties (lines contain/don't contain X, ordering
//!          relative to headings, etc.) - not byte-parity.

mod common;

use std::fs;
use std::path::PathBuf;

use serde_json::json;
use tempfile::TempDir;

use app_lib::commands::sidebar::{get_order_inner, set_order_inner};
use app_lib::parsers::sessions::append_freeform_note;
use app_lib::parsers::tasks::toggle_today_task;
use app_lib::parsers::daily::{update_plan_block, PlanBlockInput};
use app_lib::parsers::quick_notes::locate_quick_note;

const FIXTURE_DS: &str = "2026-05-15";

struct Vault {
    _dir: TempDir,
    daily_path: PathBuf,
}

/// Create a temp vault, write `initial_daily_content` to today's daily log,
/// and point AGENTIC_VAULT_ROOT at it. Returns the vault handle (drops the
/// tempdir when dropped, taking the vault with it).
fn setup_vault(initial_daily_content: &str) -> Vault {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    let daily_dir = root.join("Pulse/Daily Logs");
    fs::create_dir_all(&daily_dir).unwrap();
    let daily_path = daily_dir.join(format!("{}.md", FIXTURE_DS));
    fs::write(&daily_path, initial_daily_content).unwrap();
    std::env::set_var("AGENTIC_VAULT_ROOT", root.display().to_string());
    Vault {
        _dir: dir,
        daily_path,
    }
}

fn set_today(ds: &str) {
    std::env::set_var("AGENTIC_TODAY", ds);
}

// ─── 1. Ported test ─────────────────────────────────────────────────────────
//
// Mirrors `parity_toggle_task_flip_checked` from daily_writers.rs. Same call,
// same fixture shape; assertions check the functional flip (checked →
// unchecked) instead of byte-diffing against expected.md.

#[test]
fn integration_toggle_task_flips_checked_to_unchecked() {
    let _g = common::env_lock();
    set_today(FIXTURE_DS);
    let initial = "\
---
Type: Daily-Log
Date: 2026-05-15
---

## Daily Tasks

- [ ] Hydration check
- [x] Morning walk
";
    let v = setup_vault(initial);

    let r = toggle_today_task("- [x] Morning walk", None).unwrap();

    assert!(r.error.is_none(), "unexpected error: {:?}", r.error);
    let content = fs::read_to_string(&v.daily_path).unwrap();
    assert!(
        content.contains("- [ ] Morning walk"),
        "expected the task to be unchecked\n--- file ---\n{}",
        content
    );
    assert!(
        !content.contains("- [x] Morning walk"),
        "checked variant should be gone\n--- file ---\n{}",
        content
    );
    assert!(
        content.contains("- [ ] Hydration check"),
        "untouched task should remain\n--- file ---\n{}",
        content
    );
}

// ─── 2. Net-new coverage ────────────────────────────────────────────────────
//
// No parity test for `append_freeform_note` exists in daily_writers.rs (the
// 12 parity cases skip freeform notes because they involve a non-deterministic
// timestamp). The harness-independent pattern handles this fine: assert on
// structural properties of the bullet, not on the exact timestamp string.

#[test]
fn integration_append_freeform_note_inserts_bullet_under_notes() {
    let _g = common::env_lock();
    set_today(FIXTURE_DS);
    let initial = "\
---
Type: Daily-Log
Date: 2026-05-15
---

## Notes

";
    let v = setup_vault(initial);

    let r = append_freeform_note("integration sentinel zk9X", None).unwrap();

    assert!(r.error.is_none(), "unexpected error: {:?}", r.error);
    assert!(r.ok);
    assert!(r.mtime > 0.0, "mtime should be set after a successful write");

    let content = fs::read_to_string(&v.daily_path).unwrap();
    let lines: Vec<&str> = content.lines().collect();

    let notes_idx = lines
        .iter()
        .position(|l| l.trim() == "## Notes")
        .expect("## Notes heading should still be present");
    let bullet_idx = lines
        .iter()
        .position(|l| l.contains("integration sentinel zk9X"))
        .expect("appended bullet should be present");

    assert!(
        bullet_idx > notes_idx,
        "bullet must be inserted AFTER the `## Notes` heading\n--- file ---\n{}",
        content
    );
    assert!(
        lines[bullet_idx].starts_with("- "),
        "appended line should be a markdown bullet, got: {:?}",
        lines[bullet_idx]
    );
}

// ─── 3. Missing-note path ───────────────────────────────────────────────────
//
// A missing daily note USED to bounce the write with Ok(OkOut { ok: false }),
// which silently DROPPED whatever the user had typed. The note is now created
// from the skeleton first (the same one `daily_get_today` uses) and the text
// lands in it. Pinned here because the failure mode is invisible — the note
// just never appears and nothing errors loudly.

#[test]
fn integration_append_freeform_note_creates_missing_daily() {
    let _g = common::env_lock();
    // Future date — no daily log file will exist for it.
    set_today("2099-01-01");

    // Set up an empty vault root (no Pulse/Daily Logs/2099-01-01.md).
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("AGENTIC_VAULT_ROOT", dir.path().display().to_string());
    // pulse_vault_root() prefers a REGISTERED Pulse vault over AGENTIC_VAULT_ROOT. Reading a
    // missing file through that fallback was harmless; creating one is not, so pin the Pulse root
    // to the temp dir — then clear it right after the write so a failed assert below cannot leak a
    // dangling root into the next test.
    std::env::set_var("AGENTIC_PULSE_VAULT_ROOT", dir.path().display().to_string());
    let r = append_freeform_note("survived the missing note", None).unwrap();
    std::env::remove_var("AGENTIC_PULSE_VAULT_ROOT");

    assert!(r.ok, "a missing note is created, not an error: {:?}", r.error);
    let written = std::fs::read_to_string(dir.path().join("Pulse/Daily Logs/2099-01-01.md"))
        .expect("the note should have been created");
    assert!(
        written.contains("survived the missing note"),
        "the typed text must land in the new note, got: {written:?}"
    );
}

// ─── 4. Sidebar writer (SF6) ────────────────────────────────────────────────
//
// Mirrors `set_new_key_creates_file` from sidebar_writers.rs. SF12 deletes
// that parity harness; this guards the writer contract independently.

#[test]
fn integration_sidebar_set_order_creates_and_round_trips() {
    let _g = common::env_lock();
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("sidebar.json");

    let order = vec![json!("a"), json!("b"), json!("c")];
    let res = set_order_inner(&file, "modules:left-sidebar", &order)
        .expect("set new key");

    assert_eq!(
        res,
        Some(vec!["a".into(), "b".into(), "c".into()]),
        "set should echo back the persisted order",
    );
    assert!(file.exists(), "AppConfig file should be created on first set");

    let round_trip = get_order_inner(&file, "modules:left-sidebar")
        .expect("key should resolve after set");
    assert_eq!(round_trip, vec!["a", "b", "c"]);

    // Filter contract: non-string entries are silently dropped.
    let mixed = vec![json!("x"), json!(42), json!("y")];
    let res2 = set_order_inner(&file, "widgets:order", &mixed)
        .expect("set mixed");
    assert_eq!(res2, Some(vec!["x".into(), "y".into()]));
}

// ─── Planner writer-command characterization (plan 022) ──────────────────────
// locate_quick_note (pure stale guard), update_plan_block (fenced splice) —
// ports the writer contracts that the Fastify-era parity tests covered before
// SF12 retired the Node harness. The delete_session case that lived here was
// dropped when D5 moved sessions out of the daily-note markdown into
// sessions.json; its replacement is covered by
// `commands::sessions::tests::update_delete_note_and_desync`.

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
    // QuickNoteLocateErr has no Debug, so .expect() (needs E: Debug) won't compile;
    // .ok() drops the un-printable error and still panics on failure.
    let idx = locate_quick_note(&lines, 1, "Call dentist").ok().expect("should locate");
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
    // Bind the Vault so its TempDir lives until the call — an unbound
    // `setup_vault(initial);` drops the temp dir immediately, deleting the daily
    // file before update_plan_block runs (would yield "daily note not found").
    let _v = setup_vault(initial);

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

