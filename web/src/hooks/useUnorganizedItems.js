// Reads all unorganized quick-note bullets and unchecked tasks across every
// daily log EXCEPT today, via the `daily_get_unorganized` command. Returns two
// newest-source-first arrays:
//   tasks: [{ path, line, text, sourceDate }]  — unchecked `- [ ]`, toggleable
//   notes: [{ sourceDate, index, text }]        — plain `## Quick Notes` bullets
//
// Two refresh modes:
//   • default (no arg): self-subscribes to vault `day`/`today` events and the
//     `agentic:yesterday-notes-changed` browser event noteActions dispatch.
//   • pane-driven (non-null `reloadToken`): the consumer owns refresh (the
//     DayPane's consolidated debounced subscriptions); internal listeners are
//     skipped and the hook reloads when the token ticks.

import { useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';

export function useUnorganizedItems(reloadToken = null) {
  const [data, setData] = useState({ tasks: [], notes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      api.unorganized.read()
        .then(r => { if (!cancelled) { setData({ tasks: r.tasks || [], notes: r.notes || [] }); setError(null); } })
        .catch(e => { if (!cancelled) setError(e); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };

    load();

    if (reloadToken != null) {
      // Pane-driven mode — reload happens via the token in the deps.
      return () => { cancelled = true; };
    }

    const unsub = subscribeEvents((name) => {
      if (name === 'day' || name === 'today') load();
    });
    // noteActions helpers dispatch this browser event after delete/move/carry/
    // toggle (+ undos). subscribeEvents only sees Tauri backend events, so the
    // pane needs its own window listener to refresh.
    const onChanged = () => load();
    window.addEventListener('agentic:yesterday-notes-changed', onChanged);
    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener('agentic:yesterday-notes-changed', onChanged);
    };
  }, [reloadToken]);

  return { tasks: data.tasks, notes: data.notes, loading, error };
}
