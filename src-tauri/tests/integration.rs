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

// ─── 3. Error path ──────────────────────────────────────────────────────────
//
// The function returns Ok(OkOut { ok: false, error: Some(...) }) - NOT an
// Err - when today's file doesn't exist. This is a deliberate API choice
// (recoverable surface) and the integration scaffold should pin it down so
// the contract can't drift silently.

#[test]
fn integration_append_freeform_note_errors_when_daily_missing() {
    let _g = common::env_lock();
    // Future date — no daily log file will exist for it.
    set_today("2099-01-01");

    // Set up an empty vault root (no Pulse/Daily Logs/2099-01-01.md).
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("AGENTIC_VAULT_ROOT", dir.path().display().to_string());

    let r = append_freeform_note("text", None).unwrap();

    assert_eq!(r.ok, false, "should report not-ok when file is missing");
    assert_eq!(
        r.error.as_deref(),
        Some("Today's note not found"),
        "should surface the exact contract message"
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
