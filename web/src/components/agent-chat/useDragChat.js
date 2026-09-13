// Drag for the floating agent chat window (Concierge / Analyst / Atelier).
//
// This is useOverlayPanelDrag's mechanism, 1-1 (user-directed 2026-09-13, "make
// the smooth drag match the overlay studio panel"): pointer events with pointer
// capture, the position applied as a `translate()` and carried by the app's ONE
// glide as a CSS transition. The window therefore TRAILS the cursor exactly as
// an overlay panel does, and a release settles on the same curve — no rAF chase
// loop, no per-smoothness chase rate, no hand-rolled settle.
//
// What is deliberately GONE (user-directed, same turn): edge magnets, corner
// snapping and the anchor bookkeeping that went with them, plus the dock and
// sidebar-rail gaps the old default position reserved. The window now goes
// wherever it is put. The only constraint left is the overlay panel's own: clamp
// all four edges so the whole window stays inside the viewport, because a window
// dragged off-screen leaves nothing to grab it back by — which is exactly how a
// position saved on a wider monitor made Concierge look like it would not open.
//
// agents.magnetRadius, agents.snapCorners and agents.dragSmoothness no longer
// have a consumer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { GLIDE } from '../../util/motion.js';

const WIDTH = 380;
const HEIGHT = 520;
const EDGE_GAP = 12;   // minimum clearance from every app edge

// Keep the WHOLE window inside the viewport, all four edges, symmetric, and
// never flush: EDGE_GAP is the minimum breathing room on every side, so the
// window cannot weld itself into a corner (user-directed 2026-09-13). ONE knob
// feeds every side and the default position, so no two gaps can drift apart.
function clampPos(p) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    x: Math.min(Math.max(p.x, EDGE_GAP), Math.max(EDGE_GAP, w - WIDTH - EDGE_GAP)),
    y: Math.min(Math.max(p.y, EDGE_GAP), Math.max(EDGE_GAP, h - HEIGHT - EDGE_GAP)),
  };
}

function defaultPosition() {
  return clampPos({ x: window.innerWidth - WIDTH, y: window.innerHeight - HEIGHT });
}

// px of movement before a header hold counts as a drag, so a plain click on the
// header neither moves nor persists anything.
const DRAG_THRESHOLD = 4;

export function useDragChat({ settings, setSetting, posKey }) {
  const stored = posKey ? settings?.agents?.[posKey]?.chatPosition : settings?.agents?.chatPosition;

  // Clamp the STORED position against the CURRENT viewport before first paint. A
  // position saved on a bigger screen is off-screen here, and without this the
  // window mounts outside the viewport and reads as "the agent won't open".
  const [position, setPosition] = useState(() => (
    stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? clampPos(stored) : defaultPosition()
  ));
  const [pressed, setPressed] = useState(false);
  const [dragging, setDragging] = useState(false);

  const dragRef = useRef(null);   // the window element
  const drag = useRef(null);      // live gesture: pointer origin + position origin
  const posRef = useRef(position);
  posRef.current = position;

  const persist = useCallback((next) => {
    if (posKey) setSetting('agents', { [posKey]: { chatPosition: next } });
    else setSetting('agents', { chatPosition: next });
  }, [setSetting, posKey]);

  // Re-clamp on viewport change (window resize, monitor swap) so a window that
  // would fall outside glides back in rather than disappearing.
  useEffect(() => {
    const onResize = () => setPosition((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // External reset: the Settings "Reset position" button writes null.
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current) { didInit.current = true; return; }
    if (!stored || !Number.isFinite(stored.x) || !Number.isFinite(stored.y)) setPosition(defaultPosition());
  }, [stored]);

  const onPointerDown = useCallback((e) => {
    if (e.target.closest('button, textarea, input, select, a, [data-no-drag]')) return;
    e.preventDefault();
    drag.current = { px: e.clientX, py: e.clientY, ox: posRef.current.x, oy: posRef.current.y, moved: false };
    setPressed(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
  }, []);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      setDragging(true);
    }
    setPosition(clampPos({ x: d.ox + dx, y: d.oy + dy }));
  }, []);

  const end = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setPressed(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!d.moved) return;   // a click — no move, nothing to persist
    setDragging(false);
    persist(clampPos(posRef.current));
  }, [persist]);

  return {
    position,
    pressed,
    dragging,
    // Same shape the overlay panel returns: the transform IS the position, and
    // the app's one glide IS both the trail and the settle.
    dragStyle: { transform: `translate(${position.x}px, ${position.y}px)`, transition: `transform ${GLIDE}` },
    dragHandleProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
    dragRef,
  };
}

export const DRAG_CHAT_WIDTH = WIDTH;
export const DRAG_CHAT_HEIGHT = HEIGHT;
