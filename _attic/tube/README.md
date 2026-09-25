# Planner tube — archived 2026-09-20

The planner's calendar lid from 2026-09-08 to 2026-09-20: ONE closed circuit of
tube drawn as a single stroke — a ring round the dial, down the right spout,
round the open calendar, back up the left spout — with liquid that poured along
it as the calendar opened and chased the pointer while it was open. Removed at
Malthaiel's direction, kept here intact in case it is ever wanted again.

Nothing imports this folder. Vite never bundles it and `scripts/verify.mjs`
never scans it (that script walks two named `modules/` dirs plus a hardcoded
file list). **Reviving any of it means copying the file back into `web/src/`,
not importing across this boundary.**

## Files

| File | Was | Lines |
|---|---|---|
| `tube.js` | `web/src/util/tube.js` — the shared geometry: one path plus the three junctions MEASURED off it | 129 |
| `TubePanel.jsx` | `web/src/components/settings/TubePanel.jsx` — the Settings → Dev toy, two fixed rings you pour by hand | 189 |
| `PlannerDock-tube-excerpt.jsx` | the two blocks cut out of `modules/core/planner/PlannerDock.jsx` — the rAF pour machinery and the overlay svg | — |

## What else changed when it left

The tube's wall WAS the dial's third ring: ring 3 stopped painting itself on
2026-09-09 because the tube drew that band on top of it. With the tube gone the
stroke was handed back to `DualRingRect.jsx` (`transparent` →
`var(--clock-stroke-bg)` on the groove path). **Putting the tube back means
taking it away again**, or the band is painted twice.

The pour also reserved room round the calendar rows — `--planner-pour-clear`,
written by the dock off `home.proud` — and that clearance went with it. The
calendar now wears a plain static frame in `styles.css` instead. `home.proud`
and `--planner-pour-r` stayed: the calendar's slab alignment and its corner
radius are still measured the same way.

The calendar's open/close CLICK was on the tube's own stroke as well as the
dial's band. Only the dial's end survives, and it always worked on its own.

## Not committed at the time of removal

The removal was made in a dirty working tree and was NOT committed in the same
turn, so `git log` does not mark the boundary. The last commit before it is
`c5adbd8`; the tube's own code is in every commit before that.
