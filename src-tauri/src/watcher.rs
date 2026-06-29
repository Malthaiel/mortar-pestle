//! Sub-feature 5 — notify file watcher emitting Tauri events.
//!
//! Replaces the Fastify SSE stream + chokidar watcher in
//! `server/src/watcher.js`. Single recursive watcher on canonicalized
//! `vault_root()`, 200ms debounce via `notify-debouncer-full`. Event names
//! preserved 1:1 with the Fastify side so the web client's
//! `subscribeEvents` swap is transport-only.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

use chrono::Local;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use tauri::{AppHandle, Emitter};

use crate::commands::vault::vault_root;

const DEBOUNCE_MS: u64 = 200;

/// Holds the active debouncer for the app's lifetime. Kept in a global (rather
/// than moved into the drain thread) so a vault switch can drop it — dropping
/// unwatches the inotify descriptors and closes the channel, which ends the
/// drain thread.
static WATCHER: Mutex<Option<Debouncer<RecommendedWatcher, FileIdMap>>> = Mutex::new(None);

pub fn spawn(app: AppHandle) -> Result<(), notify::Error> {
    let root = std::fs::canonicalize(vault_root())?;

    let (tx, rx) = mpsc::channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), None, tx)?;
    debouncer.watcher().watch(&root, RecursiveMode::Recursive)?;
    *WATCHER.lock().unwrap_or_else(|e| e.into_inner()) = Some(debouncer);

    thread::spawn(move || {
        for res in rx {
            let events = match res {
                Ok(evs) => evs,
                Err(errs) => {
                    for e in errs {
                        log::warn!("notify watcher error: {e}");
                    }
                    continue;
                }
            };

            // Fresh `today` per batch so the draining thread stays correct
            // across midnight rollovers.
            let today = today_string();
            // Dedupe paths per batch — a single edit can produce
            // create+modify; we want one emit per file per debounce window.
            let mut seen: HashSet<PathBuf> = HashSet::new();
            for ev in events {
                for path in &ev.event.paths {
                    if !seen.insert(path.clone()) {
                        continue;
                    }
                    let rel = match path.strip_prefix(&root) {
                        Ok(r) => r,
                        Err(_) => continue,
                    };
                    for (name, payload) in match_event(rel, &today) {
                        let p = payload.unwrap_or_default();
                        if let Err(e) = app.emit(name, p) {
                            log::warn!("emit {name} failed: {e}");
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

/// Stop the current watcher and start a fresh one on the (now-updated)
/// `vault_root()`. Used on vault switch — dropping the old debouncer ends its
/// drain thread, then `spawn` attaches a new recursive watch to the new root.
pub fn respawn(app: AppHandle) -> Result<(), notify::Error> {
    *WATCHER.lock().unwrap_or_else(|e| e.into_inner()) = None;
    spawn(app)
}

fn today_string() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Pure function: relative path → list of `(event_name, optional_payload)`.
/// Mirrors `server/src/watcher.js:46-61`. `today_ds` is injected so tests
/// don't depend on the wall clock.
pub fn match_event(rel: &Path, today_ds: &str) -> Vec<(&'static str, Option<String>)> {
    if let Some(name) = rel.file_name().and_then(|n| n.to_str()) {
        // Skip atomic-write tmp files: see commands::vault::atomic_write —
        // tmp leaf is `{leaf}.tmp.{pid}.{ts}.{n}`.
        if name.contains(".tmp.") {
            return vec![];
        }
    }

    let rel_str = match rel.to_str() {
        Some(s) => s,
        None => return vec![],
    };
    let normalized = rel_str.replace('\\', "/");

    if let Some(rest) = normalized.strip_prefix("Pulse/Daily Logs/") {
        if rest.contains('/') {
            return vec![];
        }
        if let Some(ds) = rest.strip_suffix(".md") {
            if is_iso_date(ds) {
                let mut out: Vec<(&'static str, Option<String>)> =
                    vec![("day", Some(ds.to_string()))];
                if ds == today_ds {
                    out.push(("today", None));
                }
                return out;
            }
        }
        return vec![];
    }

    match normalized.as_str() {
        "Pulse/Schedule.md" => return vec![("schedule", None)],
        "Pulse/Recurring Tasks.md" => return vec![("routine", None)],
        "Infrastructure/Vault State/Log.md" => return vec![("log", None)],
        "Infrastructure/Vault State/Update Queue.md" => return vec![("queue", None)],
        "Infrastructure/.cache/vault_manifest.json" => return vec![("manifest", None)],
        _ => {}
    }

    if normalized.starts_with("Infrastructure/Skills/") && normalized.ends_with(".md") {
        return vec![("skills", None)];
    }

    // Generic standard-page event: any other `.md` not matched above emits
    // `("file", relpath)` so the in-app Live Preview editor can react instantly
    // to external edits of the open page (clean → silent reload, dirty → banner).
    if normalized.ends_with(".md") {
        return vec![("file", Some(normalized))];
    }

    vec![]
}

fn is_iso_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| {
        if i == 4 || i == 7 {
            *b == b'-'
        } else {
            b.is_ascii_digit()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "2026-05-22";

    fn rel(p: &str) -> PathBuf {
        PathBuf::from(p)
    }

    #[test]
    fn daily_log_today_emits_day_and_today() {
        let r = match_event(&rel("Pulse/Daily Logs/2026-05-22.md"), TODAY);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0], ("day", Some("2026-05-22".into())));
        assert_eq!(r[1], ("today", None));
    }

    #[test]
    fn daily_log_other_day_emits_day_only() {
        let r = match_event(&rel("Pulse/Daily Logs/2024-01-01.md"), TODAY);
        assert_eq!(r, vec![("day", Some("2024-01-01".into()))]);
    }

    #[test]
    fn non_iso_filename_ignored() {
        assert!(match_event(&rel("Pulse/Daily Logs/notes.md"), TODAY).is_empty());
    }

    #[test]
    fn malformed_iso_ignored() {
        assert!(match_event(&rel("Pulse/Daily Logs/2026-5-22.md"), TODAY).is_empty());
        assert!(match_event(&rel("Pulse/Daily Logs/2026/05/22.md"), TODAY).is_empty());
    }

    #[test]
    fn nested_under_daily_logs_ignored() {
        assert!(
            match_event(&rel("Pulse/Daily Logs/2026/2026-05-22.md"), TODAY).is_empty()
        );
    }

    #[test]
    fn schedule_exact_match() {
        assert_eq!(
            match_event(&rel("Pulse/Schedule.md"), TODAY),
            vec![("schedule", None)],
        );
    }

    #[test]
    fn schedule_case_sensitive() {
        // Lowercase isn't the `schedule` event — but it's still a standard
        // `.md` page, so it falls through to the generic `file` event.
        assert_eq!(
            match_event(&rel("Pulse/schedule.md"), TODAY),
            vec![("file", Some("Pulse/schedule.md".into()))],
        );
    }

    #[test]
    fn routine_exact_match() {
        assert_eq!(
            match_event(&rel("Pulse/Recurring Tasks.md"), TODAY),
            vec![("routine", None)],
        );
    }

    #[test]
    fn skills_nested_md_emits() {
        assert_eq!(
            match_event(&rel("Infrastructure/Skills/Slash/check-links.md"), TODAY),
            vec![("skills", None)],
        );
    }

    #[test]
    fn skills_non_md_ignored() {
        assert!(match_event(&rel("Infrastructure/Skills/data.json"), TODAY).is_empty());
    }

    #[test]
    fn log_exact_match() {
        assert_eq!(
            match_event(&rel("Infrastructure/Vault State/Log.md"), TODAY),
            vec![("log", None)],
        );
    }

    #[test]
    fn update_queue_exact_match() {
        assert_eq!(
            match_event(&rel("Infrastructure/Vault State/Update Queue.md"), TODAY),
            vec![("queue", None)],
        );
    }

    #[test]
    fn manifest_exact_match() {
        assert_eq!(
            match_event(&rel("Infrastructure/.cache/vault_manifest.json"), TODAY),
            vec![("manifest", None)],
        );
    }

    #[test]
    fn manifest_sibling_ignored() {
        assert!(match_event(&rel("Infrastructure/.cache/other.json"), TODAY).is_empty());
    }

    #[test]
    fn standard_page_emits_file() {
        assert_eq!(
            match_event(&rel("Knowledge/Some Page.md"), TODAY),
            vec![("file", Some("Knowledge/Some Page.md".into()))],
        );
    }

    #[test]
    fn nested_standard_page_emits_file() {
        assert_eq!(
            match_event(&rel("Mortar & Pestle/Plans/Foo.md"), TODAY),
            vec![("file", Some("Mortar & Pestle/Plans/Foo.md".into()))],
        );
    }

    #[test]
    fn non_md_standard_file_ignored() {
        assert!(match_event(&rel("Knowledge/diagram.png"), TODAY).is_empty());
    }

    #[test]
    fn tmp_atomic_write_ignored() {
        assert!(match_event(
            &rel("Pulse/Daily Logs/2026-05-22.md.tmp.12345.1700000000.abc"),
            TODAY,
        )
        .is_empty());
    }

    #[test]
    fn iso_date_validator() {
        assert!(is_iso_date("2026-05-22"));
        assert!(is_iso_date("0001-01-01"));
        assert!(!is_iso_date("26-05-22"));
        assert!(!is_iso_date("2026/05/22"));
        assert!(!is_iso_date("2026-5-22"));
        assert!(!is_iso_date(""));
    }
}
