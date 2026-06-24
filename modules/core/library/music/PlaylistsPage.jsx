// Playlists tab. With a `rest` path → the playlist detail; otherwise the grid of
// playlist cards + a "New playlist" action. Mirrors AlbumBrowser's grid feel; the
// cards use CollageCover (custom image, else 2×2 album-cover mosaic, else
// initials).

import { useState } from 'react';
import { usePlaylists } from './PlaylistProvider.jsx';
import CollageCover from './CollageCover.jsx';
import PlaylistModal from './PlaylistModal.jsx';
import PlaylistDetail from './PlaylistDetail.jsx';

const GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
  gap: 12,
};

function navigate(path) {
  window.location.hash = path;
}
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

export default function PlaylistsPage({ accent, rest }) {
  if (rest) return <PlaylistDetail path={rest} accent={accent} />;
  return <PlaylistGrid accent={accent} />;
}

function PlaylistGrid({ accent }) {
  const { playlists, createPlaylist } = usePlaylists();
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onCreate = async ({ title, coverFile }) => {
    setBusy(true);
    setError(null);
    try {
      const pl = await createPlaylist(title, [], coverFile);
      setModal(false);
      navigate('/tools/library/music/playlists/' + encodePath(pl.path));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '14px 18px 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Playlists</div>
        <button
          className="candy-btn is-primary"
          data-own-press
          onClick={() => setModal(true)}
          style={{ height: 32, ...(accent ? { '--accent': accent } : {}) }}
        >
          <span className="candy-face" style={{ padding: '0 14px' }}>+ New playlist</span>
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        {playlists.length === 0 ? (
          <div
            style={{
              color: 'var(--text-faint)',
              fontSize: 13,
              textAlign: 'center',
              padding: '48px 24px',
              lineHeight: 1.5,
              maxWidth: 380,
              margin: '0 auto',
            }}
          >
            No playlists yet. Create one here, or hit <b>+ Playlist</b> on any track in the Downloaded tab.
          </div>
        ) : (
          <div style={GRID}>
            {playlists.map((p) => (
              <PlaylistCard
                key={p.path}
                playlist={p}
                accent={accent}
                onOpen={() => navigate('/tools/library/music/playlists/' + encodePath(p.path))}
              />
            ))}
          </div>
        )}
      </div>

      <PlaylistModal
        open={modal}
        mode="create"
        accent={accent}
        onSubmit={onCreate}
        onClose={() => {
          if (!busy) {
            setModal(false);
            setError(null);
          }
        }}
        busy={busy}
        error={error}
      />
    </div>
  );
}

function PlaylistCard({ playlist, accent, onOpen }) {
  const [hover, setHover] = useState(false);
  const count = playlist.trackCount || 0;
  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        textAlign: 'left',
        padding: 8,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        background: hover ? 'var(--surface-2)' : 'transparent',
        cursor: 'pointer',
        transition: 'background 120ms ease',
      }}
    >
      <div
        style={{
          width: '100%',
          aspectRatio: '1 / 1',
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
          background: 'var(--surface-2)',
        }}
      >
        <CollageCover image={playlist.image} urls={playlist.coverUrls} title={playlist.title} accent={accent} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {playlist.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {count} track{count === 1 ? '' : 's'}
        </div>
      </div>
    </button>
  );
}
