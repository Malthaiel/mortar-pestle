// useUndoStack (SF8) — in-memory do/undo/redo for editList ops. Cap 200, a
// superset of usePlannerUndo (cap 20, no redo). Ops mutate in-memory project
// state and autosave persists the result — no IPC per undo, unlike the
// planner's per-op replay. History is NEVER persisted: a fresh project open
// starts with empty stacks, and a new op clears the redo branch.

import { useCallback, useRef, useState } from 'react';

export default function useUndoStack(cap = 200) {
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const [, bump] = useState(0);

  const push = useCallback((op) => {
    undoRef.current.push(op);
    if (undoRef.current.length > cap) undoRef.current.shift();
    redoRef.current = [];
    bump(n => n + 1);
  }, [cap]);

  const undo = useCallback(() => {
    const op = undoRef.current.pop() || null;
    if (op) { redoRef.current.push(op); bump(n => n + 1); }
    return op;
  }, []);

  const redo = useCallback(() => {
    const op = redoRef.current.pop() || null;
    if (op) { undoRef.current.push(op); bump(n => n + 1); }
    return op;
  }, []);

  const clear = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    bump(n => n + 1);
  }, []);

  return {
    push, undo, redo, clear,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
  };
}
