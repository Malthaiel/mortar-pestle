// Thin client over the Rust recycling-bin commands. Rust + index.json is the
// single source of truth, so this hook holds only a local cache refreshed on
// open — no provider, one consumer (RecyclingBinModal). After a vault restore it
// best-effort regenerates the manifest (search / counts); the tree itself
// refreshes from the file watcher when the file reappears on disk.
import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api } from '../api.js';

export function useRecycleBin() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await invoke('recycle_bin_list'));
    } catch (e) {
      console.error('recycle_bin_list failed', e);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Retention sweep (age + count) then refresh — run on open.
  const purgeThenRefresh = useCallback(
    async (maxAgeDays, maxCount) => {
      try {
        await invoke('recycle_bin_purge', { maxAgeDays, maxCount });
      } catch (e) {
        console.error('recycle_bin_purge failed', e);
      }
      await refresh();
    },
    [refresh],
  );

  const read = useCallback((id) => invoke('recycle_bin_read', { id }), []);
  const restore = useCallback(
    (id, conflict = null, renameTo = null) =>
      invoke('recycle_bin_restore', { id, conflict, renameTo }),
    [],
  );
  const remove = useCallback((id) => invoke('recycle_bin_delete', { id }), []);
  const empty = useCallback(() => invoke('recycle_bin_empty'), []);

  // Mirror Settings retention to RecycleBin/retention.json so the Rust
  // startup-purge can read it (Settings live in localStorage).
  const setRetention = useCallback(
    (days, maxCount) =>
      invoke('recycle_bin_set_retention', { days, maxCount }).catch((e) =>
        console.error('recycle_bin_set_retention failed', e),
      ),
    [],
  );

  // Best-effort manifest regen so search / counts converge after a restore.
  const regenManifest = useCallback(async () => {
    try {
      const out = await api.vaults.list();
      if (out?.activeId) await api.vaults.generateManifest(out.activeId);
    } catch {
      /* non-critical */
    }
  }, []);

  return { items, loading, refresh, purgeThenRefresh, read, restore, remove, empty, regenManifest, setRetention };
}
