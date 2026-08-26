// Anime download state, app-wide. Mirrors the music DownloadProvider: hydrates
// from `anime_download_status()` on mount, then patches on the Rust worker's
// `anime-download-progress` events (which survive navigation). `anime-download-done`
// is re-broadcast as a `video-library-changed` window event so the Downloaded tab
// (and Browse's in-library map) re-list the moment a download lands.
//
// Polling lives in the Rust worker (torrents are async); this provider is
// purely event-driven. Registered via index.jsx so it wraps the whole app.

import { createContext, useContext, useCallback, useEffect, useRef } from 'react';
import { videoApi } from './api.js';
import { useJobQueue } from './useJobQueue.js';

const Ctx = createContext(null);

export function useAnimeDownloads() {
  return useContext(Ctx) || { jobs: [], enqueue: async () => null, cancel: async () => {} };
}

export function AnimeDownloadProvider({ children }) {
  // Hydrate covers a provider remount mid-run. Direct Knowledge/*.md writes
  // don't trip the manifest watcher, so onDone re-broadcasts
  // `video-library-changed` so the Downloaded tab re-lists.
  const jobs = useJobQueue({
    statusFn: () => videoApi.animeDownloadStatus(),
    progressEvent: 'anime-download-progress',
    doneEvent: 'anime-download-done',
    isActive: (x) => x.state !== 'done' && x.state !== 'cancelled',
    onDone: (p) => window.dispatchEvent(new CustomEvent('video-library-changed', { detail: p })),
  });

  // Terminal toast: fire one app-wide notification per job that finishes or
  // fails, so feedback survives navigation (the download runs in Rust and
  // outlives the page that started it). Routed through the central
  // agentic:notify bus — the same surface updates/conflicts use — rather than a
  // bespoke floating stack, so it can't collide with the music download stack.
  const notified = useRef({});
  useEffect(() => {
    jobs.forEach(j => {
      if ((j.state === 'done' || j.state === 'error') && !notified.current[j.id]) {
        notified.current[j.id] = true;
        const ok = j.state === 'done';
        const add = !!j.metadataOnly;
        window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
          type: 'download', sourceId: j.id,
          title: j.title || 'Anime',
          message: ok ? (add ? 'Added to library' : 'Download complete') : (j.error || (add ? 'Add failed' : 'Download failed')),
          accent: ok ? 'var(--text-muted)' : 'var(--text)',
          iconKey: ok ? 'download' : 'alert',
          transient: true, duration: ok ? 5000 : null,
        } }));
      }
    });
  }, [jobs]);

  // No pre-flight any more: the engine lives inside the app, so there is no
  // daemon to be down or unauthenticated. (Was a qBittorrent reachability check
  // that blocked every download even though the built-in engine was perfectly
  // able to run.) A real failure now surfaces where it happens — the Rust add
  // returns an error and the job goes to Error with its message.
  const enqueue = useCallback(
    async ({ malId, title, audio, image, airing, type, episodes, downloadSource, metadataOnly, initialStatus }) => {
      return videoApi.animeDownloadEnqueue(malId, title, audio || 'sub', image || null, !!airing, type || 'TV', episodes ?? null, downloadSource || null, !!metadataOnly, initialStatus || null);
    },
    [],
  );
  const cancel = useCallback((jobId) => videoApi.animeDownloadCancel(jobId), []);

  return <Ctx.Provider value={{ jobs, enqueue, cancel }}>{children}</Ctx.Provider>;
}
