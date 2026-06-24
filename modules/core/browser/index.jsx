import BrowserPage from './BrowserPage.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import TabSidebar from './TabSidebar.jsx';
import TabRail from './TabRail.jsx';
import BrowserSettingsTab from './BrowserSettingsTab.jsx';

// In-app sandboxed browser. The chrome (this React UI) runs in the privileged
// `main` webview; page content renders in separate, zero-IPC raw WebKitGTK
// views (one per tab) that the Rust `browser_*` commands drive. The left
// sidebar hosts the tab strip (TabSidebar) / collapsed favicon rail (TabRail).
// See Iskariel/Plans/Browser Multi-Tab.md.
export default {
  register(api) {
    const { IconGlobe } = api.ui.icons;
    api.slots.registerLeftSidebar({
      id: 'browser',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconGlobe}
          label="Browser"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/browser')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'browser',
      renderSecondary: ({ accent }) => <TabSidebar api={api} accent={accent} />,
      renderRail: ({ accent }) => <TabRail api={api} accent={accent} />,
      order: 40,
    });
    api.slots.registerRoute({
      match: r => r === '/tools/browser' || r.startsWith('/tools/browser/')
        ? { rest: r.slice('/tools/browser'.length).replace(/^\//, '') }
        : false,
      render: ({ params, accent }) => (
        <BrowserPage api={api} accent={accent} rest={params.rest || ''} />
      ),
    });
    api.slots.registerSettingsTab({
      id: 'browser-shield',
      label: 'Browser',
      render: BrowserSettingsTab,
    });
  },
};
