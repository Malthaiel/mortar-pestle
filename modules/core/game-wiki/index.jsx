// Game Wiki module — a top-level dock surface that browses the read-only, app-managed
// GameWiki vault (multi-game reference: Deadlock + future games as top-level tree
// nodes). Mirrors the Vault module's shape (sidebar pill + games tree + route) but
// points at the `gamewiki` mounted root and renders pages read-only, client-side
// (GameWikiPage), keeping wikilink navigation inside the module.

import GameWikiTree from './GameWikiTree.jsx';
import GameWikiPage from './GameWikiPage.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import './game-wiki.css';

// /game-wiki → reader landing; /game-wiki/<gamewiki-relative path> → that page.
function matchGameWiki(path) {
  if (path === '/game-wiki') return { rest: '' };
  const m = path.match(/^\/game-wiki\/(.+)$/);
  if (!m) return false;
  return { rest: decodeURIComponent(m[1]) };
}

export default {
  register(api) {
    const { IconGamepad } = api.ui.icons;

    api.slots.registerLeftSidebar({
      id: 'game-wiki',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconGamepad}
          label="Game Wiki"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/game-wiki')}
        />
      ),
      isActive: (route) => route.page === 'game-wiki',
      renderSecondary: ({ route, accent }) => <GameWikiTree route={route} accent={accent}/>,
      order: 10,
    });

    api.slots.registerRoute({
      match: matchGameWiki,
      render: ({ params, accent }) => (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <GameWikiPage rest={params.rest} accent={accent}/>
        </div>
      ),
    });
  },
};
