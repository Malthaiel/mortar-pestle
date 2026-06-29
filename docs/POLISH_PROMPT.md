# Polish prompt — Mortar & Pestle web app

Reusable prompt template to spin up a new agent for a polish pass on the Mortar & Pestle web UI.

**How to use:** open Claude Code (or a new agent session) inside `C:\Users\malth\Code\mortar-pestle\`, fill in the `<target>` block at the bottom, then copy everything below the `---` into the session.

---

You are polishing a surface of the Mortar & Pestle web app at `C:\Users\malth\Code\mortar-pestle\`. Stack: React 18 + Vite (`web/`) rendered in a Tauri 2 desktop webview (Rust backend in `src-tauri/`; no separate web server). Dev surface: `npm run tauri dev` — Vite HMR propagates edits live to the running window.

## Required reading

Before touching any code, read `docs/DESIGN.md` in full. It captures the design-language reference: tokens, primitives, pattern recipes, motion timings, anti-patterns. Every visual decision in this polish pass should trace back to it.

## Process (light-touch)

1. Read `docs/DESIGN.md`.
2. Read the `<target>` block below.
3. If the target leaves a load-bearing detail ambiguous (which file, which behavior, what "done" looks like), ask 1–2 clarifying questions via `AskUserQuestion` — multiple choice, recommendation first. If the target is clear, proceed.
4. Polish per the decision order in `DESIGN.md`: **token → primitive → pattern → anti-pattern check**. Never hard-code a color, size, or font literal — use `var(--*)` or `color-mix(in oklch, ${accent} N%, ...)`. Reach for a shared primitive (`Dot`, `IconBtn`, `HeaderChip`, `Seg`, `FilterChip`, `SectionHeader`, `EmptyState`, `LoadingState`) before writing inline styles. When a primitive doesn't fit, paste-and-adapt a recipe from §Patterns.
5. Run `npm run build` inside `web/`. Confirm the build is clean.
6. Summarize: files changed, the new bundle filename from the build (`dist/assets/index-*.js`), what the user should verify in-browser, anything you deferred.

## Boundaries

- **Visual polish only.** Don't change behavior. Don't refactor adjacent code. Don't add dependencies.
- **CLI has no browser.** Visual confirmation in-browser is the user's job; state this explicitly in your summary.
- **No depth selectors, no vault logging.** This is out-of-vault work; the Citadel logging protocol does not apply.
- **Don't touch the Rust backend unless the target explicitly names it.** The backend lives at `src-tauri/`; the polish target is almost always under `web/src/` or `modules/`.

## What the user values (the brand, in shorthand)

- Modern, smooth, elegant — minimal where it counts.
- Restraint over density: hide secondary controls behind hover or a contextual flag (panel-open, drag-active, has-content).
- Hairline borders, dim accent fills via `color-mix`, sweep-style visualizations over ticks/numerals, 9px mono uppercase captions over icon labels.
- Motion stays under 240ms. Multi-property reveals run in lockstep with deliberately staggered durations (e.g. `max-height 200ms ease, opacity 160ms ease, margin-top 200ms ease`).

## Target

<target>

### Surface(s) to polish
<!-- file path(s), route, or feature name.
     Examples:
       - web/src/components/SkillsRunner.jsx — the run-output panel
       - /tools/video — the whole route
       - the modal that opens from the sidebar's "+ New" button
-->



### What I want
<!-- the feel, the bar, or the specific change. As prescriptive or as open-ended as you want.
     Examples:
       - bring the run-output panel up to the DESIGN.md bar — current status uses raw colored text instead of Dot+caption
       - the empty state on /tools/video reads as broken; make it feel intentional like the EmptyState pattern in DESIGN.md
       - I want the album view to feel like the music player at the bottom of the dock — slim, hover-revealed extras, accent-tinted hover states
-->



### Out of scope / don't touch
<!-- behaviors to preserve, files to leave alone, polish to skip.
     Examples:
       - don't change the skill list on the left — that's already polished
       - don't touch the audio playback logic in MusicPlayerProvider; visual polish only
       - leave the keyboard shortcuts unchanged
-->



### Notes
<!-- anything else: prior conversations, screenshots paths, links, edge cases, regressions to watch for. Freeform. -->



</target>
