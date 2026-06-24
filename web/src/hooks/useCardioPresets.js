// Cardio-presets Library hook (Health Column epic, sub-plan 5). Clones
// useWorkoutSplits (minus the active/anchor concept — a preset is just a named,
// reusable, combinable sequence): lists Health/Cardio via health_list_dir,
// parses each page, refreshes on `manifest`, and seed-self-heals the defaults
// (Zone 2 / HIIT / LISS / Tabata) when the folder is empty. Ref-guarded against
// the StrictMode double-mount; the guard resets on failure so a transient error
// can re-seed next mount.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import { DEFAULT_CARDIO } from '../util/fitnessSeed.js';

async function loadPresets() {
  const files = await api.health.listCardioPresets();
  const presets = await Promise.all(files.map((f) => api.health.readCardioDef(f).catch(() => null)));
  return presets.filter(Boolean);
}

export function useCardioPresets() {
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const seededRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setPresets(await loadPresets());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const maybeSeed = useCallback(async (current) => {
    if (current.length > 0) { seededRef.current = false; return; }
    if (seededRef.current) return;
    seededRef.current = true;
    try {
      for (const p of DEFAULT_CARDIO) await api.health.saveCardioDef(p, null);
      await refresh();
    } catch (e) {
      seededRef.current = false;
      console.error('[useCardioPresets] seed failed:', e);
    }
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    loadPresets()
      .then((r) => { if (!cancelled) { setPresets(r); maybeSeed(r); } })
      .catch((e) => { if (!cancelled) { console.error('[useCardioPresets] load failed:', e); setError(e); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    const unsub = subscribeEvents((name) => { if (name === 'manifest') refresh(); });
    return () => { cancelled = true; unsub(); };
  }, [refresh, maybeSeed]);

  const savePreset = useCallback(async (preset) => {
    const existing = presets.find((p) => p.id === preset.id);
    const r = await api.health.saveCardioDef({ ...preset, file: preset.file || existing?.file }, existing?.mtime ?? null);
    await refresh();
    return r;
  }, [presets, refresh]);

  const deletePreset = useCallback(async (file) => {
    await api.health.deleteCardioDef(file);
    await refresh();
  }, [refresh]);

  return { presets, loading, error, refresh, savePreset, deletePreset };
}
