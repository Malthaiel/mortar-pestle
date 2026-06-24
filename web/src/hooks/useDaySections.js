// Viewed-day Tasks + Quick Notes for the Planner day pane. One daily-log read
// via api.daySections.read(ds), re-run when `reloadToken` ticks — the pane
// owns the watcher subscriptions (consolidated refresh), so this hook has none.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export function useDaySections(ds, reloadToken = 0) {
  const [state, setState] = useState({ exists: false, tasks: [], notes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.daySections.read(ds);
      if (!aliveRef.current) return;
      setState(r);
      setError(null);
    } catch (e) {
      if (aliveRef.current) setError(e);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [ds]);

  useEffect(() => { load(); }, [load, reloadToken]);

  return { ...state, loading, error, reload: load };
}
