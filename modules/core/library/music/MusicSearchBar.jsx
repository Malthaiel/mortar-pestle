// The persistent Music search bar. MusicPage pins it top-right over the right
// column, so every Music screen can search without navigating to the home
// surface first.
//
// Typing floats the results in a Popover anchored under the field — the page
// behind is left alone. Enter commits the search and navigates to the full-page
// results at /tools/library/music/q/<query>, where `suppress` turns the popup
// off and the same bar drives the page inline instead.
//
// Composition only: the library column's search field (SearchRun's chip-field
// part, in a one-part .candy-split for the run's height rule) minus the slide,
// the shared Popover (portal + Esc + click-outside), Seg + useSearchTab (same
// localStorage key as the full page, so the tab choice carries across), and
// SearchResults itself — every fetch and result stack is reused verbatim.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover, Seg } from '@host/components/ui';
import { IconSearch } from '@host/components/icons.jsx';
import { navigate as go } from '@host/router.js';
import { SEARCH_TABS, useSearchTab, SEARCH_SOURCES, useSearchSource } from './searchShared.jsx';
import { SearchResults } from './MusicHome.jsx';
import { RUN_SIZE } from './util.js';

const FIELD_W = 320;
const PANEL_W = 560;
const PAD = 8;    // viewport edge clamp
const GAP_Y = 12; // breathing room under the field

export default function MusicSearchBar({ accent, query, setQuery, albums, ownedIds, onPlay, suppress }) {
  const btnRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [tab, setTab] = useSearchTab('tools:musicSearchTab');
  const [source, setSource] = useSearchSource('tools:musicSearchSource');
  const q = (query || '').trim();
  const show = open && !!q && !suppress;

  // Anchor under the field, RIGHT edges flush (it sits in the top-right
  // corner), clamped into the viewport. Measured rather than positioned by CSS
  // because the panel is portalled to document.body.
  useLayoutEffect(() => {
    if (!show) { setPos(null); return undefined; }
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const width = Math.min(PANEL_W, vw - 2 * PAD);
      setPos({
        top: r.bottom + GAP_Y,
        left: Math.max(PAD, Math.min(r.right - width, vw - width - PAD)),
        width,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [show]);

  // Every result inside SearchResults navigates on click, so the hash change is
  // the universal "a result was picked" signal — cheaper than threading an
  // onSelect callback through every result stack.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);

  const onKeyDown = (e) => {
    if (e.key !== 'Enter' || !q) return;
    e.preventDefault();
    setOpen(false);
    inputRef.current?.blur();
    go('/tools/library/music/q/' + encodeURIComponent(q));
  };

  return (
    <>
      <div className="candy-split" style={{ display: 'flex', width: FIELD_W, '--cbtn-size': RUN_SIZE }}>
        <span
          ref={btnRef}
          className="candy-btn"
          data-shape="chip-field"
          data-music-search
          // A press on the icon or padding focuses the input, as in SearchRun.
          onMouseDown={(e) => {
            if (e.target === inputRef.current) return;
            e.preventDefault();
            inputRef.current.focus();
          }}
        >
          <span className="candy-face" style={{ padding: '5px var(--chip-pad-x)', gap: 'var(--candy-face-gap)' }}>
            <IconSearch size={14} />
            <input
              ref={inputRef}
              className="chip-field-input"
              type="text"
              value={query || ''}
              onChange={(e) => { setQuery(e.target.value); setOpen(!!e.target.value.trim()); }}
              onFocus={() => setOpen(!!q)}
              onKeyDown={onKeyDown}
              placeholder={'Search your library and ' +
                (source === 'yt' ? 'YouTube' : source === 'mb' ? 'MusicBrainz' : 'MusicBrainz + YouTube')}
              // SearchRun's input style: the face carries the padding, and
              // line-height normal keeps the word level with chip labels.
              style={{ padding: 0, lineHeight: 'normal' }}
            />
          </span>
        </span>
      </div>
      {show && pos && (
        <Popover
          open
          onClose={() => setOpen(false)}
          accent={accent}
          ariaLabel="Music search results"
          // Clicking the input itself must not count as an outside click, or
          // the panel would close on every click back into the box.
          outsideExempt="[data-music-search]"
          // zIndex mirrors BlockLibraryPopover — .candy-modal sets no stacking
          // order of its own, so without it the panel loses to page content.
          style={{ position: 'fixed', zIndex: 1100, top: pos.top, left: pos.left, width: pos.width, maxHeight: '60vh' }}
          bodyStyle={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <Seg options={SEARCH_SOURCES} value={source} onChange={setSource} accent={accent} />
          <Seg options={SEARCH_TABS} value={tab} onChange={setTab} accent={accent} />
          <SearchResults
            query={q} tab={tab} source={source} accent={accent}
            albums={albums} ownedIds={ownedIds} onPlay={onPlay}
          />
        </Popover>
      )}
    </>
  );
}
