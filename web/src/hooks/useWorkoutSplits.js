// Workout-splits Library hook (Health Column, sub-plan 4). Clones useHealthLibrary:
// lists Health/Splits via health_list_dir, parses each page, refreshes on the
// `manifest` event. Adds setActive (exactly one active split) and seed-self-heal:
// when the folder is EMPTY, write the default starter set (locked behavior). The
// seed is guarded by a ref so StrictMode's double-mount can't double-seed, and
// the guard clears when the list goes non-empty so a later wipe re-seeds.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import { DEFAULT_SPLITS } from '../util/fitnessSeed.js';

async function loadSplits() {
  const files = await api.health.listSplits();
  const splits = await Promise.all(files.map((f) => api.health.readSplitDef(f).catch(() => null)));
  return splits.filter(Boolean);
}

export function useWorkoutSplits() {
  const [splits, setSplits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const seededRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSplits(await loadSplits());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Self-heal: seed defaults when the folder is empty. Best-effort — a failure
  // leaves the library empty and the user can add a split manually.
  const maybeSeed = useCallback(async (current) => {
    if (current.length > 0) { seededRef.current = false; return; }
    if (seededRef.current) return;
    seededRef.current = true;
    try {
      for (const s of DEFAULT_SPLITS) await api.health.saveSplitDef(s, null);
      await refresh();
    } catch (e) {
      seededRef.current = false; // failed before completing → allow a retry next mount
      console.error('[useWorkoutSplits] seed failed:', e);
    }
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    loadSplits()
      .then((r) => { if (!cancelled) { setSplits(r); maybeSeed(r); } })
      .catch((e) => { if (!cancelled) { console.error('[useWorkoutSplits] load failed:', e); setError(e); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    const unsub = subscribeEvents((name) => { if (name === 'manifest') refresh(); });
    return () => { cancelled = true; unsub(); };
  }, [refresh, maybeSeed]);

  const saveSplit = useCallback(async (split) => {
    const existing = splits.find((s) => s.id === split.id);
    const r = await api.health.saveSplitDef({ ...split, file: split.file || existing?.file }, existing?.mtime ?? null);
    await refresh();
    return r;
  }, [splits, refresh]);

  const deleteSplit = useCallback(async (file) => {
    await api.health.deleteSplitDef(file);
    await refresh();
  }, [refresh]);

  // Activate one split (clearing the others). `anchor` ({ anchorDate, anchorIndex })
  // pins which cycle day "today" is — set on the chosen split only. Writes that
  // change nothing are skipped to avoid churn (and needless mtime bumps).
  const setActive = useCallback(async (id, anchor) => {
    for (const s of splits) {
      const isTarget = s.id === id;
      if (!isTarget && !s.active) continue;
      const next = { ...s, active: isTarget };
      if (isTarget && anchor) {
        next.anchorDate = anchor.anchorDate;
        next.anchorIndex = anchor.anchorIndex;
      }
      await api.health.saveSplitDef(next, s.mtime ?? null);
    }
    await refresh();
  }, [splits, refresh]);

  return { splits, loading, error, refresh, saveSplit, deleteSplit, setActive };
}
