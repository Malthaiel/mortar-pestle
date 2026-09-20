// The personal-rating control: ten candy dots (1-10) with a hover preview and a
// `n/10` readout. Clicking the current value clears it back to unrated.
//
// Lifted out of music/AlbumDetail.jsx so the album page and the film/series page
// use ONE control rather than two that drift. SeriesDetail previously used a
// CandySelect dropdown reading "— / 10"; it now shares this.
//
// `stacked` puts the "Personal" label above the dots (album header); the default
// lays label and dots on one line (detail controls box).

import { useState } from 'react';

export default function RatingStrip({ value, accent, disabled, stacked, onChange }) {
  const [hover, setHover] = useState(0);
  const display = hover || value || 0;
  const fill = accent || 'var(--accent)';
  const starsRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => {
          const filled = n <= display;
          return (
            <button
              key={n}
              type="button"
              data-own-press
              disabled={disabled}
              onMouseEnter={() => setHover(n)}
              onClick={() => onChange(n === value ? 0 : n)}
              aria-label={`Rate ${n} out of 10`}
              title={`${n}/10`}
              className={'candy-btn' + (filled ? ' is-filled' : '')}
              data-shape="dot"
              style={{ '--accent': fill }}
            ><span className="candy-face" /></button>
          );
        })}
      </div>
      <span style={{
        fontSize: 10, fontFamily: 'var(--font-mono)',
        color: value > 0 ? 'var(--text-muted)' : 'var(--text-faint)',
        fontVariantNumeric: 'tabular-nums',
        minWidth: 32,
      }}>
        {value > 0 ? `${value}/10` : '— /10'}
      </span>
    </div>
  );
  return (
    <div
      onMouseLeave={() => setHover(0)}
      style={stacked
        ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }
        : { display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 }}
    >
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em',         color: 'var(--text-faint)',
      }}>Personal</span>
      {starsRow}
    </div>
  );
}
