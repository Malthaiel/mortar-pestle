# FoldMenu — archived 2026-09-11

The app's dropdown from 2026-08-05 to 2026-09-11: a candy button that unfolds into
its own rows on a real 180° hinge, over a backing "paper" that measures the rows
every frame rather than predicting them. Removed from the app at Malthaiel's
direction — *"i put a lot of work into it but it just doesn't really work that
well in the app"* — and kept here intact in case it is ever wanted again.

Nothing imports this folder. Vite never bundles it and `scripts/verify.mjs` never
scans it (that script walks two named `modules/` dirs plus a hardcoded file list).
**Reviving any of it means copying the file back into `web/src/`, not importing
across this boundary** — an import from `_attic/` would put all 1436 lines back in
the shipped bundle.

## Files

| File | Was | Lines |
|---|---|---|
| `FoldMenu.jsx` | `web/src/components/ui/FoldMenu.jsx` | 1078 |
| `FoldPaper.jsx` | `web/src/components/ui/FoldPaper.jsx` | 358 |
| `FoldDownPanel.jsx` | `web/src/components/settings/FoldDownPanel.jsx` — the Settings → Dev demo, two menus differing only in `up` | 74 |

`FoldMenu.jsx` also exported `FoldStandOff` (the neighbour-cramp wrapper hosts used
to reserve travel for an open fold), `FOLD_PAD`, `FOLD_DUR` and `FOLD_PERSPECTIVE`.

## Where it was plugged in

Removal commit: see `git log -- web/src/components/ui/FoldMenu.jsx` (last commit
before removal: `9c93c4a`). Each site's pre-fold state, for reference:

| Call site | What it was before the fold | Pre-fold sha |
|---|---|---|
| `web/src/context-menu/ContextMenuRoot.jsx` | flat portal panel, inline-styled | `7caa97a^` |
| `web/src/components/TitleBar.jsx` (account chip) | `Popover` + `useAnchoredRect`, with an avatar / name / `@handle` header | `e2037ce^` |
| `modules/core/library/VideoControls.jsx` (4 pickers) | `CandySelect direction="up"` | `bc37825^` |
| `modules/core/library/music/AlbumBrowser.jsx` (status + sort) | pill row with `onPillClick` | `9c93c4a^` |
| `web/src/components/ui/ResizeSeam.jsx` (`SeamFold`) | a hand-rolled pill list in the since-deleted `SidebarSeam.jsx` | — |
| `web/src/components/settings/DevTab.jsx` | n/a, the demo host | — |

## Why it was removed

Not the motion — that was signed off and should not be re-tuned (see the
`FoldMenu Paper` plan in the content vault). The grammar:

1. The open stack is `position: absolute` and the root is one row tall, so every
   host had to reserve travel for it. `FoldStandOff` existed only for that, and the
   music filter bar needed `position: relative; z-index: 1` so an open fold painted
   over the tiles instead of behind them.
2. Every pane had to be exactly one row tall. The account menu lost its identity
   header to this; the right-click menu lost its section-title rows.
3. A cursor-anchored fold needed a per-frame `offsetTop` read just to sit where it
   was asked to, because the paper's settle is animated.

## If you revive it

Read `FoldPaper.jsx`'s header first. Its whole point is that the paper **measures**
the rows' real rects every frame instead of restating where they will be — the
previous version predicted the fold with a hand-fitted curve plus four correction
terms and cost four chats of tuning. Do not reintroduce a constant there.
