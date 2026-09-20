import BrowserPage from './BrowserPage.jsx';
import TabSidebar from './TabSidebar.jsx';
import TabRail from './TabRail.jsx';
import BrowserSettingsTab from './BrowserSettingsTab.jsx';
import { safeDecode } from '@host/router.js';

// In-app sandboxed browser. The chrome (this React UI) runs in the privileged
// `main` webview; page content renders in separate, zero-IPC raw WebKitGTK
// views (one per tab) that the Rust `browser_*` commands drive. The left
// sidebar hosts the tab strip (TabSidebar) / collapsed favicon rail (TabRail).
// See Mortar & Pestle/Plans/Browser Multi-Tab.md.
export default {
  register(api) {
    api.slots.registerLeftSidebar({
      id: 'browser',
      isActive: (route) => route.page === 'tools' && route.sub === 'browser',
      renderSecondary: ({ accent }) => <TabSidebar api={api} accent={accent} />,
      renderRail: ({ accent }) => <TabRail api={api} accent={accent} />,
      order: 40,
    });
    api.slots.registerRoute({
      // App.jsx matches route slots against route.path — the RAW hash. matchRoute
      // safeDecodes its named captures, but never `path`, so every module matcher
      // decodes its own capture (deadlock, vault, library/player all do). This one
      // did not, and a deep-linked URL reached browser_navigate still percent-encoded
      // ("https%3A%2F%2F…"), failing the Rust https:// guard with
      // "blocked: only https:// public URLs are allowed" — surfaced to the user as the
      // generic "Page stopped responding" card. Decode ONCE here: the call site encodes
      // once with encodeURIComponent, so a literal % in the URL arrives as %25 and
      // survives this pass intact.
      match: r => r === '/tools/browser' || r.startsWith('/tools/browser/')
        ? { rest: safeDecode(r.slice('/tools/browser'.length).replace(/^\//, '')) }
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
