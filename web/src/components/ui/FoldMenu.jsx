// FoldMenu — the app's dropdown. A candy button that unfolds into its own menu
// rows like a letter, and folds back into itself.
//
// This is FoldPanel (components/settings/FoldPanel.jsx, the Dev tab "Fold" toy)
// generalized from its hardcoded three rectangles to any number of rows. The
// motion, the timings, and every trap it encodes are carried over unchanged —
// at three rows this produces byte-identical choreography to the toy. Do not
// re-tune it here; that motion is signed off. FoldPanel stays as the reference
// instance and the place to experiment.
//
// The toy is allowed to hardcode its skin because it IS the account chip: it
// measures `.titlebar-account`, and its rectangles wear plain `.candy-btn` with
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
// THE TOY IS THE REFERENCE. `FoldPanel` (components/settings/FoldPanel.jsx, the
// Dev tab "Fold" toy) is the signed-off motion, and at three rows this file must
// reproduce it beat for beat. Anything measured here is measured against that,
// not against a symmetry argument.
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
  // The rotation is NOT mirrored: the hinge still runs 180deg -> 0deg. Only the
  // PIVOT moves, from the flap's top edge to its bottom (see HINGE_Y), and
  // rotating about an origin below the flap already carries it down and over
  // the row beneath. Flipping the sign as well would undo that.
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
  useEffect(() => {
    const d = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--cbtn-press-dur'));
    if (d > 0) setPress(d);
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
  // Folding up, the flap sits ABOVE the row it lands on and the gap is below it,
  // so the same midpoint is measured from the flap's own bottom edge instead.
  const HINGE_Y = up ? `calc(100% + (${GAP_V}) / 2)` : `calc((${GAP_V}) / -2)`;
  // Which side of a flap the gap lives on. Folding up, the stack is laid out
  // bottom-to-top (see `col`), so the separator has to move to the other edge —
  // a marginTop in a column-reverse box separates a row from the WRONG
  // neighbour, and the fold lands a whole GAP out.
  const GAP_SIDE = up ? 'marginBottom' : 'marginTop';
  // Every box that stacks rows has to run bottom-to-top when folding up: the
  // group AND each preserve-3d wrapper, since the nesting means every level
  // holds a row plus the wrapper carrying everything past it.
  const col = up ? { display: 'flex', flexDirection: 'column-reverse' } : null;

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
  // waits out the first half and runs the second — which is why the open delay
  // carries a + DUR / 2 the close does not. Running from the fold's start
  // instead put the surface a full half-fold ahead of any visible row.
  //
  // Delay is the OUTERMOST hinge's, since wrapper 0 is the fold that swings the
  // whole lower block and so defines how far the menu reaches. It has to match
  // the FIRST height step exactly, or the panel goes wide before it goes tall.
  const panelT = `${DUR / 2}ms ease-in-out `
    + `${open ? openAt(0) + DUR / 2 : closeAt(0)}ms`;

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
  // Rows the panel still has to cover. Clamped, because `items` can change
  // length under a fold that is already mid-flight.
  const vis = Math.max(1, n - Math.min(folded, hinges));
  // The FOLD_PAD border, on the OUTERMOST hinge's instants — it appears once, as
  // the menu opens, not once per row. Those instants are exactly where `folded`
  // leaves and returns to its resting count, so this stays in lockstep with the
  // panel's left/width/top, which run on that hinge's clock. A one-row menu has
  // no hinge to hang it on, so it falls back to the open flag.
  const padOn = hinges ? folded < hinges : open;
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
      for (let j = 0; j < hinges; j += 1) {
        // Lips return per row, each as its own unfold FINISHES — never during,
        // or the lip grows back while the row is still rotating.
        at(openAt(j) + DUR, () => setAt(setLips, j, true));
        // At the EDGE-ON frame, not at the fold's start. Before edge-on the row
        // is still rotated past 90deg and paints nothing new — it is lying on
        // the row above — so a panel that starts growing at the fold's start
        // runs a full half-fold ahead of anything visible. User-reported
        // 2026-08-05: "during the unfold the bg expands too fast."
        at(openAt(j) + DUR / 2, () => setFolded(hinges - 1 - j));
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
    '--cbtn-depth': lipOn ? depth : '0px',
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
  const label = { gridArea: '1 / 1', whiteSpace: 'nowrap' };

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
          ? { ...row(lips[j - 1]), [GAP_SIDE]: GAP, ...hinge(open ? 0 : 180, open ? openAt(j - 1) : closeAt(j - 1)) }
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
              transform: 'scaleY(-1)',
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
          [GAP_SIDE]: GAP,
          ...col,
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
          position: 'absolute', left: 0, ...col,
          // + FOLD_PAD while open: the panel reaches FOLD_PAD above row 0, and
          // row 0 sits in a titlebar with only 6px of bar above it, so a stack
          // left at the trigger's own line puts the panel's top edge off the top
          // of the window. Sliding the whole stack down by exactly the pad lands
          // that edge back on the trigger's original top line. It is animated on
          // the panel's clock, and starts from 0, so at the handover frame the
          // paper is still dead on the button it replaced — the locked "row 1
          // lands ON the trigger" rule survives; the settle happens after.
          top: `calc(${depth} / -2 * var(--candy-center-on, 1) + ${open ? FOLD_PAD : 0}px)`,
          // Folding up, the stack is pinned by its BOTTOM to the trigger's own
          // bottom line and grows upward, and the settle moves it UP by the pad
          // instead of down. Written AFTER the `top` above so it wins — `top`
          // has to go back to `auto` or it, not `bottom`, places the box.
          // The lift is the same one with its sign flipped: a bigger `bottom`
          // raises a box exactly as a smaller `top` does.
          ...(up ? {
            top: 'auto',
            bottom: `calc(${depth} / 2 * var(--candy-center-on, 1) + ${open ? FOLD_PAD : 0}px)`,
          } : {}),
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
            + ` ${up ? 'bottom' : 'top'} ${panelT}`,
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
            boxShadow: '0 var(--candy-surface-depth) 0 -2px var(--surface-3),'
              + ' 0 var(--candy-surface-depth) 0 0 var(--border-2)',
            // Shut, it is the trigger rectangle exactly — so the first frame of
            // the open has nothing to pop. The pad only appears as it grows.
            left: open ? -FOLD_PAD : 0,
            // Pinned to whichever edge the stack itself is pinned to, so it
            // grows the same way the rows do. Folding up that anchor also
            // absorbs the lip (see the height note), keeping BOTH directions
            // the same shape: FOLD_PAD above the stack, FOLD_PAD + a lip below.
            [up ? 'bottom' : 'top']: open ? -(up ? FOLD_PAD + dpx : FOLD_PAD) : 0,
            width: open ? `calc(100% + ${FOLD_PAD * 2}px)` : '100%',
            // Sized to the rows STILL SHOWING, not to the open/shut flag — see
            // `folded`. Same rows + GAP formula the stack itself is laid out by,
            // so the panel and the paper can never disagree about a row's
            // height. + dpx: the bottom row's lip is a box-shadow living OUTSIDE
            // its layout box, so a panel sized to the boxes alone stops short.
            height: vis * box.h + (vis - 1) * (dpx + 4)
              + (padOn ? FOLD_PAD * 2 + dpx : 0),
            // Height alone runs on its own clock with NO delay: each `folded`
            // change already fires at its own fold's start, so a delay here
            // would push every step past the fold it belongs to. The other three
            // stay on the outermost hinge's clock — they are the pad appearing,
            // and it appears once, not per row.
            //
            // Half a fold long, same as panelT — see the note there. The CURVE
            // is the other half of matching: the row's painted height is
            // rowH * cos(angle) and the angle itself is eased, so a row barely
            // moves near edge-on and then falls off a cliff near flat. A cubic
            // tracks that within about 3px on a 28px row (0.125 against 0.119 at
            // the quarter point), where ease-in-out is nearly five times off
            // there. The two directions are exact mirrors of each other, so the
            // curves are too: in cubic closing, out cubic opening.
            transition: ['left', up ? 'bottom' : 'top', 'width']
              .map((p) => `${p} ${panelT}`)
              .concat(`height ${DUR / 2}ms cubic-bezier(`
                + (open ? '0.33, 1, 0.68, 1' : '0.32, 0, 0.67, 0') + ')')
              .join(', '),
          }}
        />
        {stack(0)}
      </div>
    </div>
  );
}
