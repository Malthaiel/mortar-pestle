# Plan 009: Skip full-vault manifest regeneration on boot when the on-disk manifest is already fresh

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/vaults.rs src-tauri/src/commands/manifest_gen.rs src-tauri/src/render/manifest.rs src-tauri/src/lib.rs`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The app blocks its own first paint on a full recursive read of every markdown
file in the active content vault **and** the GameWiki vault (~660 pages) on
**every** boot. `commands::vaults::init_active_vault` runs synchronously inside
Tauri's `.setup()` closure, before `window.show()` — so this I/O sits directly
on the cold-start critical path (documented budget: launch → first paint
< 1.5s). The regenerator (`manifest_gen::generate_for`) `fs::read_to_string`s
the **entire body** of every file just to pull `title`/`aliases` out of the
frontmatter, with no freshness check: nothing changed since last boot, yet the
whole vault is re-walked and re-read.

This plan makes the common case (nothing changed since last boot) a cheap
metadata-only walk that **skips** regeneration entirely, and makes the
unavoidable cold regen cheaper by reading only each file's head bytes (the
frontmatter) instead of the full body. The freshness gate lives in the single
shared `regen_manifest` function, so it covers the content vault, the
every-boot GameWiki re-index, the role vaults, and vault switches in one place.

## Current state

Files and their roles:

- `src-tauri/src/lib.rs` — Tauri setup. Line 210 calls
  `commands::vaults::init_active_vault(app.handle());` **synchronously**;
  `window.show()` is at the end of setup (lines 594–605). So init runs on the
  main thread before the window is shown.
- `src-tauri/src/commands/vaults.rs` — vault registry + boot wiring. Contains
  the shared `regen_manifest` gate point and all its boot callers.
- `src-tauri/src/commands/manifest_gen.rs` — `generate_for`, the full-vault
  walker/reader. This is where the freshness helper + the schema field go.
- `src-tauri/src/render/manifest.rs` — the manifest **reader** (proves adding a
  top-level field is safe).

### `lib.rs` — the synchronous boot call (lines 206–218, verbatim)

```rust
            // Multi-Vault — load the vault registry (seed Citadel on first
            // run), set the active vault + its app-data manifest path, and
            // build that manifest. MUST precede watcher::spawn so the watcher
            // attaches to the correct root.
            commands::vaults::init_active_vault(app.handle());
```

### `vaults.rs` — the shared gate (lines 176–191, verbatim)

```rust
/// Build (or rebuild) `entry`'s manifest if the vault has manifests enabled.
/// Best-effort: logs and continues on failure (wikilinks just render
/// unresolved). No-op when manifests are disabled for the vault.
fn regen_manifest(entry: &VaultEntry) {
    if !entry.manifest_enabled {
        return;
    }
    if let Some(dir) = manifest_dir() {
        let _ = fs::create_dir_all(&dir);
    }
    if let Some(out) = manifest_path_for(&entry.id) {
        if let Err(e) = crate::commands::manifest_gen::generate_for(&entry.path, Path::new(&out)) {
            log::warn!("manifest generation failed for vault '{}': {e:?}", entry.name);
        }
    }
}
```

`regen_manifest` is the single chokepoint. Its boot-path callers:

- `vaults.rs:363` — active content vault, in `resolve_active` match arm inside
  `init_active_vault`.
- `vaults.rs:396` — role vaults (App/Pulse) on first detection.
- `vaults.rs:487` — GameWiki **already-registered** path (the comment at
  vaults.rs:479–482 states it "is regenerated on EVERY boot").
- `vaults.rs:537` — GameWiki first-boot create.

Non-boot callers (unaffected by this change, but they route through the same
gate so they get the freshness skip too — which is correct): `vaults_add`
(:617), `set_active_vault` (:659), `scaffold_vault` (:755). The manual
`generate_manifest` command (:683) calls `generate_for` **directly**, not
through `regen_manifest`, so it always rebuilds — leave it that way.

### `manifest_gen.rs` — the generator (lines 22–90, verbatim)

```rust
#[derive(Serialize)]
struct GenEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime: Option<String>,
}

#[derive(Serialize)]
struct ManifestOut {
    schema_version: u32,
    vault_file_count: usize,
    entries: Vec<GenEntry>,
}

/// Walk `vault_path`, build the manifest, write it atomically to `out_path`.
/// Returns the number of indexed entries.
pub fn generate_for(vault_path: &str, out_path: &Path) -> Result<usize, VaultError> {
    let root = fs::canonicalize(vault_path)
        .map_err(|e| VaultError::Io(format!("canonicalize {vault_path}: {e}")))?;

    let mut entries: Vec<GenEntry> = Vec::new();
    // Prune traversal into hidden dirs (.obsidian/.git/.trash) and Raw/ for
    // speed; the per-file `is_excluded` still guards hidden files + OCR sidecars.
    let walker = WalkDir::new(&root).into_iter().filter_entry(|e| {
        if e.depth() > 0 && e.file_type().is_dir() {
            let n = e.file_name().to_str().unwrap_or("");
            if n.starts_with('.') || n == "Raw" {
                return false;
            }
        }
        true
    });

    for dirent in walker.filter_map(|e| e.ok()) {
        if !dirent.file_type().is_file() {
            continue;
        }
        let name = match dirent.file_name().to_str() {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".md") {
            continue;
        }
        let rel = match dirent.path().strip_prefix(&root).ok().and_then(|r| r.to_str()) {
            Some(r) => r.replace('\\', "/"),
            None => continue,
        };
        if is_excluded(&rel, name) {
            continue;
        }
        let content = fs::read_to_string(dirent.path()).unwrap_or_default();
        let stem = name.strip_suffix(".md").unwrap_or(name);
        let (title, aliases) = parse_title_aliases(&content, stem);
        let mtime = dirent.metadata().ok().as_ref().and_then(mtime_iso);
        entries.push(GenEntry { path: rel, title, aliases, mtime });
    }

    let count = entries.len();
    let out = ManifestOut { schema_version: 2, vault_file_count: count, entries };
    let text = serde_json::to_string(&out)
        .map_err(|e| VaultError::Io(format!("serialize manifest: {e}")))?;
    atomic_write(out_path, text.as_bytes())?;
    Ok(count)
}
```

`mtime_iso` (lines 105–111) and `parse_title_aliases` (lines 115–141) already
exist. `parse_title_aliases` only needs the **frontmatter** (it calls
`extract_frontmatter`, which requires a leading `---` … `\n---` block) — the
body is never used, so a head-bytes read is sufficient.

### `render/manifest.rs` — the reader (lines 31–34, verbatim) — proves adding a field is safe

```rust
#[derive(Deserialize)]
struct ManifestFile {
    entries: Vec<Entry>,
}
```

No `#[serde(deny_unknown_fields)]` — an extra top-level `max_mtime_ms` key is
silently ignored by the reader. `vault_list_top_folders` (vaults.rs:839–843)
reads `vault_file_count` via dynamic `serde_json::Value`, also unaffected.

### The in-repo freshness template to mirror — `commands/knowledge.rs:235–264`

```rust
    let mut files: Vec<(String, String, f64)> = Vec::new();
    let mut max_mtime = 0.0_f64;
    for ent in read.flatten() {
        // ... stat each file ...
        let mt = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        if mt > max_mtime {
            max_mtime = mt;
        }
        files.push((name, full.to_string_lossy().into_owned(), mt));
    }

    {
        let s = index_state().read().unwrap();
        if (s.loaded_max_mtime_ms - max_mtime).abs() < 0.5 && max_mtime > 0.0 {
            return;
        }
    }
```

This is the exact pattern (walk metadata → track max mtime → compare with a
`< 0.5` ms tolerance → early-return if unchanged) to reuse. The difference: the
stored value lives **on disk** in the manifest (not in memory), because the
skip must work on the very first boot of a session.

### The head-bytes reader to reuse — `parsers/frontmatter_cache.rs:45–52`

```rust
fn read_head(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let _ = f.seek(SeekFrom::Start(0));
    let mut buf = vec![0u8; HEAD_BYTES];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
```

`HEAD_BYTES = 8192` (frontmatter_cache.rs:20). This function is currently
private.

## Commands you will need

| Purpose          | Command                                                              | Expected on success        |
|------------------|---------------------------------------------------------------------|----------------------------|
| Rust tests       | `cargo test --manifest-path src-tauri/Cargo.toml --tests`           | all pass, exit 0           |
| Rust compile     | `cargo build --manifest-path src-tauri/Cargo.toml`                  | exit 0, no errors          |
| Dev run (manual) | `npm run tauri dev` (from repo root)                                 | window opens; watch stderr |

DO NOT run `cargo test --lib` — it SIGTERMs in this repo. Use `--tests` only.
Rust edits require restarting `npm run tauri dev` (no HMR for Rust).

## Scope

**In scope** (the only files you should modify):
- `src-tauri/src/commands/manifest_gen.rs` — add `max_mtime_ms` field, the
  `manifest_is_fresh` helper, the shared md-walk helper, and (Step 4) the
  head-bytes read.
- `src-tauri/src/commands/vaults.rs` — gate `regen_manifest`'s body on the
  freshness check.
- `src-tauri/src/parsers/frontmatter_cache.rs` — make `read_head` reusable
  (Step 4 only; one-word visibility change).

**Out of scope** (do NOT touch):
- `src-tauri/src/lib.rs` — do **not** move `init_active_vault` off the boot
  thread or into `async_runtime::spawn`. The freshness skip makes the sync call
  cheap; the async approach adds "manifest not yet loaded" race surface in every
  downstream reader and is explicitly the fallback, not this plan.
- `render/manifest.rs` — the reader tolerates the new field with no change.
- `manifest_gen.rs::generate_manifest` behavior (the manual on-demand command,
  vaults.rs:671–688) — it must always rebuild.
- The content vault's Python-built `Infrastructure/.cache/vault_manifest.json`
  and the `patch_content_manifest*` helpers (manifest_gen.rs:164–298) — a
  different manifest; never touched here.

## Git workflow

- Branch: `advisor/009-manifest-regen-off-boot`.
- Commit style is Conventional Commits (from `git log`: `fix(broadcast): …`,
  `feat(overlay): …`). Use `perf(vault): skip manifest regen when fresh`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a `max_mtime_ms` freshness key to the generated manifest

In `manifest_gen.rs`, add a field to `ManifestOut` and compute it while walking.
`generate_for` already stats each file for its per-entry `mtime`; reuse that one
`metadata()` call to also track the max.

1. Add to `ManifestOut`:
   ```rust
   #[derive(Serialize)]
   struct ManifestOut {
       schema_version: u32,
       vault_file_count: usize,
       /// Max file mtime (ms since epoch) across all indexed entries — the
       /// on-disk freshness key. `manifest_is_fresh` compares this + the count
       /// against a metadata-only re-walk to skip a no-op regen on boot.
       max_mtime_ms: f64,
       entries: Vec<GenEntry>,
   }
   ```
2. Add a numeric mtime helper next to `mtime_iso`:
   ```rust
   fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
       let dur = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
       Some(dur.as_secs_f64() * 1000.0)
   }
   ```
3. In the walk loop, take `metadata()` **once** and derive both the ISO string
   and the numeric max. Replace the two lines
   `let mtime = dirent.metadata().ok().as_ref().and_then(mtime_iso);` with:
   ```rust
   let meta = dirent.metadata().ok();
   let mtime = meta.as_ref().and_then(mtime_iso);
   if let Some(mm) = meta.as_ref().and_then(mtime_ms) {
       if mm > max_mtime { max_mtime = mm; }
   }
   ```
   Declare `let mut max_mtime = 0.0_f64;` next to `let mut entries` before the
   loop. Then build `ManifestOut { schema_version: 2, vault_file_count: count,
   max_mtime_ms: max_mtime, entries }`.

**Verify**: `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0.

### Step 2: Add a shared md-walk helper + `manifest_is_fresh`

Still in `manifest_gen.rs`. Extract the walk-and-filter logic (currently inline
in `generate_for`) into a helper both `generate_for` and the freshness check
use, so their exclusion rules cannot drift apart (a drift would only ever cause
an over-conservative regen, never a stale manifest, but keep them identical):

```rust
/// Iterator over a vault's indexable `*.md` files (post-exclusion), yielding
/// `(relative_path, DirEntry)`. Shared by `generate_for` and `manifest_is_fresh`
/// so both apply identical exclusion rules.
fn md_files(root: &Path) -> impl Iterator<Item = (String, walkdir::DirEntry)> + '_ {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() > 0 && e.file_type().is_dir() {
                let n = e.file_name().to_str().unwrap_or("");
                if n.starts_with('.') || n == "Raw" {
                    return false;
                }
            }
            true
        })
        .filter_map(|e| e.ok())
        .filter_map(move |dirent| {
            if !dirent.file_type().is_file() {
                return None;
            }
            let name = dirent.file_name().to_str()?;
            if !name.ends_with(".md") {
                return None;
            }
            let rel = dirent
                .path()
                .strip_prefix(root)
                .ok()
                .and_then(|r| r.to_str())?
                .replace('\\', "/");
            if is_excluded(&rel, name) {
                return None;
            }
            Some((rel, dirent))
        })
}
```

Refactor `generate_for`'s loop to consume `md_files(&root)` (it already has
`root` from `fs::canonicalize`). Then add:

```rust
/// True iff the manifest at `out_path` already reflects the current vault
/// contents — a metadata-only walk (no file bodies read) whose (count, max
/// mtime) matches the manifest's stored `vault_file_count` + `max_mtime_ms`.
/// Any structural change (add/delete → count) or edit (→ max mtime) misses.
/// False when the manifest is absent or written by a pre-`max_mtime_ms` build.
pub fn manifest_is_fresh(vault_path: &str, out_path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(out_path) else { return false; };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else { return false; };
    let (Some(stored_count), Some(stored_max)) = (
        doc.get("vault_file_count").and_then(|v| v.as_u64()),
        doc.get("max_mtime_ms").and_then(|v| v.as_f64()),
    ) else { return false; };

    let Ok(root) = fs::canonicalize(vault_path) else { return false; };
    let mut count: u64 = 0;
    let mut max_mtime = 0.0_f64;
    for (_rel, dirent) in md_files(&root) {
        count += 1;
        if let Some(mm) = dirent.metadata().ok().as_ref().and_then(mtime_ms) {
            if mm > max_mtime { max_mtime = mm; }
        }
    }
    count == stored_count && (max_mtime - stored_max).abs() < 0.5
}
```

**Verify**: `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0.

### Step 3: Gate `regen_manifest` on the freshness check

In `vaults.rs`, wrap the `generate_for` call in `regen_manifest` (lines
179–191) so it is skipped when the manifest is already fresh. This one guard
covers every boot caller (content vault, GameWiki every-boot, role vaults) and
vault switches:

```rust
fn regen_manifest(entry: &VaultEntry) {
    if !entry.manifest_enabled {
        return;
    }
    if let Some(dir) = manifest_dir() {
        let _ = fs::create_dir_all(&dir);
    }
    if let Some(out) = manifest_path_for(&entry.id) {
        // Skip the full-vault re-read when nothing changed since last boot —
        // the freshness key (count + max mtime) is a cheap metadata-only walk.
        if crate::commands::manifest_gen::manifest_is_fresh(&entry.path, Path::new(&out)) {
            return;
        }
        if let Err(e) = crate::commands::manifest_gen::generate_for(&entry.path, Path::new(&out)) {
            log::warn!("manifest generation failed for vault '{}': {e:?}", entry.name);
        }
    }
}
```

**Verify**:
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass.
- Manual perf proof (Rust has no HMR — restart the dev app):
  1. Temporarily wrap the boot call in `lib.rs:210` with timing:
     ```rust
     let _t = std::time::Instant::now();
     commands::vaults::init_active_vault(app.handle());
     eprintln!("[perf] init_active_vault took {:?}", _t.elapsed());
     ```
  2. `npm run tauri dev`, note the printed duration, close, run again.
  3. **Expected**: first run (cold, or after any vault edit) does the full
     regen; the **second** run prints a markedly smaller duration (the regen is
     skipped — only metadata walks run). On a large vault the drop is from
     tens/hundreds of ms to single-digit ms.
  4. Confirm the skip is not permanent: `touch` any `.md` in the active vault,
     restart — the duration rises again (regen ran), proving edits still
     re-index.
  5. **Remove the temporary timing lines** before finishing (lib.rs is
     out-of-scope for permanent changes).

### Step 4 (independent — land even if Step 3 is enough): head-bytes read in `generate_for`

Make the cold regen itself cheaper by reading only each file's head bytes (the
frontmatter) instead of the whole body.

1. In `frontmatter_cache.rs`, change `fn read_head` (line 45) to
   `pub(crate) fn read_head` so `manifest_gen` can reuse it. (Reuse rung: this
   is the existing head-reader; do not write a second one.)
2. In `generate_for`, replace
   `let content = fs::read_to_string(dirent.path()).unwrap_or_default();`
   with
   `let content = crate::parsers::frontmatter_cache::read_head(dirent.path()).unwrap_or_default();`

`parse_title_aliases` only reads the leading frontmatter block, which fits in
8 KB for normal vault pages — so `title`/`aliases` are unchanged. A page whose
frontmatter exceeds 8 KB would lose its aliases; this is the same 8 KB bet the
frontmatter cache already makes vault-wide.

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all
pass (existing manifest_gen behavior — title/alias extraction — is covered by
the tests you add in the Test plan; confirm they still pass with the head read).

## Test plan

Add a `#[cfg(test)] mod tests` to `manifest_gen.rs` (there is none today). Model
the temp-vault setup on the parser tests at `parsers/albums.rs:668` (`mod
tests`). Use `std::env::temp_dir()` + a unique subdir (no extra dev-dep needed)
and remove it at the end. Cover:

1. `fresh_after_generate` — create a temp dir with 2 `.md` files (with
   frontmatter), call `generate_for`, then assert
   `manifest_is_fresh(dir, out) == true`.
2. `stale_on_new_file` — after (1), write a 3rd `.md` file, assert
   `manifest_is_fresh(dir, out) == false`.
3. `stale_on_edit` — after (1), rewrite one file (advancing its mtime; if the
   filesystem's mtime resolution makes this flaky, `sleep(Duration::from_millis(
   1100))` before the rewrite), assert `manifest_is_fresh == false`.
4. `stale_when_missing` — `manifest_is_fresh(dir, nonexistent_out) == false`.
5. `head_read_extracts_title_aliases` (guards Step 4) — a file with `Title:` +
   `Aliases:` frontmatter under 8 KB round-trips its title/aliases into the
   manifest JSON.

**Verification**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` →
all pass, including the 5 new tests.

## Done criteria

ALL must hold:

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` exits 0.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0; the 5
      new `manifest_gen` tests exist and pass.
- [ ] `regen_manifest` (vaults.rs) early-returns via `manifest_is_fresh` before
      calling `generate_for`.
- [ ] `ManifestOut` serializes a top-level `max_mtime_ms`.
- [ ] Manual: a second consecutive `npm run tauri dev` boot skips regen (timing
      proof from Step 3), and touching a `.md` re-triggers it.
- [ ] No temporary timing lines left in `lib.rs`; `git status` shows only the
      three in-scope files modified.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The code at the cited locations doesn't match the "Current state" excerpts
  (drift since 57a6c80).
- `init_active_vault` (vaults.rs ~316) or `regen_manifest` (vaults.rs ~179) no
  longer calls the manifest generator on the boot path — someone already moved
  regeneration off boot; reconcile before proceeding.
- `ManifestOut` in manifest_gen.rs **already** has a `max_mtime_ms` (or
  equivalent freshness) field — Step 1 was already done; verify the rest and
  report.
- A verification fails twice after a reasonable fix attempt.
- You find `render/manifest.rs`'s `ManifestFile` (or another reader) has gained
  `#[serde(deny_unknown_fields)]` — the new top-level field would break parsing;
  report before continuing.

## Maintenance notes

- The freshness key is `(vault_file_count, max_mtime_ms)`. It misses only two
  exotic cases, both harmless-or-rare: a delete+add that keeps count identical
  **and** leaves the max mtime unchanged; or a file whose mtime moves backward
  (clock skew). Either yields a wrongly-"fresh" verdict until the next real
  change; a manual `generate_manifest` (the on-demand command) always forces a
  rebuild if a user needs it.
- If a future change adds fields the manifest reader **requires** to be present
  on every entry, a metadata-only freshness skip would serve an out-of-date
  schema — bump `schema_version` and make `manifest_is_fresh` also compare it.
- Reviewer scrutiny: confirm `md_files` and `generate_for` share exactly one
  exclusion path (Step 2), and that the Step 4 head read didn't regress
  title/alias extraction (Test 5).
- Deferred: moving `init_active_vault` fully async (the advisor's fallback
  option b) is intentionally NOT done — revisit only if profiling shows the
  metadata-only walk itself (thousands of `stat`s) is still over budget on the
  largest vaults.
