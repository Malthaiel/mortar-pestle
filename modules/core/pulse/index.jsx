// Pulse module — owns /pulse* route subtree and the Pulse left-sidebar pill
// + secondary nav (daily logs / schedule / recurring / ideas).
//
// /pulse/calendar is the Planner module's territory; its exact-match route
// slot wins because Planner registers earlier in module iteration. If
// Planner is uninstalled, Pulse's broad match handles /pulse/calendar and
// PulsePage falls back to its <EmptyCalendar/> placeholder.

import { useEffect, useState } from 'react';
import PulsePage from '@host/pages/PulsePage.jsx';
import PulseNav from '@host/components/PulseSidebar.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import RailStat from '@host/components/sidebar/RailStat.jsx';
import { useManifestData } from '@host/lib/manifestReader.js';
import { invoke } from '@host/api.js';

function PulseRail({ accent }) {
  const manifest = useManifestData();
  const [today, setToday] = useState({ words: '—', sessions: '—' });

  // Today's daily-log body — counted lazily for words + sessions. Re-reads
  // when the manifest first loads (proxy for "vault settled").
  useEffect(() => {
    const iso = new Date().toISOString().slice(0, 10);
    const path = `Pulse/Daily Logs/${iso}.md`;
    invoke('vault_read_file', { path })
      .then(result => {
        const text = typeof result === 'string' ? result : result?.content || '';
        const body = text.replace(/^---[\s\S]*?---\n/, '');
        const words = (body.match(/\S+/g) || []).length;
        const sessionsBlock = (text.match(/##\s+Sessions\s+([\s\S]*?)(?=\n##\s|$)/) || [])[1] || '';
        const sessions = (sessionsBlock.match(/^###\s/gm) || []).length;
        setToday({ words, sessions });
      })
      .catch(() => setToday({ words: 0, sessions: 0 }));
  }, [manifest]);

  return (
    <>
      <RailStat label="WORDS"    value={today.words}    accent={accent}/>
      <RailStat label="SESSIONS" value={today.sessions} accent={accent}/>
    </>
  );
}

export default {
  register(api) {
    const { IconStar } = api.ui.icons;

    api.slots.registerLeftSidebar({
      id: 'pulse',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconStar}
          label="Pulse"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/pulse')}
        />
      ),
      isActive: (route) => route.page === 'pulse'
        || (route.page === 'page' && typeof route.sub === 'string' && route.sub.startsWith('Pulse/')),
      renderSecondary: ({ route, accent }) => <PulseNav route={route} accent={accent}/>,
      renderRail: ({ accent }) => <PulseRail accent={accent}/>,
      order: 20,
    });

    api.slots.registerRoute({
      match: (path) => {
        if (path === '/pulse') return { sub: null };
        const m = path.match(/^\/pulse\/([^/]+)$/);
        if (m) return { sub: decodeURIComponent(m[1]) };
        return false;
      },
      render: ({ params, accent }) => (
        <PulsePage sub={params.sub} accent={accent}/>
      ),
    });
  },
};
