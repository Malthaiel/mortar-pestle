// Live capture state + clip list (Game Capture Step 4 frontend).
//
// Backend contract (commands/capture.rs + capture/client.rs + the lib.rs
// bridge): `get_capture_state` returns Option<StateSnapshot> — null when the
// engine is down (gate 5b — NOT an error), so we treat null as a calm idle
// state and NEVER throw. The page does not remount on each event — every
// update is a setState, mirroring DownloadsProvider's listen idiom.
//
// The snapshot envelope is snake_case (only its nested `config`/`audio` flip
// to camelCase). The `capture-state` event carries TWO disjoint payloads:
//   - a StateSnapshot (has `state`/`recording`/`config`)
//   - a folded engine error (has `code`/`message`/`fatal`)
// We discriminate by presence of `state`.

import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

export default function useCaptureState(api) {
  const [snapshot, setSnapshot] = useState(null);   // StateSnapshot | null (engine down)
  const [error, setError] = useState(null);         // folded engine error { code, message, fatal } | null
  const [engine, setEngine] = useState(null);       // EngineStatus { state, restartCount, lastExitCode, message }
  const [clips, setClips] = useState([]);           // ClipMeta[] (newest-first)

  const reloadClips = useCallback(() => {
    api.invoke('capture_list_clips')
      .then((list) => setClips(Array.isArray(list) ? list : []))
      .catch(() => setClips([]));
  }, [api]);

  // Initial state fetch — graceful: null/idle on a down engine, never throw.
  useEffect(() => {
    let alive = true;
    api.invoke('get_capture_state')
      .then((snap) => { if (alive) setSnapshot(snap || null); })
      .catch(() => { if (alive) setSnapshot(null); });
    return () => { alive = false; };
  }, [api]);

  // Initial clip list.
  useEffect(() => { reloadClips(); }, [reloadClips]);

  // Live subscriptions (they survive navigation). Mirror DownloadsProvider.
  useEffect(() => {
    const subs = [
      listen('capture-state', (e) => {
        const p = e.payload;
        if (!p) return;
        if (typeof p.state === 'string' && ('recording' in p || 'config' in p)) {
          setSnapshot(p);        // a StateSnapshot
          setError(null);
        } else if ('code' in p || 'message' in p) {
          setError(p);           // a folded engine error { code, message, fatal }
        }
      }),
      listen('capture-engine-status', (e) => { if (e.payload) setEngine(e.payload); }),
      // A saved clip lands → refresh the list (the file may not be on disk for
      // the first frame; capture_list_clips is the authority once it is) AND fire
      // an in-app bell toast (5-FB), so a save is acknowledged even when the user
      // is off the Capture page (the out-of-app notify-send only surfaces over a
      // fullscreen game). Mirrors the canonical emitNoteToast shape (api.js).
      listen('capture-saved', (e) => {
        reloadClips();
        const p = e.payload || {};
        window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
          type: 'note-info',
          title: 'Clip saved',
          message: p.game || p.name || 'Clip',
          accent: 'var(--accent)',
          iconKey: 'bell',
          duration: 4500,
        } }));
      }),
    ];
    return () => subs.forEach((pr) => pr.then((un) => un()).catch(() => {}));
  }, [reloadClips]);

  return { snapshot, error, engine, clips, reloadClips };
}
