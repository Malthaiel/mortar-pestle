// Right-click menus for the saved-item tiles. Album tiles live in three grids
// (home, browser, credits) and playlist tiles in two (home, playlists page), so
// the confirm text + delete call sit here once instead of once per surface.
//
// Both reuse the app-wide useContextMenu() hook and the same window.confirm
// wording the detail pages already use (AlbumDetail.onDelete /
// PlaylistDetail.onDelete) — deleting from a tile and from the page read alike.

import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { musicApi } from './api.js';
import { usePlaylists, isSavedTracks, refFromQueueItem, SAVED_TITLE } from './PlaylistProvider.jsx';
import { useDownloads } from './DownloadProvider.jsx';
import { useAddToPlaylistMenu } from './useAddToPlaylistMenu.jsx';

function fail(what, err) {
  // eslint-disable-next-line no-alert
  window.alert(`${what} failed: ${err?.message || err}`);
}

// (e, album) => open a one-row menu. Returns the handler for onContextMenu.
export function useAlbumMenu(accent) {
  const { openContextMenu } = useContextMenu();
  return (e, album) => openContextMenu(e, [{
    label: 'Delete album',
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

// The one right-click menu every song surface shares: Save/Unsave (always),
// Download (only when the file isn't already on disk), Add to playlist (the
// existing add-menu's own rows, nested), plus whatever the surface adds.
//
// `song` is a player queue item (`{ title, artist, n, available, watchUrl,
// albumPath, albumTitle, albumImage, audioPath, wikilink, duration }`) with an
// optional `rgMbid` — that pair is what routes Download to an album-track job
// instead of a loose single. Render the returned `modalEl` (the New-playlist
// modal) wherever the menu is used.
export function useSongMenu(accent) {
  const { openContextMenu } = useContextMenu();
  const { isSaved, toggleSaved } = usePlaylists();
  const { enqueue } = useDownloads();
  const { buildItems, modalEl } = useAddToPlaylistMenu(accent);

  const download = async (song) => {
    let rgMbid = song.rgMbid || '';
    // A row that knows only its album card (playlist / queue) still belongs on
    // the album-track path — its release-group id is one card read away, and
    // only on click. A miss (or a row whose "album" is really a playlist) falls
    // through to the loose-single path.
    if (!rgMbid && song.n && song.albumPath) {
      try {
        rgMbid = (await musicApi.readAlbum(song.albumPath))?.providerId || '';
      } catch { /* not an album card — treat as loose */ }
    }
    try {
      await (rgMbid && song.n
        ? enqueue({
            rgMbid, trackN: song.n,
            title: song.albumTitle || song.title, artist: song.artist,
            cover: song.albumImage || null,
          })
        : enqueue({ title: song.title, artist: song.artist, watchUrl: song.watchUrl || null }));
    } catch (err) { fail('Download', err); }
  };

  const openMenu = (e, song, extra = []) => {
    e.stopPropagation();
    e.preventDefault();
    const ref = refFromQueueItem(song);
    const saved = isSaved(ref);
    const items = [
      {
        label: saved ? `Remove from ${SAVED_TITLE}` : `Save to ${SAVED_TITLE}`,
        onClick: () => toggleSaved(ref).catch((err) => fail('Save', err)),
      },
      { label: 'Add to playlist', children: buildItems([ref]) },
    ];
    // A song already on disk gets no Download row at all — not greyed, not
    // "Re-download".
    if (!song.available) items.push({ label: 'Download', onClick: () => download(song) });
    if (extra.length) items.push({ divider: true }, ...extra);
    openContextMenu({ x: e.clientX, y: e.clientY }, items, { accent, header: song.title });
  };

  return { openMenu, modalEl };
}

// (e, playlist) => same shape for playlist tiles.
export function usePlaylistMenu(accent) {
  const { openContextMenu } = useContextMenu();
  const { deletePlaylist } = usePlaylists();
  // Saved Tracks is app-owned: no Delete row at all, just a dead row so the
  // right-click isn't swallowed (the same shape defaultMenus uses).
  return (e, playlist) => openContextMenu(e, isSavedTracks(playlist) ? [{
    label: 'Saved Tracks can’t be deleted',
    disabled: true,
  }] : [{
    label: 'Delete playlist',
    danger: true,
    onClick: async () => {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Delete playlist “${playlist.title}”? It'll go to the recycling bin — your tracks are kept.`)) return;
      try { await deletePlaylist(playlist); } catch (err) { fail('Delete', err); }
    },
  }], { accent, header: playlist.title });
}
