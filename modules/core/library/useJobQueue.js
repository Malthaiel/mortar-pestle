import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

// Shared background-job provider skeleton for the music/anime/import engines.
// Each engine's provider re-implemented the same three pieces byte-for-byte:
//   - `jobs` state,
//   - a mount effect that hydrates from `statusFn()` filtered by `isActive`,
//   - an effect that upserts by `job.id` on `progressEvent` and fires `onDone`
//     on `doneEvent`.
// The divergent parts (per-provider notification payload, enqueue/cancel, and
// the qBittorrent pre-flight) stay in each provider — this hook owns only the
// shared 80%.
export function useJobQueue({ statusFn, progressEvent, doneEvent, isActive, onDone }) {
  const [jobs, setJobs] = useState([]);

  // Subscribe BEFORE hydrating, and hydrate without clobbering. `listen()` is
  // async, so a listener attached after the hydrate call leaves a window where
  // a progress event is dropped — and nothing here ever re-polls, so the row
  // keeps a stale state forever (a job that finished still reading
  // "Preparing…"). Awaiting the subscriptions first closes that window; the
  // hydrate then only FILLS IN ids it hasn't already heard about, so an event
  // that lands mid-hydrate isn't overwritten by the older snapshot.
  // ponytail: no periodic re-poll, add when an event is proven lost anyway.
  useEffect(() => {
    let cancelled = false;
    const upsert = (job) => setJobs(prev => {
      const i = prev.findIndex(j => j.id === job.id);
      if (i === -1) return [...prev, job];
      const next = prev.slice();
      next[i] = job;
      return next;
    });
    const pProgress = listen(progressEvent, (e) => { if (e.payload && e.payload.id) upsert(e.payload); });
    const pDone = listen(doneEvent, (e) => { if (onDone) onDone(e.payload || {}); });

    Promise.all([pProgress, pDone])
      .then(() => statusFn())
      .then(j => {
        if (cancelled) return;
        const fresh = (j || []).filter(isActive);
        setJobs(prev => [...prev, ...fresh.filter(f => !prev.some(p => p.id === f.id))]);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      pProgress.then(f => f()).catch(() => {});
      pDone.then(f => f()).catch(() => {});
    };
  }, []);

  return jobs;
}
