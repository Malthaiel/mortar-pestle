// ColorWheel — one Lift/Gamma/Gain wheel (Color Grading SF7): hue disc with a
// draggable puck (the zero-sum RGB component) + vertical master slider (the
// shared component) + DM Mono triple readout. Pointer-capture drag only
// (never HTML5 DnD — WebKitGTK); Shift mid-gesture = 0.1× fine (incremental,
// so toggling Shift never jumps); double-click resets this wheel via onReset.
//
// Math: a triple decomposes EXACTLY into master (mean) + a zero-sum puck
// component: dr = x·S, dg = (−x/2 + (√3/2)·y)·S, db = (−x/2 − (√3/2)·y)·S,
// with inverse x = dr/S, y = (dg − db)/(√3·S). S (puckScale) maps full puck
// deflection to the wheel's useful range; channels clamp to [min, max].
//
// The component is CONTROLLED: drags emit composed triples through onDraft,
// the parent feeds the updated value back, and onGestureEnd tells the parent
// to commit its draft as ONE undo op.

import { useRef } from 'react';

const mono = { fontFamily: '"DM Mono", monospace' };
const SQ3 = Math.sqrt(3);
const SIZE = 84;
const R = SIZE / 2;
const PUCK_TRAVEL = R - 7;

// Hue ring oriented so dragging toward a hue adds that hue: +x (right) = red,
// 120° counterclockwise = green, 240° = blue.
const DISC_BG = [
  'radial-gradient(circle closest-side, var(--surface) 0%, rgba(0,0,0,0) 72%)',
  'conic-gradient(from 90deg, red, magenta, blue, cyan, lime, yellow, red)',
].join(', ');

function decompose(value, S) {
  const master = (value[0] + value[1] + value[2]) / 3;
  let x = (value[0] - master) / S;
  let y = (value[1] - value[2]) / (SQ3 * S);
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  return { master, x, y };
}

function compose(master, x, y, S, lo, hi) {
  const c = (v) => Math.min(hi, Math.max(lo, v));
  return [
    c(master + x * S),
    c(master + (-x / 2 + (SQ3 / 2) * y) * S),
    c(master + (-x / 2 - (SQ3 / 2) * y) * S),
  ];
}

export default function ColorWheel({
  label, value, accent,
  puckScale = 0.5, min = -1, max = 1, step = 0.005,
  onDraft, onGestureEnd, onReset,
}) {
  const drag = useRef(null);
  const { master, x, y } = decompose(value, puckScale);
  const cur = useRef(null);
  cur.current = { master, x, y };

  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { lx: e.clientX, ly: e.clientY, x: cur.current.x, y: cur.current.y };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const fine = e.shiftKey ? 0.1 : 1;
    d.x += ((e.clientX - d.lx) / PUCK_TRAVEL) * fine;
    d.y -= ((e.clientY - d.ly) / PUCK_TRAVEL) * fine;
    d.lx = e.clientX;
    d.ly = e.clientY;
    let { x: nx, y: ny } = d;
    const m = Math.hypot(nx, ny);
    if (m > 1) { nx /= m; ny /= m; }
    onDraft(compose(cur.current.master, nx, ny, puckScale, min, max));
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    onGestureEnd();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', userSelect: 'none' }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={onReset}
          style={{
            position: 'relative',
            width: SIZE,
            height: SIZE,
            borderRadius: '50%',
            background: DISC_BG,
            border: '1px solid var(--border)',
            cursor: 'crosshair',
            touchAction: 'none',
            flexShrink: 0,
          }}
        >
          <div style={{
            position: 'absolute',
            left: R + x * PUCK_TRAVEL - 5,
            top: R - y * PUCK_TRAVEL - 5,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: 'var(--text)',
            border: '2px solid var(--bg)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
            pointerEvents: 'none',
          }} />
        </div>
        <input
          type="range"
          orient="vertical"
          min={min}
          max={max}
          step={step}
          value={master}
          onChange={(e) => {
            const m = Number(e.target.value);
            const { x: cx, y: cy } = cur.current;
            onDraft(compose(m, cx, cy, puckScale, min, max));
          }}
          onPointerUp={onGestureEnd}
          onKeyUp={onGestureEnd}
          style={{
            WebkitAppearance: 'slider-vertical',
            width: 18,
            height: SIZE,
            accentColor: accent,
            cursor: 'ns-resize',
          }}
        />
      </div>
      <span style={{ ...mono, fontSize: 9.5, color: 'var(--text-muted)', userSelect: 'none' }}>
        {value[0].toFixed(3)} {value[1].toFixed(3)} {value[2].toFixed(3)}
      </span>
    </div>
  );
}
