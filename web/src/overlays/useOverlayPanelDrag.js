// CSS-transform drag for a host overlay panel (NOT a window move). The overlay-
// host is one fullscreen webview; each panel is an absolutely-positioned DOM node
// dragged by translate(). Pure frontend — no async IPC, no devicePixelRatio math
// (contrast the window-move dance the standalone overlay-capture window used).
// Position persists per panel key to localStorage so a panel reopens where it was
// left. onPointerDown bails on interactive children so buttons/inputs still work.
import { useCallback, useEffect, useRef, useState } from 'react';

// Keep a dragged panel on-screen. Without this, a panel dragged past the overlay
// window edge is clipped by the host's overflow:hidden and effectively lost —
// there's no handle left to grab it back. Clamp the top-left so a grabbable strip
// (incl. the header) always stays inside the viewport.
function clampPos(p) {
  const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1920;
  const h = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 1080;
  const maxX = Math.max(0, w - 120); // leave >=120px of the panel reachable
  const maxY = Math.max(0, h - 48);  // keep the header row on-screen
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

  // Recover a panel saved off-screen (dragged onto another monitor before this
  // clamp existed) and re-clamp after a viewport / monitor-layout change.
  useEffect(() => {
    const reclamp = () => setPos((p) => clampPos(p));
    reclamp();
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, []);

  const onPointerDown = useCallback((e) => {
    if (e.target.closest('button,textarea,input,select,a,[data-no-drag]')) return;
    e.preventDefault();
    drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    setPos(clampPos({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }));
  }, []);

  const end = useCallback((e) => {
    if (!drag.current) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // Functional update reads the latest pos (the closure's pos may be stale).
    setPos((p) => { const c = clampPos(p); try { localStorage.setItem(key, JSON.stringify(c)); } catch {} return c; });
  }, [key]);

  return {
    style: { transform: `translate(${pos.x}px, ${pos.y}px)` },
    dragProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}
