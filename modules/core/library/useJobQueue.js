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

  // Hydrate in-flight jobs on mount (covers a provider remount mid-run).
  useEffect(() => {
    let cancelled = false;
    statusFn()
      .then(j => { if (!cancelled) setJobs((j || []).filter(isActive)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const upsert = (job) => setJobs(prev => {
      const i = prev.findIndex(j => j.id === job.id);
      if (i === -1) return [...prev, job];
      const next = prev.slice();
      next[i] = job;
      return next;
    });
    const pProgress = listen(progressEvent, (e) => { if (e.payload && e.payload.id) upsert(e.payload); });
    const pDone = listen(doneEvent, (e) => { if (onDone) onDone(e.payload || {}); });
    return () => {
      pProgress.then(f => f()).catch(() => {});
      pDone.then(f => f()).catch(() => {});
    };
  }, []);

  return jobs;
}
