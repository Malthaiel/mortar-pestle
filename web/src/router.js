import { useEffect, useState } from 'react';

export const ROUTES = [
  { path: '/pulse',                       page: 'pulse',          label: 'Pulse',           accentKey: 'pulse' },
  { path: '/vault',                       page: 'vault',          label: 'Vault View',      accentKey: 'knowledge' },
  { path: '/graph',                       page: 'graph',          label: 'Graph',           accentKey: 'knowledge' },
  { path: '/game-wiki',                   page: 'game-wiki',      label: 'Game Wiki',       accentKey: 'knowledge' },
  { path: '/tools',                       page: 'tools',          label: 'Tools',           accentKey: 'tools' },
  { path: '/docs',                        page: 'docs',           label: 'Docs',            accentKey: 'knowledge' },
];

const PARAM_ROUTES = [
  // Unified Vault View (Phase 2b). The optional /vault prefix lets legacy
  // /knowledge/* and /infrastructure/* deep-links resolve to the same page.
  { pattern: /^\/vault\/(folder)\/([^/]+)(?:\/(.*))?$/,                        page: 'vault', captures: ['type', 'sub', 'folderPath'] },
  { pattern: /^(?:\/vault)?\/(knowledge|infrastructure)\/([^/]+)(?:\/(.*))?$/, page: 'vault', captures: ['type', 'sub', 'folderPath'] },
  { pattern: /^(?:\/vault)?\/(knowledge|infrastructure)$/,                     page: 'vault', captures: ['type'] },
  // Game Wiki — read-only multi-game reference reader (separate GameWiki vault).
  { pattern: /^\/game-wiki\/(.+)$/,                page: 'game-wiki',      captures: ['rest'] },
  { pattern: /^\/tools\/([^/]+)(?:\/(.*))?$/,          page: 'tools',          captures: ['sub', 'rest'] },
  { pattern: /^\/pulse\/([^/]+)$/,                 page: 'pulse',          captures: ['sub'] },
  { pattern: /^\/docs\/([^/]+)(?:\/(.+))?$/,       page: 'docs',           captures: ['sub', 'rest'] },
  { pattern: /^\/page\/(.+)$/,                     page: 'page',           captures: ['sub'] },
];

function pageAccentKey(sub) {
  if (!sub) return null;
  const top = sub.split('/')[0];
  if (top === 'Knowledge')       return 'knowledge';
  if (top === 'Infrastructure')  return 'infrastructure';
  if (top === 'Pulse')           return 'pulse';
  if (top === 'Projects')        return 'pulse';
  return 'knowledge';
}

function readHash() {
  const h = window.location.hash || '';
  return h.startsWith('#') ? h.slice(1) : h;
}

function matchRoute(path) {
  if (!path || path === '/') return { path, page: null };
  // Legacy alias: the standalone Releases page folded into Docs as a reserved
  // sub. Keeps #/releases deep-links + the Ship Release flow landing on the tab.
  if (path === '/releases') path = '/docs/releases';
  const exact = ROUTES.find(r => r.path === path);
  if (exact) return { ...exact };
  for (const pr of PARAM_ROUTES) {
    const m = path.match(pr.pattern);
    if (!m) continue;
    const out = { path, page: pr.page };
    pr.captures.forEach((name, idx) => {
      const raw = m[idx + 1];
      out[name] = raw ? decodeURIComponent(raw) : (name === 'folderPath' || name === 'rest' ? '' : null);
    });
    return out;
  }
  return { path, page: null };
}

export function useHashRoute() {
  const [path, setPath] = useState(() => readHash());

  useEffect(() => {
    const handler = () => setPath(readHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const route = matchRoute(path);
  const pageRoute = ROUTES.find(r => r.page === route.page);
  let accentKey = pageRoute?.accentKey || 'pulse';
  let label = pageRoute?.label || '';
  if (route.page === 'page') {
    accentKey = pageAccentKey(route.sub) || accentKey;
    label = 'Page';
  }
  return {
    path,
    page: route.page,
    type: route.type || null,
    sub: route.sub || null,
    folderPath: route.folderPath || '',
    rest: route.rest || '',
    label,
    accentKey,
  };
}

export function navigate(path) {
  window.location.hash = path;
}
