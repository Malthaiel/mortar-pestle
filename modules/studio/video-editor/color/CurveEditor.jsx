// CurveEditor — the ONE curve surface for RGB tone curves and hue-vs-sat
// (Color Grading SF8). The drawn path is sampled from gradeLut.evalCurve, so
// the editor and the LUT compiler can never disagree about a curve's shape.
//
// Interactions (pointer-capture, never HTML5 DnD):
// - pointerdown on empty plot     → add a point and drag it (one gesture)
// - pointerdown on a point        → drag it; non-wrap x is clamped between
//                                   its neighbors (monotone-x), wrap x wraps
//                                   mod 1 so a point drags across the seam
// - Shift while dragging          → 0.1× fine (incremental)
// - double-click on a point       → remove it (one undo op)
// - ⟲ reset lives in the parent  (plan said double-click background; that
//   fires pointerdown first and would add a stray point — deliberate swap)
//
// Structure: the stretched SVG draws grid + curve only; point handles are
// HTML divs in a sibling overlay (a preserveAspectRatio="none" SVG would
// squash circles into ellipses). Pointer capture goes to the WRAPPER so
// move/up keep firing wherever the pointer roams. Clicking a point without
// moving it emits nothing — no junk undo entries.

import { useRef, useState } from 'react';
import { evalCurve } from './gradeLut.js';

const EPS = 0.01; // min x gap between neighboring points (non-wrap)

export default function CurveEditor({
  points, wrap = false, identity = 'diag', yMax = 1,
  accent, stroke, background,
  onDraft, onGestureEnd,
}) {
  const wrapRef = useRef(null);
  const drag = useRef(null);
  const [hovered, setHovered] = useState(-1);

  const pts = points || [];
  const curveColor = stroke || accent || 'var(--accent)';

  const clampY = (y) => Math.min(yMax, Math.max(0, y));

  const beginDrag = (e, basePts, x, y, emitNow) => {
    // Neighbor bounds for monotone-x, fixed once per gesture from the
    // remaining points around the dragged point's starting x.
    let lo = 0;
    let hi = 1;
    if (!wrap) {
      for (const [px] of basePts) {
        if (px < x && px + EPS > lo) lo = px + EPS;
        if (px > x && px - EPS < hi) hi = px - EPS;
      }
    }
    drag.current = { basePts, x, y, lo, hi, lx: e.clientX, ly: e.clientY };
    wrapRef.current.setPointerCapture(e.pointerId);
    if (emitNow) emit();
  };

  const emit = () => {
    const d = drag.current;
    const merged = [...d.basePts, [d.x, d.y]].sort((a, b) => a[0] - b[0]);
    onDraft(merged);
  };

  const onBgPointerDown = (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    const r = wrapRef.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = clampY((1 - (e.clientY - r.top) / r.height) * yMax);
    beginDrag(e, pts, x, y, true); // adding commits even without a move
  };

  const onPointPointerDown = (idx) => (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    e.stopPropagation();
    const base = pts.filter((_, i) => i !== idx);
    beginDrag(e, base, pts[idx][0], pts[idx][1], false);
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const r = wrapRef.current.getBoundingClientRect();
    const fine = e.shiftKey ? 0.1 : 1;
    d.x += ((e.clientX - d.lx) / r.width) * fine;
    d.y -= ((e.clientY - d.ly) / r.height) * yMax * fine;
    d.lx = e.clientX;
    d.ly = e.clientY;
    if (wrap) {
      d.x = ((d.x % 1) + 1) % 1;
    } else {
      d.x = Math.min(d.hi, Math.max(d.lo, d.x));
    }
    d.y = clampY(d.y);
    emit();
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    onGestureEnd(); // no-ops upstream when nothing was emitted
  };

  const removePoint = (idx) => (e) => {
    e.stopPropagation();
    if (!wrap && pts.length <= 2) return; // tone curves keep their endpoints
    const rest = pts.filter((_, i) => i !== idx);
    onDraft(rest.length ? rest : null);
    onGestureEnd();
  };

  // Path sampled from the compiler's own math.
  const N = 128;
  const tab = evalCurve(pts, N, { wrap, identity });
  const path = [];
  for (let i = 0; i < N; i++) {
    const x = wrap ? i / N : i / (N - 1);
    path.push(`${(x * 100).toFixed(2)},${((1 - tab[i] / yMax) * 100).toFixed(2)}`);
  }
  if (wrap) path.push(`100,${((1 - tab[0] / yMax) * 100).toFixed(2)}`); // close the period

  const identityRefY = identity === 'one' ? (1 - 1 / yMax) * 100 : null;

  return (
    <div
      ref={wrapRef}
      onPointerDown={onBgPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: background || 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 7,
        cursor: 'crosshair',
        touchAction: 'none',
        overflow: 'hidden',
      }}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}>
        {[25, 50, 75].map((g) => (
          <g key={g} stroke="var(--border)" strokeWidth="0.4" opacity="0.6">
            <line x1={g} y1="0" x2={g} y2="100" />
            <line x1="0" y1={g} x2="100" y2={g} />
          </g>
        ))}
        {identity === 'diag' ? (
          <line x1="0" y1="100" x2="100" y2="0" stroke="var(--border)" strokeWidth="0.6" />
        ) : (
          <line x1="0" y1={identityRefY} x2="100" y2={identityRefY} stroke="var(--border)" strokeWidth="0.6" />
        )}
        <polyline
          points={path.join(' ')}
          fill="none"
          stroke={curveColor}
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {pts.map(([x, y], i) => (
        <div
          key={i}
          onPointerDown={onPointPointerDown(i)}
          onDoubleClick={removePoint(i)}
          onMouseEnter={() => setHovered(i)}
          onMouseLeave={() => setHovered(-1)}
          style={{
            position: 'absolute',
            left: `${x * 100}%`,
            top: `${(1 - y / yMax) * 100}%`,
            width: hovered === i ? 11 : 9,
            height: hovered === i ? 11 : 9,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            background: curveColor,
            border: '2px solid var(--bg)',
            cursor: 'grab',
            boxSizing: 'border-box',
          }}
        />
      ))}
    </div>
  );
}
