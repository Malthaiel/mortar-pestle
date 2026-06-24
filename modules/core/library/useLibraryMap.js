// In-library detection index: MAL id → { total, downloadStatus, path, title }.
// Franchise siblings (relatedIds) all map to the same anchor entry, so any
// member of a franchise reads as in-library. Extracted from AnimeBrowse so the
// homepage, see-all grids, and the adaptive detail page share one definition.

import { useEffect, useState } from 'react';
import { videoApi } from './api.js';

// Pure builder — usable directly when the caller already holds the series list
// (the homepage fetches listSeries once and derives both Continue Watching and
// this index from it, avoiding a second round-trip).
export function buildLibraryIndex(list) {
  const m = new Map();
  (list || []).forEach(s => {
    const entry = {
      total: s.episodesTotal || 0,
      downloadStatus: s.downloadStatus || null,
      path: s.path,
      title: s.title,
    };
    if (s.providerId) m.set(s.providerId, entry);
    (s.relatedIds || []).forEach(id => { if (!m.has(id)) m.set(id, entry); });
  });
  return m;
}

// Hook form: fetches its own list and refreshes when a download lands.
export default function useLibraryMap() {
  const [map, setMap] = useState(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const load = () => videoApi.listSeries()
      .then(list => { if (!cancelled) setMap(buildLibraryIndex(list)); })
      .catch(() => {});
    load();
    window.addEventListener('video-library-changed', load);
    return () => { cancelled = true; window.removeEventListener('video-library-changed', load); };
  }, []);
  return map;
}
