// Full-bleed brand button at the top of the primary sidebar — it IS the section.
// Doubles as the sidebar collapse/expand toggle; click flips `expanded` via the
// parent's onToggle.
//
// Candy slab: the accent face fills the section's full width + height; its 3D
// depth shadow forms the section's bottom edge (no separate divider). Collapsed
// shows the centered brand-mark; expanded adds the ISKARIEL label + tagline.
// Wires to the two-layer `.candy-btn.is-primary` block (data-variant="brand").

import { useEffect, useMemo, useState } from 'react';

const TAGLINES = [
  'your knowledge layer',
  'memory has a backend',
  'thoughts in alignment',
  'context, kept',
  'one rail to rule them all',
  'where every page is one click away',
  'the OS that thinks with you',
];

export default function SidebarToggleButton({ accent, expanded, onToggle, showTagline }) {
  const [pulsing, setPulsing] = useState(false);
  const tagline = useMemo(() => TAGLINES[Math.floor(Math.random() * TAGLINES.length)], []);
  const version = import.meta.env.PACKAGE_VERSION || '0.0.0';

  useEffect(() => {
    let timer = null;
    function onPulse() {
      setPulsing(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPulsing(false), 600);
    }
    window.addEventListener('agentic:vault-sync-pulse', onPulse);
    return () => {
      window.removeEventListener('agentic:vault-sync-pulse', onPulse);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const tooltip = expanded ? 'Collapse sidebar' : 'Expand sidebar';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={tooltip}
      aria-pressed={!expanded}
      title={tooltip}
      data-own-press
      className="candy-btn is-primary"
      data-shape="block"
      data-variant="brand"
      style={{
        ...(accent ? { '--accent': accent } : {}),
        ...(pulsing ? { animation: 'vault-sync-pulse 600ms cubic-bezier(0.32, 0.72, 0, 1)' } : {}),
      }}
    >
      <span
        className="candy-face"
        style={{ justifyContent: 'center', padding: expanded ? '0 14px' : '0' }}
      >
        {!expanded && <span className="brand-mark" aria-hidden/>}
        {expanded && (
          <span style={{
            flex: 1, minWidth: 0,
            display: 'flex', flexDirection: 'column',
            gap: 1,
            overflow: 'hidden',
            textAlign: 'center',
          }}>
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>Iskariel <span style={{ textTransform: 'none', fontSize: '0.82em', fontWeight: 500 }}>v{version}</span></span>
            {showTagline && (
              <span style={{
                fontSize: 9.5, fontStyle: 'italic',
                fontFamily: 'var(--font-body)',
                opacity: 0.78, fontWeight: 400,
                letterSpacing: '0.01em',
                textTransform: 'none',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                animation: 'fadeIn 0.22s ease',
              }}>{tagline}</span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}
