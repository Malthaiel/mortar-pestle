import { videoApi } from './api.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';

// Split out of SeriesBrowser.jsx so that file exports components only and
// keeps React Fast Refresh (same reason useAddToPlaylistMenu left
// AddToPlaylistButton).
// Right-click menu for a series tile. Two rows: Uninstall (the videos go, the
// show stays) and Remove from Library (the card goes, the videos stay).
// Exported so AnimeHome's ContinueCard shares one implementation.
//
// Anime only: `anime_uninstall` also clears the title's torrents and cover, so
// pointing it at a TV card would be a guess. Other domains get no menu until
// they have a remover of their own — returning null so the caller can leave
// onContextMenu unbound rather than opening a menu that does nothing.
export function useSeriesMenu(accent, domain = 'Anime') {
  const { openContextMenu } = useContextMenu();
  // keepCard = Uninstall: the videos go to the recycling bin, the show stays in the
  // library (user-directed 2026-09-29). Otherwise the card goes, the videos stay.
  const uninstall = async (series, keepCard) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(keepCard
      ? `Uninstall “${series.title}”? Its videos go to the recycling bin; the show stays in your library.`
      : `Remove “${series.title}” from your library? Downloaded videos are kept on disk. The card goes to the recycling bin.`
    )) return;
    try {
      const rep = await videoApi.seriesUninstall(series.path, keepCard, keepCard);
      window.dispatchEvent(new CustomEvent('video-library-changed', { detail: {} }));
      // eslint-disable-next-line no-alert
      if (rep && !rep.ok) window.alert((rep.warnings || [])[0] || (keepCard ? 'Could not remove the videos.' : 'Could not remove the library card.'));
    } catch (err) {
      // eslint-disable-next-line no-alert
      window.alert(`Remove failed: ${err?.message || err}`);
    }
  };
  return (e, series) => openContextMenu(e, [
    { label: 'Uninstall', danger: true, onClick: () => uninstall(series, true) },
    { label: 'Remove from Library', danger: true, onClick: () => uninstall(series, false) },
  ], { accent, header: series.title });
}
