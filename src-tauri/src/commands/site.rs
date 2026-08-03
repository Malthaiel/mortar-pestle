//! malthaiel.com site bridge — the desktop half (Site Bridge plan, Phase 2 + 4).
//!
//! Two directions, both over the SAME Supabase project and the SAME signed-in
//! session the Feedback Board already owns:
//!   up   — `site_push_busy` replaces `availability_busy` with the planner's
//!          computed busy window (times only; the payload carries no titles).
//!   down — `site_fetch_bookings` reads confirmed bookings so the planner can
//!          write them into the daily log's `## Upcoming`.
//!
//! Deliberately thin: `rest()` / `handle_json()` / the error type are reused from
//! `feedback.rs` rather than re-implemented, so there is exactly one place that
//! knows how this app talks to PostgREST. `require_user = true` on every call —
//! RLS gates both surfaces on `is_dev()`, so a signed-out app simply gets Auth.
//!
//! Schema + policies: `supabase/migrations/0004_site.sql`.

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};

use super::feedback::{handle_json, rest, FeedbackError as SiteError};

/// One busy window, already merged and ISO-stamped by `web/src/util/busyRanges.js`.
/// No label field — see the migration's header comment.
#[derive(Debug, Deserialize)]
pub struct BusyRange {
    start_ts: String,
    end_ts: String,
}

/// Sanity ceiling: a 30-day window of real blocks lands around 60–150 ranges.
/// Anything past this is a bug in the caller, not a busy person.
const MAX_RANGES: usize = 1000;

/// Replace the published availability with `ranges`. Atomic — the delete and the
/// insert happen inside `site_replace_busy()` in Postgres, so the website never
/// observes an empty (= fully free) calendar mid-push.
#[tauri::command]
pub async fn site_push_busy(ranges: Vec<BusyRange>) -> Result<Value, SiteError> {
    if ranges.len() > MAX_RANGES {
        return Err(SiteError::Invalid(format!(
            "Too many busy ranges ({}, max {MAX_RANGES})",
            ranges.len()
        )));
    }
    let rows: Vec<Value> = ranges
        .iter()
        .map(|r| json!({ "start_ts": r.start_ts, "end_ts": r.end_ts }))
        .collect();
    let resp = rest(Method::POST, "rpc/site_replace_busy", true)
        .await?
        .json(&json!({ "ranges": rows }))
        .send()
        .await?;
    let inserted = handle_json(resp).await?;
    Ok(json!({ "pushed": inserted.as_i64().unwrap_or(rows.len() as i64) }))
}

/// Confirmed bookings, soonest first. `client_email` is deliberately not selected:
/// the planner writes a calendar bullet, and an email address in a vault markdown
/// file is a copy of PII with no owner.
#[tauri::command]
pub async fn site_fetch_bookings() -> Result<Value, SiteError> {
    let q = "bookings?status=eq.confirmed\
             &select=id,service_id,start_ts,mins,client_name,client_discord,notes\
             &order=start_ts.asc";
    let resp = rest(Method::GET, q, true).await?.send().await?;
    handle_json(resp).await
}
