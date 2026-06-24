// Full-page music library grid — owned albums as cover cards, optionally filtered
// to a single listen status by the persistent MusicTopBar
// (/tools/library/music/library/<status>). The anime tab's AnimeLibrary analog;
// section navigation is owned by the topbar, so this is just the grid + heading.

import { useEffect, useMemo, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';

const go = (hash) => { window.location.hash = hash; };
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

const STATUS_LABEL = {
  'Currently-Listening': 'Listening',
  'Listened':            'Listened',
  'Plan-to-Listen':      'Plan to Listen',
  'Dropped':             'Dropped',
  'Downloaded':          'Downloaded',
  'Not-Downloaded':      'Not Downloaded',
};

export default function MusicLibrary({ accent, status = null }) {
  const { playAlbumTracks } = useMusicPlayer();
  const [albums, setAlbums] = useState(null);   // null = loading

  useEffect(() => {
    let cancelled = false;
    const load = () => musicApi.listAlbums()
      .then(l => { if (!cancelled) setAlbums(l || []); })
      .catch(() => { if (!cancelled) setAlbums([]); });
    load();
    window.addEventListener('music-library-changed', load);
    return () => { cancelled = true; window.removeEventListener('music-library-changed', load); };
  }, []);

  const items = useMemo(() => {
    let list = [...(albums || [])];
    // Ownership pseudo-statuses (topbar tiles) filter on file presence; real
    // status values filter on frontmatter Status.
    if (status === 'Downloaded') list = list.filter(a => (a.tracksPresent || 0) > 0);
    else if (status === 'Not-Downloaded') list = list.filter(a => !((a.tracksPresent || 0) > 0));
    else if (status) list = list.filter(a => a.status === status);
    return list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  }, [albums, status]);

  const onSelect = (path) => go('/tools/library/music/downloaded/' + encodePath(path));
  const onPlay = async (album) => {
    try { const detail = await musicApi.readAlbum(album.path); playAlbumTracks(detail, 0); } catch { /* ignore */ }
  };

  const heading = status ? (STATUS_LABEL[status] || status) : 'All Albums';

  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      padding: '20px 22px 40px',
      display: 'flex', flexDirection: 'column', gap: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{heading}</span>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: '0.04em' }}>
          {albums === null ? '—' : `${items.length} album${items.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {albums === null ? (
        <Muted>Loading your library…</Muted>
      ) : items.length === 0 ? (
        <Muted>{
          status === 'Downloaded' ? 'No downloaded albums yet.'
          : status === 'Not-Downloaded' ? 'Every album in your library is downloaded.'
          : status ? `No albums marked “${heading}”.`
          : 'No albums yet — download some from Browse.'
        }</Muted>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
          {items.map(a => (
            <CoverArtCard key={a.path} album={a} accent={accent} selected={false} onSelect={onSelect} onPlay={onPlay} />
          ))}
        </div>
      )}
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: '4px 0' }}>{children}</div>;
}
