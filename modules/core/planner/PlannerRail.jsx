// Collapsed LEFT-sidebar rail for the Planner section — today's WORDS and
// SESSIONS. Moved verbatim from the retired Pulse module's PulseRail
// (Planner Consolidation); the numbers and their sources are unchanged.
//
// Not to be confused with rails/PlannerMiniRail — that one is the RIGHT
// sidebar's collapsed widget rail. Different slot, different registration.

import { useEffect, useState } from 'react';
import RailStat from '@host/components/sidebar/RailStat.jsx';
import { useManifestData } from '@host/lib/manifestReader.js';
import { invoke, api } from '@host/api.js';

export default function PlannerRail({ accent }) {
  const manifest = useManifestData();
  const [today, setToday] = useState({ words: '—', sessions: '—' });

  // Today's daily-log body — counted lazily for words + sessions. Re-reads
  // when the manifest first loads (proxy for "vault settled").
  useEffect(() => {
    const iso = new Date().toISOString().slice(0, 10);
    const path = `Pulse/Daily Logs/${iso}.md`;
    // Words from the daily-log body; sessions from the sessions.json store (D5).
    Promise.all([
      invoke('vault_read_file', { path })
        .then(r => (typeof r === 'string' ? r : r?.content || ''))
        .catch(() => ''),
      api.today().then(d => (d?.sessions || []).length).catch(() => 0),
    ])
      .then(([text, sessions]) => {
        const body = text.replace(/^---[\s\S]*?---\n/, '');
        const words = (body.match(/\S+/g) || []).length;
        setToday({ words, sessions });
      })
      .catch(() => setToday({ words: 0, sessions: 0 }));
  }, [manifest]);

  return (
    <>
      <RailStat label="Words"    value={today.words}    accent={accent}/>
      <RailStat label="Sessions" value={today.sessions} accent={accent}/>
    </>
  );
}
