# Plan 012: Coalesce manifest patches and diff-apply on the frontend to survive bulk writes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md` **if that file exists** (it may not yet — do not create it).
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/manifest_gen.rs src-tauri/src/watcher.rs web/src/lib/manifestReader.js`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M-L
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Every in-app markdown write/delete/rename patches the content vault's
`Infrastructure/.cache/vault_manifest.json` so wikilink/graph/stat UI stays
fresh mid-session. The patch is a **read-modify-write of the entire file**: read
the whole JSON, `serde_json` parse it, mutate one entry, re-serialize, atomically
rewrite the whole thing (`manifest_gen.rs:186-210`). The watcher then sees the
file change and emits a `manifest` event (`watcher.rs:131`), and the frontend
reader (`manifestReader.js:39-49`) invalidates its cache, **re-fetches the full
file over IPC, `JSON.parse`s the whole rich document on the main thread**, and
pushes it to all 8 `useManifestData()` consumers — one of which
(`modules/core/graph/index.jsx`) rebuilds the entire link graph via
`buildLinkGraph`, an O(N) pass.

So a **single** note save costs: one full-file re-serialize + rewrite (Rust) +
one full-file re-fetch + re-parse (JS main thread) + up to 8 re-renders including
an O(N) graph rebuild. A **bulk** in-app op — e.g. a MAL/CSV library import
writing hundreds of cards (`library_import.rs` loops writing one card per
entry), or any skill/download writing many `.md` — multiplies that by N, and any
patches landing more than the watcher's 200 ms debounce apart become an **event
storm** of full re-parses and graph rebuilds. On a large vault this janks the UI
for the whole import.

This plan (1) **coalesces the manifest writes** at the single Rust choke point so
a bulk op produces one read-modify-write + one `manifest` event per short flush
window instead of N, and (2) makes the **frontend skip redundant re-parses**
when the coalesced fetch is byte-identical to what it already holds. The
field-preserving contract with Citadel's Python-built manifest is honored
verbatim — the batched write is the *same* read-modify-write, just deferred and
composed, so the rich Python-owned fields (`type`, `domain`, `headings`,
`outbound_links`, …) survive exactly as they do today.

## Current state

### The Rust choke point — `src-tauri/src/commands/manifest_gen.rs`

The module doc already states the contract this plan must not break
(`manifest_gen.rs:164-177`):

```rust
// The CONTENT vault's `Infrastructure/.cache/vault_manifest.json` is built by
// Citadel's Python `manifest_rebuild.py` (SessionStart hook) and carries rich
// graph fields (type, domain, headings, outbound_links, …) that vault tooling
// depends on — the app must NEVER regenerate that file wholesale. But an
// in-app markdown write/delete/rename would otherwise leave it stale all
// session ... These helpers patch only the affected entries in place,
// preserving every field they don't own ... Best-effort by design: every
// failure logs and returns — the next rebuild reconciles.
```

`patch_manifest_doc` is the **single function every patch routes through** — it
does the full read-modify-write (`manifest_gen.rs:186-210`):

```rust
fn patch_manifest_doc(mutate: impl FnOnce(&mut Vec<serde_json::Value>) -> Option<i64>) {
    let path = content_manifest_file();
    let Ok(text) = fs::read_to_string(&path) else { return };            // whole file read
    let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(&text) else {  // whole parse
        log::warn!("manifest patch: unparseable {}; skipping", path.display());
        return;
    };
    let Some(entries) = doc.get_mut("entries").and_then(|e| e.as_array_mut()) else {
        return;
    };
    let Some(delta) = mutate(entries) else { return };
    if delta != 0 {
        if let Some(n) = doc.get("vault_file_count").and_then(|v| v.as_i64()) {
            doc["vault_file_count"] = serde_json::Value::from((n + delta).max(0));
        }
    }
    match serde_json::to_string(&doc) {                                   // whole re-serialize
        Ok(out) => {
            if let Err(e) = atomic_write(&path, out.as_bytes()) {         // whole rewrite
                log::warn!("manifest patch: write failed: {e:?}");
            }
        }
        Err(e) => log::warn!("manifest patch: serialize failed: {e}"),
    }
}
```

All three public patch entry points funnel into it — **confirmed** by reading the file:

- `patch_content_manifest(rel, removed)` — one file upsert/drop; calls
  `patch_manifest_doc` at `manifest_gen.rs:223`. The upsert branch reads the
  file's *current* content inside the closure (`manifest_gen.rs:232-237`), so
  deferring the closure to flush time reads the file's *final* state — which is
  correct, if anything more so.
- `patch_content_manifest_rename(from, to, is_dir)` — for a file, calls
  `patch_content_manifest` twice (`manifest_gen.rs:261-263`); for a dir, calls
  `patch_manifest_doc` directly (`manifest_gen.rs:268`).
- `patch_content_manifest_remove_prefix(rel)` — calls `patch_manifest_doc`
  (`manifest_gen.rs:287`).

Because every path composes a `mutate` closure over `&mut Vec<serde_json::Value>`
and returns an `Option<i64>` count delta, **the closures compose**: applying
several of them in insertion order to one freshly-read `doc` produces the same
result as running them one-at-a-time, each with its own read-modify-write.

### The event bridge — `src-tauri/src/watcher.rs`

The manifest file's own change is what emits the `manifest` event
(`watcher.rs:126-133`), with **no payload**:

```rust
    match normalized.as_str() {
        "Pulse/Schedule.md" => return vec![("schedule", None)],
        "Pulse/Recurring Tasks.md" => return vec![("routine", None)],
        "Infrastructure/Vault State/Log.md" => return vec![("log", None)],
        "Infrastructure/Vault State/Update Queue.md" => return vec![("queue", None)],
        "Infrastructure/.cache/vault_manifest.json" => return vec![("manifest", None)],
        _ => {}
    }
```

The watcher debounces 200 ms (`watcher.rs:22` `const DEBOUNCE_MS: u64 = 200;`)
and dedupes paths per batch (`watcher.rs:55`). So *if* the Rust side rewrites the
manifest file once per flush window, the debouncer already collapses those into
**one** `manifest` emit. Fewer rewrites ⇒ fewer events, for free. Note the event
carries `None` — there is **no per-entry diff on the wire today**; the frontend
learns *that* the manifest changed, not *what* changed.

### The frontend reader — `web/src/lib/manifestReader.js`

On every `manifest` event the reader nukes its cache and re-fetches + re-parses
the whole file (`manifestReader.js:22-49`):

```js
async function loadManifest() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const result = await invoke('vault_read_file', { path: MANIFEST_PATH });
      const text = typeof result === 'string' ? result : result?.content;
      if (!text) throw new Error('Empty manifest response');
      _cache = JSON.parse(text);          // full parse of the rich doc, main thread
      return _cache;
    } finally {
      _loadPromise = null;
    }
  })();
  return _loadPromise;
}

function ensureWatcher() {
  if (_watching) return;
  _watching = true;
  subscribeEvents((name) => {
    if (name !== 'manifest') return;
    _cache = null;                        // invalidate; the re-fetch below repopulates
    loadManifest()
      .then((d) => { for (const fn of _subs) fn(d); })   // notify ALL subscribers
      .catch((err) => console.error('[manifestReader] refresh failed', err));
  });
}
```

The **8 consumers** that re-render on each notify (verified via
`grep -rn useManifestData` — one file has two call sites):

| Consumer | Call site |
|---|---|
| Graph page (module) — **rebuilds the whole link graph via `buildLinkGraph`, O(N)** | `modules/core/graph/index.jsx:15` |
| Graph page (web) | `web/src/pages/GraphPage.jsx:50` |
| Backlinks panel | `web/src/components/PageLinksPanel.jsx:55` |
| Pulse module | `modules/core/pulse/index.jsx:18` |
| Vault module | `modules/core/vault/index.jsx:42` |
| Library module (×2) | `modules/core/library/index.jsx:33`, `:56` |
| Music notes | `modules/core/library/music/MusicNotes.jsx:67` |

The reader only needs `{path, title, aliases, mtime}` per entry, yet `JSON.parse`
inflates the full rich doc every time. `buildLinkGraph` lives at
`modules/core/graph/index.jsx` and `web/src/pages/GraphPage.jsx` (out of scope —
do not touch it; coalescing the events is what relieves it).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | compiles; all tests pass. **NEVER pass `--lib`** — it SIGTERMs in this repo. |
| Rust compile check | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0, no errors |
| Dev run (manual test) | `npm run tauri dev` (from repo root) | Vite at `127.0.0.1:5173` + a Tauri desktop window |
| Grep gate | `grep -n "<pattern>" <file>` | as stated per step |

The frontend is **plain JS (no TypeScript)** — there is no typecheck step; rely
on the dev build + the runtime observation in the test plan.

## Scope

**In scope** (the only files you may modify):
- `src-tauri/src/commands/manifest_gen.rs` — add write-coalescing at the
  `patch_manifest_doc` choke point.
- `web/src/lib/manifestReader.js` — skip re-parse + re-notify when the fetched
  text is unchanged.

**Out of scope** (do NOT touch):
- `src-tauri/src/watcher.rs` — the `("manifest", None)` emit stays as-is. Do NOT
  add a diff payload to the event in this plan (see Step 3 / Maintenance notes).
- `modules/core/graph/index.jsx`, `web/src/pages/GraphPage.jsx`,
  `buildLinkGraph`, or any of the 8 consumer modules — the win comes from fewer
  events, not from rewriting consumers.
- The Python manifest builder or the manifest **schema/shape** — the batched
  write must produce byte-equivalent output to N sequential writes.

## Git workflow

- The repo uses **Conventional Commits** (from `git log`: `fix(broadcast): …`,
  `feat(scrim): …`). Use `perf(manifest): …`.
- Branch `advisor/012-manifest-patch-coalescing` unless the operator says
  otherwise. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a pending-mutation buffer + debounced flush in `manifest_gen.rs`

Convert `patch_manifest_doc` from "run one read-modify-write now" to "enqueue this
mutation; flush the whole batch soon". The composition property proven in
"Current state" makes this a faithful, field-preserving transform.

Target shape (produce this pattern; exact names your call):

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

type Mutation = Box<dyn FnOnce(&mut Vec<serde_json::Value>) -> Option<i64> + Send>;

static PENDING: Mutex<Vec<Mutation>> = Mutex::new(Vec::new());
static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);

// How long to accumulate before one read-modify-write. A bulk import fires many
// patches back-to-back; this window collapses them into a single rewrite.
const MANIFEST_FLUSH_MS: u64 = 300;

/// Enqueue a manifest mutation; schedule a single delayed flush if none pending.
fn patch_manifest_doc(mutate: impl FnOnce(&mut Vec<serde_json::Value>) -> Option<i64> + Send + 'static) {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).push(Box::new(mutate));
    if FLUSH_SCHEDULED.swap(true, Ordering::SeqCst) {
        return; // a flush is already scheduled; it will drain what we just pushed
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(MANIFEST_FLUSH_MS)).await;
        FLUSH_SCHEDULED.store(false, Ordering::SeqCst);
        flush_manifest_patches();
    });
}

/// Drain PENDING and apply every queued mutation in ONE read-modify-write.
fn flush_manifest_patches() {
    let batch: Vec<Mutation> = std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()));
    if batch.is_empty() { return; }
    let path = content_manifest_file();
    let Ok(text) = fs::read_to_string(&path) else { return };
    let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        log::warn!("manifest patch: unparseable {}; skipping", path.display());
        return;
    };
    let Some(entries) = doc.get_mut("entries").and_then(|e| e.as_array_mut()) else { return };
    let mut total_delta: i64 = 0;
    for mutate in batch {
        if let Some(d) = mutate(entries) { total_delta += d; }
    }
    if total_delta != 0 {
        if let Some(n) = doc.get("vault_file_count").and_then(|v| v.as_i64()) {
            doc["vault_file_count"] = serde_json::Value::from((n + total_delta).max(0));
        }
    }
    match serde_json::to_string(&doc) {
        Ok(out) => {
            if let Err(e) = atomic_write(&path, out.as_bytes()) {
                log::warn!("manifest patch: write failed: {e:?}");
            }
        }
        Err(e) => log::warn!("manifest patch: serialize failed: {e}"),
    }
}
```

Notes for the executor:

- The old `patch_manifest_doc` bound `mutate: impl FnOnce(...)`. The batched
  version needs `+ Send + 'static` so the closure can be stored and run on the
  flush task. **Check every call site compiles** — the existing closures capture
  owned `String`s (e.g. `rel`, `from_prefix`), which are already `Send + 'static`;
  none capture borrows. If any closure fails to satisfy `Send + 'static`, that is
  a STOP condition (report which one).
- `tauri::async_runtime::spawn` uses the global tokio runtime and needs no
  `AppHandle`; it is callable from the sync `pub fn` patch helpers. `tokio` has
  the `time` + `macros` features enabled (`src-tauri/Cargo.toml:30`).
- **Correctness note to preserve**: the upsert closure in
  `patch_content_manifest` reads the file inside the closure
  (`manifest_gen.rs:232-237`). Under batching it runs at flush time and reads the
  file's final content — keep it inside the closure, do NOT hoist the read to
  enqueue time.
- Best-effort semantics are unchanged and already documented
  (`manifest_gen.rs:175`): if the app exits inside a flush window, pending
  patches are dropped and the next Python `manifest_rebuild.py` reconciles. Do
  **not** add an exit-flush hook in this plan.

**Verify**:
- `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0, no errors.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass (the
  existing `watcher.rs` tests still pass; there are no `manifest_gen` unit tests
  to break).

### Step 2: Skip redundant re-parse + re-notify in `manifestReader.js`

Even with fewer events, some `manifest` fires will carry **unchanged** content
(the debouncer firing on the app's own write, or a metadata-only upsert that
rewrites identical bytes). Guard against re-parsing + re-rendering all 8
consumers when the fetched text equals what the cache was built from.

Add a module-scope `let _lastText = null;` and, in `loadManifest`, short-circuit
when the fetched `text` matches `_lastText`; store it on success:

```js
let _cache = null;
let _lastText = null;   // raw JSON text the current _cache was parsed from
// ...
_loadPromise = (async () => {
  try {
    const result = await invoke('vault_read_file', { path: MANIFEST_PATH });
    const text = typeof result === 'string' ? result : result?.content;
    if (!text) throw new Error('Empty manifest response');
    if (text === _lastText && _cache) return _cache;  // unchanged → skip JSON.parse
    _cache = JSON.parse(text);
    _lastText = text;
    return _cache;
  } finally {
    _loadPromise = null;
  }
})();
```

Then in `ensureWatcher`, only notify subscribers when the parsed object actually
changed identity (so an unchanged fetch doesn't re-render the 8 consumers):

```js
subscribeEvents((name) => {
  if (name !== 'manifest') return;
  const prev = _cache;
  _cache = null;                      // force loadManifest to re-fetch
  loadManifest()
    .then((d) => { if (d !== prev) for (const fn of _subs) fn(d); })
    .catch((err) => console.error('[manifestReader] refresh failed', err));
});
```

`d !== prev` is true whenever `JSON.parse` ran (new object) and false when the
text-equality guard returned the same cached object — exactly the "content
unchanged, don't re-render" case. When content *did* change, every consumer still
gets the fresh data, so freshness is preserved.

**Verify**:
- `grep -n "_lastText" web/src/lib/manifestReader.js` → 3 matches (declare,
  compare, assign).
- Manual, in `npm run tauri dev`: open the Graph page, then in another surface
  save a note that leaves the manifest entry byte-identical (e.g. re-save with no
  change) → the graph must **not** flash a rebuild. Save a note that adds a new
  page → the graph **does** update. State the observation.

### Step 3 (optional, measure-gated): true per-entry diff-apply — DEFERRED

The finding's literal "diff-apply changed entries instead of re-parsing the whole
blob" cannot be done cleanly today because the `manifest` event carries **no
payload** (`watcher.rs:131` emits `("manifest", None)`) — the frontend does not
know *which* entries changed, so it must re-fetch and would still `JSON.parse` the
whole file to diff it. Delivering a real diff requires either (a) adding a
changed-paths payload to the event (a `watcher.rs` + emit-path change, explicitly
out of scope here), or (b) the Rust flush emitting the changed entries directly
via `AppHandle`, bypassing the file-watcher round-trip.

**Do NOT implement Step 3 in this plan.** Steps 1+2 remove the storm (fewer
events) and the redundant-parse cost (unchanged-text guard) for a few lines and
zero contract risk. Only pursue Step 3 if, after Steps 1+2, profiling shows the
remaining `JSON.parse` itself (not the re-renders) is the bottleneck on a large
vault — record that measurement first. See Maintenance notes.

## Test plan

- **No new automated tests.** The change is a faithful transform of an existing
  best-effort helper; the existing `watcher.rs` unit tests (16 of them, e.g.
  `manifest_exact_match`) still exercise the event mapping and must stay green.
  A true coalescing test would need a running app + real FS timing, which this
  repo has no harness for — state that rather than inventing one.
- **Manual coalescing observation** (the load-bearing check), in `npm run tauri
  dev`:
  1. Trigger a bulk in-app write — e.g. run a MAL XML or CSV library import that
     creates many not-downloaded cards (`library_import.rs` writes one card per
     entry), or rapidly create/rename several `.md` from the app.
  2. Watch the manifest file's mtime (`stat -c %Y
     "$CONTENT_VAULT/Infrastructure/.cache/vault_manifest.json"` on repeated
     calls, or the file's Properties) — it should tick **once per ~300 ms flush
     window**, not once per file.
  3. With the Graph page open, the graph should rebuild **once** at the end of the
     window, not N times mid-import.
  - Record the before/after (N updates → ~1 per window).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` exits 0.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0; all
      existing tests pass.
- [ ] `grep -n "MANIFEST_FLUSH_MS\|flush_manifest_patches\|PENDING" src-tauri/src/commands/manifest_gen.rs`
      shows the batching machinery is present.
- [ ] `grep -n "_lastText" web/src/lib/manifestReader.js` → 3 matches.
- [ ] Manual bulk-write test shows ~1 manifest update per flush window, not N
      (observation recorded).
- [ ] The manifest still carries the Python-owned rich fields after an in-app
      patch — verify by opening the manifest and confirming an untouched entry
      still has its `type`/`domain`/`outbound_links` (or whatever rich fields it
      had), and a patched entry kept its rich fields while `title`/`aliases`/
      `mtime` updated.
- [ ] No files outside the in-scope list modified (`git status`).

## STOP conditions

Stop and report (do not improvise) if:

- **The field-preserving contract can't hold under batching** — if applying
  batched mutations drops, reorders, or corrupts any Python-owned field on an
  existing entry, or if `vault_file_count` drifts from the true entry count.
  **Correctness of the rich fields beats the perf win** — report it and stop.
- Any existing `patch_manifest_doc` call-site closure fails `Send + 'static`
  (name the closure).
- The code at the cited lines no longer matches the "Current state" excerpts
  (drift since `57a6c80`).
- A verification fails twice after a reasonable fix attempt.
- The fix appears to require touching `watcher.rs`, `buildLinkGraph`, or a
  consumer module (that would be Step 3, which is out of scope here).

## Maintenance notes

For whoever owns this next:

- **Flush window** `MANIFEST_FLUSH_MS = 300` is a tuning knob: shorter = fresher
  UI but more rewrites; longer = fewer rewrites but staler mid-bulk. It trades
  against `watcher.rs`'s 200 ms debounce — keep the flush ≥ the debounce so the
  file settles before the event fires.
- **No exit-flush** is deliberate (ponytail: the next Python rebuild reconciles a
  dropped window, per `manifest_gen.rs:175`). If a future feature needs the
  manifest guaranteed-current at app close, add a flush on the Tauri exit hook —
  don't retrofit it speculatively.
- **Step 3 (real diff-apply)** is the deferred follow-up. Its prerequisite is a
  changed-paths payload on the `manifest` event (or a direct `AppHandle` emit from
  the flush). Do it only if profiling proves the whole-file `JSON.parse` — not the
  8 re-renders — is the remaining bottleneck.
- A reviewer should scrutinize: closure composition order under batch (rename =
  remove-then-add must stay ordered), the `Send + 'static` bound change, and that
  the unchanged-text guard never wedges the cache stale (it only short-circuits
  when `text === _lastText`, which by definition means no change).
