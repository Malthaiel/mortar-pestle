// SF8 of Design Mode — portaled outline + name badge for the hovered or
// selected component. Position is computed from the element's
// getBoundingClientRect; we re-measure on every render (cheap), and the
// parent re-renders on every mousemove during hover.
//
// `pulsing` adds a brief markupPulse animation that re-fires whenever the
// `pulseKey` prop changes — used right after a click to confirm the pick.

import { Fragment, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function SelectionHighlight({ element, crumbs = [], accent, onPickLevel, pulsing = false, pulseKey = 0 }) {
  const [rect, setRect] = useState(() => element?.getBoundingClientRect?.() ?? null);

  useEffect(() => {
    if (!element) { setRect(null); return; }
    setRect(element.getBoundingClientRect());
  }, [element, pulseKey]);

  if (!rect || !element) return null;

  const trail = crumbs.length
    ? crumbs
    : [{ el: element, label: element.dataset?.aosComponent || 'Unknown' }];

  return createPortal(
    <>
      <div
        data-aos-no-mark
        key={`outline-${pulseKey}`}
        style={{
          position: 'fixed',
          left: rect.left - 2,
          top: rect.top - 2,
          width: rect.width + 4,
          height: rect.height + 4,
          border: `2px solid ${accent || 'var(--accent)'}`,
          borderRadius: 4,
          background: `color-mix(in oklch, ${accent || 'var(--accent)'} 6%, transparent)`,
          pointerEvents: 'none',
          zIndex: 'var(--z-design)',
          boxShadow: `0 0 0 4px color-mix(in oklch, ${accent || 'var(--accent)'} 16%, transparent)`,
        }}
      />
      <div
        data-aos-no-mark
        data-aos-mark-badge
        style={{
          position: 'fixed',
          left: rect.left - 2,
          top: Math.max(rect.top - 22, 2),
          // Transparent bottom bridge overlaps the element's top edge so the
          // cursor can travel from the element onto the badge with no dead gap
          // (the parent overlay keeps the selection alive while over the badge).
          paddingBottom: 6,
          zIndex: 'calc(var(--z-design) + 1)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            padding: '2px 6px',
            background: accent || 'var(--accent)',
            color: '#fff',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            borderRadius: 3,
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
          }}
        >
          {trail.map((c, i) => {
            const last = i === trail.length - 1;
            return (
              <Fragment key={i}>
                {i > 0 && <span style={{ opacity: 0.5 }}>›</span>}
                <span
                  title={`Mark ${c.label}`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPickLevel?.(c.el); }}
                  style={{
                    cursor: 'pointer',
                    opacity: last ? 1 : 0.8,
                    fontWeight: last ? 700 : 600,
                    padding: '0 1px',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.textDecoration = 'underline'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = last ? '1' : '0.8'; e.currentTarget.style.textDecoration = 'none'; }}
                >
                  {c.label}
                </span>
              </Fragment>
            );
          })}
        </div>
      </div>
    </>,
    document.body
  );
}
