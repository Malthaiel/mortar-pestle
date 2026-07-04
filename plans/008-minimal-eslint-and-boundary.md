# Plan 008: Add minimal ESLint (react-hooks + optional import boundary) and document the real module/host boundary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- web/package.json docs/DESIGN.md web/eslint.config.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (the first lint run surfaces real pre-existing findings — this plan keeps them as warnings and does NOT fix the codebase)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

This is ~90k lines of React written in plain JS/JSX with **no lint gate at
all** — nothing catches the React-hooks bug class (conditional hooks, stale
closures, missing effect deps), which is exactly the async-hazard family that
bites this kind of app. Standing up a *minimal* ESLint (rules-of-hooks as an
error, exhaustive-deps as a warning) gives one cheap guardrail without imposing
style ceremony the repo deliberately avoids.

Separately, a design doc claims a module/host import boundary that does not
exist. `Knowledge/Mortar & Pestle/Reference/ARCHITECTURE.md:149` (in the
**Citadel vault**, not this repo) states: *"Modules never import host source…
This rule is enforced by lint config: `web/src/*` is forbidden in any
`modules/*/index.jsx` import chain."* There is no lint config, and modules
import from `@host` (which resolves to `web/src`) **274 times across 133
files**. The repo's own `docs/DESIGN.md:106` says primitives should never be
deep-imported, yet modules deep-import `@host/components/ui/<File>.jsx` **58
times**. The documented "one hard boundary" is fiction. This plan replaces the
fiction with the boundary that actually holds (no cross-module imports —
verified: only 2 exist, both intra-library-family) and describes the real
shared surface, so future contributors and any lint rule reflect reality.

## Current state

Verified at `57a6c80`.

### No ESLint anywhere

- No `.eslintrc*` and no `eslint.config.*` exist outside `node_modules`
  (`git ls-files | grep -iE 'eslintrc|eslint.config'` → empty).
- `eslint` is **not installed**: `web/node_modules/.bin/eslint` does not exist;
  `eslint-plugin-react-hooks` is absent. They must be added.
- Neither `package.json` has a `lint` script.

`web/package.json` (relevant parts, verbatim):

```json
{
  "name": "mortar-pestle-web",
  "version": "0.0.21",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "build:watch": "vite build --watch",
    "preview": "vite preview",
    "check-themes": "node scripts/check-theme-contrast.mjs",
    "check-drag": "node scripts/check-drag-math.mjs"
  },
  "devDependencies": {
    "@babel/generator": "^7.29.1",
    "@babel/parser": "^7.29.3",
    "@babel/traverse": "^7.29.0",
    "@babel/types": "^7.29.0",
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.5"
  }
}
```

The repo's "tests" are bespoke `node`, `assert`-based, no-framework checks (e.g.
`web/scripts/check-drag-math.mjs`, run via `npm run check-drag`). The `lint`
script sits alongside these as one more `npm run` gate — no framework, no CI
assumptions.

### JSX-in-`.js` gotcha (critical for the config)

Vite compiles JSX in **both** `.js` and `.jsx` files. `web/vite.config.js:63-66`:

```js
  esbuild: {
    loader: 'jsx',
    include: /(?:src|modules)\/.*\.(js|jsx)$/,
  },
```

ESLint's default parser (espree) does **not** parse JSX unless
`parserOptions.ecmaFeatures.jsx` is true. Without it, every `.jsx` (and any
`.js` containing JSX) throws a parse error and the run is useless. The config
below sets it.

### The false boundary claim (vault — report, do not edit from this repo)

`Knowledge/Mortar & Pestle/Reference/ARCHITECTURE.md:149` (Citadel vault, path
`C:\Users\malth\Documents\Citadel\...` — **not in this repo**):

> - **Modules never import host source.** Modules import only from the SDK's published surface (`@module-sdk` or equivalent alias). This rule is enforced by lint config: `web/src/*` is forbidden in any `modules/*/index.jsx` import chain.

Reality, measured at `57a6c80` over `modules/` (`grep -rhoE "from '@host/[a-z-]+" modules/ | sort | uniq -c`):

| `@host/` subpath | imports | sanctioned SDK? |
|---|---|---|
| `@host/components` | 168 | no (host UI/internals) |
| `@host/api` | 25 | the host request layer (`web/src/api.js`) |
| `@host/hooks` | 22 | no |
| `@host/util` | 15 | no |
| `@host/router` | 12 | no |
| `@host/keybinds` | 7 | no |
| `@host/module-sdk` | 6 | **yes** — the published SDK |
| `@host/lib` | 6 | no |
| `@host/context-menu` | 6 | no |
| `@host/pages` | 4 | no |
| `@host/command-actions` | 2 | no |
| `@host/agents` | 1 | no |

Total **274** across **133** files; only **6** hit the "published surface"
(`@host/module-sdk`). So "`web/src/*` is forbidden in modules" is false by two
orders of magnitude. (`@host` → `web/src`, per `web/vite.config.js:32`
`'@host': path.resolve(__dirname, 'src')`.) Of these, **58** are deep imports of
`@host/components/ui/<File>.jsx` — the exact pattern `docs/DESIGN.md:106` says
never to do.

`docs/DESIGN.md:104-106` (repo, verbatim):

```markdown
## Primitives

Live under `web/src/components/ui/` and re-export via `web/src/components/ui/index.js`. Import as `from './ui/index.js'` (or `'../ui/index.js'` etc.) — never deep-import the individual files.
```

### The boundary that DOES hold: no cross-module imports (2 exceptions)

There is exactly one real, enforceable invariant, and it nearly holds. Modules
almost never import each other. `grep -rnE "from '@modules/" modules/` returns
exactly **2** hits, both intra-library-family (the music sub-module importing a
shared component from its own library parent):

```
modules/core/library/music/MusicCredits.jsx:18: import PosterRow from '@modules/core/library/PosterRow.jsx';
modules/core/library/music/MusicHome.jsx:16:    import PosterRow from '@modules/core/library/PosterRow.jsx';
```

`grep -rnE "from '(\.\./){2,}" modules/` (relative imports climbing out of a
module) returns **zero** cross-module hits. `library/`, `library/music/`,
`library/video/` etc. are one family sharing `@modules/core/library/*`. So the
true rule is: *no imports across module families; the library sub-tree is one
family.*

### Repo doc layout

- `docs/` contains `DESIGN.md` and `POLISH_PROMPT.md`. There is **no
  `ARCHITECTURE.md` and no `CLAUDE.md` in this repo** — so the boundary
  documentation for this plan lands in `docs/DESIGN.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 57a6c80..HEAD -- web/package.json docs/DESIGN.md web/eslint.config.js` | empty |
| Install deps | `npm --prefix web install` | exit 0, lockfile updated |
| Run lint | `npm --prefix web run lint` | completes; see note below |
| Build (sanity) | `npm --prefix web run build` | exit 0 |

**Lint exit-code note**: `npm run lint` is expected to *complete without a
config/parse crash*. A **non-zero exit caused only by surfaced findings**
(pre-existing warnings, or a genuine rules-of-hooks error) is acceptable and
expected — that is the gate doing its job. What must NOT happen is a config
resolution failure or a wall of parse errors (see STOP conditions).

## Scope

**In scope** (the only files you should modify/create):
- `web/eslint.config.js` — **new** flat config
- `web/package.json` — add devDependencies + `lint` script
- `docs/DESIGN.md` — amend to describe the real boundary

**Out of scope** (do NOT touch):
- The ~90k-line codebase itself. Do **not** auto-fix lint findings, do **not** run `eslint --fix`, do **not** rewrite the 58 deep imports or the 2 cross-module imports. This plan stands up the gate and corrects the doc — nothing else.
- `Knowledge/Mortar & Pestle/Reference/ARCHITECTURE.md` — it is in the **Citadel vault**, a different repo you likely cannot reach. Its false "enforced by lint" claim is a **report item** (see Maintenance notes), not an edit in this plan.
- The root `package.json` — leave it; the lint gate lives in `web/`.
- Prettier, style rules, `eslint-plugin-react` (component rules), CI wiring — all explicitly excluded.

## Git workflow

- Branch: `advisor/008-minimal-eslint-and-boundary`.
- Conventional commits (repo style, e.g. `chore(web): ...`, `docs: ...`). Suggested: `chore(web): add minimal eslint (react-hooks) + document real module boundary`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add devDependencies

Add to `web/package.json` `devDependencies` (these are **dev-only**, not
shipped at runtime — allowed):

- `eslint` (v9+, for native flat-config support)
- `@eslint/js` (the recommended rule set)
- `eslint-plugin-react-hooks` (v5+, flat-config compatible)

Then install:

```
npm --prefix web install
```

**Verify**: `web/node_modules/.bin/eslint` exists
(`ls web/node_modules/.bin/eslint`); `npm --prefix web ls eslint
eslint-plugin-react-hooks @eslint/js` lists all three with resolved versions.
Record the three resolved versions in your PR/commit body.

### Step 2: Create `web/eslint.config.js`

Create exactly this flat config. It is deliberately minimal: recommended rules,
JSX parsing enabled for `.js` and `.jsx`, rules-of-hooks as **error**,
exhaustive-deps as **warn**, and the two noisiest *pre-existing-debt* rules
downgraded to **warn** so day-one legacy findings don't hard-fail the gate.
`no-undef` is **off** on purpose — this is a browser app with many ambient
globals and the gate's job is the hooks bug class, not global resolution
(keeping `no-undef` on would require a `globals` dependency and flood the first
run; skipped deliberately).

```js
// Minimal ESLint gate. Purpose: catch the React-hooks bug class. NOT a style
// gate — no Prettier, no formatting rules. See plans/008 for rationale.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'vite-plugins/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Off: browser app with ambient globals; not this gate's concern.
      'no-undef': 'off',
      // Pre-existing debt — surface as warnings, don't fail the gate on legacy code.
      'no-unused-vars': 'warn',
      'no-empty': 'warn',
    },
  },
];
```

**Verify**: `node --input-type=module -e "import('./web/eslint.config.js').then(m
=> console.log(Array.isArray(m.default)))"` prints `true` (the config module
loads and exports an array — catches a syntax/import error before you run
eslint).

### Step 3: Add the `lint` script

In `web/package.json` `scripts`, add:

```json
    "lint": "eslint ."
```

**Note on coverage**: run from `web/`, `eslint .` lints `web/src` only —
**`modules/` (outside `web/`) is not covered**. That is an accepted limitation
of this minimal gate: the host SDK, hooks, and providers most worth guarding
live in `web/src`. Extending to modules is the documented follow-up (Maintenance
notes) — do not do it here.

**Verify**: `npm --prefix web run lint` runs to completion (see Step 4).

### Step 4: Run the gate, record results, tame day-one errors if needed

Run `npm --prefix web run lint`.

- If it **completes** (prints a findings summary, or clean) — good. Record the
  count of errors vs warnings. **List any `react-hooks/rules-of-hooks` errors
  verbatim in your PR/commit body** — those are real latent bugs and the whole
  point of this plan, but per Scope you do **not** fix them here.
- If it hard-fails on a **pre-existing `js.configs.recommended` rule that is an
  error** (not rules-of-hooks — e.g. `no-cond-assign`, `no-constant-condition`,
  `no-fallthrough` firing on legacy code), downgrade *only that specific rule*
  to `'warn'` in the config's `rules` block, with a `// pre-existing debt`
  comment, and re-run. This plan stands up the gate; it does not fix legacy
  debt. Do NOT downgrade `react-hooks/rules-of-hooks`.
- If it fails on **config resolution or parse errors on most/all files** — that
  is a STOP condition (see below), not a rule to downgrade.

**Verify**: `npm --prefix web run lint` completes without a config/parse crash;
you can state the error/warning counts.

### Step 5: Amend `docs/DESIGN.md` to describe the real boundary

Two edits to `docs/DESIGN.md`:

**(a)** Soften the absolute at line 106. The "never deep-import" rule is sound
for *host-internal* imports but 58 module imports already violate it via
`@host/components/ui/<File>.jsx`, and modules cannot use the `./ui/index.js`
relative form. Change the last sentence of the Primitives paragraph from:

```
Import as `from './ui/index.js'` (or `'../ui/index.js'` etc.) — never deep-import the individual files.
```

to:

```
Host-internal code imports as `from './ui/index.js'` (or `'../ui/index.js'`) — prefer the barrel over deep-importing individual files. Modules import the same barrel as `@host/components/ui/index.js` (a handful of legacy `@host/components/ui/<File>.jsx` deep imports predate this and are not retroactively rewritten).
```

**(b)** Add a new subsection documenting the **real** module/host boundary.
Place it near the Primitives section (or wherever module architecture is
discussed). Use this text — it states what actually holds so no future reader
trusts the fiction:

```markdown
## Module ↔ host import boundary (what actually holds)

Modules (`modules/**`) share a broad host surface by design, reached via the
`@host/*` alias (`@host` → `web/src`, see `web/vite.config.js`). Host UI
primitives (`@host/components`, incl. the `@host/components/ui/index.js`
barrel), hooks (`@host/hooks`), utilities (`@host/util`, `@host/lib`), the
router (`@host/router`), and the module SDK (`@host/module-sdk`) are all
legitimately imported by modules. There is **no rule** that modules may only
touch the SDK — as of this writing modules import `@host/*` ~274× across ~133
files, and only ~6 of those hit `@host/module-sdk`. Any older claim that
`web/src/*` is "forbidden in modules, enforced by lint" is inaccurate and
should be disregarded.

The one invariant that **does** hold: **no imports across module families.**
`modules/core/A` must not import `modules/core/B`. The `library` sub-tree
(`library`, `library/music`, `library/video`, …) is a single family sharing
`@modules/core/library/*`; the only current cross-file `@modules` imports are
two intra-library uses of `@modules/core/library/PosterRow.jsx`, which are fine.
Cross-*family* imports are not allowed — extract shared code to the host
(`web/src`) instead.
```

**Verify**: `grep -n "what actually holds" docs/DESIGN.md` → 1 match;
`grep -n "never deep-import the individual files" docs/DESIGN.md` → **no
matches** (the old absolute is gone).

### Step 6 (OPTIONAL — only if you also extend lint to `modules/`): enforce the no-cross-family rule

Skip this by default. A `no-restricted-imports` rule banning cross-module
imports only *does* anything if `modules/` is in the lint path, and Step 3's
`eslint .` (run from `web/`) does **not** cover `modules/`. So this rule would
be dead config as-is. If (and only if) a reviewer wants it enforced now:

1. Change the lint script to also cover modules: `"lint": "eslint . ../modules"`.
2. Add a config block for the modules glob banning cross-family `@modules`
   imports, with the library family allowed. Be aware this will flag nothing
   today (the 2 existing `@modules` imports are intra-library and allowed) — its
   value is catching *future* cross-family imports.

This is genuinely optional and adds surface area; the lazy default is to leave
it out and note it as a follow-up. If you skip it (recommended), say so in the
PR body. If you do it, the 2 existing library imports must remain unflagged.

### Step 7: Sanity build

**Verify**: `npm --prefix web run build` → exit 0 (config/dep changes didn't
break the Vite build).

## Test plan

No product-code tests — this plan adds no runtime behavior. The verification
*is* running the new gate:

- `npm --prefix web run lint` completes and reports findings (Step 4).
- `node --input-type=module -e "import('./web/eslint.config.js')..."` proves the
  config loads (Step 2).
- `npm --prefix web run build` still exits 0 (Step 7).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `web/eslint.config.js` exists and exports an array (Step 2 verify passes)
- [ ] `web/package.json` has `eslint`, `@eslint/js`, `eslint-plugin-react-hooks` in devDependencies and a `"lint": "eslint ."` script
- [ ] `npm --prefix web run lint` completes without a config/parse crash; error/warning counts and any `rules-of-hooks` findings are recorded in the PR/commit body
- [ ] `docs/DESIGN.md` contains the "Module ↔ host import boundary (what actually holds)" subsection, and the old "never deep-import the individual files" absolute is gone
- [ ] `npm --prefix web run build` exits 0
- [ ] No files outside the in-scope list are modified, and no product source was auto-fixed (`git status`; the only changes are `web/eslint.config.js`, `web/package.json`, `web/package-lock.json`, `docs/DESIGN.md`)
- [ ] `plans/README.md` status row updated (if the file exists)

## STOP conditions

Stop and report back (do not improvise) if:

- **`npm --prefix web run lint` fails on config resolution** (e.g. "Could not
  find config", flat-config not recognized → the installed `eslint` is <9, or
  `eslint-plugin-react-hooks` does not expose a flat-config-compatible plugin
  object for the installed version). Report the three resolved versions from
  Step 1 and the exact error. Do not hack around it.
- **Most/all files throw parse errors** (`Parsing error: Unexpected token <` or
  similar across the board) — the JSX `parserOptions` is not taking effect.
  Re-check Step 2's config; if it still fails, report it (do not delete files or
  disable whole configs).
- The doc excerpts in "Current state" (`docs/DESIGN.md:104-106`) don't match the
  live file (drift since `57a6c80`).
- You find yourself needing to modify product source to make the gate pass —
  that means you're fixing the codebase, which is out of scope. Stop; the gate
  is allowed to report findings.

## Maintenance notes

- **Vault doc to correct (out of this repo)**: `Knowledge/Mortar &
  Pestle/Reference/ARCHITECTURE.md:149` in the Citadel vault claims the
  module/host boundary is "enforced by lint config" and that "`web/src/*` is
  forbidden in any `modules/*/index.jsx` import chain." Both are false. That
  file is not in this repo, so this plan cannot edit it — **report this to the
  operator** so it gets corrected at the source, ideally pointing at the new
  `docs/DESIGN.md` subsection as the accurate description.
- **Coverage follow-up**: the gate lints `web/src` only. To extend to
  `modules/`, change the script to `eslint . ../modules` (from `web/`) and
  re-run; expect a fresh batch of react-hooks findings in module code. Do this
  as its own change so the first module-lint run's findings are reviewed
  deliberately.
- **Don't let recommended creep into a style gate.** If future noise pushes
  someone to add Prettier or style rules, that contradicts the repo's
  low-ceremony intent — keep this config to the hooks bug class plus whatever
  genuine-correctness recommended rules stay green.
- Reviewer should scrutinize: that `react-hooks/rules-of-hooks` is still
  `'error'` (not downgraded), that no product source was auto-fixed, and that
  the recorded rules-of-hooks findings (if any) are triaged into their own
  follow-up rather than silently left.
