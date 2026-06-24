// Library import state, app-wide. Holds the live job list for the import engine
// (CSV/TXT music in SF5, MAL XML anime in SF6): hydrates from
// `library_import_status()` on mount, patches on `library-import-progress`
// events (which survive drawer close / navigation), and on `library-import-done`
// re-broadcasts `music-library-changed` + `video-library-changed` window events
// so the grids re-list the moment cards land — and fires one completion
// notification through the agentic:notify bus. Mirrors DownloadProvider.
//
// Registered (via index.jsx) so it wraps the whole app; useImportJobs() reads it
// from the Settings Import sections.

import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { libraryImportApi } from './api.js';

const Ctx = createContext(null);

export function useImportJobs() {
  return useContext(Ctx) || { jobs: [], enqueue: async () => null, cancel: async () => {} };
}

const GREEN = '#6fb56f';
const RED = '#e07b7b';
const AMBER = '#d8a657';

function stateColor(job) {
  if (job.state === 'error') return RED;
  if (job.state === 'cancelled') return 'var(--text-muted)';
  if (job.state === 'done') return (job.unmatched && job.unmatched.length) ? AMBER : GREEN;
  return '#6c9fd8';
}

function terminalLine(job) {
  if (job.state === 'error') return job.error || 'Import failed';
  if (job.state === 'cancelled') return 'Import cancelled';
  return job.summary || 'Import complete';
}

const ACTIVE = new Set(['queued', 'parsing', 'importing']);

export function ImportProvider({ children }) {
  const [jobs, setJobs] = useState([]);

  // Hydrate in-flight jobs on mount (covers a provider remount mid-import).
  useEffect(() => {
    let cancelled = false;
    libraryImportApi.status()
      .then(j => { if (!cancelled) setJobs((j || []).filter(x => ACTIVE.has(x.state))); })
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
    const pProgress = listen('library-import-progress', (e) => { if (e.payload && e.payload.id) upsert(e.payload); });
    const pDone = listen('library-import-done', (e) => {
      // Manifest watcher doesn't fire on direct Library/*.md writes — tell the
      // grids to re-list directly. Music import touches both playlists + albums;
      // MAL import (SF6) touches the anime series — broadcast both, harmless.
      window.dispatchEvent(new CustomEvent('music-library-changed', { detail: e.payload || {} }));
      window.dispatchEvent(new CustomEvent('video-library-changed', { detail: e.payload || {} }));
    });
    return () => {
      pProgress.then(f => f()).catch(() => {});
      pDone.then(f => f()).catch(() => {});
    };
  }, []);

  // One terminal notification per job that finishes/fails/cancels, so feedback
  // survives the drawer closing. Lands in the notification panel.
  const notified = useRef({});
  useEffect(() => {
    jobs.forEach(j => {
      if ((j.state === 'done' || j.state === 'error' || j.state === 'cancelled') && !notified.current[j.id]) {
        notified.current[j.id] = true;
        window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
          type: 'import', sourceId: j.id,
          title: j.source || 'Import',
          message: terminalLine(j),
          accent: stateColor(j),
          iconKey: 'download', transient: false, duration: null,
          action: null,
        } }));
      }
    });
  }, [jobs]);

  const enqueue = useCallback(
    ({ kind, filePath, addAlbums, initialStatus }) =>
      libraryImportApi.enqueue(kind, filePath, !!addAlbums, initialStatus || null),
    [],
  );
  const cancel = useCallback((jobId) => libraryImportApi.cancel(jobId), []);

  return <Ctx.Provider value={{ jobs, enqueue, cancel }}>{children}</Ctx.Provider>;
}
