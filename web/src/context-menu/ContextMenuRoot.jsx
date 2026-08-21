// The app-wide right-click menu, as a FOLD. User-directed 2026-08-10: "i want
// the right click menu to literally just be one of these buttons" — the fold
// menu from Settings → Dev. Right-clicking anywhere in the app unfolds that same
// stack of candy rectangles at the cursor.
//
// This replaced a flat portaled panel with roving keyboard navigation, hover-
// intent submenus, separators, section headers, shortcut hints and a standing
// red for destructive rows. All of that is gone on purpose — a fold is a stack
// of IDENTICAL rectangles, and every one of those features either broke that
// (a hairline is not a rectangle) or was a second system bolted beside it.
// What survives is what fits INSIDE a row's face: a glyph and words.
//
// The item API did NOT change, so all 28 call sites are untouched. Anything the
// fold has no room for is dropped here, in normalize(), rather than at the
// callers:
//   sep / divider  -> dropped (the fold already leaves a gap between rows)
//   header/section -> DROPPED (2026-08-10). They were dead rows — the same
//                     rectangle in muted 9px type, no glyph, no click — and a
//                     dead rectangle in a stack of buttons reads as a broken
//                     button, not as a label: "remove the unclickable buttons
//                     like navigate". The grouping they carried is gone with
//                     them; the fold's gaps are the only separation now.
//   shortcut       -> dropped (user-directed; may come back)
//   danger         -> dropped (accent is the only highlight in the app now)
//   checked        -> the fold's own `selected` accent fill
//   children       -> a fly-out: a folded card that swings out of the parent
//                     row like a door, then unfolds down. See Flyout.
//
// Dismissal is owned HERE for the whole tree, which is why every FoldMenu below
// is in controlled mode: a fly-out is a sibling fold, so each fold's own
// click-outside listener would read a click on its child as "dismiss me".

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FoldMenu, { FOLD_PAD, FOLD_DUR, FOLD_PERSPECTIVE } from '../components/ui/FoldMenu.jsx';
import { IconChevronRight } from '../components/icons.jsx';
import { iconFor } from './menuIcons.js';

// No width floor. The menu is exactly as wide as its longest row needs, so the
// air to the right of the longest label equals the air to the left of the first
// glyph — the face's own symmetric 10px padding, and nothing else. It was a flat
// 200 (the old panel's width), which left ~64px of dead paper past "Command
// Palette". User-directed 2026-08-10.
const PAD = 8;          // keep the paper this far off every window edge
const ROW_H = 28;       // the menu row height the flat panel already had
// One fold, TAKEN from FoldMenu rather than retyped. The fly-out folds for
// exactly as long as a row folds, and the rows start unfolding as it lands.
const SWING = FOLD_DUR;
// How far behind its open child a level starts its own suck.
const SUCK_STAGGER = 60;
// The angle a folded panel rests at. 180 = folded flat back onto the thing it is
// hinged to, which is the whole of what makes this read as paper: at 180 the
// card lies ON the parent row, full size and fully visible, and the unfold is
// legible from frame one.
//
// It was 90 — a DOOR, not a fold. A panel at 90deg is edge-on, so it is
// INVISIBLE at rest and the first third of the animation delivers a sliver:
// measured 35.7px of 147.7 at the 100ms mark. User-reported 2026-08-10, "when i
// click quick actions to unfold the first 40% is just cut out", and re-reported
// after an angle tweak that kept the door — the mechanism was the bug, not the
// number. The reference is the same one FoldMenu's rows fold on
// (`hinge(open ? 0 : 180)`), which is Josh Comeau's two-panel fold:
// https://www.joshwcomeau.com/react/folding-the-dom/
const SHUT_ANGLE = 180;
// A cursor "suck" (the whole menu scaling out of the click point and back into
// it, on the fold's own clock) was built and REMOVED the same day, 2026-08-10:
// "nope. terrible. remove it completely it doesnt work." May be revisited — do
// not re-add it unprompted.

// WHERE THE REAL CURSOR IS. A fly-out has to answer "is the hand still on my
// parent row" at the instant it starts folding BACK, and it cannot ask CSS:
// `:hover` is the browser's own bookkeeping about a stack the card is sitting on
// top of, and it is exactly what the logged "doesn't highlight if i'm hovering
// over it" symptom says is unreliable here. A real pointer position hit-tested
// against the row's real rect depends on neither. Passive, capture, one listener
// for the app's life — the menu is mounted too rarely to arm this on demand, and
// a cursor that has not moved since is still where it was.
let cursor = { x: -1, y: -1 };
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => { cursor = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
}
const cursorOver = (el) => {
  const r = el?.getBoundingClientRect();
  return !!r && cursor.x >= r.left && cursor.x <= r.right && cursor.y >= r.top && cursor.y <= r.bottom;
};

const isSep = (it) => !!(it && (it.sep || it.divider));
const isHeader = (it) => !!(it && (it.header || it.section));
const hasKids = (it) => !!(it && it.children && it.children.length);

// The face of a row: a fixed glyph slot, then the words. The slot is a fixed
// width rather than shrink-to-fit so every label in the stack starts on the same
// vertical line, glyph or not (a section title has no glyph).
//
// `flex`, NOT `inline-flex`, and that is the whole of the row's vertical
// centring. FoldMenu hands every label a plain block span; an INLINE-level box
// inside it sits on a text LINE, so the line box grows to hold a descender the
// row does not have — measured 17.58px of wrapper around 14.4px of content,
// every pixel of the slack below the glyphs. Centring the wrapper therefore
// printed the content 1.6px HIGH on every row, and a section title (9px type on
// the same 14.4px line, pushed onto its baseline) 2.8px LOW. Block-level flex
// takes no line box, so the wrapper is exactly its content and FoldMenu's
// `alignItems: center` lands it dead centre. User-reported 2026-08-10,
// "icons/text not centered within the buttons"; measured off the live window.
function rowFace(it, { muted, chevron } = {}) {
  const Icon = it.icon || iconFor(it);
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
      opacity: muted ? 0.45 : 1,
    }}>
      <span style={{
        width: 14, flexShrink: 0, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {typeof Icon === 'function' ? <Icon size={14} /> : Icon}
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>{it.label}</span>
      {/* The chevron HUGS the words — same 8px the glyph keeps off them — rather
          than being pushed to the far edge. It used to take `marginLeft: 12`
          against a `flex: 1` label, which parked it on the right wall: that made
          a parent row 6.8px wider than the longest plain row, so the chevron
          row sized the whole menu and every text row was left with slack it did
          not ask for. Neither the margin nor the flex can come back without
          bringing that with it. User-directed 2026-08-10. */}
      {chevron && (
        <span aria-hidden style={{
          display: 'inline-flex', lineHeight: 1, opacity: 0.6,
        }}><IconChevronRight size={11} /></span>
      )}
    </span>
  );
}

/**
 * Flatten one level of the caller's items into fold rows.
 * Returns { rows, selected, kids } — `kids` maps a row index to its child items,
 * and `selected` is the index the fold paints with its accent fill.
 */
function normalize(items) {
  const rows = [];
  const kids = new Map();
  let selected = -1;
  for (const it of items) {
    // Separators and section titles both go: nothing that cannot be clicked
    // earns a rectangle in a stack of buttons. See the file header.
    if (!it || isSep(it) || isHeader(it)) continue;
    const i = rows.length;
    if (it.checked && selected < 0) selected = i;
    if (hasKids(it)) {
      kids.set(i, it.children);
      // keepOpen: this row opens something, so the fold must NOT fold shut under
      // it. The click event rides through so the fly-out can anchor off the
      // row's real rect instead of guessing where the row ended up.
      rows.push({ label: rowFace(it, { chevron: true }), keepOpen: true });
      continue;
    }
    rows.push({
      label: rowFace(it, { muted: it.disabled }),
      disabled: !!it.disabled,
      onClick: it.onClick,
    });
  }
  return { rows, selected, kids };
}

// Row text: the flat panel's own type, restated on the fold's face. FoldMenu's
// face defaults to the account chip's mono 11.5 — right for a titlebar chip,
// wrong for a menu — and `justifyItems: stretch` is what puts the label on the
// left instead of centred in the rectangle.
const FACE = {
  fontFamily: 'var(--font-body)',
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: 0,
  textTransform: 'none',
  padding: '0 10px',
  alignItems: 'center',
  justifyItems: 'stretch',
};

/**
 * One fold in the tree. The root is anchored at the click point; a fly-out is
 * anchored to its parent row and arrives through the door swing.
 *
 * Mount order matters and is the same for both: render SHUT, measure the real
 * stack, place it, and only then unfold. Measuring first is what lets a menu
 * near the bottom of the window fold UPWARD instead of off the screen — and the
 * layout box is honest even while the rows are folded, because a fold is a
 * transform and transforms do not touch layout.
 */
function Level({ anchor, items, title, accent, open, onDismiss, onClosed, depth, trigger }) {
  const wrapRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [up, setUp] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const [swung, setSwung] = useState(false);
  // WHICH FACE OF THE CARD IS TOWARD THE VIEWER. Not a duplicate of `swung` —
  // `swung` is where the paper is GOING, this is what has actually turned past
  // edge-on, and the two are half a swing apart.
  //
  // It exists because nothing about 3D could be made to hide the card's own
  // face while it lies folded. `backface-visibility` on the panel, on a wrapper
  // around it, and on the blank cover were all tried and all MEASURED not to
  // work: the hinge is the root of its own 3D context (its parent flattens it,
  // to hold the camera), so a backface test inside it never sees the hinge's
  // own 180 and every layer reports itself front-facing. Photographed
  // 2026-08-11: with the card folded, its rows painted over the cover reading
  // "sgnitteS" — the words of the fly-out's own first row, mirrored. Four
  // earlier rounds all failed because they went after the parent's TITLE face,
  // which was never the thing on screen.
  //
  // So the swap is done in the open, on the fold's own clock: at SWING / 2 the
  // card is exactly edge-on and NOTHING of it is visible, which is the one
  // instant a hard cut cannot be seen. Same instant in both directions.
  const [faceUp, setFaceUp] = useState(false);
  useEffect(() => {
    if (depth === 0) return undefined;
    const t = setTimeout(() => setFaceUp(swung), SWING / 2);
    return () => clearTimeout(t);
  }, [swung, depth]);
  // Whether the card's LEFT side (the underside, below) is lit accent. Opening,
  // it always is — the highlight is the row handing itself to the card. Closing,
  // only if the hand is still on the row it is folding back onto, which is the
  // hover the row itself cannot show while the card covers it. User-directed
  // 2026-08-11. Read once per direction change, off the real cursor and the
  // trigger's real rect; `swung` is the only thing that says which way we are
  // going, so it is the only thing this watches.
  const [hot, setHot] = useState(true);
  useEffect(() => {
    if (depth === 0) return;
    setHot(swung || cursorOver(trigger));
  }, [swung, depth, trigger]);
  // The row's real box, for the face that lies on it — see the underside below.
  // Read from the live element rather than taken from `anchor`, which carries
  // only where the card goes, and never in a constant: the row height is a
  // candy row's own, and it moves with the theme's density.
  const [tbox, setTbox] = useState(null);
  useLayoutEffect(() => {
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    setTbox({ w: r.width, h: r.height });
  }, [trigger]);
  // Which side of the parent row this card ended up on. The door has to hinge on
  // the edge it is ATTACHED to, so a card flipped to the parent's left swings off
  // its RIGHT edge — see the door's style. Invisible until 2026-08-10, when the
  // swing started painting at all.
  const [flip, setFlip] = useState(false);
  const [flyout, setFlyout] = useState(null); // { index, rect, items, face }

  const { rows, selected, kids } = normalize(items);

  useLayoutEffect(() => {
    const stack = wrapRef.current?.querySelector('[role="menu"]');
    if (!stack) return;
    const w = stack.offsetWidth + FOLD_PAD * 2;
    const h = stack.offsetHeight + FOLD_PAD * 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // A fly-out starts at its parent row's right edge and flips to the parent's
    // left when there is no room; the root starts at the cursor.
    let left = anchor.x;
    let right = null;
    let flipped = false;
    if (left + w + PAD > vw) {
      // A FLIPPED card is anchored by its RIGHT edge, not by a left computed as
      // `flipX - w`. `w` is an ESTIMATE — the stack plus two pads — and the box
      // that actually gets folded is the hinge's, which is FoldMenu's shut stub
      // and a few px wider. Subtracting the wrong width from flipX put the whole
      // flipped card 9.3px off the row it folds onto (measured 2026-08-11, face
      // 242.8->390.2 against a row at 252.1->399.6). Anchored by the right edge,
      // the seam sits on flipX whatever the card measures, and the 180 lands it
      // on the row by construction — same guarantee the rightward case gets from
      // `left = anchor.x`. The estimate is still fine for the two things it is
      // asked here: does it FIT, and would flipping run off the other edge.
      if (anchor.flipX != null && anchor.flipX - w >= PAD) {
        flipped = true;
        left = null;
        right = vw - anchor.flipX;
      } else if (anchor.flipX != null) { left = PAD; } else left = vw - w - PAD;
    }
    setFlip(flipped);
    setPos(flipped
      ? { right, top: Math.max(PAD, anchor.y) }
      : { left: Math.max(PAD, left), top: Math.max(PAD, anchor.y) });
    // Row 0 stays on the anchor in both directions — only the stack below it
    // changes side — so this is purely "which way is there room for".
    setUp(anchor.y + h + PAD > vh && anchor.y - h > PAD);
  }, [items, anchor.x, anchor.y]);

  // Unfold on the frame AFTER the stack has been placed, so nothing is ever
  // seen folding at the wrong spot. A fly-out waits out its door swing first.
  useEffect(() => {
    if (!pos || !open) return undefined;
    if (depth === 0) {
      const r = requestAnimationFrame(() => setUnfolded(true));
      return () => cancelAnimationFrame(r);
    }
    const r = requestAnimationFrame(() => setSwung(true));
    const t = setTimeout(() => setUnfolded(true), SWING);
    return () => { cancelAnimationFrame(r); clearTimeout(t); };
  }, [pos, open, depth]);

  // The whole tree shuts together: fold the rows back up and let the door swing
  // closed behind them.
  //
  // A menu dismissed before it ever unfolded (a click landing in the same frame
  // as the right-click) has no close to play, and FoldMenu correctly reports
  // nothing — so report it here instead, or the host waits on an onClosed that
  // never comes and the menu stays mounted forever.
  const unfoldedRef = useRef(false);
  unfoldedRef.current = unfolded;
  useEffect(() => {
    // A second right-click while a menu is up re-uses this instance with fresh
    // props, so a stale fly-out is dropped on the RE-ARM. It used to be dropped
    // at the start of the close instead, which unmounted the card on frame one
    // and threw away the close it was about to play.
    if (open) { setFlyout(null); return; }
    if (!unfoldedRef.current) { onClosed?.(); return; }
    // Rows fold up first; the door swings shut behind them, off the fold's OWN
    // onClosed rather than a second clock here (see the FoldMenu below). The
    // fly-out stays mounted for all of it — the tree is unmounted by the root's
    // onClosed, which is always the last to fire because the root has the most
    // rows to fold.
    setUnfolded(false);
  }, [open]);

  // `face` is the parent row's OWN label node, handed to the child fold as its
  // shut face (FoldMenu paints it on row 1's underside — the one face a shut
  // stack shows). So the words are on screen for the first beat of the unfold
  // and the last beat of the fold, and gone in between, exactly as the account
  // chip in Settings → Dev holds its name and avatar across the same two beats.
  // That parity is the spec: user-directed 2026-08-10, "1 side needs the quick
  // actions text… look at how the dev tab settings foldmenu buttons show the
  // username and pfp during the first unfold and on the last fold".
  //
  // Only the card's UNDERSIDE is blank — see the door below. It pins nothing:
  // this face is what keeps the fly-out as wide as the row it peeled off.
  //
  // The row TOGGLES its own fly-out (user-directed 2026-08-10). A second click
  // does not unmount it — it flips `open` false and the card plays its own close
  // (rows fold up, then the door swings shut) and reports back through
  // `onClosed`, which is the only thing that clears it. Dropping the state on
  // the click instead would make it vanish on frame one, which is the bug this
  // file already fixed once for the whole-menu close.
  const openFlyout = (i, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // `el` is the row itself, kept so the card can hit-test the real cursor
    // against the real button when it folds back — see `hot`.
    const fresh = { index: i, rect, el: e.currentTarget, items: kids.get(i), face: rows[i].label, open: true };
    setFlyout((cur) => {
      if (!cur || cur.index !== i) return fresh;
      // Clicking a card that is already folding away brings it straight back,
      // rather than making you wait out a close you just interrupted.
      return cur.open === false ? fresh : { ...cur, open: false };
    });
  };

  // Wire each parent row's click to its own fly-out. normalize() cannot do this
  // — it has no idea where the row will land.
  //
  // A row whose card is OUT goes blank, and stays blank until the card has
  // finished folding back — `flyout` is cleared by the child's onClosed, which is
  // the instant the card lands, so the words come back underneath it rather than
  // beside it. That is the whole read of the gesture: the words were LIFTED OFF
  // this button and carried to the fly-out, leaving an empty button behind to
  // click again. User-directed 2026-08-11.
  //
  // Hidden, not removed, and hidden the same way the card's blank side is: this
  // row is the widest thing in some menus, and dropping its label would resize
  // the whole stack the moment a card opened. `display: contents` keeps the
  // wrapper out of the layout entirely so the words go on sizing the row.
  //
  // `rows`, not `wired`, is what openFlyout hands the card (`rows[i].label`), so
  // the card still gets the REAL words — blanking here cannot reach it.
  const wired = rows.map((r, i) => {
    if (!kids.has(i)) return r;
    const lifted = flyout && flyout.index === i;
    return {
      ...r,
      onClick: (e) => openFlyout(i, e),
      label: lifted
        ? <span style={{ display: 'contents', visibility: 'hidden' }}>{r.label}</span>
        : r.label,
    };
  });

  const node = (
    <div
      ref={wrapRef}
      // What "inside the menu" means to the dismissal listener, and to the
      // provider's native-menu suppressor.
      data-ctx-fold=""
      onContextMenu={(e) => {
        // Right-clicking the menu itself must not stack a second menu on top.
        e.preventDefault();
        if (e.nativeEvent) e.nativeEvent.__agenticCtxHandled = true;
      }}
      style={{
        position: 'fixed',
        // Left OR right, never both — a flipped card hangs off its right edge so
        // that the seam lands on the row whatever the card measures. See the
        // placement effect.
        left: pos ? (pos.left != null ? pos.left : 'auto') : -9999,
        right: pos && pos.right != null ? pos.right : 'auto',
        top: pos ? pos.top : -9999,
        zIndex: 9999,
        // Placed but not yet measured = never shown. visibility, not display:
        // the stack has to be laid out for the measurement to exist at all.
        visibility: pos ? 'visible' : 'hidden',
        ['--accent']: accent,
        // Only a fly-out folds. The camera lives on the wrapper so the panel has
        // depth without touching the fold's own camera inside it — and it is
        // FoldMenu's camera, not a second one, so a fly-out folding beside a row
        // and the row itself are seen from the same distance.
        ...(depth > 0 ? { perspective: FOLD_PERSPECTIVE } : null),
      }}
    >
      {/* The fold. The hinge is the SEAM — the middle of the FOLD_PAD gap the
          card is anchored across, not the card's own edge, exactly as FoldMenu
          hinges a row on the middle of the gap to its neighbour rather than on
          its own top edge (`HINGE_Y`). Hinging on the card's edge instead leaves
          the panel a whole half-gap from where the paper actually creases.
          The sign mirrors with the side, so the free edge always lifts toward
          the viewer whichever way the card flipped.
          preserve-3d is what gives this panel two real sides: without it the
          children are flattened into one plane and both faces paint at once. */}
      <div style={depth > 0 ? {
        // The underside below hangs off this box, so it has to be the one that
        // positions it — the only other positioned ancestor is the fixed
        // wrapper, and `inset: 0` against that fills the viewport.
        position: 'relative',
        transformOrigin: flip
          ? `calc(100% + ${FOLD_PAD / 2}px) center`
          : `${-FOLD_PAD / 2}px center`,
        transform: `rotateY(${swung ? 0 : (flip ? -SHUT_ANGLE : SHUT_ANGLE)}deg)`,
        transition: `transform ${SWING}ms ease-in-out`,
        transformStyle: 'preserve-3d',
      } : undefined}>
        {/* The card's FRONT. Not drawn at all while the card lies face-down —
            see `faceUp`. `visibility`, not `display`: the stack still has to be
            laid out while it is hidden, because the placement above measures
            the real `[role="menu"]` box before anything is shown. */}
        <div style={{
          transformStyle: 'preserve-3d',
          visibility: depth > 0 && !faceUp ? 'hidden' : 'visible',
        }}>
        <FoldMenu
          noTrigger
          up={up}
          open={unfolded}
          onRequestClose={onDismiss}
          // This menu belongs to the pointer — it was opened AT it — so it gets
          // inhaled back into it, tracking the cursor if it moves mid-close.
          suckToCursor
          // Levels are SIBLINGS (each portals to document.body), so the root's
          // transform does not carry its fly-out — every level sucks itself and
          // they all converge on the same live point. A level holding an open
          // child waits for it: deepest first, root last. Only two levels ever
          // exist in the real tree, so "has an open child" IS depth-from-bottom.
          suckDelay={flyout && flyout.open !== false ? SUCK_STAGGER : 0}
          // A fly-out owns the second half of its own close: the rows fold up on
          // the fold's clock, and this is the instant they finish — the panel
          // folds back from here, so the two beats cannot drift. The host is
          // told the level is FINISHED only once it has landed, or a toggled-off
          // fly-out unmounts mid-fold. SWING is FoldMenu's own DUR, so this is
          // not a second clock for someone else's motion.
          onClosed={depth > 0
            ? () => { setSwung(false); setTimeout(() => onClosed?.(), SWING); }
            : onClosed}
          items={wired}
          selected={selected}
          rowH={ROW_H}
          shape="row"
          faceStyle={FACE}
          ariaLabel={typeof title === 'string' ? title : 'Menu'}
        >
          {/* The card's RIGHT-HAND side, seen for the second half of the swing
              and the first beat of the rows. It is BLANK by spec (user-directed
              2026-08-11: "the left side to say quick actions and the right side
              to be blank"). The words still have to be RENDERED, though — this
              face is pin 2 of the fold's width, the one thing holding a fly-out
              as wide as the row it peeled off, and he rejected letting it
              shrink. `visibility: hidden` measures and does not paint; dropping
              the node instead would take the width with it. */}
          {/* `display: contents` is LOAD-BEARING: a plain inline wrapper here is
              a box of its own, and it made the card 150.7 wide against a 147.5
              row — 3.2px of paper that the fold, pinned at the seam, hung off
              the LEFT, so the card landed beside the row and then vanished
              ("looks like the folded button snaps to its correct position").
              With `contents` the wrapper has no box at all and the words size
              the face exactly as they did before they were hidden. */}
          <span style={{ display: 'contents', visibility: 'hidden' }}>{title}</span>
        </FoldMenu>
        </div>
        {/* The card's BACK — the face lying on the parent row for the whole
            swing, and the ONLY thing drawn while `faceUp` is false. It carries
            the parent row's own words, which is the spec: user-directed
            2026-08-10, "1 side needs the quick actions text… look at how the dev
            tab settings foldmenu buttons show the username and pfp during the
            first unfold and on the last fold". The blank side is the other one —
            it faces away and is never seen.
            The `rotateY(180)` is what makes those words READ. This face lives
            inside the hinge, so while the card is folded the hinge's own 180 is
            mirroring everything in here; a second 180 composes to identity and
            the text comes out the right way round. It must be a ROTATION, not
            `scaleX(-1)`: a mirror flips the facing too, which shipped once and
            hid both faces at rest ("the exact same as before with 40%
            missing").
            It swaps with the front at SWING / 2 — see `faceUp`. `visibility`
            rather than a backface rule, because backface rules do not work in
            here at all; every variant was tried and photographed failing.
            aria-hidden: the real card carries the accessible tree. */}
        {depth > 0 && (
          <span aria-hidden className={`candy-btn${hot ? ' is-active' : ''}`} data-shape="row" style={{
            // SIZED OFF THE ROW IT LIES ON, not off the card. `inset: 0` filled
            // the hinge, and the hinge is as wide as FoldMenu's shut STUB, which
            // is styled as a chip (its own font, its own 8px padding) and pays no
            // attention to the rows' faceStyle — measured 150.7 against a 147.5
            // row. The fold mirrors about the seam, so the card's far edge lands
            // on the row's far edge and every extra pixel hangs off the OTHER
            // side: "the fold lands slightly more left than the original quick
            // actions button - then disappears, which makes it look like the
            // folded button snaps to its correct position" (2026-08-11).
            // Reading the trigger's real rect is the only thing that cannot
            // drift: the row is the target, so the row is what gets measured.
            // Anchored on the hinge's own edge — the LEFT one normally, the
            // RIGHT one when the card flipped — because that is the edge the
            // 180 maps onto the row.
            position: 'absolute', top: 0, display: 'block',
            ...(flip ? { right: 0 } : { left: 0 }),
            width: tbox ? tbox.w : '100%',
            height: tbox ? tbox.h : '100%',
            pointerEvents: 'none',
            transform: 'rotateY(180deg)',
            visibility: faceUp ? 'hidden' : 'visible',
          }}>
            {/* height: 100% is LOAD-BEARING. This face is the layer that PAINTS
                — the shell around it is transparent — and one with no text has
                no line box, so it collapsed to zero and painted nothing. */}
            <span className="candy-face" style={{ ...FACE, height: '100%' }}>{title}</span>
          </span>
        )}
      </div>
    </div>
  );

  return (
    <>
      {createPortal(node, document.body)}
      {flyout && (
        <Level
          depth={depth + 1}
          // The child hangs off the parent row's right edge, its own row 0
          // level with that row. flipX is the parent stack's left edge, which is
          // where it goes when the window runs out on the right.
          anchor={{
            x: flyout.rect.right + FOLD_PAD,
            y: flyout.rect.top,
            flipX: flyout.rect.left - FOLD_PAD,
          }}
          items={flyout.items}
          title={flyout.face}
          accent={accent}
          trigger={flyout.el}
          // Shut when the whole tree shuts, OR when its own row toggled it off.
          open={open && flyout.open !== false}
          onDismiss={onDismiss}
          // Cleared only once the close has fully played — see openFlyout.
          onClosed={() => setFlyout(null)}
        />
      )}
    </>
  );
}

export default function ContextMenuRoot({ point, items = [], opts = {}, onClose }) {
  const [open, setOpen] = useState(true);
  const accent = opts.accent || 'var(--accent)';

  // A second right-click while a menu is up re-uses this instance with fresh
  // props — re-arm it rather than leaving a shut fold on screen.
  useEffect(() => { setOpen(true); }, [items, point && point.x, point && point.y]);

  // The ONE dismissal owner for the tree (see the file header). Capture phase so
  // a surface that stops propagation on its own keys cannot swallow Escape.
  useEffect(() => {
    const dismiss = () => setOpen(false);
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      dismiss();
    }
    function onDown(e) {
      // Every level portals into <body>, so "inside" means inside any of the
      // menu's own fixed wrappers.
      if (e.target.closest && e.target.closest('[data-ctx-fold]')) return;
      dismiss();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, []);

  if (!point) return null;

  return (
    <Level
      depth={0}
      anchor={{ x: point.x, y: point.y }}
      items={items}
      title={opts.header}
      accent={accent}
      open={open}
      onDismiss={() => setOpen(false)}
      // Unmount only once the close has PLAYED — dropping the menu on the click
      // would cut the fold off mid-flight.
      onClosed={onClose}
    />
  );
}
