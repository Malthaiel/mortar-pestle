// SF8 of Design Mode — pointer-mode state machine + body attribute
// synchronization + Esc handler. Pointer mode state: off | markup | edit.
//
// Body attribute drives the cursor style + CSS-side gating
// (`body[data-design-pointer="markup"] { cursor: crosshair; }`).
//
// Esc is registered in capture phase + calls stopImmediatePropagation so
// it lands BEFORE DesignModeOverlay's bubble-phase Esc handler — Esc in
// pointer mode clears the pointer, not the whole Design mode.
//
// Exposed as a hook (useDesignPointer) returning state + setters so
// AtelierChatWindow can read pointerMode for the segmented toggle, and
// MarkupOverlay can read it to decide whether to capture.

import { useCallback, useEffect, useRef, useState } from 'react';

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useDesignPointer() {
  const [pointerMode, setPointerModeState] = useState('off');
  const [selected, setSelected] = useState(null); // { name, source, rect, element, revealInfo }
  const pointerModeRef = useRef('off');

  const setPointerMode = useCallback((next) => {
    pointerModeRef.current = next;
    setPointerModeState(next);
    if (next === 'off') setSelected(null);
  }, []);

  // Reflect pointer mode to the body so the global cursor rule can target it.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    if (pointerMode === 'off') {
      body.removeAttribute('data-design-pointer');
    } else {
      body.setAttribute('data-design-pointer', pointerMode);
    }
    return () => body.removeAttribute('data-design-pointer');
  }, [pointerMode]);

  // Esc clears pointer mode in capture phase so it beats DesignModeOverlay's
  // bubble-phase handler. stopImmediatePropagation prevents the parent from
  // exiting Design mode entirely on the same Esc keystroke.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (isEditableTarget(e.target)) return;
      if (pointerModeRef.current === 'off') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Clear body attr synchronously so DesignModeOverlay's bubble-phase
      // handler (if it ever runs) sees the pointer as off.
      document.body.removeAttribute('data-design-pointer');
      pointerModeRef.current = 'off';
      setPointerModeState('off');
      setSelected(null);
    };
    window.addEventListener('keydown', onKey, true); // capture
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return { pointerMode, setPointerMode, selected, setSelected };
}
