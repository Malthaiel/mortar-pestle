// React hooks that translate registry bindings into live keyboard behavior.
//
//   useKeybindAction(id, keybinds, handler)
//     Fires `handler` on chord match. `keybinds` is settings.keybinds; the
//     hook falls back to KEYBINDS_DEFAULT if the user has cleared the row
//     or the field is missing on first load.
//
//   useKeybindHold(id, keybinds) -> boolean
//     Returns true while the bound modifier key is held. Mirrors the
//     canonical pattern from Sidebar.jsx:81-102 verbatim.

import { useEffect, useState } from 'react';
import { matchChord } from './match.js';
import { KEYBINDS_DEFAULT } from './registry.js';

function isEditableTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}

export function useKeybindAction(id, keybinds, handler, opts) {
  const binding = keybinds?.[id] ?? KEYBINDS_DEFAULT[id];
  const key      = binding?.key;
  const modsSig  = (binding?.modifiers || []).slice().sort().join(',');
  const kind     = binding?.kind;
  // Some actions (notably Cmd+K command palette) want to fire even while
  // the focus is in a text input — they're global escape hatches. Default
  // behavior is to respect inputs (the safer choice).
  const ignoreEditable = !!opts?.ignoreEditableTarget;

  useEffect(() => {
    if (!binding || kind !== 'chord') return;
    const onKey = (e) => {
      if (!ignoreEditable && isEditableTarget(e.target)) return;
      if (matchChord(e, binding)) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // binding object identity changes on every setSetting; gate on its
    // semantic content (key + sorted modifiers + kind) plus the handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, modsSig, kind, handler, ignoreEditable]);
}

export function useKeybindHold(id, keybinds) {
  const binding = keybinds?.[id] ?? KEYBINDS_DEFAULT[id];
  const modifier = binding?.kind === 'hold' ? binding.modifier : null;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!modifier) { setHeld(false); return; }
    const onDown = (e) => {
      if (e.key !== modifier) return;
      if (isEditableTarget(e.target)) return;
      if (e.repeat) return;
      setHeld(true);
    };
    const onUp = (e) => {
      if (e.key !== modifier) return;
      setHeld(false);
    };
    const onBlur = () => setHeld(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [modifier]);

  return held;
}
