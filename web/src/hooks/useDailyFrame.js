// Daily-frame canonical source — reads/writes `Pulse/Schedule.md` YAML
// frontmatter. Mirrors useBlockLibrary; the manifest event triggers refresh
// on external edits. Writes round-trip the mtime to catch concurrent writes.

import { useCallback, useEffect, useState } from 'react';
import { api, subscribeEvents, emptyFramesMap } from '../api.js';

export function useDailyFrame() {
  const [frames, setFrames] = useState(emptyFramesMap);
  const [mtime, setMtime] = useState(null);
  const [extras, setExtras] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.dailyFrame.read();
      setFrames(r.frames);
      setMtime(r.mtime);
      setExtras(r.extras || {});
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.dailyFrame.read()
      .then(r => {
        if (cancelled) return;
        setFrames(r.frames);
        setMtime(r.mtime);
        setExtras(r.extras || {});
      })
      .catch(e => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    const unsub = subscribeEvents((name) => {
      // `manifest` covers in-app vault rebuilds; `schedule` covers external
      // (Obsidian) edits to Pulse/Schedule.md — the canonical frame source.
      if (name === 'manifest' || name === 'schedule') refresh();
    });
    return () => { cancelled = true; unsub(); };
  }, [refresh]);

  const writeFrames = useCallback(async (next) => {
    const r = await api.dailyFrame.write(next, mtime);
    setFrames(next);
    setMtime(r.mtime);
    return r;
  }, [mtime]);

  return { frames, mtime, extras, loading, error, refresh, writeFrames };
}
