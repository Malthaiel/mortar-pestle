// Health history scan (Health Column epic, sub-plan 6). Reads the last N days
// (default 90) of daily pages once, feeding the weekly-macro-average strip and
// the workout-streak chip. Bounded + cached: the scan re-runs ONLY when its key
// (todayDs | windowDays | refreshTick) changes — not on unrelated re-renders.
// `refreshTick` is HealthColumn's debounced vault-watcher tick (today/day/manifest),
// so an external or in-app write re-scans exactly once. A stale-key guard drops a
// late scan whose key was superseded mid-flight.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { addDays } from '../util/time.js';

const DEFAULT_WINDOW = 90;

async function scanHistory(todayDs, windowDays) {
  const dss = [];
  for (let i = 0; i < windowDays; i++) dss.push(addDays(todayDs, -i));
  // Parallel reads — readDay is a cheap vault_read_file; an absent page returns
  // exists:false with empty sections, never throws the whole scan.
  return Promise.all(dss.map(async (ds) => {
    try {
      const d = await api.health.readDay(ds);
      return { ds, meals: d.meals || [], workout: d.workout || null, cardio: d.cardio || [], exists: !!d.exists };
    } catch {
      return { ds, meals: [], workout: null, cardio: [], exists: false };
    }
  }));
}

// useHealthHistory(todayDs, refreshTick, windowDays) → { days, loading, refresh }.
// `days` is today-first descending; each entry { ds, meals, workout, cardio, exists }.
export function useHealthHistory(todayDs, refreshTick = 0, windowDays = DEFAULT_WINDOW) {
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const keyRef = useRef(null);

  const run = useCallback(async () => {
    const key = `${todayDs}|${windowDays}|${refreshTick}`;
    keyRef.current = key;
    setLoading(true);
    try {
      const result = await scanHistory(todayDs, windowDays);
      if (keyRef.current === key) setDays(result);
    } catch (e) {
      console.error('[useHealthHistory] scan failed:', e);
    } finally {
      if (keyRef.current === key) setLoading(false);
    }
  }, [todayDs, windowDays, refreshTick]);

  useEffect(() => { run(); }, [run]);

  return { days, loading, refresh: run };
}
