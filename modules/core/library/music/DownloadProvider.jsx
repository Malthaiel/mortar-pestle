// Download state, app-wide. Holds the live job list for the music download
// engine: hydrates from `music_download_status()` on mount, then patches on the
// Rust worker's `music-download-progress` events (which survive navigation —
// that's why the engine emits Tauri events, not a Channel). `music-download-done`
// is re-broadcast as a `music-library-changed` window event so AlbumBrowser
// re-lists the moment a download lands, without an app restart.
//
// Registered (via index.jsx) so it wraps the whole app. Fires one completion
// notification per terminal job through the agentic:notify bus — ported here
// when the music DownloadToastStack was retired in favor of the global
// Downloads popup, so completion feedback never lapses.

import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { musicApi } from './api.js';

const Ctx = createContext(null);

export function useDownloads() {
  return useContext(Ctx) || { jobs: [], enqueue: async () => null, cancel: async () => {} };
}

const GREEN = 'var(--text-muted)';
const RED = 'var(--text)';

function stateColor(job) {
  if (job.state === 'error') return RED;
  if (job.state === 'done') return (job.failed && job.failed.length) ? RED : GREEN;
  if (job.state === 'cancelled') return 'var(--text-muted)';
  return '#6c9fd8';
}

function terminalLine(job) {
  const failed = job.failed || [];
  if (job.state === 'error') return job.error || (job.metadataOnly ? 'Add failed' : 'Download failed');
  if (job.metadataOnly) return 'Added to library';
  if (failed.length) return `Done · ${failed.length} of ${job.trackTotal} failed`;
  return `Downloaded · ${job.trackTotal} track${job.trackTotal === 1 ? '' : 's'}`;
}

export function DownloadProvider({ children }) {
  const [jobs, setJobs] = useState([]);

  // Hydrate in-flight jobs on mount (downloads don't survive an app restart per
  // decision #4, so this is usually empty — but covers a provider remount mid-run).
  useEffect(() => {
    let cancelled = false;
    musicApi.downloadStatus()
      .then(j => { if (!cancelled) setJobs((j || []).filter(x => x.state === 'queued' || x.state === 'downloading')); })
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
    const pProgress = listen('music-download-progress', (e) => { if (e.payload && e.payload.id) upsert(e.payload); });
    const pDone = listen('music-download-done', (e) => {
      // Manifest watcher doesn't fire on direct Knowledge/*.md writes — tell the
      // library to re-list directly.
      window.dispatchEvent(new CustomEvent('music-library-changed', { detail: e.payload || {} }));
    });
    return () => {
      pProgress.then(f => f()).catch(() => {});
      pDone.then(f => f()).catch(() => {});
    };
  }, []);

  // Terminal notification: fire one app-wide agentic:notify per job that finishes
  // or fails, so completion feedback survives navigation. Ported from the retired
  // DownloadToastStack; mirrors AnimeDownloadProvider. Lands in the notification
  // panel with an "Open album" action.
  const notified = useRef({});
  useEffect(() => {
    jobs.forEach(j => {
      if ((j.state === 'done' || j.state === 'error') && !notified.current[j.id]) {
        notified.current[j.id] = true;
        window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
          type: 'download', sourceId: j.id,
          title: j.title || 'Album',
          message: terminalLine(j),
          accent: stateColor(j),
          iconKey: 'download', transient: false, duration: null,
          action: (j.state === 'done' && j.albumPath)
            ? { label: 'Open album', kind: 'open-album', payload: { albumPath: j.albumPath } }
            : null,
        } }));
      }
    });
  }, [jobs]);

  const enqueue = useCallback(
    ({ rgMbid, title, artist, cover, onlyMissing, metadataOnly, initialStatus }) =>
      musicApi.downloadEnqueue(rgMbid, title, artist, cover || null, !!onlyMissing, !!metadataOnly, initialStatus || null),
    [],
  );
  const cancel = useCallback((jobId) => musicApi.downloadCancel(jobId), []);

  return <Ctx.Provider value={{ jobs, enqueue, cancel }}>{children}</Ctx.Provider>;
}
