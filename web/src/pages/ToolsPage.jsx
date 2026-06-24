import { useEffect, useRef } from 'react';
import { useRouteSlots } from '../module-sdk/useModuleRegistry.js';

function replaceHash(newHash) {
  const base = window.location.href.split('#')[0];
  window.history.replaceState(null, '', base + '#' + newHash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// Dispatcher for /tools/<sub>/... routes. Each tool registers its own route
// slot via the Module SDK; this component just matches and renders. Bare
// /tools (no sub) redirects to /tools/library as a starting point.
export default function ToolsPage({ accent, sub, rest }) {
  const redirectedRef = useRef(false);
  const routeSlots = useRouteSlots();

  useEffect(() => {
    if (sub) { redirectedRef.current = false; return; }
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    replaceHash('/tools/library');
  }, [sub]);

  if (!sub) return null;

  const fullPath = '/tools/' + sub + (rest ? '/' + rest : '');
  for (const slot of routeSlots) {
    const params = slot.match(fullPath);
    if (params) return slot.render({ route: fullPath, params, accent });
  }
  return null;
}
