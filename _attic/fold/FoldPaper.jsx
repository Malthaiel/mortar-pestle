// FoldPaper — the surface a FoldMenu unfolds onto.
//
// It MEASURES the rows every frame and sits a fixed halo outside them. It does
// not predict them. The previous version did: it sized itself to an integer row
// count that stepped on a timer, eased with a hand-fitted cubic chosen to
// imitate the cosine of a rotating row, plus a swing allowance, a two-frame hold
// on one edge, and four `up`-only correction terms. The rows rotate
// continuously on their own clock, so that panel could only ever be tuned to be
// wrong less often — it cost four chats and never matched between directions.
// A rect on a rotated element is already the painted, transformed box: the
// browser has done the fold maths, so ask it.
//
// Consequences worth knowing:
//   - the halo is exactly PAD on every frame, by construction, not by tuning;
//   - the two directions are the same code, mirrored by the compositor;
//   - changing the FOLD's timing needs no change here at all. The paper follows
//     whatever the rows actually do.
//
// The saga this replaces is recorded in `FoldMenu Up Close Handoff.md` at the
// Citadel root, and in git history before this file existed.
import { useLayoutEffect, useRef } from 'react';
import { postAudit } from '../../util/auditBridge.js';

// ---------------------------------------------------------------------------
// Knobs. This is the whole tunable surface of the background.
// ---------------------------------------------------------------------------

// The gap between the buttons and the paper's edge. All four sides, both
// directions. Exported because the HOST has to make room for it — the trigger's
// neighbours have no idea a surface is about to appear around it.
export const FOLD_PAD = 6;

// How long that gap takes to appear at the start of an open, and to close at
// the end of a close. The gap is the only thing here on a clock; the extent is
// measured.
const RAMP = 150;

// How many 60fps frames BEFORE the fold's handover the halo finishes closing.
// At 0 the paper reads as fully folded on the handover's own last frame, which
// he called too late — user-directed 2026-08-07, "i want the paper to visually
// get fully folded about 3 frames earlier within both foldmenus", then two more
// on top after looking. One number, both directions, because there is only one
// code path.
const LAND_EARLY = 5;
const FRAME = 1000 / 60;

// cubic-bezier(0.33, 1, 0.68, 1) and cubic-bezier(0.32, 0, 0.67, 0) — the same
// two curves the old panel ran, written as functions because this drives on a
// frame loop rather than a CSS transition.
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeIn = (p) => p ** 3;

// The rows' own curve: cubic-bezier(0.42, 0, 0.58, 1), i.e. the `ease-in-out`
// keyword their CSS transition used to name. SOLVED, not approximated — the
// obvious quad ease is visibly different through the middle of a fold and this
// fold's feel is signed off. y(t) collapses to smoothstep for these control
// points; only x(t) needs inverting, and 20 bisections is exact to well under a
// pixel of rotation.
const easeInOut = (p) => {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let t = p;
  for (let i = 0; i < 20; i += 1) {
    t = (lo + hi) / 2;
    const u = 1 - t;
    const x = 3 * u * u * t * 0.42 + 3 * u * t * t * 0.58 + t * t * t;
    if (x < p) lo = t; else hi = t;
  }
  return t * t * (3 - 2 * t);
};

// A row's depth lip as it is painted RIGHT NOW, in px, foreshortened by however
// far the row has rotated. `.candy-btn`'s lip is `box-shadow: 0 <depth> 0`, and
// getComputedStyle reports the live interpolated shadow mid-transition, so this
// follows a lip easing away rather than assuming the resting one. Negative on
// the `up` fold (FoldMenu negates --cbtn-depth there), hence the abs.
//
// The foreshortening is the row's own: a rect on a rotated element is already
// projected, so the ratio against its layout height is the same factor the
// browser applied to the box — and the shadow rotates with the box.
const liveLip = (el, r) => {
  const m = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(getComputedStyle(el).boxShadow);
  if (!m) return 0;
  const h = el.offsetHeight;
  return Math.abs(parseFloat(m[2])) * (h > 0 ? Math.min(1, r.height / h) : 1);
};

// Dump every frame's edges to web/.audit/main.json for measurement. Open the
// LEFT chip then the RIGHT one in Settings → Dev; one pass leaves both traces.
const PROBE = false;

/**
 * The transition string the HOST needs. The trigger's neighbours stand off by
 * FOLD_PAD while the menu is open, and they have to move on the same clock the
 * halo does or the two drift against each other.
 */
export const paperT = (open, shutMs) => (open
  ? `${RAMP}ms cubic-bezier(0.33, 1, 0.68, 1) 0ms`
  : `${RAMP}ms cubic-bezier(0.32, 0, 0.67, 0) ${Math.max(0, shutMs - RAMP)}ms`);

/**
 * @param {boolean} open     the menu's own state, set in the click handler
 * @param {boolean} shown    kept true until the close has finished PLAYING
 * @param {boolean} up       the fold is mirrored; see the frame conversion below
 * @param {object}  groupRef the element the rows live in — the frame everything
 *   is measured in, and the element that carries the settle
 * @param {object}  rowsRef  ref to an ARRAY of the row buttons
 * @param {number}  lip      the row's depth lip in px, measured off the trigger
 * @param {number}  shutMs   when the fold's handover happens
 * @param {object}  frameRef ref to the ancestor a HOST may be transforming (the
 *   suck-to-cursor close scales FoldMenu's root). Its transform is switched off
 *   for the length of each measurement; see the note in the loop.
 */
export default function FoldPaper({ open, shown, up, groupRef, rowsRef, lip, shutMs, hingeDur, frameRef }) {
  const ref = useRef(null);
  // The fold's own t0, reset ONLY by `open`. The measuring effect below restarts
  // on `lip` and `shutMs` too, and a restart mid-fold would rewind every row to
  // the top of its swing — the halo can afford that, the rotation cannot.
  const foldT0 = useRef(0);
  useLayoutEffect(() => { foldT0.current = performance.now(); }, [open]);

  // Layout, not plain, effect: it runs in the same commit as the click, so the
  // first frame of an open is already measured rather than one frame stale.
  useLayoutEffect(() => {
    if (!shown) return undefined;
    // The paper's OWN shadow band, read off the same global the shadow itself
    // uses so the two can never disagree. Settings → Appearance → Press & depth
    // rewrites it (0 / 2 / 4 / 7), hence a read rather than a constant.
    const surf = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--candy-surface-depth')) || 0;
    const t0 = performance.now();
    const samples = [];
    let raf = 0;
    let last = '';

    const tick = () => {
      // Scheduled FIRST, so no single bad frame can end the loop. It can: React
      // detaches a row's ref during a commit and reattaches it after this
      // effect runs, so a frame that lands mid-commit sees an empty stack. A
      // `return` before this line leaves the paper dead at zero size in the
      // corner for the rest of the session — which is exactly what it did.
      raf = requestAnimationFrame(tick);
      const el = ref.current;
      const group = groupRef.current;
      if (!el || !group) return;
      const t = performance.now() - t0;

      // THE ROWS, ON THIS LOOP'S CLOCK. Each hinge publishes `--hinge: <target
      // angle> <delay>` (see FoldMenu's hinge()); the start is the other side of
      // the same flip. Written here, before anything is measured, so the rect
      // read a few lines down is of a row this callback just placed — the paper
      // and the rows cannot come apart, at any frame rate, by construction.
      // They used to: the rotation was a compositor transition that kept
      // advancing while this loop was starved. See hinge() for the photographs.
      if (hingeDur) {
        const ft = performance.now() - foldT0.current;
        for (const el of group.querySelectorAll('*')) {
          const spec = el.style.getPropertyValue('--hinge');
          if (!spec) continue;
          const [target, delay] = spec.trim().split(/\s+/).map(Number);
          const from = 180 - target;
          const p2 = Math.min(1, Math.max(0, (ft - delay) / hingeDur));
          const deg = from + (target - from) * easeInOut(p2);
          el.style.transform = `rotateX(${deg}deg) translateZ(-1px)`;
        }
      }

      // The halo. Grows from the click on an open; on a close it runs its RAMP
      // so as to LAND on `shutMs - LAND_EARLY frames` — written as its own end
      // minus its own length, so the leg can never be pushed past the handover
      // where nothing is painted any more.
      const land = shutMs - LAND_EARLY * FRAME;
      const p = open
        ? easeOut(Math.min(1, t / RAMP))
        : 1 - easeIn(Math.min(1, Math.max(0, (t - (land - RAMP)) / RAMP)));
      const h = FOLD_PAD * p;

      // MEASURE WITH THE ANCESTOR'S TRANSFORM OFF.
      //
      // Every number below is a screen rect converted into the group's own
      // LOCAL px, and that conversion is only valid while nothing above the
      // group is transformed. The suck-to-cursor close breaks exactly that: it
      // scales FoldMenu's root, so the rects shrink while the insets written at
      // the bottom stay local, and past a point the scale term overtakes the
      // fold term and the paper REVERSES — probed 2026-08-21, bottom inset
      // climbed 36 -> 145px and then walked back to 96px while the rows were
      // still folding. Reported as "the background of the fold menu stops
      // compacting".
      //
      // Dividing by a measured scale was tried first and is NOT enough: it can
      // only undo a uniform scale (a rect is the axis-aligned bounding box of
      // the transformed box, so a rotated non-uniform scale is unrecoverable),
      // and it still left `g.height` below in polluted units. Clearing the
      // transform for the length of the measurement is exact for ANY transform,
      // which is what lets the suck keep its directional squash.
      //
      // Invisible: this runs inside one rAF callback, so the style is back
      // before the frame is painted. Costs a second forced layout on a subtree
      // that is already being measured 4-6 times a frame.
      const frame = frameRef && frameRef.current;
      const savedT = frame ? frame.style.transform : '';
      if (savedT) frame.style.transform = 'none';
      try {
      // Measure. `g` is the group's own border box — its layout height, which
      // does not change as the rows fold, so it is a stable frame to measure in.
      const g = group.getBoundingClientRect();
      let near = Infinity;
      let far = -Infinity;
      for (const b of rowsRef.current) {
        // isConnected, not just null: `items` can shrink under a fold that is
        // already in flight, leaving a detached button in the array whose rect
        // is all zeros — which would drag the union back to the group's origin.
        if (!b || !b.isConnected) continue;
        const r = b.getBoundingClientRect();
        // THE ONE PLACE `up` EXISTS as geometry. The group is mirrored by a
        // scaleY(-1) (see UP_FLIP in FoldMenu), so screen-down is the group's
        // local UP. Converting here means every number below is the down fold's,
        // and comes out mirrored for free.
        // Each row's OWN lip folds into its OWN extent, rather than one
        // allowance applied to whichever row happens to own the edge. A rect
        // excludes box-shadow, and a row DROPS its lip as its fold begins — so
        // an allowance attached to the edge jumps a whole lip the frame the edge
        // changes hands. That is why `down` was unsteady on an open while `up`
        // was not: up's lip side is row 0, which never gives up the edge and
        // never drops its lip, while down's is the far edge, which passes from
        // row 0 (lip on) to a folding row (lip already gone). Per-row, the max
        // is continuous and neither direction can jump.
        const lp = liveLip(b, r);
        const a = (up ? g.bottom - r.bottom : r.top - g.top) - (up ? lp : 0);
        const z = (up ? g.bottom - r.top : r.bottom - g.top) + (up ? 0 : lp);
        if (a < near) near = a;
        if (z > far) far = z;
      }
      if (!Number.isFinite(near)) return;

      // A rect does not include box-shadow, and a row's depth lip IS a shadow.
      // It lands on whichever side the lips point, which is PAINT and does not
      // mirror: FoldMenu negates --cbtn-depth on the rows precisely so they keep
      // lighting from above after the flip, which points them at the group's
      // local TOP on `up` and its local BOTTOM on `down`.
      //
      // The paper's own band rides that SAME side (see the boxShadow below), so
      // the paper's visible edge there is its box plus `surf`. That surplus is
      // invisible while the halo is out — it sits under the last row's own lip —
      // but at the end of a close there is no row below row 0 to hide it, and it
      // stood 4px proud after the other three edges had gone: "the top, left and
      // right sides are already non-visible but the bottom still is",
      // user-reported 2026-08-07. So the allowance eases from the full lip at
      // rest (which is the resting spacing he signed off) down to `lip - surf`
      // as the halo closes, which puts the band's own end exactly on row 0's lip
      // — derived, for ANY depth setting, not tuned.
      //
      // The lip is MEASURED off the row that actually defines this edge, not
      // taken as a constant, because a closing row DROPS its lip (FoldMenu sets
      // --cbtn-depth to 0 per row as its fold begins) and a paper still holding
      // room for a lip that is no longer painted stands a whole depth too far
      // out: "when the folding/closing animation happens the buttons are fully
      // pressed as they come up which means that there is too much space in
      // between", 2026-08-07. `.boxShadow` reports the LIVE interpolated value
      // mid-transition, which --cbtn-depth does not (an unregistered custom
      // property jumps; the box-shadow built from it eases).
      // The paper's own band rides the lip side too (see the boxShadow below),
      // so its visible edge there is its box plus `surf`. Pulling the box in by
      // that much as the halo closes lands the band exactly on row 0's lip
      // instead of standing proud of it — derived for ANY depth setting.
      //
      // CLOSING ONLY. On an OPEN the same term fires at the START, where it
      // dragged the paper a whole `surf` INSIDE the rows and then let go:
      // measured 1.02 -> 4.69 on down, -4.00 -> -0.16 on up over the first
      // 100ms. "it doesnt maintain a consistent gap like the closing one does",
      // 2026-08-07.
      const tuck = open ? 0 : surf * (1 - p);
      if (up) near += tuck; else far -= tuck;

      // Four insets, one number each. The sides do not follow the rows: a row
      // draws fractionally wider than its hinge under perspective, and tracking
      // that reads as the paper shimmering. It is always the full width.
      // ponytail: sides pinned to the group. If rows ever get their own widths,
      // measure them the same way the vertical pair is measured.
      const next = `${near - h}|${g.height - (far + h)}|${-h}`;
      if (next !== last) {
        last = next;
        el.style.top = `${near - h}px`;
        el.style.bottom = `${g.height - (far + h)}px`;
        el.style.left = `${-h}px`;
        el.style.right = `${-h}px`;
        // The group gives the halo back so the paper's near edge stays put on
        // screen — in the titlebar there are only 6px of bar above the chip, so
        // a paper that grew upward would clip off the window. Driven off the
        // SAME `h`, so the two cancel by construction instead of by two clocks
        // agreeing. Layout is applied before the flip, hence the sign.
        group.style.setProperty('--fold-settle', `${(up ? -1 : 1) * h}px`);
      }

      if (PROBE) {
        // `wide` is how far the widest row reaches past the group's own box —
        // the sides are pinned to the group, so anything positive here is a row
        // drawing outside the paper.
        let wide = 0;
        for (const b of rowsRef.current) {
          if (!b || !b.isConnected) continue;
          const r = b.getBoundingClientRect();
          wide = Math.max(wide, r.right - g.right, g.left - r.left);
        }
        samples.push({
          t: Math.round(t),
          near: +near.toFixed(2),
          far: +far.toFixed(2),
          h: +h.toFixed(2),
          tuck: +tuck.toFixed(2),
          wide: +wide.toFixed(2),
        });
      }
      } finally {
        // Always, including the early return above: leaving the transform off
        // would freeze the suck on whatever frame threw.
        if (savedT) frame.style.transform = savedT;
      }
      // Keeps running for as long as the menu is shown, not just while it moves.
      // ponytail: 4-6 rect reads a frame while a dropdown sits open. Deliberate
      // — it means a label arriving late (an async display name) re-fits the
      // paper with no extra machinery. Gate it on movement if it ever costs.
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      if (PROBE && samples.length) {
        // Separate keys per direction so a close cannot overwrite its own open.
        postAudit((up ? 'foldUp' : 'foldDown') + (open ? 'Open' : ''),
          { open, lip, shutMs, samples });
      }
    };
  }, [open, shown, up, lip, shutMs, hingeDur, groupRef, rowsRef]);

  return (
    <div
      ref={ref}
      className="candy-modal"
      aria-hidden="true"
      style={{
        position: 'absolute', zIndex: -1, pointerEvents: 'none',
        // .candy-modal's own box-shadow MINUS its --shadow-card leg — the soft
        // blur every floating panel casts. This is not a panel hovering over the
        // page, it is the trigger's own paper, and a blur under it reads as a
        // second surface. The two flat candy bands stay.
        // Negated under the flip for the same reason the rows negate their lip:
        // a downward band mirrored would light the paper from underneath.
        boxShadow: [
          `0 ${up ? 'calc(var(--candy-surface-depth) * -1)' : 'var(--candy-surface-depth)'} 0 -2px var(--surface-3)`,
          `0 ${up ? 'calc(var(--candy-surface-depth) * -1)' : 'var(--candy-surface-depth)'} 0 0 var(--border-2)`,
        ].join(', '),
      }}
    />
  );
}
