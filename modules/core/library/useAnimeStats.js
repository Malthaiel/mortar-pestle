// Shared anime-library stats — one fetch + one event subscription feeding BOTH
// the Library sidebar tree (the status-count rows) and the slimmed AnimeTopBar
// (Rewatched / Episodes). A module-level store (useSyncExternalStore) dedupes:
// whichever surface mounts first starts the fetch; every subscriber re-renders on
// updates. Lifted out of AnimeTopBar so the two subtrees (sidebar in
// renderSecondary, topbar in AnimePage) can never disagree on counts.

import { useSyncExternalStore } from 'react';
import { videoApi } from './api.js';

let _series = null;            // null = loading
const _listeners = new Set();
let _started = false;

function emit() { for (const l of _listeners) l(); }
function setSeries(next) { _series = next; emit(); }
function load() { videoApi.listSeries().then((l) => setSeries(l || [])).catch(() => setSeries([])); }
function onLocal(e) {
  const d = e.detail || {};
  if (!d.path || _series == null) return;
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

// Franchise rows carry an integer watched count; non-franchise rows an array.
function watchedCount(s) {
  return typeof s.watchedEpisodes === 'number' ? s.watchedEpisodes : (s.watchedEpisodes || []).length;
}

// Series snapshot (null while loading) + the derived counts AnimeTopBar used to
// compute locally. Derivation is cheap and runs per render; the store only
// re-renders subscribers when the list ref actually changes.
export function useAnimeStats() {
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
}
