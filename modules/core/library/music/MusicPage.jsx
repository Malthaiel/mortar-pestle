// Music section page. The AlbumBrowser library column is docked to the left of
// every mode (it used to exist only inside the `downloaded` route), and the
// MusicSearchBar is pinned top-centre over the right half on every mode (the
// topbar strip it rode was removed 2026-09-25). The mode picks what fills the
// right half; it is parsed from the URL rest (everything after /tools/library/music/):
//   ""                                   → MusicHome (combined search-first home)
//   "downloaded" | "downloaded/<album>"  → AlbumDetail
//   "playlists" | "playlists/<path>"     → PlaylistsPage (grid / detail)
//   "browse"                             → MusicBrainz discovery + download
//   legacy "personal[/<album>]" or bare "<album>" → downloaded (back-compat)

import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import AlbumBrowser from './AlbumBrowser.jsx';
import AlbumDetail  from './AlbumDetail.jsx';
import BrowsePage   from './BrowsePage.jsx';
import PlaylistsPage from './PlaylistsPage.jsx';
import MusicHome    from './MusicHome.jsx';
import MusicSearchBar from './MusicSearchBar.jsx';
import { TILE_GAP } from './util.js';
import ResizeSeam, { DRAG_EASE, HOTZONE_PX } from '@host/components/ui/ResizeSeam.jsx';
import { encodePath, decodePath } from '../paths.js';
import { navigate as go } from '@host/router.js';

const HOME_PATH = '/tools/library/music';
const LAST_VIEWED_KEY = 'tools:lastMusicPath';
const SPLIT_WIDTH_KEY = 'music:split:width';
const RIGHT_MIN      = 360;  // detail (right) floor — reserved so it never overflows
const SEAM_W         = 6;    // ResizeSeam hotzone width
const SPLIT_FALLBACK = 480;  // used before the container is measured
// The presets ARE the snap set — ResizeSeam derives it from them. Same three
// words as every other seam in the app. Compact is the narrowest the filter
// row fits (the Playlists view's 385px row + the bar's 18px sides + the 1px
// border, user-picked 2026-09-25); Default moved to 480 with it so the two
// keep their own snap zones (ResizeSeam SNAP_RADIUS 14).
const SPLIT_PRESETS = [
  { label: 'Compact', value: 424 },
  { label: 'Default', value: 480 },
  { label: 'Wide',    value: 600 },
];
// Album-browser (left) floor: no drag goes narrower than Compact, where the
// filter row would stick out (user-directed 2026-09-25; was 320).
const SPLIT_MIN = SPLIT_PRESETS[0].value;

// Split the rest into a mode:
//   "" (bare /tools/library/music)        → home (the combined search-first surface)
//   "browse" | "browse/q/<query>" | "browse/artists/q/<query>" → Browse (seeded)
//   "playlists[/<path>]"          → Playlists
//   "downloaded[/<album>]" | legacy "personal[/<album>]" | bare "<album>" → album split-view
function parseMusicRoute(rest) {
  if (!rest) return { mode: 'home', album: '' };
  const segs = rest.split('/');
  const first = segs[0];
  if (first === 'browse') {
    // Identity routes — open the thing itself rather than re-searching for its
    // name. Without these a picked album/artist could only be handed over as a
    // text query, which lands you on the Browse grid needing a second click.
    //   browse/rg/<releaseGroupMbid>       → straight into AlbumDetail
    //   browse/artist/<mbid>/<name?>       → straight into that discography
    if (segs[1] === 'rg' && segs[2]) {
      return { mode: 'browse', album: '', browseMode: 'albums', browseQuery: '', browseRg: segs[2] };
    }
    if (segs[1] === 'artist' && segs[2]) {
      return {
        mode: 'browse', album: '', browseMode: 'artists', browseQuery: '',
        browseArtist: { mbid: segs[2], name: segs[3] ? decodeURIComponent(segs[3]) : '' },
      };
    }
    let browseMode = 'albums', qi = 1;
    if (segs[1] === 'artists' || segs[1] === 'albums') { browseMode = segs[1]; qi = 2; }
    const browseQuery = (segs[qi] === 'q' && segs.length > qi + 1)
      ? decodePath(segs.slice(qi + 1).join('/')) : '';
    return { mode: 'browse', album: '', browseMode, browseQuery };
  }
  // "q/<query>" is still the home surface — the COMMITTED search (Enter in the
  // topbar bar), carrying the query so it survives a Back out of a result. This
  // page mirrors it back with replaceState (no per-keystroke history entries);
  // without it Back landed on an empty home.
  if (first === 'q') {
    return { mode: 'home', album: '', homeQuery: decodePath(segs.slice(1).join('/')) };
  }
  const slash = rest.indexOf('/');
  const tail  = slash === -1 ? '' : rest.slice(slash + 1);
  if (first === 'playlists') return { mode: 'playlists', album: tail ? decodePath(tail) : '' };
  // 'downloaded' (canonical) and legacy 'personal' both resolve to the library.
  if (first === 'downloaded' || first === 'personal') return { mode: 'downloaded', album: tail ? decodePath(tail) : '' };
  // Legacy /tools/library/music/<album> with no mode segment → downloaded album.
  return { mode: 'downloaded', album: decodePath(rest) };
}

function readInitialSplitWidth() {
  try {
    const v = parseInt(localStorage.getItem(SPLIT_WIDTH_KEY), 10);
    if (Number.isFinite(v) && v >= SPLIT_MIN) return v;
  } catch {}
  return SPLIT_FALLBACK;
}

export default function MusicPage({ accent, rest }) {
  const { mode, album, homeQuery, browseMode, browseQuery, browseRg, browseArtist } = parseMusicRoute(rest || '');
  const selectedPath = album;

  // ── Search (topbar-owned) ────────────────────────────────────────────
  // The query lives here, not in MusicHome, because MusicSearchBar renders on every
  // Music screen and MusicHome only on one. `onSearchPage` is the committed
  // search (Enter navigated to /q/<query>): there the popup is suppressed and the
  // bar drives the page inline instead of floating over it.
  const [query, setQuery] = useState(homeQuery || '');
  const onSearchPage = mode === 'home' && !!homeQuery;
  useEffect(() => { setQuery(homeQuery || ''); }, [homeQuery]);

  // One library fetch feeds both the popup and the home page.
  const [albums, setAlbums] = useState(null);   // owned library (null = loading)
  useEffect(() => {
    let cancelled = false;
    const load = () => musicApi.listAlbums()
      .then(l => { if (!cancelled) setAlbums(l || []); })
      .catch(() => { if (!cancelled) setAlbums([]); });
    load();
    window.addEventListener('music-library-changed', load);
    return () => { cancelled = true; window.removeEventListener('music-library-changed', load); };
  }, []);
  const ownedIds = useMemo(
    () => new Set((albums || []).map(a => a.providerId).filter(Boolean)),
    [albums],
  );

  // Play an album by reading its full detail then loading the queue. Defined
  // here so the popup and the home carousels share one implementation.
  const { playAlbumTracks } = useMusicPlayer();
  const playAlbum = async (a) => {
    try { playAlbumTracks(await musicApi.readAlbum(a.path), 0); } catch {}
  };

  // Mirror the committed query into the hash so Back out of a result returns to
  // these results instead of an empty home. replaceState, not navigate: a history
  // entry per keystroke turns Back into a per-letter rewind. Only runs on the
  // committed-search page — typing elsewhere just floats the popup and must
  // leave the URL of the page you're on alone.
  useEffect(() => {
    if (!onSearchPage) return undefined;
    const t = setTimeout(() => {
      const cur = (window.location.hash || '').replace(/^#/, '');
      if (cur !== HOME_PATH && !cur.startsWith(HOME_PATH + '/q/')) return;
      const q = query.trim();
      const want = HOME_PATH + (q ? '/q/' + encodeURIComponent(q) : '');
      if (cur === want) return;
      window.history.replaceState(null, '', window.location.href.split('#')[0] + '#' + want);
    }, 250);
    return () => clearTimeout(t);
  }, [query, onSearchPage]);

  // ── Resizable split (personal mode) ──────────────────────────────────
  const containerRef = useRef(null);
  const [containerW, setContainerW] = useState(0);
  const [leftWidth, setLeftWidth] = useState(readInitialSplitWidth);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (w) => { if (w > 0) setContainerW(w); };
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) measure(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const dynamicMax = Math.max(SPLIT_MIN, containerW - RIGHT_MIN - SEAM_W);
  const defaultW = containerW
    ? Math.round(Math.min(dynamicMax, Math.max(SPLIT_MIN, (containerW - SEAM_W) / 2)))
    : SPLIT_FALLBACK;

  // Once measured, pull a saved-too-wide width back into range so the detail
  // pane never drops below its floor. Not persisted — the preferred width is
  // restored when the window grows again.
  useEffect(() => {
    if (!containerW) return;
    setLeftWidth(w => Math.min(Math.max(SPLIT_MIN, w), dynamicMax));
  }, [containerW, dynamicMax]);

  // The combined home is the landing surface now, so the old "restore last-viewed
  // album on bare /tools/library/music" redirect was removed — bare → MusicHome.

  useEffect(() => {
    if (!selectedPath) return;
    try { localStorage.setItem(LAST_VIEWED_KEY, selectedPath); } catch {}
    const seg = selectedPath.split('/').pop() || '';
    document.title = 'Music · ' + seg.replace(/\.md$/, '');
    return () => { document.title = 'Citadel'; };
  }, [selectedPath]);

  // navigate (a history PUSH), not replaceState: picking an album in the browser
  // used to overwrite the current entry, so no album click was ever recorded and
  // the mouse Back button skipped the whole session in the split view and popped
  // out to wherever you were before Music. AlbumBrowser only calls this on a
  // click (no arrow-key selection), so one entry per pick is exactly one step.
  const onSelectAlbum = (albumPath) => {
    go('/tools/library/music/downloaded/' + encodePath(albumPath));
  };

  let content;
  if (mode === 'home') {
    // Only the committed search reaches the page — while the popup is floating
    // over the carousels the page underneath must stay as it was.
    content = (
      <MusicHome
        accent={accent}
        query={onSearchPage ? query : ''}
        albums={albums} ownedIds={ownedIds} onPlay={playAlbum}
      />
    );
  } else if (mode === 'browse' && browseRg) {
    // A Browse album is the ONE album page, fed by its release group
    // (user-directed 2026-09-28: "all album pages are the same").
    content = <AlbumDetail key={'rg:' + browseRg} accent={accent} rgMbid={browseRg}/>;
  } else if (mode === 'browse') {
    content = (
      <BrowsePage
        key={'browse:' + (browseMode || '') + ':' + (browseQuery || '') + ':' + (browseArtist?.mbid || '')}
        accent={accent}
        initialQuery={browseQuery}
        initialMode={browseMode === 'artists' ? 'artists' : 'albums'}
        initialArtist={browseArtist}
      />
    );
  } else if (mode === 'playlists') {
    content = <PlaylistsPage accent={accent} rest={album}/>;
  } else {
    content = selectedPath
      ? <AlbumDetail accent={accent} albumPath={selectedPath}/>
      : <EmptyDetail/>;
  }

  // The library column is permanent (Spotify-style): every mode renders inside
  // the right half of the same split, so the panel never unmounts on navigation.
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        ref={containerRef}
        style={{
          flex: 1, minHeight: 0, minWidth: 0,
          display: 'flex', flexDirection: 'row',
        }}
      >
        <div style={{
          width: leftWidth, flexShrink: 0,
          minWidth: SPLIT_MIN, minHeight: 0,
          borderRight: 'var(--candy-frame) solid var(--border)',
          display: 'flex', flexDirection: 'column',
          // A drag TRAILS the cursor on ResizeSeam's shared clock rather than
          // tracking it 1:1 — same lag and curve as the seam's own menu.
          transition: isResizing ? `width ${DRAG_EASE}`
            : 'width 120ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}>
          <AlbumBrowser accent={accent} onSelect={onSelectAlbum} selectedPath={selectedPath}/>
        </div>

        <ResizeSeam
          width={leftWidth}
          onWidthChange={setLeftWidth}
          accent={accent || 'var(--text)'}
          defaultWidth={defaultW}
          minWidth={SPLIT_MIN}
          maxWidth={dynamicMax}
          presets={SPLIT_PRESETS}
          storageKey={SPLIT_WIDTH_KEY}
          ariaLabel="Resize album browser"
          onDragStart={() => setIsResizing(true)}
          onDragEnd={() => setIsResizing(false)}
        />

        <div style={{
          flex: 1, minWidth: RIGHT_MIN, minHeight: 0,
          display: 'flex', flexDirection: 'column', position: 'relative',
        }}>
          {content}
          {/* Pinned top-centre (user-directed 2026-09-25), the same TILE_GAP
              from the top as the library column's run sits from its top.
              left/right 0 + fit-content + auto margins centres it without a
              full-width strip over the page. Over the page rather than above
              it, so the album's full-bleed sleeve still reaches the top edge.
              zIndex 2 clears .film-detail's children (z-index 1). left reaches
              back over the seam's in-flow strip so it centres between the two
              painted dividers, not 3px right of them (2026-09-26). */}
          <div style={{
            position: 'absolute', top: TILE_GAP, left: -HOTZONE_PX, right: 0,
            width: 'fit-content', margin: '0 auto', zIndex: 2,
          }}>
            <MusicSearchBar
              accent={accent}
              query={query} setQuery={setQuery}
              albums={albums} ownedIds={ownedIds} onPlay={playAlbum}
              suppress={onSearchPage}
              onHome={() => go(HOME_PATH)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyDetail() {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-faint)', fontSize: 13,
      fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
    }}>
      Select an album
    </div>
  );
}

