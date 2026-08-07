// FoldMenu — the app's dropdown. A candy button that unfolds into its own menu
// rows like a letter, and folds back into itself.
//
// This is FoldPanel (the Dev tab "Fold" toy) generalized from its hardcoded
// three rectangles to any number of rows. The motion, the timings, and every
// trap it encodes are carried over unchanged — at three rows this produced
// byte-identical choreography to the toy. Do not re-tune it here; that motion
// is signed off. The toy itself was DELETED 2026-08-06 (user-directed), so this
// file is now the only fold implementation; recover
// `web/src/components/settings/FoldPanel.jsx` from git history if the reference
// choreography ever needs re-reading.
//
// The toy was allowed to hardcode its skin because it WAS the account chip: it
// measured `.titlebar-account`, and its rectangles wore plain `.candy-btn` with
// the full 7px `--candy-depth`. Nothing here may hardcode any of that. Every
// row wears the TRIGGER's own class and shape, and the gap, the hinge pivot and
// the lip are all read off the trigger's computed `--cbtn-depth` — a `chip` is
// pinned to `--candy-depth-small` (5px, styles.css `.candy-btn[data-shape="chip"]`),
// so a hardcoded 7px turns the paper heavier than the button that became it and
// hangs the pivot half a lip out.
//
// Structure: row 0 never moves and everything folds onto it. Rows 1..n-1 live
// in nested preserve-3d wrappers, wrapper j carrying rows j+1..n-1, so folding
// wrapper j carries every row below it as one piece. n rows means n-1 hinges.
import { Children, useEffect, useRef, useState } from 'react';

// Camera distance. The article's 500 was sized for a 300px-tall image; against
// 28px rows it sits far too close and the taper (the near edge of a folding
// flap draws wider than its hinge) reads as the rows changing shape. Pulling
// the camera back flattens the taper without killing the fold.
// taper% = PERSPECTIVE / (PERSPECTIVE - rowHeight) — recompute if rows get tall.
const PERSPECTIVE = 2000;

// One fold. One number for both directions and both orientations; there is no
// second duration anywhere below.
//
// THE TOY WAS THE REFERENCE. `FoldPanel` (the Dev tab "Fold" toy, deleted
// 2026-08-06 — in git history only) was the signed-off motion, and at three
// rows this file reproduces it beat for beat. Anything measured here is
// measured against that, not against a symmetry argument.
//
// A mirror rule lived here for part of 2026-08-05 — the close rewritten as the
// open played backwards, which deleted three close-only beats: the bottom row's
// squash, the one-`press`-early lip drop, and the close's extra `press` of
// spread (plus a shorter UP_DUR, which stays dead — direction never changes the
// clock). All three are BACK, same day, user-directed: "literally just copy and
// paste that one into the dropdown". The close is not the open reversed. It
// opens with a compaction — squash, lip, then rotate — and the toy has always
// read that way. Do not re-derive the mirror; it was tried and rejected.
//
// ease-in-out is symmetric, so edge-on sits at exactly DUR/2 in both
// directions, which is what lets every `flipped` swap below use one
// expression. A curve that is NOT symmetric silently drifts them.
const DUR = 300;
// Fallback for the candy face's ease-down; the live value is read from
// --cbtn-press-dur on mount, since Settings → Animations rewrites it.
const PRESS_FALLBACK = 70;
// Used only until the trigger is measured; every shape pins its own lip.
const DEPTH_FALLBACK = 'var(--candy-depth)';
// Beat the two states cross-fade over on OPEN. Close hard-cuts instead.
const SETTLE = 120;

// One frame at 60fps. The panel's BOTTOM edge is delayed by TWO of these on a
// close, user-directed 2026-08-06: "the bottom gets sucked in faster than the
// left, right, and top of the bg. delay the bottom by like a frame" — then "still
// slightly fast" at one frame, so it went to two.
//
// It is the bottom ALONE because the bottom is the only edge the browser derives
// from TWO interpolated properties — it is `top` plus `height`, where the other
// three are one property each. The delay goes on the `height` leg, and the leg is
// shortened by the same amount so it still LANDS on SHUT: a plain delay would
// push the tail past the handover, where the group's hard opacity cut chops
// whatever is left mid-movement. Start a frame later, finish together.
//
// A 1.5px allowance on `padLip` was tried for this first and is gone. It worked
// by leaving the bottom permanently short of its target, which is a different
// thing wearing the same clothes — it never fully closed, it just closed less.
const FRAME = 1000 / 60;

// How far the backing panel sits outside the rows on every side once open.
// Exported because the HOST has to make room for it: the trigger's neighbours
// have no idea a panel is about to appear around it, and on the titlebar there
// is only an 8px gap to the icons either side and 6px of bar above the chip.
// The open stack slides DOWN by this much for the same reason — the panel's top
// edge would otherwise land above the titlebar and clip off-screen.
export const FOLD_PAD = 6;

// How far child `i` of a standoff block travels while the fold is open, in px.
//
// A block with no seam (a lone bell) has nothing to give and just slides the
// whole pad. Otherwise the block's FAR edge is PINNED and its own seams absorb
// the standoff: the child nearest the fold walks the full FOLD_PAD away, the
// child at the far end does not move at all, and everything between is spread
// evenly — which closes each seam by exactly FOLD_PAD / seams.
//
// Why pin the far edge: a plain block-wide translate is only right when the
// block has room to move INTO. The titlebar's three window controls sit against
// the window edge, so translating them ate the strip's own 8px padding — with
// the account fold open, panel-to-Minimize measured 8px while Close-to-edge
// measured 2px, the whole block shoved into the corner. Measured 2026-08-05.
const standOffShift = (dir, i, seams) => {
  if (seams <= 0) return dir * FOLD_PAD;
  return dir > 0 ? FOLD_PAD * (1 - i / seams) : -FOLD_PAD * (i / seams);
};

/**
 * The standoff a host owes a fold's NEIGHBOURS. Wraps the block of buttons that
 * sits beside the trigger, in place of the plain flex `<span>` it would
 * otherwise be. `dir` is -1 for a block on the fold's left, +1 for one on its
 * right; `t` is the panel's OWN transition string, handed to the host by
 * onOpenChange, so the neighbours and the panel edge are one movement rather
 * than two that agree. The seam count is read off the children.
 *
 * TRANSFORMS ONLY, and that is not an optimisation — it is the feature. The
 * first build animated the flex `gap` (plus a margin to hold the block's layout
 * width) and Malthaiel called the result janky on sight: `gap` is a LAYOUT
 * property, so the browser re-solves the strip every frame and rounds each seam
 * to a whole pixel, which walks 8px -> 5px in about three visible steps instead
 * of gliding. A transform is composited, takes subpixels, and never touches
 * layout — so the cluster cannot reflow and the trigger cannot be dragged
 * sideways mid-fold either, which is what the compensating margin was for.
 *
 * Each child gets its OWN wrapper rather than the transform being cloned onto
 * the button: a candy button's press and hover states are transforms too, and
 * an inline one on the button itself would outrank them and kill the press for
 * as long as the menu is open.
 */
export function FoldStandOff({ dir, open, t, gap = 8, children, ...rest }) {
  const kids = Children.toArray(children);
  const seams = kids.length - 1;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap }} {...rest}>
      {kids.map((kid, i) => (
        <span
          key={kid.key ?? i}
          style={{
            display: 'inline-flex',
            transform: `translateX(${open ? standOffShift(dir, i, seams) : 0}px)`,
            transition: t ? `transform ${t}` : undefined,
          }}
        >{kid}</span>
      ))}
    </span>
  );
}

// .candy-btn's OWN colour transitions, restated verbatim. An inline
// `transition` replaces the class's whole list, so a hinge that only declares
// its transform leg strips these and the button's colours snap.
//
// All FOUR legs, not just box-shadow: dropping `selected` mid-close fades the
// accent out through `color`, `background` and `border-color` as well as the
// depth band, and a row carrying an inline hinge (the innermost one, and the
// trigger) would otherwise keep only the band's ease and hard-cut its face.
const BAND_T = ['color', 'background', 'border-color', 'box-shadow']
  .map((p) => `${p} 150ms cubic-bezier(0, 0, 0.58, 1)`).join(', ');

// The account chip's face text, resolved through all three rules that reach it:
// base .candy-face (mono, --text-muted), [data-shape="chip"] (600, no uppercase),
// then .titlebar-account (11.5px, no letter-spacing). Shared by the trigger and
// every row so the swap changes no glyph.
// NOT optional: without it the rows fall back to stock .candy-face — 11px, weight
// 700, letter-spacing 0.08em, text-transform uppercase — and read ACCOUNT
// SETTINGS in a fold whose trigger reads Malthaiel.
const CHIP_TEXT = {
  fontSize: 11.5,
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  letterSpacing: 0,
  textTransform: 'none',
};

/**
 * @param {{label: string, onClick: function}[]} items  menu rows, top to bottom
 * @param {React.ReactNode} children  the trigger's face content — reused verbatim
 *   on row 1's underside, which is the one face left showing when shut, so the
 *   swap back to the real button changes no glyph
 */
export default function FoldMenu({
  items,
  children,
  rowH = 28,
  triggerClassName = '',
  triggerTitle,
  shape = 'chip',
  faceStyle,
  ariaLabel = 'Menu',
  // Fold UPWARD instead of down — for a trigger in a bottom bar, where a
  // downward stack would unfold off the bottom of the window. Row 0 still lands
  // on the trigger's exact footprint; everything else mirrors about it.
  //
  // It is the SAME fold, scaled -1 in Y about row 0's centre — one flip on the
  // group, not a mirrored set of rules. Nothing else in this file branches on
  // it except the two things that are paint rather than geometry (glyphs and
  // depth). See UP_FLIP for why, and for what the five-branch version cost.
  up = false,
  // Index of the row holding the current value, or -1 for a command menu with
  // no selection (the titlebar account menu). Wears the app's standard
  // `is-active` accent fill, same as any other selected candy button.
  selected = -1,
  // Told whenever the fold opens or shuts, and handed the panel's own CSS
  // transition string. The host needs BOTH: the panel appears FOLD_PAD outside
  // the trigger on every side, into space the trigger's neighbours are sitting
  // in, and a host that moves them on a clock of its own drifts against the
  // fold. Passing the real string is what keeps them one motion.
  onOpenChange,
  style,
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const [press, setPress] = useState(PRESS_FALLBACK);
  // The row's resting lip, read off the live trigger. See the header note: this
  // is per-shape and cannot be assumed to be --candy-depth.
  const [depth, setDepth] = useState(DEPTH_FALLBACK);
  // Every rectangle takes an EXPLICIT width and height measured off the real
  // trigger, exactly as the toy measures the account chip. A percentage width in
  // a self-sizing grid instead lets the rows set the column and the trigger
  // stretch to them, which silently widens the button that already exists.
  const triggerRef = useRef(null);
  const [box, setBox] = useState({ w: 160, h: rowH });
  // The panel's own shadow band, read off the same global the shadow itself uses
  // so the two can never disagree. Settings → Appearance → Press & depth rewrites
  // it (0 / 2 / 4 / 7), hence a read rather than a constant. See `padLip`.
  const [surf, setSurf] = useState(4);
  useEffect(() => {
    const d = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--cbtn-press-dur'));
    if (d > 0) setPress(d);
    const s = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--candy-surface-depth'));
    if (s >= 0) setSurf(s);
    const el = triggerRef.current;
    if (!el) return undefined;
    // Re-measured, not read once on mount. The trigger shrink-wraps its own
    // content and that content ARRIVES LATE — the account chip paints "Account"
    // until an async profile fetch hands it a display name, and an avatar image
    // has no size until it loads. A single mount read locks the rows to the
    // placeholder width and they never catch up, so the paper is narrower than
    // the button it came out of. The toy cannot hit this: it measures a chip on
    // another surface that settled long before the Dev tab mounted.
    const read = () => {
      const r = el.getBoundingClientRect();
      if (r.width) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
      const cd = getComputedStyle(el).getPropertyValue('--cbtn-depth').trim();
      if (cd) setDepth(cd);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowH]);

  // Gap between neighbouring rows, as marginTop: the depth lip plus air. The lip
  // part is not optional — the rows are candy buttons, lip included, and a lip is
  // a DOWNWARD box-shadow living outside layout, so any gap shorter than it
  // leaves it overhanging the row below. Built from the MEASURED lip, so it
  // tracks Settings → Appearance → Depth and the row's own shape alike.
  const GAP_V = `${depth} + 4px`;
  const GAP = `calc(${GAP_V})`;

  // The pivot sits at the MIDDLE of the space between neighbours, not on a row's
  // own top edge — rotating about the edge lands the flap a whole GAP off its
  // target. Half of it makes the fold symmetric about the boundary.
  //
  // ONE value, both directions. `up` does not move this pivot, or the gap side,
  // or the stacking order — see UP_FLIP.
  const HINGE_Y = `calc((${GAP_V}) / -2)`;

  // UP is the DOWN fold, turned upside down. Nothing below branches on it.
  //
  // It used to: `up` moved the hinge pivot to the flap's bottom, moved the gap
  // to marginBottom, laid every preserve-3d wrapper out column-reverse, and
  // pinned the group and the panel by `bottom` instead of `top` — five parallel
  // rules that had to be kept in step with a close that was tuned entirely
  // against `down`. They were not, and could not be: every beat added to the
  // close (the hug/tuck split, the group settle, the bottom-edge frame delay)
  // was a beat somebody had to re-derive by hand for the other direction.
  // User-directed 2026-08-06, after the mirrored close came out wrong: "mirror
  // it 1-1 but just flip it upside down".
  //
  // So the geometry is mirrored ONCE, here, by the compositor: the whole open
  // group is scaled -1 in Y about ROW 0's CENTRE, which is the one point that
  // must not move (row 0 lands on the trigger's exact footprint in both
  // directions). Every fold, every clock and every panel leg below is the
  // down-fold's, unchanged, and comes out mirrored for free.
  //
  // Two things do NOT want mirroring, and both are PAINT rather than geometry:
  //
  //   1. glyphs — flipped text is unreadable, so each label counter-flips (see
  //      `label`). Row 1's underside already counter-flips for its own 180deg
  //      rotation, so under UP_FLIP the two cancel and it takes none.
  //   2. depth — a candy lip and the panel's own band are DOWNWARD shadows, and
  //      a press slides the face DOWN. Mirrored they would light every row from
  //      below. Both ride --cbtn-depth (styles.css: the box-shadow AND the
  //      :active translateY), so negating that one value on the rows puts the
  //      band and the press back the right way up after the flip — see row().
  //      The panel restates its own band, so it negates there.
  const UP_FLIP = up ? {
    transform: 'scaleY(-1)',
    transformOrigin: `50% ${box.h / 2}px`,
  } : null;

  const hinge = (deg, delay) => ({
    transform: `rotateX(${deg}deg) translateZ(-1px)`,
    transformOrigin: `center ${HINGE_Y}`,
    transition: `transform ${DUR}ms ease-in-out ${delay}ms, ${BAND_T}`,
    willChange: 'transform',
  });

  const n = items.length;
  const hinges = Math.max(0, n - 1);
  const last = hinges - 1;                 // innermost wrapper index

  // Fold start times, indexed by wrapper (0 = outermost, `last` = innermost).
  //
  // Closing runs innermost-first, opening runs outermost-first. The SPREADS
  // differ on purpose and this is the toy's own schedule, not a bug: closing
  // spreads over `press + DUR`, opening over `DUR`. At two hinges that is the
  // toy exactly — closing, the flap goes at `press` and the pair at
  // `2 * press + DUR`; opening, the pair at `press` and the flap at
  // `press + DUR`. The extra press closing is the beat the compaction (squash,
  // then lip) plays into before the outer fold takes the stack away.
  const closeAt = (j) => (last < 1 ? press : press + ((last - j) / last) * (press + DUR));
  const openAt = (j) => (last < 1 ? press : press + (j / last) * DUR);

  // Hand-over instant: the outermost fold is the last to finish, so this is when
  // the real candy button takes back over. EVERY close timing derives from it,
  // so they cannot drift apart.
  const SHUT = closeAt(0) + DUR;

  // Backing panel geometry. `depth` is a CSS length string off the live trigger
  // ('5px' on a chip), or the raw var() fallback before the first measure —
  // parseFloat gives NaN there, hence the 7px floor (--candy-depth's value).
  const dpx = parseFloat(depth) || 7;
  // HALF a fold, not a whole one — and that is geometry, not taste.
  //
  // A fold is a ROTATION, so what a row PAINTS is its own height times cos of
  // the hinge angle. The angle passes 90deg at exactly DUR / 2 (ease-in-out is
  // symmetric), and at 90deg the row paints zero pixels: the stack has already
  // reached its final extent halfway through the fold, and the rest of the
  // rotation only carries the row on over the one above it. A panel easing over
  // the full DUR is therefore half a fold behind for every single fold —
  // user-reported 2026-08-05, "doesn't collapse fast enough".
  //
  // Opening is the same statement backwards: a row paints nothing until it
  // passes edge-on, then grows over the SECOND half of its fold. So the panel
  // waits out the first half and runs the second. Running from the fold's start
  // instead put the surface a full half-fold ahead of any visible row.
  //
  // Delay is the OUTERMOST hinge's, since wrapper 0 is the fold that swings the
  // whole lower block and so defines how far the menu reaches. It has to match
  // the FIRST height step exactly, or the panel goes wide before it goes tall.
  //
  // BOTH directions carry the + DUR / 2, closing included. Closing, the pad
  // legs used to fire at `closeAt(0)` and land DUR / 2 before the fold did, so
  // the paper above row 0 was sucked in while the rows were still visibly
  // rotating — user-reported 2026-08-06, "at frame 192 the top part of the bg
  // starts to compact too early for my liking". Started half a fold later they
  // land exactly on SHUT, with the rest of the handover.
  //
  // Closing they also take the HEIGHT leg's own curve rather than ease-in-out,
  // and this is the same statement a third time: ease-in-out spends its whole
  // duration moving, so 6px of pad crawled in over 150ms beside a 28px height
  // that stalls and then drops in the last handful of frames — "it collapses too
  // slow horizontally compared to how fast it collapses vertically", 2026-08-06.
  // One curve on both is what makes them one speed; it also holds the pad out
  // until the very end, which is the "even later" half of the same report.
  // Opening keeps ease-in-out: nothing there was reported and that motion is
  // signed off.
  //
  // Closing it is an EIGHTH of a fold, not a half — "i want the top to still be
  // a bit later", 2026-08-06, twice, after the curve alone and then a quarter
  // fold were both still too early. This is about the floor: at 37ms the pad has
  // barely three frames to cross and anything shorter simply snaps. The delay is
  // written as its own end minus its own length, so the leg lands on SHUT by
  // construction: it can never be pushed past the handover, where the group is
  // already hidden and the rest of the motion would simply not be painted.
  //
  // OPENING it is the mirror of the close's TUCK, and it is the HALO's clock,
  // not the row extent's. The two used to share one: the pad and the first
  // height step both fired at `openAt(0) + DUR / 2` = 220ms, so for the first
  // 220ms of an open there was a stack fading in over a panel still at exactly
  // the trigger's rectangle — and that rectangle sits behind row 0's own opaque
  // face, so there was no visible surface at all. User-reported 2026-08-06,
  // "the opening unfolding animation background doesnt appear instantly after
  // clicking the button". The close answers this with two beats (hug then
  // tuck); the open now has its two, in mirror order — halo FIRST, from `press`,
  // so a surface exists the moment the button's press lands, then the row extent
  // on its own `+ DUR / 2` clock so it can never outrun a visible row.
  //
  // The `+ DUR / 2` on the ROW EXTENT is untouched and must stay: a row paints
  // nothing until it passes edge-on, so extent that starts with the fold runs
  // half a fold ahead of anything visible ("during the unfold the bg expands too
  // fast", 2026-08-05). Only the halo moved.
  const panelD = open ? DUR / 2 : DUR / 8;
  const panelT = `${panelD}ms `
    + `${open ? 'ease-in-out' : 'cubic-bezier(0.32, 0, 0.67, 0)'} `
    + `${open ? press : SHUT - panelD}ms`;
  // The GROUP's own FOLD_PAD settle — the stack sits a pad low while open so the
  // panel's top edge lands on the trigger's line, and it has to give that back by
  // the time the fold ends. On panelT (37ms starting at SHUT - 37) the whole 6px
  // happened in two frames after everything else had finished, which reads as the
  // compacted button teleporting home: user-directed 2026-08-06, "the move looks
  // quite jagid… i want the entire thing to be moving up as it goes DURING the
  // folding animation". Over the last half fold instead it is nine frames, and it
  // lands on SHUT with the handover.
  //
  // It cannot start EARLIER than the tuck, and that is a hard constraint, not
  // caution: the panel's top pad is measured from the stack, so a group that has
  // already slid up while the pad is still out puts the panel's top edge above the
  // trigger's own line — and in the titlebar there are only 6px of bar above it,
  // so it clips off the top of the window. Started with the tuck the two cancel:
  // the pad shrinks as the group rises and the top edge only ever moves DOWN,
  // toward the button (base + 0 → base + 3 → base + 0 at 4 rows).
  //
  // Opening keeps panelT, where it cancels against the panel's own pinned-edge
  // leg. Only this leg changed; `panelT` still goes to the host (FoldStandOff
  // slides the neighbouring titlebar controls on it), so the standoff's clock is
  // untouched — moving it too would start the neighbours back while the panel is
  // still a pad wider than the trigger, and slide them under it.
  const groupT = open ? panelT : `${DUR / 2}ms ease-in-out ${SHUT - DUR / 2}ms`;

  // The innermost row's SQUASH, the toy's `down`. Closing, that row is pressed
  // on frame one and released at `press` — which is exactly when its own fold
  // starts, so the compaction runs a beat AHEAD of the rotation and is legible
  // while the stack is still flat.
  //
  // Squash-before-fold rather than squash-during is load-bearing, not taste: a
  // pressed face is slid DOWN --cbtn-depth inside its own button, and the fold
  // rotates that button 180deg, flipping the slide upward — so a row still held
  // at the moment it lands puts its face a full depth above its target. Released
  // before its own fold begins, it is always at rest when it lands.
  const [down, setDown] = useState(false);

  // How many rows are folded away RIGHT NOW, so the backing panel can shrink in
  // step with the stack instead of on one clock of its own.
  //
  // The panel used to run its whole height change on wrapper 0's transition. At
  // three rows that is 440ms -> 740ms closing, while the stack loses its bottom
  // row between 70 and 370 — so for the first 440ms the panel sat at full height
  // under a stack that was already a row shorter, then dumped two rows of height
  // in one leg. User-reported 2026-08-05: "the bg doesn't collapse alongside the
  // buttons perfectly."
  //
  // A single transition cannot follow a STAGED collapse, so the panel is driven
  // by the same per-fold timers the lips and the face swaps already use: each
  // fold takes exactly its own row off the height, over its own DUR. Set to an
  // absolute count rather than incremented, so an interrupted fold cannot leave
  // the panel counting from the wrong number.
  const [folded, setFolded] = useState(hinges);
  // A close's last leg is TWO beats:
  //
  //   1. hug   `closeAt(0)` → + DUR / 2 — the stack's own extent, down to row 0's
  //            rectangle plus its halo. Half a fold because a row paints
  //            rowH * cos(angle), which hits zero at half its fold.
  //   2. tuck  → + DUR / 2 — the 6px halo goes, all four sides at once, landing on
  //            SHUT. This is the LAST VISIBLE frame of the panel, so it has to be
  //            the one that lands on the handover.
  //
  // A third beat lived here for part of 2026-08-06 — a `suck` that took row 0's
  // bare rectangle to nothing at the button's centre, which cost the tuck half its
  // length (DUR / 4 each) and ended the halo at SHUT - DUR / 4. It is DELETED, and
  // it is not a taste call: that rectangle is flush with row 0 and its own shadow
  // band ends exactly on row 0's lip (see `padLip`), so row 0's opaque face covers
  // every pixel of it and the beat was invisible. All it did was end the visible
  // collapse five frames early — user-reported 2026-08-06, "the 3 other sides
  // compact 5 frames too early… its been a thing this entire time". Anything that
  // wants to animate that bare rectangle has to do it BEFORE the halo closes or
  // after the handover, and after the handover nothing is painted.
  //
  // The two beats are SEQUENTIAL for a reason that outlived the third: run the
  // halo and a height-to-zero together and the height falls from 41px to 0 while
  // the width only comes in 12px, so the panel drops below the chip's own height
  // at barely a third of the leg while still 6px wider than it on each side — top
  // and bottom tuck behind the chip, the sides do not, and two rounded ears sit
  // either side of the shut button ("sides are sticking out", same day). Speed is
  // NOT the lever: giving the pad its own faster clock fixes the ears and reads as
  // the sides closing quicker than the top, which is the uneven collapse reported
  // one round earlier.
  //
  // `folded` reaching `hinges` only takes the panel down to row 0's own rectangle;
  // beats 2 and 3 take that rectangle away. The three used to be one instant, and
  // that was a real bug: `folded`
  // lands on `hinges` at `closeAt(0)`, the outermost fold's START, and the height
  // read `vis === 1 ? 0 : …` off it — so the panel dumped TWO rows of height in
  // the one leg whose fold only removes ONE, at double the stack's speed, and the
  // `vis === 1` height was never painted in a close at all. It was gone half a
  // fold before the rotation finished: "it visually fully closes before the
  // folding animation is fully done", 2026-08-06. An earlier pass measured the
  // collapse against the panel's BOX and called it on time, which it was — the
  // last of the paper IS row 0's rectangle, so it sits behind the button and the
  // flush box hides an already-swallowed surface. Split in two, each beat is half
  // a fold: the stack's own extent for the first half, then the halo tuck for the
  // second, landing on SHUT with the rest of the handover.
  // Starts TRUE, which is not a quirk: it reads as "the panel is collapsed", and
  // at rest it is. `padOn` hangs off it, so a false here would pad the panel out
  // while it is hidden and the very first open would start from a box wider than
  // the trigger and pop.
  const [tuck, setTuck] = useState(true);
  // Rows the panel still has to cover. Clamped, because `items` can change
  // length under a fold that is already mid-flight.
  const vis = Math.max(1, n - Math.min(folded, hinges));
  // The FOLD_PAD border — it appears once, as the menu opens, not once per row.
  // Opening it rides `folded`, whose outermost step is the instant the panel
  // starts covering more than row 0. A one-row menu has no hinge to hang either
  // on, so it falls back to the open flag.
  //
  // BOTH directions ride `tuck` now, which is the same statement twice: the pad
  // is one beat of its own at each end of the motion, LAST out on a close and
  // FIRST in on an open. Opening it used to ride `folded`, whose outermost step
  // is the first height step, so the halo and the row extent arrived in the same
  // instant and the first 220ms of an open painted nothing (see panelT). Now
  // `tuck` drops at `press` and the halo grows on the panelT beat that ends
  // exactly where the extent begins.
  //
  // CLOSING it rides `tuck`, i.e. it survives the whole staged collapse and goes
  // in its own beat right before the height, not half a fold before it — see the
  // two beats on `tuck`. The halo is the only part of
  // this panel that is ever VISIBLE at the end of a close: from the outermost
  // fold's edge-on frame the paper is down to row 0's own rectangle, sitting
  // behind row 0's own button, so a panel with no pad left is a panel you cannot
  // see. Dropped at the fold's START instead (`folded < hinges`, tried
  // 2026-08-06) the surface went invisible half a fold early even though the box
  // measured flush to the last frame — "doesnt land with the fold now. sucked in
  // too early". Both halves of the pad move on this one flag, which is also what
  // keeps the old "ears of surplus width poking out of the shut button" bug dead:
  // the pad and the height reach zero on the same frame, so neither can outlive
  // the other.
  const padOn = hinges ? !tuck : open;
  //
  // Per-wrapper lip state. A candy lip is a DOWNWARD box-shadow, so a row
  // rotated 180deg points its lip UP and stacks a whole depth of shadow above
  // whatever it lands on — the other half of landing flush, and invisible to a
  // box measurement (the boxes land dead flush; only the paint sits high).
  const [lips, setLips] = useState(() => Array(hinges).fill(true));
  // Which wrappers are past edge-on, so the row inside each can swap its face.
  const [flipped, setFlipped] = useState(() => Array(hinges).fill(false));

  useEffect(() => {
    if (!hinges) return undefined;
    const t = [];
    const at = (ms, fn) => t.push(setTimeout(fn, ms));
    const setAt = (setter, j, v) => setter((prev) => {
      const nx = prev.slice(); nx[j] = v; return nx;
    });

    if (open) {
      setDown(false);
      // The halo beat, and the mirror of the close's tuck. At `press`, not at
      // frame one: the pad's own legs carry no CSS delay, so this timer IS their
      // start, and it has to land on the same instant panelT's delay does or the
      // sides and the pinned edge come apart. Before this the pad waited for
      // `folded`, half a fold later — see padOn.
      at(press, () => setTuck(false));
      for (let j = 0; j < hinges; j += 1) {

        // Lips return per row, each as its own unfold FINISHES — never during,
        // or the lip grows back while the row is still rotating.
        at(openAt(j) + DUR, () => setAt(setLips, j, true));
        // At the EDGE-ON frame, not at the fold's start. Before edge-on the row
        // is still rotated past 90deg and paints nothing new — it is lying on
        // the row above — so a panel that starts growing at the fold's start
        // runs a full half-fold ahead of anything visible. User-reported
        // 2026-08-05: "during the unfold the bg expands too fast."
        // LEAD, and it is measured, not taste. The step fires at the edge-on
        // frame and the panel then EASES into the new size over DUR / 2, while
        // the row that just crossed edge-on is already painting — so for that
        // leg the surface is catching up to a row that is ahead of it.
        // Measured off a 60fps capture 2026-08-06, four rows, mid-open: rows
        // painting to y=941 with the panel's full-width edge at y=937, against
        // a settled halo of 7px. User-reported on BOTH directions, "the buttons
        // are ahead of the background when opening rather than being inside of
        // it".
        //
        // Two frames is the overshoot expressed on the leg's own clock: 8px of
        // an out-cubic 37px step is about 22% of it, and 22% of DUR / 2 is 33ms.
        // It is a LEAD on the step, NOT a longer leg — stretching the leg is the
        // move this file rejects everywhere else, because it fixes the average
        // speed and breaks the shape. Only the height step leads; the face swap
        // stays on the true edge-on frame, where a swap is invisible.
        at(openAt(j) + DUR / 2 - 2 * FRAME, () => setFolded(hinges - 1 - j));
        // Swapped at the edge-on frame: mid-fold the row is rotated 90deg and
        // paints zero pixels tall, so an instant swap there cannot be seen. A
        // cross-fade instead blooms a ghost word on a face-up row.
        at(openAt(j) + DUR / 2, () => setAt(setFlipped, j, false));
      }
    } else {
      setDown(true);                                  // squash, then release at
      at(press, () => setDown(false));                // the innermost fold start
      for (let j = 0; j < hinges; j += 1) {
        // The INNERMOST row drops its lip as its own fold begins. Every wrapper
        // above it drops one `press` EARLY — held flat for a beat first, the
        // collapse is legible; dropped at the start of its own fold instead it
        // happens while the row is already rotating and cannot be read at all.
        // That early beat is the toy's, and it is the pair's whole compaction
        // cue, since only the innermost row squashes.
        at(closeAt(j) - (j === last ? 0 : press), () => setAt(setLips, j, false));
        at(closeAt(j), () => setFolded(hinges - j));
        at(closeAt(j) + DUR / 2, () => setAt(setFlipped, j, true));
      }
      // Beat 2 starts exactly where the outermost fold goes edge-on, which is
      // where the stack stops reaching below row 0 and the panel has nothing left
      // to hug. Beat 3 follows it, and the two split the remaining half fold, so
      // the last one lands on SHUT by construction.
      at(closeAt(0) + DUR / 2, () => setTuck(true));
    }
    return () => t.forEach(clearTimeout);
  }, [open, press, hinges]);

  // Kept mounted for the whole close so the fold can play, then dropped. See the
  // display note on the group below.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) { setShown(true); return undefined; }
    const t = setTimeout(() => setShown(false), SHUT);
    return () => clearTimeout(t);
  }, [open, SHUT]);

  // The panel's pad is FOLD_PAD on three sides and FOLD_PAD + a lip on the
  // bottom, because the bottom row's lip is a box-shadow living outside its
  // layout box and a panel sized to the boxes alone stops short of it. That
  // asymmetry is right while the menu is OPEN and wrong the moment it collapses:
  // one shared curve moving 6px of top pad and 11px of bottom pad, against a
  // shared half-row of slide, empties the top halo at 30% of the leg and the
  // bottom at 52%, so the bottom visibly trails the top all the way in. Measured off a screenshot mid-tuck, 2026-08-06 — 5px of halo above the
  // chip against 10px below, at the same frame — reported as "doesnt close
  // evenly. the bottom is closing in slower than the top". Dropped for the close,
  // both halos are 6px and land together. Nothing is lost: the only lip left by
  // then is row 0's own, and row 0 paints it itself, over this panel.
  // It is a CONSTANT for the whole close and goes only at the handover, when the
  // height is going to zero anyway. Animating it away earlier is what made the
  // bottom edge land a frame before the other three, and the reason is that this
  // allowance is not decoration: row 0's lip paints OVER this panel, so the
  // VISIBLE bottom halo is the pad minus the lip. Held constant, the tuck moves
  // all four visible halos by the same 6px and they land together; eased out
  // during the hug (`open || vis > 1`, tried 2026-08-06) the bottom's visible
  // travel is a lip shorter than the top's 6px, so it arrives first — measured
  // off his own clip frame at 11px of halo above the chip against 9px below,
  // reported as "the bottom of the bg is slightly behind (1 frame)".
  //
  // MINUS the panel's own band, and that is the third band in this stack, not a
  // fudge. `.candy-modal`'s box-shadow paints --candy-surface-depth (4px default,
  // Settings → Appearance → Press & depth) of flat band BELOW the panel's box, so
  // the panel's visible bottom edge is its box plus that band. At a full lip
  // allowance the band still stood 4px clear of the lip when the tuck ended and
  // sat there until the handover took it — "bottom now trails by a frame", 2026-08-06,
  // one round after the opposite error. `lip - band` puts the band's own bottom
  // exactly on the lip's, so the last visible pixel of panel disappears on the
  // same frame the top halo closes. It may go NEGATIVE (a `high` surface depth of
  // 7px against a chip's 5px lip), which is correct and wants no clamp: the panel
  // simply has to end a hair above row 0's bottom for its band to hide.
  // OPEN it is the FULL lip, not `dpx - surf`, and that is a RESTING-SPACING
  // call rather than a travel one. The algebra above says the two visible halos
  // come out equal at `dpx - surf`; the pixels say otherwise. Measured at full
  // open, four rows, down direction: 6px between row 0's box and the panel's
  // top edge against 3px at the bottom — user-reported 2026-08-06 on BOTH
  // directions, "the spacing between the shortcuts button and the edge of the
  // background / the settings button and the edge of the background are uneven
  // … i want those two spacings to be applied to the opposite side of the bg".
  // In both menus the halo he likes is the one at the TOP; the short one is the
  // bottom, on the side the row's own lip paints over.
  //
  // It reverts to `dpx - surf` for the whole close, because THAT value is what
  // makes all four visible halos the same function of progress while the panel
  // tucks (see the note below, and the two measurements that pinned it). The
  // 4px handover between the two happens on frame one of the close, on the
  // height's own leg, while the height is already losing a row — nothing to see.
  const padLip = open ? dpx : (shown ? dpx - surf : 0);



  // Held in a ref so an inline arrow from the host (a new function identity
  // every render) cannot make this fire on every render — it fires only when
  // the state or the clock actually changes.
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  useEffect(() => { notify.current?.(open, panelT); }, [open, panelT]);

  // Close on Escape and on any click outside. The fold replaces the menu's
  // PAINT, not a menu's behaviour.
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // Always writes --cbtn-depth rather than adding and removing the key: React
  // only touches style keys that CHANGED, and a key that disappears takes its
  // value with it while the untouched rest of the rule stays put. The rest value
  // is the MEASURED one, not --candy-depth — writing the global here overrode
  // whatever lip the row's own shape pins and made the paper heavier than the
  // trigger it came out of.
  // Do NOT hide the rows under row 1 once they are past edge-on. It was tried
  // 2026-08-05 to fix a z-order tie at four rows (a blank back painting over
  // row 1's name) and it BROKE THE FOLD outright — reverted on sight. The tie
  // was real and is FIXED, by lifting row 1 out of the ±1 alternation — see the
  // note on its style in stack(). Nothing here needs to go invisible.
  const row = (lipOn) => ({
    width: '100%',                    // the GROUP sizes the stack — see there
    height: box.h,
    display: 'block',                 // the class is inline-flex; these stack
    // NEGATED under UP_FLIP, and that one sign covers both things this variable
    // drives in styles.css: the lip (`box-shadow: 0 var(--cbtn-depth) 0`) and
    // the press (`.candy-face { transform: translateY(var(--cbtn-depth)) }`).
    // Rendered upward inside a group that is then mirrored, both come out
    // pointing DOWN — a row keeps its own lip under it and still presses
    // downward, exactly as it does in the unflipped fold.
    '--cbtn-depth': lipOn ? (up ? `calc(${depth} * -1)` : depth) : '0px',
    // Re-armed against each wrapper's pointerEvents: 'none' — but ONLY while
    // open. An unconditional 'auto' also beats the GROUP's own open ? auto :
    // none, so the rows keep hit-testing through the whole close: the one you
    // clicked holds :hover until its own rotation carries it out from under the
    // cursor, then fades back to grey mid-flight — a flicker. Dropping to
    // 'none' at click releases the hover on frame one, while everything is
    // still flat.
    pointerEvents: open ? 'auto' : 'none',
  });

  // Grid, not the class's inline-flex, so a row can stack its two labels in one
  // cell without absolute positioning.
  const FACE = {
    ...CHIP_TEXT,
    height: '100%',
    padding: '0 8px',
    display: 'grid',
    placeItems: 'center',
    ...faceStyle,
  };
  // Counter-flips the glyphs back the right way up under UP_FLIP. It goes on
  // the LABEL, never on `.candy-face` — the face's transform slot belongs to
  // .candy-btn's :active press, and an inline one here outranks the stylesheet
  // and kills the press for every row in the fold.
  const label = {
    gridArea: '1 / 1',
    whiteSpace: 'nowrap',
    ...(up ? { transform: 'scaleY(-1)' } : null),
  };

  // Rows nest: wrapper j holds row j+1 and everything under it. The LAST row
  // gets no wrapper of its own — its hinge rides the button, exactly as the toy
  // does it (the bottom flap is a hinged button, not a hinged div around one).
  const stack = (j) => (
    <>
      {/* Every row wears the TRIGGER's own class and shape, so the paper is the
          same rectangle as the button that became it — same radius, same lip,
          same hover. The toy gets this for free by being three copies of one
          plain .candy-btn; a generalized fold has to forward it, or the shut
          state and the open state are two different buttons. */}
      <button
        type="button"
        // The accent is held only while OPEN, so it releases on frame one of the
        // close and eases out under the fold rather than riding it down and
        // hard-cutting at the handover. .candy-btn's own 150ms colour ease does
        // the work — fast, but a fade, not a cut. Restoring it is free: on open
        // the group is still at opacity 0 until `press`, so the accent arrives
        // behind the fade-in and is never seen to appear.
        // is-pressed on the innermost row only, and only for the first `press`
        // of a close — the squash. See `down`.
        className={`candy-btn ${triggerClassName}${j === selected && open ? ' is-active' : ''}${j === n - 1 && down ? ' is-pressed' : ''}`.trim()}
        data-shape={shape}
        data-own-press
        data-self-press
        aria-current={j === selected ? 'true' : undefined}
        style={j === n - 1 && j > 0
          ? { ...row(lips[j - 1]), marginTop: GAP, ...hinge(open ? 0 : 180, open ? openAt(j - 1) : closeAt(j - 1)) }
          // Row 1 is lifted clear of every other row, and this is arithmetic,
          // not a nudge. Each hinge carries translateZ(-1px), and two nested
          // 180deg rotations compose to the identity — so a row's FINAL z
          // alternates 0, +1, 0, +1 with nesting depth, and rows 1, 3, 5 all
          // resolve to the same +1. Row 1 is the only row with a back face (the
          // `j === 1` branch below); rows 3, 5 show a deliberately blank
          // underside and sit LATER in document order, so from four rows up the
          // blank one paints over the shut label for the last 150ms of the
          // close — user-reported 2026-08-05, "the final fold is blank then it
          // snaps to the malthaiel pfp", confirmed off a 60fps capture. Two and
          // three rows have no row 3 to tie with, which is why the toy (three
          // hardcoded rectangles) can never show it.
          // -2px here reads as +2 through wrapper 0's own 180deg flip, landing
          // row 1 at +3 — unreachable by the ±1 alternation at ANY row count,
          // so this holds without a per-level scheme. Do not "fix" this by
          // hiding the rows underneath: that was tried the same day and broke
          // the fold outright (see row()).
          : { ...row(j === 0 ? true : lips[j - 1]),
            ...(j === 1 ? { transform: 'translateZ(-2px)' } : null) }}
        onClick={() => { setOpen(false); items[j].onClick?.(); }}
      >
        <span className="candy-face" style={FACE}>
          {/* Row 1's UNDERSIDE is the one face left showing when shut: every
              row below folds behind it, then it flips onto row 0. So the shut
              label lives here, on the back, and it is the TRIGGER's own content
              so the swap back to the real button only adds the depth band.
              rotateX flips y only, so the counter-flip is scaleY.
              Every other row shows nothing on its back — nothing hides a
              backface, so without this the browser paints the row's own word
              straight through it, upside down, and parks it there between
              folds. Blank underside, like real folded paper. */}
          <span style={{ ...label, opacity: j > 0 && flipped[j - 1] ? 0 : 1 }}>
            {items[j].label}
          </span>
          {j === 1 && (
            <span style={{
              ...label,
              opacity: flipped[0] ? 1 : 0,
              // Two flips that cancel: this face is upside down because its row
              // is rotated 180deg, and upside down AGAIN under UP_FLIP. So the
              // counter-flip is exactly the one `label` already carries, and up
              // wants neither. Written as an override rather than left to the
              // spread, because the down direction needs it and label does not
              // carry it there.
              transform: up ? 'none' : 'scaleY(-1)',
              // gap: inherit, never a number. This span is a hand-built copy of
              // the trigger's face and the shut state swaps one for the other,
              // so any gap of its own shifts the avatar against the name at the
              // handover — it was 6 against the chip's own 8 (styles.css,
              // `.candy-face` under .titlebar-account) and the swap visibly
              // nudged. `inherit` takes whatever gap the host's face rule sets,
              // so a different host cannot reintroduce the same 2px.
              display: 'inline-flex', alignItems: 'center', gap: 'inherit',
            }}>{children}</span>
          )}
        </span>
      </button>
      {j === n - 2 && stack(j + 1)}
      {j < n - 2 && (
        <div style={{
          marginTop: GAP,
          transformStyle: 'preserve-3d',
          // A row's translateZ(-1px) puts it BEHIND this wrapper's own plane,
          // so the wrapper wins every hit test over it and the row never sees a
          // mouseenter. Nothing listens here, so make it transparent to the
          // pointer; the rows re-arm themselves in row().
          pointerEvents: 'none',
          // Rotation is driven by `open`, NOT by the flip flags — those fire at
          // the edge-on frame, half a fold late, and keying the transform to
          // them would start every fold DUR/2 behind its own delay.
          ...hinge(open ? 0 : 180, open ? openAt(j) : closeAt(j)),
        }}>
          {stack(j + 1)}
        </div>
      )}
    </>
  );

  if (!n) return null;

  return (
    // Fixed to the trigger's own height so the fold hanging below it cannot
    // stretch whatever row the trigger sits in.
    <div ref={rootRef} style={{
      display: 'grid', width: 'max-content', height: rowH,
      position: 'relative', zIndex: 130,
    }}>
      {/* Shut state. A real .candy-btn, so hover, press and depth arrive for
          free. Fades in on open, HARD-CUTS in on close: the paper's last
          visible face and this button paint different things for the length of
          any cross-fade, which reads as a flash. */}
      <button
        ref={triggerRef}
        type="button"
        className={`candy-btn ${triggerClassName}`.trim()}
        data-shape={shape}
        data-own-press
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{
          // `style` lands on BOTH states, never on the root wrapper. It carries
          // the host's optical-centring lift, and candyCenterOffset() reads
          // --cbtn-depth, which is defined on the candy button ITSELF — on a
          // wrapping div it falls back and, worse, the centring audit reads the
          // button's own `top` as 0 and flags every neighbour on the row as half
          // a band out. The fold group takes the same lift so the two states sit
          // on the same line.
          ...style,
          // No width: the trigger shrink-wraps its own content (the account chip
          // has no width of its own — it wraps the avatar plus a display name of
          // whatever length), and the rows are measured FROM it.
          gridArea: '1 / 1', alignSelf: 'start', height: rowH,
          opacity: open ? 0 : 1,
          pointerEvents: open ? 'none' : 'auto',
          // Fades in on open over SETTLE, HARD-CUTS in on close (0ms at SHUT) —
          // the toy's own handover, restored 2026-08-05. A symmetric fade was
          // tried in between and taken back out: the close's fade re-derives
          // this button out of the paper over 120ms, and against the folded
          // stack's last visible face that reads as the button re-materialising
          // rather than the paper handing back.
          //
          // The box-shadow leg is .candy-btn's own, restated verbatim: an
          // inline transition REPLACES the whole list, and dropping it leaves
          // the depth band snapping to the hover accent while the face above it
          // still eases over 150ms.
          transition: `opacity ${open ? SETTLE : 0}ms ease-in-out ${open ? press : SHUT}ms,`
            + ` ${BAND_T}`,
        }}
        {...rest}
      >
        {/* Same CHIP_TEXT and the same padding as every row, so the swap between
            the two states changes no glyph and moves nothing. Left as the
            class's own inline-flex (not FACE's grid) because the trigger holds
            an avatar beside its text, not two stacked labels. */}
        <span className="candy-face" style={{
          ...CHIP_TEXT, height: '100%', padding: '0 8px',
        }}>
          {children}
        </span>
      </button>

      {/* Open state. A DIV, not a button — the rows are real candy buttons and a
          button cannot nest inside a button. Each row closes the fold itself.
          Width must match the rows: perspective-origin defaults to the centre
          of the element that DECLARES perspective, and a wider one puts the
          vanishing point off to the right, skewing the fold sideways. */}
      <div
        role="menu"
        aria-label={ariaLabel}
        // Shut, every row is rotated 180deg onto row 0, so their layout boxes
        // genuinely coincide and the spacing audit reads a ~35px overlap. That
        // is the fold working, not a rhythm bug — opt the stack out.
        data-spacing-intent="fold"
        style={{
          ...style,                     // same lift as the trigger — see there
          // Absolute, not a grid cell. A shut fold must occupy NOTHING: the
          // stack hangs a full row below the titlebar and the spacing audit
          // reads that as the bar overrunning the page. `display: none` does
          // remove it — and BREAKS THE OPEN. A transition cannot run on an
          // element that was display:none on the previous frame, because there
          // is no start value to interpolate from, so the group's opacity
          // SNAPPED to 1 instead of easing in after `press`. The folded stack
          // was therefore fully visible from frame one while row 1 was still
          // rotated 180deg — an upside-down copy of the trigger's own face,
          // parked flat for press + DUR/2 (~350ms, twenty frames) until its
          // fold reached edge-on. Measured off a 60fps capture, 2026-08-04.
          // Out of flow instead: zero layout contribution, transitions intact.
          //
          // `top` RESTATES the host's centring lift rather than zeroing it.
          // candyCenterOffset() (util/candy.js) is {position:'relative', top:
          // calc(--cbtn-depth / -2 …)}, so `position:'absolute', top:0` after
          // the ...style spread silently overrode both halves and dropped the
          // paper half a lip below the button it replaces — a visible jump at
          // the handover. Absolute in a position:relative root starts at the
          // same static top, so the same calc reproduces the lift exactly.
          // It uses the MEASURED depth, not the raw var: --cbtn-depth is
          // declared on the candy button itself, so on this div it would fall
          // back to --candy-depth (7px) while a chip trigger lifts by 5px.
          position: 'absolute', left: 0,
          // The ONE place the direction exists — see UP_FLIP. Everything from
          // here down is written for the downward fold and mirrors for free.
          ...UP_FLIP,
          // + FOLD_PAD while open: the panel reaches FOLD_PAD above row 0, and
          // row 0 sits in a titlebar with only 6px of bar above it, so a stack
          // left at the trigger's own line puts the panel's top edge off the top
          // of the window. Sliding the whole stack down by exactly the pad lands
          // that edge back on the trigger's original top line. It is animated on
          // the panel's clock, and starts from 0, so at the handover frame the
          // paper is still dead on the button it replaced — the locked "row 1
          // lands ON the trigger" rule survives; the settle happens after.
          //
          // The settle's SIGN is the one thing UP_FLIP cannot mirror, because
          // `top` is layout and the flip is a transform — the box is placed
          // first, then mirrored, so a settle written to move the group down
          // still moves it down. Negated for up, which is the same statement it
          // always was: the panel reaches a pad PAST row 0 on the far side, and
          // the group gives that pad back toward the trigger. Flipped, the far
          // side is below, so the group slides up. `groupT` is untouched, so it
          // still cancels against the panel's own pinned-edge leg to the frame.
          //
          // The centring lift is NOT negated: UP_FLIP pivots on row 0's centre,
          // so row 0 does not move and its optical lift is the trigger's own in
          // both directions.
          top: `calc(${depth} / -2 * var(--candy-center-on, 1)`
            + ` + ${open ? (up ? -FOLD_PAD : FOLD_PAD) : 0}px)`,
          // The GROUP sets the width and the rows take 100% of it, so every row
          // is the same rectangle and perspective-origin (which defaults to the
          // centre of whatever DECLARES perspective) lands on their centre — a
          // group wider than its rows puts the vanishing point off to the right
          // and skews the fold sideways.
          //
          // max-content, floored at the trigger: rows used to be pinned to the
          // measured trigger width, so any label longer than the trigger's own
          // text overflowed its rectangle — and at the end of a close that
          // spill poked out from behind the folded flap, which is not a
          // rectangle of paper any more. The floor keeps the shut state honest:
          // while the longest label fits inside the trigger, the stack is
          // exactly the trigger's width and the handover moves nothing.
          perspective: PERSPECTIVE, width: 'max-content', minWidth: box.w,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          // Hidden only once the close has finished PLAYING, so the fold is
          // never cut off mid-flight. visibility, not display: a hidden element
          // still has a box and a computed style, so its opacity transition
          // survives the handover — see the position note above for what
          // display:none did to the open.
          visibility: shown ? 'visible' : 'hidden',
          // Mirrors the trigger's own handover exactly — fade on open, hard cut
          // on close, same clock. Any difference between these two lines is a
          // flash, so they change together or not at all.
          transition: `opacity ${open ? SETTLE : 0}ms ease-in-out ${open ? press : SHUT}ms,`
            + ` top ${groupT}`,
        }}
      >
        {/* The paper it unfolds ONTO. Without it the rows hang over whatever
            page is behind the titlebar; this gives the open menu its own
            surface. It grows out of the trigger's exact footprint and runs on
            the outermost hinge's own clock — see panelT — so it opens as one
            flap of the same fold rather than popping in whole.
            Reuses .candy-modal, the skin every other floating panel in the app
            wears (Popover's default), so this is not a new surface.
            zIndex -1 puts it under the in-flow rows: the group declares
            `perspective`, which is a stacking context, so a negative child
            paints below its non-positioned siblings and nothing else. It is
            NOT in the preserve-3d wrappers, so it takes no rotation. */}
        <div
          className="candy-modal"
          aria-hidden="true"
          style={{
            position: 'absolute', zIndex: -1, pointerEvents: 'none',
            // .candy-modal's box-shadow restated MINUS its --shadow-card leg —
            // the soft 12px/48px blur every floating panel casts. The fold is
            // not a panel hovering over the page; it is the trigger's own paper
            // unfolding on the strip, and a blur under it reads as a second
            // surface. The two flat candy bands stay, so it keeps the same
            // depth every other candy surface has. User-directed 2026-08-05.
            // NEGATED under UP_FLIP, for the same reason the rows negate their
            // --cbtn-depth: this is a downward band, and a mirrored one would
            // light the paper from underneath.
            boxShadow: `0 ${up ? 'calc(var(--candy-surface-depth) * -1)' : 'var(--candy-surface-depth)'} 0 -2px var(--surface-3),`
              + ` 0 ${up ? 'calc(var(--candy-surface-depth) * -1)' : 'var(--candy-surface-depth)'} 0 0 var(--border-2)`,
            // Shut, it is the trigger rectangle exactly — so the first frame of
            // the open has nothing to pop. The pad only appears as it grows.
            //
            // Keyed to `padOn`, NOT to `open`, and so are the width and the
            // pinned edge below: all four are the same pad, the height carries it
            // in its own `padOn` term, and closing that flag leaves at the SUCK
            // while `open` flips on frame one. Run off `open` on the panel's late
            // clock they outlived the height, and once the height had collapsed
            // all that was left was a pad of surplus width poking an ear out
            // either side of the shut button — screenshotted 2026-08-06, "i can
            // see the sides of the bg sticking out". One flag and one clock for
            // the whole pad, and they cannot come apart again.
            left: padOn ? -FOLD_PAD : 0,
            // Pinned to the same edge the stack is, so it grows the way the rows
            // do.
            //
            // `open || padOn`, so this leg is `open`-driven OPENING and
            // `padOn`-driven CLOSING, and its clock (see the transition) splits
            // the same way. Opening it must stay on panelT: it cancels against
            // the group's own FOLD_PAD slide, which runs on that clock, and any
            // difference between the two curves wobbles the panel's top edge
            // during an open that is signed off. CLOSING it must not: on panelT a
            // close delays it to `SHUT - DUR / 8`, so the pad tucked in over the
            // last two frames — invisible while the height still hit 0 at
            // `closeAt(0)`, but the moment the collapse was split in two (see
            // `tuck`) beat 1 held row 0's rectangle for half a fold with a pad of
            // pad standing above it and no sides left, screenshotted 2026-08-06:
            // "i can see the top of it poking out without the sides present".
            // Closing, all four pad edges leave together on the tuck beat.
            // Always `top`, both directions — UP_FLIP mirrors the placed box.
            //
            // The lip allowance moves to THIS edge for up, and that is not a
            // second rule, it is the same one: the allowance belongs on
            // whichever side the rows' bands point, and negating --cbtn-depth
            // (see row()) points them at the stack's local TOP. After the flip
            // it lands back under row 0, exactly where the down fold has it.
            top: open || padOn ? -(FOLD_PAD + (up ? padLip : 0)) : 0,
            width: padOn ? `calc(100% + ${FOLD_PAD * 2}px)` : '100%',
            // Sized to the rows STILL SHOWING, not to the open/shut flag — see
            // `folded`. Same rows + GAP formula the stack itself is laid out by,
            // so the panel and the paper can never disagree about a row's
            // height. + dpx: the bottom row's lip is a box-shadow living OUTSIDE
            // its layout box, so a panel sized to the boxes alone stops short.
            // The lip allowance is NOT part of the `padOn` term: it outlives the
            // tuck by a beat, so that the bottom halo's visible travel matches the
            // other three. See `padLip`.
            height: vis * box.h + (vis - 1) * (dpx + 4)
              + (padOn ? FOLD_PAD * 2 : 0) + padLip,
            // Height alone runs on its own clock with NO delay: each `folded`
            // change already fires at its own fold's start, so a delay here
            // would push every step past the fold it belongs to. The other three
            // stay on the outermost hinge's clock — they are the pad appearing,
            // and it appears once, not per row.
            //
            // Half a fold for the hug, half for the tuck — see the two beats on
            // `tuck`. One curve and one speed per beat; the ORDER is what keeps
            // the sides from outliving the height, never a faster clock for the
            // pad.
            // The CURVE
            // is the other half of matching: the row's painted height is
            // rowH * cos(angle) and the angle itself is eased, so a row barely
            // moves near edge-on and then falls off a cliff near flat. A cubic
            // tracks that within about 3px on a 28px row (0.125 against 0.119 at
            // the quarter point), where ease-in-out is nearly five times off
            // there. The two directions are exact mirrors of each other, so the
            // curves are too: in cubic closing, out cubic opening.
            // A `transform` leg rode this clock while a third beat slid the bare
            // rectangle into the button's centre; that beat is deleted (see `tuck`) and
            // the leg went with it. If one ever comes back it belongs on the HEIGHT's
            // clock, not panelT's, or the paper shrinks first and slides second.
            //
            // Stretching this leg is NOT the way to keep the surface on screen
            // longer, and it was tried first (2026-08-06, a whole DUR): the
            // average speed comes out right and the SHAPE comes out wrong, so the
            // bottom edge trails a row-width behind the rotating stack for most
            // of the leg — screenshotted the same session, "the bottom of the
            // background is lagging behind and doesnt hug the folding buttons".
            // The length is geometry: a row paints rowH * cos(angle) and hits
            // zero at half its fold, so half a fold is the only length that
            // tracks it. Add BEATS, never duration — see `tuck`.
            // The pinned edge is the ONE leg that changes clock with direction:
            // panelT opening (it has to cancel the group's slide), the pad's own
            // clock closing (or it tucks in two frames before the handover) — see
            // the value above.
            transition: (open ? [`top ${panelT}`] : [])
              .concat(['height', 'left', 'width']
                .concat(open ? [] : ['top'])
                .map((p) => {
                  // Only the height, only closing, only on the tuck beat — the hug
                  // has to stay glued to the rows and cannot be delayed. See FRAME.
                  const late = p === 'height' && !open && tuck ? 2 * FRAME : 0;
                  return `${p} ${DUR / 2 - late}ms cubic-bezier(`
                    + (open ? '0.33, 1, 0.68, 1' : '0.32, 0, 0.67, 0') + ')'
                    + (late ? ` ${late}ms` : '');
                }))
              .join(', '),
          }}
        />
        {stack(0)}
      </div>
    </div>
  );
}
