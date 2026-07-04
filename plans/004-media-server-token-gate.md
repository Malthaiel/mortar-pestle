# Plan 004: Token-gate the media server `/media` route

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — otherwise skip.
>
> **Drift check (run first)**:
> `git -C C:/Users/malth/Code/mortar-pestle diff --stat 57a6c80..HEAD -- src-tauri/src/media_server.rs src-tauri/src/lib.rs web/src/api.js`
> Expected: no output. If any of these changed, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The app runs a loopback HTTP server (`127.0.0.1`, kernel-random port) so
WebView media elements can load bytes. Its `/media?path=<abs>` route serves
**any absolute path under an allowed root, gated only by path containment — no
access token**. Its sibling routes (`/transcode/:hash`, `/subs/:hash`,
`/editor-proxy/:hash`) require an unguessable 16-hex registry key that must
already exist in an in-process registry, so an outsider cannot forge one.

`/media` responses set `Access-Control-Allow-Origin: *` and the preflight sets
`Access-Control-Allow-Private-Network: true` — which is what makes this
reachable: those two headers are exactly the opt-in that lets a **public web
page** (via Private Network Access) or **any local process** that discovers the
ephemeral port read arbitrary vault/Library/captures files cross-origin. The
only things standing in the way are port entropy and knowing an absolute path —
and the default vault path (`~/Documents/Citadel`) is well-known.

The `ACAO: *` itself is an accepted decision (loopback-only server); the
**missing token is the gap**. The transcode lane already proves the token
pattern. This plan mints a per-session random token at bind time and requires
it on `/media`, closing the read-any-file hole without changing the accepted
CORS posture.

## Current state

**`src-tauri/src/media_server.rs`** — the server. The module doc already
concedes the routes are "no auth" (lines 10-12) and that the hash routes carry
"the hash-prefix access-token check" while `/media` does not.

Port storage and bind, `media_server.rs:45-66`:
```rust
static SERVER_PORT: OnceLock<u16> = OnceLock::new();

pub fn port() -> Option<u16> {
    SERVER_PORT.get().copied()
}

/// Bind to a kernel-assigned port on 127.0.0.1 and run the router until exit.
/// Returns the bound port via `port()` once `setup` completes.
pub async fn run() -> std::io::Result<()> {
    let app = Router::new()
        .route("/media", get(handle_media).options(handle_preflight))
        .route("/transcode/:hash", get(handle_transcode).options(handle_preflight))
        .route("/subs/:hash", get(handle_subs).options(handle_preflight))
        .route("/editor-proxy/:hash", get(handle_editor_proxy).options(handle_preflight));

    let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let listener = TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    let _ = SERVER_PORT.set(local.port());
    log::info!("media server listening on http://{}", local);
    axum::serve(listener, app).await
}
```

The query type and the **unauthenticated** handler, `media_server.rs:68-107`:
```rust
#[derive(Deserialize)]
struct MediaQuery {
    path: String,
}

async fn handle_media(Query(q): Query<MediaQuery>, headers: HeaderMap) -> Response<Body> {
    use std::fs;
    use std::path::PathBuf;

    // Strip a Windows `\\?\` verbatim prefix. [...]
    let requested = PathBuf::from(q.path.strip_prefix(r"\\?\").unwrap_or(&q.path));
    let canonical = match fs::canonicalize(&requested) {
        Ok(p) => p,
        Err(_) => return status(StatusCode::NOT_FOUND, "not found"),
    };
    if !is_under_allowed_root(&canonical) {
        return status(StatusCode::FORBIDDEN, "outside allowed root");
    }
    // ... serves the file (Range or full) ...
}
```
`is_under_allowed_root` (`src-tauri/src/commands/media.rs:344`) accepts any path
under the vault, Library vault, App vault, captures dir, or a media root — a
large surface. Containment is the **only** gate today.

The CORS headers that make cross-origin reads possible — preflight,
`media_server.rs:243-253`:
```rust
async fn handle_preflight() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range, Content-Type")
        .header("Access-Control-Allow-Private-Network", "true")
        .header("Access-Control-Max-Age", "86400")
        .body(Body::empty())
        // ...
}
```

**`src-tauri/src/lib.rs`** — the IPC command the frontend calls to learn the
port, `lib.rs:31-34`:
```rust
#[tauri::command]
fn media_server_port() -> Option<u16> {
    media_server::port()
}
```
It is already ACL-wired (registered in `generate_handler!` at `lib.rs:611` and
allowed as `allow-media-server-port` in `capabilities/default.json`). The
server is spawned in setup at `lib.rs:264` (`media_server::run().await`).

**`web/src/api.js`** — the frontend fetches the port once and caches a base
URL, `api.js:53-69`:
```js
async function mediaBaseUrl() {
  if (_mediaBaseUrl) return _mediaBaseUrl;
  if (!_mediaBaseUrlPromise) {
    _mediaBaseUrlPromise = invoke('media_server_port')
      .then((port) => {
        if (typeof port === 'number' && port > 0) {
          _mediaBaseUrl = `http://127.0.0.1:${port}`;
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('agentic:media-server-ready', { detail: { baseUrl: _mediaBaseUrl } }));
          }
        }
        return _mediaBaseUrl;
      })
      .catch(() => null);
  }
  return _mediaBaseUrlPromise;
}
```

**The ONE place the `/media` URL is built**, `api.js:107-116`:
```js
export function mediaHttpUrl(p, opts) {
  if (!p) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  if (!_mediaBaseUrl) {
    mediaBaseUrl();
    return null;
  }
  const abs = absFromInput(p, opts && opts.library ? LIBRARY_ROOT_FOR_MEDIA : undefined);
  return `${_mediaBaseUrl}/media?path=${encodeURIComponent(abs)}`;
}
```
A repo-wide grep of `web/` and `modules/` for `/media?path=` construction finds
**only** this line — `rewriteAssetToHttp` (`api.js:120-125`) rewrites
`mortar-pestle-asset://localhost/...` URLs into `/transcode|/subs|/editor-proxy`
URLs (which already carry their hash) and does **not** build `/media`, so it
needs no change.

**Token primitive available** — `src-tauri/Cargo.toml:53`:
`uuid = { version = "1", features = ["v4"] }`. `uuid::Uuid::new_v4().simple().to_string()`
yields 32 lowercase hex chars (122 bits of entropy) — an unguessable
per-session token, URL-safe with no encoding.

## How the fix works (read before writing)

1. Mint a random token in `media_server::run()` and store it in a new
   `SERVER_TOKEN` `OnceLock` **before** setting `SERVER_PORT` (so any reader
   that sees a port also sees a token). Expose it with a `token()` accessor
   mirroring `port()`.
2. Require the token on `/media`: add an `Option<String>` `t` field to
   `MediaQuery` and reject (403) any request whose `t` doesn't equal the
   session token, **before** `fs::canonicalize` (don't touch the FS for an
   unauthorized caller). The other three routes are untouched — their hash IS
   their token.
3. Thread the token to the frontend by **reusing** the existing
   `media_server_port` command (already ACL-wired): change its return type from
   `Option<u16>` to a small `{ port, token }` struct. This avoids adding a new
   IPC command (which would need the 3-site ACL wiring: `build.rs` +
   `capabilities/default.json` + `generate_handler!`). Keep the command name.
4. Update the single frontend consumer (`mediaBaseUrl`) to capture the token,
   and the single `/media` URL builder (`mediaHttpUrl`) to append `&t=<token>`.

Plain `==` token comparison is acceptable here: the value is a 122-bit
per-session secret compared over loopback; a timing side-channel is not
practical. `rewriteAssetToHttp` is deliberately left alone.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Compile + Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` (run in `C:/Users/malth/Code/mortar-pestle`) | compiles, all tests pass, exit 0 |
| Frontend syntax/lint (if configured) | `npm run lint` (in repo root) | exit 0 |
| Dev run (manual smoke) | `npm run tauri dev` | app window opens; media plays (see Step 5) |

**Landmine — never run `cargo test --lib`**: it SIGTERMs the dev sandbox. Use
`--tests` only (it still runs the in-module `#[cfg(test)]` unit tests).

## Scope

**In scope**:
- `src-tauri/src/media_server.rs` — add `SERVER_TOKEN` + `token()`; mint in
  `run()`; add `t` field + token check in `handle_media`.
- `src-tauri/src/lib.rs` — change `media_server_port` to return `{ port, token }`.
- `web/src/api.js` — capture the token in `mediaBaseUrl`; append `&t=` in
  `mediaHttpUrl`.

**Out of scope** (do NOT touch):
- `/transcode`, `/subs`, `/editor-proxy` handlers and their preflight — they are
  already gated by the registry hash; adding a second token there is redundant
  and risks breaking playback.
- `rewriteAssetToHttp` in `api.js` — it builds hash routes, not `/media`.
- `capabilities/default.json`, `src-tauri/build.rs`, `generate_handler!` — the
  fix reuses the existing `media_server_port` command, so no new ACL entry.
- The `ACAO: *` / `Access-Control-Allow-Private-Network` headers — the accepted
  CORS posture stays; the token is the added gate.

## Git workflow

- Branch: `advisor/004-media-server-token-gate`.
- One commit; repo style — e.g.
  `security(media): token-gate /media route (per-session token)`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Mint and expose a session token in `media_server.rs`

Below `SERVER_PORT` (`media_server.rs:45`), add:
```rust
static SERVER_TOKEN: OnceLock<String> = OnceLock::new();
```
Below `port()` (`media_server.rs:47-49`), add an accessor:
```rust
pub fn token() -> Option<String> {
    SERVER_TOKEN.get().cloned()
}
```
In `run()`, set the token **before** `SERVER_PORT.set(...)` (replace the single
line `let _ = SERVER_PORT.set(local.port());` at `media_server.rs:63` with):
```rust
    let _ = SERVER_TOKEN.set(uuid::Uuid::new_v4().simple().to_string());
    let _ = SERVER_PORT.set(local.port());
```

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → compiles
(a warning that `token` is unused is expected until Step 3), tests pass.

### Step 2: Require the token in `handle_media`

Add a token field to the query type (`media_server.rs:68-71`):
```rust
#[derive(Deserialize)]
struct MediaQuery {
    path: String,
    t: Option<String>,
}
```
In `handle_media`, insert the check as the **first** thing in the body (before
the `let requested = ...` line at `media_server.rs:82`):
```rust
    // Access token: /media serves any path under an allowed root, so unlike the
    // hash routes it needs its own capability token (minted per-session in run()).
    // Reject before touching the filesystem.
    let ok = matches!((token(), q.t.as_deref()), (Some(t), Some(qt)) if t == qt);
    if !ok {
        return status(StatusCode::FORBIDDEN, "bad or missing token");
    }
```

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → compiles,
tests pass.

### Step 3: Return the token from the `media_server_port` command

In `lib.rs`, replace the command at `lib.rs:31-34`:
```rust
#[derive(serde::Serialize)]
struct MediaServerInfo {
    port: u16,
    token: String,
}

#[tauri::command]
fn media_server_port() -> Option<MediaServerInfo> {
    match (media_server::port(), media_server::token()) {
        (Some(port), Some(token)) => Some(MediaServerInfo { port, token }),
        _ => None,
    }
}
```
Do NOT change its registration in `generate_handler!` (`lib.rs:611`) or the
capability entry — the command name is unchanged.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → compiles,
tests pass, no "unused `token`" warning remains.

### Step 4: Consume the token in the frontend

In `web/src/api.js`, add a module-level token cache next to `_mediaBaseUrl`
(`api.js:51-52`):
```js
let _mediaBaseUrl = null;
let _mediaToken = null;
let _mediaBaseUrlPromise = null;
```
Update `mediaBaseUrl` (`api.js:56-64`) to destructure the new struct — the
`.then((port) => ...)` callback becomes:
```js
    _mediaBaseUrlPromise = invoke('media_server_port')
      .then((info) => {
        if (info && typeof info.port === 'number' && info.port > 0) {
          _mediaBaseUrl = `http://127.0.0.1:${info.port}`;
          _mediaToken = info.token;
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('agentic:media-server-ready', { detail: { baseUrl: _mediaBaseUrl } }));
          }
        }
        return _mediaBaseUrl;
      })
      .catch(() => null);
```
Append the token in `mediaHttpUrl` (`api.js:115`) — replace the return line:
```js
  return `${_mediaBaseUrl}/media?path=${encodeURIComponent(abs)}&t=${_mediaToken}`;
```
(`_mediaToken` is set on the same tick as `_mediaBaseUrl`; the existing
`if (!_mediaBaseUrl) { ...; return null; }` guard above already prevents building
a URL before both are cached.)

**Verify**: `npm run lint` → exit 0 (if lint is configured; otherwise confirm the
file parses by starting the dev build in Step 5).

### Step 5: Manual GUI smoke test (playback cannot be verified headless)

Headless/CI cannot verify actual `<audio>`/`<video>` playback — state this in
your report. Run `npm run tauri dev` and:
1. Open a page/module that plays media (e.g. a Library album track, a Game
   Capture clip, or any `<video>`/`<audio>` surface). It must play — confirming
   the token round-trips and `/media` still serves for the real app.
2. In the app devtools console, confirm a media element's `src` looks like
   `http://127.0.0.1:<port>/media?path=...&t=<32-hex>`.
3. Negative check: in the console, fetch the same URL **without** the token and
   confirm a 403:
   ```js
   fetch(document.querySelector('audio,video').src.replace(/&t=[^&]*/, ''))
     .then(r => console.log('status', r.status));   // expect: status 403
   ```

If media does not play with the token present, STOP and report (the token is
not round-tripping — do not disable the check to "make it work").

## Test plan

- No new automated test is required; the existing Rust suite must still pass
  (`cargo test --manifest-path src-tauri/Cargo.toml --tests`), proving the
  handler/type changes compile and don't regress.
- The security behavior is verified manually in Step 5: token present → plays;
  token stripped → 403. Record both observations in your report.
- (Optional, only if you can already exercise the server in a test) a request to
  `/media?path=<any>` with no `t` returns 403 — but do not add an integration
  harness for this if none exists; the Step-5 console check is sufficient.

## Done criteria

ALL must hold:

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0.
- [ ] `handle_media` returns 403 before `fs::canonicalize` when `t` is absent or wrong.
- [ ] `media_server_port` returns `{ port, token }`; `web/src/api.js` builds `/media?...&t=<token>`.
- [ ] Manual Step 5: media plays with the token; the same URL minus `&t=` returns 403.
- [ ] `git status` shows only the three in-scope files modified.
- [ ] No new entry added to `capabilities/default.json` / `build.rs` / `generate_handler!`.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The drift check shows `media_server.rs`, `lib.rs`, or `api.js` changed since
  `57a6c80` and the live code no longer matches the excerpts.
- You cannot find the `/media?path=` builder at `api.js:115` (or a grep of
  `web/` + `modules/` finds a **second** place that builds a `/media` URL not
  covered by Step 4) — the token must be injected at every builder or the app
  breaks; surface the extra call site instead of guessing.
- `cargo test ... --tests` fails to compile twice after a reasonable fix.
- Step 5 media playback fails with the token present.
- The fix seems to require touching an out-of-scope file (esp. the ACL files or
  the hash-route handlers).

## Maintenance notes

For whoever owns the media server next:

- The token is per **process run** (fresh on every app launch), stored in a
  `OnceLock`. It is minted in `run()` before `SERVER_PORT` is set, so
  `media_server_port` never returns a port without a token.
- Any **new** route that serves a caller-supplied path (as opposed to an
  internal registry hash) must apply the same token check `handle_media` uses.
  Routes keyed by an unguessable in-process hash (`/transcode`, `/subs`,
  `/editor-proxy`) do not need it.
- If a future consumer builds a `/media` URL outside `mediaHttpUrl`, it must
  append `&t=${_mediaToken}` (import the token or route through `mediaHttpUrl`).
  A reviewer should grep `web/` + `modules/` for `/media?path=` to confirm
  `mediaHttpUrl` stays the sole builder.
- The `ACAO: *` + PNA headers are intentionally retained (loopback-only server,
  accepted decision); the token — not CORS narrowing — is the access gate. Do
  not "fix" this by removing the CORS headers; that breaks WebView media without
  closing anything the token doesn't already close.
