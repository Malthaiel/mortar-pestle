// Terminal module — now a 3-view hub (Terminal / Token Dashboard / Skills
// Runner) behind a secondary-sidebar nav. The standalone Skills Runner module
// folded in here (its pages + provider + api moved alongside); the Token
// Dashboard is a native view over local Claude Code session usage.
//
// Routing: this one route slot owns /tools/terminal/* AND the legacy
// /tools/skills/* (redirected in TerminalRouter — the registry's
// registerRedirect is never consumed, so the rewrite lives in the view).

import { TerminalProvider } from './TerminalProvider.jsx';
import { SkillsProvider } from './SkillsProvider.jsx';
import { bindSkillsApi } from './api.js';
import TerminalSidebar from './TerminalSidebar.jsx';
import TerminalRouter from './TerminalRouter.jsx';
import SettingsTab from './SettingsTab.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import './terminal.css';

export default {
  register(api) {
    const { IconConsole } = api.ui.icons;
    bindSkillsApi(api);

    // Two app-wide providers: PTY tabs (TerminalProvider) and skill jobs
    // (SkillsProvider) both survive intra-app navigation.
    api.slots.registerProvider(TerminalProvider);
    api.slots.registerProvider(SkillsProvider);

    api.slots.registerLeftSidebar({
      id: 'terminal',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconConsole}
          label="Terminal"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/terminal')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'terminal',
      renderSecondary: ({ route, accent }) => <TerminalSidebar route={route} accent={accent} />,
      order: 60,
    });

    api.slots.registerRoute({
      // Normalized `rest`: '' | 'dashboard' | 'skills' | 'skills/<slug>'.
      // `legacy:true` marks the old /tools/skills paths so TerminalRouter
      // rewrites the hash to the merged equivalent.
      match: (r) => {
        if (r === '/tools/terminal' || r.startsWith('/tools/terminal/')) {
          return { rest: r.slice('/tools/terminal'.length).replace(/^\//, ''), legacy: false };
        }
        if (r === '/tools/skills' || r.startsWith('/tools/skills/')) {
          return { rest: 'skills' + r.slice('/tools/skills'.length), legacy: true };
        }
        return false;
      },
      render: ({ params, accent }) => (
        <TerminalRouter rest={params.rest} legacy={params.legacy} accent={accent} />
      ),
    });

    api.slots.registerSettingsTab({
      id: 'terminal',
      label: 'Terminal',
      render: SettingsTab,
    });
  },
};
