// Markup mode overlay. Capture-phase mousemove + click on the window;
// resolves the hit target to the deepest element under the cursor (skipping
// anything inside `[data-aos-no-mark]`).
//
// On click we hand the element to onPick — App.jsx copies its component name
// and source path to the clipboard. Markup mode stays on after the click so
// the user can chain picks (DevTools behavior). Esc or the keybind clears.

import { useCallback, useEffect, useRef, useState } from 'react';
import SelectionHighlight from './SelectionHighlight.jsx';
import { resolveTarget, buildCrumbs } from './mark-resolve.js';

// 1-pixel offset probes around the cursor — when an exact-hit pixel lands on
// the seam between two stacked [data-aos-component] siblings, elementFromPoint
// can resolve to the parent's background instead of the visually-correct
// sibling. Probe the four cardinal directions ±1px and pick whichever returns
// a [data-aos-component] that the exact hit missed. Acceptable for v1
// cursor-precision tax stated in the original v1.6.0 Known Issue.
const PROBE_OFFSETS = [
  [0, 0],
  [0, -1], [0, 1],
  [-1, 0], [1, 0],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

function findTarget(clientX, clientY) {
  for (const [dx, dy] of PROBE_OFFSETS) {
    const hit = document.elementFromPoint(clientX + dx, clientY + dy);
    if (!hit) continue;
    // Don't highlight anything inside our own chat UI (opt-out via data-aos-no-mark).
    if (hit.closest('[data-aos-no-mark]')) {
      if (dx === 0 && dy === 0) return null;
      continue;
    }
    const target = resolveTarget(hit);
    if (target) return target;
  }
  return null;
}

export default function MarkupOverlay({ accent, onPick }) {
  const [hovered, setHovered] = useState(null);
  const [pulseKey, setPulseKey] = useState(0);
  const rafRef = useRef(0);

  const handleMove = useCallback((e) => {
    if (rafRef.current) return;
    const { clientX, clientY } = e;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      // Keep the current selection while the cursor is over our own breadcrumb
      // badge, so the user can slide onto it and click a crumb without the
      // hover (and the badge) vanishing.
      const over = document.elementFromPoint(clientX, clientY);
      if (over && over.closest('[data-aos-mark-badge]')) return;
      const target = findTarget(clientX, clientY);
      setHovered((prev) => (prev === target ? prev : target));
    });
  }, []);

  // Commit a pick at an explicit element — used by both the window click
  // (deepest element) and the breadcrumb crumbs (a chosen shallower level).
  const pick = useCallback((el) => {
    if (!el) return;
    setPulseKey((k) => k + 1);
    onPick?.(el);
  }, [onPick]);

  const handleClick = useCallback((e) => {
    const target = findTarget(e.clientX, e.clientY);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    pick(target);
  }, [pick]);

  useEffect(() => {
    window.addEventListener('mousemove', handleMove, true);
    window.addEventListener('click', handleClick, true);
    return () => {
      window.removeEventListener('mousemove', handleMove, true);
      window.removeEventListener('click', handleClick, true);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [handleMove, handleClick]);

  if (!hovered) return null;
  return (
    <SelectionHighlight
      element={hovered}
      crumbs={buildCrumbs(hovered)}
      onPickLevel={pick}
      accent={accent}
      pulsing={pulseKey > 0}
      pulseKey={pulseKey}
    />
  );
}
