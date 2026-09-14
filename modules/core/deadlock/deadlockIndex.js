// Module-wide cached flat index of the Deadlock vault: basename(lower) → full
// deadlock-relative path (no .md). Powers short-form wikilink resolution in the
// read-only reader — full-path links (`[[Fact/Heroes/Abrams]]`, ~96% of
// links) resolve directly; short-form/date links (`[[Abrams]]`, `[[2026-04-30]]`)
// need this basename map. Built once via a recursive vault_get_folder walk of the
// deadlock root (one-level disk scans, manifest-independent), cached as a promise.

import { api } from '@host/api.js';

let _promise = null;

async function build() {
  const byBase = new Map();
  async function walk(fp) {
    const [slug, ...rest] = fp ? fp.split('/') : [''];
    let res;
    try {
      res = await api.getVaultFolder(slug || '', rest.join('/'), 'deadlock');
    } catch {
      return;
    }
    for (const p of res?.pages || []) {
      const full = (p.path || '').replace(/^\/+/, '').replace(/\.md$/, '');
      if (!full) continue;
      const base = full.split('/').pop().toLowerCase();
      if (!byBase.has(base)) byBase.set(base, full); // first wins (deterministic)
    }
    await Promise.all((res?.subfolders || []).map((sf) => walk(fp ? `${fp}/${sf.name}` : sf.name)));
  }
  await walk('');
  return { byBase };
}

// Lazily build (and cache) the index. Safe to call repeatedly.
export function getDeadlockIndex() {
  if (!_promise) _promise = build().catch(() => ({ byBase: new Map() }));
  return _promise;
}

// Resolve a wikilink target (already stripped of #anchor and |display) to a full
// deadlock-relative path, or null. Full-path targets pass through unchanged;
// short-forms resolve by basename via the index.
export function resolveTarget(target, index) {
  const t = (target || '').replace(/\.md$/, '').trim();
  if (!t) return null;
  if (t.includes('/')) return t;
  return index?.byBase?.get(t.toLowerCase()) || null;
}
