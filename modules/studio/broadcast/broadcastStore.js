// Shared module store (SP3) — the sidebar tree and the page are SEPARATE slot
// roots (renderSecondary vs registerRoute), so cross-root UI state lives in a
// module-level external store consumed via useSyncExternalStore. Snapshot
// state does NOT live here (useBroadcastState owns it, event-driven); this is
// only the UI-side state both roots share.

import { useSyncExternalStore } from 'react';

let state = {
  // { scene: string, itemId: number } | null — mirrored to the engine via
  // select_item so the preview selection box tracks the tree.
  selection: null,
  // { scene: string, itemId: number|null } | null — itemId null = the scene
  // row itself is renaming. Set right after add-source (rename armed).
  renameTarget: null,
  inspectorOpen: false,
  // scene name -> [[itemId, visible], ...] — alt-click-eye solo stash (SF7).
  soloStash: new Map(),
};

const listeners = new Set();

export function getBroadcastUi() {
  return state;
}

export function updateBroadcastUi(patch) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useBroadcastUi() {
  return useSyncExternalStore(subscribe, getBroadcastUi);
}

/// One-line engine verb call over the SP3 passthrough command. Returns the
/// reply data (or throws the command error).
export function verb(api, op, args) {
  return api.invoke('broadcast_request', { op, args: args ?? null });
}
