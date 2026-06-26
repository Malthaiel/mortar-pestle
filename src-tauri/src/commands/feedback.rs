//! Feedback Board backend — the app's only cloud-backed feature. All Supabase
//! traffic routes through here (the webview never calls the internet directly).
//!
//! Security model (see `supabase/migrations/0001_feedback_board.sql`):
//!   - The **anon key + project URL are public** (baked via `option_env!`, with a
//!     runtime `std::env::var` fallback for dev). Row-Level Security is the gate.
//!   - The **user session JWT lives in the OS keyring** (`iskariel`/`feedback_session`).
//!   - `bearer()` attaches the user's access token so Postgres RLS sees `auth.uid()`;
//!     public reads fall back to the anon key alone. Token refresh is Mutex-serialized.
//!
//! Plan of record: Citadel `Knowledge/Iskariel/Plans/Feedback Board.md`.
//! Patterns cloned from `design.rs` (error/keyring/reqwest) + `self_update.rs` (poll task).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

// ───────────────────────── secrets (public anon key) ─────────────────────────
// Baked at build time; release builds must set these (a placeholder/empty value
// makes every command return Config). Runtime env fallback lets dev set them
// without a recompile.
const SUPABASE_URL_BAKED: Option<&str> = option_env!("ISKARIEL_SUPABASE_URL");
const SUPABASE_ANON_BAKED: Option<&str> = option_env!("ISKARIEL_SUPABASE_ANON_KEY");

fn base_url() -> Result<String, FeedbackError> {
    if let Some(u) = SUPABASE_URL_BAKED {
        if !u.is_empty() {
            return Ok(u.trim_end_matches('/').to_string());
        }
    }
    if let Ok(u) = std::env::var("ISKARIEL_SUPABASE_URL") {
        if !u.is_empty() {
            return Ok(u.trim_end_matches('/').to_string());
        }
    }
    Err(FeedbackError::Config(
        "Supabase URL not configured (set ISKARIEL_SUPABASE_URL)".into(),
    ))
}

fn anon_key() -> Result<String, FeedbackError> {
    if let Some(k) = SUPABASE_ANON_BAKED {
        if !k.is_empty() {
            return Ok(k.to_string());
        }
    }
    if let Ok(k) = std::env::var("ISKARIEL_SUPABASE_ANON_KEY") {
        if !k.is_empty() {
            return Ok(k.to_string());
        }
    }
    Err(FeedbackError::Config(
        "Supabase anon key not configured (set ISKARIEL_SUPABASE_ANON_KEY)".into(),
    ))
}

// ───────────────────────── error type (mirrors DesignError) ─────────────────────────
#[derive(Debug)]
pub enum FeedbackError {
    Invalid(String),
    NotFound(String),
    Auth(String),
    Network(String),
    Upstream(String),
    RateLimited(String),
    Config(String),
    Io(String),
}

impl Serialize for FeedbackError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let (code, msg) = match self {
            FeedbackError::Invalid(m) => ("INVALID", m),
            FeedbackError::NotFound(m) => ("NOT_FOUND", m),
            FeedbackError::Auth(m) => ("AUTH", m),
            FeedbackError::Network(m) => ("NETWORK", m),
            FeedbackError::Upstream(m) => ("UPSTREAM", m),
            FeedbackError::RateLimited(m) => ("RATE_LIMITED", m),
            FeedbackError::Config(m) => ("CONFIG", m),
            FeedbackError::Io(m) => ("IO", m),
        };
        let mut map = s.serialize_map(Some(2))?;
        map.serialize_entry("code", code)?;
        map.serialize_entry("message", msg)?;
        map.end()
    }
}

impl From<reqwest::Error> for FeedbackError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            FeedbackError::Network("Request timed out".into())
        } else {
            FeedbackError::Network(e.to_string())
        }
    }
}

// ───────────────────────── session (OS keyring) ─────────────────────────
const KR_SERVICE: &str = "iskariel";
const KR_ACCOUNT: &str = "feedback_session";

#[derive(Serialize, Deserialize, Clone)]
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: String,
}

fn store_session(s: &Session) -> Result<(), FeedbackError> {
    let payload = serde_json::to_string(s).map_err(|e| FeedbackError::Io(e.to_string()))?;
    let entry = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT)
        .map_err(|e| FeedbackError::Io(format!("keyring open: {e}")))?;
    entry
        .set_password(&payload)
        .map_err(|e| FeedbackError::Io(format!("keyring set: {e}")))
}

fn load_session() -> Option<Session> {
    let entry = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT).ok()?;
    let s = entry.get_password().ok()?;
    serde_json::from_str(&s).ok()
}

fn clear_session() {
    if let Ok(entry) = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn current_uid() -> Result<String, FeedbackError> {
    load_session()
        .map(|s| s.user_id)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| FeedbackError::Auth("Not signed in".into()))
}

fn session_from_gotrue(v: &Value) -> Result<Session, FeedbackError> {
    let access_token = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or_else(|| FeedbackError::Auth("Sign-in failed (no token returned)".into()))?
        .to_string();
    let refresh_token = v
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    let expires_at = v
        .get("expires_at")
        .and_then(|x| x.as_i64())
        .or_else(|| {
            v.get("expires_in")
                .and_then(|x| x.as_i64())
                .map(|s| now_secs() + s)
        })
        .unwrap_or_else(|| now_secs() + 3600);
    let user_id = v
        .pointer("/user/id")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(Session {
        access_token,
        refresh_token,
        expires_at,
        user_id,
    })
}

// Serialize refreshes so two concurrent commands never double-refresh the token.
static REFRESH_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The bearer token to send: the user's access token (refreshed if near expiry),
/// or `None` when signed out. `require_user` errors instead of returning `None`.
async fn bearer(require_user: bool) -> Result<Option<String>, FeedbackError> {
    let sess = match load_session() {
        Some(s) => s,
        None => {
            return if require_user {
                Err(FeedbackError::Auth("Not signed in".into()))
            } else {
                Ok(None)
            }
        }
    };
    if sess.expires_at > now_secs() + 60 {
        return Ok(Some(sess.access_token));
    }
    // Near expiry — refresh under the lock (re-check: another task may have done it).
    let _guard = REFRESH_MUTEX.lock().await;
    if let Some(fresh) = load_session() {
        if fresh.expires_at > now_secs() + 60 {
            return Ok(Some(fresh.access_token));
        }
    }
    if sess.refresh_token.is_empty() {
        clear_session();
        return if require_user {
            Err(FeedbackError::Auth("Session expired — sign in again".into()))
        } else {
            Ok(None)
        };
    }
    match refresh_session(&sess.refresh_token).await {
        Ok(fresh) => {
            store_session(&fresh)?;
            Ok(Some(fresh.access_token))
        }
        Err(e) => {
            clear_session();
            if require_user {
                Err(e)
            } else {
                Ok(None)
            }
        }
    }
}

async fn refresh_session(refresh_token: &str) -> Result<Session, FeedbackError> {
    let base = base_url()?;
    let anon = anon_key()?;
    let resp = client()?
        .post(format!("{base}/auth/v1/token?grant_type=refresh_token"))
        .header("apikey", anon.as_str())
        .header("Content-Type", "application/json")
        .json(&json!({ "refresh_token": refresh_token }))
        .send()
        .await?;
    let v = handle_json(resp).await?;
    session_from_gotrue(&v)
}

// ───────────────────────── HTTP helpers ─────────────────────────
fn client() -> Result<reqwest::Client, FeedbackError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("iskariel-feedback/1.0")
        .build()
        .map_err(|e| FeedbackError::Network(format!("HTTP client init: {e}")))
}

/// A PostgREST request with `apikey` + `Authorization` already attached.
/// `require_user=true` forces a signed-in token (RLS sees `auth.uid()`);
/// `false` falls back to the anon key for public reads.
async fn rest(
    method: Method,
    path: &str,
    require_user: bool,
) -> Result<reqwest::RequestBuilder, FeedbackError> {
    let base = base_url()?;
    let anon = anon_key()?;
    let token = match bearer(require_user).await? {
        Some(t) => t,
        None => anon.clone(),
    };
    Ok(client()?
        .request(method, format!("{base}/rest/v1/{path}"))
        .header("apikey", anon)
        .header("Authorization", format!("Bearer {token}")))
}

async fn handle_json(resp: reqwest::Response) -> Result<Value, FeedbackError> {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|e| FeedbackError::Upstream(format!("malformed response: {e}")))
    } else {
        Err(map_http_error(status.as_u16(), &text))
    }
}

fn map_http_error(code: u16, body: &str) -> FeedbackError {
    let body = body.trim();
    match code {
        401 | 403 => FeedbackError::Auth(if body.is_empty() {
            "Not permitted".into()
        } else {
            format!("Not permitted: {body}")
        }),
        404 => FeedbackError::NotFound("Not found".into()),
        409 => FeedbackError::Invalid(format!("Conflict: {body}")),
        422 => FeedbackError::Invalid(format!("Rejected: {body}")),
        429 => FeedbackError::RateLimited("Too many requests — wait a moment".into()),
        _ => FeedbackError::Upstream(format!("HTTP {code}: {body}")),
    }
}

async fn fetch_profile(uid: &str) -> Result<Option<Value>, FeedbackError> {
    let resp = rest(Method::GET, &format!("profiles?id=eq.{uid}&select=*"), false)
        .await?
        .send()
        .await?;
    let arr = handle_json(resp).await?;
    Ok(arr.as_array().and_then(|a| a.first()).cloned())
}

// ════════════════════════ Phase 1 — auth + profile + posts ════════════════════════

#[tauri::command]
pub async fn feedback_otp_send(email: String) -> Result<Value, FeedbackError> {
    let email = email.trim().to_string();
    if !email.contains('@') || email.len() < 3 {
        return Err(FeedbackError::Invalid("Enter a valid email address".into()));
    }
    let base = base_url()?;
    let anon = anon_key()?;
    let resp = client()?
        .post(format!("{base}/auth/v1/otp"))
        .header("apikey", anon.as_str())
        .header("Content-Type", "application/json")
        .json(&json!({ "email": email, "create_user": true }))
        .send()
        .await?;
    handle_json(resp).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn feedback_otp_verify(email: String, token: String) -> Result<Value, FeedbackError> {
    let base = base_url()?;
    let anon = anon_key()?;
    let resp = client()?
        .post(format!("{base}/auth/v1/verify"))
        .header("apikey", anon.as_str())
        .header("Content-Type", "application/json")
        .json(&json!({ "type": "email", "email": email.trim(), "token": token.trim() }))
        .send()
        .await?;
    let v = handle_json(resp).await?;
    let sess = session_from_gotrue(&v)?;
    store_session(&sess)?;
    let uid = sess.user_id.clone();
    let profile = fetch_profile(&uid).await.ok().flatten();
    Ok(json!({ "signedIn": true, "userId": uid, "profile": profile }))
}

#[tauri::command]
pub async fn feedback_get_session() -> Result<Value, FeedbackError> {
    if load_session().is_none() {
        return Ok(json!({ "signedIn": false }));
    }
    // refresh-if-needed; a dead refresh token = graceful signed-out
    if bearer(true).await.is_err() {
        clear_session();
        return Ok(json!({ "signedIn": false }));
    }
    let uid = current_uid()?;
    let profile = fetch_profile(&uid).await.ok().flatten();
    Ok(json!({ "signedIn": true, "userId": uid, "profile": profile }))
}

#[tauri::command]
pub async fn feedback_sign_out() -> Result<Value, FeedbackError> {
    if let Some(s) = load_session() {
        if let (Ok(base), Ok(anon)) = (base_url(), anon_key()) {
            if let Ok(c) = client() {
                let _ = c
                    .post(format!("{base}/auth/v1/logout"))
                    .header("apikey", anon.as_str())
                    .header("Authorization", format!("Bearer {}", s.access_token))
                    .send()
                    .await;
            }
        }
    }
    clear_session();
    if let Ok(mut g) = SEEN.lock() {
        *g = None;
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn feedback_profile_get(user_id: Option<String>) -> Result<Value, FeedbackError> {
    let uid = match user_id {
        Some(u) if !u.is_empty() => u,
        _ => current_uid()?,
    };
    Ok(fetch_profile(&uid).await?.unwrap_or(Value::Null))
}

const RESERVED: &[&str] = &[
    "admin", "dev", "iskariel", "support", "mod", "moderator", "staff", "official", "system",
];

fn is_valid_handle(h: &str) -> bool {
    let n = h.chars().count();
    n >= 3
        && n <= 30
        && h.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[tauri::command]
pub async fn feedback_profile_upsert(
    handle: String,
    display_name: String,
) -> Result<Value, FeedbackError> {
    let uid = current_uid()?;
    let handle = handle.trim().to_lowercase();
    if !is_valid_handle(&handle) {
        return Err(FeedbackError::Invalid(
            "Handle must be 3–30 characters: a–z, 0–9, underscore".into(),
        ));
    }
    if RESERVED.contains(&handle.as_str()) {
        return Err(FeedbackError::Invalid("That handle is reserved".into()));
    }
    let body = json!({ "id": uid, "handle": handle, "display_name": display_name.trim() });
    let resp = rest(Method::POST, "profiles?on_conflict=id", true)
        .await?
        .header("Prefer", "resolution=merge-duplicates,return=representation")
        .json(&body)
        .send()
        .await?;
    let arr = handle_json(resp).await?;
    arr.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| FeedbackError::Upstream("profile not saved".into()))
}

#[tauri::command]
pub async fn feedback_posts_list(
    category: Option<String>,
    status: Option<String>,
    sort: Option<String>,
) -> Result<Value, FeedbackError> {
    let mut q = String::from(
        "posts?select=*,author:author_id(handle,display_name,avatar_url)&deleted=eq.false&hidden=eq.false",
    );
    if let Some(c) = category.filter(|c| c != "all" && !c.is_empty()) {
        q.push_str(&format!("&category=eq.{c}"));
    }
    if let Some(s) = status.filter(|s| s != "all" && !s.is_empty()) {
        q.push_str(&format!("&status=eq.{s}"));
    }
    let order = match sort.as_deref() {
        Some("top") => "pinned.desc,score.desc,created_at.desc",
        _ => "pinned.desc,created_at.desc",
    };
    q.push_str(&format!("&order={order}"));
    let resp = rest(Method::GET, &q, false).await?.send().await?;
    handle_json(resp).await
}

#[tauri::command]
pub async fn feedback_post_get(id: String) -> Result<Value, FeedbackError> {
    let q = format!("posts?id=eq.{id}&select=*,author:author_id(handle,display_name,avatar_url)");
    let resp = rest(Method::GET, &q, false).await?.send().await?;
    let arr = handle_json(resp).await?;
    arr.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| FeedbackError::NotFound("Post not found".into()))
}

#[tauri::command]
pub async fn feedback_post_create(
    category: String,
    title: String,
    body: String,
    attach_logs: bool,
    logs: Option<String>,
) -> Result<Value, FeedbackError> {
    let uid = current_uid()?;
    let title = title.trim();
    if title.chars().count() < 3 || title.chars().count() > 140 {
        return Err(FeedbackError::Invalid("Title must be 3–140 characters".into()));
    }
    if body.chars().count() > 8000 {
        return Err(FeedbackError::Invalid("Body too long (max 8000 characters)".into()));
    }
    if !matches!(category.as_str(), "bug" | "feature" | "improvement" | "other") {
        return Err(FeedbackError::Invalid("Pick a category".into()));
    }
    let resp = rest(Method::POST, "posts", true)
        .await?
        .header("Prefer", "return=representation")
        .json(&json!({ "author_id": uid, "category": category, "title": title, "body": body }))
        .send()
        .await?;
    let arr = handle_json(resp).await?;
    let post = arr
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| FeedbackError::Upstream("post not created".into()))?;
    if attach_logs {
        if let Some(pid) = post.get("id").and_then(|x| x.as_str()) {
            let diag = json!({
                "post_id": pid,
                "app_version": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "logs": logs.unwrap_or_default(),
            });
            // Best-effort: a failed diagnostics insert must not lose the post.
            if let Ok(rb) = rest(Method::POST, "post_diagnostics", true).await {
                let _ = rb.json(&diag).send().await;
            }
        }
    }
    Ok(post)
}

#[tauri::command]
pub async fn feedback_post_delete_own(id: String) -> Result<Value, FeedbackError> {
    let resp = rest(Method::PATCH, &format!("posts?id=eq.{id}"), true)
        .await?
        .json(&json!({ "deleted": true }))
        .send()
        .await?;
    handle_json(resp).await?;
    Ok(json!({ "ok": true }))
}

// ════════════════════════ Phase 2 — votes + comments ════════════════════════

/// Set the caller's directional vote on a post. `value`: +1 = up, -1 = down.
/// Clicking the current direction clears the vote; the opposite switches it.
/// (Name kept from the single-toggle era to avoid 4-site re-registration — it now
/// SETS a directional vote: `votes.value ∈ {-1,+1}`, one row per (post,user).)
#[tauri::command]
pub async fn feedback_vote_toggle(post_id: String, value: i64) -> Result<Value, FeedbackError> {
    let uid = current_uid()?;
    let dir: i64 = if value < 0 { -1 } else { 1 };
    // Read the current vote (if any) to decide toggle-off vs. switch.
    let current = handle_json(
        rest(
            Method::GET,
            &format!("votes?post_id=eq.{post_id}&user_id=eq.{uid}&select=value"),
            true,
        )
        .await?
        .send()
        .await?,
    )
    .await?;
    let current_val = current
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_i64());
    // Clear any existing vote first (idempotent), then re-insert unless toggling off.
    if current_val.is_some() {
        handle_json(
            rest(
                Method::DELETE,
                &format!("votes?post_id=eq.{post_id}&user_id=eq.{uid}"),
                true,
            )
            .await?
            .send()
            .await?,
        )
        .await?;
    }
    let new_val: i64 = if current_val == Some(dir) {
        0 // same direction clicked → vote removed
    } else {
        handle_json(
            rest(Method::POST, "votes", true)
                .await?
                .json(&json!({ "post_id": post_id, "user_id": uid, "value": dir }))
                .send()
                .await?,
        )
        .await?;
        dir
    };
    // Return the post's fresh denormalized counts so the UI updates without a refetch.
    let post = handle_json(
        rest(
            Method::GET,
            &format!("posts?id=eq.{post_id}&select=upvote_count,downvote_count,score"),
            false,
        )
        .await?
        .send()
        .await?,
    )
    .await?;
    let counts = post
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(json!({
        "value": new_val,
        "upvote_count": counts.get("upvote_count").cloned().unwrap_or_else(|| json!(0)),
        "downvote_count": counts.get("downvote_count").cloned().unwrap_or_else(|| json!(0)),
        "score": counts.get("score").cloned().unwrap_or_else(|| json!(0)),
    }))
}

#[tauri::command]
pub async fn feedback_comments_list(post_id: String) -> Result<Value, FeedbackError> {
    let q = format!(
        "comments?post_id=eq.{post_id}&deleted=eq.false&select=*,author:profiles(handle,display_name,avatar_url)&order=created_at.asc"
    );
    let resp = rest(Method::GET, &q, false).await?.send().await?;
    handle_json(resp).await
}

#[tauri::command]
pub async fn feedback_comment_create(post_id: String, body: String) -> Result<Value, FeedbackError> {
    let _uid = current_uid()?;
    let body = body.trim();
    if body.is_empty() || body.chars().count() > 4000 {
        return Err(FeedbackError::Invalid("Comment must be 1–4000 characters".into()));
    }
    let resp = rest(Method::POST, "comments", true)
        .await?
        .header("Prefer", "return=representation")
        .json(&json!({ "post_id": post_id, "author_id": _uid, "body": body }))
        .send()
        .await?;
    let arr = handle_json(resp).await?;
    arr.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| FeedbackError::Upstream("comment not created".into()))
}

#[tauri::command]
pub async fn feedback_comment_delete_own(id: String) -> Result<Value, FeedbackError> {
    let resp = rest(Method::PATCH, &format!("comments?id=eq.{id}"), true)
        .await?
        .json(&json!({ "deleted": true }))
        .send()
        .await?;
    handle_json(resp).await?;
    Ok(json!({ "ok": true }))
}

/// Post ids the signed-in user has voted on / follows — for "my vote" + "following"
/// highlights. votes are world-readable; follows are own-only (RLS).
#[tauri::command]
pub async fn feedback_my_interactions() -> Result<Value, FeedbackError> {
    let uid = current_uid()?;
    let votes = handle_json(
        rest(Method::GET, &format!("votes?user_id=eq.{uid}&select=post_id,value"), true)
            .await?
            .send()
            .await?,
    )
    .await?;
    let follows = handle_json(
        rest(Method::GET, &format!("follows?user_id=eq.{uid}&select=post_id"), true)
            .await?
            .send()
            .await?,
    )
    .await?;
    Ok(json!({ "votes": votes, "follows": follows }))
}

// ════════════════════════ Phase 3 — follow + notifications + dev ════════════════════════

#[tauri::command]
pub async fn feedback_follow_toggle(post_id: String) -> Result<Value, FeedbackError> {
    let uid = current_uid()?;
    let del = rest(
        Method::DELETE,
        &format!("follows?post_id=eq.{post_id}&user_id=eq.{uid}"),
        true,
    )
    .await?
    .header("Prefer", "return=representation")
    .send()
    .await?;
    let removed = handle_json(del).await?;
    let was_following = removed.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if was_following {
        return Ok(json!({ "following": false }));
    }
    let ins = rest(Method::POST, "follows", true)
        .await?
        .json(&json!({ "post_id": post_id, "user_id": uid }))
        .send()
        .await?;
    handle_json(ins).await?;
    Ok(json!({ "following": true }))
}

#[tauri::command]
pub async fn feedback_notifications_poll() -> Result<Value, FeedbackError> {
    let q = "notifications?read_at=is.null&select=id,kind,created_at,post:post_id(id,title),actor:actor_id(handle,display_name)&order=created_at.desc";
    let resp = rest(Method::GET, q, true).await?.send().await?;
    handle_json(resp).await
}

#[tauri::command]
pub async fn feedback_notifications_mark_read(ids: Vec<String>) -> Result<Value, FeedbackError> {
    if ids.is_empty() {
        return Ok(json!({ "ok": true }));
    }
    let list = ids.join(",");
    let now = chrono::Utc::now().to_rfc3339();
    let resp = rest(Method::PATCH, &format!("notifications?id=in.({list})"), true)
        .await?
        .json(&json!({ "read_at": now }))
        .send()
        .await?;
    handle_json(resp).await?;
    Ok(json!({ "ok": true }))
}

// dev powers — RLS (`is_dev()` + the posts/comments triggers) is the real gate;
// a non-dev call simply no-ops (status/pinned/hidden reset) or is rejected.
#[tauri::command]
pub async fn feedback_post_set_status(id: String, status: String) -> Result<Value, FeedbackError> {
    if !matches!(
        status.as_str(),
        "open" | "under_review" | "planned" | "in_progress" | "done" | "declined"
    ) {
        return Err(FeedbackError::Invalid("Invalid status".into()));
    }
    let resp = rest(Method::PATCH, &format!("posts?id=eq.{id}"), true)
        .await?
        .header("Prefer", "return=representation")
        .json(&json!({ "status": status }))
        .send()
        .await?;
    let arr = handle_json(resp).await?;
    arr.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| FeedbackError::Auth("Not permitted (dev only)".into()))
}

#[tauri::command]
pub async fn feedback_post_pin(id: String, pinned: bool) -> Result<Value, FeedbackError> {
    let resp = rest(Method::PATCH, &format!("posts?id=eq.{id}"), true)
        .await?
        .header("Prefer", "return=representation")
        .json(&json!({ "pinned": pinned }))
        .send()
        .await?;
    let arr = handle_json(resp).await?;
    arr.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| FeedbackError::Auth("Not permitted (dev only)".into()))
}

#[tauri::command]
pub async fn feedback_post_delete_any(id: String, hide: bool) -> Result<Value, FeedbackError> {
    // hide=true → dev soft-hide; else hard soft-delete. Both dev-gated by RLS.
    let field = if hide { "hidden" } else { "deleted" };
    let resp = rest(Method::PATCH, &format!("posts?id=eq.{id}"), true)
        .await?
        .json(&json!({ field: true }))
        .send()
        .await?;
    handle_json(resp).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn feedback_comment_delete_any(id: String) -> Result<Value, FeedbackError> {
    let resp = rest(Method::PATCH, &format!("comments?id=eq.{id}"), true)
        .await?
        .json(&json!({ "deleted": true }))
        .send()
        .await?;
    handle_json(resp).await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn feedback_comment_official_reply(
    post_id: String,
    body: String,
) -> Result<Value, FeedbackError> {
    let uid = current_uid()?;
    let body = body.trim();
    if body.is_empty() || body.chars().count() > 4000 {
        return Err(FeedbackError::Invalid("Reply must be 1–4000 characters".into()));
    }
    let resp = rest(Method::POST, "comments", true)
        .await?
        .header("Prefer", "return=representation")
        .json(&json!({ "post_id": post_id, "author_id": uid, "body": body, "is_official": true }))
        .send()
        .await?;
    let arr = handle_json(resp).await?;
    arr.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| FeedbackError::Auth("Not permitted (dev only)".into()))
}

// ════════════════════════ Phase 4 — avatars ════════════════════════

#[tauri::command]
pub async fn feedback_avatar_upload(
    bytes: Vec<u8>,
    content_type: String,
) -> Result<Value, FeedbackError> {
    let uid = current_uid()?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(FeedbackError::Invalid("Image too large (max 4 MB)".into()));
    }
    if !matches!(
        content_type.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp"
    ) {
        return Err(FeedbackError::Invalid("Only PNG, JPEG, or WebP images".into()));
    }
    // Decode → downscale → re-encode to PNG (strips EXIF + any embedded metadata).
    let img = image::load_from_memory(&bytes)
        .map_err(|e| FeedbackError::Invalid(format!("Not a valid image: {e}")))?;
    let img = img.resize(256, 256, image::imageops::FilterType::Lanczos3);
    let mut out: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| FeedbackError::Upstream(format!("re-encode failed: {e}")))?;

    let base = base_url()?;
    let anon = anon_key()?;
    let token = bearer(true)
        .await?
        .ok_or_else(|| FeedbackError::Auth("Not signed in".into()))?;
    let object_path = format!("avatars/{uid}/avatar.png");
    let resp = client()?
        .post(format!("{base}/storage/v1/object/{object_path}"))
        .header("apikey", anon.as_str())
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "image/png")
        .header("x-upsert", "true")
        .body(out)
        .send()
        .await?;
    handle_json(resp).await?;

    // Public URL with a cache-buster so the new avatar shows immediately.
    let public_url = format!(
        "{base}/storage/v1/object/public/{object_path}?v={}",
        now_secs()
    );
    let pr = rest(Method::PATCH, &format!("profiles?id=eq.{uid}"), true)
        .await?
        .header("Prefer", "return=representation")
        .json(&json!({ "avatar_url": public_url }))
        .send()
        .await?;
    handle_json(pr).await?;
    Ok(json!({ "avatarUrl": public_url }))
}

// ════════════════════════ background poll (in-app notifications) ════════════════════════
// Mirrors `self_update::spawn_poll`: a 60s loop that surfaces new notifications as
// toasts through the existing bell. Pauses when the window is unfocused and when
// signed out. RLS scopes the inbox to the signed-in user.

const POLL_SECS: u64 = 60;
static FOCUSED: AtomicBool = AtomicBool::new(true);
// Dedup set of notification ids already toasted. None until the first signed-in
// poll, which SEEDS (no toast) so pre-existing unread don't flood on startup.
static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Wired into `lib.rs` `on_window_event` next to `self_update::record_focus_change`.
pub fn record_focus_change(focused: bool) {
    FOCUSED.store(focused, Ordering::Relaxed);
}

/// Started from `lib.rs` `setup`. Fire-and-forget; cheap when signed out/unfocused.
pub fn spawn_poll(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
            if !FOCUSED.load(Ordering::Relaxed) || load_session().is_none() {
                continue;
            }
            match poll_notifications().await {
                Ok(items) => {
                    for it in items {
                        let _ = app.emit("feedback:notify", &it);
                    }
                }
                Err(e) => eprintln!("feedback poll: {e:?}"),
            }
        }
    });
}

async fn poll_notifications() -> Result<Vec<Value>, FeedbackError> {
    let q = "notifications?read_at=is.null&select=id,kind,created_at,post:post_id(id,title),actor:actor_id(handle,display_name)&order=created_at.asc";
    let resp = rest(Method::GET, q, true).await?.send().await?;
    let arr = handle_json(resp).await?;
    let arr = arr.as_array().cloned().unwrap_or_default();

    let mut out = Vec::new();
    let mut guard = SEEN.lock().map_err(|_| FeedbackError::Io("poll lock".into()))?;
    let first_run = guard.is_none();
    let set = guard.get_or_insert_with(HashSet::new);
    for n in arr {
        let id = match n.get("id").and_then(|x| x.as_str()) {
            Some(i) if !i.is_empty() => i.to_string(),
            _ => continue,
        };
        if set.contains(&id) {
            continue;
        }
        set.insert(id);
        if !first_run {
            out.push(notif_to_toast(&n));
        }
    }
    // ponytail: bounded dedup memory; clearing risks one re-toast, never a leak.
    if set.len() > 1000 {
        set.clear();
    }
    Ok(out)
}

fn notif_to_toast(n: &Value) -> Value {
    let title = n.pointer("/post/title").and_then(|x| x.as_str()).unwrap_or("a post");
    let actor = n
        .pointer("/actor/handle")
        .and_then(|x| x.as_str())
        .unwrap_or("Someone");
    let (heading, message) = match n.get("kind").and_then(|x| x.as_str()).unwrap_or("") {
        "status_change" => ("Status updated".to_string(), format!("\"{title}\" moved on the roadmap")),
        "official_reply" => ("Official reply".to_string(), format!("A dev replied on \"{title}\"")),
        _ => ("New comment".to_string(), format!("{actor} commented on \"{title}\"")),
    };
    json!({
        "type": "feedback",
        "title": heading,
        "message": message,
        "iconKey": "bell",
        "duration": 9000,
    })
}
