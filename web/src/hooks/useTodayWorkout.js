// Resolve the active split's day for a planner date (Health Column, sub-plan 4).
// A PURE read of (splits, pivotDs) — it never writes; log_workout does the
// snapshot. Takes the splits array from a single useWorkoutSplits instance owned
// by FitnessSection (so the seeding hook mounts once).
//
//   dayIndex = (daysDiff(ds, anchorDate) + anchorIndex) mod cycle.length
//
// Double-modded so a past day (negative delta) wraps correctly; anchorIndex is
// clamped into range so a cycle shortened AFTER activation re-pins instead of
// pointing past the end. (A lengthened cycle simply extends the rotation.)

import { useMemo } from 'react';
import { daysDiff } from '../util/time.js';

export function resolveDayIndex(split, ds) {
  const len = split?.cycle?.length || 0;
  if (!len || !split.anchorDate) return null;
  const anchorIdx = (((split.anchorIndex ?? 0) % len) + len) % len;
  const delta = daysDiff(ds, split.anchorDate);
  return (((delta + anchorIdx) % len) + len) % len;
}

// Is `ds` a rest day under the active split? (Used by the history streak — a rest
// day is a neutral skip.) null when there's no active split / no anchor.
export function isRestDay(activeSplit, ds) {
  if (!activeSplit) return null;
  const idx = resolveDayIndex(activeSplit, ds);
  if (idx == null) return null;
  const label = activeSplit.cycle[idx];
  return ((activeSplit.days && activeSplit.days[label]) || []).length === 0;
}

export function useTodayWorkout(splits, pivotDs) {
  return useMemo(() => {
    const split = (splits || []).find((s) => s.active) || null;
    if (!split) return { split: null, dayIndex: null, dayLabel: null, targets: [], isRest: false };
    const dayIndex = resolveDayIndex(split, pivotDs);
    if (dayIndex == null) return { split, dayIndex: null, dayLabel: null, targets: [], isRest: false };
    const dayLabel = split.cycle[dayIndex];
    const targets = (split.days && split.days[dayLabel]) || [];
    return { split, dayIndex, dayLabel, targets, isRest: targets.length === 0 };
  }, [splits, pivotDs]);
}
