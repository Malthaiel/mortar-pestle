// Fetches page counts grouped by top-level folder (Knowledge / Pulse /
// Infrastructure / Iskariel / …) once at mount. Backs the sidebar's
// width-aware pill subtitle that fades in at rail widths above 340px.
//
// Counts come from /api/manifest/counts which reads the in-memory vault
// manifest; if the manifest hasn't loaded yet (briefly after server start
// or a rebuild), the endpoint returns an empty object and we leave the
// state empty — subtitles simply won't render until the next mount.

import { useEffect, useState } from 'react';
import { api } from '../api.js';

export function useRootCounts() {
  const [counts, setCounts] = useState({});
  useEffect(() => {
    let cancelled = false;
    api.getRootCounts()
      .then(r => { if (!cancelled) setCounts(r.counts || {}); })
      .catch(() => { /* leave empty */ });
    return () => { cancelled = true; };
  }, []);
  return counts;
}
