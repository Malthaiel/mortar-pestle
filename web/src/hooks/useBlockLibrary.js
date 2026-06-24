// Planner block library — reads/writes `Iskariel/Block Library.md`.
//
// The file is canonical (Build Convention #8) and editable in Obsidian. The
// vault watcher's `manifest` event triggers a refresh, so external edits
// flow through. Writes round-trip the mtime returned by the prior read to
// catch concurrent-edit conflicts (the standard pattern used by daily-log
// writers — see SF3.5 in api.js).

import { useCallback, useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';

export function useBlockLibrary() {
  const [blocks, setBlocks] = useState([]);
  const [mtime, setMtime] = useState(null);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.blockLibrary.read();
      setBlocks(r.blocks);
      setMtime(r.mtime);
      setExists(r.exists);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.blockLibrary.read()
      .then(r => {
        if (cancelled) return;
        setBlocks(r.blocks);
        setMtime(r.mtime);
        setExists(r.exists);
      })
      .catch(e => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    const unsub = subscribeEvents((name) => {
      if (name === 'manifest') refresh();
    });
    return () => { cancelled = true; unsub(); };
  }, [refresh]);

  const writeBlocks = useCallback(async (next) => {
    const r = await api.blockLibrary.write(next, mtime);
    setBlocks(next);
    setMtime(r.mtime);
    setExists(true);
    return r;
  }, [mtime]);

  const upsertBlock = useCallback(async (block) => {
    const next = [...blocks];
    const idx = next.findIndex(b => b.id === block.id);
    if (idx >= 0) next[idx] = block;
    else next.push(block);
    return writeBlocks(next);
  }, [blocks, writeBlocks]);

  const deleteBlock = useCallback(async (id) => {
    return writeBlocks(blocks.filter(b => b.id !== id));
  }, [blocks, writeBlocks]);

  return {
    blocks,
    exists,
    loading,
    error,
    mtime,
    refresh,
    writeBlocks,
    upsertBlock,
    deleteBlock,
  };
}
