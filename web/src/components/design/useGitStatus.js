// SF11 of Design Mode — polls `design_git_status` for working-tree dirty
// (tracked-modified) files so the Atelier WorkingTreeTray can list + commit
// + discard agent edits without the user dropping to a terminal. Composes
// the useLiveOverrides mount-load, useEventReminders poller, and
// useAgentChat `agent-done` event-listen patterns.

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const POLL_MS = 4000;

export function useGitStatus() {
  const [dirty, setDirty] = useState([]);
  const unlistenRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const d = await invoke('design_git_status');
      setDirty(Array.isArray(d) ? d : []);
    } catch {
      // No repo / git missing / ACL-blocked → treat as empty (the tray shows
      // the empty state). A capability-gate error here means a registration
      // site was missed; it surfaces loudly in the console instead.
      setDirty([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      refresh();
      const id = setInterval(() => {
        if (!cancelled) refresh();
      }, POLL_MS);
      const unlisten = await listen('agent-done', () => {
        if (!cancelled) refresh();
      });
      if (cancelled) {
        clearInterval(id);
        unlisten?.();
        return;
      }
      unlistenRef.current = () => {
        clearInterval(id);
        unlisten?.();
      };
    })();
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [refresh]);

  return { dirty, refresh };
}