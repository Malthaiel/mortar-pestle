// Global download aggregator — the single host-side source of truth for the
// Downloads dock button (badge) and the Downloads popup. The Library module's
// music + anime download providers are module-scoped (the host can't import
// across the module boundary), so this subscribes to the SAME Tauri events they
// emit (music/anime-download-progress + -done), hydrates in-flight jobs via the
// *_download_status commands, and loads finished jobs from the persisted history
// store (downloads_history_load). Everything is normalized into one row shape,
// split into `active` (in-flight) and `recent` (terminal, deduped vs history),
// and exposed with cancel / retry / clear / open / reveal actions.

import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { navigate } from '../router.js';

const Ctx = createContext(null);

const EMPTY = {
  active: [], recent: [], activeCount: 0,
  cancel: () => {}, retry: () => {}, clear: () => {}, open: () => {}, reveal: () => {}, reload: () => {},
};

export function useAllDownloads() {
  return useContext(Ctx) || EMPTY;
}

const ACTIVE_STATES = new Set(['queued', 'preparing', 'downloading']);
const STATE_ORDER = { downloading: 0, preparing: 1, queued: 2 };
const encodePath = (p) => String(p || '').split('/').map(encodeURIComponent).join('/');

function byActive(a, b) {
  const d = (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3);
  if (d) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function musicStatus(j) {
  const failed = (j.failed && j.failed.length) || 0;
  if (j.state === 'queued') return j.queuePosition > 0 ? `Queued — #${j.queuePosition} in line` : 'Queued';
  if (j.state === 'downloading') return `${j.trackIndex || 0}/${j.trackTotal || 0}${j.trackTitle ? ` · ${j.trackTitle}` : ''}`;
  if (j.state === 'cancelled') return 'Cancelled';
  if (j.state === 'error') return j.error || 'Download failed';
  if (j.state === 'done') return failed ? `Done · ${failed} of ${j.trackTotal} failed` : `Downloaded · ${j.trackTotal} track${j.trackTotal === 1 ? '' : 's'}`;
  return '';
}

function animeStatus(j) {
  if (j.state === 'queued') return j.queuePosition > 0 ? `Queued — #${j.queuePosition} in line` : 'Queued';
  if (j.state === 'preparing') return 'Preparing…';
  if (j.state === 'downloading') {
    const pct = Math.round(j.progressPct || 0);
    return `${pct}%${j.filesTotal ? ` · ${j.filesDone || 0}/${j.filesTotal} files` : ''}`;
  }
  if (j.state === 'cancelled') return 'Cancelled';
  if (j.state === 'error') return j.error || 'Download failed';
  if (j.state === 'done') return 'Downloaded';
  return '';
}

function normMusic(j, nowMs) {
  const total = j.trackTotal || 0;
  const terminal = !ACTIVE_STATES.has(j.state);
  return {
    id: j.id, source: 'music', title: j.title || 'Album', subtitle: j.artist || '',
    cover: j.cover || null, state: j.state,
    progress: j.state === 'done' ? 1 : (total ? Math.min(1, (j.trackIndex || 0) / total) : 0),
    statusLine: musicStatus(j),
    finishedAt: terminal ? nowMs : null,
    openPath: j.albumPath || null, revealPath: j.savePath || null,
    sizeBytes: j.sizeBytes ?? null, speed: j.dlSpeed ?? null, eta: j.etaSecs ?? null, savePath: j.savePath ?? null,
    failedCount: (j.failed && j.failed.length) || 0, error: j.error || null,
    args: { kind: 'music', rgMbid: j.rgMbid, title: j.title, artist: j.artist, cover: j.cover ?? null, onlyMissing: !!j.onlyMissing },
    live: true,
  };
}

function normAnime(j, nowMs) {
  const terminal = !ACTIVE_STATES.has(j.state);
  return {
    id: j.id, source: 'video', title: j.title || 'Anime', subtitle: `${j.animeType || 'TV'} · ${j.audio || 'sub'}`,
    cover: j.image || null, state: j.state,
    progress: j.state === 'done' ? 1 : Math.min(1, (j.progressPct || 0) / 100),
    statusLine: animeStatus(j),
    finishedAt: terminal ? nowMs : null,
    openPath: j.seriesPath || null, revealPath: j.localPath || null,
    sizeBytes: j.sizeBytes ?? null, speed: j.dlSpeed ?? null, eta: j.etaSecs ?? null, savePath: j.savePath ?? null,
    failedCount: 0, error: j.error || null,
    // downloadSource is #[serde(skip)] on the live job; the persisted record
    // carries it, and retry is recent-only, so null here is fine.
    args: { kind: 'video', malId: j.malId, title: j.title, audio: j.audio, image: j.image ?? null, airing: !!j.airing, animeType: j.animeType, episodes: j.episodesTotal ?? null, downloadSource: null },
    live: true,
  };
}

// STT model download — the `stt-download-progress` / `stt-download-done` Tauri events
// emitted by `stt_download_model` (download ≠ activate). No cover, no library Open
// target; Reveal routes to the dedicated `stt_reveal_model` command (the cache lives
// under %LOCALAPPDATA%, outside `reveal_in_files`'s vault-containment gate).
function normStt(p, nowMs) {
  const pct = Math.round(p.pct || 0);
  return {
    id: `stt:${p.name}`, source: 'stt', title: p.name, subtitle: 'Speech model',
    cover: null, state: 'downloading', progress: Math.min(1, (p.pct || 0) / 100),
    statusLine: `${pct}%`,
    finishedAt: null, openPath: null, revealPath: p.revealPath ?? null,
    sizeBytes: null, speed: null, eta: null, savePath: null,
    failedCount: 0, error: null,
    args: { kind: 'stt', name: p.name }, live: true,
  };
}

function normSttDone(p, nowMs) {
  const cancelled = p.code === 'cancelled';
  const state = p.ok ? 'done' : cancelled ? 'cancelled' : 'error';
  return {
    id: `stt:${p.name}`, source: 'stt', title: p.name, subtitle: 'Speech model',
    cover: null, state, progress: p.ok ? 1 : 0,
    statusLine: p.ok ? 'Downloaded' : cancelled ? 'Cancelled' : (p.error || 'Download failed'),
    finishedAt: nowMs, openPath: null, revealPath: p.revealPath ?? null,
    sizeBytes: null, speed: null, eta: null, savePath: null,
    failedCount: 0, error: p.ok ? null : (p.error || null),
    args: { kind: 'stt', name: p.name }, live: false,
  };
}

function normHistory(r) {
  let statusLine;
  if (r.state === 'error') statusLine = r.error || 'Download failed';
  else if (r.state === 'cancelled') statusLine = 'Cancelled';
  else statusLine = r.source === 'music' && r.failedCount ? `Done · ${r.failedCount} failed` : 'Downloaded';
  return {
    id: r.id, source: r.source, title: r.title || (r.source === 'music' ? 'Album' : r.source === 'stt' ? 'Speech model' : 'Anime'),
    subtitle: r.subtitle || '', cover: r.cover || null, state: r.state,
    progress: r.state === 'done' ? 1 : 0, statusLine,
    finishedAt: r.finishedAt || 0,
    openPath: r.openPath || null, revealPath: r.revealPath || null,
    sizeBytes: r.sizeBytes ?? null, speed: null, eta: null, savePath: r.savePath ?? null,
    failedCount: r.failedCount || 0, error: r.error || null,
    args: r.args || null, live: false,
  };
}

export function DownloadsProvider({ children, settings }) {
  const cap = settings?.downloads?.historyCap ?? 100;
  const expiryDays = settings?.downloads?.historyExpiryDays ?? 30;

  const [liveById, setLiveById] = useState({});   // id -> normalized live row
  const [history, setHistory] = useState([]);     // HistoryRecord[] (raw)

  const upsertLive = useCallback((row) => {
    setLiveById(prev => ({ ...prev, [row.id]: row }));
  }, []);

  const reloadHistory = useCallback(() => {
    invoke('downloads_history_load', { cap, expiryDays })
      .then(rows => setHistory(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, [cap, expiryDays]);

  // Hydrate in-flight jobs once on mount (covers a provider mount mid-run).
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    invoke('music_download_status', {}).then(js => {
      if (!cancelled) (js || []).forEach(j => upsertLive(normMusic(j, now)));
    }).catch(() => {});
    invoke('anime_download_status', {}).then(js => {
      if (!cancelled) (js || []).forEach(j => upsertLive(normAnime(j, now)));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [upsertLive]);

  // (Re)load history on mount and whenever the retention settings change.
  useEffect(() => { reloadHistory(); }, [reloadHistory]);

  // Subscribe to the engines' live events (they survive navigation).
  useEffect(() => {
    const subs = [
      listen('music-download-progress', (e) => { if (e.payload && e.payload.id) upsertLive(normMusic(e.payload, Date.now())); }),
      listen('anime-download-progress', (e) => { if (e.payload && e.payload.id) upsertLive(normAnime(e.payload, Date.now())); }),
      listen('stt-download-progress', (e) => { if (e.payload && e.payload.name) upsertLive(normStt(e.payload, Date.now())); }),
      listen('music-download-done', () => reloadHistory()),
      listen('anime-download-done', () => reloadHistory()),
      listen('stt-download-done', (e) => {
        if (e.payload && e.payload.name) upsertLive(normSttDone(e.payload, Date.now()));
        reloadHistory();
      }),
    ];
    return () => subs.forEach(p => p.then(f => f()).catch(() => {}));
  }, [upsertLive, reloadHistory]);

  const { active, recent, activeCount } = useMemo(() => {
    const liveRows = Object.values(liveById);
    const activeRows = liveRows.filter(r => ACTIVE_STATES.has(r.state)).sort(byActive);
    // recent = terminal-live ∪ history, deduped by id; history overlays last
    // because it's authoritative (carries finishedAt + the full retry args).
    const byId = new Map();
    liveRows.filter(r => !ACTIVE_STATES.has(r.state)).forEach(r => byId.set(r.id, r));
    history.forEach(r => byId.set(r.id, normHistory(r)));
    let recentRows = Array.from(byId.values()).sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    // Client-side display filter so retention changes reflect instantly (the
    // Rust load already prunes the file; this just mirrors it in the UI).
    if (expiryDays > 0) {
      const cutoff = Date.now() - expiryDays * 86400000;
      recentRows = recentRows.filter(r => (r.finishedAt || 0) >= cutoff);
    }
    recentRows = recentRows.slice(0, Math.max(1, cap));
    return { active: activeRows, recent: recentRows, activeCount: activeRows.length };
  }, [liveById, history, cap, expiryDays]);

  const cancel = useCallback((row) => {
    if (row.source === 'stt') { invoke('stt_cancel').catch(() => {}); return; }
    const cmd = row.source === 'music' ? 'music_download_cancel' : 'anime_download_cancel';
    invoke(cmd, { jobId: row.id }).catch(() => {});
  }, []);

  const clear = useCallback((ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    invoke('downloads_history_clear', { ids: list }).catch(() => {});
    const drop = new Set(list);
    setHistory(prev => prev.filter(r => !drop.has(r.id)));
    setLiveById(prev => {
      const next = { ...prev };
      list.forEach(id => { if (next[id] && !ACTIVE_STATES.has(next[id].state)) delete next[id]; });
      return next;
    });
  }, []);

  const open = useCallback((row) => {
    if (!row.openPath) return;
    const base = row.source === 'music' ? '/tools/library/music/downloaded/' : '/tools/library/anime/';
    navigate(base + encodePath(row.openPath));
  }, []);

  const reveal = useCallback((row) => {
    // STT models live under %LOCALAPPDATA% (outside the vault-containment gate), so
    // route to the dedicated command by name; the path itself never crosses to JS.
    if (row.source === 'stt') {
      invoke('stt_reveal_model', { name: row.args?.name ?? row.title }).catch(() => {});
      return;
    }
    if (row.revealPath) invoke('reveal_in_files', { path: row.revealPath }).catch(() => {});
  }, []);

  const retry = useCallback(async (row) => {
    const a = row.args || {};
    try {
      if (row.source === 'stt') {
        // Re-download by name; the global stt-download-* events drive the popup, so
        // the throwaway Channel just satisfies the command signature.
        const ch = new Channel();
        await invoke('stt_download_model', { name: a.name ?? row.title, onEvent: ch });
        return;
      }
      if (row.source === 'music') {
        await invoke('music_download_enqueue', {
          rgMbid: a.rgMbid, title: a.title ?? row.title, artist: a.artist ?? row.subtitle,
          cover: a.cover ?? row.cover ?? null, onlyMissing: !!a.onlyMissing,
        });
      } else {
        // Mirror AnimeDownloadProvider's qBittorrent pre-flight so a retry never
        // silently stalls in the Rust poll loop.
        const qbit = await invoke('qbit_status', {}).catch(() => null);
        if (!qbit || !qbit.connected) {
          const why = (qbit && qbit.error) || 'qBittorrent isn’t reachable.';
          window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
            type: 'anime-download', title: 'Download blocked',
            message: `${why} Start it in Settings → Anime, then retry.`,
            accent: '#e07b7b', iconKey: 'alert', duration: 7000,
          } }));
          return;
        }
        await invoke('anime_download_enqueue', {
          malId: a.malId, title: a.title ?? row.title, audio: a.audio || 'sub',
          image: a.image ?? row.cover ?? null, airing: !!a.airing,
          animeType: a.animeType || 'TV', episodes: a.episodes ?? null,
          downloadSource: a.downloadSource ?? null,
        });
      }
    } catch (e) {
      window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
        type: 'download', title: 'Retry failed',
        message: String((e && e.message) || e || 'Could not start download'),
        accent: '#e07b7b', iconKey: 'alert', duration: 6000,
      } }));
    }
  }, []);

  // Manual refresh — re-pull persisted history + re-hydrate any in-flight jobs.
  const reload = useCallback(() => {
    reloadHistory();
    const now = Date.now();
    invoke('music_download_status', {}).then(js => {
      (js || []).forEach(j => upsertLive(normMusic(j, now)));
    }).catch(() => {});
    invoke('anime_download_status', {}).then(js => {
      (js || []).forEach(j => upsertLive(normAnime(j, now)));
    }).catch(() => {});
  }, [reloadHistory, upsertLive]);

  const value = useMemo(
    () => ({ active, recent, activeCount, cancel, retry, clear, open, reveal, reload }),
    [active, recent, activeCount, cancel, retry, clear, open, reveal, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
