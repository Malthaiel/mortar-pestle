// CSS-transform drag for a host overlay panel (NOT a window move). The overlay-
// host is one fullscreen webview; each panel is an absolutely-positioned DOM node
// dragged by translate(). Pure frontend — no async IPC, no devicePixelRatio math
// (contrast the window-move dance the standalone overlay-capture window used).
// Position persists per panel key to localStorage so a panel reopens where it was
// left. onPointerDown bails on interactive children so buttons/inputs still work.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GLIDE } from '../util/motion.js';

// Keep a dragged panel on-screen. Without this, a panel dragged past the overlay
// window edge is clipped by the host's overflow:hidden and effectively lost —
// there's no handle left to grab it back. With the panel's measured size, clamp
// all four edges so the WHOLE panel stays inside the viewport (symmetric — no
// edge lets any part escape). Before the first drag (size unknown) fall back to
// keeping a grabbable strip reachable so a restored off-screen position recovers.
function clampPos(p, size) {
  const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1920;
  const h = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 1080;
  const pw = size?.w || 0;
  const ph = size?.h || 0;
  const maxX = pw ? Math.max(0, w - pw) : Math.max(0, w - 120);
  const maxY = ph ? Math.max(0, h - ph) : Math.max(0, h - 48);
  return { x: Math.min(Math.max(p.x, 0), maxX), y: Math.min(Math.max(p.y, 0), maxY) };
}

export default function useOverlayPanelDrag(key, initial = { x: 0, y: 0 }) {
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clampPos(saved);
    } catch { /* garbled saved value — fall through to the configured default */ }
    return clampPos(initial);
  });
  const drag = useRef(null);
  // Panel's rendered size, measured at each drag start (the panel is content-height
  // so it changes as tiles reorder / grow). Drives the four-edge clamp.
  const sizeRef = useRef({ w: 0, h: 0 });

  // Recover a panel saved off-screen (dragged onto another monitor before this
  // clamp existed) and re-clamp after a viewport / monitor-layout change.
  useEffect(() => {
    const reclamp = () => setPos((p) => clampPos(p, sizeRef.current));
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, []);

  const onPointerDown = useCallback((e) => {
    if (e.target.closest('button,textarea,input,select,a,[data-no-drag]')) return;
    e.preventDefault();
    // Measure the visible panel box (the header's card ancestor) so the clamp
    // keeps the whole panel on-screen on all four edges.
    const panel = e.currentTarget.closest('.candy-card') || e.currentTarget.parentElement;
    if (panel) { const r = panel.getBoundingClientRect(); sizeRef.current = { w: r.width, h: r.height }; }
    drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    setPos(clampPos({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }, sizeRef.current));
  }, []);

  const end = useCallback((e) => {
    if (!drag.current) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // Functional update reads the latest pos (the closure's pos may be stale).
    setPos((p) => { const c = clampPos(p, sizeRef.current); try { localStorage.setItem(key, JSON.stringify(c)); } catch {} return c; });
  }, [key]);

  // Shift the panel's X by dx without a header drag — used by a left-edge resize to
  // keep the panel's RIGHT edge fixed while the width grows/shrinks from the left.
  const nudgeX = useCallback((dx) => {
    setPos((p) => clampPos({ x: p.x + dx, y: p.y }, sizeRef.current));
  }, []);
  // Same, vertical — a top-edge resize keeps the panel's BOTTOM edge fixed.
  const nudgeY = useCallback((dy) => {
    setPos((p) => clampPos({ x: p.x, y: p.y + dy }, sizeRef.current));
  }, []);
  // Persist the current position (a resize interaction owns its own pointer-up, so it
  // calls this to save the nudged X the same way a drag's end handler saves a move).
  const commitPos = useCallback(() => {
    setPos((p) => { const c = clampPos(p, sizeRef.current); try { localStorage.setItem(key, JSON.stringify(c)); } catch { /* ignore */ } return c; });
  }, [key]);

  return {
    // The panel TRAILS the cursor on the app's one glide instead of tracking it
    // 1:1 (Motion Unification, 2026-08-13). Left on permanently rather than
    // gated to the drag: the same trail is what a release settles on, and the
    // on-resize reclamp then glides back into view instead of teleporting.
    style: {
      transform: `translate(${pos.x}px, ${pos.y}px)`,
      transition: `transform ${GLIDE}`,
    },
    dragProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
    nudgeX,
    nudgeY,
    commitPos,
  };
}
