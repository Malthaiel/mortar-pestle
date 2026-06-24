// Sidebar background-pattern picker (Settings → Appearance → Sidebar pattern).
//
// Five tiles, each painting the REAL motif gradient (the same --pat-* vars the
// rails use) so the choice is visual. The faint rail alpha would be invisible at
// swatch size, so each tile locally boosts --sidebar-line — and because
// var(--sidebar-line) inside --pat-* resolves lazily at the using element, the
// boost re-colours the gradient without touching the rail tokens.
//
// Hovering / focusing a tile live-previews it on the ACTUAL sidebars by writing
// data-sidebar-pattern on :root (the same attr useSettings drives) — mirroring
// the accent setPreviewAccent idiom. The committed value is held in a ref so
// that leaving a tile after a click restores the just-committed motif rather
// than a stale closure value. Click commits via onChange (→ setSetting).

import { useRef } from 'react';

const TILES = [
  { value: 'grid',       label: 'Grid',  bg: 'var(--pat-grid)'  },
  { value: 'hatch',      label: 'Hatch', bg: 'var(--pat-hatch)' },
  { value: 'arcs',       label: 'Arcs',  bg: 'var(--pat-arcs)'  },
  { value: 'crosshatch', label: 'Cross', bg: 'var(--pat-cross)' },
  { value: 'none',       label: 'None',  bg: 'none'             },
];

export default function PatternSwatchPicker({ value, onChange, accent }) {
  const committed = value || 'grid';
  const committedRef = useRef(committed);
  committedRef.current = committed;
  const ring = accent || 'var(--accent)';

  const setLive = (v) => document.documentElement.setAttribute('data-sidebar-pattern', v);
  const restore = () => document.documentElement.setAttribute('data-sidebar-pattern', committedRef.current);
  const commit  = (v) => { committedRef.current = v; setLive(v); onChange(v); };

  return (
    <div role="radiogroup" aria-label="Sidebar background pattern"
         style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {TILES.map((t) => {
        const active = committed === t.value;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={t.label}
            onMouseEnter={() => setLive(t.value)}
            onMouseLeave={restore}
            onFocus={() => setLive(t.value)}
            onBlur={restore}
            onClick={() => commit(t.value)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
              padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
            }}
          >
            <span style={{
              width: 56, height: 42, borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--surface)',
              backgroundImage: t.bg,
              // Boost the line so the motif reads at swatch size (rail alpha is
              // deliberately near-invisible). Lazy var resolution does the rest.
              '--sidebar-line': 'color-mix(in oklch, var(--text-muted) 65%, transparent)',
              boxSizing: 'border-box',
              border: `1.5px solid ${active ? ring : 'var(--border-2)'}`,
              boxShadow: active ? `0 0 0 2px color-mix(in oklch, ${ring} 28%, transparent)` : 'none',
              display: 'grid', placeItems: 'center',
              transition: 'border-color 120ms ease, box-shadow 120ms ease',
            }}>
              {t.value === 'none' && (
                <span style={{ fontSize: 16, lineHeight: 1, color: 'var(--text-faint)' }}>∅</span>
              )}
            </span>
            <span style={{
              fontSize: 11, fontWeight: active ? 600 : 400,
              color: active ? 'var(--text)' : 'var(--text-muted)',
            }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
