// Playlists tab. With a `rest` path → the playlist detail; otherwise the grid of
// playlist cards + a "New playlist" action. Mirrors AlbumBrowser's grid feel; the
// cards use CollageCover (custom image, else 2×2 album-cover mosaic, else
// initials).

import { useState } from 'react';
import { usePlaylists } from './PlaylistProvider.jsx';
import { usePlaylistMenu } from './contextMenus.js';
import CollageCover from './CollageCover.jsx';
import PlaylistModal from './PlaylistModal.jsx';
import PlaylistDetail from './PlaylistDetail.jsx';
import { encodePath } from '../paths.js';
import { navigate } from '@host/router.js';

const GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
  gap: 12,
};

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

// Rides the shared candy tile shape (.candy-btn[data-shape="tile"]) — the same
// master CoverArtCard uses, so the album and playlist grids read identically.
// The shape owns the frame, the press depth and the hover colour flip; no
// hand-rolled border/hover state here.
export function PlaylistCard({ playlist, accent, onOpen }) {
  const playlistMenu = usePlaylistMenu(accent);
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
  };
  return (
    <div
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => playlistMenu(e, playlist)}
      role="button"
      tabIndex={0}
      className="candy-btn"
      data-shape="tile"
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face">
        <div
          style={{
            width: '100%',
            aspectRatio: '1 / 1',
            borderRadius: 6,
            overflow: 'hidden',
            background: 'var(--surface-2)',
          }}
        >
          <CollageCover image={playlist.image} urls={playlist.coverUrls} title={playlist.title} accent={accent} />
        </div>
        <div style={{ marginTop: 10, minWidth: 0 }}>
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
        </div>
      </div>
    </div>
  );
}
