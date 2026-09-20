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
import { TILE_GRID } from './util.js';
import { encodePath } from '../paths.js';
import { navigate } from '@host/router.js';

const GRID = TILE_GRID;   // the module-wide cover-tile grid (util.js)

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

      {/* Bottom padding clears the last tile row's press-depth band (util.js § TILE_GRID). */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: 18, paddingBottom: 'calc(18px + var(--candy-tile-depth))',
      }}>
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
// `pinned` marks a card that must not be picked up inside a Cluster —
// data-no-drag is DraggableSidebarList's own per-item opt-out, honoured even
// under dragFromInteractive. Nothing else about the card changes.
export function PlaylistCard({ playlist, accent, onOpen, pinned = false }) {
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
      {...(pinned ? { 'data-no-drag': '' } : {})}
      // Straight from PlaylistsPage this is a grid item and stretches, but in
      // the left panel's Cluster it sits inside the drag wrapper — a plain
      // block — so nothing stretches it and its width falls back to the cover
      // image's intrinsic size. A playlist whose cover does not load then has
      // NO intrinsic content, and the whole card collapsed to a 24px dot
      // (Macroblank, 2026-09-10). Claiming the width makes the cell, not the
      // artwork, decide how big the tile is.
      style={{ width: '100%', '--accent': accent || 'var(--accent)' }}
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
      </div>
    </div>
  );
}
