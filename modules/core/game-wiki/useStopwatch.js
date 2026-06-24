// Count-up stopwatch for the Notes timer (sub-plan 5). A pausable in-game clock the
// coach starts at kickoff so a note added while it runs gets a [m:ss] timestamp.
// Survives app reload / HMR: persisted state is { running, startEpochMs, accumulatedSec }
// and elapsed is recomputed from the wall clock on mount, so a reload never loses the
// clock and a missed tick self-corrects — the interval only repaints; epoch math is the
// truth. Keyed per scrim+match+team so each notes list keeps its own clock.
import { useCallback, useEffect, useRef, useState } from 'react';

function load(key) {
  try {
    const j = JSON.parse(localStorage.getItem(key) || 'null');
    if (j && typeof j === 'object') return { running: !!j.running, startEpochMs: j.startEpochMs ?? null, accumulatedSec: Number(j.accumulatedSec) || 0 };
  } catch { /* unreadable / blocked */ }
  return { running: false, startEpochMs: null, accumulatedSec: 0 };
}

function elapsedOf(st) {
  return st.running && st.startEpochMs
    ? st.accumulatedSec + Math.max(0, Math.floor((Date.now() - st.startEpochMs) / 1000))
    : st.accumulatedSec;
}

export function useStopwatch(key) {
  const [st, setSt] = useState(() => load(key));
  const [elapsedSec, setElapsedSec] = useState(() => elapsedOf(st));

  // persist on every state change
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(st)); } catch { /* full / blocked */ } }, [key, st]);

  // recompute immediately when state changes + tick (repaint only) while running
  useEffect(() => {
    setElapsedSec(elapsedOf(st));
    if (!st.running) return undefined;
    const id = setInterval(() => setElapsedSec(elapsedOf(st)), 1000);
    return () => clearInterval(id);
  }, [st]);

  const elapsedRef = useRef(0);
  elapsedRef.current = elapsedSec;

  const start = useCallback(() => setSt((s) => (s.running ? s : { running: true, startEpochMs: Date.now(), accumulatedSec: s.accumulatedSec })), []);
  const pause = useCallback(() => setSt((s) => (s.running ? { running: false, startEpochMs: null, accumulatedSec: elapsedOf(s) } : s)), []);
  const reset = useCallback(() => setSt({ running: false, startEpochMs: null, accumulatedSec: 0 }), []);
  const toggle = useCallback(() => setSt((s) => (s.running
    ? { running: false, startEpochMs: null, accumulatedSec: elapsedOf(s) }
    : { running: true, startEpochMs: Date.now(), accumulatedSec: s.accumulatedSec })), []);

  return { elapsedSec, running: st.running, start, pause, resume: start, reset, toggle, elapsedRef };
}
