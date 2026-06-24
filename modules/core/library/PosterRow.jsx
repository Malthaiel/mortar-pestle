// Horizontal-scroll poster carousel for the Anime homepage (Continue Watching,
// Top Anime, This Season) and reused by the see-all grids' header. A title row
// with an optional "See all" link and two scrub buttons sits above a single
// horizontally-scrolling track of fixed-width poster columns. Children are the
// caller's cards (SeriesCard / AnimeResultCard) — PosterRow owns only the
// track + scrubbing, not the tile.
//
// layout="grid" swaps the horizontal track for a wrapping auto-fill grid and
// hides the scrub arrows (used by AnimeCredits' Characters "See all" expand);
// seeAllLabel overrides the chip text for that in-place toggle. colWidth sets
// the poster column width (default 150px; the Characters rail passes a smaller
// value so its cards shrink without touching the home sliders).

import { useRef } from 'react';

export default function PosterRow({ title, subtitle, onSeeAll, seeAllLabel = 'See all →', layout = 'row', colWidth = 150, accent, children }) {
  const ref = useRef(null);
  const grid = layout === 'grid';
  const scrollByDir = (dir) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(300, el.clientWidth * 0.82), behavior: 'smooth' });
  };
  const track = grid
    ? { display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${colWidth}px, 1fr))`, gap: 14 }
    : {
        display: 'grid', gridAutoFlow: 'column', gridAutoColumns: `${colWidth}px`,
        gap: 14, overflowX: 'auto', overflowY: 'hidden',
        // Deliberately NO `scrollbar-width` here: WebKitGTK honors that standard
        // property and would draw a native overlay bar, diverging from the rest
        // of the app. Omitting it lets the global `::-webkit-scrollbar` rule
        // apply — the same 6px grey→accent thumb used app-wide on the vertical
        // bars, flipped horizontal. paddingBottom drops it into a clear band
        // below the cards (the custom bar is non-overlay, so this separates it).
        paddingBottom: 20,
      };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{
          margin: 0, fontSize: 15, fontWeight: 700,
          color: 'var(--text)', letterSpacing: '-0.01em',
        }}>{title}</h3>
        {subtitle && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
            {subtitle}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {onSeeAll && (
            <button onClick={onSeeAll} data-own-press className="candy-btn" data-shape="chip">
              <span className="candy-face" style={{ fontSize: 11 }}>{seeAllLabel}</span>
            </button>
          )}
          {!grid && (
            <>
              <Scrub accent={accent} onClick={() => scrollByDir(-1)} label="Scroll left">‹</Scrub>
              <Scrub accent={accent} onClick={() => scrollByDir(1)} label="Scroll right">›</Scrub>
            </>
          )}
        </div>
      </div>
      <div ref={ref} style={track}>
        {children}
      </div>
    </section>
  );
}

function Scrub({ accent, onClick, label, children }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      data-own-press
      className="candy-btn"
      data-shape="icon"
      style={{ width: 26, height: 26, '--accent': accent }}
    ><span className="candy-face" style={{ fontSize: 16, lineHeight: 1, color: 'var(--text-muted)' }}>{children}</span></button>
  );
}
