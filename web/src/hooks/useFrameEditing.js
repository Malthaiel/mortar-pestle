// Daily-frame editing logic, extracted from CalendarPane so all three calendar
// surfaces — planner, Pulse calendar, planner widget — share ONE implementation
// instead of triplicating it. Fetches per-day frame segments for `dateKeys`,
// exposes a merge helper that folds them into a session list, and returns the
// seven frame gesture handlers as an `onFrame*`-keyed `handlers` object ready to
// spread onto CalendarPanel. `pushUndo` is optional — surfaces without an undo
// stack (Pulse calendar, dock) pass nothing and the undo steps are skipped.
//
// `frames` is lowercase-keyed (mon..sun) while weekdayForKey returns 'Mon',
// hence the .toLowerCase() on every weekday access. Edit-mode template writes
// (retime/create/delete/rename) push an undo entry that snapshots the whole
// `frames` map and restores it via writeFrames — the API re-reads a fresh mtime
// on every write, so the snapshot can't go stale.

import { useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { weekdayForKey } from '../util/events.js';
import { minsToHM } from '../util/time.js';
import { validateDay, makeUniqueId } from '../util/frames.js';
import { useFrameForDates } from './useFrameForDate.js';

export function useFrameEditing(dateKeys, { pushUndo = null } = {}) {
  const {
    perDay: frameByDay, frames, writeFrames,
    overrides: frameOverrides, refreshOverrides,
  } = useFrameForDates(dateKeys);

  // Flatten each visible day's frame segments into one list, then expose a
  // helper that appends them to a caller's session array so packDaySessions
  // lanes frame + real sessions together.
  const frameSegments = useMemo(() => {
    const out = [];
    for (const ds of dateKeys) {
      if (frameByDay[ds]) out.push(...frameByDay[ds]);
    }
    return out;
  }, [frameByDay, dateKeys]);

  const mergeIntoSessions = useCallback(
    (sessions) => [...(sessions || []), ...frameSegments],
    [frameSegments],
  );

  const handleFrameDrop = useCallback(async (targetDs, frameId, startMins) => {
    const dayFrame = frames[weekdayForKey(targetDs).toLowerCase()] || [];
    const block = dayFrame.find(b => b.id === frameId);
    if (!block) return;
    const [bsh, bsm] = block.start.split(':').map(Number);
    const startMin = bsh * 60 + bsm;
    let endMin;
    if (block.end === '24:00') endMin = 1440;
    else {
      const [eh, em] = block.end.split(':').map(Number);
      endMin = eh * 60 + em;
    }
    const durMin = Math.max(15, endMin - startMin);
    const newStartMins = startMins;
    const newEndMins = Math.min(24 * 60, newStartMins + durMin);
    const newStartHM = minsToHM(newStartMins);
    const newEndHM = newEndMins === 1440 ? '24:00' : minsToHM(newEndMins);

    const prevOverride = frameOverrides?.[targetDs]?.[frameId] || null;
    try {
      await api.dailyFrame.setOverride(targetDs, frameId, { start: newStartHM, end: newEndHM });
      refreshOverrides();
      if (pushUndo) {
        pushUndo({
          label: `Move ${block.name}`,
          inverse: async () => {
            try {
              if (prevOverride) {
                await api.dailyFrame.setOverride(targetDs, frameId, prevOverride);
              } else {
                await api.dailyFrame.clearOverride(targetDs, frameId);
              }
              refreshOverrides();
            } catch (e) { console.error('Frame undo failed', e); }
          },
        });
      }
    } catch (e) {
      console.error('Frame override failed', e);
    }
  }, [frames, frameOverrides, refreshOverrides, pushUndo]);

  // Per-day frame resize (non-edit mode): write an explicit start/end override
  // for THIS date only — mirrors handleFrameDrop's override + undo, but sets
  // both edges directly instead of recomputing the end from a preserved
  // duration. Edit-mode resize rewrites the recurring frame via handleFrameRetime.
  const handleFrameResize = useCallback(async (targetDs, frameId, startHM, endHM) => {
    if (!frameId) return;
    const prevOverride = frameOverrides?.[targetDs]?.[frameId] || null;
    try {
      await api.dailyFrame.setOverride(targetDs, frameId, { start: startHM, end: endHM });
      refreshOverrides();
      if (pushUndo) {
        const dayFrame = frames[weekdayForKey(targetDs).toLowerCase()] || [];
        const block = dayFrame.find(b => b.id === frameId);
        pushUndo({
          label: `Resize ${block?.name || frameId}`,
          inverse: async () => {
            try {
              if (prevOverride) await api.dailyFrame.setOverride(targetDs, frameId, prevOverride);
              else await api.dailyFrame.clearOverride(targetDs, frameId);
              refreshOverrides();
            } catch (e) { console.error('Frame resize undo failed', e); }
          },
        });
      }
    } catch (e) {
      console.error('Frame resize failed', e);
    }
  }, [frames, frameOverrides, refreshOverrides, pushUndo]);

  // Delete-for-today (#10): write a `{deleted: true}` per-day override so this
  // frame is hidden on `targetDs` only — the weekly template stays untouched.
  // Restored en masse by handleFrameRestoreDeleted (the header reset circle).
  const handleFrameDeleteToday = useCallback(async (targetDs, frameId) => {
    if (!frameId) return;
    const prevOverride = frameOverrides?.[targetDs]?.[frameId] || null;
    try {
      await api.dailyFrame.setOverride(targetDs, frameId, { deleted: true });
      refreshOverrides();
      if (pushUndo) {
        const dayFrame = frames[weekdayForKey(targetDs).toLowerCase()] || [];
        const block = dayFrame.find(b => b.id === frameId);
        pushUndo({
          label: `Delete ${block?.name || frameId} for today`,
          inverse: async () => {
            try {
              if (prevOverride) await api.dailyFrame.setOverride(targetDs, frameId, prevOverride);
              else await api.dailyFrame.clearOverride(targetDs, frameId);
              refreshOverrides();
            } catch (e) { console.error('Delete-for-today undo failed', e); }
          },
        });
      }
    } catch (e) { console.error('Delete-for-today failed', e); }
  }, [frames, frameOverrides, refreshOverrides, pushUndo]);

  // Reset circle (#10): clear every {deleted} override for the day; per-block
  // time tweaks keep their overrides (their venue stays "Reset override").
  // Sequential clears are safe — clearOverride re-reads content+mtime per call.
  // Returns the restored frame ids so the caller can stagger their re-entry.
  const handleFrameRestoreDeleted = useCallback(async (targetDs) => {
    const dayOv = frameOverrides?.[targetDs] || {};
    const ids = Object.keys(dayOv).filter(id => dayOv[id]?.deleted);
    if (!ids.length) return [];
    try {
      for (const id of ids) await api.dailyFrame.clearOverride(targetDs, id);
      refreshOverrides();
      if (pushUndo) {
        pushUndo({
          label: `Restore ${ids.length} deleted frame${ids.length > 1 ? 's' : ''}`,
          inverse: async () => {
            try {
              for (const id of ids) await api.dailyFrame.setOverride(targetDs, id, { deleted: true });
              refreshOverrides();
            } catch (e) { console.error('Restore-deleted undo failed', e); }
          },
        });
      }
      return ids;
    } catch (e) { console.error('Restore deleted frames failed', e); return []; }
  }, [frameOverrides, refreshOverrides, pushUndo]);

  const handleFrameReset = useCallback(async (targetDs, frameId) => {
    if (!frameId) return;
    const prev = frameOverrides?.[targetDs]?.[frameId] || null;
    if (!prev) return;
    try {
      await api.dailyFrame.clearOverride(targetDs, frameId);
      refreshOverrides();
      const dayFrame = frames[weekdayForKey(targetDs).toLowerCase()] || [];
      const block = dayFrame.find(b => b.id === frameId);
      if (pushUndo) {
        pushUndo({
          label: `Reset ${block?.name || frameId}`,
          inverse: async () => {
            try {
              await api.dailyFrame.setOverride(targetDs, frameId, prev);
              refreshOverrides();
            } catch (e) { console.error('Frame reset undo failed', e); }
          },
        });
      }
    } catch (e) {
      console.error('Frame reset failed', e);
    }
  }, [frames, frameOverrides, refreshOverrides, pushUndo]);

  // Edit-mode template writes — each gesture edits that column's weekday
  // template (frames[weekday]) in Schedule.md via writeFrames, live (no Save).
  const handleFrameRetime = useCallback(async (ds, frameId, startHM, endHM) => {
    const wd = weekdayForKey(ds).toLowerCase();
    const list = frames[wd] || [];
    const idx = list.findIndex(b => b.id === frameId);
    if (idx < 0) return;
    if (list[idx].start === startHM && list[idx].end === endHM) return;
    const next = { ...frames, [wd]: list.map((b, i) => i === idx ? { ...b, start: startHM, end: endHM } : b) };
    const prevFrames = frames;
    const label = list[idx].name;
    try {
      await writeFrames(next);
      if (pushUndo) pushUndo({ label: `Edit ${label}`, inverse: async () => { try { await writeFrames(prevFrames); } catch (e) { console.error('Frame retime undo failed', e); } } });
    } catch (e) { console.error('Frame retime failed', e); }
  }, [frames, writeFrames, pushUndo]);

  const handleFrameCreate = useCallback(async (ds, startHM, endHM, name) => {
    const wd = weekdayForKey(ds).toLowerCase();
    const list = frames[wd] || [];
    const block = { id: makeUniqueId(list, name), name: name.trim(), start: startHM, end: endHM, planned: false };
    const dayNext = [...list, block];
    const errs = validateDay(dayNext);
    if (Object.keys(errs).length > 0) { console.warn('Frame create invalid — skipped', errs); return; }
    const prevFrames = frames;
    try {
      await writeFrames({ ...frames, [wd]: dayNext });
      if (pushUndo) pushUndo({ label: `Add ${block.name}`, inverse: async () => { try { await writeFrames(prevFrames); } catch (e) { console.error('Frame create undo failed', e); } } });
    } catch (e) { console.error('Frame create failed', e); }
  }, [frames, writeFrames, pushUndo]);

  const handleFrameDelete = useCallback(async (ds, frameId) => {
    const wd = weekdayForKey(ds).toLowerCase();
    const list = frames[wd] || [];
    const block = list.find(b => b.id === frameId);
    if (!block) return;
    const prevFrames = frames;
    try {
      await writeFrames({ ...frames, [wd]: list.filter(b => b.id !== frameId) });
      if (pushUndo) pushUndo({ label: `Delete ${block.name}`, inverse: async () => { try { await writeFrames(prevFrames); } catch (e) { console.error('Frame delete undo failed', e); } } });
    } catch (e) { console.error('Frame delete failed', e); }
  }, [frames, writeFrames, pushUndo]);

  const handleFrameRename = useCallback(async (ds, frameId, name) => {
    const wd = weekdayForKey(ds).toLowerCase();
    const list = frames[wd] || [];
    const idx = list.findIndex(b => b.id === frameId);
    if (idx < 0) return;
    const nm = name.trim();
    if (!nm || nm === list[idx].name) return;
    const prevFrames = frames;
    const prevName = list[idx].name;
    try {
      await writeFrames({ ...frames, [wd]: list.map((b, i) => i === idx ? { ...b, name: nm } : b) });
      if (pushUndo) pushUndo({ label: `Rename ${prevName}`, inverse: async () => { try { await writeFrames(prevFrames); } catch (e) { console.error('Frame rename undo failed', e); } } });
    } catch (e) { console.error('Frame rename failed', e); }
  }, [frames, writeFrames, pushUndo]);

  // Shift a (possibly midnight-wrapping) frame's start AND end by deltaMins,
  // preserving duration — the edit-mode drag gesture for re-timing a wrap frame
  // whose split head/tail segments a single edge-drag can't express. Template
  // write + undo (mirrors handleFrameRetime).
  const handleFrameShift = useCallback(async (ds, frameId, deltaMins) => {
    const delta = Math.round(deltaMins / 15) * 15;
    if (!delta) return;
    const wd = weekdayForKey(ds).toLowerCase();
    const list = frames[wd] || [];
    const idx = list.findIndex(b => b.id === frameId);
    if (idx < 0) return;
    const b = list[idx];
    const toMins = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
    const wrap = (m) => ((m % 1440) + 1440) % 1440;
    const sMins = toMins(b.start);
    const eMins = b.end === '24:00' ? 1440 : toMins(b.end);
    const newStart = minsToHM(wrap(sMins + delta));
    const neRaw = wrap(eMins + delta);
    const newEnd = (neRaw === 0 && eMins === 1440) ? '24:00' : minsToHM(neRaw);
    if (newStart === b.start && newEnd === b.end) return;
    const next = { ...frames, [wd]: list.map((x, i) => i === idx ? { ...x, start: newStart, end: newEnd } : x) };
    const prevFrames = frames;
    try {
      await writeFrames(next);
      if (pushUndo) pushUndo({ label: `Move ${b.name}`, inverse: async () => { try { await writeFrames(prevFrames); } catch (e) { console.error('Frame shift undo failed', e); } } });
    } catch (e) { console.error('Frame shift failed', e); }
  }, [frames, writeFrames, pushUndo]);

  return {
    frameSegments,
    mergeIntoSessions,
    frames, overrides: frameOverrides, refreshOverrides, writeFrames,
    restoreDeleted: handleFrameRestoreDeleted,
    handlers: {
      onFrameDrop: handleFrameDrop,
      onFrameDeleteToday: handleFrameDeleteToday,
      onFrameReset: handleFrameReset,
      onFrameRetime: handleFrameRetime,
      onFrameResize: handleFrameResize,
      onFrameCreate: handleFrameCreate,
      onFrameDelete: handleFrameDelete,
      onFrameRename: handleFrameRename,
      onFrameShift: handleFrameShift,
    },
  };
}
