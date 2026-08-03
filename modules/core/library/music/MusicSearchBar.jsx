// The persistent Music search bar. It lives in MusicTopBar's `leading` slot, so
// every Music screen can search without navigating to the home surface first.
//
// Typing floats the results in a Popover anchored under the input — the page
// behind is left alone. Enter commits the search and navigates to the full-page
// results at /tools/library/music/q/<query>, where `suppress` turns the popup
// off and the same bar drives the page inline instead.
//
// Composition only: `.candy-input` (the markup MusicHome's inline bar used),
// the shared Popover (portal + Esc + click-outside), Seg + useSearchTab (same
// localStorage key as the full page, so the tab choice carries across), and
// SearchResults itself — every fetch and result stack is reused verbatim.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover, Seg } from '@host/components/ui';
import { navigate as go } from '@host/router.js';
import { SEARCH_TABS, useSearchTab } from './searchShared.jsx';
import { SearchResults } from './MusicHome.jsx';

const PANEL_W = 560;
const PAD = 8;

export default function MusicSearchBar({ accent, query, setQuery, albums, ownedIds, onPlay, suppress }) {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [tab, setTab] = useSearchTab('tools:musicSearchTab');
  const q = (query || '').trim();
  const show = open && !!q && !suppress;

  // Anchor under the input, left edges flush, clamped into the viewport.
  // Measured rather than positioned by CSS because the panel is portalled to
  // document.body (the topbar is a scroll container and would clip it).
  useLayoutEffect(() => {
    if (!show) { setPos(null); return undefined; }
    const measure = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const width = Math.min(PANEL_W, vw - 2 * PAD);
      setPos({
        top: r.bottom + PAD,
        left: Math.max(PAD, Math.min(r.left, vw - width - PAD)),
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
      <input
        ref={inputRef}
        type="text"
        value={query || ''}
        onChange={(e) => { setQuery(e.target.value); setOpen(!!e.target.value.trim()); }}
        onFocus={() => setOpen(!!q)}
        onKeyDown={onKeyDown}
        placeholder="Search your library and MusicBrainz"
        className="candy-input"
        data-music-search
        style={{
          width: 320, flexShrink: 0,
          padding: '7px 12px', fontSize: 12,
          color: 'var(--text)', outline: 'none',
        }}
      />
      {show && pos && (
        <Popover
          open
          onClose={() => setOpen(false)}
          accent={accent}
          ariaLabel="Music search results"
          // Clicking the input itself must not count as an outside click, or
          // the panel would close on every click back into the box.
          outsideExempt="[data-music-search]"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxHeight: '60vh' }}
          bodyStyle={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <Seg options={SEARCH_TABS} value={tab} onChange={setTab} accent={accent} />
          <SearchResults
            query={q} tab={tab} accent={accent}
            albums={albums} ownedIds={ownedIds} onPlay={onPlay}
          />
        </Popover>
      )}
    </>
  );
}
