// RailSplitter — a thin drag-to-resize vertical divider for a flex [rail | content] layout.
// The caller owns the width state + persistence and passes min/max; this only translates a
// horizontal pointer drag into onWidth(clampedWidth). New primitive (approved, Match View
// Rework Phase 0), staged in Prototypes.md: the settings-drawer sidebar isn't file-tree style
// and treeKit has no resize affordance, so there was nothing existing to reuse or extend.

import { useRef } from 'react';

export default function RailSplitter({ width, min = 150, max = 360, onWidth }) {
  const drag = useRef(null);
  const onDown = (e) => {
    e.preventDefault();
    drag.current = { startX: e.clientX, startW: width };
    const move = (ev) => {
      const d = ev.clientX - drag.current.startX;
      onWidth(Math.max(min, Math.min(max, drag.current.startW + d)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div onPointerDown={onDown} title="Drag to resize" aria-hidden
      style={{ flexShrink: 0, width: 6, cursor: 'col-resize', alignSelf: 'stretch', position: 'relative' }}>
      <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, transform: 'translateX(-0.5px)', background: 'var(--border)' }} />
    </div>
  );
}
