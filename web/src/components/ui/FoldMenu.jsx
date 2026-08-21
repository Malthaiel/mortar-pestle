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
import { Children, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import FoldPaper, { FOLD_PAD, paperT } from './FoldPaper.jsx';
import useSuckToCursor, { SUCK_DUR, SUCK_LEAD } from '../../hooks/useSuckToCursor.js';

export { FOLD_PAD };

// Both re-exported below their definitions, as FOLD_PERSPECTIVE / FOLD_DUR. A
// host that folds something of its OWN alongside this one (the context menu's
// fly-out is a fold panel hinged on a menu row) has to fold on the same camera
// and the same clock, and typing 2000 and 300 into that file again is how the
// two silently drift. See `feedback_measure_never_predict`.

// Camera distance. The article's 500 was sized for a 300px-tall image; against
// 28px rows it sits far too close and the taper (the near edge of a folding
// flap draws wider than its hinge) reads as the rows changing shape. Pulling
// the camera back flattens the taper without killing the fold.
// taper% = PERSPECTIVE / (PERSPECTIVE - rowHeight) — recompute if rows get tall.
const PERSPECTIVE = 2000;
export { PERSPECTIVE as FOLD_PERSPECTIVE };

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
export { DUR as FOLD_DUR };
// Fallback for the candy face's ease-down; the live value is read from
// --cbtn-press-dur on mount, since Settings → Animations rewrites it.
const PRESS_FALLBACK = 70;
// Used only until the trigger is measured; every shape pins its own lip.
const DEPTH_FALLBACK = 'var(--candy-depth)';
// The TRIGGER's fade-out on open. The open group no longer cross-fades against
// it — it hard-cuts in at frame one, mirroring the close's hard cut out (see the
// group's transition), so the paper is present for the whole open exactly as it
// is for the whole close. The trigger is fully occluded by the shut stack while
// this runs (the group is absolutely positioned, so it paints over a
// non-positioned sibling), so the length here is now invisible either way.
const SETTLE = 120;

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
  // CONTROLLED MODE (the context menu). Pass `open` and the host owns the
  // state: every close request — a row click, Escape, a click outside — is
  // reported through onRequestClose instead of flipping local state, and the
  // internal dismissal listeners stand down (see the effect below for why a
  // fly-out makes them actively wrong). Leave `open` undefined and the fold is
  // exactly the self-driven button it has always been.
  open: openProp,
  onRequestClose,
  // Fired once the close has fully PLAYED (at SHUT). A host that mounts the
  // fold only while its menu is up needs this to unmount — dropping it on the
  // close request instead cuts the fold off mid-flight.
  onClosed,
  // The trigger becomes an invisible measurement stub: still laid out, still a
  // real .candy-btn of the row's own shape, so the lip and the row height are
  // read off a live element exactly as they always were — but never painted and
  // never clickable. For a menu that opens AT A POINT there is no button to
  // fold out of; the stack is the whole control.
  noTrigger = false,
  // Explicit floor for the row rectangle, on top of the trigger's own width.
  // Unset by default, and a noTrigger fold has NOTHING else — its stub is not a
  // floor (see the group's minWidth), so it shrink-wraps its longest row.
  minWidth = 0,
  // On close, get INHALED INTO THE LIVE CURSOR on top of the fold — for a menu
  // that belongs to the pointer (the right-click menu, the seam's width
  // chooser). Off by default: a button-anchored fold (the titlebar account
  // menu, the subtitle picker) belongs to its trigger, not to the mouse.
  //
  // The suck rides the TAIL of the existing fold rather than following it, so
  // the close does not get one millisecond longer at any row count.
  suckToCursor = false,
  // Stagger for a tree of folds that shut together — the deepest goes first and
  // the root last, so it reads as a drain pulling the far end in.
  suckDelay = 0,
  style,
  ...rest
}) {
  const [openState, setOpenState] = useState(false);
  const isCtl = openProp !== undefined;
  const open = isCtl ? !!openProp : openState;
  // One close path for every caller. Controlled, it is a REQUEST — the host
  // flips `open` and the fold plays the same close it always did.
  const requestClose = () => { if (isCtl) onRequestClose?.(); else setOpenState(false); };
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
  // The open group, and the row buttons inside it. FoldPaper measures both every
  // frame — it is the frame the paper is placed in, and they are what it hugs.
  const groupRef = useRef(null);
  const rowsRef = useRef([]);
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
  // One STABLE ref callback per row. An inline arrow here is a new function
  // every render, which makes React detach every row ref and reattach it — and
  // the reattach lands AFTER FoldPaper's effect, so the paper would find an
  // empty stack on any re-render mid-fold.
  const setRow = useMemo(
    () => Array.from({ length: n }, (_, j) => (el) => { rowsRef.current[j] = el; }),
    [n],
  );
  const hinges = Math.max(0, n - 1);
  const last = hinges - 1;                 // innermost wrapper index

  // Fold start times, indexed by wrapper (0 = outermost, `last` = innermost).
  //
  // Closing runs innermost-first, opening runs outermost-first. The SPREADS
  // differ on purpose and this is the toy's own schedule, not a bug: closing
  // steps by `(press + DUR) / 2`, opening by `DUR / 2`. At two hinges that is
  // the toy exactly — closing, the flap goes at `press` and the pair at
  // `2 * press + DUR`; opening, the pair at `press` and the flap at
  // `press + DUR`. The extra press closing is the beat the compaction (squash,
  // then lip) plays into before the outer fold takes the stack away.
  //
  // The STEP is per hinge and CONSTANT — the schedule is pinned at the
  // reference count (the four-row Settings → Dev fold, `last` 2), not divided
  // across however many hinges there are. Dividing was the original form
  // (`(j / last) * DUR`) and it held the TOTAL fixed instead: every fold took
  // the same ~670ms, so each row went faster the more rows there were. Fine at
  // the two fold counts that existed, wrong the moment the context menu handed
  // it eight rows — 50ms a row against the dev tab's 150ms, "when i right click
  // and have like 10 options it gets super fast", 2026-08-10. A long menu now
  // takes longer to open, which is the honest cost of one cadence.
  const closeAt = (j) => (last < 1 ? press : press + (last - j) * ((press + DUR) / 2));
  const openAt = (j) => (last < 1 ? press : press + j * (DUR / 2));

  // Hand-over instant: the outermost fold is the last to finish, so this is when
  // the real candy button takes back over. EVERY close timing derives from it,
  // so they cannot drift apart.
  const SHUT = closeAt(0) + DUR;
  // Anchored on the END, not the start, then pulled SUCK_LEAD earlier still: a
  // start-anchored overlap would run out early on the eight-row context menu
  // and late on the three-row width chooser. The lead is what makes it bite
  // into the fold rather than only ride its tail, so the suck now finishes
  // after SHUT and the unmount gate below moves with it.
  const suckStart = suckToCursor ? Math.max(0, SHUT - SUCK_DUR * (1 + SUCK_LEAD)) + suckDelay : 0;
  const suckEnd = suckToCursor ? Math.max(SHUT, suckStart + SUCK_DUR) : SHUT;

  // Backing panel geometry. `depth` is a CSS length string off the live trigger
  // ('5px' on a chip), or the raw var() fallback before the first measure —
  // parseFloat gives NaN there, hence the 7px floor (--candy-depth's value).
  const dpx = parseFloat(depth) || 7;
  // The paper's own clock, handed to the HOST. The trigger's neighbours stand
  // off by FOLD_PAD while the menu is open, and they have to move on the halo's
  // clock or the two drift against each other. FoldPaper owns the number; this
  // is a read of it, not a second copy of it.
  const panelT = paperT(open, SHUT);

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

  // Per-wrapper lip state. A candy lip is a DOWNWARD box-shadow, so a row
  // rotated 180deg points its lip UP and stacks a whole depth of shadow above
  // whatever it lands on — the other half of landing flush, and invisible to a
  // box measurement (the boxes land dead flush; only the paint sits high).
  // Both of these START AT THE SHUT RESTING STATE — lips OFF, flipped ON — which
  // is what a close leaves behind, not what they used to be seeded with (the
  // opposite of both). It was invisible while the group waited out `press` and
  // cross-faded in, and it stopped being invisible the moment the group started
  // hard-cutting in at frame one: on the FIRST open after a mount, row 1 painted
  // its front label through its own back (upside down) and every row carried a
  // lip while it rotated, for the 70ms before the folds begin. Seeded correctly,
  // the first open is byte-identical to every later one.
  const [lips, setLips] = useState(() => Array(hinges).fill(false));
  // Which wrappers are past edge-on, so the row inside each can swap its face.
  const [flipped, setFlipped] = useState(() => Array(hinges).fill(true));

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
        at(closeAt(j) + DUR / 2, () => setAt(setFlipped, j, true));
      }
    }
    return () => t.forEach(clearTimeout);
  }, [open, press, hinges]);

  // Kept mounted for the whole close so the fold can play, then dropped. See the
  // display note on the group below.
  // The fold waits for the trigger's press to reach the bottom. A click faster
  // than --cbtn-press-dur releases :active while the face is still travelling
  // down, and the group cuts in at frame one on top of it — so the press read as
  // clipped: "if i click the button super fast then the button doesnt get fully
  // pressed before the animation starts", 2026-08-07. Held down for whatever is
  // left of `press`, a fast click plays exactly like a slow one. `is-pressed`
  // keeps the face down for that window, since :active is already gone.
  // It also waits out the RELEASE — the face travels back up over the same
  // `press`, and the fold starts once it has landed at the top, user-directed
  // 2026-08-07: "i want the fold to wait until the button fully reaches the top
  // after reaching the bottom". So the whole gesture is press down, come back
  // up, then unfold, whatever speed the click was.
  const downAt = useRef(0);
  const timers = useRef([]);
  const [holding, setHolding] = useState(false);
  const openAfterPress = () => {
    const left = Math.max(0, press - (performance.now() - downAt.current));
    if (left > 0) {
      setHolding(true);
      timers.current.push(setTimeout(() => setHolding(false), left));
    }
    timers.current.push(setTimeout(() => setOpenState(true), left + press));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const [shown, setShown] = useState(false);
  // Only a fold that was actually OPEN reports a finished close. Without this
  // the mount itself (open === false) would fire onClosed one SHUT later and
  // unmount a menu that never opened.
  const wasOpen = useRef(false);
  // Same reason as `notify` below: an inline arrow from the host is a new
  // identity every render, and this one is read from inside a timeout.
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;
  // Layout effect: a plain one runs after paint, so frame one of an open used to
  // render with the group still `visibility: hidden` — a wasted frame at the
  // front of the halo's ramp, and one the "hard cut in at frame one" note above
  // already assumed was not there.
  useLayoutEffect(() => {
    if (open) { wasOpen.current = true; setShown(true); return undefined; }
    const played = wasOpen.current;
    wasOpen.current = false;
    const t = setTimeout(() => { setShown(false); if (played) closedRef.current?.(); }, suckEnd);
    return () => clearTimeout(t);
  }, [open, suckEnd]);

  // The suck lands ON the fold's own clock: it ENDS at SHUT, so at the four-row
  // reference (SHUT 740) it owns the last 30% and the total close is unchanged.
  // Only a fold shorter than the suck itself (or one carrying a stagger) runs
  // past SHUT, and then the unmount gate above moves with it — this file has
  // been burned twice by an unmount arriving before its close had played.
  // (the call itself lives below rootRef's declaration — see there.)

  // Held in a ref so an inline arrow from the host (a new function identity
  // every render) cannot make this fire on every render — it fires only when
  // the state or the clock actually changes.
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  useEffect(() => { notify.current?.(open, panelT); }, [open, panelT]);

  // Close on Escape and on any click outside. The fold replaces the menu's
  // PAINT, not a menu's behaviour.
  //
  // CONTROLLED folds opt out entirely, and that is not tidiness: a context menu
  // renders its fly-out as a SIBLING fold, so a click on a child row lands
  // outside the parent's root and this listener would read it as "dismiss me".
  // One owner for the whole tree instead — the host's.
  const rootRef = useRef(null);
  useSuckToCursor(rootRef, { active: suckToCursor && shown && !open, startAt: suckStart });
  useEffect(() => {
    if (!open || isCtl) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') requestClose(); };
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) requestClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, isCtl]);

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
  // `under` marks ROW 1 while it is still folded onto row 0 — the shut stack and
  // the first half of an open. There the fold LOOKS like one button but is two:
  // row 1 draws the face, row 0 draws the lip beneath it. :hover only ever
  // reaches the top one, so the face lit accent while the lip stayed grey —
  // user-reported 2026-08-08, "only the top of the button is highlighted the
  // accent color rather than the whole button including the dropshadow". Giving
  // row 1 its own lip for that window puts face and lip on ONE element, so they
  // light together under whatever hover rule the trigger's skin carries — no
  // colour is restated here, which is the only version that survives a skin
  // change. Row 0's grey lip is still drawn, exactly underneath and fully
  // occluded (row 1 resolves to z +3; see the note in stack()).
  //
  // The SIGN is the opposite of the resting one, and for the same reason the
  // resting one is negated under UP_FLIP: row 1 is rotated 180deg here, so its
  // local down is the screen's up. Two flips cancel on `up`, hence the swap.
  // FoldPaper is unaffected — it takes the max over the rows and row 1's box is
  // flush on row 0's, so the union does not move.
  const row = (lipOn, under = false) => ({
    width: '100%',                    // the GROUP sizes the stack — see there
    height: box.h,
    display: 'block',                 // the class is inline-flex; these stack
    // NEGATED under UP_FLIP, and that one sign covers both things this variable
    // drives in styles.css: the lip (`box-shadow: 0 var(--cbtn-depth) 0`) and
    // the press (`.candy-face { transform: translateY(var(--cbtn-depth)) }`).
    // Rendered upward inside a group that is then mirrored, both come out
    // pointing DOWN — a row keeps its own lip under it and still presses
    // downward, exactly as it does in the unflipped fold.
    '--cbtn-depth': lipOn ? (up ? `calc(${depth} * -1)` : depth)
      : under ? (up ? depth : `calc(${depth} * -1)`)
        : '0px',
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
        // FoldPaper unions these rects every frame. A rect on a rotated element
        // is already the painted, transformed box, so this is the whole of what
        // the paper needs to know about the fold.
        ref={setRow[j]}
        // The accent is held only while OPEN, so it releases on frame one of the
        // close and eases out under the fold rather than riding it down and
        // hard-cutting at the handover. .candy-btn's own 150ms colour ease does
        // the work — fast, but a fade, not a cut. Restoring it is free even
        // though the group is now opaque from frame one: the selected row is
        // folded UNDER row 1's opaque face at rest and does not clear edge-on
        // until ~220ms, by which point its own 150ms colour ease (started on
        // the click) has long finished. Still never seen to appear.
        // is-pressed on the innermost row only, and only for the first `press`
        // of a close — the squash. See `down`.
        className={`candy-btn ${triggerClassName}${j === selected && open ? ' is-active' : ''}${j === n - 1 && down ? ' is-pressed' : ''}`.trim()}
        data-shape={shape}
        data-own-press
        data-self-press
        aria-current={j === selected ? 'true' : undefined}
        // A dead row — a section title, or an action that doesn't apply here.
        // The native attribute is the whole implementation: it kills the click,
        // and with it the close, so the row is inert without a second guard.
        disabled={!!items[j].disabled}
        style={j === n - 1 && j > 0
          ? { ...row(lips[j - 1], j === 1 && flipped[0]), marginTop: GAP, ...hinge(open ? 0 : 180, open ? openAt(j - 1) : closeAt(j - 1)) }
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
          : { ...row(j === 0 ? true : lips[j - 1], j === 1 && flipped[0]),
            ...(j === 1 ? { transform: 'translateZ(-2px)' } : null) }}
        // `keepOpen` is for a row that OPENS something rather than doing
        // something — a fly-out's parent. The event goes through so the host can
        // anchor off the row's own rect rather than guessing where it is.
        onClick={(e) => {
          if (!items[j].keepOpen) requestClose();
          items[j].onClick?.(e);
        }}
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
          free. Fades OUT on open, HARD-CUTS back in on close: the paper's last
          visible face and this button paint different things for the length of
          any cross-fade, which reads as a flash. Its open fade is now hidden
          anyway — the group cuts in at frame one and paints straight over it. */}
      <button
        ref={triggerRef}
        type="button"
        className={`candy-btn ${triggerClassName}${holding ? ' is-pressed' : ''}`.trim()}
        data-shape={shape}
        data-own-press
        title={noTrigger ? undefined : triggerTitle}
        aria-haspopup={noTrigger ? undefined : 'menu'}
        aria-expanded={noTrigger ? undefined : open}
        aria-hidden={noTrigger || undefined}
        tabIndex={noTrigger ? -1 : undefined}
        onPointerDown={noTrigger ? undefined : () => { downAt.current = performance.now(); }}
        onClick={noTrigger ? undefined : openAfterPress}
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
          // The stub is never painted and never hit — but it is still LAID OUT,
          // which is the whole point: `visibility: hidden` keeps its box and its
          // computed style, so the lip and the row height below are read off a
          // real candy button of the rows' own shape rather than assumed.
          // `display: none` would take the box away and with it the measurement.
          ...(noTrigger ? { visibility: 'hidden' } : null),
          opacity: open ? 0 : 1,
          pointerEvents: open || noTrigger ? 'none' : 'auto',
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
          // --fold-settle is written by FoldPaper, off the same halo value it is
          // padding itself out by. The paper reaches FOLD_PAD past row 0, and row
          // 0 sits in a titlebar with only 6px of bar above it, so a stack left
          // at the trigger's own line puts the paper's edge off the top of the
          // window. Giving the halo back here keeps that edge pinned on screen —
          // and because both numbers are the SAME `h`, they cancel by
          // construction rather than by two clocks agreeing.
          //
          // No transition on it: FoldPaper drives it per frame, so a CSS ease
          // here would fight the loop. The sign is FoldPaper's, because layout
          // is applied before UP_FLIP mirrors the box.
          //
          // The centring lift is NOT flipped: UP_FLIP pivots on row 0's centre,
          // so row 0 does not move and its optical lift is the trigger's own in
          // both directions.
          //
          // A noTrigger fold takes NO lift, for the same reason it takes no
          // width floor: there is no button underneath for it to hand back to,
          // so there is nothing to be optically flush WITH — and the host has
          // already placed the stack off a real measured rect. The context
          // menu's fly-out is anchored to its parent row, which is itself a
          // candy row carrying that lift, so applying it again counted it
          // twice: the card came to rest 3.5px (depth / 2) ABOVE the row it had
          // peeled off. User-reported 2026-08-10, "its final resting place is
          // slightly above the original button"; measured off the live window,
          // group top 316.0 against a row top of 319.5.
          top: noTrigger
            ? 'var(--fold-settle, 0px)'
            : `calc(${depth} / -2 * var(--candy-center-on, 1)`
              + ' + var(--fold-settle, 0px))',
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
          //
          // A noTrigger stub is NOT a floor. There is no button to hand back to,
          // so there is nothing for the stack to stay flush WITH — and the stub
          // is still handed `children` as its shut face, so any host that gives
          // one (a context-menu fly-out is handed its PARENT ROW's face) would
          // pin the whole stack to that face's width through a button nobody can
          // see. The shut face still sizes row 1's own grid column, which is why
          // a fly-out stays as wide as the row it peeled off — that one is
          // wanted, and it is not this line's doing.
          perspective: PERSPECTIVE,
          width: 'max-content',
          minWidth: noTrigger ? minWidth : Math.max(box.w, minWidth),
          // A noTrigger fold is painted from the moment it MOUNTS, shut stack and
          // all, because there is no button underneath for it to hand back to —
          // the stack IS the whole control (see the prop). A fold that opens out
          // of a real trigger still appears only for its own open, so the shut
          // stack cannot flash beside the button it came from.
          //
          // The context menu's fly-out is what needed this. It swings out of its
          // parent row like a door over SWING, and only THEN unfolds — so for
          // that whole swing the fold was not open yet, and both of these
          // hid it: nothing was painted, the swing was invisible, and the card
          // appeared out of nowhere already landed. User-reported 2026-08-10,
          // "the fly-out doesnt have an unfolding/folding in animations" — the
          // unfold was playing the whole time; the door was not.
          opacity: open || noTrigger ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          // Hidden only once the close has finished PLAYING, so the fold is
          // never cut off mid-flight. visibility, not display: a hidden element
          // still has a box and a computed style, so its opacity transition
          // survives the handover — see the position note above for what
          // display:none did to the open.
          visibility: shown || noTrigger ? 'visible' : 'hidden',
          // HARD CUT AT BOTH ENDS, and that is the mirror: the close holds this
          // group at opacity 1 for its whole 740ms and cuts it at SHUT, so the
          // paper is present for every frame of a close. The open used to wait
          // `press` and then cross-fade over SETTLE against the trigger, so the
          // paper was absent for 70ms and see-through for 120 more — the exact
          // window the halo grows in. User-directed 2026-08-07, "mirror the
          // closing animation".
          //
          // Cutting in at frame one costs nothing to look at: this div is
          // ABSOLUTE and the trigger is not, so the shut stack paints over the
          // trigger completely, and the shut stack IS the trigger's face — row
          // 1's underside carries the trigger's own children (see stack()) with
          // row 0's lip beneath it. The trigger is left on its own SETTLE fade
          // underneath, where nothing can see it.
          //
          // This is NOT the display:none failure recorded on `position` above.
          // That one snapped the opacity because the element had no previous
          // frame to interpolate from, which killed the HINGE transitions too,
          // so the stack sat unfolded and parked. Here the element is only ever
          // `visibility: hidden`, every transition keeps its start value, and
          // the folds still begin at `press` exactly as before.
          transition: `opacity 0ms ease-in-out ${open ? 0 : SHUT}ms`,
        }}
        ref={groupRef}
      >
        {/* The paper it unfolds ONTO. It MEASURES this stack every frame and
            sits a fixed halo outside it — see FoldPaper.jsx. zIndex -1 there
            puts it under the in-flow rows: this group declares `perspective`,
            which is a stacking context, so a negative child paints below its
            non-positioned siblings and nothing else. It is NOT inside the
            preserve-3d wrappers, so it takes no rotation of its own. */}
        <FoldPaper
          open={open}
          shown={shown}
          up={up}
          groupRef={groupRef}
          rowsRef={rowsRef}
          lip={dpx}
          shutMs={SHUT}
          frameRef={rootRef}
        />
        {stack(0)}
      </div>
    </div>
  );
}
