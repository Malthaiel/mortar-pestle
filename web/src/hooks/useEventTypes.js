// Planner event types — reads/writes `Iskariel/Event Types.md`, mirroring
// useBlockLibrary. The file is canonical (Build Convention #8) and editable in
// Obsidian; the vault watcher's `manifest` event triggers a refresh. Writes
// round-trip the prior read's mtime for conflict safety. When the file is
// absent, the General default set is surfaced so the New Event popup always
// has types to pick (the first add persists them).

import { useCallback, useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';

export const DEFAULT_EVENT_TYPES = [
  { id: 'appointment', name: 'Appointment', color: 'oklch(0.68 0.15 25)' },
  { id: 'meeting',     name: 'Meeting',     color: 'oklch(0.70 0.14 145)' },
  { id: 'deadline',    name: 'Deadline',    color: 'oklch(0.68 0.18 305)' },
  { id: 'reminder',    name: 'Reminder',    color: 'oklch(0.75 0.13 85)' },
  { id: 'personal',    name: 'Personal',    color: 'oklch(0.70 0.12 235)' },
];

export function useEventTypes() {
  const [types, setTypes] = useState([]);
  const [mtime, setMtime] = useState(null);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.eventTypes.read();
      setTypes(r.types); setMtime(r.mtime); setExists(r.exists); setError(null);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.eventTypes.read()
      .then(r => { if (cancelled) return; setTypes(r.types); setMtime(r.mtime); setExists(r.exists); })
      .catch(e => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    const unsub = subscribeEvents((name) => { if (name === 'manifest') refresh(); });
    return () => { cancelled = true; unsub(); };
  }, [refresh]);

  const writeTypes = useCallback(async (next) => {
    const r = await api.eventTypes.write(next, mtime);
    setTypes(next); setMtime(r.mtime); setExists(true);
    return r;
  }, [mtime]);

  const addType = useCallback(async (type) => {
    const base = exists ? types : DEFAULT_EVENT_TYPES;
    const next = [...base];
    const idx = next.findIndex(t => t.id === type.id);
    if (idx >= 0) next[idx] = type; else next.push(type);
    return writeTypes(next);
  }, [exists, types, writeTypes]);

  // Remove a type by id. Past events keep their type name in markdown — only the
  // pickable set shrinks. Deleting the last type leaves an empty list (the file
  // now exists, so the General defaults no longer backfill).
  const removeType = useCallback(async (id) => {
    const base = exists ? types : DEFAULT_EVENT_TYPES;
    return writeTypes(base.filter(t => t.id !== id));
  }, [exists, types, writeTypes]);

  // Surface the General defaults only until the file exists; once it does, the
  // stored list is authoritative and may legitimately be empty.
  const effective = exists ? types : DEFAULT_EVENT_TYPES;

  return { types: effective, exists, loading, error, mtime, refresh, writeTypes, addType, removeType };
}
