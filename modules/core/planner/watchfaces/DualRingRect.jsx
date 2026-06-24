import { useEffect, useRef, useState } from 'react';

// Rounded-rectangle variant of DualRing. Same dual-arc semantics — outer thin
// arc = session progress (depletes once over the whole session), inner thicker
// arc = current-minute progress (depletes once per minute then snaps back).
// Used by the compact watchface where the dial lives inside a candy-shell
// rectangular button. Drag-to-set duration is horizontal delta-based (6 px per
// minute) rather than angular click-to-set — the entire SVG surface is one
// grip target and "left = less, right = more" maps cleanly to user intent.
export default function DualRingRect({
  remainingMins, phase, running,
  accent = '#c0392b',
  width = 200, height = 80,
  interactive = false, dragMins = null,
  glow = true,
  onDragStart, onDrag, onDragEnd,
  onPressedChange,
}) {
  const svgRef = useRef(null);

  const outerInset = 10.89;
  const outerR = 16.94;
  const outerStrokeW = 2.18;
  const innerInset = 22.99;
  const innerR = 9.68;
  const innerStrokeW = 5.57;

  const totalSec = Math.max(0, Math.round(remainingMins * 60));
  const totalSecRef = useRef(totalSec);
  const subSecRef = useRef(0);
  const lastFrameRef = useRef(performance.now());
  const [, setFrameTick] = useState(0);

  useEffect(() => {
    if (totalSec !== totalSecRef.current) {
      totalSecRef.current = totalSec;
      subSecRef.current = 0;
    }
  }, [totalSec]);

  useEffect(() => {
    if (!running) return;
    let raf;
    const tick = (t) => {
      const dt = (t - lastFrameRef.current) / 1000;
      lastFrameRef.current = t;
      subSecRef.current = Math.min(1, subSecRef.current + dt);
      setFrameTick((c) => c + 1);
      raf = requestAnimationFrame(tick);
    };
    lastFrameRef.current = performance.now();
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const isDragMode = dragMins != null;
  let outerFraction, innerFraction;
  if (isDragMode) {
    outerFraction = Math.min(1, dragMins / 60);
    innerFraction = 1;
  } else {
    const liveRemainingSec = Math.max(0, totalSec - subSecRef.current);
    outerFraction = Math.min(1, liveRemainingSec / 3600);
    const liveMinSec = liveRemainingSec % 60;
    innerFraction = liveMinSec === 0 && liveRemainingSec > 0 ? 1 : liveMinSec / 60;
  }

  const strokeColor = accent;

  // Walk the rounded-rect perimeter clockwise from top-middle, emitting an SVG
  // path for the leading `fraction` of total length. Corners are quarter-arcs;
  // edges are straight lines. Total perimeter = 2(w+h) - 8r + 2πr.
  function roundedRectArcPath(x, y, w, h, r, fraction) {
    if (fraction <= 0.0001) return '';
    const startX = x + w / 2;
    const startY = y;
    if (fraction >= 1) {
      return (
        `M ${startX} ${startY} ` +
        `L ${x + w - r} ${y} ` +
        `A ${r} ${r} 0 0 1 ${x + w} ${y + r} ` +
        `L ${x + w} ${y + h - r} ` +
        `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
        `L ${x + r} ${y + h} ` +
        `A ${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
        `L ${x} ${y + r} ` +
        `A ${r} ${r} 0 0 1 ${x + r} ${y} ` +
        `L ${startX} ${startY}`
      );
    }
    const cornerLen = (Math.PI * r) / 2;
    const halfTopLen = w / 2 - r;
    const sideVLen = h - 2 * r;
    const sideHLen = w - 2 * r;
    const segments = [
      { len: halfTopLen, kind: 'line',
        from: [startX, startY], to: [x + w - r, y] },
      { len: cornerLen, kind: 'arc',
        from: [x + w - r, y], to: [x + w, y + r], center: [x + w - r, y + r] },
      { len: sideVLen, kind: 'line',
        from: [x + w, y + r], to: [x + w, y + h - r] },
      { len: cornerLen, kind: 'arc',
        from: [x + w, y + h - r], to: [x + w - r, y + h], center: [x + w - r, y + h - r] },
      { len: sideHLen, kind: 'line',
        from: [x + w - r, y + h], to: [x + r, y + h] },
      { len: cornerLen, kind: 'arc',
        from: [x + r, y + h], to: [x, y + h - r], center: [x + r, y + h - r] },
      { len: sideVLen, kind: 'line',
        from: [x, y + h - r], to: [x, y + r] },
      { len: cornerLen, kind: 'arc',
        from: [x, y + r], to: [x + r, y], center: [x + r, y + r] },
      { len: halfTopLen, kind: 'line',
        from: [x + r, y], to: [startX, startY] },
    ];
    const perimeter = 2 * (w + h) - 8 * r + 2 * Math.PI * r;
    let remaining = fraction * perimeter;
    let path = `M ${startX} ${startY}`;
    for (const seg of segments) {
      if (remaining <= 0) break;
      if (remaining >= seg.len) {
        if (seg.kind === 'line') {
          path += ` L ${seg.to[0]} ${seg.to[1]}`;
        } else {
          path += ` A ${r} ${r} 0 0 1 ${seg.to[0]} ${seg.to[1]}`;
        }
        remaining -= seg.len;
      } else {
        const t = remaining / seg.len;
        if (seg.kind === 'line') {
          const px = seg.from[0] + t * (seg.to[0] - seg.from[0]);
          const py = seg.from[1] + t * (seg.to[1] - seg.from[1]);
          path += ` L ${px} ${py}`;
        } else {
          const startAng = Math.atan2(seg.from[1] - seg.center[1], seg.from[0] - seg.center[0]);
          const sweep = t * Math.PI / 2;
          const endAng = startAng + sweep;
          const px = seg.center[0] + r * Math.cos(endAng);
          const py = seg.center[1] + r * Math.sin(endAng);
          path += ` A ${r} ${r} 0 0 1 ${px} ${py}`;
        }
        remaining = 0;
      }
    }
    return path;
  }

  const outerX = outerInset, outerY = outerInset;
  const outerW = width - 2 * outerInset, outerH = height - 2 * outerInset;
  const innerX = innerInset, innerY = innerInset;
  const innerW = width - 2 * innerInset, innerH = height - 2 * innerInset;

  const outerBgPath = roundedRectArcPath(outerX, outerY, outerW, outerH, outerR, 1);
  const innerBgPath = roundedRectArcPath(innerX, innerY, innerW, innerH, innerR, 1);
  const outerArcPath = roundedRectArcPath(outerX, outerY, outerW, outerH, outerR, outerFraction);
  const innerArcPath = roundedRectArcPath(innerX, innerY, innerW, innerH, innerR, innerFraction);

  const outerHaloW = outerStrokeW * 2.2;
  const innerHaloW = innerStrokeW * 1.6;

  const dragging = useRef(false);
  const startXRef = useRef(0);
  const startMinsRef = useRef(0);
  const lastSentMinsRef = useRef(null);
  const PX_PER_MIN = 6;

  function onPointerDown(e) {
    if (!interactive) return;
    e.preventDefault();
    dragging.current = true;
    startXRef.current = e.clientX;
    startMinsRef.current = dragMins != null
      ? dragMins
      : Math.max(1, Math.min(60, Math.round(remainingMins)));
    lastSentMinsRef.current = null;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onPressedChange?.(true);
    onDragStart?.(startMinsRef.current);
  }
  function onPointerMove(e) {
    if (!dragging.current) return;
    const deltaPx = e.clientX - startXRef.current;
    const newMins = Math.max(
      1,
      Math.min(60, Math.round(startMinsRef.current + deltaPx / PX_PER_MIN)),
    );
    if (newMins !== lastSentMinsRef.current) {
      lastSentMinsRef.current = newMins;
      onDrag?.(newMins);
    }
  }
  function onPointerUp(e) {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onPressedChange?.(false);
    onDragEnd?.();
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      overflow="visible"
      width={width}
      height={height}
      style={{
        display: 'block',
        touchAction: interactive ? 'none' : 'auto',
        cursor: interactive ? (isDragMode ? 'grabbing' : 'grab') : 'default',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <defs>
        {glow && (
          <filter id="dualRectGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.9"/>
          </filter>
        )}
      </defs>

      {/* Transparent hit-rect — makes the entire SVG surface pointer-receptive
          so drag works anywhere inside the button, not just on the strokes. */}
      <rect x={0} y={0} width={width} height={height} fill="transparent"/>

      {/* Background rings — full perimeter, neutral stroke. */}
      <path d={outerBgPath} fill="none" stroke="var(--clock-stroke-bg)" strokeWidth={outerStrokeW}/>
      <path d={innerBgPath} fill="none" stroke="var(--clock-stroke-bg)" strokeWidth={innerStrokeW}/>

      {/* Outer arc — session progress. Always glows. */}
      {outerArcPath && (
        <>
          {glow && (
            <path d={outerArcPath} stroke={strokeColor}
              strokeWidth={outerHaloW} fill="none" strokeLinecap="round"
              opacity="0.32" filter="url(#dualRectGlow)"/>
          )}
          <path d={outerArcPath} stroke={strokeColor}
            strokeWidth={outerStrokeW} fill="none" strokeLinecap="round"/>
        </>
      )}

      {/* Inner arc — current-minute progress. Always glows. */}
      {innerArcPath && (
        <>
          {glow && (
            <path d={innerArcPath} stroke={strokeColor}
              strokeWidth={innerHaloW} fill="none" strokeLinecap="round"
              opacity="0.30" filter="url(#dualRectGlow)"/>
          )}
          <path d={innerArcPath} stroke={strokeColor}
            strokeWidth={innerStrokeW} fill="none" strokeLinecap="round"/>
        </>
      )}
    </svg>
  );
}
