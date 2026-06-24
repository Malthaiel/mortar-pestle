// SF7 of Design Mode — Atelier chat drag-to-relocate hook. Mouse-based drag
// from the [data-aos-chat-drag-handle] inside ChatHeader. Free drag with an
// edge magnet: on release, if the window lands within `magnetRadius` px of a
// content-area edge it snaps flush to that edge and slides freely along it;
// with `snapCorners` on, both axes can snap at once to dock a corner.
// magnetRadius 0 = pure free drag.
//
// Motion is GPU-composited. left/top hold the committed BASE position; an
// imperative `transform: translate3d()` — driven by a requestAnimationFrame
// chase loop, never per-frame setState — carries the window during drag and the
// post-release settle, so the heavy chat subtree never re-renders mid-drag.
// `dragSmoothness` (none|light|medium|heavy) sets the chase rate: how much the
// window trails the cursor, reusing the same buckets as the sidebar tile drag
// (none = pinned 1:1, heavy = a weighty trail). The same loop decelerates into
// the snapped resting point (that deceleration IS the settle) and animates the
// Reset-position glide back to default. Window resize re-anchors instantly.
// Final {x, y, anchor} persists to settings.agents.chatPosition (debounced) so
// edge/corner docks follow the viewport on resize. A null chatPosition (the
// Reset-position button) glides back to the default bottom-right.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const WIDTH = 380;
const HEIGHT = 520;
const SIDEBAR_RAIL = 56;
const EDGE_GAP = 8;
const DOCK_GAP_BOTTOM = 60;

// Trailing-glide chase rate per frame — shared vocabulary with the sidebar tile
// drag (data-anim-drag-tile-smoothness). Higher closes more of the gap to the
// target each frame: 1 = instant 1:1, 0.08 = heavy weighty trail.
const CHASE = { none: 1.0, light: 0.35, medium: 0.18, heavy: 0.08 };

// Flush top-left coordinates for each content-area edge — clears the left
// sidebar rail and the bottom dock so the chat never hides under chrome.
function edgesForViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    left: SIDEBAR_RAIL + EDGE_GAP,
    right: w - WIDTH - EDGE_GAP,
    top: EDGE_GAP,
    bottom: h - HEIGHT - DOCK_GAP_BOTTOM,
  };
}

function defaultPosition() {
  const e = edgesForViewport();
  return { x: e.right, y: e.bottom, anchor: 'bottom-right' };
}

function clampToViewport(x, y) {
  return {
    x: Math.max(EDGE_GAP, Math.min(window.innerWidth - WIDTH - EDGE_GAP, x)),
    y: Math.max(EDGE_GAP, Math.min(window.innerHeight - HEIGHT - EDGE_GAP, y)),
  };
}

// Snap an already-clamped free position to the nearest content-area edge(s).
// radius 0 disables snapping. With snapCorners each axis snaps independently
// (both near → corner); without, only the single nearest edge snaps so the
// window stays free to slide along it. anchor ∈ {left|right|top|bottom|
// top-left|top-right|bottom-left|bottom-right|free}.
function snapToEdges(x, y, radius, snapCorners) {
  if (!radius || radius <= 0) return { x, y, anchor: 'free' };
  const e = edgesForViewport();
  const dLeft = Math.abs(x - e.left);
  const dRight = Math.abs(x - e.right);
  const dTop = Math.abs(y - e.top);
  const dBottom = Math.abs(y - e.bottom);
  const hMin = Math.min(dLeft, dRight);
  const vMin = Math.min(dTop, dBottom);
  const hSide = dLeft <= dRight ? 'left' : 'right';
  const vSide = dTop <= dBottom ? 'top' : 'bottom';
  const hNear = hMin <= radius;
  const vNear = vMin <= radius;

  if (snapCorners) {
    const anchor = hNear && vNear ? `${vSide}-${hSide}`
      : hNear ? hSide
      : vNear ? vSide
      : 'free';
    return { x: hNear ? e[hSide] : x, y: vNear ? e[vSide] : y, anchor };
  }
  // Edges only — flush the single nearest edge, slide along the other axis.
  if (!hNear && !vNear) return { x, y, anchor: 'free' };
  if (hMin <= vMin) return { x: e[hSide], y, anchor: hSide };
  return { x, y: e[vSide], anchor: vSide };
}

// Recompute a stored position's flush coords for the current viewport: right/
// bottom track w/h, left/top are constant, free axes are re-clamped into view.
function reanchor(p) {
  if (!p) return p;
  const e = edgesForViewport();
  const a = p.anchor || 'free';
  const clamped = clampToViewport(p.x, p.y);
  const x = a.includes('left') ? e.left : a.includes('right') ? e.right : clamped.x;
  const y = a.includes('top') ? e.top : a.includes('bottom') ? e.bottom : clamped.y;
  return { ...p, x, y };
}

// px of cursor movement before a header hold engages a drag (mirrors
// useBlockDrag's 4px gate). A click below this just press-and-releases the
// candy button — no drag, no edge-snap, no position persist.
const DRAG_THRESHOLD = 4;

export function useDragChat({ settings, setSetting, posKey }) {
  const magnetRadius = settings?.agents?.magnetRadius ?? 80;
  const snapCorners = settings?.agents?.snapCorners ?? false;
  const dragSmoothness = settings?.agents?.dragSmoothness ?? 'medium';
  const stored = posKey ? settings?.agents?.[posKey]?.chatPosition : settings?.agents?.chatPosition;

  const initial = (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y))
    ? stored
    : defaultPosition();

  const [position, setPosition] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const [pressed, setPressed] = useState(false); // held (mousedown→mouseup): drives the candy depress on the whole window

  const dragRef = useRef(null);                       // the chat window element
  const posRef = useRef(initial);                     // latest committed position
  const offsetRef = useRef({ dx: 0, dy: 0 });
  const startRef = useRef({ x: 0, y: 0 }); // mousedown client coords for the movement threshold
  const baseRef = useRef({ x: initial.x, y: initial.y });   // left/top during a move
  const targetRef = useRef({ x: initial.x, y: initial.y }); // where cur chases to
  const curRef = useRef({ x: initial.x, y: initial.y });    // rendered (lerped) coord
  const commitRef = useRef(initial);                  // full {x,y,anchor} to commit
  const rafRef = useRef(0);
  const draggingRef = useRef(false);
  const settlingRef = useRef(false);
  const persistRef = useRef(false);
  const persistTimer = useRef(null);
  posRef.current = position;

  const magnetR = useRef(magnetRadius);
  const cornersR = useRef(snapCorners);
  const chaseR = useRef(CHASE.medium);
  magnetR.current = magnetRadius;
  cornersR.current = snapCorners;
  chaseR.current = CHASE[dragSmoothness] ?? CHASE.medium;

  const persistPosition = useCallback((next) => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      // Per-agent position: agents.<posKey>.chatPosition (the agents bag is
      // shallow-merged, so for v1 the scoped bag holds only chatPosition).
      // Atelier (no posKey) keeps the legacy agents.chatPosition.
      if (posKey) setSetting('agents', { [posKey]: { chatPosition: next } });
      else setSetting('agents', { chatPosition: next });
    }, 200);
  }, [setSetting, posKey]);

  const applyTransform = () => {
    const el = dragRef.current;
    if (el) {
      el.style.transform =
        `translate3d(${curRef.current.x - baseRef.current.x}px, ${curRef.current.y - baseRef.current.y}px, 0)`;
    }
  };

  // Exponential chase: each frame closes `chase` of the gap to the target and
  // writes the result as a transform. When released (not dragging) and settled
  // within 0.5px, commit base ← final and stop — the layout effect then clears
  // the transform in the same paint, so there is no flash.
  const runLoop = useCallback(() => {
    if (rafRef.current) return;
    const tick = () => {
      const c = curRef.current;
      const t = targetRef.current;
      const k = chaseR.current;
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      const settled = Math.abs(t.x - c.x) < 0.5 && Math.abs(t.y - c.y) < 0.5;
      if (!draggingRef.current && settled) {
        c.x = t.x;
        c.y = t.y;
        applyTransform();
        rafRef.current = 0;
        settlingRef.current = false;
        const commit = commitRef.current;
        const persist = persistRef.current;
        persistRef.current = false;
        setPosition(commit);
        if (persist) persistPosition(commit);
        return;
      }
      applyTransform();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [persistPosition]);

  // Keep curRef/transform in sync after any committed (non-drag) position
  // change — settle commit, reset glide, resize re-anchor, mount. Runs after
  // React writes left/top and before paint, so clearing the imperative
  // transform never shows an intermediate frame.
  useLayoutEffect(() => {
    if (!draggingRef.current && !settlingRef.current) {
      curRef.current = { x: position.x, y: position.y };
      const el = dragRef.current;
      if (el) el.style.transform = '';
    }
  }, [position]);

  // Re-anchor edge/corner-docked positions on viewport resize (instant; a drag
  // in flight keeps its own listeners and snaps on release).
  useEffect(() => {
    const onResize = () => {
      if (draggingRef.current) return;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      settlingRef.current = false;
      setPosition((p) => reanchor(p));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // External reset: when chatPosition is cleared (null/invalid) and we're not
  // mid-drag, glide back to the default. The Reset-position button writes null.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (draggingRef.current) return;
    // Skip the very first (mount) run — the window already starts at its default
    // when stored is null, so an initial glide is a no-op that can race the first
    // drag. Only glide when stored TRANSITIONS to null afterward (Reset button).
    if (!didInitRef.current) { didInitRef.current = true; return; }
    if (!stored || !Number.isFinite(stored.x) || !Number.isFinite(stored.y)) {
      const def = defaultPosition();
      baseRef.current = { x: posRef.current.x, y: posRef.current.y };
      curRef.current = { x: posRef.current.x, y: posRef.current.y };
      targetRef.current = { x: def.x, y: def.y };
      commitRef.current = def;
      settlingRef.current = true;
      persistRef.current = false;
      runLoop();
    }
  }, [stored, runLoop]);

  // Cancel any in-flight animation / debounce on unmount.
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (persistTimer.current) clearTimeout(persistTimer.current);
  }, []);

  const onMouseDown = useCallback((e) => {
    // Ignore mousedowns on buttons inside the header (e.g. close, controls).
    if (e.target.closest('button')) return;
    e.preventDefault();
    // The drag handle's top-left equals the chat window's top-left; capture
    // the cursor offset within it for the later drag clamp.
    const rect = e.currentTarget.getBoundingClientRect();
    offsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    startRef.current = { x: e.clientX, y: e.clientY };
    // Held = candy depress on the whole window immediately ("holding it down →
    // pressed down"). The drag itself only engages once the cursor moves past
    // DRAG_THRESHOLD, so a plain click press-and-releases with no drag/snap.
    setPressed(true);

    const engage = () => {
      // Anchor the drag at the committed base. Start the chase from where the
      // window VISUALLY is (curRef): equal to the base when idle, or the
      // in-flight coord if re-grabbed mid-settle (no jump).
      baseRef.current = { x: posRef.current.x, y: posRef.current.y };
      targetRef.current = { x: curRef.current.x, y: curRef.current.y };
      settlingRef.current = false;
      setDragging(true);
      draggingRef.current = true;
      runLoop();
    };

    const onMove = (mv) => {
      if (!draggingRef.current) {
        // Threshold gate: don't drag (or snap/persist) on a no-move click.
        if (Math.hypot(mv.clientX - startRef.current.x, mv.clientY - startRef.current.y) < DRAG_THRESHOLD) return;
        engage();
      }
      // Update the chase target only — the rAF loop carries the window there.
      targetRef.current = clampToViewport(mv.clientX - offsetRef.current.dx, mv.clientY - offsetRef.current.dy);
    };

    const onUp = (mu) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setPressed(false);
      if (!draggingRef.current) return; // a click — no drag, no snap, no persist

      setDragging(false);
      draggingRef.current = false;

      const { x, y } = clampToViewport(mu.clientX - offsetRef.current.dx, mu.clientY - offsetRef.current.dy);
      const final = snapToEdges(x, y, magnetR.current, cornersR.current);
      targetRef.current = { x: final.x, y: final.y };
      commitRef.current = final;
      settlingRef.current = true;
      persistRef.current = true;
      runLoop(); // already running; the guard makes this a no-op
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [runLoop]);

  return { position, pressed, dragging, dragHandleProps: { onMouseDown }, dragRef };
}

export const DRAG_CHAT_WIDTH = WIDTH;
export const DRAG_CHAT_HEIGHT = HEIGHT;
