import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { playReorderPickup, playReorderDrop } from '../hooks/useTactileSound.js';
import { GLIDE, GLIDE_MS } from '../util/motion.js';

// ── Drag reorder: measure, never predict ─────────────────────────────────────
// The item you drag IS the real item. It never leaves the list, nothing is
// cloned, and no landing coordinate is ever computed: the list reorders live
// underneath the finger, so at release the dragged element is ALREADY sitting
// in its final slot and the drop is just its own transform easing to zero.
// A post-drop jump is impossible by construction rather than tuned away.
//
// This replaced (2026-09-19) a 1224-line predict-and-clone engine: it cloned
// the item, portalled the clone to <body>, flew the clone to a coordinate
// computed by dragMath.js from rects cached at pickup, then deleted the clone
// and un-hid the original. Every post-drop jump on the dock, the playlist grid
// and the right widget rail was that prediction disagreeing with reality. The
// prediction only held where the layout happened to be standing still and on
// whole pixels at the instant of the snapshot — which is why the nutrition
// chips were the one surface that behaved. See Plans/Drag Reorder Rewrite.md.
//
// Everything that moves moves by the SAME mechanism, FLIP:
//   First  — the element's on-screen rect, captured the instant before the
//            order changes (so an interrupted glide is picked up mid-flight,
//            not snapped back to where it was three reorders ago).
//   Last   — its rect after React has committed the new order.
//   Invert — transform it by the difference, with no transition.
//   Play   — one reflow, then transition the transform away.
// Siblings opening a slot, a grid chip stepping sideways, a dock button
// sliding along the bar and the drop glide itself are all that one path. The
// only exception is the dragged element in 'cursor' mode, which is driven by
// the pointer instead (and re-anchored to its new slot on every reorder, so a
// shuffle underneath it is invisible).
//
// The gesture layer below (hold-to-lift, tap-vs-drag, click swallow, the
// interactive-chrome block list, the abort paths) is carried over unchanged —
// it was never the bug.

const HOLD_MS = 180;
// MOVE_THRESHOLD: cursor displacement (px) during the 180ms hold that aborts
// the long-press. 10, not 6 — high-precision tap-to-click touchpads register
// tiny drift during a deliberate hold, and 6 made the tile fail to lift on
// light holds (KI v0.7.0 + v0.7.3).
const MOVE_THRESHOLD = 10;
// Exponential chase for the pointer-following tile: close this fraction of the
// gap each frame so it slides with weight instead of sticking to the cursor.
// 0.18 is what the retired 'drag-tile-smoothness' setting called medium.
const CHASE_RATE = 0.18;
// Past a container edge only this fraction of the overage passes through, so
// the tile resists leaving its list.
const RUBBER = 0.18;
// Grow-to-contain resistance: d = C·(1−e^(−x/C)) — ~1:1 just past the edge,
// asymptotic to C px far out. Raise for looser, lower for a harder wall.
const EDGE_GIVE = 80;
const resist = (x) => EDGE_GIVE * (1 - Math.exp(-x / EDGE_GIVE));

// Drop the press marks the global press-hold (useTactileSound) put on the
// button when the pointer went down. A candy button's press moves the FACE,
// and on a rail tile that face carries the album art, the title and the meter
// — so a press carried through the flight has to be released on the landing,
// and that release is visible at every speed (fast it snaps, slow the tile's
// contents drift upward for a quarter second after the drop, reported
// 2026-09-19). Released at lift instead, there is nothing to release later.
// .is-dragging keeps the accent band, so it still reads as held.
function releasePress(root) {
  if (!root) return;
  for (const el of [root, ...root.querySelectorAll('[data-candy-pressed], .is-pressed')]) {
    el.removeAttribute('data-candy-pressed');
    el.classList.remove('is-pressed');
  }
}

// Move one entry between slots. The whole reorder model, in three lines.
function moveSlot(arr, from, to) {
  if (from === to) return arr;
  const next = arr.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

export default function DraggableSidebarList({
  items,
  renderItem,
  onReorder,
  direction = 'vertical',
  enabled = true,
  dragFromInteractive = false,
  onDragActiveChange,
  keyExtractor = (item, i) => item.key ?? i,
  getItemStyle,
  // Opt-in edge-snap (the dock passes { triggerPx, centerIndex }; null
  // elsewhere). On release, a drop near the bar's left edge / centre / right
  // edge snaps into that magnet zone instead of the nearest slot.
  snapZones = null,
  // Opt-in grow-to-contain (the overlay Studio panel): past a panel edge the
  // card expands to keep the dragged tile inside, with exponential resistance.
  growToContain = false,
  // Accepted and ignored. The gap is whatever the container's real layout gap
  // is — it is never restated, so there is nothing for a caller to declare.
  // Kept in the signature only so existing call sites need no edit.
  gapSize: _gapSize,
  className,
  style,
}) {
  const isGrid = direction === 'grid';
  const isHorizontal = direction === 'horizontal';

  const containerRef = useRef(null);
  const itemRefs = useRef([]);

  // The one piece of drag state React renders from.
  //   order     — original indices in their current preview arrangement
  //   oi        — the dragged item's ORIGINAL index (stable across reorders)
  //   slot      — where it currently sits in `order`
  //   releasing — the drop glide is running; the gesture is over
  const [ds, setDs] = useState(null);
  const dsRef = useRef(null);
  dsRef.current = ds;

  // Imperative drag bookkeeping — never rendered, so it can change per frame.
  const dRef = useRef(null);
  const rafRef = useRef(0);
  const holdRef = useRef(0);
  const mouseRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);
  // Layout rects (transform stripped) by original index — what the hit test
  // measures slots against. Refreshed every layout effect.
  const layoutRects = useRef(new Map());
  // FLIP's "First": on-screen rects captured the instant BEFORE an order
  // change, by original index.
  const firstRects = useRef(null);

  // Props the window-level pointer handlers read at call time, so those
  // handlers can stay stable across renders instead of being rebuilt (and
  // re-registered) on every parent update.
  const P = useRef(null);
  P.current = { items, onReorder, snapZones, growToContain, onDragActiveChange, enabled, dragFromInteractive, isGrid, isHorizontal };

  // A parent that adds or removes an item mid-gesture invalidates the preview
  // order's indices. Render the real list and abort rather than map a stale
  // index onto a missing item.
  const stale = !!ds && ds.order.length !== items.length;
  const view = ds && !stale ? ds.order.map((i) => items[i]) : items;
  itemRefs.current.length = view.length;

  // ── Geometry ──────────────────────────────────────────────────────────────

  // Where the pointer currently wants the dragged tile's top-left, in viewport
  // coordinates, after the container's resistance. Used to POSITION the tile in
  // cursor mode, and (via its centre) to hit-test slots in that mode too.
  const pointerTarget = useCallback(() => {
    const d = dRef.current;
    const lr = layoutRects.current.get(d.oi);
    const w = lr ? lr.width : d.w;
    const h = lr ? lr.height : d.h;
    let x = d.originLeft + (mouseRef.current.x - d.sx);
    let y = d.originTop + (mouseRef.current.y - d.sy);
    const cb = containerRef.current?.getBoundingClientRect();
    if (!cb) return { x, y, w, h };
    const band = (v, min, max) => (v < min ? min - (min - v) * RUBBER : v > max ? max + (v - max) * RUBBER : v);
    if (isGrid) {
      x = band(x, cb.left, cb.right - w);
      y = band(y, cb.top, cb.bottom - h);
    } else if (isHorizontal) {
      x = band(x, cb.left, cb.right - w);
      y = lr ? lr.top : y;
    } else if (d.grow) {
      // Past either panel edge the tile keeps going with resistance and the
      // card grows to contain it (see growWrite), so a tile never leaves the
      // panel — the panel expands.
      if (y + h > cb.bottom) y = cb.bottom - h + resist(y + h - cb.bottom);
      else if (y < cb.top) y = cb.top - resist(cb.top - y);
      x = lr ? lr.left : x;
    } else {
      y = band(y, cb.top, cb.bottom - h);
      x = lr ? lr.left : x;
    }
    return { x, y, w, h };
  }, [isGrid, isHorizontal]);

  // Which slot the gesture is currently asking for. One rule for all three
  // directions: the slot whose resting centre is nearest the point the gesture
  // is aiming at, with the CURRENT slot seeded as the incumbent so a tie — or
  // anything not strictly nearer — leaves the order alone. That incumbent seed
  // is the whole hysteresis; there is no threshold fraction to tune.
  //
  // The aiming point differs by mode because what the eye follows differs: in
  // cursor mode the tile itself moves, so its centre is the thing being placed;
  // in slot-snap the tile stays in its slot and the cursor is the only thing
  // that moved.
  const pickSlot = useCallback(() => {
    const d = dRef.current;
    const cur = dsRef.current;
    if (!d || !cur) return 0;
    const me = layoutRects.current.get(d.oi);
    if (!me) return d.slot;
    let px, py;
    if (d.mode === 'cursor') {
      const t = pointerTarget();
      px = t.x + t.w / 2;
      py = t.y + t.h / 2;
    } else {
      px = mouseRef.current.x;
      py = mouseRef.current.y;
    }
    const dist = (r) => {
      const dx = px - (r.left + r.width / 2);
      const dy = py - (r.top + r.height / 2);
      if (isGrid) return dx * dx + dy * dy;
      return isHorizontal ? Math.abs(dx) : Math.abs(dy);
    };
    let best = d.slot;
    let bestD = dist(me);
    for (let s = 0; s < cur.order.length; s++) {
      if (s === d.slot) continue;
      const r = layoutRects.current.get(cur.order[s]);
      if (!r || (!r.width && !r.height)) continue;
      const v = dist(r);
      if (v < bestD) { bestD = v; best = s; }
    }
    return best;
  }, [isGrid, isHorizontal, pointerTarget]);

  // Snapshot every item's ON-SCREEN rect. Called immediately before an order
  // change so FLIP starts from where things actually are, mid-glide included.
  const captureFirst = useCallback(() => {
    const cur = dsRef.current;
    const m = new Map();
    const els = itemRefs.current;
    for (let s = 0; s < els.length; s++) {
      const el = els[s];
      if (!el) continue;
      m.set(cur ? cur.order[s] : s, el.getBoundingClientRect());
    }
    firstRects.current = m;
  }, []);

  // ── Grow-to-contain ───────────────────────────────────────────────────────
  // Written as CUSTOM PROPERTIES on the card, consumed by one !important rule
  // per element in styles.css. React owns `style.minHeight` / `style.paddingTop`
  // on these same elements, so writing them directly is what once left the right
  // rail pinned at padding-top: 0 for the life of the window (it ate 7px of the
  // gap above the first tile). Custom properties are a slot React never touches
  // here, and rest is restored by the data-attribute leaving — no snapshotting,
  // no restore bookkeeping, nothing to get wrong.
  const growWrite = useCallback((topPx, bottomPx) => {
    const card = dRef.current?.card;
    if (!card) return;
    card.style.setProperty('--dl-grow-top', `${topPx}px`);
    card.style.setProperty('--dl-grow-bottom', `${bottomPx}px`);
  }, []);

  const growEnd = useCallback(() => {
    const d = dRef.current;
    const card = d?.card;
    if (!card) return;
    card.style.removeProperty('--dl-grow-ease');
    card.style.removeProperty('--dl-grow-top');
    card.style.removeProperty('--dl-grow-bottom');
    card.style.removeProperty('--dl-rest-pt');
    card.style.removeProperty('--dl-rest-h');
    card.style.removeProperty('--dl-rest-mt');
    card.removeAttribute('data-dl-grow-card');
    d.list?.removeAttribute('data-dl-grow-list');
  }, []);

  // ── Per-frame loop ────────────────────────────────────────────────────────
  const step = useCallback(() => {
    const d = dRef.current;
    const cur = dsRef.current;
    if (!d || d.phase !== 'drag' || !cur || cur.releasing) { rafRef.current = 0; return; }
    rafRef.current = requestAnimationFrame(step);

    const t = pointerTarget();
    if (d.mode === 'cursor') {
      d.cx += (t.x - d.cx) * CHASE_RATE;
      d.cy += (t.y - d.cy) * CHASE_RATE;
      const el = itemRefs.current[d.slot];
      const lr = layoutRects.current.get(d.oi);
      if (el && lr) el.style.transform = `translate(${d.cx - lr.left}px, ${d.cy - lr.top}px)`;
      if (d.card) {
        const cb = containerRef.current?.getBoundingClientRect();
        if (cb) growWrite(Math.max(0, cb.top - d.cy), Math.max(0, d.cy + t.h - cb.bottom));
      }
    }

    const want = pickSlot();
    if (want !== d.slot) {
      captureFirst();
      const from = d.slot;
      d.slot = want;
      setDs((p) => (p ? { ...p, order: moveSlot(p.order, from, want), slot: want } : p));
    }
  }, [pointerTarget, pickSlot, captureFirst, growWrite]);

  // ── FLIP ──────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const els = itemRefs.current;
    const d = dRef.current;

    // Strip every inline transform first, so the rects measured below are
    // LAYOUT rects and never an in-flight animation frame. Safe because this
    // runs before paint: what is stripped here is re-applied a few lines down.
    for (let s = 0; s < els.length; s++) {
      const el = els[s];
      if (!el) continue;
      el.style.transition = 'none';
      el.style.transform = '';
    }

    if (!ds) {
      // At rest: hand every element back to the stylesheet and forget the
      // measurements, so nothing of the drag survives into the next one.
      for (const el of els) if (el) el.style.transition = '';
      layoutRects.current.clear();
      firstRects.current = null;
      return;
    }

    const last = new Map();
    for (let s = 0; s < ds.order.length; s++) {
      const el = els[s];
      if (el) last.set(ds.order[s], el.getBoundingClientRect());
    }
    layoutRects.current = last;

    const first = firstRects.current;
    const moved = [];
    for (let s = 0; s < ds.order.length; s++) {
      const oi = ds.order[s];
      const el = els[s];
      if (!el) continue;
      const n = last.get(oi);
      // The pointer-driven tile is not a FLIP participant while the gesture is
      // live: re-anchor it to its NEW slot at the same on-screen position, so a
      // reorder shuffling underneath it never shows as a jump under the finger.
      if (d && oi === d.oi && d.mode === 'cursor' && !ds.releasing) {
        el.style.transform = `translate(${d.cx - n.left}px, ${d.cy - n.top}px)`;
        continue;
      }
      const p = first?.get(oi);
      if (!p || !n) continue;
      const dx = p.left - n.left;
      const dy = p.top - n.top;
      if (!dx && !dy) continue;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(el);
    }
    firstRects.current = null;
    if (!moved.length) return;
    // One reflow commits the inverted positions, then they play to rest.
    // Cleared to '' and not to a zero translate: a lingering transform keeps
    // the element on its own compositing layer, where a fractional position is
    // snapped to a whole device pixel and the item paints 1px off its
    // neighbours (photographed on the chips and the dock, September 2026).
    void els[0].offsetWidth;
    for (const el of moved) {
      el.style.transition = `transform ${GLIDE}`;
      el.style.transform = '';
    }
  });

  // ── Gesture ───────────────────────────────────────────────────────────────

  const clearHold = useCallback(() => {
    if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = 0; }
  }, []);

  const detach = useCallback(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onAbort);
    window.removeEventListener('blur', onAbort);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers are stable (defined below, captured by closure)
  }, []);

  const finish = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    growEnd();
    dRef.current = null;
    setDs(null);
    // The release point rides along: a surface whose hover was suspended for
    // the drag needs to know where the pointer ACTUALLY is to resume.
    P.current.onDragActiveChange?.(false, mouseRef.current);
  }, [growEnd]);

  const beginDrag = useCallback((slot, cx, cy) => {
    const el = itemRefs.current[slot];
    if (!el) return;
    // Signal drag-active FIRST so consumers (the dock) can cancel a hover
    // affordance before anything is measured; the rect read below forces the
    // style/layout flush that applies it.
    P.current.onDragActiveChange?.(true);
    const r = el.getBoundingClientRect();

    // A grid is always slot-snap, whatever the setting says: its chips live in
    // a run of fixed slots, so the lifted one steps between them rather than
    // floating free. So is a horizontal strip — the dock, user-directed
    // 2026-09-13 that its drag must read as the playlist drag. The setting
    // governs the vertical rails, which is what its description already scopes
    // it to. Read once at lift; a mid-drag change applies to the next drag.
    const mode = (P.current.isGrid || P.current.isHorizontal)
      ? 'slot-snap'
      : (document.body?.getAttribute('data-anim-drag-tile-follow') === 'slot-snap' ? 'slot-snap' : 'cursor');

    const list = containerRef.current;
    const card = (P.current.growToContain && !P.current.isHorizontal && list) ? list.parentElement : null;
    dRef.current = {
      phase: 'drag', mode, slot, oi: slot,
      sx: cx, sy: cy,
      originLeft: r.left, originTop: r.top,
      cx: r.left, cy: r.top, w: r.width, h: r.height,
      card, list,
    };
    mouseRef.current = { x: cx, y: cy };

    if (card) {
      // Freeze the resting values the grow rule adds to, read off the live
      // element rather than restated from whatever the owner renders.
      const lcs = window.getComputedStyle(list);
      card.style.setProperty('--dl-rest-pt', lcs.paddingTop);
      card.style.setProperty('--dl-rest-h', `${list.getBoundingClientRect().height}px`);
      card.style.setProperty('--dl-rest-mt', window.getComputedStyle(card).marginTop);
      card.style.setProperty('--dl-grow-top', '0px');
      card.style.setProperty('--dl-grow-bottom', '0px');
      card.setAttribute('data-dl-grow-card', '');
      list.setAttribute('data-dl-grow-list', '');
    }

    captureFirst();
    setDs({ order: P.current.items.map((_, i) => i), oi: slot, slot, releasing: false });
    playReorderPickup();
    // Let the pressed face paint one frame before it is dropped: cleared up
    // front there is no pressed state to transition FROM, so the face teleports
    // up at lift. One frame in, .candy-face's own 150ms ease-out carries it.
    requestAnimationFrame(() => releasePress(el));
    if (!rafRef.current) rafRef.current = requestAnimationFrame(step);
  }, [captureFirst, step]);

  // Edge-snap (dock only). Returns a drop index in onReorder's slot-between
  // convention, or null for "no zone hit". Measured against the CONTAINER so a
  // wide flex spacer never skews it.
  const snapIndex = useCallback(() => {
    const sz = P.current.snapZones;
    const container = containerRef.current;
    if (!sz || !container) return null;
    const cr = container.getBoundingClientRect();
    const x = mouseRef.current.x;
    const t = sz.triggerPx ?? 48;
    if (x <= cr.left + t) return 0;
    if (x >= cr.right - t) return P.current.items.length;
    const mid = (cr.left + cr.right) / 2;
    if (Math.abs(x - mid) <= t) return sz.centerIndex ?? Math.floor(P.current.items.length / 2);
    return null;
  }, []);

  const onMove = useCallback((e) => {
    const d = dRef.current;
    if (!d) return;
    if (d.phase === 'hold') {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        clearHold();
        if (P.current.dragFromInteractive) {
          // Dock: a move during the hold cancels, so a tap stays navigation and
          // only a deliberate still hold reads as drag intent.
          dRef.current = null;
          detach();
        } else {
          // Reorder lists: movement STARTS the drag without waiting out the
          // hold timer.
          beginDrag(d.slot, e.clientX, e.clientY);
        }
      }
      return;
    }
    e.preventDefault();
    mouseRef.current = { x: e.clientX, y: e.clientY };
  }, [clearHold, detach, beginDrag]);

  const onUp = useCallback((e) => {
    detach();
    const d = dRef.current;
    if (!d) return;
    clearHold();
    if (d.phase === 'hold') { dRef.current = null; return; }

    e.preventDefault();
    // True release point — the last pointermove can lag it by one event.
    mouseRef.current = { x: e.clientX, y: e.clientY };
    // A real lift happened. Swallow the synthetic click the browser fires after
    // pointerup so a hold-drag never also triggers the item's onClick (a dock
    // button would navigate). Cleared next tick so it never eats a real click.
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);

    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }

    const from = d.oi;
    let slot = pickSlot();
    const snapped = P.current.snapZones && P.current.isHorizontal ? snapIndex() : null;
    if (snapped != null) slot = snapped > from ? snapped - 1 : snapped;

    playReorderDrop();

    // Capture the on-screen positions BEFORE the final order lands, so the
    // release is the same FLIP as every other move: the tile eases from where
    // the finger left it into the slot it already occupies.
    captureFirst();
    d.slot = slot;
    setDs((p) => (p ? { ...p, order: moveSlot(p.order, p.slot, slot), slot, releasing: true } : p));

    if (d.card) {
      d.card.style.setProperty('--dl-grow-ease', GLIDE);
      growWrite(0, 0);
    }

    // onReorder takes a slot-BETWEEN index: `to === from` and `to === from + 1`
    // are both no-ops, and a downward move loses one index when the source is
    // spliced out. Every consumer's remap reads it that way, so convert the
    // landed slot back into it rather than changing nine call sites.
    const to = slot > from ? slot + 1 : slot;

    setTimeout(() => {
      // Commit the real order and drop the preview in ONE render, so there is
      // never a frame showing the old arrangement.
      flushSync(() => {
        finish();
        if (from !== to) P.current.onReorder?.(from, to);
      });
    }, GLIDE_MS);
  }, [detach, clearHold, pickSlot, snapIndex, captureFirst, growWrite, finish]);

  // A release outside the OS window, or a blur mid-drag (Alt-Tab, a focus-
  // stealing dialog), never produces a pointerup.
  const onAbort = useCallback(() => {
    if (!dRef.current) return;
    detach();
    clearHold();
    finish();
  }, [detach, clearHold, finish]);

  const onItemDown = useCallback((e, slot) => {
    if (!P.current.enabled || e.button !== 0) return;
    suppressClickRef.current = false;
    // Pickup is allowed only from non-interactive chrome. With
    // dragFromInteractive (the dock, whose every item IS a button) the whole
    // item is a drag surface and only inputs and explicit data-no-drag block it.
    const blockSelector = P.current.dragFromInteractive
      ? 'input, textarea, select, [contenteditable], [data-no-drag]'
      : 'button, a, [role="button"], input, textarea, select, [contenteditable], [data-no-drag]';
    const blocked = e.target.closest?.(blockSelector);
    if (blocked && blocked !== e.currentTarget) return;
    if (!itemRefs.current[slot]) return;

    dRef.current = { phase: 'hold', slot, sx: e.clientX, sy: e.clientY };
    mouseRef.current = { x: e.clientX, y: e.clientY };
    holdRef.current = setTimeout(() => beginDrag(slot, e.clientX, e.clientY), HOLD_MS);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { passive: false });
    window.addEventListener('pointercancel', onAbort);
    window.addEventListener('blur', onAbort);
  }, [beginDrag, onMove, onUp, onAbort]);

  useEffect(() => { if (stale) onAbort(); }, [stale, onAbort]);

  useEffect(() => () => {
    detach();
    clearHold();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    growEnd();
  }, [detach, clearHold, growEnd]);

  return (
    <div
      ref={containerRef}
      data-drag-list=""
      data-dragging={ds ? 'true' : undefined}
      className={className}
      style={{ display: 'flex', flexDirection: isHorizontal || isGrid ? 'row' : 'column', flexWrap: isGrid ? 'wrap' : undefined, ...style }}
    >
      {view.map((item, s) => {
        const oi = ds ? ds.order[s] : s;
        const isDragged = ds ? oi === ds.oi : false;
        return (
          <div
            // Keyed on the item's ORIGINAL index, so the key is stable while
            // the preview order shuffles: React MOVES the existing node instead
            // of remounting it, which is what lets FLIP animate it (and what
            // keeps an index-bearing key like `${id}:${i}` from changing
            // mid-drag).
            key={keyExtractor(item, oi)}
            ref={(el) => { itemRefs.current[s] = el; }}
            onPointerDown={(e) => onItemDown(e, s)}
            onClickCapture={(e) => { if (suppressClickRef.current) { e.stopPropagation(); e.preventDefault(); } }}
            className={isDragged && !ds.releasing ? 'is-dragging' : undefined}
            style={{
              ...(getItemStyle ? getItemStyle(item, oi) : {}),
              position: 'relative',
              // Above its siblings for the whole gesture, drop glide included.
              zIndex: isDragged ? 2 : undefined,
              cursor: enabled ? 'grab' : undefined,
              pointerEvents: isDragged ? 'none' : undefined,
            }}
          >
            {renderItem(item, oi)}
          </div>
        );
      })}
    </div>
  );
}
