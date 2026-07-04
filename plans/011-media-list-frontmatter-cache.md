# Plan 011: Route album/series list scans through the existing mtime frontmatter cache

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/parsers/albums.rs src-tauri/src/parsers/series.rs src-tauri/src/parsers/frontmatter_cache.rs`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Every Music-library and Video-library navigation re-scans the whole library
from disk: `list_albums` and `list_series` loop over every `*.md` card and
`fs::read_to_string` the **entire file** — including the body track/season
tables — then `parse_frontmatter`, with no caching. Meanwhile the repo already
has a ready, mtime-keyed, LRU-bounded frontmatter cache
(`parsers/frontmatter_cache.rs`) that reads only the first 8 KB (the
frontmatter) per file and serves a cached parse when the file's mtime is
unchanged — but these two list paths don't use it.

Routing the frontmatter reads through that cache means a repeat library scan
does zero body reads (cache hits by mtime), cutting the per-nav cost to a
metadata stat + cached-map clone per card. Albums fit the cache perfectly (the
summary never uses the body). Series fit it for the common non-franchise case;
franchise entries still need a full read (see the constraint below).

## Current state

### `parsers/albums.rs::list_albums` (lines 373–411, verbatim)

```rust
pub fn list_albums() -> Result<Vec<AlbumSummary>, VaultError> {
    let dir = albums_dir();
    let mut entries = safe_read_dir(&dir);
    entries.sort();
    let mut out = Vec::new();
    for entry in entries {
        if !entry.ends_with(".md") {
            continue;
        }
        let abs = dir.join(&entry);
        let Ok(text) = fs::read_to_string(&abs) else {
            continue;
        };
        let (meta, _body) = parse_frontmatter(&text);
        let stat = fs::metadata(&abs)?;
        let name = entry.trim_end_matches(".md").to_string();
        let tracks_present = count_present_tracks(&meta);
        out.push(AlbumSummary {
            path: format!("{ALBUMS_DIR}/{entry}"),
            name: name.clone(),
            title: meta_str(&meta, "Title").unwrap_or(name),
            artist: first_artist(&meta),
            year: meta_clone(&meta, "Year"),
            image: meta_str(&meta, "Image"),
            status: meta_str(&meta, "Status"),
            personal_rating: meta_f64(&meta, "Personal Rating"),
            genres: as_strings(meta.get("Genres")),
            release_type: meta_str(&meta, "Release Type"),
            track_count: meta_clone(&meta, "Track Count"),
            length: meta_str(&meta, "Length"),
            mtime: mtime_ms(&stat),
            release_id: meta_str(&meta, "Release ID"),
            provider_id: meta_str(&meta, "Provider ID"),
            tracks_present,
            tracks_total: meta_i64(&meta, "Track Count").unwrap_or(tracks_present),
        });
    }
    Ok(out)
}
```

The body is discarded (`let (meta, _body) = …`). Every field is derived from
`meta`. `count_present_tracks(&meta)` (albums.rs:303–319) reads the track-audio
folder from **disk** each call (via `safe_read_dir`) — it is NOT
frontmatter-only, so it must keep running fresh every call (see constraint 2).

### `parsers/series.rs::list_series` (lines 648–719, verbatim excerpt of the read)

```rust
pub fn list_series() -> Result<Vec<SeriesSummary>, VaultError> {
    let dir = anime_dir();
    let mut entries = safe_read_dir(&dir);
    entries.sort();
    let mut out = Vec::new();
    for entry in entries {
        if !entry.ends_with(".md") {
            continue;
        }
        let abs = dir.join(&entry);
        let Ok(text) = fs::read_to_string(&abs) else {
            continue;
        };
        let (meta, body) = parse_frontmatter(&text);
        let stat = match fs::metadata(&abs) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let franchise = is_franchise(&meta);
        let (status, watched_value, episodes_total, season_names, related_ids, re_watches);
        if franchise {
            let sections = parse_franchise_sections(&body);
            // ... uses `sections` (from body) ...
        } else {
            // ... all fields from `meta`; body unused ...
        }
        // ... push SeriesSummary { ... } ...
    }
    Ok(out)
}
```

`is_franchise(&meta)` (frontmatter-only) decides the branch. The **franchise**
branch calls `parse_franchise_sections(&body)` — it needs the file **body**.
The non-franchise branch derives everything from `meta` (body unused).

### The cache to use — `parsers/frontmatter_cache.rs` (lines 61–83, verbatim)

```rust
/// Get the frontmatter map for `abs_path`. Empty map on missing/unreadable file
/// (mirrors Node's `getFrontmatter`).
pub fn get_frontmatter(abs_path: &Path) -> Map<String, Value> {
    let mtime = match mtime_ms_of(abs_path) {
        Some(v) => v,
        None => return Map::new(),
    };
    let key = abs_path.to_string_lossy().into_owned();

    {
        let s = state().lock().unwrap();
        if let Some(e) = s.entries.get(&key) {
            if (e.mtime_ms - mtime).abs() < 0.5 {
                return e.meta.clone();
            }
        }
    }

    let head = match read_head(abs_path) {
        Ok(s) => s,
        Err(_) => return Map::new(),
    };
    let (meta, _body) = parse_frontmatter(&head);
    // ... LRU insert (cap 4096) ...
```

Signature: `pub fn get_frontmatter(abs_path: &Path) -> Map<String, Value>` —
returns the **same `Map<String, Value>`** type that `parse_frontmatter(text).0`
returns (`parse_frontmatter` is `fn(&str) -> (Map<String, Value>, String)`,
frontmatter.rs:77). It reads only `HEAD_BYTES = 8192` and caches by mtime. It is
reachable from the parsers as `crate::parsers::frontmatter_cache::get_frontmatter`
(`parsers/mod.rs:8` declares `pub mod frontmatter_cache;`; `pub mod albums;` at
:4, `pub mod series;` at :16).

## Constraints (from reading the code — honor these)

1. **8 KB head window.** `get_frontmatter` only parses the first 8 KB. An
   album's frontmatter (title/artist/year/rating/etc.) is far under that, so
   albums are safe. A many-season franchise anime's frontmatter (many suffixed
   `Status <s>` / `Watched Episodes <s>` / `Re Watches <s>` keys) could
   approach or exceed 8 KB — so the **franchise path re-reads the file in full**
   and does not rely on the cached (possibly truncated) meta.
2. **`count_present_tracks` must stay disk-fresh.** It reads the track-audio
   folder on every call; keep it computed from the (cached) `meta` each call —
   do NOT memoize the whole summary Vec, or a completed download would show a
   stale "tracks present" count. This is why the fix uses the per-file
   frontmatter cache, not a whole-list memo.

## Commands you will need

| Purpose      | Command                                                    | Expected on success |
|--------------|-----------------------------------------------------------|---------------------|
| Rust tests   | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | all pass, exit 0    |
| Rust compile | `cargo build --manifest-path src-tauri/Cargo.toml`        | exit 0              |

DO NOT run `cargo test --lib` (SIGTERMs). `--tests` only. Rust edits need a
`npm run tauri dev` restart to see them live (no Rust HMR).

## Scope

**In scope** (the only files you should modify):
- `src-tauri/src/parsers/albums.rs` — `list_albums` reads via the cache.
- `src-tauri/src/parsers/series.rs` — `list_series` reads via the cache for
  non-franchise; full read for franchise.

**Out of scope** (do NOT touch):
- The returned data shapes `AlbumSummary` / `SeriesSummary` — no field added,
  removed, or retyped; the frontend depends on them.
- `count_present_tracks`, `first_artist`, `is_franchise`,
  `parse_franchise_sections`, the `meta_*` helpers — unchanged.
- `read_album` / `read_series` (the single-item readers) — this plan is the
  **list** scans only.
- `frontmatter_cache.rs` — use it as-is; no changes needed (`get_frontmatter`
  is already `pub`).

## Git workflow

- Branch: `advisor/011-media-list-frontmatter-cache`.
- Conventional Commits (from `git log`). Use
  `perf(media): cache frontmatter reads in album/series list scans`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Route `list_albums` through the frontmatter cache

In `albums.rs::list_albums`, replace the full read + parse with a cache lookup.
Keep `fs::metadata` as the existence guard (so a missing file still errors as
before). Replace these lines:

```rust
        let abs = dir.join(&entry);
        let Ok(text) = fs::read_to_string(&abs) else {
            continue;
        };
        let (meta, _body) = parse_frontmatter(&text);
        let stat = fs::metadata(&abs)?;
```

with:

```rust
        let abs = dir.join(&entry);
        // mtime-keyed cache: reads only the frontmatter head (8KB) and serves a
        // cached parse when the card's mtime is unchanged — no body read. The
        // album summary never uses the body, so this is a full win.
        let stat = fs::metadata(&abs)?;
        let meta = crate::parsers::frontmatter_cache::get_frontmatter(&abs);
```

Everything after (`let name = …`, `count_present_tracks(&meta)`, the
`AlbumSummary { … }` push) is unchanged — `meta` is the same `Map<String,
Value>` type. `count_present_tracks(&meta)` still runs each call (disk-fresh).

If the `parse_frontmatter` import (albums.rs:24
`use crate::parsers::frontmatter::{parse_frontmatter, set_frontmatter_field};`)
becomes unused after this change, the compiler will warn — check whether
`read_album` (which also calls `parse_frontmatter`, albums.rs:419) still uses
it. It does, so leave the import as is.

**Verify**: `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0, no
`unused import` warning for `parse_frontmatter`.

### Step 2: Route `list_series` through the cache, full-read only for franchise

In `series.rs::list_series`, replace the read + metadata block. Replace these
lines:

```rust
        let abs = dir.join(&entry);
        let Ok(text) = fs::read_to_string(&abs) else {
            continue;
        };
        let (meta, body) = parse_frontmatter(&text);
        let stat = match fs::metadata(&abs) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let franchise = is_franchise(&meta);
```

with:

```rust
        let abs = dir.join(&entry);
        let stat = match fs::metadata(&abs) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Cheap cached frontmatter (8KB head) decides the branch.
        let cached = crate::parsers::frontmatter_cache::get_frontmatter(&abs);
        let franchise = is_franchise(&cached);
        // Franchise rollup needs the body's season sections, and a many-season
        // franchise's frontmatter can exceed the cache's 8KB head window — so
        // re-read it in full. Non-franchise entries never touch the body, so the
        // cache hit means zero body reads.
        let (meta, body) = if franchise {
            let text = match fs::read_to_string(&abs) {
                Ok(t) => t,
                Err(_) => continue,
            };
            parse_frontmatter(&text)
        } else {
            (cached, String::new())
        };
```

The rest of the loop (`let (status, watched_value, …);`, the
`if franchise { parse_franchise_sections(&body) … } else { … }` branch, the
`SeriesSummary { … }` push) is unchanged — `meta` and `body` have the same types
and, for franchise, the same full-read values as before. `is_franchise` reads a
top-of-frontmatter flag, well within 8 KB, so the branch decision from `cached`
is reliable.

`parse_frontmatter` stays imported (used in the franchise branch + by
`read_series`).

**Verify**: `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0.

## Test plan

Both files already have `#[cfg(test)] mod tests` (albums.rs:668; series.rs has
its own `cfg(test)` module per the audit). The change must not alter their
output — run them first:

- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all existing
  album/series tests pass unchanged (the summaries are byte-identical; only the
  read path changed).

Add one cache-correctness test per file, modeled on the existing test module's
temp-library setup (they set the library root — reuse whatever env var /
fixture the existing tests use, e.g. `AGENTIC_LIBRARY_VAULT_ROOT`, seen in
`commands/vaults.rs:423`):

1. `albums.rs` — `list_albums_stable_across_calls`: seed a temp library with 2
   album cards, call `list_albums()` twice, assert the two `Vec<AlbumSummary>`
   are equal (exercises the cache-hit path on the 2nd call).
2. `series.rs` — `list_series_stable_across_calls`: seed 1 non-franchise + 1
   franchise series card, call `list_series()` twice, assert equal (covers both
   the cached non-franchise path and the full-read franchise path).

If the existing test harness makes seeding a fresh library awkward, keep just
the "existing tests pass" gate and note it — do not invent a new fixture
framework.

**Verification**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` →
all pass, including any new tests.

## Done criteria

ALL must hold:

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` exits 0, no new unused
      warnings.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0;
      existing album/series tests pass unchanged.
- [ ] `list_albums` derives `meta` from
      `frontmatter_cache::get_frontmatter`; no `fs::read_to_string` remains in
      `list_albums`.
- [ ] `list_series` derives `meta` from the cache for non-franchise and
      full-reads only when `is_franchise` is true.
- [ ] `AlbumSummary` / `SeriesSummary` field sets are unchanged (`git diff`
      shows no struct edits).
- [ ] `git status` shows only `albums.rs` and `series.rs` (+ optional tests)
      modified.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The code at the cited locations doesn't match the "Current state" excerpts
  (drift since 57a6c80).
- `get_frontmatter`'s signature is no longer
  `pub fn get_frontmatter(&Path) -> Map<String, Value>` (a type mismatch with
  `parse_frontmatter().0`) — report; do not force a conversion.
- `list_albums` turns out to read a **body** field after all (it does not
  today — the body is discarded) — if a summary field now needs the body, that
  album can't use the head-only cache; report the field.
- The existing album/series tests **fail** after the change (a behavior
  difference, e.g. an album whose frontmatter exceeds 8 KB losing a field) —
  report which field/file; do not paper over it.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Documented constraint (report this at handoff):** the series cache win is
  **non-franchise only**. Franchise entries need the body
  (`parse_franchise_sections`) and may have >8 KB frontmatter, so they still do
  a full read. If franchise entries dominate a user's library, the series win is
  small — acceptable, and albums are unaffected.
- The cache is invalidated by mtime automatically; an in-app card edit bumps the
  mtime → the next scan re-reads that one card. `frontmatter_cache::invalidate_all`
  (bulk drop) is wired to the manifest-reload bus, so a manifest reload also
  clears it.
- Reviewer scrutiny: confirm `count_present_tracks` still runs on every
  `list_albums` call (disk-fresh track counts) and that no whole-Vec memo was
  introduced; confirm the franchise branch still full-reads (no 8 KB truncation
  of franchise frontmatter).
- Deferred: `read_album`/`read_series` (single-item readers) are not cached
  here — they read the body intentionally (track table / episode list) and are
  one-off per open, not per-nav scans, so the cache would not help them.
