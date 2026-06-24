// SF9 of Design Mode — the Things-3-style floating token bubble. Five rows:
// border-radius, padding, margin, color, font-size. Sliders push live
// overrides via useLiveOverrides; the bubble has its own drag handle so
// the user can relocate it. Once initially placed (next to the selected
// element), the bubble stays put when the page scrolls — it's anchored to
// the viewport, not the element rect.

import { useMemo, useRef, useState } from 'react';
import { resolveToken } from './token-resolver.js';

const BUBBLE_WIDTH = 240;
const APPROX_HEIGHT = 320;

const ROW_SPECS = [
  { id: 'radius',   label: 'Radius',   property: 'border-radius', min: 0, max: 32, unit: 'px' },
  { id: 'padding',  label: 'Padding',  property: 'padding',       min: 0, max: 48, unit: 'px' },
  { id: 'margin',   label: 'Margin',   property: 'margin',        min: 0, max: 48, unit: 'px' },
  { id: 'fontSize', label: 'Size',     property: 'font-size',     min: 8, max: 32, unit: 'px' },
];

function initialPosition(elementRect) {
  const margin = 12;
  let x = elementRect.right + margin;
  let y = elementRect.top;
  if (x + BUBBLE_WIDTH + 8 > window.innerWidth) {
    x = Math.max(8, elementRect.left - BUBBLE_WIDTH - margin);
  }
  if (y + APPROX_HEIGHT + 8 > window.innerHeight) {
    y = Math.max(8, window.innerHeight - APPROX_HEIGHT - 8);
  }
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  return { x, y };
}

function parsePx(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export default function TokenBubble({
  element, reveal, selClass, accent,
  pending, setOverride, clearOverride, clearSelClass,
  onClose, onCommit,
}) {
  const elementRect = useMemo(() => element.getBoundingClientRect(), [element]);
  const [pos, setPos] = useState(() => initialPosition(elementRect));
  const [dragging, setDragging] = useState(false);
  const dragOffsetRef = useRef({ dx: 0, dy: 0 });

  const tokens = useMemo(() => ({
    radius:   resolveToken(element, 'border-radius'),
    padding:  resolveToken(element, 'padding'),
    margin:   resolveToken(element, 'margin'),
    color:    resolveToken(element, 'color'),
    fontSize: resolveToken(element, 'font-size'),
  }), [element]);

  const initialVals = useMemo(() => {
    const cs = getComputedStyle(element);
    return {
      radius:   parsePx(cs.borderTopLeftRadius),
      padding:  parsePx(cs.paddingTop),
      margin:   parsePx(cs.marginTop),
      color:    cs.color,
      fontSize: parsePx(cs.fontSize),
    };
  }, [element]);

  const [vals, setVals] = useState(initialVals);

  const overrideRowsForSel = pending.filter((p) => p.selClass === selClass);

  const handleSlider = (rowId, value) => {
    setVals((v) => ({ ...v, [rowId]: value }));
    const t = tokens[rowId];
    let override;
    if (rowId === 'radius' && t.varName) {
      override = { selClass, target: 'var', name: t.varName, value: `${value}px`, property: 'border-radius', component: reveal.name, source: reveal.source };
    } else if (rowId === 'radius') {
      override = { selClass, target: 'prop', name: 'border-radius', value: `${value}px`, property: 'border-radius', component: reveal.name, source: reveal.source };
    } else if (rowId === 'padding') {
      override = { selClass, target: 'prop', name: 'padding', value: `${value}px`, property: 'padding', component: reveal.name, source: reveal.source };
    } else if (rowId === 'margin') {
      override = { selClass, target: 'prop', name: 'margin', value: `${value}px`, property: 'margin', component: reveal.name, source: reveal.source };
    } else if (rowId === 'fontSize') {
      override = { selClass, target: 'prop', name: 'font-size', value: `${value}px`, property: 'font-size', component: reveal.name, source: reveal.source };
    }
    if (override) setOverride(override);
  };

  const handleColor = (value) => {
    setVals((v) => ({ ...v, color: value }));
    setOverride({
      selClass, target: 'prop', name: 'color', value, property: 'color',
      component: reveal.name, source: reveal.source,
    });
  };

  const overrideForName = (name) => overrideRowsForSel.find((o) => o.name === name);

  const handleCommitRow = async (override) => {
    if (override.target !== 'var') return;
    try {
      await onCommit(override);
    } catch (e) {
      console.error('Commit failed:', e);
    }
  };

  const handleDiscardRow = (rowId) => {
    const t = tokens[rowId];
    if (rowId === 'radius' && t.varName) clearOverride(selClass, t.varName);
    else if (rowId === 'radius')         clearOverride(selClass, 'border-radius');
    else if (rowId === 'padding')        clearOverride(selClass, 'padding');
    else if (rowId === 'margin')         clearOverride(selClass, 'margin');
    else if (rowId === 'fontSize')       clearOverride(selClass, 'font-size');
    else if (rowId === 'color')          clearOverride(selClass, 'color');
    setVals((v) => ({ ...v, [rowId]: initialVals[rowId] }));
  };

  const onDragMouseDown = (e) => {
    if (e.target.closest('button, input, [data-aos-bubble-no-drag]')) return;
    e.preventDefault();
    dragOffsetRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    setDragging(true);
    const onMove = (mv) => {
      const x = Math.max(8, Math.min(window.innerWidth - BUBBLE_WIDTH - 8, mv.clientX - dragOffsetRef.current.dx));
      const y = Math.max(8, Math.min(window.innerHeight - 60 - 8, mv.clientY - dragOffsetRef.current.dy));
      setPos({ x, y });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      data-aos-no-mark
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: BUBBLE_WIDTH,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: '0 12px 36px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.12)',
        zIndex: 'calc(var(--z-design) + 1)',
        fontFamily: 'var(--font-body)',
        animation: 'atelierChatIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      <div
        onMouseDown={onDragMouseDown}
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border-soft)',
          background: 'var(--surface)',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8,
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: accent || 'var(--text)', lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
            {reveal.name}
          </span>
          <span style={{
            fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 3,
          }}>tokens</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close (overrides stay pending)"
          style={{
            width: 20, height: 20, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none',
            color: 'var(--text-muted)', cursor: 'pointer', borderRadius: 4,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="6" y1="18" x2="18" y2="6"/>
          </svg>
        </button>
      </div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ROW_SPECS.map((spec) => {
          const tok = tokens[spec.id];
          const value = vals[spec.id];
          const matchedName = (spec.id === 'radius' && tok.varName) ? tok.varName
            : spec.id === 'radius' ? 'border-radius'
            : spec.property;
          const ov = overrideForName(matchedName);
          return (
            <SliderRow
              key={spec.id}
              spec={spec}
              token={tok}
              value={value}
              accent={accent}
              onChange={(v) => handleSlider(spec.id, v)}
              override={ov}
              onCommit={() => ov && handleCommitRow(ov)}
              onDiscard={() => handleDiscardRow(spec.id)}
            />
          );
        })}
        <ColorRow
          token={tokens.color}
          value={vals.color}
          accent={accent}
          onChange={handleColor}
          override={overrideForName('color')}
          onDiscard={() => handleDiscardRow('color')}
        />
      </div>
    </div>
  );
}

function SliderRow({ spec, token, value, accent, onChange, override, onCommit, onDiscard }) {
  const matchedChip = (spec.id === 'radius' && token.varName)
    ? token.varName.replace('--radius-', 'radius-')
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{spec.label}</span>
          {matchedChip && (
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 4px',
              background: `color-mix(in oklch, ${accent || 'var(--text)'} 12%, transparent)`,
              color: accent || 'var(--text)', borderRadius: 3, letterSpacing: '0.04em',
            }}>{matchedChip}</span>
          )}
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>
          {value}{spec.unit}
        </span>
      </div>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          width: '100%',
          accentColor: accent || 'var(--text)',
          height: 18,
          cursor: 'pointer',
        }}
      />
      {override && (
        <div style={{ display: 'flex', gap: 4 }}>
          {override.target === 'var' ? (
            <button
              type="button"
              onClick={onCommit}
              title={`Patch :root ${override.name} in web/src/styles.css`}
              style={{
                flex: 1, padding: '3px 6px',
                background: accent || 'var(--text)', color: '#fff',
                border: 'none', borderRadius: 4,
                fontSize: 10, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >Commit</button>
          ) : (
            <span
              title="No token target — raw value can't be committed to source in v1 (lives in pending only)"
              style={{
                flex: 1, padding: '3px 6px',
                background: 'var(--surface-2)', color: 'var(--text-faint)',
                border: '1px dashed var(--border-soft)', borderRadius: 4,
                fontSize: 9.5, fontWeight: 600, textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                opacity: 0.7,
              }}
            >no token</span>
          )}
          <button
            type="button"
            onClick={onDiscard}
            title="Discard live override + revert"
            style={{
              padding: '3px 8px',
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border-soft)', borderRadius: 4,
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}
          >Drop</button>
        </div>
      )}
    </div>
  );
}

function ColorRow({ token, value, accent, onChange, override, onDiscard }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>Color</span>
          {token.varName && (
            <span title={token.varName} style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 4px',
              background: `color-mix(in oklch, ${accent || 'var(--text)'} 12%, transparent)`,
              color: accent || 'var(--text)', borderRadius: 3,
            }}>{token.varName.replace('--', '')}</span>
          )}
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
          {value.length > 18 ? value.slice(0, 18) + '…' : value}
        </span>
      </div>
      <input
        type="color"
        value={toHex(value)}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', height: 28, padding: 0, border: '1px solid var(--border-soft)', borderRadius: 4, cursor: 'pointer', background: 'transparent' }}
      />
      {override && (
        <div style={{ display: 'flex', gap: 4 }}>
          <span
            title="Color commit-to-source is deferred to a later release (theme-scoped patching)"
            style={{
              flex: 1, padding: '3px 6px',
              background: 'var(--surface-2)', color: 'var(--text-faint)',
              border: '1px dashed var(--border-soft)', borderRadius: 4,
              fontSize: 9.5, fontWeight: 600, textAlign: 'center',
              fontFamily: 'var(--font-mono)',
              opacity: 0.7,
            }}
          >no commit (v1)</span>
          <button
            type="button"
            onClick={onDiscard}
            title="Discard color override + revert"
            style={{
              padding: '3px 8px',
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border-soft)', borderRadius: 4,
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}
          >Drop</button>
        </div>
      )}
    </div>
  );
}

function toHex(rgbStr) {
  // Accept hex pass-through or convert rgb(r, g, b) → #rrggbb. Falls back to #888888.
  if (!rgbStr) return '#888888';
  if (rgbStr.startsWith('#')) return rgbStr.length === 7 ? rgbStr : '#888888';
  const m = rgbStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return '#888888';
  const hex = (n) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}
