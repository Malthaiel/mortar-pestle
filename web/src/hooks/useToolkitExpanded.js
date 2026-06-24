import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'toolkit:expanded:v1';

function read() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) return true;
    return v === 'true';
  } catch { return true; }
}

function write(value) {
  try { localStorage.setItem(STORAGE_KEY, String(!!value)); } catch {}
}

export function useToolkitExpanded() {
  const [expanded, setExpandedState] = useState(read);

  useEffect(() => {
    function onStorage(e) {
      if (e.key === STORAGE_KEY) setExpandedState(read());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setExpanded = useCallback((value) => {
    const v = !!value;
    setExpandedState(v);
    write(v);
  }, []);

  const toggle = useCallback(() => {
    setExpandedState(prev => {
      const next = !prev;
      write(next);
      return next;
    });
  }, []);

  return { expanded, setExpanded, toggle };
}
