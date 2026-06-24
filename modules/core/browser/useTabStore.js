// React binding for the browser tab store. Returns the live snapshot
// { tabs, activeId, pinned, recent } and re-renders on any store mutation,
// including the Rust-driven `browser-tab-update` events.

import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from './tabStore.js';

export function useTabStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
