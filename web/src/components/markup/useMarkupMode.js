// Markup mode on/off. Hover any element to see its name + ancestor breadcrumb;
// click copies the component name and source path to the clipboard.
//
// Toggled by the `markup.toggle` global keybind (see keybinds/registry.js).
// The body attribute drives the crosshair cursor rule in styles.css; it is
// deliberately still named data-design-pointer so that rule needs no change.
//
// Replaces the old useDesignPointer hook, which carried a second 'edit' mode
// and a capture-phase Esc handler that only existed to beat Design Mode's own
// Esc handler. With Design Mode gone, a plain bubble-phase listener is enough.

import { useCallback, useEffect, useState } from 'react';

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useMarkupMode() {
  const [markupOn, setMarkupOn] = useState(false);
  const toggleMarkup = useCallback(() => setMarkupOn((on) => !on), []);

  useEffect(() => {
    const body = document.body;
    if (!body) return;
    if (markupOn) body.setAttribute('data-design-pointer', 'markup');
    else body.removeAttribute('data-design-pointer');
    return () => body.removeAttribute('data-design-pointer');
  }, [markupOn]);

  useEffect(() => {
    if (!markupOn) return;
    const onKey = (e) => {
      if (e.key !== 'Escape' || isEditableTarget(e.target)) return;
      e.preventDefault();
      setMarkupOn(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [markupOn]);

  return { markupOn, toggleMarkup };
}
