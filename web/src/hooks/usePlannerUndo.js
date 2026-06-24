// Per-modal-session undo stack for the Planner. Scoped to a single open
// of PlannerModal — clear on close. Each entry is `{ label, inverse }`
// where `inverse` is an async function that reverts the action. The
// caller is responsible for capturing the necessary state (session id,
// metadata, etc.) in the closure passed as `inverse`.
//
// Stack is bounded to MAX_DEPTH (oldest entries drop off) so a long
// drop session can't accumulate unbounded memory.

import { useCallback, useRef, useState } from 'react';

const MAX_DEPTH = 20;

export function usePlannerUndo() {
  const stackRef = useRef([]);
  const [depth, setDepth] = useState(0);

  const push = useCallback((entry) => {
    if (!entry || typeof entry.inverse !== 'function') return;
    stackRef.current.push(entry);
    if (stackRef.current.length > MAX_DEPTH) {
      stackRef.current.shift();
    }
    setDepth(stackRef.current.length);
  }, []);

  const undo = useCallback(async () => {
    const entry = stackRef.current.pop();
    setDepth(stackRef.current.length);
    if (!entry) return null;
    try { await entry.inverse(); } catch (e) { console.error('Undo failed', e); }
    return entry.label || null;
  }, []);

  const clear = useCallback(() => {
    stackRef.current = [];
    setDepth(0);
  }, []);

  return { push, undo, clear, depth };
}
