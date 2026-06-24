// Sub-feature 6 — listens for `agentic:sidebar-row-persisted` window events
// and returns the id of the row that just persisted. Consumers apply a 120ms
// accent-glow animation to the matching row via `sidebar-row-drop-pulse`
// keyframe (styles.css). Fires only on user drag-drop → persist completion;
// never on hydrate or sibling broadcast. Self-clears after 140ms (120ms
// animation + 20ms slack) so reorders 200ms apart each pulse independently.

import { useEffect, useState } from 'react';

const EVENT = 'agentic:sidebar-row-persisted';

export function useDropPulse(key) {
  const [pulsingId, setPulsingId] = useState(null);

  useEffect(() => {
    if (!key) return;
    let timer = null;
    const onPersist = (e) => {
      if (e.detail?.key !== key) return;
      const id = e.detail.id;
      if (id == null) return;
      setPulsingId(id);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPulsingId(null), 140);
    };
    window.addEventListener(EVENT, onPersist);
    return () => {
      window.removeEventListener(EVENT, onPersist);
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return pulsingId;
}

export const SIDEBAR_ROW_PULSE_STYLE =
  'sidebar-row-drop-pulse 120ms cubic-bezier(0.32, 0.72, 0, 1)';
