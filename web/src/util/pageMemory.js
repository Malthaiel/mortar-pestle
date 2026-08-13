// App-wide page memory — which page you were last on, globally and per module.
//
// Two consumers, both in hooks/useActiveModule.jsx (it already owns the route +
// manifest reconciliation, so nothing else needs to know this exists):
//   - boot: an empty hash lands on the page you left, not on nothing
//   - dock: clicking a module's button returns to where you were inside it,
//           instead of resetting to its routeBase
//
// localStorage, same reasoning as scrollMemory.js: it has to survive a webview
// reload and an app restart, and it is a handful of short strings.

const PREFIX = 'page-memory:';

function read(k) {
  try { return localStorage.getItem(PREFIX + k) || null; } catch { return null; }
}

export function recordRoute(path, moduleKey) {
  if (!path || path === '/') return;
  try {
    localStorage.setItem(PREFIX + 'last', path);
    if (moduleKey) localStorage.setItem(PREFIX + 'mod:' + moduleKey, path);
  } catch { /* private mode / quota */ }
}

export function lastRoute() { return read('last'); }

export function lastRouteFor(moduleKey) { return moduleKey ? read('mod:' + moduleKey) : null; }

// Which module a path belongs to. Longest matching routeBase wins (/tools/library
// beats /tools). Anything with no module — Docs, Tools' own landing, /page/* —
// falls back to its first path segment, so those surfaces get the same memory.
export function moduleKeyFor(path, routeBases) {
  let best = '';
  for (const base of routeBases) {
    if (typeof base !== 'string') continue;
    if (path === base || path.startsWith(base + '/')) {
      if (base.length > best.length) best = base;
    }
  }
  return best || '/' + String(path).replace(/^\//, '').split('/')[0];
}
