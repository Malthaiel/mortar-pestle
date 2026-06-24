// In-app updater state — subscribes to the Tauri `update-available` event,
// seeds initial state from `app_self_check_update`, and dispatches a
// window event the toast component listens for. Consumers (Sidebar dot,
// Settings drawer row, Toast) read `available` + `disk*` fields. The
// `dev.autoCheckUpdates` setting is checked at the consumer (this hook
// returns the raw state so a single Rust loop drives every surface).

import { useEffect, useRef, useState } from 'react';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { invoke } from '../api.js';

const IN_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

const EMPTY = {
  available: false,
  diskSha256Prefix: null,
  currentSha256Prefix: null,
  diskMtimeSecs: null,
  diskSize: null,
  prevExists: false,
};

function mapStatus(s) {
  if (!s) return EMPTY;
  return {
    available: !!s.available,
    diskSha256Prefix: s.diskSha256Prefix ?? null,
    currentSha256Prefix: s.currentSha256Prefix ?? null,
    diskMtimeSecs: typeof s.diskMtimeSecs === 'number' ? s.diskMtimeSecs : null,
    diskSize: typeof s.diskSize === 'number' ? s.diskSize : null,
    prevExists: !!s.prevExists,
  };
}

export function useUpdateStatus() {
  const [status, setStatus] = useState(EMPTY);
  const dispatchedRef = useRef(false);

  useEffect(() => {
    if (!IN_TAURI) return;
    let cancelled = false;

    // Seed from a single immediate check so a freshly-mounted shell that
    // missed the emit (e.g. event landed before AppShell rendered) still
    // shows the dot. Don't dispatch the toast on initial seed — toast is
    // only for new transitions during the session.
    invoke('app_self_check_update').then(s => {
      if (cancelled) return;
      const mapped = mapStatus(s);
      setStatus(mapped);
      dispatchedRef.current = mapped.available;
    }).catch(() => {});

    const unlisten = tauriListen('update-available', e => {
      const mapped = mapStatus(e.payload);
      setStatus(mapped);
      if (mapped.available && !dispatchedRef.current) {
        dispatchedRef.current = true;
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('agentic:update-available', { detail: mapped }));
        }
      }
    });

    return () => {
      cancelled = true;
      unlisten.then(fn => fn()).catch(() => {});
    };
  }, []);

  return status;
}

export async function applyUpdate(expectedSha256Prefix) {
  if (!IN_TAURI) throw new Error('not in Tauri shell');
  return invoke('app_self_apply_update', { expectedSha256Prefix });
}

export async function revertUpdate() {
  if (!IN_TAURI) throw new Error('not in Tauri shell');
  return invoke('app_self_revert');
}

// Push a new poll cadence to the Rust loop. Accepts ms (matches the
// stored setting shape), converts to seconds, and clamps client-side so
// the IPC validation error never reaches users. The Rust side enforces
// the same 10..=3600 window — this is just a friendlier failure path.
export async function setPollInterval(ms) {
  if (!IN_TAURI) return;
  const secs = Math.max(10, Math.min(3600, Math.round(Number(ms) / 1000)));
  return invoke('app_self_set_poll_interval', { secs });
}
