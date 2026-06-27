// Combined Music home — the single search-first surface that folds the old
// Downloaded / Playlists / Browse tabs into one. Carousel-first, cloned from the
// Anime tab's AnimeHome: a search bar spanning your library + MusicBrainz, then
// (when the query is empty) Continue Listening, Your Playlists, Recently Added,
// and a library-derived "More from artists you own" discovery row. Library cards
// route to the album detail (/tools/library/music/downloaded/<path>); MusicBrainz cards
// route into the existing Browse preview seeded with their query.

import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { usePlaylists } from './PlaylistProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import BrowseResultCard from './BrowseResultCard.jsx';
import CollageCover from './CollageCover.jsx';
import PosterRow from '@modules/core/library/PosterRow.jsx';

const go = (hash) => { window.location.hash = hash; };
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const toAlbum = (path) => go('/tools/library/music/downloaded/' + encodePath(path));
const toBrowse = (q, mode) =>
  go('/tools/library/music/browse/' + (mode === 'artists' ? 'artists/' : '') + 'q/' + encodeURIComponent(q));
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

export default function MusicHome({ accent }) {
  const { playAlbumTracks } = useMusicPlayer();
  const { playlists } = usePlaylists();
  const [albums, setAlbums] = useState(null);   // owned library (null = loading)
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = () => musicApi.listAlbums()
      .then(l => { if (!cancelled) setAlbums(l || []); })
      .catch(() => { if (!cancelled) setAlbums([]); });
    load();
    window.addEventListener('music-library-changed', load);
    return () => { cancelled = true; window.removeEventListener('music-library-changed', load); };
  }, []);

  // Play an album by reading its full detail then loading the queue.
  const playAlbum = async (album) => {
    try {
      const detail = await musicApi.readAlbum(album.path);
      playAlbumTracks(detail, 0);
    } catch {}
  };

  const ownedIds = useMemo(
    () => new Set((albums || []).map(a => a.providerId).filter(Boolean)),
    [albums],
  );
  const q = query.trim();

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '20px 22px 40px',
        display: 'flex', flexDirection: 'column', gap: 26,
      }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library and MusicBrainz…"
          className="candy-input"
          style={{ padding: '11px 14px', fontSize: 14, color: 'var(--text)', outline: 'none', width: '100%' }}
        />

        {q ? (
          <SearchResults query={q} accent={accent} albums={albums} ownedIds={ownedIds}
                         onPlay={playAlbum} />
        ) : (
          <>
            <ContinueListening albums={albums} accent={accent} onPlay={playAlbum} />
            <YourPlaylists playlists={playlists} accent={accent} />
            <RecentlyAdded albums={albums} accent={accent} onPlay={playAlbum} />
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
  return (
    <div
      onClick={() => toPlaylist(playlist.path)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toPlaylist(playlist.path); } }}
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
                          onSelect={() => toBrowse(`${r.title} ${r.artist}`.trim(), 'albums')} />
      ))}
    </PosterRow>
  );
}

// ---- Search ----------------------------------------------------------------

function SearchResults({ query, accent, albums, ownedIds, onPlay }) {
  const [mbAlbums, setMbAlbums] = useState(null);
  const [mbArtists, setMbArtists] = useState(null);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  useEffect(() => {
    const myId = ++reqId.current;
    setError(null); setMbAlbums(null); setMbArtists(null);
    const t = setTimeout(async () => {
      try {
        const [al, ar] = await Promise.all([
          musicApi.searchReleaseGroups(query, 18, 0).catch(() => []),
          musicApi.searchArtists(query).catch(() => []),
        ]);
        if (myId === reqId.current) { setMbAlbums(al || []); setMbArtists(ar || []); }
      } catch (e) {
        if (myId === reqId.current) setError(errText(e, 'Search failed.'));
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const localHits = useMemo(() => {
    const ql = query.toLowerCase();
    return (albums || []).filter(a =>
      (a.title || '').toLowerCase().includes(ql) ||
      (a.artist || '').toLowerCase().includes(ql)
    ).slice(0, 12);
  }, [albums, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupHeading>In your library</GroupHeading>
        {localHits.length === 0
          ? <Muted>No matches in your library.</Muted>
          : <div style={GRID}>{localHits.map(a => (
              <CoverArtCard key={a.path} album={a} accent={accent} selected={false} onSelect={toAlbum} onPlay={onPlay} />
            ))}</div>}
      </div>

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
                                onSelect={() => toBrowse(`${r.title} ${r.artist || ''}`.trim(), 'albums')} />
            ))}</div>)}
      </div>

      {mbArtists && mbArtists.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <GroupHeading>Artists · MusicBrainz</GroupHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {mbArtists.slice(0, 8).map(a => (
              <ArtistRow key={a.mbid} artist={a} onSelect={() => toBrowse(a.name, 'artists')} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ArtistRow({ artist, onSelect }) {
  const [hover, setHover] = useState(false);
  const sub = [artist.disambiguation, artist.country].filter(Boolean).join(' · ');
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start',
        textAlign: 'left', width: '100%', padding: '10px 12px',
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
        background: hover ? 'var(--surface-2)' : 'transparent',
        cursor: 'pointer', transition: 'background 120ms ease',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{artist.name}</span>
      {sub && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</span>}
    </button>
  );
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
