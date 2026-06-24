// useClipDrag — useBlockDrag (modules/core/planner/CalendarPanel.jsx:96-232)
// ported horizontal for timeline clips. COPY, not import: the original is
// planner-internal. Same engine: window pointer listeners, 4 px threshold
// before a click becomes a drag, rAF exponential chase toward a snapped +
// clamped target, translate3d-only motion, two-step WebKit release glide,
// post-drag click suppression, selectstart kill, and the body
// data-anim-drag-* tunables (drag-tile-follow intentionally ignored — the
// timeline always frame-snaps, like the calendar always slot-snaps).
// Differences from the source: the axis is horizontal (frames, not minutes),
// lanes replace day columns ([data-track-lane] inside the closest
// [data-tl-lanes]), and snap+clamp is delegated to resolveTarget — Timeline
// owns the frame grid, magnetic points, and neighbor-gap math. `moving`
// stays true after release so the clip holds at the dropped spot until the
// parent commit remounts it via its geometry-encoding key; `releasing`
// re-enables pointer events immediately so a no-op drop stays clickable.

import { useEffect, useRef, useState } from 'react';

export default function useClipDrag({
  elRef,
  startFrame,
  durFrames,
  ppf,            // px per frame at the zoom level current at pointerdown
  laneIdx,        // the clip's own track index
  selfId,
  resolveTarget,  // (laneIdx, desiredStartFrame, durFrames, selfId) → start | null
  onCommit,       // (laneIdx, startFrame)
}) {
  const [moving, setMoving] = useState(false);
  const [moveDelta, setMoveDelta] = useState({ x: 0, y: 0 });
  const [liveStart, setLiveStart] = useState(null);
  const [releasing, setReleasing] = useState(false);
  const drag = useRef(null);
  const glideRef = useRef(160);

  // Defensive teardown if the clip unmounts mid-drag before pointerup runs.
  useEffect(() => () => {
    const d = drag.current;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    window.removeEventListener('pointermove', d.move);
    window.removeEventListener('pointerup', d.up);
    document.removeEventListener('selectstart', d.killSelect);
  }, []);

  function onPointerDown(e) {
    if (e.target.closest('[data-resize]')) return; // trim handles (SF7) own their loop
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    const el = elRef.current;
    const ownLane = el?.closest('[data-track-lane]');
    const lanesRoot = ownLane?.closest('[data-tl-lanes]');
    if (!ownLane || !lanesRoot) return;
    const scroller = lanesRoot.closest('[data-tl-scroll]');
    const lanes = Array.from(lanesRoot.querySelectorAll('[data-track-lane]'))
      .map(l => ({ idx: Number(l.dataset.trackLane), rect: l.getBoundingClientRect() }))
      .sort((a, b) => a.rect.top - b.rect.top);
    if (!lanes.length) return;
    const originLane = lanes.find(l => l.idx === laneIdx) || lanes[0];
    const blockRect = el.getBoundingClientRect();

    const smooth = document.body?.getAttribute('data-anim-drag-tile-smoothness') || 'medium';
    const chaseRate = ({ none: 1, light: 0.35, medium: 0.18, heavy: 0.08 })[smooth] ?? 0.18;
    const glideKey = document.body?.getAttribute('data-anim-drag-drop-glide') || '75';
    glideRef.current = ({ off: 0, '25': 480, '50': 240, '75': 160, '100': 120 })[glideKey] ?? 160;

    const d = {
      lanes, originLane, chaseRate,
      scroll0: scroller ? scroller.scrollLeft : 0, // rects are a pointerdown snapshot — mid-drag scroll isn't tracked (same exposure as the calendar)
      grabOffsetX: e.clientX - blockRect.left,
      startX: e.clientX, startY: e.clientY,
      cursor: { x: e.clientX, y: e.clientY },
      cur: { x: 0, y: 0 },
      lastTarget: null, moved: false, raf: 0, move, up, killSelect,
    };
    drag.current = d;

    // Snapped + clamped target for the current cursor: lane from cursor Y
    // (clamped to the outer lanes), start frame from cursor X via the
    // pointerdown scroll snapshot, then Timeline's resolveTarget applies
    // magnets + neighbor-gap clamping. A null resolve (no gap fits) keeps the
    // last valid target instead of jumping.
    function target() {
      const { x, y } = d.cursor;
      const lane = d.lanes.find(l => y >= l.rect.top && y < l.rect.bottom)
        || (y < d.lanes[0].rect.top ? d.lanes[0] : d.lanes[d.lanes.length - 1]);
      const desired = Math.round((x - d.grabOffsetX - lane.rect.left + d.scroll0) / ppf);
      const start = resolveTarget(lane.idx, desired, durFrames, selfId);
      if (start == null) {
        return d.lastTarget || { dx: 0, dy: 0, laneIdx, start: startFrame };
      }
      return {
        dx: (start - startFrame) * ppf,
        dy: lane.rect.top - d.originLane.rect.top,
        laneIdx: lane.idx, start,
      };
    }
    // Per-frame exponential chase toward the snapped target (the "light drag").
    function loop() {
      const t = target();
      d.lastTarget = t;
      setLiveStart(t.start);
      d.cur.x += (t.dx - d.cur.x) * d.chaseRate;
      d.cur.y += (t.dy - d.cur.y) * d.chaseRate;
      setMoveDelta({ x: d.cur.x, y: d.cur.y });
      d.raf = requestAnimationFrame(loop);
    }
    function move(ev) {
      d.cursor = { x: ev.clientX, y: ev.clientY };
      if (d.moved) return;
      const ax = ev.clientX - d.startX, ay = ev.clientY - d.startY;
      if (ax * ax + ay * ay > 16) { // 4px threshold before a click becomes a drag
        d.moved = true;
        setReleasing(false);
        setMoving(true);
        window.getSelection?.()?.removeAllRanges?.();
        d.raf = requestAnimationFrame(loop);
      }
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.removeEventListener('selectstart', killSelect);
      if (!d.moved) { drag.current = null; return; } // a click, not a drag
      cancelAnimationFrame(d.raf);
      // Swallow the click that the browser fires after a drag-release.
      const suppress = (e2) => { e2.stopPropagation(); window.removeEventListener('click', suppress, true); };
      window.addEventListener('click', suppress, true);
      const t = d.lastTarget || target();
      setLiveStart(t.start);
      // Two-step so the glide transition is live BEFORE the transform changes
      // (a same-render transition+transform swap is skipped by WebKit): enable
      // the transition this frame, settle onto the snapped spot next frame.
      setReleasing(true);
      requestAnimationFrame(() => setMoveDelta({ x: t.dx, y: t.dy }));
      onCommit?.(t.laneIdx, t.start);
      // Keep moving=true; the parent commit remounts the clip (geometry key).
    }
    // Kill text-selection for the whole press: mid-drag the clip goes
    // pointer-events:none, so the cursor sweeps selectable ruler/label text
    // underneath where a selection would re-anchor.
    function killSelect(ev) { ev.preventDefault(); }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.addEventListener('selectstart', killSelect);
  }

  const dragTransform = `translate3d(${moveDelta.x}px, ${moveDelta.y}px, 0)`;
  const dragTransition = releasing && glideRef.current > 0
    ? `transform ${glideRef.current}ms cubic-bezier(0.32,0.72,0,1)`
    : 'none';
  return { moving, releasing, dragTransform, dragTransition, onPointerDown, liveStart };
}
