// Per-day frame resolution — merges canonical frame (from useDailyFrame)
// with that day's `frame_override` from daily-log frontmatter, and splits
// midnight-crossing blocks into two segments (head + tail) for natural
// rendering in a single-day calendar column.

import { useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import { weekdayForKey } from '../util/events.js';
import { useDailyFrame } from './useDailyFrame.js';

function timeToMins(hhmm) {
  if (hhmm === '24:00') return 1440;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Pure helper — given canonical frame + a single-day override map + ds,
// returns an array of session-shaped segments ready for packDaySessions.
export function mergeFrameForDate(frame, override, ds) {
  const segments = [];
  for (const block of frame || []) {
    const ov = override?.[block.id];
    // Deleted-for-today (#10): the override hides this frame on this date only.
    if (ov?.deleted) continue;
    const startStr = ov?.start ?? block.start;
    const endStr   = ov?.end   ?? block.end;
    const isOverridden = !!ov;
    const startMin = timeToMins(startStr);
    const endMin   = timeToMins(endStr);

    const baseMeta = {
      isFrame: true,
      frameId: block.id,
      isOverridden,
      planned: !!block.planned,
    };

    if (endMin > startMin) {
      segments.push({
        id: `frame:${ds}:${block.id}`,
        dateKey: ds,
        start: startStr,
        end: endStr,
        task: block.name,
        meta: baseMeta,
      });
    } else if (endMin < startMin) {
      // Crosses midnight — split into two same-day segments.
      segments.push({
        id: `frame:${ds}:${block.id}:tail`,
        dateKey: ds,
        start: '00:00',
        end: endStr,
        task: block.name,
        meta: { ...baseMeta, segment: 'tail' },
      });
      segments.push({
        id: `frame:${ds}:${block.id}:head`,
        dateKey: ds,
        start: startStr,
        end: '24:00',
        task: block.name,
        meta: { ...baseMeta, segment: 'head' },
      });
    }
    // endMin === startMin: zero-duration block, skip.
  }
  return segments;
}

// Hook — fetches the 7-key weekday frame map (cached) + per-day overrides for
// the given dates, resolving each date to its weekday's frame. Returns
// { perDay: { ds → segments[] }, loading, frames, overrides, writeFrames,
// refreshOverrides }. Bump `refreshOverrides` after writing an override so the
// per-day map reflects the latest state.
export function useFrameForDates(dates) {
  const { frames, writeFrames, mtime, loading: frameLoading } = useDailyFrame();
  const [overrides, setOverrides] = useState({});
  const [overridesLoading, setOverridesLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const datesKey = (dates || []).join(',');

  useEffect(() => {
    if (!dates || dates.length === 0) {
      setOverrides({});
      setOverridesLoading(false);
      return;
    }
    let cancelled = false;
    setOverridesLoading(true);
    Promise.all(
      dates.map(ds => api.dailyFrame.getOverride(ds).catch(() => ({})))
    ).then(results => {
      if (cancelled) return;
      const map = {};
      dates.forEach((ds, i) => { map[ds] = results[i] || {}; });
      setOverrides(map);
      setOverridesLoading(false);
    });
    return () => { cancelled = true; };
  }, [datesKey, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-sync: a per-day frame override written on any calendar surface emits a
  // `day` event from the file watcher; re-fetch overrides so every open surface
  // (planner / Pulse calendar / planner widget) converges without a reopen.
  useEffect(() => {
    const unsub = subscribeEvents((name) => {
      if (name === 'day') setRefreshKey(k => k + 1);
    });
    return unsub;
  }, []);

  const refreshOverrides = () => setRefreshKey(k => k + 1);

  const perDay = {};
  for (const ds of dates || []) {
    // Pick this date's weekday frame (Sunday-indexed util → lowercase mon..sun).
    const dayFrame = frames[weekdayForKey(ds).toLowerCase()] || [];
    perDay[ds] = mergeFrameForDate(dayFrame, overrides[ds] || {}, ds);
  }
  return {
    perDay,
    loading: frameLoading || overridesLoading,
    frames, overrides, writeFrames, mtime,
    refreshOverrides,
  };
}
