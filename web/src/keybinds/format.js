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

export { IS_MAC };
