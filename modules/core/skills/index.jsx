import { SkillsProvider } from './SkillsProvider.jsx';
import SkillsPage from './SkillsPage.jsx';
import SkillsNav from './SkillsNav.jsx';
import { bindSkillsApi } from './api.js';
import SidebarPill from '@host/components/SidebarPill.jsx';

export default {
  register(api) {
    bindSkillsApi(api);
    const { IconTerminal } = api.ui.icons;
    api.slots.registerProvider(SkillsProvider);
    api.slots.registerLeftSidebar({
      id: 'skills',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconTerminal}
          label="Skills Runner"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/skills')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'skills',
      renderSecondary: ({ route, accent }) => <SkillsNav route={route} accent={accent} />,
      order: 50,
    });
    api.slots.registerRoute({
      match: r => r === '/tools/skills' || r.startsWith('/tools/skills/')
        ? { rest: r.slice('/tools/skills'.length).replace(/^\//, '') }
        : false,
      render: ({ params, accent }) => (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <SkillsPage accent={accent} selectedSlug={params.rest || null}/>
        </div>
      ),
    });
  },
};
