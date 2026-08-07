// Combined Music home — the single search-first surface that folds the old
// Downloaded / Playlists / Browse tabs into one. Carousel-first, cloned from the
// Anime tab's AnimeHome: Continue Listening, Your Playlists, Recently Added, and
// a library-derived "More from artists you own" discovery row when the query is
// empty; the result stacks when it isn't. Library cards route to the album detail
// (/tools/library/music/downloaded/<path>); MusicBrainz cards route into the
// existing Browse preview seeded with their query.
//
// The search bar itself no longer lives here — it moved into MusicTopBar
// (MusicSearchBar.jsx) so it is present on every Music screen. MusicPage owns the
// query, the album list and the hash mirroring, and hands them down; this page is
// the FULL-PAGE view of a committed search, and `SearchResults` is exported so
// the topbar popup renders the identical stacks.

import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { usePlaylists } from './PlaylistProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import BrowseResultCard from './BrowseResultCard.jsx';
import CollageCover from './CollageCover.jsx';
import PosterRow from '@modules/core/library/PosterRow.jsx';
import { Seg } from '@host/components/ui/index.js';
import {
  SEARCH_TABS, useSearchTab, SEARCH_SOURCES, useSearchSource,
  ResultRow, trackRowProps, recordingRowProps, youtubeRowProps,
} from './searchShared.jsx';
import { usePlaylistMenu } from './contextMenus.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { youtubeQueueItem } from './util.js';
import { encodePath } from '../paths.js';
import { navigate as go } from '@host/router.js';

const toAlbum = (path) => go('/tools/library/music/downloaded/' + encodePath(path));
const toBrowse = (q, mode) =>
  go('/tools/library/music/browse/' + (mode === 'artists' ? 'artists/' : '') + 'q/' + encodeURIComponent(q));
// Identity links: open the album/artist itself. Clicking a specific result used
// to hand Browse only its NAME as a fresh query, so you landed on the Browse
// grid and had to click the same thing a second time.
const toRelease = (mbid) => go('/tools/library/music/browse/rg/' + encodeURIComponent(mbid));
const toArtistPage = (mbid, name) =>
  go('/tools/library/music/browse/artist/' + encodeURIComponent(mbid) +
     (name ? '/' + encodeURIComponent(name) : ''));
const toPlaylists = () => go('/tools/library/music/playlists');
const toPlaylist = (path) => go('/tools/library/music/playlists/' + encodePath(path));

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 };

function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

export default function MusicHome({ accent, query = '', albums, ownedIds, onPlay }) {
  const { playlists } = usePlaylists();
  const [tab, setTab] = useSearchTab('tools:musicSearchTab');
  const [source, setSource] = useSearchSource('tools:musicSearchSource');
  const q = (query || '').trim();

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '20px 22px 40px',
        display: 'flex', flexDirection: 'column', gap: 26,
      }}>
        {q ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Seg options={SEARCH_SOURCES} value={source} onChange={setSource} accent={accent}/>
              <Seg options={SEARCH_TABS} value={tab} onChange={setTab} accent={accent}/>
            </div>
            <SearchResults query={q} tab={tab} source={source} accent={accent} albums={albums}
                           ownedIds={ownedIds} onPlay={onPlay} />
          </>
        ) : (
          <>
            <ContinueListening albums={albums} accent={accent} onPlay={onPlay} />
            <YourPlaylists playlists={playlists} accent={accent} />
            <RecentlyAdded albums={albums} accent={accent} onPlay={onPlay} />
            <MoreFromYourArtists albums={albums} ownedIds={ownedIds} accent={accent} />
          </>
        )}
      </div>
    </div>
  );
}

// ---- Empty-state carousels -------------------------------------------------

// Currently-Listening albums, most-recently-added first (mirrors the Anime
// tab's status-driven Continue Watching).
function ContinueListening({ albums, accent, onPlay }) {
  const items = useMemo(() => (albums || [])
    .filter(a => a.status === 'Currently-Listening')
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, 14), [albums]);
  if (albums === null) return null;
  if (items.length === 0) return null;
  return (
    <PosterRow title="Continue Listening" accent={accent} colWidth={160}>
      {items.map(a => (
        <CoverArtCard key={a.path} album={a} accent={accent} selected={false} onSelect={toAlbum} onPlay={onPlay} />
      ))}
    </PosterRow>
  );
}

function RecentlyAdded({ albums, accent, onPlay }) {
  const items = useMemo(() => [...(albums || [])]
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, 18), [albums]);
  if (albums === null) return <Muted>Loading your library…</Muted>;
  if (items.length === 0) return null;
  return (
    <PosterRow title="Recently Added" accent={accent} colWidth={160}
               onSeeAll={() => go('/tools/library/music/downloaded')}>
      {items.map(a => (
        <CoverArtCard key={a.path} album={a} accent={accent} selected={false} onSelect={toAlbum} onPlay={onPlay} />
      ))}
    </PosterRow>
  );
}

function YourPlaylists({ playlists, accent }) {
  if (!playlists || playlists.length === 0) return null;
  return (
    <PosterRow title="Your Playlists" accent={accent} colWidth={160} onSeeAll={toPlaylists}>
      {playlists.map(p => <PlaylistMiniCard key={p.path} playlist={p} accent={accent} />)}
    </PosterRow>
  );
}

function PlaylistMiniCard({ playlist, accent }) {
  const count = playlist.trackCount || 0;
  const playlistMenu = usePlaylistMenu(accent);
  return (
    <div
      onClick={() => toPlaylist(playlist.path)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toPlaylist(playlist.path); } }}
      onContextMenu={(e) => playlistMenu(e, playlist)}
      role="button" tabIndex={0}
      className="candy-btn" data-shape="tile"
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face">
        <div style={{ width: '100%', aspectRatio: '1 / 1', borderRadius: 6, overflow: 'hidden', background: 'var(--surface-2)' }}>
          <CollageCover image={playlist.image} urls={playlist.coverUrls} title={playlist.title} accent={accent} />
        </div>
        <div style={{ marginTop: 10, minWidth: 0 }}>
          <div title={playlist.title} style={{
            fontSize: 13, fontWeight: 500, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{playlist.title}</div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
            {count} track{count === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    </div>
  );
}

// Library-derived discovery: take a couple of artists you own, pull their
// MusicBrainz discographies, and surface the releases you don't have yet. Best
// effort — hidden entirely if MusicBrainz is unreachable or returns nothing.
function MoreFromYourArtists({ albums, ownedIds, accent }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (albums === null) return;
    if (albums.length === 0) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      const artists = [...new Set(albums.map(a => a.artist).filter(Boolean))].slice(0, 2);
      const out = [];
      const seen = new Set();
      for (const name of artists) {
        try {
          const hits = await musicApi.searchArtists(name);
          const mbid = hits && hits[0] && hits[0].mbid;
          if (!mbid) continue;
          const rgs = await musicApi.artistReleaseGroups(mbid);
          (rgs || []).forEach(r => {
            if (!r.mbid || ownedIds.has(r.mbid) || seen.has(r.mbid)) return;
            seen.add(r.mbid);
            out.push({ ...r, artist: r.artist || name });
          });
        } catch {}
        if (out.length >= 18) break;
      }
      if (!cancelled) setItems(out.slice(0, 18));
    })();
    return () => { cancelled = true; };
  }, [albums, ownedIds]);

  if (!items || items.length === 0) return null;
  return (
    <PosterRow title="More from artists you own" accent={accent} colWidth={160}>
      {items.map(r => (
        <BrowseResultCard key={r.mbid} result={r} accent={accent} inLibrary={false}
                          onSelect={() => toRelease(r.mbid)} />
      ))}
    </PosterRow>
  );
}

// ---- Search ----------------------------------------------------------------

// Exported: the topbar's MusicSearchBar popup renders the identical stacks, so
// the popup and the full page can never drift apart.
export function SearchResults({ query, tab, source = 'both', accent, albums, ownedIds, onPlay }) {
  const [mbAlbums, setMbAlbums] = useState(null);
  const [mbArtists, setMbArtists] = useState(null);
  const [mbSongs, setMbSongs] = useState(null);
  const [localSongs, setLocalSongs] = useState(null);
  const [ytSongs, setYtSongs] = useState(null);
  const [ytError, setYtError] = useState(null);
  const [error, setError] = useState(null);
  const { playTracks } = useMusicPlayer();
  const reqId = useRef(0);

  // Which stacks this tab renders — also gates the fetches, so switching to
  // Artists never spends a MusicBrainz call on recordings. `source` gates the
  // two remote catalogues on top of that; the local-library stacks ignore it.
  const wantMb = source !== 'yt';
  const wantYt = source !== 'mb';
  const showAlbums  = tab === 'all' || tab === 'albums';
  const showSongs   = tab === 'all' || tab === 'songs';
  const showArtists = tab === 'all' || tab === 'artists';

  useEffect(() => {
    const myId = ++reqId.current;
    setError(null); setYtError(null);
    setMbAlbums(null); setMbArtists(null); setMbSongs(null); setLocalSongs(null); setYtSongs(null);
    const t = setTimeout(async () => {
      try {
        const [al, ar, rec, tr, yt] = await Promise.all([
          wantMb && showAlbums  ? musicApi.searchReleaseGroups(query, 18, 0).catch(() => []) : Promise.resolve(null),
          wantMb && showArtists ? musicApi.searchArtists(query).catch(() => [])              : Promise.resolve(null),
          wantMb && showSongs   ? musicApi.searchRecordings(query).catch(() => [])           : Promise.resolve(null),
          showSongs             ? musicApi.searchTracks(query, 40).catch(() => [])           : Promise.resolve(null),
          // yt-dlp shells out (1-3s) and can fail on its own (tool missing, no
          // network) — its error is kept separate so it never blanks the
          // MusicBrainz stacks.
          wantYt && showSongs
            ? musicApi.searchYoutube(query, 15).catch((e) => { setYtError(errText(e, 'YouTube search failed.')); return []; })
            : Promise.resolve(null),
        ]);
        if (myId !== reqId.current) return;
        setMbAlbums(al); setMbArtists(ar); setMbSongs(rec); setLocalSongs(tr); setYtSongs(yt);
      } catch (e) {
        if (myId === reqId.current) setError(errText(e, 'Search failed.'));
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, showAlbums, showSongs, showArtists, wantMb, wantYt]);

  const localHits = useMemo(() => {
    const ql = query.toLowerCase();
    return (albums || []).filter(a =>
      (a.title || '').toLowerCase().includes(ql) ||
      (a.artist || '').toLowerCase().includes(ql)
    ).slice(0, 12);
  }, [albums, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {showAlbums && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <GroupHeading>In your library</GroupHeading>
          {localHits.length === 0
            ? <Muted>No matches in your library.</Muted>
            : <div style={GRID}>{localHits.map(a => (
                <CoverArtCard key={a.path} album={a} accent={accent} selected={false} onSelect={toAlbum} onPlay={onPlay} />
              ))}</div>}
        </div>
      )}

      {showSongs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <GroupHeading>Songs in your library</GroupHeading>
          {localSongs === null && <Muted>Searching…</Muted>}
          {localSongs && (localSongs.length === 0
            ? <Muted>No songs in your library match.</Muted>
            : <RowList>{localSongs.map(t => (
                <ResultRow key={`${t.albumPath}#${t.disc}.${t.n}`} {...trackRowProps(t)}
                           onClick={() => toAlbum(t.albumPath)} />
              ))}</RowList>)}
        </div>
      )}

      {wantYt && showSongs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <GroupHeading>Songs · YouTube</GroupHeading>
          {ytError && <div style={{ color: 'var(--text)', fontSize: 12 }}>{ytError}</div>}
          {!ytError && ytSongs === null && <Muted>Searching…</Muted>}
          {!ytError && ytSongs && (ytSongs.length === 0
            ? <Muted>No songs.</Muted>
            : <RowList>{ytSongs.map(h => (
                <ResultRow key={h.watchUrl} {...youtubeRowProps(h)}
                           onClick={() => playTracks([youtubeQueueItem(h)], 0)} />
              ))}</RowList>)}
        </div>
      )}

      {wantMb && showSongs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <GroupHeading>Songs · MusicBrainz</GroupHeading>
          {!error && mbSongs === null && <Muted>Searching…</Muted>}
          {!error && mbSongs && (mbSongs.length === 0
            ? <Muted>No songs.</Muted>
            : <RowList>{mbSongs.map(r => (
                <ResultRow key={r.mbid} {...recordingRowProps(r)}
                           onClick={() => (r.releaseGroupMbid
                             ? toRelease(r.releaseGroupMbid)
                             // MusicBrainz doesn't always attach a release to a
                             // recording; fall back to a search for it.
                             : toBrowse(`${r.title} ${r.artist || ''}`.trim(), 'albums'))} />
              ))}</RowList>)}
        </div>
      )}

      {wantMb && showAlbums && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <GroupHeading>Albums · MusicBrainz</GroupHeading>
            {mbAlbums && mbAlbums.length > 0 && (
              <button onClick={() => toBrowse(query, 'albums')} data-own-press
                      className="candy-btn" data-shape="chip" style={{ marginLeft: 'auto' }}>
                <span className="candy-face" style={{ fontSize: 11 }}>See all →</span>
              </button>
            )}
          </div>
          {error && <div style={{ color: 'var(--text)', fontSize: 12 }}>{error}</div>}
          {!error && mbAlbums === null && <Muted>Searching…</Muted>}
          {!error && mbAlbums && (mbAlbums.length === 0
            ? <Muted>No albums.</Muted>
            : <div style={GRID}>{mbAlbums.map(r => (
                <BrowseResultCard key={r.mbid} result={r} accent={accent}
                                  inLibrary={ownedIds.has(r.mbid)}
                                  onSelect={() => toRelease(r.mbid)} />
              ))}</div>)}
        </div>
      )}

      {wantMb && showArtists && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <GroupHeading>Artists · MusicBrainz</GroupHeading>
          {!error && mbArtists === null && <Muted>Searching…</Muted>}
          {!error && mbArtists && (mbArtists.length === 0
            ? <Muted>No artists.</Muted>
            : <RowList>{mbArtists.slice(0, tab === 'artists' ? 25 : 8).map(a => (
                <ResultRow key={a.mbid} title={a.name}
                           sub={[a.disambiguation, a.country].filter(Boolean).join(' · ')}
                           onClick={() => toArtistPage(a.mbid, a.name)} />
              ))}</RowList>)}
        </div>
      )}
    </div>
  );
}

function RowList({ children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>;
}

// ---- Small primitives ------------------------------------------------------

function GroupHeading({ children }) {
  return (
    <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
      {children}
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: '4px 0' }}>{children}</div>;
}
