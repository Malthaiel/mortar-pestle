// Per-section "last viewed page" memory. Switching dock sections (Knowledge →
// Pulse → Knowledge) should restore the page you were on, not reset to the top
// sidebar item. We persist each section's sidebar `selectedPath` — which already
// lives in the same string space as item.path — under one localStorage key per
// section, so it survives reloads. Mirrors the recents store in useRecentPages.js.
//
// Storage: 'section:last-page:v1:<section>' → selectedPath
//   e.g. 'section:last-page:v1:knowledge' → '/knowledge/calisthenics/YouTube Pipeline'

const PREFIX = 'section:last-page:v1:';

export function readSectionPage(section) {
  try {
    const v = localStorage.getItem(PREFIX + section);
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// `key` is the sidebar selectedPath. No-ops on null/empty so the transient
// bare-route moment (selectedPath null, pre-redirect) never clobbers a saved value.
export function writeSectionPage(section, key) {
  try {
    if (key && typeof key === 'string') localStorage.setItem(PREFIX + section, key);
  } catch {}
}
