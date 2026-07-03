// Live Broadcast engine state (SP2 SF4) — useCaptureState mirror.
//
// Backend contract (commands/broadcast.rs + broadcast/client.rs + the lib.rs
// bridge): `broadcast_get_state` returns Option<StateSnapshot> — null when the
// engine is down (NOT an error), so we treat null as a calm down state and
// NEVER throw. Every update is a setState (DownloadsProvider listen idiom).
//
// Deltas vs capture: broadcast splits the one folded event into THREE —
// `broadcast-state` (StateSnapshot), `broadcast-error` (ProtoError
// {code,message}), `broadcast-engine-status` (EngineStatus, camelCase).
// The snapshot envelope is snake_case (state / recording.elapsed_ns / …).
//
// Resync poll — required, not a nicety: the engine's boot-time push_state
// fires before its socket accepts any connection (zero subscribers, event
// dropped), so neither first boot nor a respawn ever delivers an unsolicited
// snapshot. While the supervisor says the engine should be serving
// (spawning/up/adopted) and we hold no snapshot, re-fetch on a short interval;
// the interval exists only inside that window.

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

const RESYNC_MS = 1200;

export default function useBroadcastState(api) {
  const [snapshot, setSnapshot] = useState(null); // StateSnapshot | null (engine down)
  const [error, setError] = useState(null);       // ProtoError { code, message } | null
  const [engine, setEngine] = useState(null);     // EngineStatus { state, restartCount, lastExitCode, message }

  // Initial state fetch — graceful: null on a down engine, never throw.
  useEffect(() => {
    let alive = true;
    api.invoke('broadcast_get_state')
      .then((snap) => { if (alive) setSnapshot(snap || null); })
      .catch(() => { if (alive) setSnapshot(null); });
    return () => { alive = false; };
  }, [api]);

  // Live subscriptions (they survive navigation).
  useEffect(() => {
    const subs = [
      listen('broadcast-state', (e) => {
        const p = e.payload;
        if (!p) return;
        if (typeof p.state === 'string' && ('recording' in p || 'scenes' in p)) {
          setSnapshot(p);
          setError(null);
        }
      }),
      listen('broadcast-error', (e) => { if (e.payload) setError(e.payload); }),
      listen('broadcast-engine-status', (e) => {
        const s = e.payload;
        if (!s) return;
        setEngine(s);
        // A stale snapshot must not read as alive once the engine is gone.
        if (s.state === 'down' || s.state === 'failed') setSnapshot(null);
      }),
    ];
    return () => subs.forEach((pr) => pr.then((un) => un()).catch(() => {}));
  }, []);

  // Bounded resync poll across the down→serving window (see header).
  const engineState = engine?.state;
  const needsResync = snapshot == null && (engineState === 'spawning' || engineState === 'up' || engineState === 'adopted');
  useEffect(() => {
    if (!needsResync) return;
    let alive = true;
    const fetchState = () => {
      api.invoke('broadcast_get_state')
        .then((snap) => { if (alive && snap) setSnapshot(snap); })
        .catch(() => {});
    };
    fetchState();
    const t = setInterval(fetchState, RESYNC_MS);
    return () => { alive = false; clearInterval(t); };
  }, [needsResync, api]);

  return { snapshot, error, engine, alive: snapshot != null };
}
