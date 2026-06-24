// Debounced project autosave (PageView precedent). Dirty on COMMITTED ops
// only — callers invoke markDirty at pointer-up / field commit, never per
// keystroke or per drag frame. 1.5 s debounce into vedit_project_save with
// the mtime conflict gate; flush on unmount / window blur / Ctrl+S (the page
// wires the key); discard on BEFORE_VAULT_SWITCH so a vault switch can't
// write a stale buffer (editorDirty.js contract).

import { useCallback, useEffect, useRef } from 'react';
import { markEditorDirty, clearEditorDirty, BEFORE_VAULT_SWITCH } from '@host/hooks/editorDirty.js';

const DEBOUNCE_MS = 1500;

export default function useAutosave({ api, name, getSnapshot, mtimeRef, onStatus }) {
  const timer = useRef(null);
  const dirtyRef = useRef(false);
  const inflight = useRef(false);
  const key = name ? `vedit:${name}` : null;

  const flush = useCallback(async () => {
    if (!key || !dirtyRef.current || inflight.current) return;
    clearTimeout(timer.current);
    inflight.current = true;
    try {
      const r = await api.invoke('vedit_project_save', {
        name,
        data: getSnapshot(),
        mtime: mtimeRef.current,
      });
      mtimeRef.current = r.mtime;
      dirtyRef.current = false;
      clearEditorDirty(key);
      onStatus?.({ state: 'saved', mtime: r.mtime });
    } catch (e) {
      onStatus?.({ state: 'error', error: e });
    } finally {
      inflight.current = false;
      // Edits that landed mid-save stay dirty and re-debounce.
      if (dirtyRef.current) timer.current = setTimeout(flush, DEBOUNCE_MS);
    }
  }, [api, name, getSnapshot, mtimeRef, key, onStatus]);

  const markDirty = useCallback(() => {
    if (!key) return;
    dirtyRef.current = true;
    markEditorDirty(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
    onStatus?.({ state: 'dirty' });
  }, [key, flush, onStatus]);

  useEffect(() => {
    if (!key) return undefined;
    const onBlur = () => { flush(); };
    const onSwitch = () => {
      clearTimeout(timer.current);
      dirtyRef.current = false;
      clearEditorDirty(key);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener(BEFORE_VAULT_SWITCH, onSwitch);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener(BEFORE_VAULT_SWITCH, onSwitch);
      flush(); // unmount flush
      clearEditorDirty(key);
    };
  }, [key, flush]);

  return { markDirty, flush };
}
