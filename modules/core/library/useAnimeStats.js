// Shared series-library stats — one fetch + one event subscription per media
// domain, feeding BOTH the Library sidebar tree (the status-count rows) and that
// domain's topbar. A module-level store (useSyncExternalStore) dedupes:
// whichever surface mounts first starts the fetch; every subscriber re-renders on
// updates. Lifted out of the retired AnimeTopBar so the two subtrees (sidebar in
// renderSecondary, topbar in AnimePage) can never disagree on counts.
//
// One store per domain, built by the same factory: Anime, TV Shows and Movies
// read the same Rust command with a different catalog, so a copy of this file
// would only be a second place to fix the same bug.

import { useSyncExternalStore } from 'react';
import { videoApi } from './api.js';

// Franchise rows carry an integer watched count; non-franchise rows an array.
function watchedCount(s) {
  return typeof s.watchedEpisodes === 'number' ? s.watchedEpisodes : (s.watchedEpisodes || []).length;
}

function makeSeriesStats(domain) {
  let _series = null;            // null = loading
  const _listeners = new Set();
  let _started = false;

  function emit() { for (const l of _listeners) l(); }
  function setSeries(next) { _series = next; emit(); }
  function load() { videoApi.listSeries(domain).then((l) => setSeries(l || [])).catch(() => setSeries([])); }
  function onLocal(e) {
    const d = e.detail || {};
    if (!d.path || _series == null) return;
    // The event is global; a path belonging to the other domain matches nothing.
    setSeries(_series.map((s) => (s.path === d.path ? { ...s, ...d } : s)));
  }
  function start() {
    if (_started) return;
    _started = true;
    load();
    window.addEventListener('video-library-changed', load);
    window.addEventListener('series-updated', onLocal);
  }
  function subscribe(cb) { start(); _listeners.add(cb); return () => { _listeners.delete(cb); }; }
  function getSnapshot() { return _series; }

  // Series snapshot (null while loading) + the derived counts each topbar used
  // to compute locally. Derivation is cheap and runs per render; a store only
  // re-renders its own subscribers, and only when its list ref changes.
  return function useSeriesStats() {
    const series = useSyncExternalStore(subscribe, getSnapshot);
    const list = series || [];
    const byStatus = {};
    let episodes = 0, rewatched = 0, downloaded = 0;
    for (const s of list) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      episodes += watchedCount(s);
      rewatched += s.reWatches || 0;
      if (s.hasLocalFiles) downloaded++;
    }
    return { series, loading: series === null, byStatus, total: list.length, episodes, rewatched, downloaded };
  };
}

export const useAnimeStats = makeSeriesStats('Anime');
export const useTvStats = makeSeriesStats('TV Shows');
// A film card carries no episode table, so `episodes` and `rewatched` come out
// 0 for this store — the Movies topbar reads `total` and `downloaded` instead.
export const useMovieStats = makeSeriesStats('Movies');
