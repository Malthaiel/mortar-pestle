// Terminal module's secondary (left) sidebar: Terminal / Token Dashboard /
// Skills Runner rows. Reuses the shared SidebarNav recipe (same component the
// Video Editor's VeditNav and LibraryNav use) so the buttons match every other
// secondary-sidebar nav in the app — 32px candy rows, shallower nav depth,
// accent-tinted when selected. Active row is derived from the route's `rest`.

import { SidebarNav } from '@host/components/SidebarBrowser.jsx';

const TERMINAL = '/tools/terminal';
const DASHBOARD = '/tools/terminal/dashboard';
const SKILLS = '/tools/terminal/skills';

export default function TerminalSidebar({ route, accent }) {
  const seg = (route?.rest || '').split('/')[0];
  const selected = seg === 'dashboard' ? DASHBOARD : seg === 'skills' ? SKILLS : TERMINAL;
  return (
    <SidebarNav
      groups={[{ items: [
        { path: TERMINAL,  title: 'Terminal',        icon: 'IconTerminal' },
        { path: DASHBOARD, title: 'Token Dashboard', icon: 'IconChart' },
        { path: SKILLS,    title: 'Skills Runner',   icon: 'IconRocket' },
      ] }]}
      selectedPath={selected}
      accent={accent}
      onSelect={(item) => { window.location.hash = item.path; }}
    />
  );
}
