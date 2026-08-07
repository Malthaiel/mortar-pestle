// Right-click menus for the saved-item tiles. Album tiles live in three grids
// (home, browser, credits) and playlist tiles in two (home, playlists page), so
// the confirm text + delete call sit here once instead of once per surface.
//
// Both reuse the app-wide useContextMenu() hook and the same window.confirm
// wording the detail pages already use (AlbumDetail.onDelete /
// PlaylistDetail.onDelete) — deleting from a tile and from the page read alike.

import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { musicApi } from './api.js';
import { usePlaylists } from './PlaylistProvider.jsx';

function fail(what, err) {
  // eslint-disable-next-line no-alert
  window.alert(`${what} failed: ${err?.message || err}`);
}

// (e, album) => open a one-row menu. Returns the handler for onContextMenu.
export function useAlbumMenu(accent) {
  const { openContextMenu } = useContextMenu();
  return (e, album) => openContextMenu(e, [{
    label: 'Delete album…',
    danger: true,
    onClick: async () => {
      // eslint-disable-next-line no-alert
      if (!window.confirm(
        `Delete album “${album.title}”? Its card and audio tracks go to the recycling bin — ` +
        `restorable until it's purged. Playlist entries for these tracks show unavailable until you restore.`
      )) return;
      try {
        await musicApi.deleteAlbum(album.path);
        window.dispatchEvent(new CustomEvent('music-library-changed'));
      } catch (err) { fail('Delete', err); }
    },
  }], { accent, header: album.title });
}

// (e, playlist) => same shape for playlist tiles.
export function usePlaylistMenu(accent) {
  const { openContextMenu } = useContextMenu();
  const { deletePlaylist } = usePlaylists();
  return (e, playlist) => openContextMenu(e, [{
    label: 'Delete playlist…',
    danger: true,
    onClick: async () => {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Delete playlist “${playlist.title}”? It'll go to the recycling bin — your tracks are kept.`)) return;
      try { await deletePlaylist(playlist); } catch (err) { fail('Delete', err); }
    },
  }], { accent, header: playlist.title });
}
