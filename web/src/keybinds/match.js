// Pure matcher: does a KeyboardEvent satisfy a chord binding?
//
// 'meta' modifier is platform-primary: it matches either e.metaKey (Mac Cmd)
// or e.ctrlKey (Win/Linux Ctrl). This preserves the existing global handler
// behavior in App.jsx (`const meta = e.metaKey || e.ctrlKey`).
//
// Hold-style bindings are matched by useKeybindHold directly against
// e.key === binding.modifier; this matcher only handles chords.

export function matchChord(e, binding) {
  if (!binding || binding.kind !== 'chord' || !binding.key) return false;
  const wantKey = String(binding.key).toLowerCase();
  const gotKey = String(e.key || '').toLowerCase();
  if (wantKey !== gotKey) return false;

  const mods = new Set(binding.modifiers || []);
  const wantMetaPrimary = mods.has('meta');
  const gotMetaPrimary  = e.metaKey || e.ctrlKey;
  if (wantMetaPrimary !== gotMetaPrimary) return false;

  if (mods.has('shift') !== e.shiftKey) return false;
  if (mods.has('alt')   !== e.altKey)   return false;

  return true;
}

// Two bindings refer to the same input gesture if they have the same kind,
// the same key (case-insensitive) or modifier, and the same modifier set.
// Used by the editor to detect conflicts and auto-unbind the previous owner.
export function bindingsEqual(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'hold') return a.modifier === b.modifier;
  if (a.kind === 'chord') {
    if (String(a.key || '').toLowerCase() !== String(b.key || '').toLowerCase()) return false;
    const am = new Set(a.modifiers || []);
    const bm = new Set(b.modifiers || []);
    if (am.size !== bm.size) return false;
    for (const m of am) if (!bm.has(m)) return false;
    return true;
  }
  return false;
}
