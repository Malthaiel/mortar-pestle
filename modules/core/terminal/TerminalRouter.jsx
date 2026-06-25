// Dispatches the Terminal module's three views off the route `rest` segment,
// and rewrites legacy /tools/skills/* hashes to the merged /tools/terminal/*
// path (one tick, render null) so old deep-links + bookmarks still resolve.

import { useEffect } from 'react';
import { navigate } from '@host/router.js';
import TerminalPage from './TerminalPage.jsx';
import SkillsLaunchpad from './SkillsLaunchpad.jsx';
import SkillsPage from './SkillsPage.jsx';
import TokenDashboard from './TokenDashboard.jsx';

export default function TerminalRouter({ rest, legacy, accent }) {
  useEffect(() => {
    if (legacy) navigate('/tools/terminal' + (rest ? '/' + rest : ''));
  }, [legacy, rest]);
  if (legacy) return null;

  if (rest === 'dashboard') return <TokenDashboard accent={accent} />;
  if (rest === 'skills') return <SkillsLaunchpad accent={accent} />;
  if (rest.startsWith('skills/')) {
    return (
      <SkillsPage
        accent={accent}
        selectedSlug={decodeURIComponent(rest.slice('skills/'.length))}
        onBack={() => navigate('/tools/terminal/skills')}
      />
    );
  }
  return <TerminalPage />;
}
