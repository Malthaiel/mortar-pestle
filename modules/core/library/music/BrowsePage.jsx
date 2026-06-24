// Browse page — Spotify-like MusicBrainz discovery. An [Albums | Artists]
// toggle switches search mode; Artists mode lists matching artists, and picking
// one shows their discography as the same cover grid. Search is debounced and
// race-guarded. Covers + download come from later sub-features; SF1 is search +
// grid + placeholder only.

import { useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { FilterChip, TextInput } from '@host/components/ui/index.js';
import BrowseResultCard from './BrowseResultCard.jsx';
import BrowsePreview from './BrowsePreview.jsx';

const MODE_ALBUMS = 'albums';
const MODE_ARTISTS = 'artists';

const GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
  gap: 14,
};

// Surface the real error: Tauri rejects a command with either a serialized
// VaultError ({ code, message }) or a bare string (e.g. a panic or arg error).
// Show whatever carries signal so failures are debuggable, not opaque.
function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

export default function BrowsePage({ accent, initialQuery = '', initialMode = MODE_ALBUMS }) {
  const [mode, setMode] = useState(initialMode === MODE_ARTISTS ? MODE_ARTISTS : MODE_ALBUMS);
  const [query, setQuery] = useState(initialQuery || '');
  const [results, setResults] = useState(null);   // albums / discography; null = idle
  const [artists, setArtists] = useState(null);    // artist hits; null = idle
  const [selectedArtist, setSelectedArtist] = useState(null); // { mbid, name }
  const [selectedResult, setSelectedResult] = useState(null); // a result card → preview
  const [libraryMap, setLibraryMap] = useState(() => new Map()); // providerId → { present, total }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  // In-library detection: providerId (release-group MBID) → { present, total },
  // refreshed when a download lands so the ✓ / repair badges update live.
  useEffect(() => {
    const load = () => musicApi.listAlbums()
      .then(albums => {
        const m = new Map();
        (albums || []).forEach(a => {
          if (a.providerId) m.set(a.providerId, { present: a.tracksPresent || 0, total: a.tracksTotal || 0 });
        });
        setLibraryMap(m);
      })
      .catch(() => {});
    load();
    window.addEventListener('music-library-changed', load);
    return () => window.removeEventListener('music-library-changed', load);
  }, []);

  // Debounced search on query/mode change (skipped while viewing a discography).
  useEffect(() => {
    if (selectedArtist) return;
    const q = query.trim();
    if (!q) { setResults(null); setArtists(null); setError(null); setLoading(false); return; }
    const myId = ++reqId.current;
    setLoading(true); setError(null);
    const t = setTimeout(async () => {
      try {
        if (mode === MODE_ALBUMS) {
          const r = await musicApi.searchReleaseGroups(q, 25, 0);
          if (myId === reqId.current) { setResults(r || []); setArtists(null); }
        } else {
          const r = await musicApi.searchArtists(q);
          if (myId === reqId.current) { setArtists(r || []); setResults(null); }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[browse] search error:', e);
        if (myId === reqId.current) setError(errText(e, 'Search failed.'));
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, mode, selectedArtist]);

  // Load a selected artist's discography.
  useEffect(() => {
    if (!selectedArtist) return;
    const myId = ++reqId.current;
    setLoading(true); setError(null); setResults(null);
    musicApi.artistReleaseGroups(selectedArtist.mbid)
      .then(r => { if (myId === reqId.current) setResults(r || []); })
      .catch(e => { if (myId === reqId.current) setError(errText(e, 'Failed to load discography.')); })
      .finally(() => { if (myId === reqId.current) setLoading(false); });
  }, [selectedArtist]);

  const switchMode = (m) => {
    if (m === mode) return;
    setMode(m);
    setSelectedArtist(null);
    setResults(null); setArtists(null); setError(null);
  };

  const onQueryChange = (v) => {
    setQuery(v);
    if (selectedArtist) setSelectedArtist(null); // typing leaves the discography view
  };

  const showArtistList = mode === MODE_ARTISTS && !selectedArtist;

  // A picked result takes over the whole page; backing out restores the grid
  // (search/discography state is untouched while the preview is mounted).
  if (selectedResult) {
    return (
      <BrowsePreview
        result={selectedResult}
        accent={accent}
        onBack={() => setSelectedResult(null)}
        libraryEntry={libraryMap.get(selectedResult.mbid) || null}
      />
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{
        padding: '14px 18px 10px',
        display: 'flex', flexDirection: 'column', gap: 10,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <FilterChip active={mode === MODE_ALBUMS} accent={accent} onClick={() => switchMode(MODE_ALBUMS)}>Albums</FilterChip>
          <FilterChip active={mode === MODE_ARTISTS} accent={accent} onClick={() => switchMode(MODE_ARTISTS)}>Artists</FilterChip>
        </div>
        <TextInput
          value={query}
          onChange={onQueryChange}
          placeholder={mode === MODE_ALBUMS ? 'Search albums on MusicBrainz…' : 'Search artists on MusicBrainz…'}
        />
        {selectedArtist && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <button
              onClick={() => setSelectedArtist(null)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 12, padding: 0,
              }}
            >← Artists</button>
            <span style={{ color: 'var(--text-faint)' }}>/</span>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{selectedArtist.name}</span>
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        {loading && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Searching…</div>
        )}
        {!loading && error && (
          <div style={{ color: '#e07b7b', fontSize: 12, textAlign: 'center', padding: 24 }}>{error}</div>
        )}
        {!loading && !error && !query.trim() && !selectedArtist && (
          <Hint mode={mode} />
        )}

        {/* Artist list */}
        {!loading && !error && showArtistList && artists && (
          artists.length === 0
            ? <Empty>No artists match.</Empty>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {artists.map(a => (
                  <ArtistRow key={a.mbid} artist={a} accent={accent}
                             onSelect={() => setSelectedArtist({ mbid: a.mbid, name: a.name })} />
                ))}
              </div>
            )
        )}

        {/* Album / discography grid */}
        {!loading && !error && (mode === MODE_ALBUMS || selectedArtist) && results && (
          results.length === 0
            ? <Empty>{selectedArtist ? 'No releases found for this artist.' : 'No albums match.'}</Empty>
            : (
              <div style={GRID}>
                {results.map(r => (
                  <BrowseResultCard key={r.mbid} result={r} accent={accent}
                                    inLibrary={libraryMap.has(r.mbid)}
                                    onSelect={() => setSelectedResult(r)} />
                ))}
              </div>
            )
        )}
      </div>
    </div>
  );
}

function Hint({ mode }) {
  return (
    <div style={{
      color: 'var(--text-faint)', fontSize: 13, textAlign: 'center',
      padding: '40px 24px', lineHeight: 1.5, maxWidth: 380, margin: '0 auto',
    }}>
      {mode === MODE_ALBUMS
        ? 'Search MusicBrainz for an album to preview and download.'
        : 'Search for an artist, then browse their discography.'}
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
      {children}
    </div>
  );
}

function ArtistRow({ artist, accent, onSelect }) {
  const [hover, setHover] = useState(false);
  const sub = [artist.disambiguation, artist.country].filter(Boolean).join(' · ');
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start',
        textAlign: 'left', width: '100%',
        padding: '10px 12px', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
        background: hover ? 'var(--surface-2)' : 'transparent',
        cursor: 'pointer', transition: 'background 120ms ease',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{artist.name}</span>
      {sub && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</span>}
    </button>
  );
}
