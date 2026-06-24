// Vault manifest reader. Loads Infrastructure/.cache/vault_manifest.json
// via the `vault_read_file` Tauri command and caches the parsed result in
// module scope. Modules call `useManifestData()` to access the page list
// for stat derivations (Watched videos, total .md, orphan count, etc).
//
// In-session updates: the Rust vault commands patch the manifest after an
// in-app *.md write/delete/rename (commands/manifest_gen.rs), and external
// rebuilds (Citadel's SessionStart hook) rewrite it wholesale — either way
// the vault watcher emits a `manifest` event, which invalidates this cache
// and re-fetches, pushing the fresh data to every mounted consumer.

import { useEffect, useState } from 'react';
import { invoke, subscribeEvents } from '../api.js';

const MANIFEST_PATH = 'Infrastructure/.cache/vault_manifest.json';

let _cache = null;
let _loadPromise = null;
const _subs = new Set();
let _watching = false;

async function loadManifest() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const result = await invoke('vault_read_file', { path: MANIFEST_PATH });
      const text = typeof result === 'string' ? result : result?.content;
      if (!text) throw new Error('Empty manifest response');
      _cache = JSON.parse(text);
      return _cache;
    } finally {
      _loadPromise = null;
    }
  })();
  return _loadPromise;
}

function ensureWatcher() {
  if (_watching) return;
  _watching = true;
  subscribeEvents((name) => {
    if (name !== 'manifest') return;
    _cache = null; // invalidate; the re-fetch below repopulates
    loadManifest()
      .then((d) => { for (const fn of _subs) fn(d); })
      .catch((err) => console.error('[manifestReader] refresh failed', err));
  });
}

export function useManifestData() {
  const [data, setData] = useState(_cache);
  useEffect(() => {
    ensureWatcher();
    _subs.add(setData);
    let cancelled = false;
    if (!_cache) {
      loadManifest()
        .then((d) => { if (!cancelled) setData(d); })
        .catch((err) => { if (!cancelled) console.error('[manifestReader] failed to load', err); });
    }
    return () => { cancelled = true; _subs.delete(setData); };
  }, []);
  return data;
}

export function getManifestSync() {
  return _cache;
}
