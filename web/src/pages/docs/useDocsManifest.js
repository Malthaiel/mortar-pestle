// Shared, module-cached docs manifest fetch. Both DocsPage (flatten / prev-next
// / body resolution) and DocsNav (the sidebar tree) consume this, so only one
// `docs_get_manifest` IPC call fires per session. The manifest is static for
// the session, so a module-level cache is safe and dedupes concurrent callers.

import { useEffect, useState } from 'react';
import { api } from '../../api.js';

let _cache = null;
let _inflight = null;

function load() {
  if (_cache) return Promise.resolve(_cache);
  if (!_inflight) {
    _inflight = api.docs.getManifest()
      .then(m => { _cache = m; _inflight = null; return m; })
      .catch(e => { _inflight = null; throw e; });
  }
  return _inflight;
}

export function useDocsManifest() {
  const [manifest, setManifest] = useState(_cache);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (_cache) { setManifest(_cache); return; }
    let alive = true;
    load()
      .then(m => { if (alive) setManifest(m); })
      .catch(e => { if (alive) setError(e.message || String(e)); });
    return () => { alive = false; };
  }, []);

  return { manifest, error };
}
