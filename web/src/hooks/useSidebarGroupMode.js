// Tiny hook that returns the current sidebar group-collapse mode. Reads from
// the same localStorage blob useSettings persists, plus listens for an
// in-app broadcast so all sidebars update immediately when the setting
// changes (without prop drilling).

import { useEffect, useState } from 'react';

const EVENT = 'sidebar-group-mode-changed';
const DEFAULT = 'accordion';

function readMode() {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    if (raw.sidebarGroupMode === 'expanded' ||
        raw.sidebarGroupMode === 'accordion' ||
        raw.sidebarGroupMode === 'independent') {
      return raw.sidebarGroupMode;
    }
  } catch {}
  return DEFAULT;
}

export function emitSidebarGroupModeChange() {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useSidebarGroupMode() {
  const [mode, setMode] = useState(readMode);
  useEffect(() => {
    const handler = () => setMode(readMode());
    window.addEventListener(EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);
  return mode;
}
