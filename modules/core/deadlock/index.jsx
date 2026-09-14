// Deadlock module — a top-level dock surface that browses the read-only, app-managed
// Deadlock vault (game reference knowledge as top-level tree nodes).
// Mirrors the Vault module's shape (sidebar pill + tree + route) but
// points at the `deadlock` mounted root and renders pages read-only, client-side
// (DeadlockPage), keeping wikilink navigation inside the module.

import { lazy, Suspense } from 'react';
import DeadlockRail from './DeadlockRail.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import { safeDecode } from '@host/router.js';
import './deadlock.css';

// react-markdown (+ remark-gfm, ~100KB) is only needed once a page is actually
// viewed — lazy-split it off the boot chunk (mirrors web/src/pages/GraphPage.jsx's
// pixi.js split). DeadlockTree stays eager (light secondary-sidebar tree).
const DeadlockPage = lazy(() => import('./DeadlockPage.jsx'));

// /deadlock → reader landing; /deadlock/<deadlock-relative path> → that page.
function matchDeadlock(path) {
  if (path === '/deadlock') return { rest: '' };
  const m = path.match(/^\/deadlock\/(.+)$/);
  if (!m) return false;
  return { rest: safeDecode(m[1]) };
}

export default {
  register(api) {
    const { IconGamepad } = api.ui.icons;

    api.slots.registerLeftSidebar({
      id: 'deadlock',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconGamepad}
          label="Deadlock"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/deadlock')}
        />
      ),
      isActive: (route) => route.page === 'deadlock',
      renderSecondary: ({ route, accent }) => <DeadlockRail route={route} accent={accent}/>,
      order: 10,
    });

    api.slots.registerRoute({
      match: matchDeadlock,
      render: ({ params, accent }) => (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Suspense fallback={null}>
            <DeadlockPage rest={params.rest} accent={accent}/>
          </Suspense>
        </div>
      ),
    });
  },
};
