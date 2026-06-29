// Timeline clip block (SF6/SF7) — functional chrome from existing tokens only
// (creative checkpoint waived 2026-06-10: core functionality first). Geometry
// comes from frame math (left/width = start/dur × ppf); motion comes from
// useClipDrag's transform. The PARENT must key this component by geometry —
// `${id}:${track}:${start}:${dur}` — because the drag hook holds moving=true
// + the drag transform after release and resets only on remount
// (CalendarPanel.jsx:90-94 gotcha; same trap as planner frame segments).
//
// SF7: [data-resize] trim handles own their pointer loop (excluded from the
// move drag by useClipDrag's closest() guard) with live frame-snapped +
// clamped preview via resolveTrim; blade mode disables the move drag, shows a
// crosshair, and routes clicks to onBladeClick with the frame under the
// cursor; selection uses the bin card's accent border + ring recipe.

import { memo, useRef, useState } from 'react';
import useClipDrag from './useClipDrag.js';

const mono = { fontFamily: 'var(--font-mono), monospace' };

export default memo(function TimelineClip({
  clip, name, ppf, laneIdx, laneH,
  accent, selected, bladeMode,
  resolveTarget, onCommitMove,
  onSelect, onBladeClick, onMenu,
  resolveTrim, onTrimCommit,
}) {
  const elRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [trim, setTrim] = useState(null); // { edge, value } — live preview while resizing
  const { moving, releasing, dragTransform, dragTransition, onPointerDown, liveStart } = useClipDrag({
    elRef,
    startFrame: clip.start,
    durFrames: clip.dur,
    ppf,
    laneIdx,
    selfId: clip.id,
    resolveTarget,
    onCommit: (toLane, start) => onCommitMove(clip.id, laneIdx, toLane, start),
  });

  const start = trim?.edge === 'in' ? trim.value : clip.start;
  const end = trim?.edge === 'out' ? trim.value : clip.start + clip.dur;

  const startResize = (edge) => (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const base = edge === 'in' ? clip.start : clip.start + clip.dur;
    let lastVal = base;
    const mv = (ev) => {
      const desired = base + (ev.clientX - startX) / ppf;
      lastVal = resolveTrim(laneIdx, clip.id, edge, desired);
      setTrim({ edge, value: lastVal });
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      setTrim(null);
      if (lastVal !== base) onTrimCommit(laneIdx, clip.id, edge, lastVal);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const frameAt = (clientX) => {
    const sc = elRef.current?.closest('[data-tl-scroll]');
    if (!sc) return clip.start;
    return Math.round((clientX - sc.getBoundingClientRect().left + sc.scrollLeft) / ppf);
  };

  const onClick = (e) => {
    if (bladeMode) {
      onBladeClick(laneIdx, clip.id, frameAt(e.clientX));
    } else {
      onSelect(laneIdx, clip.id, e.shiftKey);
    }
  };

  const edgeColor = accent || 'var(--accent)';
  const handle = (edge) => (
    <div
      data-resize={edge}
      onPointerDown={startResize(edge)}
      style={{ position: 'absolute', [edge === 'in' ? 'left' : 'right']: 0, top: 0, bottom: 0, width: 7, cursor: 'ew-resize', zIndex: 2 }}
    >
      {(hovered || selected || trim?.edge === edge) && (
        <div style={{ position: 'absolute', [edge === 'in' ? 'left' : 'right']: 2, top: '25%', bottom: '25%', width: 3, borderRadius: 2, background: edgeColor, opacity: 0.9 }} />
      )}
    </div>
  );

  return (
    <div
      ref={elRef}
      onPointerDown={bladeMode ? undefined : onPointerDown}
      onClick={onClick}
      onContextMenu={(e) => onMenu?.(laneIdx, clip.id, frameAt(e.clientX), e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        left: start * ppf,
        top: 4,
        height: laneH - 8,
        width: Math.max(2, (end - start) * ppf),
        boxSizing: 'border-box',
        borderRadius: 7,
        background: 'var(--surface)',
        border: `1px solid ${selected ? edgeColor : 'var(--border)'}`,
        boxShadow: moving
          ? '0 6px 18px rgba(0,0,0,0.35)'
          : selected ? `0 0 0 1px ${edgeColor}` : 'none',
        transform: dragTransform,
        transition: dragTransition,
        zIndex: moving || releasing ? 6 : 2,
        cursor: bladeMode ? 'crosshair' : 'grab',
        overflow: 'hidden',
        userSelect: 'none',
        pointerEvents: moving && !releasing ? 'none' : 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 8px',
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </span>
      {clip.grade && (
        <span title="Graded" style={{ width: 7, height: 7, borderRadius: '50%', background: edgeColor, flexShrink: 0 }} />
      )}
      {clip.mute && (
        <span style={{ ...mono, fontSize: 9, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 3, padding: '0 3px', flexShrink: 0 }}>
          M
        </span>
      )}
      {moving && liveStart != null && (
        <span style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto', flexShrink: 0 }}>
          {liveStart}f
        </span>
      )}
      {trim && (
        <span style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto', flexShrink: 0 }}>
          {trim.value}f
        </span>
      )}
      {!bladeMode && handle('in')}
      {!bladeMode && handle('out')}
    </div>
  );
});
