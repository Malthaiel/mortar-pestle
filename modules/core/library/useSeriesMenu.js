import { videoApi } from './api.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';

// Split out of SeriesBrowser.jsx so that file exports components only and
// keeps React Fast Refresh (same reason useAddToPlaylistMenu left
// AddToPlaylistButton).
// Right-click menu for a series tile. Two rows because anime_uninstall's
// delete_files flag is the only real choice the detail page's confirm dialog
// offers — exposing both here avoids lifting that dialog out of SeriesDetail.
// Exported so AnimeHome's ContinueCard shares one implementation.
//
// Anime only: `anime_uninstall` also clears the title's torrents and cover, so
// pointing it at a TV card would be a guess. Other domains get no menu until
// they have a remover of their own — returning null so the caller can leave
// onContextMenu unbound rather than opening a menu that does nothing.
export function useSeriesMenu(accent, domain = 'Anime') {
  const { openContextMenu } = useContextMenu();
  const uninstall = async (series, deleteFiles) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `Remove “${series.title}” from your library?` +
      (deleteFiles ? ' Its video files are deleted too.' : ' Downloaded video files are kept on disk.') +
      ' The card goes to the recycling bin.'
    )) return;
    try {
      const rep = await videoApi.seriesUninstall(series.path, deleteFiles);
      window.dispatchEvent(new CustomEvent('video-library-changed', { detail: {} }));
      // eslint-disable-next-line no-alert
      if (rep && !rep.ok) window.alert((rep.warnings || [])[0] || 'Could not remove the library card.');
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`Remove failed: ${err?.message || err}`);
    }
  };
  return (e, series) => openContextMenu(e, [
    { label: 'Remove from Library', danger: true, onClick: () => uninstall(series, false) },
    { label: 'Remove + Delete Files', danger: true, onClick: () => uninstall(series, true) },
  ], { accent, header: series.title });
}
