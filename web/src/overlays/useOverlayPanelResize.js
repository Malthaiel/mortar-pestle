// Corner-handle pointer resize for a host overlay panel — the sibling primitive
// of useOverlayPanelDrag (that hook owns position via translate(); this one owns
// width/height). Pointer-captured drag on the handle element, clamped to
// [min, viewport], persisted per panel key on release. The handle carries
// data-no-drag so the panel's drag hook ignores it. The min floor keeps inner
// chrome from inverting (the browser panel's POPOVER_HEIGHT viewport shrink
// needs ≥520px of height to stay positive).
import { useCallback, useRef, useState } from 'react';

function clampSize(s, min) {
  const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 1080;
  return {
    w: Math.min(Math.max(s.w, min.w), vw),
    h: Math.min(Math.max(s.h, min.h), vh),
  };
}

export default function useOverlayPanelResize(key, initial = { w: 960, h: 640 }, min = { w: 680, h: 520 }) {
  // min/initial are captured once — callers pass literals, and a resize
  // primitive's floor never changes mid-session.
  const minRef = useRef(min);
  const [size, setSize] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) return clampSize(saved, minRef.current);
    } catch { /* garbled saved value — fall through to the configured default */ }
    return clampSize(initial, minRef.current);
  });
  const drag = useRef(null);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { px: e.clientX, py: e.clientY, ow: size.w, oh: size.h };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
  }, [size.w, size.h]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    setSize(clampSize({ w: d.ow + (e.clientX - d.px), h: d.oh + (e.clientY - d.py) }, minRef.current));
  }, []);

  const end = useCallback((e) => {
    if (!drag.current) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // Functional update reads the latest size (the closure's may be stale).
    setSize((s) => { const c = clampSize(s, minRef.current); try { localStorage.setItem(key, JSON.stringify(c)); } catch { /* ignore */ } return c; });
  }, [key]);

  return {
    size,
    resizeProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}
