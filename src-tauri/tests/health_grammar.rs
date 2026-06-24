//! Health Column daily-log grammar — round-trip + writer contract tests.
//!
//! Pattern: temp-vault + call the underlying `app_lib::parsers::health`
//! functions directly (not the `#[tauri::command]` wrappers) + assert on file
//! content / parsed structs. Mirrors `tests/integration.rs`.
//!
//! Covers: log → exact bytes, ad-hoc (no supplements) shape, nested supplement
//! sub-bullets, format↔parse identity, edit in-place splice, delete drained
//! block, the sugar split incl. `na`, and the no-op-on-existing-logs guarantee.

mod common;

use std::fs;
use std::path::PathBuf;

use tempfile::TempDir;

use app_lib::parsers::health::{
    delete_meal_log, edit_meal_log, log_meal, parse_nutrition_log, MealLogEntry, MealTarget,
    MicroTok, Sugar, Supplement,
};

const FIXTURE_DS: &str = "2026-05-15";

struct Vault {
    _dir: TempDir,
    daily_path: PathBuf,
}

/// Temp vault with today's daily log seeded; points AGENTIC_VAULT_ROOT at it
/// (pulse_vault_root() falls back to vault_root() in tests).
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

fn micro(key: &str, amount: f64, unit: &str) -> MicroTok {
    MicroTok {
        key: key.to_string(),
        amount,
        unit: unit.to_string(),
    }
}

/// The canonical fixture meal (matches the grammar example in the plan).
fn chicken_bowl() -> MealLogEntry {
    MealLogEntry {
        time: Some("13:05".to_string()),
        name: "Chicken & Rice Bowl".to_string(),
        kcal: 612.0,
        protein: 48.0,
        carb: 71.0,
        fat: 14.0,
        sugar: Sugar {
            total: Some(4.0),
            added: Some(2.0),
        },
        micros: vec![
            micro("fiber", 6.0, "g"),
            micro("sodium", 540.0, "mg"),
            micro("potassium", 820.0, "mg"),
            micro("calcium", 120.0, "mg"),
            micro("iron", 3.2, "mg"),
            micro("vitamin_d", 0.4, "mcg"),
        ],
        supplements: vec![
            Supplement {
                name: "Vitamin D3".to_string(),
                dose: Some("25mcg".to_string()),
                micros: vec![micro("vitamin_d", 25.0, "mcg")],
            },
            Supplement {
                name: "Creatine".to_string(),
                dose: Some("5g".to_string()),
                micros: vec![],
            },
        ],
    }
}

const SKELETON: &str = "\
---
Type: Daily-Log
Date: 2026-05-15
---

## Focus Block

## Quick Notes

## Tasks

## Upcoming

## Sessions

- 9:30\u{2013}10:15 Deep work (Code, 45m)

## Plan

## Vault Activity
";

const HEAD: &str = "- 13:05 \u{2014} Chicken & Rice Bowl \u{2014} 612 kcal \u{00B7} 48p / 71c / 14f | fiber=6g sodium=540mg potassium=820mg calcium=120mg iron=3.2mg vitamin_d=0.4mcg sugar=4g/2g";
const SUPP1: &str = "  + Vitamin D3 \u{2014} 25mcg \u{00B7} vitamin_d=25mcg";
const SUPP2: &str = "  + Creatine \u{2014} 5g";

#[test]
fn log_meal_writes_exact_grammar_at_eof() {
    let _g = common::env_lock();
    let v = setup_vault(SKELETON);

    let r = log_meal(FIXTURE_DS, chicken_bowl(), None).unwrap();
    assert!(r.ok && r.error.is_none(), "unexpected: {:?}", r.error);
    assert!(r.mtime > 0.0);

    let content = fs::read_to_string(&v.daily_path).unwrap();
    // Section lazily created at EOF, after the canonical sections.
    assert!(content.contains("## Nutrition Log"), "section missing:\n{content}");
    assert!(content.contains(HEAD), "head bullet wrong:\n{content}");
    assert!(content.contains(SUPP1), "supplement 1 wrong:\n{content}");
    assert!(content.contains(SUPP2), "supplement 2 wrong:\n{content}");
    // Existing content untouched.
    assert!(content.contains("- 9:30\u{2013}10:15 Deep work (Code, 45m)"));
    let nut = content.find("## Nutrition Log").unwrap();
    let sess = content.find("## Sessions").unwrap();
    assert!(nut > sess, "Nutrition Log must come AFTER the 7 sections");
}

#[test]
fn log_meal_then_parse_round_trips() {
    let _g = common::env_lock();
    let v = setup_vault(SKELETON);
    let entry = chicken_bowl();

    log_meal(FIXTURE_DS, entry.clone(), None).unwrap();
    let content = fs::read_to_string(&v.daily_path).unwrap();

    let parsed = parse_nutrition_log(&content);
    assert_eq!(parsed.len(), 1, "exactly one meal");
    assert_eq!(parsed[0], entry, "format→parse must recover the entry exactly");
}

#[test]
fn ad_hoc_quick_add_is_byte_indistinguishable() {
    // A one-ingredient quick-add (no supplements, no Library page) produces the
    // SAME bullet shape as a saved meal — snapshot integrity by construction.
    let _g = common::env_lock();
    let v = setup_vault(SKELETON);
    let quick = MealLogEntry {
        time: Some("08:10".to_string()),
        name: "Banana".to_string(),
        kcal: 105.0,
        protein: 1.3,
        carb: 27.0,
        fat: 0.4,
        sugar: Sugar {
            total: Some(14.0),
            added: None, // raw fruit: added sugar not reported
        },
        micros: vec![micro("potassium", 422.0, "mg"), micro("fiber", 3.1, "g")],
        supplements: vec![],
    };
    log_meal(FIXTURE_DS, quick.clone(), None).unwrap();
    let content = fs::read_to_string(&v.daily_path).unwrap();
    assert!(
        content.contains(
            "- 08:10 \u{2014} Banana \u{2014} 105 kcal \u{00B7} 1.3p / 27c / 0.4f | potassium=422mg fiber=3.1g sugar=14g/na"
        ),
        "ad-hoc bullet wrong (note sugar=14g/na):\n{content}"
    );
    let parsed = parse_nutrition_log(&content);
    assert_eq!(parsed[0], quick);
    assert_eq!(parsed[0].sugar.added, None, "na must parse to None, not 0");
}

#[test]
fn sugar_fully_unreported_emits_na_na() {
    let _g = common::env_lock();
    let v = setup_vault(SKELETON);
    let entry = MealLogEntry {
        time: None,
        name: "Black Coffee".to_string(),
        kcal: 2.0,
        protein: 0.3,
        carb: 0.0,
        fat: 0.0,
        sugar: Sugar::default(), // both None
        micros: vec![],
        supplements: vec![],
    };
    log_meal(FIXTURE_DS, entry.clone(), None).unwrap();
    let content = fs::read_to_string(&v.daily_path).unwrap();
    assert!(
        content.contains("- Black Coffee \u{2014} 2 kcal \u{00B7} 0.3p / 0c / 0f | sugar=na/na"),
        "timeless + na/na bullet wrong:\n{content}"
    );
    assert_eq!(parse_nutrition_log(&content)[0], entry);
}

#[test]
fn edit_meal_log_replaces_block_in_place() {
    let _g = common::env_lock();
    let v = setup_vault(SKELETON);
    log_meal(FIXTURE_DS, chicken_bowl(), None).unwrap();

    let mut edited = chicken_bowl();
    edited.kcal = 700.0;
    edited.supplements = vec![]; // drop the supplements
    let target = MealTarget {
        time: Some("13:05".to_string()),
        name: "Chicken & Rice Bowl".to_string(),
    };
    let r = edit_meal_log(FIXTURE_DS, target, edited, None).unwrap();
    assert!(r.ok && r.error.is_none());

    let content = fs::read_to_string(&v.daily_path).unwrap();
    assert!(content.contains("700 kcal"), "edit didn't apply:\n{content}");
    assert!(!content.contains("612 kcal"), "old value lingering:\n{content}");
    assert!(!content.contains(SUPP1), "supplements should be gone:\n{content}");
    assert_eq!(parse_nutrition_log(&content).len(), 1);
}

#[test]
fn edit_missing_meal_is_no_op() {
    // DESYNC guard: a target that doesn't match returns ok:false WITHOUT writing.
    let _g = common::env_lock();
    let v = setup_vault(SKELETON);
    log_meal(FIXTURE_DS, chicken_bowl(), None).unwrap();
    let before = fs::read_to_string(&v.daily_path).unwrap();

    let r = edit_meal_log(
        FIXTURE_DS,
        MealTarget {
            time: Some("99:99".to_string()),
            name: "Ghost Meal".to_string(),
        },
        chicken_bowl(),
        None,
    )
    .unwrap();
    assert!(!r.ok);
    assert_eq!(r.error.as_deref(), Some("Meal not found"));
    let after = fs::read_to_string(&v.daily_path).unwrap();
    assert_eq!(before, after, "file must be untouched on a missing target");
}

#[test]
fn delete_meal_log_drains_block_and_captures_it() {
    let _g = common::env_lock();
    let v = setup_vault(SKELETON);
    log_meal(FIXTURE_DS, chicken_bowl(), None).unwrap();

    let r = delete_meal_log(
        FIXTURE_DS,
        MealTarget {
            time: Some("13:05".to_string()),
            name: "Chicken & Rice Bowl".to_string(),
        },
        None,
    )
    .unwrap();
    assert!(r.ok);
    assert_eq!(r.heading.as_deref(), Some("## Nutrition Log"));

    // The captured block is the verbatim head + both supplement sub-bullets.
    let block = r.removed_block.expect("removed_block");
    let expected_block = format!("{HEAD}\n{SUPP1}\n{SUPP2}");
    assert_eq!(block, expected_block, "drained block not verbatim");

    // And the meal is gone from the file.
    let content = fs::read_to_string(&v.daily_path).unwrap();
    assert!(!content.contains(HEAD), "meal still present:\n{content}");
    assert!(parse_nutrition_log(&content).is_empty());
}

#[test]
fn parse_is_empty_on_logs_without_the_section() {
    // The thousands of existing daily logs (no health section) parse as empty.
    assert!(parse_nutrition_log(SKELETON).is_empty());
    assert!(parse_nutrition_log("").is_empty());
}
