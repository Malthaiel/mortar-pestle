// Per-anime detail page — the adaptive resolver. A direct vault path is always
// owned and renders SeriesDetail (Play + local episodes). A MAL id resolves
// against the live library index: if it (or a franchise sibling) is owned it
// renders the owned view; otherwise it renders DiscoveryDetail (synopsis +
// Download + MAL episodes). Because useLibraryMap refreshes on
// video-library-changed, a title that finishes downloading flips this page
// from the discovery view to the owned/playable view with no navigation.

import { useEffect } from 'react';
import SeriesDetail from './SeriesDetail.jsx';
import DiscoveryDetail from './DiscoveryDetail.jsx';
import useLibraryMap from './useLibraryMap.js';

function titleFromPath(p) {
  const seg = (p || '').split('/').pop() || '';
  return seg.replace(/\.md$/, '');
}

export default function AnimeDetail({ accent, seriesPath, malId }) {
  const libMap = useLibraryMap();

  // Resolve ownership. malId arrives from the route as a string; library keys
  // are numeric MAL ids, so coerce before the lookup.
  const ownedEntry = !seriesPath && malId != null ? (libMap.get(Number(malId)) || null) : null;
  const ownedPath = seriesPath || (ownedEntry && ownedEntry.path) || null;

  useEffect(() => {
    if (!ownedPath) return;
    document.title = 'Anime · ' + titleFromPath(ownedPath);
    return () => { document.title = 'Citadel'; };
  }, [ownedPath]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {ownedPath
        ? <SeriesDetail accent={accent} seriesPath={ownedPath} />
        : <DiscoveryDetail accent={accent} malId={malId} />}
    </div>
  );
}
