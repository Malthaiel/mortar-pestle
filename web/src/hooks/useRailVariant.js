import { useCallback, useEffect, useState } from 'react';

const EVENT_NAME = 'agentic:rail-variant-changed';

function keyFor(moduleId) {
  return `module:${moduleId}:railVariant`;
}

function read(moduleId, fallback) {
  try {
    const v = localStorage.getItem(keyFor(moduleId));
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {}
  return fallback;
}

function write(moduleId, value) {
  try { localStorage.setItem(keyFor(moduleId), String(value)); } catch {}
}

// Imperative get/set for callers without a component (e.g. the app-wide context
// menu's rail-variant items). The hook below delegates to setRailVariant so the
// localStorage write + cross-instance broadcast live in one place.
export function readRailVariant(moduleId, fallback = null) {
  return read(moduleId, fallback);
}

export function setRailVariant(moduleId, id) {
  write(moduleId, id);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { moduleId, variantId: id } }));
}

export function useRailVariant(moduleId, fallback = null) {
  const [variantId, setVariantIdState] = useState(() => read(moduleId, fallback));

  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.moduleId === moduleId) {
        setVariantIdState(e.detail.variantId);
      }
    }
    window.addEventListener(EVENT_NAME, onChange);
    return () => window.removeEventListener(EVENT_NAME, onChange);
  }, [moduleId]);

  const setVariantId = useCallback((id) => {
    setVariantIdState(id);
    setRailVariant(moduleId, id);
  }, [moduleId]);

  return [variantId, setVariantId];
}
