// Health Library — reads/writes the off-graph Library/Health pages (Meals,
// Supplements, Goals) at root:'library'. Clones useBlockLibrary's shape.
//
// Library pages are manifest-less, so the vault watcher's `manifest` event may
// not fire on a Library write — every mutation therefore calls refresh()
// explicitly (in-app edits flow through immediately; an external Obsidian edit
// refreshes on the next manifest tick if the watcher covers the Library mount).

import { useCallback, useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';

async function loadAll() {
  const [mealFiles, suppFiles, goalsRes] = await Promise.all([
    api.health.listMeals(),
    api.health.listSupplements(),
    api.health.readGoals(),
  ]);
  const [meals, supplements] = await Promise.all([
    Promise.all(mealFiles.map((f) => api.health.readMealDef(f).catch(() => null))),
    Promise.all(suppFiles.map((f) => api.health.readSupplementDef(f).catch(() => null))),
  ]);
  return {
    meals: meals.filter(Boolean),
    supplements: supplements.filter(Boolean),
    goals: goalsRes.goals,
    goalsMtime: goalsRes.mtime,
  };
}

export function useHealthLibrary() {
  const [meals, setMeals] = useState([]);
  const [supplements, setSupplements] = useState([]);
  const [goals, setGoals] = useState(null);
  const [goalsMtime, setGoalsMtime] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const apply = useCallback((r) => {
    setMeals(r.meals);
    setSupplements(r.supplements);
    setGoals(r.goals);
    setGoalsMtime(r.goalsMtime);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await loadAll());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    loadAll()
      .then((r) => { if (!cancelled) apply(r); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const unsub = subscribeEvents((name) => { if (name === 'manifest') refresh(); });
    return () => { cancelled = true; unsub(); };
  }, [apply, refresh]);

  const saveMeal = useCallback(async (meal) => {
    const existing = meals.find((m) => m.id === meal.id);
    const r = await api.health.saveMealDef({ ...meal, file: meal.file || existing?.file }, existing?.mtime);
    await refresh();
    return r;
  }, [meals, refresh]);

  const deleteMeal = useCallback(async (file) => {
    await api.health.deleteMealDef(file);
    await refresh();
  }, [refresh]);

  const saveSupplement = useCallback(async (s) => {
    const existing = supplements.find((x) => x.id === s.id);
    const r = await api.health.saveSupplementDef({ ...s, file: s.file || existing?.file }, existing?.mtime);
    await refresh();
    return r;
  }, [supplements, refresh]);

  const deleteSupplement = useCallback(async (file) => {
    await api.health.deleteSupplementDef(file);
    await refresh();
  }, [refresh]);

  const saveGoals = useCallback(async (g) => {
    const r = await api.health.saveGoals(g, goalsMtime);
    await refresh();
    return r;
  }, [goalsMtime, refresh]);

  return {
    meals, supplements, goals,
    loading, error,
    refresh,
    saveMeal, deleteMeal,
    saveSupplement, deleteSupplement,
    saveGoals,
  };
}
