# Plan 029: Resolve the three-way reduced-motion contradiction

> **Executor instructions**: This is a DECISION plan. It has a human-decision
> STOP gate BEFORE any code change. Do Step 1 (verify + surface the decision),
> then STOP and get the maintainer's ruling on which surface wins. Only after
> that do you run exactly ONE of the two branches in Step 2. Do not touch
> `web/src/styles.css` before the ruling. Run every verification. Update the
> `plans/README.md` status row if that file exists.
>
> **Drift check (run first)**:
> `git -C . diff --stat 57a6c80..HEAD -- web/src/styles.css web/src/hooks/useSettings.js`
> If either file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S (the code change is a few lines either way; the cost is the decision, not the diff)
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction / decision
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Three authoritative surfaces disagree about whether Mortar & Pestle honors
`prefers-reduced-motion`, and the code sits in the middle half-following each.
The product brief still promises full reduced-motion support; a later decision
doc reverses that product-wide; and the CSS still ships one live orphan
`@media (prefers-reduced-motion: reduce)` rule that neither surface accounts for.
Nobody can answer "does this app honor reduced motion?" without hitting a
contradiction. This plan makes the code internally consistent with a single
chosen source of truth and flags the out-of-repo doc that the maintainer must
reconcile. It is small, but leaving it unresolved means every future motion
feature re-litigates the same question.

## Current state

The three surfaces (all read first-hand; the two vault docs are quoted here
because they live OUTSIDE this repo and you cannot open them):

1. **PRODUCT.md (living, authoritative product brief)** — still promises support.
   `Knowledge/Mortar & Pestle/Reference/PRODUCT.md:107`:
   > Honor `prefers-reduced-motion`. Disable theme-change transitions, custom
   > radial-clock animation, and every non-essential motion when the user opts
   > out. The reduced-motion build must remain fully usable and aesthetically
   > intact — not a stripped-down fallback.
   And immediately above it, `PRODUCT.md:106`, a still-standing commitment:
   > WCAG AA color contrast in every theme (light, dark, future variants).
   (PRODUCT.md lives in the Citadel content vault, not this repo. You cannot edit
   it as part of this plan.)

2. **The reversing decision doc** — `App vault ›
   Mortar & Pestle/Decisions/2026-05-21 Drop Reduced-Motion Support.md` (also
   outside this repo; quoted so this plan is self-contained). Its ruling:
   > As of 2026-05-21, [the app] ships without `prefers-reduced-motion` opt-out
   > behavior. Motion is a load-bearing brand attribute, not a configurable
   > preference.
   Its "Consequences" claim the code was cleaned up:
   > `web/src/hooks/useSettings.js`: removed `reduceMotion` useMemo +
   > `data-reduce-motion` dataset write + dependency entry.
   > `web/src/styles.css`: removed the `:root[data-reduce-motion='1']` rule block
   > that disabled all transitions + animations.
   Its "Reversibility" note gives the ~8-line re-add recipe (verbatim):
   > 1. Re-add `reduceMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false, [])` to `useSettings.js`.
   > 2. Re-add `root.dataset.reduceMotion = reduceMotion ? '1' : '0'` in the useEffect + add `reduceMotion` to the deps array.
   > 3. Re-add `:root[data-reduce-motion='1'] * { transition: none !important; animation: none !important; }` to `styles.css`.

3. **The code** — half-followed the ADR:
   - `web/src/hooks/useSettings.js` — the ADR was applied here: the file has
     **zero** reduced-motion references. Its only `matchMedia` use is
     `prefers-color-scheme` (`useSettings.js:675,678`, `useResolvedTheme`). No
     `reduceMotion`, no `data-reduce-motion`. Confirmed by reading the full file.
   - `web/src/styles.css:450-452` — but this LIVE orphan survived. It is the only
     `prefers-reduced-motion` occurrence in the stylesheet (a repo-wide grep of
     the file returns exactly this one block):
     ```css
     @media (prefers-reduced-motion: reduce) {
       .dock-root .candy-btn[data-shape="icon"], .dock-btn-label { transition: none; }
     }
     ```
     The ADR's cleanup removed a *different* rule (`:root[data-reduce-motion='1'] *`);
     this dock-specific `@media` query was added separately and was never swept.
     So the app today DOES still partially honor reduced motion — just for two
     dock selectors — which matches neither the ADR (which says drop it entirely)
     nor PRODUCT.md (which says honor it everywhere, not just the dock).

**Recommendation (maintainer's call to confirm):** align to the ADR — it is the
later decision, its rationale is strong ("motion is load-bearing brand"), and the
code already leans that way (`useSettings.js` is fully cleaned). That means
**deleting the `styles.css:450-452` orphan**. But this is explicitly a decision
for the maintainer (see STOP), because PRODUCT.md is marked "living /
authoritative" and technically outranks a decision doc on paper.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Confirm the orphan | `git -C . grep -n "prefers-reduced-motion" web/src/styles.css` | exactly one hit at line ~450 |
| Confirm useSettings is clean | `git -C . grep -ni "reduce-motion\|reduceMotion\|reduced-motion" web/src/hooks/useSettings.js` | no matches |
| Dev run (visual sanity) | `npm run tauri dev` | Vite 127.0.0.1:5173 + desktop window |

## Scope

**In scope** (the ONLY repo file you may modify, and only after the ruling):
- `web/src/styles.css` — either delete the `:450-452` block (ADR branch) or
  extend reduced-motion coverage (PRODUCT branch). One or the other, not both.
- `web/src/hooks/useSettings.js` — ONLY in the PRODUCT branch (re-add the ~8-line
  hook per the ADR's reversibility recipe).

**Out of scope** (do NOT touch):
- `PRODUCT.md` and the decision doc. They live in the Citadel vault, a **separate
  repo you do not have**. Reconciling them (so the losing surface stops claiming
  the opposite) is a maintainer follow-up — flag it, do not attempt it.
- The WCAG-AA contrast commitment (`PRODUCT.md:106`) — unaffected by motion;
  leave it alone.
- Any broader motion/animation refactor. This plan touches reduced-motion only.

## Steps

### Step 1: Verify state and surface the decision — then STOP

Run the two grep commands above and confirm: exactly one `prefers-reduced-motion`
block in `styles.css` at ~450, and zero reduced-motion refs in `useSettings.js`.
Report the confirmed state to the maintainer with the two branches below and the
recommendation (align to the ADR → delete the orphan). **Do not edit any file
yet.** Wait for the ruling on which surface wins.

**Verify**: you have posted the confirmed current state + the two branches, and
received an explicit "ADR wins" or "PRODUCT wins" decision. Absent a decision,
this plan is blocked (that is the correct state — see STOP).

### Step 2: Apply the chosen branch (exactly one)

**Branch A — ADR wins (recommended): delete the orphan.**
Remove the entire block at `web/src/styles.css:450-452`:
```css
@media (prefers-reduced-motion: reduce) {
  .dock-root .candy-btn[data-shape="icon"], .dock-btn-label { transition: none; }
}
```
Nothing else references it; deleting it makes the CSS consistent with the ADR and
with the already-clean `useSettings.js`. Leave a one-line note in the PR
description that PRODUCT.md:107 must be updated by the maintainer to match.

**Verify (Branch A)**:
`git -C . grep -n "prefers-reduced-motion" web/src/styles.css` → **no matches**.
`npm run tauri dev` boots; the dock still behaves normally.

**Branch B — PRODUCT wins: restore full support.**
Follow the ADR's own reversibility recipe (it is the sanctioned re-add path):
1. `useSettings.js`: add
   `const reduceMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false, []);`
2. In the existing root-dataset `useEffect` (the one at
   `useSettings.js:809-838` that sets `root.dataset.theme` etc.), add
   `root.dataset.reduceMotion = reduceMotion ? '1' : '0';` and add `reduceMotion`
   to that effect's dependency array.
3. `styles.css`: add the blanket rule
   `:root[data-reduce-motion='1'] * { transition: none !important; animation: none !important; }`
   and KEEP (or fold in) the existing dock `@media` block.

**Verify (Branch B)**:
`git -C . grep -ni "reduceMotion" web/src/hooks/useSettings.js` → matches in the
memo, the dataset write, and the deps array.
`npm run tauri dev` boots; toggling OS reduced-motion suppresses transitions.

## Done criteria

Machine-checkable. ALL that apply to the CHOSEN branch must hold:

- [ ] Exactly one branch was applied; the other file is untouched.
- [ ] Branch A: `git -C . grep -n "prefers-reduced-motion" web/src/styles.css`
      returns nothing; `useSettings.js` unchanged.
- [ ] Branch B: `useSettings.js` has the memo + dataset write + deps entry;
      `styles.css` has the `:root[data-reduce-motion='1']` rule.
- [ ] `npm run tauri dev` boots without console errors.
- [ ] The PR description flags the out-of-repo doc reconciliation the maintainer
      must do (update PRODUCT.md:107 for Branch A, or re-affirm it for Branch B,
      and the decision doc's "Consequences" either way).
- [ ] `plans/README.md` status row updated (only if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- **No maintainer ruling yet.** This is the primary gate. Which surface wins
  (the "living" PRODUCT brief vs. the later decision doc) is a human product
  decision. Do NOT pick for them by editing code. Blocked-pending-decision is
  the correct resting state.
- The `styles.css:450-452` excerpt no longer matches, or the grep returns more
  than one `prefers-reduced-motion` hit (the surface changed — the "single
  orphan" premise is void).
- `useSettings.js` turns out to already contain reduced-motion code (the ADR was
  reverted without updating this plan) — report before doing anything.

## Maintenance notes

- Whichever branch lands, the losing doc surface still lies until the maintainer
  edits it. The repo change alone does NOT close the contradiction — it only
  makes the *code* pick a side. Track the doc edit separately.
- A reviewer should confirm exactly one branch was applied and that no unrelated
  motion CSS was swept in (this plan is deliberately narrow: one CSS block, and
  in Branch B one hook).
- If Branch A lands and compliance pressure later forces reduced-motion back, the
  ADR's reversibility recipe (Branch B here) is the re-add path — it is small by
  design.
