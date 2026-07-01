import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { playReorderPickup, playReorderDrop } from '../hooks/useTactileSound.js';
import { computeSlotY } from './dragMath.js';

// ── Drop-sequence invariants (the drop-flicker saga, 2026-07-01) ─────────────
// The drop is a multi-frame pipeline: clone glides to slot (glideMs) → commit
// (reorder + clone removal in one flushSync) → bridge (until the next real
// pointermove). Four invariants, each broken once before being written down:
//  1. ACCENT CONTINUITY — an accent-painted element sits under the cursor on
//     every painted frame: the clone (.is-dragging, → .is-drop-accent at glide
//     start) through the glide, then the bridged real tile (.is-drop-accent
//     via accentTileUnderCursor) after commit. :hover can't cover the swap (no
//     recompute without a real pointer move) and colour transitions must not
//     fade the restore in (the bridge CSS transitions transform ONLY). [997f927]
//  2. PRESS RELEASES ON THE CLONE — the real tile is never pressed, so the
//     clone eases its face up during the glide (the is-dragging →
//     is-drop-accent swap drops the pressed-face rule). A pressed clone
//     swapped for an unpressed tile is an instant snap. [251a0cf]
//  3. CLONE LANDS PIXEL-EXACT — computeSlotY (dragMath.js) must equal the
//     landed tile's real top INCLUDING the container's flex gap. Exhaustive
//     check: `npm run check-drag`; live: `window.dragAudit()`. [97612e8]
//  4. GLIDE TARGETS THE COMMITTED SLOT — dropIdx is pinned to `to` at release;
//     the mid-drag dropIdx is 60ms-throttled and can be one update stale. [97612e8]
// Touching this sequence or the candy tile CSS → run window.dragAudit() in the
// affected webview and paste its numbers (Close the Loop § browser-verify).

const HOLD_MS = 180;
// MOVE_THRESHOLD: cursor displacement (px) during the 180ms hold that aborts
// the long-press. Bumped from 6 to 10 in v0.7.4.3 — high-precision tap-to-click
// touchpads register tiny drift during a deliberate hold; the prior 6px window
// made the pill fail to lift on light holds (KI v0.7.0 + v0.7.3).
const MOVE_THRESHOLD = 10;
const GAP = 44;
const STATE_THROTTLE = 60;
// CURSOR_OFFSET: 4px nudge so the cursor remains visible inside the top-left
// of the dragged tile (DESIGN.md § Drag and drop).
const CURSOR_OFFSET = 4;
// SHIFT_THRESHOLD_FRACTION: how far into a stationary module (from its top) the
// cursor must travel before items shift to open the next slot. 0.5 = midpoint
// (legacy). 0.2 = items shift when cursor is 20% past module top — clone
// spends less time visibly overlapping a stationary item. The first non-source
// item keeps a midpoint trigger so dropping at the top of the rail stays
// reachable inside its bounds.
const SHIFT_THRESHOLD_FRACTION = 0.2;

function PlainDragTile({ sourceElement, originRect, originDisplay, cursorRef, slotY, isHorizontal = false, releasing = false, glideMs = 160, containerRef, grow = false }) {
  const hostRef = useRef(null);
  const cloneRef = useRef(null);
  const modeRef = useRef('slot-snap');
  // Flipped true when the parent enters its release phase on drop. The
  // cursor-mode RAF reads this each frame and bails so its writes don't
  // fight the CSS transition that animates the clone into its final slot.
  const releaseRef = useRef(false);
  // Resting (content) height of the list container captured at lift, so the
  // drop-release effect can animate the grow-to-contain min-height back down.
  const growBaseRef = useRef(0);

  // useLayoutEffect (not useEffect) so the clone is inserted into the DOM
  // synchronously after React's commit, BEFORE the browser paints. Otherwise
  // there's a one-paint gap where the source slot has gone display:none
  // (causing adjacent slots to reflow upward) but the floating clone hasn't
  // appeared yet — visible as a "split second" jump of neighboring tiles.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!sourceElement || !host) return undefined;

    // Read the drag-tile-follow mode at lift time. Mid-drag mode changes are
    // ignored — the next drag picks up the new mode. Three modes:
    //   'off'       — clone parks at origin (gap-stays-at-source covers it)
    //   'cursor'    — clone anchors at the rail origin; cursor delta from the
    //                 lift point translates it on the active axis (no jump
    //                 to cursor center on pickup)
    //   'slot-snap' — clone snaps to slot with a 160ms CSS transition
    // Absent attr defaults to 'cursor' (matches ANIMATION_KEY_CONFIG in useSettings).
    const mode = document.body?.getAttribute('data-anim-drag-tile-follow') || 'cursor';
    modeRef.current = mode;

    const clone = sourceElement.cloneNode(true);
    // The source slot uses visibility:hidden during drag to preserve its
    // layout space (see items.map). cloneNode copies inline styles, so the
    // clone would inherit visibility:hidden and be invisible — force it
    // visible on the clone itself.
    clone.style.visibility = 'visible';
    // The source slot also runs the `drag-source-collapse` keyframe to shrink
    // its height to 0 over 160ms (so flex-weighted siblings grow smoothly
    // into the freed space). cloneNode copies the triggering data attribute
    // and the from-height CSS variable, so without these resets the clone
    // would ALSO collapse to height 0 mid-pickup and vanish.
    clone.removeAttribute('data-dragsrc-collapsing');
    clone.style.removeProperty('--drag-source-from-h');
    // Mark the clone so per-tile CSS can keep the press-depth look during
    // drag (the original element loses :active the moment the clone takes
    // over the pointer). E.g. `.music-tile.is-dragging` collapses
    // its box-shadow to mimic the pressed state.
    clone.classList.add('is-dragging');
    // Axis-aware initial position. `slotY` holds the slot coordinate on the
    // active axis (Y for vertical, X for horizontal) — same prop name kept
    // for backwards compatibility with the parent's computeSlot call.
    let initialPos;
    if (mode === 'off') {
      initialPos = isHorizontal ? originRect.left : originRect.top;
    } else if (mode === 'cursor') {
      // Tile stays where it was lifted; the RAF loop below translates it
      // by the cursor delta from this anchor.
      initialPos = isHorizontal ? originRect.left : originRect.top;
    } else {
      const fallback = isHorizontal ? originRect.left : originRect.top;
      initialPos = (typeof slotY === 'number' && !isNaN(slotY)) ? slotY : fallback;
    }
    const initialX = isHorizontal ? initialPos : originRect.left;
    const initialY = isHorizontal ? originRect.top : initialPos;
    Object.assign(clone.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: originRect.width + 'px',
      height: originRect.height + 'px',
      margin: '0',
      pointerEvents: 'none',
      zIndex: '9999',
      cursor: 'grabbing',
      transition: 'none',
      opacity: '1',
      display: originDisplay || 'block',
      // Vertical: X anchors to source column (modules stay locked to rail).
      // Horizontal: Y anchors to source row (dock buttons stay on the bar).
      // Active-axis position depends on the drag mode.
      transform: `translate3d(${initialX}px, ${initialY}px, 0)`,
    });
    // Portal the clone to <body> rather than the in-tree host. The clone is
    // position:fixed and positioned with viewport coords (getBoundingClientRect).
    // If ANY ancestor of the host has a transform, that ancestor — not the
    // viewport — becomes the containing block for the fixed clone (CSS Transforms
    // spec), throwing it ~a full viewport off-screen. The dock's `.dock-pos` uses
    // translateX(-50%) and `.dock-root` ends its show-animation on a transform,
    // which is exactly why the dock clone went invisible while the (untransformed)
    // right sidebar worked. <body> has no transformed ancestor, so fixed ==
    // viewport again; theme vars live on :root/body so the clone still inherits them.
    document.body.appendChild(clone);
    cloneRef.current = clone;

    let rafId = null;
    let cancelled = false;
    // Hoisted so the cleanup below can reset them (assigned in the cursor branch).
    // growEl = the list container (grows to contain the tile); cardEl = its parent
    // .candy-card (pulled up so the panel can grow from the TOP too).
    let growEl = null;
    let cardEl = null;
    if (mode === 'cursor') {
      // Capture cursor at lift time. The tile starts at its rail origin and
      // chases the cursor delta with exponential smoothing — each frame the
      // rendered position closes a fixed fraction of the gap to the target,
      // giving the tile a weighty, slightly-laggy feel as it slides through
      // the rail. CHASE_RATE comes from the `drag-tile-smoothness` setting:
      // higher = snappier (less drag), lower = laggier. 'medium' (0.18) puts
      // the tile within ~1px of the cursor after ~25 frames once you stop.
      const ic = { x: cursorRef.current.x, y: cursorRef.current.y };
      const smoothnessBucket = document.body?.getAttribute('data-anim-drag-tile-smoothness') || 'medium';
      const CHASE_RATE = ({ none: 1.0, light: 0.35, medium: 0.18, heavy: 0.08 })[smoothnessBucket] ?? 0.18;
      // Rubber-band bounds: keep the tile inside its list container. The container
      // doesn't move during a pointer drag, so measure it once. Past an edge only R
      // of the overage passes to the target, so the tile resists leaving the panel
      // and the release glide springs it back to a valid slot.
      // ponytail: if a tile is taller than its container, min > max and the clamp
      // just pins it to the top/left edge — fine for these short lists.
      const cb = containerRef?.current?.getBoundingClientRect();
      // Grow-to-contain (vertical only): the content-height card grows to keep the
      // dragged tile inside it, in the direction of drag, with exponential resistance
      // on the stretch (below). Bottom: grow the list min-height (card extends down,
      // Studio fixed). Top: pad the list top + pull the card up by the same amount, so
      // the top edge (Studio) rises while the tiles and card bottom stay put — a true
      // mirror of the bottom, with Studio always above the tile.
      growEl = (grow && !isHorizontal && cb) ? (containerRef?.current || null) : null;
      cardEl = growEl ? growEl.parentElement : null;
      const baseH = cb ? cb.height : 0;
      growBaseRef.current = baseH;
      let curX = originRect.left;
      let curY = originRect.top;
      const loop = () => {
        if (cancelled || releaseRef.current) return;
        const c = cursorRef.current;
        let targetX = isHorizontal ? originRect.left + (c.x - ic.x) : originRect.left;
        let targetY = isHorizontal ? originRect.top : originRect.top + (c.y - ic.y);
        if (isHorizontal) {
          // Dock: unchanged linear rubber-band both edges.
          if (cb) {
            const RH = 0.18;
            const min = cb.left, max = cb.right - originRect.width;
            if (targetX < min) targetX = min - (min - targetX) * RH;
            else if (targetX > max) targetX = max + (targetX - max) * RH;
          }
        } else if (cb && grow) {
          // Overlay (growToContain): inside the panel the tile follows freely; past
          // either PANEL edge it stretches the card with exponential resistance —
          // d = C·(1−e^(−x/C)): ~1:1 just past the edge, asymptotic to C px far out
          // (firm, hard cap). The card then grows to contain the tile at that resisted
          // position (below), so a tile never leaves the panel — the panel expands.
          // ponytail: C=80 is the "firm" feel; raise for looser, lower for a harder wall.
          const EDGE_GIVE = 80;
          const resist = (x) => EDGE_GIVE * (1 - Math.exp(-x / EDGE_GIVE));
          const tileBottom = targetY + originRect.height;
          if (tileBottom > cb.bottom) targetY = cb.bottom - originRect.height + resist(tileBottom - cb.bottom);
          else if (targetY < cb.top)  targetY = cb.top - resist(cb.top - targetY);
        } else if (cb) {
          // Non-grow vertical consumers (right sidebar): original linear rubber-band
          // both edges, no card growth — unchanged from before the overlay grow.
          const R = 0.18;
          const min = cb.top, max = cb.bottom - originRect.height;
          if (targetY < min) targetY = min - (min - targetY) * R;
          else if (targetY > max) targetY = max + (targetY - max) * R;
        }
        curX += (targetX - curX) * CHASE_RATE;
        curY += (targetY - curY) * CHASE_RATE;
        if (growEl) {
          // Grow the card to contain the (resisted) tile position — instant follow, no
          // transition during drag. Bottom → min-height (card extends down). Top → list
          // padding-top + an equal upward pull on the card, so the top edge (Studio)
          // rises while the tiles and card bottom stay fixed. The two are mutually
          // exclusive (a tile drags up OR down), so they never fight.
          const overBottom = Math.max(0, (curY + originRect.height) - cb.bottom);
          const overTop = Math.max(0, cb.top - curY);
          growEl.style.minHeight = overBottom > 0 ? `${baseH + overBottom}px` : '';
          growEl.style.paddingTop = overTop > 0 ? `${overTop}px` : '';
          if (cardEl) cardEl.style.marginTop = overTop > 0 ? `${-overTop}px` : '';
        }
        clone.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else if (mode === 'slot-snap') {
      // Force a reflow so the initial transform commits with transition: none,
      // then enable the 160ms transition for subsequent slot updates. Without
      // the reflow, the browser may batch the transition switch with the initial
      // transform and animate from (0, 0) to the first slot on mount.
      void clone.offsetWidth;
      clone.style.transition = 'transform 160ms cubic-bezier(0.32, 0.72, 0, 1)';
    }

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      try { clone.remove(); } catch { /* already removed */ }
      cloneRef.current = null;
      // Drop the grow-to-contain overrides so the container + card return to rest
      // (only touched when we actually grew — never stomps a consumer's own styles).
      if (growEl) { growEl.style.minHeight = ''; growEl.style.paddingTop = ''; growEl.style.transition = ''; }
      if (cardEl) { cardEl.style.marginTop = ''; cardEl.style.transition = ''; }
    };
  }, [sourceElement, originRect.left, originRect.top, originRect.width, originRect.height, originDisplay, cursorRef, isHorizontal]);

  // Slot-snap mode: update transform when slot changes; CSS transition animates.
  // Gated on modeRef (captured at mount) so cursor-mode RAF writes aren't fought.
  useEffect(() => {
    const clone = cloneRef.current;
    if (!clone || modeRef.current !== 'slot-snap') return;
    const cx = isHorizontal ? slotY : originRect.left;
    const cy = isHorizontal ? originRect.top : slotY;
    clone.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
  }, [originRect.left, originRect.top, slotY, isHorizontal]);

  // Drop-release animation. The parent's onUp two-phase flow flips
  // `releasing` true on drop, keeps dragState alive for one transition cycle
  // (source stays hidden, gap stays open), then clears it. We ride that
  // window to (1) stop the cursor RAF, (2) animate the clone into the final
  // slot position via CSS transition, and (3) drop the `is-dragging` class
  // so .music-tile's own 150ms transitions on transform+box-shadow
  // animate the press release. Without this, the clone is destroyed the
  // frame after drop and the press-up animation is never visible.
  useEffect(() => {
    const clone = cloneRef.current;
    if (!clone || !releasing) return;
    releaseRef.current = true;
    const cx = isHorizontal ? slotY : originRect.left;
    const cy = isHorizontal ? originRect.top : slotY;
    // Cursor-mode clones run with transition: 'none' during drag (RAF writes
    // the transform every frame). Switching to '160ms' AND changing transform
    // in the same JS task makes the browser batch both writes and skip the
    // transition — the clone snaps to slot instead of gliding. Force a reflow
    // between the two so the new transition rule is committed before the
    // transform delta is computed. Same pattern the slot-snap init uses at
    // mount (search for `void clone.offsetWidth`).
    clone.style.transition = `transform ${glideMs}ms cubic-bezier(0.32, 0.72, 0, 1)`;
    void clone.offsetWidth;
    clone.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    // Swap is-dragging → is-drop-accent for the glide. The bridge class carries
    // the same accent (band + face flood, both tile types) but NOT the pressed
    // face transform, so the face eases back up over --cbtn-press-dur during
    // the glide — the same release a normal click shows. History: removing
    // is-dragging bare killed the accent mid-glide (the old flicker), so
    // dca4b97 kept it through the whole glide — which made the swap-to-source
    // an instant pressed→unpressed SNAP. The bridge class is the missing third
    // state: accent yes, press no. (Its CSS keeps the transform transition
    // alive and only strips the colour transitions — see styles.css.)
    clone.classList.remove('is-dragging');
    clone.classList.add('is-drop-accent');
    // Snap the grown card back to content height over the same glide, so the card
    // shrink and the clone settle finish together (transition to the captured
    // resting px, not '' — an auto/none target won't animate).
    const gc = containerRef?.current;
    if (gc && (gc.style.minHeight || gc.style.paddingTop)) {
      const ease = `${glideMs}ms cubic-bezier(0.32, 0.72, 0, 1)`;
      gc.style.transition = `min-height ${ease}, padding-top ${ease}`;
      if (gc.style.minHeight) gc.style.minHeight = `${growBaseRef.current}px`;
      if (gc.style.paddingTop) {
        gc.style.paddingTop = '0px';
        const card = gc.parentElement;
        if (card) { card.style.transition = `margin-top ${ease}`; card.style.marginTop = '0px'; }
      }
    }
  }, [releasing, slotY, originRect.left, originRect.top, isHorizontal, glideMs, containerRef]);

  return (
    <div
      ref={hostRef}
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />
  );
}

export default function DraggableSidebarList({
  items,
  renderItem,
  onReorder,
  direction = 'vertical',
  enabled = true,
  dragFromInteractive = false,
  onDragActiveChange,
  gapSize: gapSizeProp = GAP,
  keyExtractor = (item, i) => item.key ?? i,
  getItemStyle,
  // Opt-in edge-snap (the dock passes { triggerPx, centerIndex }; null elsewhere
  // so every sidebar consumer is byte-identical). On release, a drop near the
  // bar's left edge / centre / right edge snaps into that magnet zone.
  snapZones = null,
  // Opt-in grow-to-contain (the overlay panel passes it): past a panel edge the
  // card expands to keep the dragged tile inside, with exponential resistance.
  // Off elsewhere (dock/right sidebar) so their drag geometry is unchanged.
  growToContain = false,
  className,
  style,
}) {
  const containerRef = useRef(null);
  const itemRefs = useRef([]);
  const [dragState, setDragState] = useState(null);

  const dRef = useRef(null);
  const lastStateRef = useRef(0);
  const mouseRef = useRef({ x: 0, y: 0 });
  const holdTimerRef = useRef(null);
  // Set true on a real drag release so the wrapper's capture-phase click
  // handler swallows the synthetic click that follows pointerup (keeps a
  // hold-drag from also firing the item's onClick, e.g. dock nav buttons).
  const suppressClickRef = useRef(false);
  // Holds the { el, clearOnMove } for the transient post-drop forced accent
  // (see forceDropAccent). null when no drop-accent is active.
  const dropAccentRef = useRef(null);

  // Axis configuration — vertical (default) keeps the legacy sidebar behavior;
  // horizontal swaps to X-based threshold checks and marginLeft/Right gap.
  const isHorizontal = direction === 'horizontal';
  const axis        = isHorizontal ? 'x'           : 'y';
  const sizeProp    = isHorizontal ? 'width'       : 'height';
  const startProp   = isHorizontal ? 'left'        : 'top';
  const marginStart = isHorizontal ? 'marginLeft'  : 'marginTop';
  const marginEnd   = isHorizontal ? 'marginRight' : 'marginBottom';

  const clearHold = useCallback(() => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  }, []);

  // Remove the transient post-drop accent + its one-shot listener.
  const clearDropAccent = useCallback(() => {
    const d = dropAccentRef.current;
    if (!d) return;
    d.el.classList.remove('is-drop-accent');
    window.removeEventListener('pointermove', d.clearOnMove);
    dropAccentRef.current = null;
  }, []);

  // Force the transient post-drop accent onto wrapper `el`; cleared on the next
  // real pointermove (when :hover takes back over). See accentTileUnderCursor.
  const forceDropAccent = useCallback((el) => {
    if (!el) return;
    clearDropAccent();
    el.classList.add('is-drop-accent');
    const clearOnMove = () => clearDropAccent();
    dropAccentRef.current = { el, clearOnMove };
    window.addEventListener('pointermove', clearOnMove);
  }, [clearDropAccent]);

  // Bridge the :hover gap on drop. The drag clone carried the accent through the
  // glide; when it's removed and the reordered tiles reappear under a STILL cursor,
  // the browser won't recompute :hover without a real pointer move, so the accent
  // would blink off. Hit-test the ACTUAL tile under the cursor (elementFromPoint)
  // rather than assume the dragged tile lands there — React re-inserts the dragged
  // node on a downward reorder but the displaced sibling on an upward one, so the
  // tile under the cursor isn't always the one dragged (the up-only flash). Caller
  // must have committed the reorder synchronously (flushSync) so this reads the new
  // order. (memory: ":hover needs a real pointer move".)
  const accentTileUnderCursor = useCallback(() => {
    const { x, y } = mouseRef.current;
    const hit = document.elementFromPoint(x, y);
    const wrapper = hit ? itemRefs.current.find(w => w && w.contains(hit)) : null;
    forceDropAccent(wrapper || null);
  }, [forceDropAccent]);

  const cleanup = useCallback(() => {
    clearHold();
    clearDropAccent();
    itemRefs.current.forEach(el => { if (el) el.style.pointerEvents = ''; });
    dRef.current = null;
    setDragState(null);
    onDragActiveChange?.(false);
  }, [clearHold, clearDropAccent, onDragActiveChange]);

  useEffect(() => cleanup, [cleanup]);

  // ── Compute drop index from current mouse coord and item rects ────────────
  // The dragged item is `display: none` during drag, so its rect is zero —
  // skip it and iterate the remaining items in original-index order. Returns
  // the original-array index, which is what `onReorder(from, to)` expects.
  // Coordinate axis is selected by `direction` (Y for vertical, X for horizontal).
  const calcDropIndex = useCallback(() => {
    const draggedIdx = dRef.current?.idx;
    const coord = mouseRef.current[axis];
    const els = itemRefs.current;
    let firstNonSourceSeen = false;
    for (let i = 0; i < els.length; i++) {
      if (i === draggedIdx) continue;
      const el = els[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r[sizeProp] === 0) continue;
      const offsetFraction = firstNonSourceSeen ? SHIFT_THRESHOLD_FRACTION : 0.5;
      firstNonSourceSeen = true;
      const threshold = r[startProp] + offsetFraction * r[sizeProp];
      if (coord < threshold) return i;
    }
    return els.length;
  }, [axis, sizeProp, startProp]);

  // Edge-snap (opt-in via `snapZones`, horizontal only). On release, if the
  // cursor is within triggerPx of the bar's left edge, centre, or right edge,
  // return that zone's drop index instead of the rect-midpoint slot; null = no
  // zone hit (fall back to calcDropIndex). Measured against the CONTAINER, so a
  // wide flex:1 spacer never skews it.
  const calcSnapIndex = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const cr = container.getBoundingClientRect();
    const x = mouseRef.current.x;
    const t = snapZones?.triggerPx ?? 48;
    if (x <= cr.left + t) return 0;
    if (x >= cr.right - t) return items.length;
    const mid = (cr.left + cr.right) / 2;
    if (Math.abs(x - mid) <= t) {
      return snapZones?.centerIndex != null ? snapZones.centerIndex : Math.floor(items.length / 2);
    }
    return null;
  }, [snapZones, items]);

  // ── Window move ────────────────────────────────────────────────────────────
  const onMove = useCallback((e) => {
    const drag = dRef.current;
    if (!drag) return;
    if (drag.phase === 'hold') {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        clearHold();
        if (dragFromInteractive) {
          // Dock: a move during the hold cancels (keeps tap=nav; a deliberate still
          // hold is the drag intent). Unchanged.
          dRef.current = null;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        } else {
          // Reorder lists (overlay / right sidebar): movement STARTS the drag right
          // away — no need to wait out the hold timer / full press-down. beginDrag
          // flips dRef to 'drag' and the existing listeners carry the rest.
          beginDrag(drag.idx, itemRefs.current[drag.idx]?.getBoundingClientRect(), e.clientX, e.clientY);
        }
      }
      return;
    }
    if (drag.phase === 'drag') {
      e.preventDefault();
      mouseRef.current = { x: e.clientX, y: e.clientY };

      // Throttled React state update for drop-zone gap
      const now = performance.now();
      if (now - lastStateRef.current > STATE_THROTTLE) {
        lastStateRef.current = now;
        const dropIdx = calcDropIndex();
        setDragState(prev => {
          if (!prev || prev.dropIdx === dropIdx) return prev;
          return { ...prev, dropIdx };
        });
      }
    }
    // beginDrag is referenced in the hold branch but intentionally omitted from deps
    // (defined below; captured by closure like onUp — reading it at call time is safe).
  }, [clearHold, calcDropIndex, dragFromInteractive]);

  // ── Window up ────────────────────────────────────────────────────────────
  const onUp = useCallback((e) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const drag = dRef.current;
    if (!drag) return;
    clearHold();

    if (drag.phase === 'hold') {
      dRef.current = null;
      return;
    }

    if (drag.phase === 'drag') {
      e.preventDefault();
      // True release point — the last pointermove can lag it by one event, and
      // the post-drop accent hit-test (accentTileUnderCursor) reads these coords
      // ~160ms later. calcDropIndex below reads them too, so both use the same
      // ground truth.
      mouseRef.current = { x: e.clientX, y: e.clientY };
      // A real lift occurred (not a tap). Swallow the synthetic click the
      // browser fires after pointerup so a hold-drag — even one with no net
      // index change — never also triggers the item's onClick (e.g. a dock
      // button that would navigate/open a modal). Cleared next tick so it
      // never eats a later genuine click.
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);

      let to = calcDropIndex();
      if (snapZones && isHorizontal) {
        const snapped = calcSnapIndex();
        if (snapped != null) to = snapped;
      }
      const from = drag.idx;
      playReorderDrop();

      // Drop-release glide bucket. 'off' skips the release animation entirely
      // (synchronous cleanup, clone vanishes, source reappears at new slot —
      // matches the pre-feature behavior). 25/50/75/100 are speed buckets:
      // higher = snappier (shorter duration). 75 is the default the feature
      // shipped with; 100 trims another 25% off; 25 stretches 3× for a
      // cinematic settle.
      const glideBucket = document.body?.getAttribute('data-anim-drag-drop-glide') || '75';
      const glideMs = ({ off: 0, '25': 480, '50': 240, '75': 160, '100': 120 })[glideBucket] ?? 160;

      if (glideMs === 0) {
        flushSync(() => {
          cleanup();
          if (typeof from === 'number' && typeof to === 'number' && from !== to) {
            onReorder(from, to);
          }
        });
        accentTileUnderCursor();
        return;
      }

      // Two-phase release. Phase 1 (now): clear listeners + dRef but keep
      // dragState alive with `releasing: true` so the source slot stays
      // hidden and the gap stays open. PlainDragTile responds by animating
      // the clone into the final slot and dropping the `is-dragging` class
      // (the inner tile's 150ms transitions on transform+box-shadow animate
      // the press release). Phase 2 (after glideMs): clear dragState and
      // fire onReorder in one render, so the source reappears at its new
      // slot exactly when the clone vanishes.
      clearHold();
      itemRefs.current.forEach(el => { if (el) el.style.pointerEvents = ''; });
      dRef.current = null;
      // Pin dropIdx to the slot the drop actually commits to. The throttled
      // (60ms) move handler can leave dragState.dropIdx one update stale at
      // release, in which case the clone would glide to the OLD slot and then
      // snap to the real one when the source appears.
      setDragState(prev => prev ? { ...prev, dropIdx: to, releasing: true, glideMs } : null);

      setTimeout(() => {
        // Commit the swap synchronously so the hit-test below reads the new order in
        // the same frame the clone is removed (no un-accented paint in between).
        flushSync(() => {
          setDragState(null);
          if (typeof from === 'number' && typeof to === 'number' && from !== to) {
            onReorder(from, to);
          }
        });
        onDragActiveChange?.(false);
        accentTileUnderCursor();
      }, glideMs);
    }
  }, [clearHold, calcDropIndex, calcSnapIndex, snapZones, isHorizontal, cleanup, onReorder, onMove, onDragActiveChange, accentTileUnderCursor]);

  // ── Start drag ───────────────────────────────────────────────────────────
  const beginDrag = useCallback((idx, or, cx, cy) => {
    const el = itemRefs.current[idx];
    if (!el) return;

    // Signal drag-active FIRST so consumers (the dock) can imperatively cancel
    // any hover affordance (the dock's hover-expand width) before we measure. Otherwise
    // the rect snapshots below capture the expanded geometry and both the drop math
    // and the clone size go off. The getComputedStyle + getBoundingClientRect
    // reads that follow force the style/layout flush that applies it.
    onDragActiveChange?.(true);

    // Snapshot the source's computed `display` BEFORE the upcoming rerender
    // applies `display: none` to it — the clone needs the original value.
    const originDisplay = window.getComputedStyle(el).display;

    // Re-measure the source rect now (after drag-active unscaling) rather than
    // trusting the press-time `or`, so originRect, positions and heights are all
    // read under one consistent, unscaled layout.
    const originRect = el.getBoundingClientRect();

    // Capture layout BEFORE source.display:none takes effect. The gap-stays-
    // at-source lift cancels source's collapse exactly (marginStart on the next
    // item equals source's size on the axis), so positions[i] for i != sourceIdx
    // will continue to match items[i].getBoundingClientRect()[startProp] during
    // steady state — making computeSlotY math work off cached coordinates.
    const positions = itemRefs.current.map(e => e ? e.getBoundingClientRect()[startProp] : 0);
    const heights   = itemRefs.current.map(e => e ? e.getBoundingClientRect()[sizeProp]  : 0);

    // Container flex `gap` on the active axis. The source-collapse + drop-gap math
    // is height-only, so a flex gap leaves a one-gap surplus where the source lifts
    // and a one-gap deficit where it lands → siblings snap by one gap-width on drop.
    // Capture it so the render can cancel the surplus (−gap on the source) and pad
    // the deficit (+gap on the drop slot). 0 for margin-spaced consumers (dock/
    // sidebar) → a no-op there.
    const gcs = containerRef.current ? window.getComputedStyle(containerRef.current) : null;
    const flexGap = gcs ? (parseFloat(isHorizontal ? gcs.columnGap : gcs.rowGap) || 0) : 0;

    dRef.current = { phase: 'drag', idx };
    mouseRef.current = { x: cx, y: cy };

    if (el) el.style.pointerEvents = 'none';

    // Initial dropIdx points at the next non-source slot so the destination
    // marginTop (or marginBottom when source is last) opens a real gap exactly
    // at source's original position — items above and below source do not
    // visibly reflow on lift. The clone fills the gap (DESIGN.md § Drag and drop).
    const initialDropIdx = idx === itemRefs.current.length - 1 ? itemRefs.current.length : idx + 1;
    setDragState({
      dragging: true,
      idx,
      dropIdx: initialDropIdx,
      originRect,
      originDisplay,
      positions,
      heights,
      flexGap,
    });
    playReorderPickup();
  }, [onDragActiveChange, startProp, sizeProp]);

  // ── Item pointer down ────────────────────────────────────────────────────
  const onItemDown = useCallback((e, idx) => {
    if (!enabled || e.button !== 0) return;
    suppressClickRef.current = false;

    // Drag pickup is allowed only from non-interactive chrome. Any standard
    // interactive element — or anything tagged data-no-drag (custom drag
    // surfaces like the planner day-view or the music seek/volume sliders) —
    // receives its own pointer events instead.
    //
    // When `dragFromInteractive` is set (the dock, whose every item IS an icon
    // button), the whole item is a drag surface: buttons/links no longer block
    // pickup, only inputs/sliders and explicit data-no-drag do. Tap-vs-hold
    // still disambiguates click from drag (HOLD_MS / MOVE_THRESHOLD below).
    const blockSelector = dragFromInteractive
      ? 'input, textarea, select, [contenteditable], [data-no-drag]'
      : 'button, a, [role="button"], input, textarea, select, [contenteditable], [data-no-drag]';
    const blocked = e.target.closest?.(blockSelector);
    if (blocked && blocked !== e.currentTarget) return;

    const r = itemRefs.current[idx]?.getBoundingClientRect();
    if (!r) return;

    dRef.current = { phase: 'hold', idx, sx: e.clientX, sy: e.clientY };
    mouseRef.current = { x: e.clientX, y: e.clientY };
    holdTimerRef.current = setTimeout(() => beginDrag(idx, r, e.clientX, e.clientY), HOLD_MS);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { passive: false });
  }, [enabled, dragFromInteractive, beginDrag, onMove, onUp]);

  const flexDir = direction === 'vertical' ? 'column' : 'row';

  // Destination gap matches the dragged item's actual size on the active axis
  // (+ one flex gap, which the inserted item brings in the final layout) so the
  // slot equals the item's true footprint and neighbours don't snap on drop.
  const gapSize = (dragState?.originRect?.[sizeProp] ?? gapSizeProp) + (dragState?.flexGap ?? 0);

  return (
    <>
      {dragState?.dragging && itemRefs.current[dragState.idx] && (
        <PlainDragTile
          sourceElement={itemRefs.current[dragState.idx]}
          originRect={dragState.originRect}
          originDisplay={dragState.originDisplay}
          cursorRef={mouseRef}
          slotY={computeSlotY(dragState.dropIdx, dragState.idx, dragState.positions, dragState.heights, dragState.flexGap ?? 0)}
          isHorizontal={isHorizontal}
          releasing={!!dragState.releasing}
          glideMs={dragState.glideMs ?? 160}
          containerRef={containerRef}
          grow={growToContain}
        />
      )}
      <div ref={containerRef} data-drag-list="" data-dragging={dragState?.dragging ? 'true' : undefined} className={className} style={{ display: 'flex', flexDirection: flexDir, ...style }}>
        {items.map((item, i) => {
          const isDragged = dragState?.idx === i;
          const isDrop    = dragState?.dragging && dragState?.dropIdx === i && !isDragged;
          // dropIdx === items.length means "drop after the last item". There
          // is no item[items.length] to attach a marginTop to, so the gap
          // gets attached as a marginBottom on the actual last non-dragged
          // item — otherwise dragging the first item past the last item in a
          // short list (e.g. the 2-slot right sidebar) shows zero visual
          // feedback even though the drop itself succeeds.
          // When source is the LAST item, marginBottom needs to land on the
          // second-to-last item (the new last non-source) so the gap renders at
          // source's original position. Otherwise the existing `items.length - 1`
          // target IS the source, which has `display: none` and !isDragged is
          // false — no gap renders and the lift collapses items upward.
          const lastNonSourceIdx = dragState?.idx === items.length - 1
            ? items.length - 2
            : items.length - 1;
          const isDropAfter = dragState?.dragging
            && dragState?.dropIdx === items.length
            && i === lastNonSourceIdx
            && !isDragged;
          // getItemStyle is spread FIRST so the drag-state overrides below
          // (display: none on the picked-up slot, etc.) win. Right-sidebar
          // slots set display: 'flex' here — without the order fix, the
          // collapse would be silently overwritten and the dragged tile
          // would stay visible, blocking layout.
          const itemStyle = getItemStyle ? getItemStyle(item, i) : {};

          return (
            <div
              key={keyExtractor(item, i)}
              ref={el => { itemRefs.current[i] = el; }}
              onPointerDown={e => onItemDown(e, i)}
              onClickCapture={e => { if (suppressClickRef.current) { e.stopPropagation(); e.preventDefault(); } }}
              style={{
                ...itemStyle,
                // Animate the destination-slot gap. The dragged item's source
                // slot collapses via a CSS animation (see `data-dragsrc-collapsing`
                // below) — sized from the captured originRect down to 0 over
                // the same 160ms easing, so flex-weighted siblings (e.g. the
                // planner slot with flexWeight:2) grow into the freed space
                // smoothly instead of snapping. Post-drop snap-back is instant.
                // The SOURCE transitions its margin too (not just !isDragged): its
                // −flexGap compensation must ease in with the SAME easing as the
                // collapse keyframe + the drop-gap, or it lands instantly at t=0 and
                // shoves neighbours by one gap on pickup (the pickup-snap bug).
                transition: dragState?.dragging
                  ? 'margin 160ms cubic-bezier(0.32, 0.72, 0, 1)'
                  : 'none',
                [marginStart]: isDrop ? gapSize : 0,
                // Source slot cancels one flex gap so its collapse doesn't leave a
                // one-gap surplus where it lifted (siblings stay put on drop). Pairs
                // with the +flexGap in gapSize above to keep the lift itself reflow-
                // free. No-op when the container has no flex gap.
                [marginEnd]:   isDragged ? -(dragState?.flexGap ?? 0) : (isDropAfter ? gapSize : 0),
                // Source slot: hide visually + provide the from-height for
                // the keyframe collapse. `visibility: hidden` keeps the slot
                // invisible during the collapse so its content doesn't clip-
                // peek above the clone; the keyframe runs simultaneously and
                // shrinks the slot height from its captured origin to 0. The
                // floating clone already covers the source's origin pixel
                // position, so the visual is: clone in place, planner grows
                // smoothly upward into the freed space.
                visibility: isDragged ? 'hidden' : undefined,
                ['--drag-source-from-h']: isDragged
                  ? `${dragState.originRect.height}px`
                  : undefined,
                cursor: enabled ? 'grab' : undefined,
                position: 'relative',
                pointerEvents: isDragged ? 'none' : undefined,
              }}
              data-dragsrc-collapsing={isDragged ? 'true' : undefined}
            >
              {renderItem(item, i)}
            </div>
          );
        })}
      </div>
    </>
  );
}
