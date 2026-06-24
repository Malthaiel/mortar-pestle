import { TerminalProvider } from './TerminalProvider.jsx';
import TerminalPage from './TerminalPage.jsx';
import SettingsTab from './SettingsTab.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import './terminal.css';

export default {
  register(api) {
    const { IconConsole } = api.ui.icons;
    api.slots.registerProvider(TerminalProvider);
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
      renderSecondary: null,
      order: 60,
    });
    api.slots.registerRoute({
      match: r => r === '/tools/terminal' || r.startsWith('/tools/terminal/') ? {} : false,
      render: () => <TerminalPage/>,
    });
    api.slots.registerSettingsTab({
      id: 'terminal',
      label: 'Terminal',
      render: SettingsTab,
    });
  },
};
