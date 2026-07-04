# Plan 027: Converge CSS ownership and persistence/notification patterns on the de-facto winners

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If anything in the "STOP conditions" section occurs, stop and report — do
> not improvise. When done, update the status row for this plan in
> `plans/README.md` if that file exists — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- web/src/styles.css modules/core/library`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L (mostly a doc + a bounded first sweep; the full straggler sweep is deferred)
- **Risk**: MED (CSS regressions are **silent** — a mis-scoped move looks fine at build time and breaks a surface only visually; there is no test that catches it)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Three conventions have a clear de-facto winner but no written rule, so the
codebase keeps drifting away from each:

- **CSS ownership**: `web/src/styles.css` is **4932 lines — ~93% of all app CSS** —
  and holds module-specific styles (a whole "MAL anime page clone" block owned by
  the library module; overlay-host panel styles). Only **5 of ~15 modules** ship
  their own CSS. There's no rule, so deleting a module orphans its selectors in
  the host sheet, and every new module's styles default into the 4932-line pile.
- **Persistence**: the winner is `useSettings`/`settings.*` (~47 files), but **43
  raw `localStorage` keys across 37 files** bypass it, plus server/vault-JSON
  paths coexist — with no rule saying which to reach for.
- **Data access + notifications**: raw `invoke()` vs the `@host/api.js` wrapper vs
  5 module-owned `api.js` wrappers vs the deprecated `vault.endpoint`; and four
  notification entry points (`notify` / `Toast.` / `showToast` / `toast(`) coexist.

This plan is **document-the-rule-then-sweep**, not a big-bang rewrite. Its
deliverable is (1) a short conventions doc naming the winners, (2) the **first,
safest** CSS-migration slice (the library module's anime block), and (3) a
straggler checklist so the rest is a tracked follow-up, not a silent debt.

## Current state

### (A) CSS ownership

- `web/src/styles.css` = **4932 lines** (verified `wc -l`). Imported once, globally,
  at `web/src/main.jsx:8` (`import './styles.css';`).
- **Modules that already own + import their CSS (the pattern to generalize) — 5:**
  - `modules/core/terminal/terminal.css` ← `terminal/index.jsx:17` (`import './terminal.css';`)
  - `modules/core/game-wiki/game-wiki.css` ← `game-wiki/index.jsx:10`
  - `modules/core/feedback/feedback.css` ← `feedback/index.jsx:7`
  - `modules/studio/overlay/stt.css` ← `overlay/SttPage.jsx:5`
  - `modules/studio/broadcast/broadcast.css` ← `broadcast/BroadcastPage.jsx:24`
- **Module-specific blocks currently stranded in `styles.css`:**
  - **Anime page clone** — `styles.css:4431-4811`, a contiguous `.anime-*` block
    (header comment `styles.css:4431`: `/* === MAL anime page clone === */`;
    last selector `.anime-recs-row` at `:4805`; the next block starts `:4813`).
    Owned by the **library module**: the `.anime-*` classes are used only in
    `modules/core/library/AnimeDetailHeader.jsx` and
    `modules/core/library/AnimeRecommendations.jsx` (verified: `grep -rl
    "anime-alt-titles\|anime-recs-row\|anime-histogram\|anime-info" web/src` →
    **no host files**; the library module is the sole consumer). **This is the
    clean, safe first slice.**
  - **Overlay-host panels** — `styles.css:4813-4932`: `.capture-hud`/`.overlay-toast`
    (`:4813`), `.ov-studio-*` (`:4827`), `.ov-scrim-*` (`:4917`). These render in
    the **overlay-host webview** (`web/src/overlays/OverlayStudioPanel.jsx`,
    `OverlayHostView.jsx`) — **host code, not a module**. They are a *riskier*
    candidate: the overlay host already **borrows another module's CSS**
    (`web/src/overlays/OverlayStudioPanel.jsx:29`: `import
    '@modules/studio/overlay/stt.css';`). This cross-import is exactly the hazard
    the STOP condition guards. Treat overlay panels as an **optional gated second
    slice**, moved (if at all) to a host sheet `web/src/overlays/overlays.css`,
    not a module CSS.
- The library module entry is `modules/core/library/index.jsx` (its import block is
  `:7-27`) — the correct place to add `import './library.css';`.

### (B) Persistence — winner + exceptions

- Winner: `useSettings` (`web/src/hooks/useSettings.js`, **50 `localStorage`
  references** — it *is* the settings implementation) exposed as the module-SDK
  `settings.*` surface (~47 files use it).
- **43 raw `localStorage` keys across 37 files** bypass it (verified: `grep -rl
  "localStorage.\(get\|set\|remove\)Item" modules web/src` → 37 files; the
  distinct-key count of 43 is the audit lead to confirm during the follow-up
  sweep).
- **Legit exception to document, not "fix":** `web/src/overlays/OverlayStudioPanel.jsx`
  (6 `localStorage` refs, incl. `'overlay-studio-order'`) persists to raw
  `localStorage` because the **bare overlay host webview can't reach the
  server-backed `useSidebarOrder`**. Server/vault-JSON persistence is also correct
  in places (settings that must survive a reinstall / be shared across vaults).

### (C) Data access + notifications

- **Data paths coexist**: raw `invoke()` from `@host/api.js`; the `@host/api.js`
  `api` wrapper; **5 module-owned `api.js` wrappers** (e.g.
  `modules/core/library/api.js`, `modules/core/library/music/api.js`); and the
  deprecated `vault.endpoint`.
- **Notification entry points coexist** (approximate audit leads — confirm exact
  counts during the follow-up sweep): `notify(` (~60), `Toast.` (~29),
  `showToast` (~23), `toast(` (~3). The download/import providers already route
  through the central `agentic:notify` bus (see
  `modules/core/library/music/DownloadProvider.jsx:83`) — that's the winner.

### Conventions to honor / where the doc goes

- **Correction to an earlier draft premise:** the repo DOES contain
  `docs/DESIGN.md` (a ~30 KB code-adjacent *design-language* reference: tokens,
  primitives, CSS patterns — tracked in git) plus `docs/POLISH_PROMPT.md`. This is
  a DIFFERENT file from the creative/motion `DESIGN.md` that lives in the Obsidian
  vault (unreachable by a code executor). Also note: sibling plan `006` creates a
  repo-root `CLAUDE.md`, and sibling plan `008` appends the module/host import
  boundary note to `docs/DESIGN.md`. So there are three candidate homes.
- **Doc placement decision for this plan:** put the **CSS-ownership rule** in
  `docs/DESIGN.md` (it is design-language, and sits beside plan 008's boundary
  note — keep them together). Put the **code/state conventions** (persistence,
  data-access, notifications) in a repo-root `CONVENTIONS.md` (code conventions,
  not design-language). If plan 006's `CLAUDE.md` already exists when you run this,
  a one-line pointer from `CLAUDE.md` to `CONVENTIONS.md` is enough — do not
  duplicate. (The rest of this plan says `CONVENTIONS.md`; wherever it does, the
  CSS-ownership section specifically belongs in `docs/DESIGN.md` per this decision.)
- Module CSS is imported from the module's **entry** file (`index.jsx`) or its top
  page — match the 5 exemplars above.

## Commands you will need

| Purpose           | Command                              | Expected on success        |
|-------------------|--------------------------------------|----------------------------|
| Web build         | `npm --prefix web run build`         | exit 0, `web/dist` written |
| Dev run (manual)  | `npm run tauri dev`                  | Vite + window, app boots   |
| Count CSS lines   | `wc -l web/src/styles.css`           | (drops by ~380 after slice)|

## Scope

**In scope:**
- `CONVENTIONS.md` (create, repo root) — the rule doc + the straggler checklist.
- `modules/core/library/library.css` (create) — receives the anime block.
- `modules/core/library/index.jsx` (add one `import './library.css';` line).
- `web/src/styles.css` (delete the moved anime block).

**Out of scope (do NOT do in this plan):**
- The **full 43-key `localStorage` sweep** — documented as a follow-up checklist
  only. Do not migrate any raw `localStorage` call.
- The **notification sweep** (collapsing `Toast.`/`showToast`/`toast(` → `notify`)
  — checklist only.
- Migrating any **module-owned api.js wrapper** or the `vault.endpoint` deprecation
  — checklist only.
- Moving the **overlay-host panel CSS** (`.capture-hud`/`.ov-studio-*`/`.ov-scrim-*`)
  unless Step 3's gate passes — it's host-scoped and borrow-adjacent (optional).
- Any **behavioral** change. CSS moves are byte-identical relocations; the doc adds
  no runtime code.

## Git workflow

- Branch: `advisor/027-styling-and-state-conventions`.
- Commit per step. Message style — match repo, e.g.
  `docs: add CONVENTIONS.md (css ownership, persistence, notifications)` and
  `refactor(library): move anime page CSS out of styles.css into library.css`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: write `CONVENTIONS.md` (the deliverable)

Create `CONVENTIONS.md` at the repo root with these sections (fill the winners
exactly as stated — this doc is the whole point of the plan):

```markdown
# App Conventions

De-facto standards for CSS ownership, persistence, data access, and
notifications. New code follows these; drift is the exception and must be
justified inline.

## CSS ownership
- **Each module owns a `<module>.css` next to its entry and imports it there.**
  Exemplars: `modules/core/terminal/terminal.css`, `game-wiki/game-wiki.css`,
  `feedback/feedback.css`, `studio/overlay/stt.css`, `studio/broadcast/broadcast.css`.
- `web/src/styles.css` holds ONLY host-global styles (design tokens, the candy
  primitives, layout shell). Module-specific selectors do not belong here.
- The overlay-host webview (`web/src/overlays/`) is host code, not a module; its
  panel styles live in a host sheet, and it may import a module's CSS when it
  genuinely reuses that module's chrome (documented exception:
  `OverlayStudioPanel.jsx` imports `stt.css`).

## Persistence
- **`useSettings` / the module-SDK `settings.*` surface is the standard** for user
  and module preferences.
- Use raw `localStorage` only where `settings.*` is unreachable — the documented
  case is the bare overlay-host webview (`overlay-studio-order`), which can't reach
  the server-backed `useSidebarOrder`.
- Use server/vault-JSON persistence when the value must survive a reinstall or be
  shared across vaults (name the case at the call site).

## Data access
- **One path: a module-owned `api.js` wrapper → the SDK `invoke`.** Modules that
  talk to Rust own a thin `api.js` (see `modules/core/library/api.js`) rather than
  calling raw `invoke` scattered across components.
- `vault.endpoint` is deprecated — do not add new callers.

## Notifications
- **One entry point: `notify` (the `agentic:notify` bus).** `Toast.`/`showToast`/
  `toast(` are legacy and are being swept out.
```

Then append the **straggler checklist** (from "Current state" B and C) as a
`## Follow-up sweeps (tracked, not yet done)` section: the 43 raw-`localStorage`
files, the `Toast.`/`showToast`/`toast(` entry points, and the module-owned
api.js wrappers to reconcile. Generate the file list to paste with:
`grep -rl "localStorage.\(get\|set\|remove\)Item" modules web/src` and
`grep -rn "Toast\.\|showToast\|[^a-zA-Z]toast(" modules web/src`. List them; do
**not** change them.

**Verify**: `CONVENTIONS.md` exists at repo root and contains the four rule
sections + the follow-up checklist. (No build impact — it's a doc.)

### Step 2: move the anime CSS block into the library module (first sweep slice)

**Pre-move safety grep (this is the STOP gate — run it first):** confirm every
selector in `styles.css:4431-4811` is `.anime-*` prefixed and used only by the
library module:
`grep -n "^\.[a-z]" web/src/styles.css | awk -F: '$1>=4431 && $1<=4811'`
— every printed selector must start `.anime-`. If ANY non-`.anime-` selector
appears in that range, STOP (the block isn't cleanly bounded).
Then: `grep -rl "class.*anime-" web/src` — must return **no** host files (only
`modules/core/library/**` may use these classes).

- Create `modules/core/library/library.css`. Move `styles.css:4431-4811`
  (the `/* === MAL anime page clone === */` block through `.anime-recs-row`,
  ending just before `/* === Overlay-host capture HUD === */` at `:4813`) into it
  **verbatim** — no selector edits, no reformatting.
- In `modules/core/library/index.jsx`, add `import './library.css';` alongside the
  existing imports (`:7-27`).
- Delete the moved block from `web/src/styles.css`.

**Verify**:
- `npm --prefix web run build` → exit 0.
- `wc -l web/src/styles.css` → ~4552 (dropped ~380).
- `grep -c "anime-alt-titles" web/src/styles.css` → 0;
  `grep -c "anime-alt-titles" modules/core/library/library.css` → 1.
- **Manual visual check (mandatory — CSS regressions are silent, no test catches
  them)**: `npm run tauri dev`, open Library → an anime series detail page and the
  discovery detail page. The alt-titles, histogram, status bars, info list, and
  recommendations row must render **identical** to before the move. State the
  result explicitly in your report ("anime detail + discovery detail render
  unchanged" or the specific difference).

### Step 3 (OPTIONAL — gated): move the overlay-host panel CSS

Only attempt if you want the second slice AND the gate passes. The overlay panels
(`styles.css:4813-4932`) are host-scoped and one is already borrowed
cross-module.

**Gate grep**: `grep -rn "capture-hud\|ov-studio\|ov-scrim" modules web/src` —
confirm these classes are used ONLY in `web/src/overlays/**`. If any *module*
(under `modules/`) uses them, STOP — moving them would break that module's borrow.

If the gate passes: move `styles.css:4813-4932` into a new
`web/src/overlays/overlays.css`, import it from `web/src/overlays/OverlayHostView.jsx`
(the overlay-host entry — verify it's the mount point first), delete the block
from `styles.css`, and re-run the Step-2 verify pattern (build + `wc -l` +
**manual visual check of the overlay Capture HUD, Studio panel, and Scrim panel**
in a live overlay). If anything about the overlay host's mount/import is
uncertain, SKIP this step — it's optional and the anime slice already proves the
pattern.

## Test plan

- There is **no automated test** for CSS placement — the verification is the build
  (proves the sheet still parses and is imported) plus the **manual visual check**
  that the moved surfaces render unchanged. This must be stated explicitly, per
  repo convention (a task is done when verified or explicitly "not verified
  because…").
- No new unit tests are written; this plan adds a doc and relocates CSS.

## Done criteria

- [ ] `CONVENTIONS.md` exists at repo root with the CSS/persistence/data/notification
      rules + the follow-up straggler checklist.
- [ ] `npm --prefix web run build` exits 0.
- [ ] `modules/core/library/library.css` exists; `modules/core/library/index.jsx`
      imports it; `grep -c "anime-" web/src/styles.css` returns 0.
- [ ] `wc -l web/src/styles.css` is ~380 lines smaller than before.
- [ ] Manual: anime detail + discovery detail pages render unchanged (recorded in
      the report).
- [ ] No raw-`localStorage`, notification, or api-wrapper call was changed (`git
      diff` touches only the four in-scope files, + overlay files if Step 3 ran).
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live code at the cited lines (drift).
- The Step-2 pre-move grep finds a **non-`.anime-` selector** inside 4431-4811, or a
  **host file** using an `.anime-*` class — the block isn't cleanly module-owned.
- The Step-3 gate finds a **module** (under `modules/`) depending on
  `capture-hud`/`ov-studio`/`ov-scrim` — cross-module CSS borrow; do not move it.
- The manual visual check shows ANY rendering difference on a moved surface — the
  move dropped a selector or changed cascade order. Report the exact difference.
- You find yourself tempted to also migrate `localStorage`/toast calls "while
  you're here" — that's the deferred sweep; it is out of scope. Add it to the
  `CONVENTIONS.md` checklist instead.

## Maintenance notes

- **The doc is the durable output.** The anime-CSS move is a proof-of-pattern; the
  real value is the next person having a rule to point at when a module's styles
  start piling into `styles.css` again. A reviewer should check that new modules'
  PRs ship a `<module>.css`, not additions to the host sheet.
- **The straggler sweep is a real follow-up plan**, not vapor: the 43-key
  `localStorage` reconciliation and the `Toast.`/`showToast`/`toast(` → `notify`
  collapse each want their own scoped plan (do them a few files at a time, each
  with a manual smoke, since both are silent-regression-prone). The checklist in
  `CONVENTIONS.md` is the input to those plans.
- **Overlay CSS is the sharp edge**: the overlay host reuses module chrome by
  importing module CSS (`stt.css`). Any future overlay-CSS reorg must keep that
  borrow working — the overlay webview has no container/`useSidebarOrder` context,
  so it legitimately breaks several host assumptions.
- **Deliberately deferred**: this plan does not touch the `vault.endpoint`
  deprecation or consolidate the 5 module-owned api.js wrappers — both are named in
  the doc as standing conventions but their enforcement sweep is future work.
