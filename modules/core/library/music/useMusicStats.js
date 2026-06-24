// Shared music-library stats — the useAnimeStats analog. One listAlbums fetch +
// one event subscription, module-level, feeding BOTH the Library sidebar tree
// (status-count rows) and the slimmed MusicTopBar (Tracks / Artists). Lifted out
// of MusicTopBar so the sidebar and topbar subtrees agree on counts.

import { useSyncExternalStore } from 'react';
import { musicApi } from './api.js';

let _albums = null;            // null = loading
const _listeners = new Set();
let _started = false;

function emit() { for (const l of _listeners) l(); }
function setAlbums(next) { _albums = next; emit(); }
function load() { musicApi.listAlbums().then((l) => setAlbums(l || [])).catch(() => setAlbums([])); }
function onLocal(e) {
  const d = e.detail || {};
  if (!d.path || _albums == null) return;
  setAlbums(_albums.map((a) => (a.path === d.path ? { ...a, ...d } : a)));
}
function start() {
  if (_started) return;
  _started = true;
  load();
  window.addEventListener('music-library-changed', load);
  window.addEventListener('album-updated', onLocal);
}
function subscribe(cb) { start(); _listeners.add(cb); return () => { _listeners.delete(cb); }; }
function getSnapshot() { return _albums; }

// Owned tracks per album: prefer the downloaded/total count, fall back to the
// frontmatter Track Count (which serde may hand over as a number or a string).
function trackCount(a) {
  if (typeof a.tracksTotal === 'number' && a.tracksTotal > 0) return a.tracksTotal;
  const n = typeof a.trackCount === 'number' ? a.trackCount : parseInt(a.trackCount, 10);
  return Number.isFinite(n) ? n : 0;
}

export function useMusicStats() {
  const albums = useSyncExternalStore(subscribe, getSnapshot);
  const list = albums || [];
  const byStatus = {};
  let tracks = 0, downloaded = 0;
  const artists = new Set();
  for (const a of list) {
    if (a.status) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    tracks += trackCount(a);
    if (a.artist) artists.add(a.artist);
    if ((a.tracksPresent || 0) > 0) downloaded++;
  }
  return { albums, loading: albums === null, byStatus, total: list.length, tracks, artists: artists.size, downloaded };
}
