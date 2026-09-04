// Pretty-print a binding as an array of key labels for chip rendering.
// Mac gets glyphs (⌘ ⌥ ⇧ ⌃); other platforms get text (Ctrl / Alt / Shift).
//
// Used by:
//   - KeyboardHintsOverlay (cheatsheet chips)
//   - KeybindsTab (current-binding chips per row)
//   - Conflict toast text

const IS_MAC = (() => {
  if (typeof navigator === 'undefined') return false;
  const p = navigator.userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(p);
})();

const KEY_GLYPHS = IS_MAC
  ? { meta: '⌘', alt: '⌥', shift: '⇧', ctrl: '⌃' }
  : { meta: 'Ctrl', alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl' };

const MODIFIER_GLYPH = IS_MAC
  ? { Meta: '⌘', Alt: '⌥', Shift: '⇧', Control: '⌃', Ctrl: '⌃' }
  : { Meta: 'Win', Alt: 'Alt', Shift: 'Shift', Control: 'Ctrl', Ctrl: 'Ctrl' };

function prettyKey(key) {
  if (!key) return '';
  if (key.length === 1) return key.toUpperCase();
  // Common named keys
  if (key === 'ArrowUp') return '↑';
  if (key === 'ArrowDown') return '↓';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  if (key === 'Escape') return 'Esc';
  if (key === ' ') return 'Space';
  return key;
}

export function formatBinding(binding) {
  if (!binding) return ['Unbound'];
  if (binding.kind === 'hold') {
    return [MODIFIER_GLYPH[binding.modifier] || binding.modifier];
  }
  if (binding.kind === 'chord') {
    const out = [];
    const mods = binding.modifiers || [];
    // Order: meta → ctrl → alt → shift → key (matches macOS HIG)
    if (mods.includes('meta')) out.push(KEY_GLYPHS.meta);
    if (mods.includes('ctrl') && !mods.includes('meta')) out.push(KEY_GLYPHS.ctrl);
    if (mods.includes('alt')) out.push(KEY_GLYPHS.alt);
    if (mods.includes('shift')) out.push(KEY_GLYPHS.shift);
    out.push(prettyKey(binding.key));
    return out;
  }
  return ['?'];
}

// Tauri accelerator string for a chord binding ("F6", "Shift+F6",
// "CommandOrControl+K") — the shape `global_shortcut`'s Shortcut::from_str
// parses. Returns '' for a hold binding or an empty key (an Unbound row), which
// Rust treats as "skip this one", not as an error.
//
// 'meta' is platform-primary in this registry (Ctrl on Windows), and
// CommandOrControl is the accelerator spelling of exactly that.
export function toAccelerator(binding) {
  if (!binding || binding.kind !== 'chord' || !binding.key) return '';
  const mods = binding.modifiers || [];
  const parts = [];
  if (mods.includes('meta')) parts.push('CommandOrControl');
  if (mods.includes('ctrl') && !mods.includes('meta')) parts.push('Control');
  if (mods.includes('alt')) parts.push('Alt');
  if (mods.includes('shift')) parts.push('Shift');
  const k = String(binding.key).trim();
  // F-keys and single characters are the only shapes these rows carry; anything
  // else goes through as-is and Rust logs an unparseable-accelerator warning
  // rather than binding something the user did not ask for.
  parts.push(/^f([1-9]|1\d|2[0-4])$/i.test(k) ? k.toUpperCase() : k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

export { IS_MAC };
