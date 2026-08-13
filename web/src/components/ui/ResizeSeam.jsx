// ResizeSeam — the app's ONE resize divider. Every resizable split runs through
// this: the left nav sidebar, the right toolkit rail, the Settings rail, and the
// Planner's calendar and health seams.
//
// Was `components/SidebarSeam.jsx` (2026-05-21 nav rebuild). Reworked
// 2026-08-11 (Resize Seam Rework) on three user-reported defects:
//
//   1. The accent line painted ~2px BESIDE the rail divider instead of on it.
//      It was pinned at a hardcoded `left: (HOTZONE - SEAM_WIDTH) / 2`, but the
//      divider is a 1px `border` belonging to a NEIGHBOUR element and sits at a
//      different offset at every call site. It is measured now — see
//      dividerX(). Restating it as a constant is what caused the bug.
//   2. The width chooser was a hand-rolled pill list with its own hover colours.
//      It is a real FoldMenu now — the app's dropdown, candy rows and all.
//   3. Each call site declared five `snapTargets` 40px apart, unrelated to its
//      three presets, so a drag ratcheted. The snap set IS the presets now.
//
// Behaviours kept from the original: magnetic seam affordance (invisible until
// the cursor enters a 6px hotzone, then a 2px accent line fades in over 120ms),
// an 80ms accent flash each time the drag crosses into a snap target, rubber-band
// overshoot at min/max that springs back on release, auto-collapse with width
// memory below `collapseThreshold`, double-click to reset, and persistence via
// `storageKey` (written on release or a menu pick, never during a drag).
//
// Cut in the rework: the px width badge, the Ctrl+0 reset (double-click still
// resets), the `snapTargets` prop, and the drag-time edge ring — with the line
// now dead on the divider, a second 1px accent 3px away read as a mistake.
//
// Round 2, 2026-08-13, five user-directed tweaks (all commented where they land):
//
//   1. The PANE trails the cursor on the same 120ms clock the menu always used,
//      for the whole drag rather than only inside a snap. `SNAP_EASE` and the
//      `onSnapChange` prop are gone with it — six hosts now just declare the
//      trail on their own transition and stopped tracking a snap flag.
//   2. Rows carry a glyph, like the right-click menu's do. See PRESET_ICON.
//   3. The menu is locked horizontally: its x freezes at the click.
//   4. The menu opens on a CLICK, not on hover.
//   5. The snap pull reaches 18px instead of 12.
//
// EVERYTHING VISIBLE IS A BODY PORTAL, including the accent line. Not tidiness:
// the seam's own ancestors clip it. CollapsibleRail owns an `overflow: hidden`
// (it keeps the expanded body mounted while collapsed) and the settings drawer
// hides overflow to draw its rounded corners — and a clip cuts at the PADDING
// box, i.e. inside the very border the line has to sit on top of. Fixed to the
// measured viewport coordinates instead, nothing can clip it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FoldMenu from './FoldMenu.jsx';
import { IconChevronLeft, IconChevronRight, IconDot } from '../icons.jsx';

const HOTZONE_PX  = 6;
const SEAM_WIDTH  = 2;
// 12 was too tight to find, 18 grabbed too eagerly — user-tuned to 12 + 2 on
// 2026-08-13. The ceiling is 20 regardless: the toolkit rail and the Planner
// health column both put their two closest presets 40px apart, so anything
// past that leaves no unsnapped width between them at all.
const SNAP_RADIUS = 14;
const RUBBER_MAX  = 28;
// Cursor to the paper's edge. FoldPaper reaches FOLD_PAD outside the rows, so
// the gap you actually see is this minus that.
const MENU_GAP    = 14;
// How long the cursor may be off BOTH the seam and the menu before it folds
// away — enough to travel the MENU_GAP between them.
const MENU_GRACE  = 150;
const ROW_H       = 28;

// The trail a dragged thing keeps behind the cursor, exported so all six hosts
// share one clock instead of six copies of a number. Property-less: a host
// applies it to `width` or to `flex-basis` depending on how it sizes itself,
// and the menu applies it to its own `transform`.
//
// It used to be snap-only (`SNAP_EASE`), 1:1 tracking everywhere else, and the
// menu trailed on a separate 120ms of its own — so the pane and the menu moved
// on two different clocks and only agreed by accident inside a snap. One
// constant, one curve, applied for the WHOLE drag: user-directed 2026-08-13,
// "the same drag the menu has, on the actual left-to-right resizing as well".
// 120ms `ease` was measurably a trail but did not READ as one: mid-motion it
// looked right, and the moment the cursor stopped the pane covered the leftover
// gap in a twelfth of a second, which the eye files as a snap rather than a
// glide. The arrival is the only part anyone watches, so it is long and
// decelerating — a hard ease-out that spends most of its time near the end.
// User-reported 2026-08-13, "it snaps to its new position rather than smoothly
// gliding there".
export const DRAG_EASE = '260ms cubic-bezier(0.22, 1, 0.36, 1)';

// A glyph per preset, keyed on the label, the same way `context-menu/menuIcons`
// keys the right-click rows — the labels are Compact / Default / Wide at every
// seam in the app, so one table covers all six. The mark IS the width it sets:
// chevrons facing IN for narrow, OUT for wide, a dot between them.
// User-directed 2026-08-13, matching the right-click menu's icon-and-words rows.
//
// Built from the two SINGLE chevrons rather than the `IconChevrons*` pair
// icons: those are Font Awesome's angles-up / angles-down, i.e. two chevrons
// pointing the SAME way (collapse-all / expand-all), which turned on their side
// read as two arrows both pointing left. There is no in/out pair in the pack.
const PRESET_ICON = {
  Compact: <><IconChevronRight size={9} /><IconChevronLeft size={9} /></>,
  Default: <IconDot size={9} />,
  Wide:    <><IconChevronLeft size={9} /><IconChevronRight size={9} /></>,
};

// Same block-level flex wrapper the context menu's rows use, for the same
// reason: an inline wrapper sits on a text line and prints its content ~1.6px
// high inside FoldMenu's centred row.
function rowFace(label) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
      <span style={{
        width: 14, flexShrink: 0, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {PRESET_ICON[label] || <IconDot size={9} />}
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  );
}

// The context menu's own row type, restated here for the same reason it is
// restated there: FoldMenu's face defaults to the titlebar account chip's mono
// 11.5, which is right for a chip and wrong for a menu row.
const FACE = {
  fontFamily: 'var(--font-body)',
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: 0,
  textTransform: 'none',
  padding: '0 12px',
  alignItems: 'center',
  justifyItems: 'stretch',
};

function rubberBand(over) {
  return RUBBER_MAX * (1 - Math.exp(-over / 50));
}

/**
 * Where the REAL rail divider is, in viewport x.
 *
 * The divider is a 1px `border` on a NEIGHBOUR — sometimes the pane before the
 * seam (Settings rail: `borderRight`), sometimes the pane after it (AppShell
 * toolkit: `borderLeft`), and sometimes an ANCESTOR, because the left sidebar's
 * seam is absolutely positioned inside the rail it resizes (Sidebar.jsx). All
 * three land the line in a different place, which is exactly why the old
 * hardcoded offset was wrong at every call site at once.
 *
 * Read every frame the seam is visible, never cached: the seam MOVES while you
 * drag it, and the rail eases into a snap under its own transition.
 */
function dividerX(el) {
  const r = el.getBoundingClientRect();
  const mid = r.left + r.width / 2;
  const found = [];
  const edge = (x) => { if (Number.isFinite(x)) found.push(x); };

  const prev = el.previousElementSibling;
  const next = el.nextElementSibling;
  if (prev) {
    const w = parseFloat(getComputedStyle(prev).borderRightWidth) || 0;
    if (w) edge(prev.getBoundingClientRect().right - w / 2);
  }
  if (next) {
    const w = parseFloat(getComputedStyle(next).borderLeftWidth) || 0;
    if (w) edge(next.getBoundingClientRect().left + w / 2);
  }
  // Only if no sibling owns one. Nearest ancestor wins and the walk stops there
  // — a modal's own frame is a border too, and it is not this seam's divider.
  for (let a = el.parentElement; a && !found.length; a = a.parentElement) {
    const cs = getComputedStyle(a);
    const ar = a.getBoundingClientRect();
    const rw = parseFloat(cs.borderRightWidth) || 0;
    const lw = parseFloat(cs.borderLeftWidth) || 0;
    if (rw) edge(ar.right - rw / 2);
    if (lw) edge(ar.left + lw / 2);
  }

  // Closest to the seam's own centre, and only if it is plausibly THIS seam's
  // divider. A candidate further than the hotzone belongs to something else
  // (the Planner's two seams have no divider at all) — centre the line on the
  // seam, which is what it should always have been in that case.
  const best = found.reduce(
    (b, x) => (b == null || Math.abs(x - mid) < Math.abs(b - mid) ? x : b),
    null,
  );
  return best != null && Math.abs(best - mid) <= HOTZONE_PX ? best : mid;
}

/**
 * What z-index a body portal needs to sit exactly where this seam sits.
 *
 * The hit strip is portaled to `document.body`, which throws away every
 * stacking context it was born in — and one constant cannot serve all six
 * seams. The left sidebar's strip must stay UNDER an open modal (1000) or it
 * steals a 12px column of it; the Planner's two seams live INSIDE that modal
 * and must sit above it. So it is read off the real ancestor chain rather than
 * picked: the highest z-index above the seam, plus one.
 */
function stackZ(el) {
  let z = 4;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const v = parseInt(getComputedStyle(a).zIndex, 10);
    if (Number.isFinite(v)) z = Math.max(z, v + 1);
  }
  return z;
}

export default function ResizeSeam({
  width,
  onWidthChange,
  accent,
  defaultWidth,
  minWidth,
  maxWidth,
  collapseThreshold = 0,
  collapsed = false,
  onCollapse,
  onUncollapse,
  onDragStart,
  onDragEnd,
  // The three width options. Doubles as the snap set — there is no second list.
  presets = [],
  storageKey,
  ariaLabel = 'Resize sidebar',
  // The pane this seam resizes is to its RIGHT (dragging left grows it). Drives
  // the delta sign AND which way the menu unfolds — a menu that opened over the
  // rail it is resizing would cover the thing you are looking at.
  inverted = false,
  style: outerStyle,
}) {
  const [hover, setHover] = useState(false);
  const [menuHover, setMenuHover] = useState(false);
  // The fold is CLICK-opened now, not hover-opened — a hover-opened menu popped
  // up every time the cursor crossed the seam on its way somewhere else.
  // User-directed 2026-08-13. It still folds away on its own once the cursor
  // leaves both it and the seam, so the ways OUT are unchanged.
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  // Frozen at the click. The menu tracks the cursor vertically only, so its x
  // must not be re-read from a moving cursor — that is what let it slide
  // sideways during a drag. User-directed 2026-08-13, "locked horizontally".
  const anchorXRef = useRef(0);
  const [pulseTick, setPulseTick] = useState(0);
  const [pulseFlash, setPulseFlash] = useState(false);
  // The line's live geometry: viewport top/height of the seam plus the measured
  // divider x. Refreshed every frame while the seam is showing.
  const [line, setLine] = useState(null);
  const dragStateRef = useRef(null);
  const lastSnappedRef = useRef(null);
  const seamRef = useRef(null);
  const hitRef = useRef(null);
  const accentColor = accent || 'var(--text)';
  const snapSet = presets.map(p => p.value);

  const persist = useCallback((v) => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, String(v)); } catch {}
  }, [storageKey]);

  useEffect(() => {
    if (!pulseTick) return;
    setPulseFlash(true);
    const t = setTimeout(() => setPulseFlash(false), 80);
    return () => clearTimeout(t);
  }, [pulseTick]);

  const visible = hover || dragging || menuOpen;

  // The ways out, all four wired to the same close: cursor gone from BOTH the
  // seam and the menu for MENU_GRACE, Escape, a pointer down anywhere else, or
  // a second click on the seam (in onUp below). Picking a row closes too.
  useEffect(() => {
    if (!menuOpen) return undefined;
    if (hover || menuHover || dragging) return undefined;
    const t = setTimeout(() => setMenuOpen(false), MENU_GRACE);
    return () => clearTimeout(t);
  }, [menuOpen, hover, menuHover, dragging]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    const onDown = (e) => {
      if (hitRef.current?.contains(e.target)) return;
      if (e.target.closest?.('[data-seam-fold]')) return;
      setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // Capture: a row's own click must still land, but a pointer down on some
    // other control should close this before that control reacts.
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [menuOpen]);

  // Measure while showing. A rAF loop rather than a one-shot read, because the
  // seam travels with the pane during a drag and keeps travelling afterwards
  // while the pane eases into its snap — a cached rect strands the line.
  const measure = useCallback(() => {
    const el = seamRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setLine({ top: r.top, height: r.height, x: dividerX(el), z: stackZ(el) });
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    let raf = 0;
    const tick = () => { measure(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, measure]);
  // And once whenever the pane resizes or the window does, because the HIT
  // STRIP below is positioned off this measurement and exists before anything
  // is hovered — the rAF loop above only runs once the seam is already showing,
  // which is a hover the strip is what delivers.
  useLayoutEffect(() => { measure(); }, [measure, width, collapsed]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const snapIfNear = useCallback((raw) => {
    for (const t of snapSet) {
      if (Math.abs(raw - t) <= SNAP_RADIUS) return { value: t, snapped: true };
    }
    return { value: raw, snapped: false };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapSet.join(',')]);

  const onPointerDown = useCallback((e) => {
    if (collapsed) return;
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: width, moved: false };
    setDragging(true);
    lastSnappedRef.current = null;
    onDragStart?.();

    const onMove = (ev) => {
      // For a seam whose pane is on its RIGHT (`inverted`), leftward cursor
      // motion GROWS the pane — invert the delta so the snap/rubberband/persist
      // maths below stays direction-agnostic.
      const rawDx = ev.clientX - dragStateRef.current.startX;
      const dx = inverted ? -rawDx : rawDx;
      let raw = dragStateRef.current.startWidth + dx;
      setCursor({ x: ev.clientX, y: ev.clientY });
      // Past this the gesture is a DRAG, not a click, so the pointer-up below
      // resizes instead of toggling the menu. 3px is the usual slop a hand
      // leaves on a deliberate click.
      if (Math.abs(rawDx) > 3) dragStateRef.current.moved = true;

      let snapped = false;
      if (collapseThreshold > 0 && raw < collapseThreshold) {
        const over = Math.max(0, minWidth - raw);
        raw = minWidth - rubberBand(over);
      } else if (raw < minWidth) {
        raw = minWidth - rubberBand(minWidth - raw);
      } else if (raw > maxWidth) {
        raw = maxWidth + rubberBand(raw - maxWidth);
      } else {
        const hit = snapIfNear(raw);
        snapped = hit.snapped;
        if (snapped) {
          if (lastSnappedRef.current !== hit.value) {
            setPulseTick(k => k + 1);
            lastSnappedRef.current = hit.value;
          }
          raw = hit.value;
        } else {
          lastSnappedRef.current = null;
        }
      }
      onWidthChange(raw);
    };

    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragging(false);
      onDragEnd?.();

      // A click, not a drag: toggle the fold and touch nothing else. Returning
      // before the snap below matters — SNAP_RADIUS is 18px now, so running a
      // click through it would silently resize a pane nobody dragged.
      if (!dragStateRef.current.moved) {
        // Anchored on the MEASURED divider, not on where the click landed —
        // the hotzone is 12px wide, so anchoring on the click made the menu
        // pop up in a different place every time. User-reported 2026-08-13.
        anchorXRef.current = seamRef.current ? dividerX(seamRef.current) : ev.clientX;
        setCursor({ x: ev.clientX, y: ev.clientY });
        setMenuOpen(o => !o);
        return;
      }

      const rawDx = ev.clientX - dragStateRef.current.startX;
      const dx = inverted ? -rawDx : rawDx;
      const raw = dragStateRef.current.startWidth + dx;

      if (collapseThreshold > 0 && raw < collapseThreshold && onCollapse) {
        // Preserve the pre-drag width; the collapse path doesn't persist a new
        // width — the next expand restores `startWidth`.
        onWidthChange(dragStateRef.current.startWidth);
        onCollapse();
        return;
      }

      let final = Math.max(minWidth, Math.min(maxWidth, raw));
      final = snapIfNear(final).value;
      onWidthChange(final);
      persist(final);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [collapsed, width, minWidth, maxWidth, snapIfNear, collapseThreshold,
    onCollapse, onWidthChange, persist, onDragStart, onDragEnd, inverted]);

  const onDoubleClick = useCallback(() => {
    if (collapsed || defaultWidth == null) return;
    onWidthChange(defaultWidth);
    persist(defaultWidth);
  }, [collapsed, defaultWidth, onWidthChange, persist]);

  const pickPreset = useCallback((v) => {
    onWidthChange(v);
    persist(v);
    setMenuOpen(false);
  }, [onWidthChange, persist]);

  // Collapsed: a thin clickable expand strip instead of the drag seam. Clicking
  // it restores the pane to its remembered expanded width.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onUncollapse}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        style={{
          width: HOTZONE_PX,
          alignSelf: 'stretch',
          flexShrink: 0,
          position: 'relative',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'e-resize',
        }}
        onMouseEnter={e => {
          const inner = e.currentTarget.querySelector('[data-seam-inner]');
          if (inner) inner.style.opacity = '1';
        }}
        onMouseLeave={e => {
          const inner = e.currentTarget.querySelector('[data-seam-inner]');
          if (inner) inner.style.opacity = '0';
        }}
      >
        <span
          aria-hidden
          data-seam-inner
          style={{
            position: 'absolute',
            top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 2, height: 24,
            background: accentColor,
            borderRadius: 1,
            opacity: 0,
            transition: 'opacity 120ms ease',
          }}
        />
      </button>
    );
  }

  return (
    <>
      {/* Layout only — it holds the seam's place in the flex row and is what
          dividerX() walks from. It cannot be the hit target: it sits entirely
          on ONE side of the divider (the left sidebar's is 273..279 against a
          divider at 279.5), so every pixel of grab space was on the left and
          none on the right, and it cannot grow rightward either — the rail's
          own overflow:hidden clips it, the same clip that forced the accent
          line into a portal. User-reported 2026-08-13, "i'm able to click more
          to the left of the line but not at all to the right". */}
      <div
        ref={seamRef}
        aria-hidden
        style={{
          width: HOTZONE_PX,
          alignSelf: 'stretch',
          flexShrink: 0,
          position: 'relative',
          zIndex: 4,
          pointerEvents: 'none',
          ...outerStyle,
        }}
      />

      {/* The real control: HOTZONE_PX of grab space either side of the measured
          divider, portaled so nothing can clip it. */}
      {line && createPortal(
        <div
          ref={hitRef}
          onMouseEnter={(e) => { setCursor({ x: e.clientX, y: e.clientY }); measure(); setHover(true); }}
          onMouseLeave={() => setHover(false)}
          // Tracked before a drag as well as during one, so the menu can follow
          // the cursor the moment it appears.
          onPointerMove={(e) => { if (!dragging) setCursor({ x: e.clientX, y: e.clientY }); }}
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
          role="separator"
          aria-orientation="vertical"
          aria-label={ariaLabel}
          title="Drag to resize · double-click to reset"
          style={{
            position: 'fixed',
            top: line.top,
            height: line.height,
            left: line.x - HOTZONE_PX,
            width: HOTZONE_PX * 2,
            cursor: 'col-resize',
            background: 'transparent',
            zIndex: line.z,
          }}
        />,
        document.body,
      )}

      {/* The line. Always mounted so it can FADE rather than pop, and fixed to
          the measured divider so no ancestor's overflow clip can eat it. */}
      {line && createPortal(
        <div aria-hidden style={{
          position: 'fixed',
          top: line.top,
          height: line.height,
          left: line.x - SEAM_WIDTH / 2,
          width: SEAM_WIDTH,
          background: accentColor,
          borderRadius: 1,
          pointerEvents: 'none',
          zIndex: 1200,
          opacity: visible ? 1 : 0,
          boxShadow: pulseFlash
            ? `0 0 0 4px color-mix(in oklch, ${accentColor} 42%, transparent)`
            : dragging
              ? `0 0 0 3px color-mix(in oklch, ${accentColor} 60%, transparent)`
              : 'none',
          transition: dragging
            ? 'box-shadow 80ms ease'
            : 'opacity 120ms ease, box-shadow 140ms ease',
        }}/>,
        document.body,
      )}

      {presets.length > 0 && (
        <SeamFold
          wanted={menuOpen}
          cursorY={cursor.y}
          anchorX={anchorXRef.current}
          mirror={inverted}
          presets={presets}
          value={Math.round(width)}
          onPick={pickPreset}
          onHoverChange={setMenuHover}
        />
      )}
    </>
  );
}

/**
 * The width chooser: a FoldMenu unfolded beside the point you CLICKED, following
 * the cursor up and down but never sideways, and staying up for the whole drag.
 *
 * `noTrigger` + controlled `open` is the same configuration the right-click menu
 * uses for a menu that opens AT A POINT — there is no button here to fold out
 * of, the stack is the whole control.
 *
 * `anchorX` is a frozen number, not a live cursor x. That is the whole of the
 * horizontal lock: the transform below reads y only.
 */
function SeamFold({ wanted, cursorY, anchorX, mirror, presets, value, onPick, onHoverChange }) {
  const wrapRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  // Half the OPEN stack's height, so the menu can sit centred on the cursor.
  // The FoldMenu root is only one row tall (the stack hangs off it absolutely),
  // so this has to come off the stack itself. A fold is a transform and
  // transforms do not touch layout, so the box is honest even while shut.
  const [half, setHalf] = useState(null);
  // The OPEN stack's width, for the same reason `half` exists and measured off
  // the same box. A mirrored fold used to be pulled back by `-100%`, but a
  // percentage resolves against this wrapper — and the wrapper is FoldMenu's
  // ONE-ROW root (~20px), not the 112px stack hanging off it absolutely. So a
  // leftward fold moved back 20px instead of 112 and painted straight over the
  // rail it was resizing. Photographed 2026-08-13; never seen before because no
  // mirrored seam had ever been opened on screen.
  const [stackW, setStackW] = useState(null);

  // Mount on demand; unmount only once the close has actually PLAYED (onClosed
  // below). No grace period here — the seam owns the whole close decision now,
  // including the cursor-left grace, so a second one here would just make every
  // dismissal 150ms late.
  useEffect(() => {
    if (wanted) setMounted(true);
    else setOpen(false);
  }, [wanted]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const stack = wrapRef.current?.querySelector('[role="menu"]');
    if (stack) { setHalf(stack.offsetHeight / 2); setStackW(stack.offsetWidth); }
  }, [mounted, presets.length]);

  // Unfold on the frame AFTER the stack has been measured and placed, so it is
  // never seen folding at the wrong spot — the same order the context menu uses.
  useEffect(() => {
    if (!mounted || half == null || !wanted) return undefined;
    const r = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(r);
  }, [mounted, half, wanted]);

  if (!mounted) return null;

  const selected = presets.findIndex(p => p.value === value);
  const items = presets.map(p => ({
    label: rowFace(p.label),
    onClick: () => onPick(p.value),
  }));

  return createPortal(
    <div
      ref={wrapRef}
      data-seam-fold
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      style={{
        position: 'fixed',
        top: 0,
        // Anchored on the side AWAY from the pane being resized. A rightward
        // menu grows from this x; a leftward one is pulled back by its own
        // width, which is the one thing the transform below has to know.
        left: mirror ? anchorX - MENU_GAP : anchorX + MENU_GAP,
        zIndex: 1300,
        // Vertical only, and the x above is a frozen click point rather than a
        // live cursor, so nothing can walk the menu sideways across the pane.
        transform: `translate3d(${mirror ? -(stackW || 0) : 0}px, ${cursorY - (half || 0)}px, 0)`,
        transition: `transform ${DRAG_EASE}`,
        // Hidden for the one frame between mounting and being measured — the
        // stack has to be laid out to be measured, and an unplaced stack would
        // otherwise flash at the top-left of the window.
        visibility: half == null || (mirror && stackW == null) ? 'hidden' : 'visible',
        // The rows own their own hit-testing; this wrapper must not swallow the
        // seam's drag when the cursor passes over the gap beside them.
        pointerEvents: 'none',
      }}
    >
      <div style={{ pointerEvents: 'auto', width: 'max-content' }}>
        <FoldMenu
          noTrigger
          open={open}
          // Deliberately NOT wired. FoldMenu dismisses itself on any mousedown
          // outside its own root, and the seam IS outside it — so starting a
          // drag folded the menu away on the first press, exactly when it is
          // meant to stay up and trail. The seam owns every close (cursor gone,
          // Escape, outside press, second click, row picked), and all five run
          // through `wanted`, so there is nothing left for this to do.
          onClosed={() => { setMounted(false); setHalf(null); setStackW(null); }}
          items={items}
          selected={selected}
          rowH={ROW_H}
          shape="row"
          faceStyle={FACE}
          minWidth={112}
          ariaLabel="Resize presets"
        />
      </div>
    </div>,
    document.body,
  );
}
