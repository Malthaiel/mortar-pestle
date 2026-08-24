// Routine items for a given day — the Frame + Recurring merge (Planner
// Consolidation).
//
// One Routine item is `{ id, name, start?, end? }` living in that weekday's
// entry of `Pulse/Schedule.md`'s frames map. Timed items ALSO paint on the
// calendar (useFrameEditing renders those); untimed ones exist only here. Every
// item is tickable either way.
//
// Two halves, deliberately owned by different sides:
//   - the ITEM LIST comes from the frames map, parsed in JS (useDailyFrame)
//   - the TICK STATE comes from Rust (`api.routine()` reads the daily log's
//     `## Routine` section). Rust does NOT know the item list — it returns only
//     what has been ticked, so an item never ticked simply reads unchecked.
//
// Ticking writes through `api.toggleRoutine(task)`, which is idempotent
// flip-or-insert on that section.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import { useDailyFrame } from './useDailyFrame.js';
import { weekdayForKey } from '../util/events.js';

export function useRoutineItems(ds, refreshTick = 0) {
  const { frames } = useDailyFrame();
  const [ticks, setTicks] = useState({});
  const [bump, setBump] = useState(0);

  // Tick state for TODAY's log. `api.routine()` is today-scoped in Rust, so a
  // past/future pivot shows the items with no ticks rather than lying with
  // today's. Re-reads on the day/today watcher events and on our own writes.
  useEffect(() => {
    let cancelled = false;
    api.routine()
      .then((d) => {
        if (cancelled) return;
        const map = {};
        for (const it of (d?.items || [])) map[it.task] = !!it.checked;
        setTicks(map);
      })
      .catch(() => { if (!cancelled) setTicks({}); });
    return () => { cancelled = true; };
  }, [refreshTick, bump]);

  useEffect(() => {
    const unsub = subscribeEvents((name) => {
      // 'schedule' = the item list changed; 'today'/'day' = a tick changed.
      if (name === 'schedule' || name === 'today' || name === 'day') setBump(b => b + 1);
    });
    return () => unsub();
  }, []);

  const items = useMemo(() => {
    if (!ds || !frames) return [];
    const dayKey = weekdayForKey(ds).toLowerCase();
    return (frames[dayKey] || []).map(b => ({
      id: b.id,
      name: b.name,
      start: b.start || null,
      end: b.end || null,
      timed: !!(b.start && b.end),
      checked: !!ticks[b.name],
    }));
  }, [frames, ds, ticks]);

  const toggle = useCallback(async (name) => {
    // Optimistic — the watcher round-trip is slower than the tick feels.
    setTicks(prev => ({ ...prev, [name]: !prev[name] }));
    try { await api.toggleRoutine(name); }
    catch (e) { console.error('routine toggle failed', e); setBump(b => b + 1); }
  }, []);

  const done = items.filter(i => i.checked).length;
  return { items, toggle, done, total: items.length };
}
