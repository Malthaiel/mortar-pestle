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

import { createContext, useContext, useCallback, useEffect, useRef } from 'react';
import { libraryImportApi } from './api.js';
import { useJobQueue } from './useJobQueue.js';

const Ctx = createContext(null);

export function useImportJobs() {
  return useContext(Ctx) || { jobs: [], enqueue: async () => null, cancel: async () => {} };
}

const GREEN = 'var(--text-muted)';
const RED = 'var(--text)';
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
  // Hydrate covers a provider remount mid-import. The manifest watcher doesn't
  // fire on direct Library/*.md writes, so onDone re-broadcasts both
  // library-changed events (music import touches playlists + albums; MAL import
  // touches the anime series — both, harmless) so the grids re-list.
  const jobs = useJobQueue({
    statusFn: () => libraryImportApi.status(),
    progressEvent: 'library-import-progress',
    doneEvent: 'library-import-done',
    isActive: (x) => ACTIVE.has(x.state),
    onDone: (p) => {
      window.dispatchEvent(new CustomEvent('music-library-changed', { detail: p }));
      window.dispatchEvent(new CustomEvent('video-library-changed', { detail: p }));
    },
  });

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
