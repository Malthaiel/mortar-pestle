// The persistent Music search bar. MusicPage pins it top-centre over the right
// column, so every Music screen can search without navigating to the home
// surface first. It is the library column's SearchRun itself (user-directed
// 2026-09-25): an icon-only Home button leads and never slides; icon-only
// Reports and Pin follow the field and slide out when the text outgrows it. Reports and
// Pin are placeholders, not wired yet (user-directed, to come).
//
// Typing floats the results in a Popover anchored under the run — the page
// behind is left alone. Enter commits the search and navigates to the full-page
// results at /tools/library/music/q/<query>, where `suppress` turns the popup
// off and the same bar drives the page inline instead.
//
// Composition only: SearchRun, the shared Popover (portal + Esc +
// click-outside), Seg + useSearchTab (same localStorage key as the full page,
// so the tab choice carries across), and SearchResults itself — every fetch
// and result stack is reused verbatim.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover, Seg } from '@host/components/ui';
import SearchRun from '@host/components/ui/SearchRun.jsx';
import { IconHome, IconPin, IconFileText } from '@host/components/icons.jsx';
import { ChipIconBtn } from '@host/components/planner/ItemChips.jsx';
import { navigate as go } from '@host/router.js';
import { SEARCH_TABS, useSearchTab, SEARCH_SOURCES, useSearchSource } from './searchShared.jsx';
import { SearchResults } from './MusicHome.jsx';
import { RUN_SIZE } from './util.js';

const PLACEHOLDER = 'What do you want to play?';
const PANEL_W = 560;
const PAD = 8;    // viewport edge clamp
const GAP_Y = 12; // breathing room under the field

export default function MusicSearchBar({ accent, query, setQuery, albums, ownedIds, onPlay, suppress, onHome }) {
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [tab, setTab] = useSearchTab('tools:musicSearchTab');
  const [source, setSource] = useSearchSource('tools:musicSearchSource');
  const q = (query || '').trim();
  const show = open && !!q && !suppress;

  // Anchor under the run, centred on it (the bar sits top-centre), clamped
  // into the viewport. Measured rather than positioned by CSS because the
  // panel is portalled to document.body.
  useLayoutEffect(() => {
    if (!show) { setPos(null); return undefined; }
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const width = Math.min(PANEL_W, vw - 2 * PAD);
      setPos({
        top: r.bottom + GAP_Y,
        left: Math.max(PAD, Math.min(r.left + (r.width - width) / 2, vw - width - PAD)),
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

  // SearchRun owns the input, so focus and Enter are caught as they bubble out
  // of it; the buttons beside it must not reopen the popup or commit.
  const isInput = (e) => e.target.tagName === 'INPUT';
  const onKeyDown = (e) => {
    if (!isInput(e) || e.key !== 'Enter' || !q) return;
    e.preventDefault();
    setOpen(false);
    e.target.blur();
    go('/tools/library/music/q/' + encodeURIComponent(q));
  };

  return (
    <>
      {/* The island: the run sits on a plate in the left sidebar's colour that
          hugs its width, like a MacBook notch (user-directed 2026-09-26). Even
          6px all round, the chips' lip (--candy-depth-small) added under them;
          --radius-lg follows the global corner setting and is concentric with
          the chips at the default (6px chip + 6px pad = 12px). */}
      <div ref={btnRef} data-music-search onKeyDown={onKeyDown} onFocus={(e) => { if (isInput(e)) setOpen(!!q); }}
        style={{ background: 'var(--surface)', padding: '6px 6px calc(6px + var(--candy-depth-small))', borderRadius: 'var(--radius-lg)' }}>
        <SearchRun
          value={query || ''}
          onChange={(v) => { setQuery(v); setOpen(!!v.trim()); }}
          placeholder={PLACEHOLDER}
          size={RUN_SIZE}
          leading={(
            <ChipIconBtn title="Music home" onClick={onHome} size={RUN_SIZE}>
              <IconHome size={14} />
            </ChipIconBtn>
          )}
        >
          <ChipIconBtn title="Reports" size={RUN_SIZE}>
            <IconFileText size={14} />
          </ChipIconBtn>
          <ChipIconBtn title="Pin" size={RUN_SIZE}>
            <IconPin size={14} />
          </ChipIconBtn>
        </SearchRun>
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
