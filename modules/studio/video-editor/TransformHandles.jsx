import { useEffect, useRef, useState } from 'react';
import { computeLayerQuad } from './color/glDisplay.js';
import { setXformDraft, clearXformDraft } from './transformDraft.js';

// On-preview transform handles (Compositing & Titles SF6). Pointer-only (no
// HTML5 DnD — project_iskariel_no_html5_dnd): drag the box to MOVE, the corners
// to SCALE (uniform, from center), the top stem to ROTATE. The live gesture
// writes the shared xformDraft so the GL loop previews it per tick; pointerup
// commits ONE setClipTransform op (one undo entry) and clears the draft. The box
// geometry comes from computeLayerQuad, so it tracks the composited picture
// exactly. Crop is inspector-only this pass (crop drag-handles deferred).

const IDENT = { x: 0, y: 0, scale: 1, rot: 0, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 } };

export default function TransformHandles({ clipId, trackId, transform, srcW, srcH, seqW, seqH, accent, onCommit, isTitle }) {
  const wrapRef = useRef(null);
  const drag = useRef(null);
  const [live, setLive] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => { const r = el.getBoundingClientRect(); setSize({ w: r.width, h: r.height }); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const t = live || transform || IDENT;
  const rectW = size.w;
  const rectH = size.h;

  const begin = (mode, e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = wrapRef.current.getBoundingClientRect();
    const lx = e.clientX - r.left;
    const ly = e.clientY - r.top;
    // Box center in css px (from the current transform quad).
    const q = computeLayerQuad({ srcW, srcH, seqW, seqH, cw: rectW, ch: rectH, transform: t, isTitle });
    const centerX = (((q[0] + 1) / 2) * rectW + ((q[12] + 1) / 2) * rectW) / 2;
    const centerY = (((1 - q[1]) / 2) * rectH + ((1 - q[13]) / 2) * rectH) / 2;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* SVG capture unsupported */ }
    drag.current = {
      mode, pid: e.pointerId, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top,
      t0: { x: t.x ?? 0, y: t.y ?? 0, scale: t.scale ?? 1, rot: t.rot ?? 0, opacity: t.opacity ?? 1, crop: { ...(t.crop || IDENT.crop) } },
      cx: centerX, cy: centerY,
      initDist: Math.hypot(lx - centerX, ly - centerY) || 1,
      initAng: Math.atan2(ly - centerY, lx - centerX),
      last: null,
    };
  };

  const move = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pid) return;
    const seqFit = Math.min(rectW / seqW, rectH / seqH);
    const seqRectW = seqW * seqFit;
    const seqRectH = seqH * seqFit;
    const t0 = d.t0;
    let nt;
    if (d.mode === 'move') {
      nt = { ...t0, x: t0.x + (e.clientX - d.sx) / seqRectW, y: t0.y - (e.clientY - d.sy) / seqRectH };
    } else if (d.mode === 'scale') {
      const dist = Math.hypot((e.clientX - d.left) - d.cx, (e.clientY - d.top) - d.cy);
      nt = { ...t0, scale: Math.max(0.05, t0.scale * (dist / d.initDist)) };
    } else {
      const ang = Math.atan2((e.clientY - d.top) - d.cy, (e.clientX - d.left) - d.cx);
      nt = { ...t0, rot: t0.rot + ((ang - d.initAng) * 180) / Math.PI };
    }
    d.last = nt;
    setLive(nt);
    setXformDraft(clipId, nt);
  };

  const end = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pid) return;
    const final = d.last;
    drag.current = null;
    setLive(null);
    clearXformDraft();
    if (final) onCommit(trackId, clipId, final);
  };

  // Empty pass-through wrapper until the element is measured + the frame decoded.
  if (!srcW || !srcH || !rectW || !rectH) {
    return <div ref={wrapRef} style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none' }} />;
  }

  const verts = computeLayerQuad({ srcW, srcH, seqW, seqH, cw: rectW, ch: rectH, transform: t, isTitle });
  const P = (i) => ({ x: ((verts[i * 4] + 1) / 2) * rectW, y: ((1 - verts[i * 4 + 1]) / 2) * rectH });
  const TL = P(0), TR = P(1), BL = P(2), BR = P(3);
  const center = { x: (TL.x + BR.x) / 2, y: (TL.y + BR.y) / 2 };
  const topMid = { x: (TL.x + TR.x) / 2, y: (TL.y + TR.y) / 2 };
  const ux = topMid.x - center.x, uy = topMid.y - center.y;
  const ul = Math.hypot(ux, uy) || 1;
  const rotPt = { x: topMid.x + (ux / ul) * 30, y: topMid.y + (uy / ul) * 30 };
  const corners = [TL, TR, BL, BR];
  const col = accent || '#6cf';

  return (
    <div
      ref={wrapRef}
      style={{ position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none' }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <svg width={rectW} height={rectH} style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
        <line x1={topMid.x} y1={topMid.y} x2={rotPt.x} y2={rotPt.y} stroke={col} strokeWidth="1.5" />
        <polygon
          points={`${TL.x},${TL.y} ${TR.x},${TR.y} ${BR.x},${BR.y} ${BL.x},${BL.y}`}
          fill="rgba(0,0,0,0.001)"
          stroke={col}
          strokeWidth="1.5"
          style={{ pointerEvents: 'auto', cursor: 'move' }}
          onPointerDown={(e) => begin('move', e)}
        />
        {corners.map((p, i) => (
          <rect
            key={i}
            x={p.x - 6}
            y={p.y - 6}
            width="12"
            height="12"
            fill={col}
            stroke="#fff"
            strokeWidth="1"
            style={{ pointerEvents: 'auto', cursor: 'nwse-resize' }}
            onPointerDown={(e) => begin('scale', e)}
          />
        ))}
        <circle
          cx={rotPt.x}
          cy={rotPt.y}
          r="6"
          fill="#fff"
          stroke={col}
          strokeWidth="1.5"
          style={{ pointerEvents: 'auto', cursor: 'grab' }}
          onPointerDown={(e) => begin('rotate', e)}
        />
      </svg>
    </div>
  );
}
