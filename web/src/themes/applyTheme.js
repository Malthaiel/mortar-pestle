// Theme paint helpers — the single DOM writer for community-theme token maps.
// Both the committed apply effect (useSettings) and the transient hover-preview
// (ThemePicker) call these, so there is exactly one implementation and the
// preview can never drift from the commit.
//
// paintTheme sets each override token inline on the given root (normally
// document.documentElement); a null map or a missing key removes the inline
// value so the styles.css `:root` base re-shows. Iterating the fixed
// THEME_TOKEN_KEYS list guarantees a token set by a previous theme is cleared
// when switching to one that omits it.
import { THEME_TOKEN_KEYS } from './registry.js';

export function paintTheme(root, theme, resolvedTheme) {
  if (!root) return;
  const overrides = (theme && theme[resolvedTheme]) || null;
  for (const k of THEME_TOKEN_KEYS) {
    if (overrides && overrides[k] != null) root.style.setProperty(k, overrides[k]);
    else root.style.removeProperty(k);
  }
}

export function paintAccent(root, hex) {
  if (root && hex) root.style.setProperty('--accent', hex);
}
