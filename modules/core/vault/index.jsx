// Vault View module — the Phase 2b consolidation of the former Knowledge and
// Infrastructure modules into one dock button + one unified left-sidebar tree
// that browses the whole content vault (Knowledge domains + Infrastructure
// sections) in a single scroll.
//
// Routes live under /vault/<type>/… (type ∈ knowledge | infrastructure). Legacy
// /knowledge* and /infrastructure* paths resolve here too (router.js maps them
// to page 'vault'), so old deep-links + the recently-visited list keep working;
// the route-slot match below normalizes them as well for the raw-path matcher
// in App.jsx. The bare /vault → last-viewed (else first Knowledge domain)
// redirect lives inside VaultViewPage (async vault state).

import VaultViewPage from '@host/pages/VaultViewPage.jsx';
import VaultSidebar from '@host/components/VaultSidebar.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import RailStat from '@host/components/sidebar/RailStat.jsx';
import { useManifestData } from '@host/lib/manifestReader.js';

// Normalize a raw hash path into { type, sub, folderPath } | false. Accepts the
// canonical /vault/<type>/… form and the legacy /<type>/… form (old bookmarks).
function matchVault(path) {
  if (path === '/vault') return { type: null, sub: null, folderPath: '' };
  // Auto-discovery generic browse (SF3): /vault/folder/<top>/<rest>.
  const f = path.match(/^\/vault\/folder\/([^/]+)(?:\/(.*))?$/);
  if (f) {
    return {
      type: 'folder',
      sub: decodeURIComponent(f[1]),
      folderPath: f[2] ? decodeURIComponent(f[2]) : '',
    };
  }
  const m = path.match(/^(?:\/vault)?\/(knowledge|infrastructure)(?:\/([^/]+))?(?:\/(.*))?$/);
  if (!m) return false;
  return {
    type: m[1],
    sub: m[2] ? decodeURIComponent(m[2]) : null,
    folderPath: m[3] ? decodeURIComponent(m[3]) : '',
  };
}

function VaultRail({ accent }) {
  const manifest = useManifestData();
  const stats = (() => {
    if (!manifest?.entries) return { pages: '—', today: '—', orphans: '—' };
    const todayIso = new Date().toISOString().slice(0, 10);
    return {
      pages:   manifest.entries.length,
      today:   manifest.entries.filter(e => (e.mtime || '').startsWith(todayIso)).length,
      orphans: manifest.entries.filter(e => !e.outbound_links || e.outbound_links.length === 0).length,
    };
  })();
  return (
    <>
      <RailStat label="PAGES"   value={stats.pages}   accent={accent}/>
      <RailStat label="TODAY"   value={stats.today}   accent={accent}/>
      <RailStat label="ORPHANS" value={stats.orphans} accent={accent}/>
    </>
  );
}

export default {
  register(api) {
    const { IconLibrary } = api.ui.icons;

    api.slots.registerLeftSidebar({
      id: 'vault',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconLibrary}
          label="Vault View"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/vault')}
        />
      ),
      isActive: (route) => route.page === 'vault'
        || (route.page === 'page' && typeof route.sub === 'string'
            && (route.sub.startsWith('Knowledge/') || route.sub.startsWith('Infrastructure/'))),
      renderSecondary: ({ route, accent }) => <VaultSidebar route={route} accent={accent}/>,
      renderRail: ({ accent }) => <VaultRail accent={accent}/>,
      order: 0,
    });

    api.slots.registerRoute({
      match: matchVault,
      render: ({ params, accent }) => (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <VaultViewPage type={params.type} sub={params.sub} folderPath={params.folderPath} accent={accent}/>
        </div>
      ),
    });
  },
};
