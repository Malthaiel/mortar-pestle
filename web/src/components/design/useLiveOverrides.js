// SF9/SF10 of Design Mode — single source of truth for pending design-mode
// overrides. Manages:
//   - the <style id="design-mode-overrides"> element in <head>
//   - the Tauri-persisted JSON at <app_config>/design-pending.json (SF10)
//   - the synthetic `aos-sel-<uuid>` class on each overridden DOM element
//
// On mount: invoke('design_pending_get') seeds local state; the style
// element is built; any selClasses are re-applied to matching DOM elements
// found via [data-aos-source][data-aos-component] selectors.
//
// On every pending change: serialize the style block + debounced (200ms)
// invoke('design_pending_set'). Off-screen elements (not currently in the
// DOM) stay in pending unchanged — the next mount that has them in the
// DOM re-applies their selClass.

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const STYLE_ELEMENT_ID = 'design-mode-overrides';
const selClassMap = new WeakMap(); // element -> selClass (stable per element across remounts)

function ensureStyleEl() {
  let el = document.getElementById(STYLE_ELEMENT_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    document.head.appendChild(el);
  }
  return el;
}

function serialize(pending) {
  const byClass = new Map();
  for (const o of pending) {
    if (!byClass.has(o.selClass)) byClass.set(o.selClass, []);
    byClass.get(o.selClass).push(o);
  }
  const rules = [];
  for (const [selClass, rows] of byClass.entries()) {
    const decls = rows.map((r) => {
      if (r.target === 'var') return `${r.name}: ${r.value};`;
      return `${r.name}: ${r.value} !important;`;
    }).join(' ');
    rules.push(`.${selClass} { ${decls} }`);
  }
  return rules.join('\n');
}

export function getOrCreateSelClass(element) {
  if (!element) return null;
  let sel = selClassMap.get(element);
  if (sel) return sel;
  sel = `aos-sel-${Math.random().toString(36).slice(2, 10)}`;
  selClassMap.set(element, sel);
  return sel;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function findMatchingElement(edit) {
  if (!edit.source || !edit.component) return null;
  // Escape attribute selector chars (most importantly the colons in line:col).
  const sourceEsc = CSS.escape(edit.source);
  const componentEsc = CSS.escape(edit.component);
  return document.querySelector(
    `[data-aos-source="${sourceEsc}"][data-aos-component="${componentEsc}"]`
  );
}

export function useLiveOverrides() {
  const [pending, setPendingState] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const pendingRef = useRef([]);
  pendingRef.current = pending;
  const persistTimer = useRef(null);

  // Load from Tauri on mount.
  useEffect(() => {
    let cancelled = false;
    invoke('design_pending_get')
      .then((edits) => {
        if (cancelled) return;
        setPendingState(Array.isArray(edits) ? edits : []);
        setLoaded(true);
      })
      .catch((e) => {
        console.warn('[design] design_pending_get failed:', e);
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // Sync the <style> block on every pending change (gate on `loaded` so the
  // initial empty state doesn't briefly clear prior overrides during the load).
  useEffect(() => {
    if (!loaded) return;
    const styleEl = ensureStyleEl();
    styleEl.textContent = serialize(pending);
  }, [pending, loaded]);

  // Re-apply synthetic classes to in-DOM elements after load and on each
  // pending change. Off-screen matches are skipped silently; the next render
  // that has them in the DOM picks them up.
  useEffect(() => {
    if (!loaded) return;
    for (const edit of pending) {
      const el = findMatchingElement(edit);
      if (el && !el.classList.contains(edit.selClass)) {
        el.classList.add(edit.selClass);
        // Stash the mapping so getOrCreateSelClass returns the same value
        // if Edit mode picks this element again.
        selClassMap.set(el, edit.selClass);
      }
    }
  }, [pending, loaded]);

  // Debounced Tauri persistence.
  useEffect(() => {
    if (!loaded) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      invoke('design_pending_set', { edits: pending }).catch((e) => {
        console.warn('[design] design_pending_set failed:', e);
      });
    }, 200);
    return () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
    };
  }, [pending, loaded]);

  const setOverride = useCallback((override) => {
    setPendingState((p) => {
      const idx = p.findIndex((x) => x.selClass === override.selClass && x.name === override.name);
      if (idx >= 0) {
        const next = [...p];
        next[idx] = { ...next[idx], ...override };
        return next;
      }
      return [...p, { id: uid(), ...override }];
    });
  }, []);

  const clearOverride = useCallback((selClass, name) => {
    setPendingState((p) => p.filter((x) => !(x.selClass === selClass && x.name === name)));
  }, []);

  const clearSelClass = useCallback((selClass) => {
    setPendingState((p) => p.filter((x) => x.selClass !== selClass));
  }, []);

  const clearById = useCallback((id) => {
    setPendingState((p) => p.filter((x) => x.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setPendingState([]);
  }, []);

  const setPending = useCallback((next) => {
    setPendingState(next);
  }, []);

  return {
    pending,
    loaded,
    setOverride,
    clearOverride,
    clearSelClass,
    clearById,
    clearAll,
    setPending,
  };
}
