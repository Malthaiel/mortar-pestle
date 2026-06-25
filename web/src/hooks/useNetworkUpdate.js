// Network auto-updater — wraps @tauri-apps/plugin-updater (GitHub Releases).
//
// `checkForUpdate()` is the raw probe, shared by NotificationProvider's
// startup check and the interactive panel hook. `useNetworkUpdate()` drives
// the merged "Check for updates" surface in Settings ▸ System: manual + a
// silent auto-check on open, download with progress, install, then relaunch
// via the `app_relaunch` command (reuses the same app.restart() path as the
// local self-updater — no extra dependency).
//
// This is the real distribution updater. The on-disk self-updater
// (useUpdateStatus) is a separate LOCAL dev-rebuild signal; both feed the one
// Updates section.

import { useCallback, useEffect, useRef, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { invoke } from '../api.js';

const IN_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

// Raw check. Returns the live Update handle (truthy ⇒ an update is available)
// or null when up to date. Throws on network/parse errors (e.g. no published
// release yet) — callers decide whether to surface that.
export async function checkForUpdate() {
  if (!IN_TAURI) return null;
  return check();
}

export function useNetworkUpdate({ autoCheck = true } = {}) {
  const [phase, setPhase] = useState('idle');   // idle|checking|available|uptodate|downloading|installing|error
  const [info, setInfo] = useState(null);       // { version, currentVersion, notes, date }
  const [progress, setProgress] = useState(0);  // 0..1
  const [error, setError] = useState(null);
  const updateRef = useRef(null);               // live Update handle for the install step

  const runCheck = useCallback(async ({ silent = false } = {}) => {
    if (!IN_TAURI) { if (!silent) { setPhase('error'); setError('not in Tauri shell'); } return; }
    setError(null);
    if (!silent) setPhase('checking');
    try {
      const update = await checkForUpdate();
      if (update) {
        updateRef.current = update;
        setInfo({
          version: update.version,
          currentVersion: update.currentVersion,
          notes: (update.body || '').trim(),
          date: update.date || null,
        });
        setPhase('available');
      } else {
        setPhase('uptodate');
      }
    } catch (e) {
      const msg = (e && (e.message || e.toString())) || 'update check failed';
      if (silent) setPhase('idle');             // background populate: stay quiet (no release yet / offline)
      else { setPhase('error'); setError(msg); }
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setError(null); setProgress(0); setPhase('downloading');
    try {
      let total = 0, got = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') { total = event.data?.contentLength || 0; setProgress(0); }
        else if (event.event === 'Progress') { got += event.data?.chunkLength || 0; if (total > 0) setProgress(Math.min(1, got / total)); }
        else if (event.event === 'Finished') { setProgress(1); setPhase('installing'); }
      });
      // Installed — relaunch into the freshly-installed binary.
      await invoke('app_relaunch');
    } catch (e) {
      setPhase('error');
      setError((e && (e.message || e.toString())) || 'install failed');
    }
  }, []);

  // Silent auto-check shortly after mount so the panel shows live status when
  // opened (and the startup toast path lives in NotificationProvider).
  useEffect(() => {
    if (!IN_TAURI || !autoCheck) return;
    const t = setTimeout(() => runCheck({ silent: true }), 1200);
    return () => clearTimeout(t);
  }, [autoCheck, runCheck]);

  return { phase, info, progress, error, check: runCheck, downloadAndInstall };
}
