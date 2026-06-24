// React binding for the Password Vault store. Returns the live snapshot
// { status, entries, folders } and re-renders on any store mutation.

import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from './credsStore.js';

export function useCredsStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
