# Plan 002: Establish a one-command verification baseline and wire it into CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index. (As of this writing there is no
> `plans/` index yet; do NOT create one — the advisor owns it.)
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- package.json .github/workflows/release.yml src-tauri/tests/vault_io_sanity.rs`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (`scripts/verify.mjs` and
> `.github/workflows/verify.yml` are new files — they will not exist at 57a6c80.)

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (this UNBLOCKS other plans — it is the drift-gate they reference)
- **Category**: tests / dx
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

There is currently **no one-command way to prove the repo works**. The Rust
half has real tests (integration tests in `src-tauri/tests/*.rs` plus ~36
`#[cfg(test)]` unit mods) but no runnable aggregate, and a naive
`cargo test --lib` **SIGTERMs the dev sandbox**. The JS half has only two
bespoke pure-math node checks (`check-themes`, `check-drag`) that nothing runs
automatically. CI consists of a **single** workflow (`release.yml`) that fires
only on `v*` tags, runs **zero** tests/lint/checks, and publishes a **signed**
NSIS installer — so nothing is verified before a public, auto-updating release
ships. On top of that, `release.yml` holds the updater signing key while using
**mutable** action refs (`@v4`, `@stable`, `@v0`): a compromised action could
exfiltrate the key and push malicious signed updates to every user.

After this plan: `node scripts/verify.mjs` runs the whole gate in one command;
a non-tag `verify.yml` runs it on every push and PR; `release.yml` blocks a
signed release on the WCAG-AA contrast gate; and every CI action is pinned to a
commit SHA. Every future test surface joins `verify.mjs`, so this baseline
becomes the prerequisite drift-gate the other plans build on.

## Current state

Facts inlined — the executor has not seen this repo.

### Repo shape

- Windows 11 primary dev host (PowerShell + Git-Bash both available). CI target
  is `windows-latest`.
- Tauri 2 Rust backend in `src-tauri/` (crate `package.name = "mortar-pestle"`,
  `[lib] name = "app_lib"`) **plus 3 independent sidecar crates**
  `mortar-pestle-{capture,stt,broadcast}`. **There is NO Cargo workspace** — the
  sidecars are separate crates, so a single `cargo test` on `src-tauri` never
  reaches them (out of scope here).
- React 18 + Vite 6 **plain-JS** frontend in `web/` + `modules/`.
- Root `package.json` scripts: `dev`, `build`, `tauri`, `sync-versions`
  (no test/lint/verify script exists yet).
- `web/package.json` scripts include `check-themes`
  (`node scripts/check-theme-contrast.mjs`) and `check-drag`
  (`node scripts/check-drag-math.mjs`).

### The Rust test surface and the SIGTERM hazard

`src-tauri/tests/` contains these integration test targets (each is its own
compiled test binary):

- `integration.rs` — daily-writer command contracts; uses temp vaults +
  `AGENTIC_VAULT_ROOT` + `common::env_lock()`. Runs clean, hermetic.
- `health_grammar.rs` — Health-column grammar round-trips; temp-vault pattern.
  Runs clean, hermetic.
- `stt_roundtrip.rs` — pure cross-crate JSON golden round-trips. No runtime deps.
- `capture_roundtrip.rs` — pure cross-crate JSON golden round-trips. No runtime deps.
- `vault_io_sanity.rs` — mix of pure-function renderer tests (run today) and
  three `#[ignore]` real-vault smoke tests (never run — see below).
- `transcode_integration.rs` — **every test is `#[ignore]`** (they shell out to
  `ffmpeg` and run multi-second workloads). Compiles fine; runs **0** tests
  without `--ignored`.
- `common/mod.rs` — shared helper module (`env_lock`, `set_vault_root`,
  `fixture_path`); not a test target itself.

**The hazard (verbatim from the source):** both `stt_roundtrip.rs` and
`capture_roundtrip.rs` carry this banner:

```
//! Run (NEVER `cargo test --lib` — it SIGTERMs the dev sandbox):
//! cargo test --test stt_roundtrip      (resp. --test capture_roundtrip)
```

So the repo's own documented-safe invocation is the **per-target `--test <name>`
form**, never `--lib`.

**Do NOT use `cargo test --tests`.** Cargo's `--tests` flag (plural) selects
*all* test targets **including the library unit tests** — i.e. it re-includes
the exact `--lib` surface that SIGTERMs. (`integration.rs`'s header comment
loosely says "`cargo test --tests` must include this file's coverage"; that is
aspirational prose about coverage, not a safe invocation — ignore it for the
run command.) The provably-safe baseline enumerates the integration targets
explicitly with repeated `--test` flags, which never compiles or runs the lib
unit tests.

### The two web checks (both dependency-free)

- `web/scripts/check-theme-contrast.mjs` — a working **WCAG-AA** gate. Parses
  the theme registry's OKLch tokens + `web/src/styles.css`, computes contrast
  for text-on-surface / accent pairs across every theme in light **and** dark,
  and ends with `process.exit(failed === 0 ? 0 : 1)`. Imports only
  `node:*` + local `../src/themes/registry.js` — **no `node_modules` needed**.
  `PRODUCT.md` promises WCAG AA in every theme; this gate is currently only run
  by the manual `check-themes` script.
- `web/scripts/check-drag-math.mjs` — exhaustive `node:assert/strict` check of
  `computeSlotY` (`web/src/components/dragMath.js`) against a reference layout.
  Throws (→ non-zero exit) on mismatch. Imports only `node:assert` + local
  `../src/components/dragMath.js` — **no `node_modules` needed**.

This bespoke pure-math node-check style is the repo's **deliberate** test idiom.
**Extend it — do not introduce a heavyweight test framework (no Jest/Vitest).**

### `release.yml` today (the ONLY workflow)

Full current contents of `.github/workflows/release.yml`:

```yaml
name: Release
# ... (header comment about signing secrets) ...
on:
  push:
    tags:
      - 'v*'
permissions:
  contents: write
jobs:
  release:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
      - name: Cache Rust build
        uses: swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
      - name: Install dependencies
        run: |
          npm ci
          npm --prefix web ci
      - name: Build and publish release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          VITE_BUILD_TIER: studio
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Mortar & Pestle ${{ github.ref_name }}'
          releaseBody: |
            # ... release notes ...
          releaseDraft: false
          prerelease: false
      - name: Ensure updater latest.json
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node scripts/ensure-latest-json.mjs
```

The five mutable action refs to pin: `actions/checkout@v4`,
`actions/setup-node@v4`, `dtolnay/rust-toolchain@stable`,
`swatinem/rust-cache@v2`, `tauri-apps/tauri-action@v0`. The job holds
`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` in env at the build step.

### `vault_io_sanity.rs` — dead Linux path + never-run smoke tests

The module doc comment hardcodes a **Linux** path and a Linux run-hint (this app
now targets Windows):

```
//! ... against the real vault at /home/malthaiel/Documents/Citadel.
//! ...
//! Marked `#[ignore]` so `cargo test` in CI without the vault skips them.
//! Run locally with:
//!   cargo test -p mortar-pestle --test vault_io_sanity -- --ignored --nocapture
```

Three tests carry `#[ignore]`: `render_claude_md_smoke`,
`render_handles_nonexistent`, `render_rejects_traversal`. Their bodies call
`render::render_path(...)`, which resolves the vault root via
`app_lib::commands::vault::vault_root()` — whose **first precedence is the
`AGENTIC_VAULT_ROOT` env var** (confirmed at `src-tauri/src/commands/vault.rs:20-34`).
So the fix is env-based, not a literal path swap: gate the smoke tests on
`AGENTIC_VAULT_ROOT` and drop `#[ignore]` so they run in the baseline (as
cheap no-ops when the env is unset, as real checks when a vault root is
provided). The other tests in the file (`frontmatter_title_parser`,
`render_string_*`) are pure functions and already run.

The env pattern used across the suite (for reference — `common/mod.rs`):

```rust
static ENV_LOCK: Mutex<()> = Mutex::new(());
pub fn env_lock() -> MutexGuard<'static, ()> { ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner()) }
```

You do **not** need `env_lock` for the smoke-test guard below — it only *reads*
`AGENTIC_VAULT_ROOT` (set externally by the developer), and each `--test` target
is its own process, so there is no cross-target env race.

### tauri-build / `web/dist` caveat (read before Step 1)

Compiling `app_lib` for the integration tests may require the built frontend at
`web/dist` to exist (Tauri embeds `frontendDist` assets at compile time via
`tauri::generate_context!`). Whether it does depends on where that macro lives.
Two facts to act on:
- If your first `node scripts/verify.mjs` run fails at the **cargo** step with a
  tauri-build / `frontendDist` / missing-`web/dist` error, build the web
  frontend once first: `npm --prefix web ci && npm --prefix web run build`, then
  re-run. In CI this is handled by building web before `verify.mjs` (Step 2).
- If the cargo step compiles fine without `web/dist`, you may later drop the web
  build from `verify.yml` to speed CI (noted in Step 2).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full baseline | `node scripts/verify.mjs` | exit 0, prints `✓ verify passed` |
| Rust integration tests (the safe form) | `cargo test --manifest-path src-tauri/Cargo.toml --test integration --test health_grammar --test stt_roundtrip --test capture_roundtrip --test vault_io_sanity --test transcode_integration` | all named targets pass; `transcode_integration` runs 0 tests (all `#[ignore]`) |
| Web contrast gate | `npm --prefix web run check-themes` | exit 0; final line `✓ 0 fail, …` |
| Web drag gate | `npm --prefix web run check-drag` | exit 0 |
| JS syntax check | `node --check web/src/components/dragMath.js` | exit 0, no output |
| Build web (only if cargo needs dist) | `npm --prefix web ci && npm --prefix web run build` | exit 0; `web/dist/` created |
| Resolve an action tag → commit SHA | `gh api repos/actions/checkout/commits/v4 --jq .sha` | a 40-char hex SHA |

## Suggested executor toolkit

- **`gh` CLI** (GitHub CLI) for Step 4 SHA lookups: `gh api repos/<owner>/<repo>/commits/<ref> --jq .sha`.
  If `gh` is unavailable, use the web fallback in Step 4.
- No repo-specific skills are required.

## Scope

**In scope** (the only files you may create/modify):
- `scripts/verify.mjs` (create)
- `package.json` (root — add the `verify` script only)
- `.github/workflows/verify.yml` (create)
- `.github/workflows/release.yml` (edit — add a pre-build check step; pin action SHAs)
- `src-tauri/tests/vault_io_sanity.rs` (edit — doc comment + env-gate the 3 smoke tests)

**Out of scope** (do NOT touch):
- Any source under `src-tauri/src/**`, `web/src/**`, `modules/**` — this plan
  adds a gate around existing behavior, it does not change behavior.
- The 3 sidecar crates `mortar-pestle-{capture,stt,broadcast}` — separate crates,
  not reachable from `src-tauri`'s `cargo test`; a follow-up plan can add them.
- The lib unit tests (`cargo test --lib` / `--tests`) — deliberately excluded
  from the baseline because they SIGTERM the dev sandbox (see Maintenance notes).
- `web/scripts/check-*.mjs` — reuse them as-is; do not rewrite.
- Introducing any test framework or new dependency.

## Git workflow

- Branch: `advisor/002-verification-baseline` (or the repo's branch convention if
  one is evident from `git branch -a`).
- Commit per step or per logical unit. Match the repo's commit style — inspect
  `git log --oneline -10` and mirror it.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `scripts/verify.mjs` + the root `verify` script

Create `scripts/verify.mjs` — a zero-dependency Node ESM script that runs, in
sequence, (a) the Rust **integration** tests, (b) the two web checks, (c) a JS
syntax check over the pure util modules — and exits non-zero if any sub-step
fails, printing which. Use this shape (adjust only if a STOP condition forces
it):

```js
#!/usr/bin/env node
// One-command verification baseline for mortar-pestle. Runs the Rust integration
// tests + the two bespoke web checks + a JS syntax gate, in sequence, exiting
// non-zero (naming the failure) if any step fails.
//
// HAZARD — Rust tests: NEVER run `cargo test --lib` OR `cargo test --tests`
// here. Cargo's `--tests` selects ALL test targets INCLUDING the library unit
// tests (~36 #[cfg(test)] mods) — the exact `--lib` surface that SIGTERMs the
// agent dev-sandbox (see the banners in src-tauri/tests/stt_roundtrip.rs and
// capture_roundtrip.rs). We enumerate the INTEGRATION targets explicitly with
// repeated `--test <name>` flags — the form the repo's own test-file run-hints
// document as safe — which never compiles or runs the lib unit tests.
// Re-including `--lib`/`--tests` is a separate follow-up (see the plan's
// Maintenance notes) that must first isolate the offending unit test.
import { spawnSync } from 'node:child_process';

// npm resolves to npm.cmd on Windows; spawnSync with shell:false won't find a
// bare `npm` there. Pick the platform binary explicitly (CI + dev are Windows).
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [
  {
    name: 'rust integration tests',
    cmd: 'cargo',
    args: [
      'test', '--manifest-path', 'src-tauri/Cargo.toml',
      '--test', 'integration',
      '--test', 'health_grammar',
      '--test', 'stt_roundtrip',
      '--test', 'capture_roundtrip',
      '--test', 'vault_io_sanity',
      '--test', 'transcode_integration', // all #[ignore] → compiles, runs 0
    ],
  },
  { name: 'web: theme contrast (WCAG AA)', cmd: NPM, args: ['--prefix', 'web', 'run', 'check-themes'] },
  { name: 'web: drag math',                cmd: NPM, args: ['--prefix', 'web', 'run', 'check-drag'] },
  {
    name: 'js syntax check (pure utils)',
    cmd: process.execPath, // node
    baseArgs: ['--check'],
    // JSX-free util modules only — `node --check` rejects JSX. Grow this list
    // as pure utils are added; a listed file that gains JSX must be removed
    // (it belongs to the vite-built surface, not this syntax gate).
    files: ['web/src/components/dragMath.js', 'web/src/themes/registry.js'],
  },
];

const failed = [];
for (const s of steps) {
  if (s.files) {
    for (const f of s.files) {
      console.log(`\n▶ ${s.name}: node --check ${f}`);
      const r = spawnSync(s.cmd, [...s.baseArgs, f], { stdio: 'inherit' });
      if (r.status !== 0) failed.push(`${s.name} (${f})`);
    }
  } else {
    console.log(`\n▶ ${s.name}: ${s.cmd} ${s.args.join(' ')}`);
    const r = spawnSync(s.cmd, s.args, { stdio: 'inherit' });
    if (r.status !== 0) failed.push(s.name);
  }
}

if (failed.length) {
  console.error(`\n✗ verify FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\n✓ verify passed');
```

Then add to root `package.json` `scripts` (keep the existing entries):

```json
"verify": "node scripts/verify.mjs"
```

First confirm the two listed `node --check` files exist and are JSX-free
(`web/src/components/dragMath.js` is confirmed pure math; verify
`web/src/themes/registry.js` has no JSX — if it does, drop it from the `files`
list).

**Verify**: `node scripts/verify.mjs` → exits 0 and prints `✓ verify passed`.
(If the cargo step fails on a missing `web/dist`, see the tauri-build caveat
above: build web once, then re-run. If it SIGTERMs, see STOP conditions.)

### Step 2: Add the non-tag CI workflow `.github/workflows/verify.yml`

Create `.github/workflows/verify.yml` that runs the baseline on branch pushes
and PRs (NOT tags — `release.yml` owns tags; scoping `push.branches: ['**']`
matches all branches but not tag pushes, so the two never double-fire):

```yaml
name: Verify
on:
  push:
    branches: ['**']   # branch pushes only — tag pushes are handled by release.yml
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@<SHA>          # v4  (pin in Step 4)
      - name: Setup Node
        uses: actions/setup-node@<SHA>        # v4  (pin in Step 4)
        with:
          node-version: 20
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@<SHA>    # stable (pin in Step 4)
      - name: Cache Rust build
        uses: swatinem/rust-cache@<SHA>       # v2  (pin in Step 4)
        with:
          workspaces: src-tauri
      - name: Install dependencies
        run: |
          npm ci
          npm --prefix web ci
      - name: Build web (so app_lib tests compile)
        run: npm --prefix web run build
      - name: Run verification baseline
        run: node scripts/verify.mjs
```

The "Build web" step guarantees `web/dist` exists before the cargo step. If you
confirmed in Step 1 that the cargo step compiles **without** `web/dist`, you may
delete that step to speed CI (leave a one-line comment saying why).

**Verify**: `node -e "require('js-yaml')" ` is not available; instead validate
the YAML parses and the file is well-formed with:
`gh workflow view Verify` after pushing is the real check, but pre-push, confirm
structure with `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/verify.yml','utf8');if(!/on:\s/.test(s)||!/verify\.mjs/.test(s))process.exit(1)"` → exit 0. (If `actionlint` is installed, `actionlint .github/workflows/verify.yml` → exit 0 is stronger.)

### Step 3: Add a release-blocking check step to `release.yml`

Insert a new step in `.github/workflows/release.yml` **between** the existing
`Install dependencies` step and the `Build and publish release` (tauri-action)
step, running the two dependency-free web checks — so a theme below WCAG-AA (or
a drag-math regression) blocks the **signed** public release:

```yaml
      - name: Verify web gates (WCAG AA + drag math)
        run: |
          npm --prefix web run check-themes
          npm --prefix web run check-drag
```

Use the **web checks only** here (not the full `node scripts/verify.mjs`): they
need neither `web/dist` nor a Rust compile, so they add ~seconds and avoid a
build-ordering problem (tauri-action builds `web/dist` *after* this step) and a
redundant second web build. The full baseline (incl. Rust) runs in `verify.yml`
pre-tag; a compile regression would additionally fail tauri-action's own build.

**Verify**: `npm --prefix web run check-themes` → exit 0 (final line reports
`0 fail`); `npm --prefix web run check-drag` → exit 0. Confirm the new step sits
before the `tauri-apps/tauri-action` step in the file.

### Step 4: Pin every CI action `uses:` to a full commit SHA (both workflows)

The release job holds the updater signing key, so a compromised mutable action
ref could steal it and push malicious signed updates. Pin all five actions in
**both** `release.yml` and `verify.yml` to a 40-char commit SHA, keeping a
trailing version comment so the human/Dependabot can still track the intended
line.

**You MUST fetch these SHAs live — this plan contains none by design; do not
invent or recall any.** For each action, resolve its ref to a commit SHA:

```
gh api repos/actions/checkout/commits/v4          --jq .sha
gh api repos/actions/setup-node/commits/v4        --jq .sha
gh api repos/dtolnay/rust-toolchain/commits/stable --jq .sha
gh api repos/swatinem/rust-cache/commits/v2       --jq .sha
gh api repos/tauri-apps/tauri-action/commits/v0   --jq .sha
```

Web fallback if `gh` is unavailable: open
`https://github.com/<owner>/<repo>/commits/<ref>` and copy the full SHA of the
top commit (e.g. `https://github.com/actions/checkout/commits/v4`).

Note on `dtolnay/rust-toolchain@stable`: `stable` is a moving git ref, not a
semver tag — pin it to the SHA it currently points at and comment `# stable`.

Rewrite each `uses:` as, e.g.:

```yaml
        uses: actions/checkout@<40charSHA>   # v4
```

**Verify**: `grep -rEn "uses:\s+\S+@(v[0-9]+|stable)\b" .github/workflows/` →
**no matches** (every `uses:` now ends in a 40-hex SHA). And
`grep -rEn "uses:\s+\S+@[0-9a-f]{40}" .github/workflows/ | wc -l` → 10
(5 actions × 2 workflows).

### Step 5: Fix `src-tauri/tests/vault_io_sanity.rs` (dead path + un-ignore smoke tests)

1. **Doc comment**: remove the hardcoded Linux path and Linux run-hint. Replace
   the header's first line and the "Run locally with" block so they describe the
   env-gated behavior, e.g.:

   ```rust
   //! Sanity tests for the Rust vault IO + markdown renderer.
   //!
   //! The real-vault smoke tests read `AGENTIC_VAULT_ROOT` (the first-precedence
   //! vault root; see commands::vault::vault_root). They self-skip when it is
   //! unset — so they run as no-ops in CI and as real checks when a vault root is
   //! provided. The pure-function tests below always run.
   //!
   //! Run the smoke tests against a real vault:
   //!   AGENTIC_VAULT_ROOT=<path-to-vault> cargo test --manifest-path src-tauri/Cargo.toml --test vault_io_sanity -- --nocapture
   ```

2. **The three smoke tests** (`render_claude_md_smoke`, `render_handles_nonexistent`,
   `render_rejects_traversal`): remove `#[ignore]` from each and add a uniform
   env guard as the first line of each body, so they compile+run in the baseline
   and only assert when a vault root is present:

   ```rust
   #[test]
   fn render_claude_md_smoke() {
       let Ok(_root) = std::env::var("AGENTIC_VAULT_ROOT") else {
           eprintln!("skip render_claude_md_smoke: AGENTIC_VAULT_ROOT unset");
           return;
       };
       // ... existing assertions unchanged ...
   }
   ```

   Apply the same guard (with the matching test name in the message) to
   `render_handles_nonexistent` and `render_rejects_traversal`. Do not otherwise
   change the assertion bodies.

The non-`#[ignore]` subset (`frontmatter_title_parser`, `render_string_*`) is
already covered by the `--test vault_io_sanity` target in `verify.mjs`.

**Verify**:
`cargo test --manifest-path src-tauri/Cargo.toml --test vault_io_sanity` → all
tests pass; the three smoke tests print their `skip …` line and pass (env unset
in a plain shell). Then `grep -n "#\[ignore\]" src-tauri/tests/vault_io_sanity.rs`
→ no matches. Then re-run `node scripts/verify.mjs` → still `✓ verify passed`.

## Test plan

This plan **adds the harness**, not new product tests. Coverage folded into the
baseline: the two cross-crate protocol gates (`stt_roundtrip`,
`capture_roundtrip`), the daily-writer + health-grammar integration tests
(`integration`, `health_grammar`), the renderer sanity tests (`vault_io_sanity`,
now including the un-ignored smoke tests as env-gated), the WCAG-AA contrast gate,
the drag-math gate, and a JS syntax pass over pure utils.

- Structural pattern to mirror for any future Rust integration test:
  `src-tauri/tests/integration.rs` (temp-vault + `common::env_lock`).
- Structural pattern for any future JS check: `web/scripts/check-drag-math.mjs`
  (dep-free `node:assert` over a pure module).
- Full-baseline verification: `node scripts/verify.mjs` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node scripts/verify.mjs` exits 0 and prints `✓ verify passed`.
- [ ] Root `package.json` has a `"verify": "node scripts/verify.mjs"` script
      (`node -e "process.exit(require('./package.json').scripts.verify?0:1)"` → exit 0).
- [ ] `.github/workflows/verify.yml` exists, triggers on `push`(branches)+`pull_request`, runs `node scripts/verify.mjs`.
- [ ] `release.yml` runs `check-themes` (+ `check-drag`) **before** the `tauri-apps/tauri-action` step.
- [ ] `grep -rEn "uses:\s+\S+@(v[0-9]+|stable)\b" .github/workflows/` → **no matches**; 10 `uses:` lines end in a 40-hex SHA.
- [ ] `grep -n "#\[ignore\]" src-tauri/tests/vault_io_sanity.rs` → no matches; the Linux path `/home/malthaiel` no longer appears in that file.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated (only if that index exists).

## STOP conditions

Stop and report back (do not improvise) if:

- **`cargo test … --test <targets>` SIGTERMs or is killed.** The explicit
  integration-target enumeration is supposed to avoid the `--lib` SIGTERM
  entirely. If it still SIGTERMs, the hazard reaches an *integration* test (not
  just the lib) and the core invocation assumption is wrong — do NOT start
  deleting tests. Report which target triggered it. (First, sanity-check you did
  not accidentally use `--lib` or `--tests`.)
- The cargo step fails to **compile** for a reason other than missing `web/dist`
  (e.g. an API/signature drift in a test), or fails after you have built
  `web/dist` and retried once — the codebase has drifted from this plan's
  "Current state"; report the error.
- `release.yml` or `vault_io_sanity.rs` on disk does not match the excerpts in
  "Current state" (drift since 57a6c80).
- A `node --check` listed file errors because it contains JSX — remove it from
  the list and note it; if that leaves the JS-check step with zero files, report
  (the pure-util set may have moved).
- `gh api` cannot resolve an action ref to a SHA and the web fallback is also
  unavailable — report; do NOT commit a placeholder or remembered SHA.
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this after it lands:

- **This baseline is the drift-gate other plans reference.** Every new test
  surface — a new `src-tauri/tests/*.rs` integration target, a new
  `web/scripts/check-*.mjs`, or a new pure util worth syntax-checking — **must
  be added to `scripts/verify.mjs`** (a new `--test <name>` in the cargo args, a
  new web-check step, or a new entry in the `node --check` `files` list). If it
  is a dependency-free web gate that should block releases, also add it to
  `release.yml`'s pre-build check step.
- **Deliberately excluded: the lib unit tests** (`cargo test --lib` / `--tests`,
  ~36 `#[cfg(test)]` mods). They SIGTERM the dev sandbox because at least one
  unit test spawns a subprocess the sandbox kills. A worthwhile follow-up plan:
  isolate the offending unit test(s) (e.g. behind an `#[ignore]` or a feature
  flag / a dedicated `--test` harness), then re-include the lib units so
  `verify.mjs` gains full unit coverage. Until then the baseline is
  integration-only by design.
- **Deliberately excluded: the 3 sidecar crates**
  (`mortar-pestle-{capture,stt,broadcast}`). No Cargo workspace ties them in, so
  they need their own `cargo test --manifest-path <crate>/Cargo.toml` step in
  `verify.mjs` — a small follow-up.
- **SHA pins vs updates.** The trailing `# v4` / `# stable` comments let a human
  (or Dependabot `github-actions` ecosystem, if enabled) bump the pins later.
  Re-pin on every intentional action upgrade; never revert to a mutable `@vN`
  ref on the signing job.
- **What a reviewer should scrutinize**: that `verify.mjs` never contains
  `--lib` or `--tests`; that release-time signing secrets are still only exposed
  at the tauri-action step; that the new `verify.yml` cannot fire on tag pushes
  (double-run) and that the two workflows' triggers don't overlap.
