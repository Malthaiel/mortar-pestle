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
// EVERYTHING VISIBLE IS A BODY PORTAL, including the accent line. Not tidiness:
// the seam's own ancestors clip it. CollapsibleRail owns an `overflow: hidden`
// (it keeps the expanded body mounted while collapsed) and the settings drawer
// hides overflow to draw its rounded corners — and a clip cuts at the PADDING
// box, i.e. inside the very border the line has to sit on top of. Fixed to the
// measured viewport coordinates instead, nothing can clip it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FoldMenu from './FoldMenu.jsx';

const HOTZONE_PX  = 6;
const SEAM_WIDTH  = 2;
// Wider than the old 8px. There are only three targets now instead of five
// every 40px, so the pull has to be findable without hunting for it.
const SNAP_RADIUS = 12;
const RUBBER_MAX  = 28;
// Cursor to the paper's edge. FoldPaper reaches FOLD_PAD outside the rows, so
// the gap you actually see is this minus that.
const MENU_GAP    = 14;
// How long the cursor may be off BOTH the seam and the menu before it folds
// away — enough to travel the MENU_GAP between them.
const MENU_GRACE  = 150;
// The menu's vertical trail behind the cursor.
const TRAIL       = 120;
const ROW_H       = 28;

// The glide a pane takes INTO a snap target, exported so the five hosts share
// one clock instead of five copies of a number. Property-less: a host applies
// it to `width` or to `flex-basis` depending on how it sizes itself. Short and
// hard-out, because the whole distance is at most SNAP_RADIUS — the pane's
// resting 180ms would read as lag against a cursor that is still moving.
export const SNAP_EASE = '120ms cubic-bezier(0.16, 1, 0.3, 1)';

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
  // Told when the drag enters or leaves a snap target. The host uses it to let
  // the pane EASE the last few px into the target instead of jumping, while
  // still tracking the cursor 1:1 everywhere else — it cannot work that out on
  // its own, since all it ever sees is a stream of widths.
  onSnapChange,
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
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [pulseTick, setPulseTick] = useState(0);
  const [pulseFlash, setPulseFlash] = useState(false);
  // The line's live geometry: viewport top/height of the seam plus the measured
  // divider x. Refreshed every frame while the seam is showing.
  const [line, setLine] = useState(null);
  const dragStateRef = useRef(null);
  const lastSnappedRef = useRef(null);
  const seamRef = useRef(null);
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

  const visible = hover || dragging || menuHover;

  // Measure while showing. A rAF loop rather than a one-shot read, because the
  // seam travels with the pane during a drag and keeps travelling afterwards
  // while the pane eases into its snap — a cached rect strands the line.
  const measure = useCallback(() => {
    const el = seamRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setLine({ top: r.top, height: r.height, x: dividerX(el) });
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    let raf = 0;
    const tick = () => { measure(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, measure]);

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
    dragStateRef.current = { startX: e.clientX, startWidth: width };
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
      onSnapChange?.(snapped);
      onWidthChange(raw);
    };

    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragging(false);
      onSnapChange?.(false);
      onDragEnd?.();

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
    onCollapse, onWidthChange, persist, onDragStart, onDragEnd, onSnapChange, inverted]);

  const onDoubleClick = useCallback(() => {
    if (collapsed || defaultWidth == null) return;
    onWidthChange(defaultWidth);
    persist(defaultWidth);
  }, [collapsed, defaultWidth, onWidthChange, persist]);

  const pickPreset = useCallback((v) => {
    onWidthChange(v);
    persist(v);
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
      <div
        ref={seamRef}
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
          width: HOTZONE_PX,
          alignSelf: 'stretch',
          flexShrink: 0,
          cursor: 'col-resize',
          position: 'relative',
          zIndex: 4,
          ...outerStyle,
        }}
      />

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
          wanted={visible}
          cursor={cursor}
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
 * The width chooser: a FoldMenu unfolded beside the cursor, following it up and
 * down but never sideways, and staying up for the whole drag.
 *
 * `noTrigger` + controlled `open` is the same configuration the right-click menu
 * uses for a menu that opens AT A POINT — there is no button here to fold out
 * of, the stack is the whole control.
 */
function SeamFold({ wanted, cursor, mirror, presets, value, onPick, onHoverChange }) {
  const wrapRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  // Half the OPEN stack's height, so the menu can sit centred on the cursor.
  // The FoldMenu root is only one row tall (the stack hangs off it absolutely),
  // so this has to come off the stack itself. A fold is a transform and
  // transforms do not touch layout, so the box is honest even while shut.
  const [half, setHalf] = useState(null);

  // Mount on demand; unmount only once the close has actually PLAYED, or the
  // fold is cut off mid-flight.
  useEffect(() => {
    if (wanted) { setMounted(true); return undefined; }
    const t = setTimeout(() => setOpen(false), MENU_GRACE);
    return () => clearTimeout(t);
  }, [wanted]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const stack = wrapRef.current?.querySelector('[role="menu"]');
    if (stack) setHalf(stack.offsetHeight / 2);
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
  const items = presets.map(p => ({ label: p.label, onClick: () => onPick(p.value) }));

  return createPortal(
    <div
      ref={wrapRef}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      style={{
        position: 'fixed',
        top: 0,
        // Anchored on the side AWAY from the pane being resized. A rightward
        // menu grows from this x; a leftward one is pulled back by its own
        // width, which is the one thing the transform below has to know.
        left: mirror ? cursor.x - MENU_GAP : cursor.x + MENU_GAP,
        zIndex: 1300,
        // Vertical only. The x is set above and never moves again, so the trail
        // cannot drag the menu sideways across the pane.
        transform: `translate3d(${mirror ? '-100%' : '0px'}, ${cursor.y - (half || 0)}px, 0)`,
        transition: `transform ${TRAIL}ms ease`,
        // Hidden for the one frame between mounting and being measured — the
        // stack has to be laid out to be measured, and an unplaced stack would
        // otherwise flash at the top-left of the window.
        visibility: half == null ? 'hidden' : 'visible',
        // The rows own their own hit-testing; this wrapper must not swallow the
        // seam's drag when the cursor passes over the gap beside them.
        pointerEvents: 'none',
      }}
    >
      <div style={{ pointerEvents: 'auto', width: 'max-content' }}>
        <FoldMenu
          noTrigger
          open={open}
          onRequestClose={() => setOpen(false)}
          onClosed={() => { setMounted(false); setHalf(null); }}
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
