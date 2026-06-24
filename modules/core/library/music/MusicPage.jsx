// Music section page. A persistent MusicTopBar sits atop every mode; the mode is
// parsed from the URL rest (everything after /tools/library/music/):
//   ""                                   → MusicHome (combined search-first home)
//   "library" | "library/<status>"       → MusicLibrary grid (all / status-filtered)
//   "downloaded" | "downloaded/<album>"  → AlbumBrowser (left, resizable) + AlbumDetail
//   "playlists" | "playlists/<path>"     → PlaylistsPage (grid / detail)
//   "browse"                             → MusicBrainz discovery + download
//   legacy "personal[/<album>]" or bare "<album>" → downloaded (back-compat)

import { useEffect, useRef, useState } from 'react';
import AlbumBrowser from './AlbumBrowser.jsx';
import AlbumDetail  from './AlbumDetail.jsx';
import BrowsePage   from './BrowsePage.jsx';
import PlaylistsPage from './PlaylistsPage.jsx';
import MusicHome    from './MusicHome.jsx';
import MusicLibrary from './MusicLibrary.jsx';
import MusicTopBar  from './MusicTopBar.jsx';
import SidebarSeam from '@host/components/SidebarSeam.jsx';

const LAST_VIEWED_KEY = 'tools:lastMusicPath';
const SPLIT_WIDTH_KEY = 'music:split:width';
const SPLIT_MIN      = 320;  // album-browser (left) floor
const RIGHT_MIN      = 360;  // detail (right) floor — reserved so it never overflows
const SEAM_W         = 6;    // SidebarSeam hotzone width
const SPLIT_FALLBACK = 480;  // used before the container is measured
const SNAP_TARGETS   = [360, 440, 520, 600];

function replaceHash(newHash) {
  const base = window.location.href.split('#')[0];
  window.history.replaceState(null, '', base + '#' + newHash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function decodePath(path) {
  let prev;
  let current = path;
  let safety = 0;
  while (safety < 10 && current !== prev) {
    prev = current;
    try {
      current = current.split('/').map(s => decodeURIComponent(s)).join('/');
    } catch {
      break;
    }
    safety++;
  }
  return current;
}
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// Split the rest into a mode:
//   "" (bare /tools/library/music)        → home (the combined search-first surface)
//   "browse" | "browse/q/<query>" | "browse/artists/q/<query>" → Browse (seeded)
//   "library[/<status>]"          → MusicLibrary grid (all / status-filtered)
//   "playlists[/<path>]"          → Playlists
//   "downloaded[/<album>]" | legacy "personal[/<album>]" | bare "<album>" → album split-view
function parseMusicRoute(rest) {
  if (!rest) return { mode: 'home', album: '' };
  const segs = rest.split('/');
  const first = segs[0];
  if (first === 'browse') {
    let browseMode = 'albums', qi = 1;
    if (segs[1] === 'artists' || segs[1] === 'albums') { browseMode = segs[1]; qi = 2; }
    const browseQuery = (segs[qi] === 'q' && segs.length > qi + 1)
      ? decodePath(segs.slice(qi + 1).join('/')) : '';
    return { mode: 'browse', album: '', browseMode, browseQuery };
  }
  const slash = rest.indexOf('/');
  const tail  = slash === -1 ? '' : rest.slice(slash + 1);
  if (first === 'library') return { mode: 'library', album: '', status: segs[1] || null };
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
  const { mode, album, status, browseMode, browseQuery } = parseMusicRoute(rest || '');
  const selectedPath = album;

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

  const onSelectAlbum = (albumPath) => {
    replaceHash('/tools/library/music/downloaded/' + encodePath(albumPath));
  };

  let content;
  if (mode === 'home') {
    content = <MusicHome accent={accent}/>;
  } else if (mode === 'library') {
    content = <MusicLibrary accent={accent} status={status}/>;
  } else if (mode === 'browse') {
    content = (
      <BrowsePage
        key={'browse:' + (browseMode || '') + ':' + (browseQuery || '')}
        accent={accent}
        initialQuery={browseQuery}
        initialMode={browseMode === 'artists' ? 'artists' : 'albums'}
      />
    );
  } else if (mode === 'playlists') {
    content = <PlaylistsPage accent={accent} rest={album}/>;
  } else {
    content = (
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
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          transition: isResizing ? 'none' : 'width 120ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}>
          <AlbumBrowser accent={accent} onSelect={onSelectAlbum} selectedPath={selectedPath}/>
        </div>

        <SidebarSeam
          width={leftWidth}
          onWidthChange={setLeftWidth}
          accent={accent || 'var(--text)'}
          defaultWidth={defaultW}
          minWidth={SPLIT_MIN}
          maxWidth={dynamicMax}
          snapTargets={SNAP_TARGETS}
          storageKey={SPLIT_WIDTH_KEY}
          ariaLabel="Resize album browser"
          edgeRingSide="right"
          onDragStart={() => setIsResizing(true)}
          onDragEnd={() => setIsResizing(false)}
        />

        <div style={{
          flex: 1, minWidth: RIGHT_MIN, minHeight: 0,
          display: 'flex', flexDirection: 'column',
        }}>
          {selectedPath
            ? <AlbumDetail accent={accent} albumPath={selectedPath}/>
            : <EmptyDetail/>
          }
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MusicTopBar accent={accent} rest={rest} />
      {content}
    </div>
  );
}

function EmptyDetail() {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-faint)', fontSize: 13,
      fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
      textTransform: 'uppercase',
    }}>
      Select an album
    </div>
  );
}

