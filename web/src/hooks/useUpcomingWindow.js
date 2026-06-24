// Reads the `## Upcoming` section across a forward window (start day + N days)
// and returns structured events grouped by date, sorted by start time. The
// Planner day pane anchors the window at its pivot day (`startDs`) and drives
// refresh itself via `reloadToken`; with no `startDs` the window starts today
// and the hook self-subscribes to vault `today`/`day`/`manifest` events
// (the original behavior, kept for windowless consumers).

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import { parseUpcomingSection, keyForDate, dateFromKey } from '../util/events.js';

function offsetKey(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return keyForDate(d);
}

export function useUpcomingWindow(days = 14, startDs = null, reloadToken = 0) {
  const [groups, setGroups] = useState([]); // [{ ds, events: [...] }]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const base = startDs ? dateFromKey(startDs) : new Date();
      const dsList = Array.from({ length: days + 1 }, (_, i) => offsetKey(base, i));
      const sections = await Promise.all(
        dsList.map(ds => api.upcoming.readSection(ds).catch(() => ''))
      );
      if (!aliveRef.current) return;
      const out = [];
      dsList.forEach((ds, i) => {
        const events = parseUpcomingSection(sections[i]).filter(e => e.title);
        events.sort((a, b) => (a.start || '99:99').localeCompare(b.start || '99:99'));
        if (events.length) out.push({ ds, events });
      });
      setGroups(out);
      setError(null);
    } catch (e) {
      if (aliveRef.current) setError(e);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [days, startDs]);

  useEffect(() => { load(); }, [load, reloadToken]);

  useEffect(() => {
    if (startDs != null) return undefined; // pane-driven refresh — no self-sub
    const unsub = subscribeEvents((name) => {
      if (name === 'today' || name === 'day' || name === 'manifest') load();
    });
    return () => unsub();
  }, [load, startDs]);

  return { groups, loading, error, reload: load };
}
