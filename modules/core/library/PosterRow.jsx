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

import { useLayoutEffect, useRef, useState } from 'react';

// The row's title lettering.
export const ROW_TITLE_STYLE = { margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' };
// A title starts where the first card's face does, inside its outline, so it
// has the same gap to its left as the button below it (user-directed
// 2026-09-26): the first card's face border under `root`, never restated. A
// tile first: a row's own See All / scrub chips sit before its cards.
export const faceInset = (root) => {
  const face = root?.querySelector('[data-shape="tile"] > .candy-face') || root?.querySelector('.candy-face');
  return face ? parseFloat(getComputedStyle(face).borderLeftWidth) || 0 : 0;
};

export default function PosterRow({ title, subtitle, onSeeAll, seeAllLabel = 'See All →', layout = 'row', colWidth = 150, accent, children }) {
  const ref = useRef(null);
  const grid = layout === 'grid';
  // Own first card's inset, unless a page lines several titles up on one value
  // (--row-title-inset, set by MusicCredits).
  const [inset, setInset] = useState(0);
  // How far the title's line box runs below its letters (a zero-size probe
  // sits on the baseline). The button run is lifted by that plus its own lip,
  // so the space under the buttons equals the space under the title
  // (user-directed 2026-09-26): read off the live title, never restated.
  const baseRef = useRef(null);
  const [descent, setDescent] = useState(0);
  useLayoutEffect(() => {
    setInset(faceInset(ref.current));
    const b = baseRef.current;
    if (b) setDescent(b.parentElement.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom);
  });
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
        // The scroller must be the containing block of its positioned cards
        // (every candy tile is position: relative): left static, the cards
        // painted past the row's left edge, over the column beside it, while it
        // scrolled (filmed 2026-09-26: 5 of 6 passes spilled, 0 of 6 with this).
        position: 'relative',
      };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <h3 style={{ ...ROW_TITLE_STYLE, paddingLeft: `var(--row-title-inset, ${inset}px)` }}>{title}<span ref={baseRef} style={{ display: 'inline-block' }}/></h3>
        {subtitle && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
            {subtitle}
          </span>
        )}
        {/* One fused run at the source run's height (Last.fm / RYM, 26px),
            user-directed 2026-09-26. ponytail: 26px restated from SourceRun;
            lift to a shared export if a third run needs it. */}
        {(onSeeAll || !grid) && (
        <div className="candy-split" style={{ marginLeft: 'auto', marginBottom: `calc(${descent}px + var(--candy-depth-small))`, '--cbtn-size': '26px', '--accent': accent }}>
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
        )}
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
      data-shape="chip"
      style={{ '--accent': accent }}
    ><span className="candy-face" style={{ fontSize: 16, lineHeight: 1, color: 'var(--text-muted)' }}>{children}</span></button>
  );
}
