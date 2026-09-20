// Shared status-dot palette for media pages (PageView renders any vault page
// including media entries; needs the status colors to draw frontmatter chips).
// The music + video modules keep their own copies under modules/core/<name>/
// util.js so they remain decoupled from host shape per the module-SDK rules.

import { IconClock, IconPlay, IconCheck, IconPause, IconX } from '../components/icons.jsx';

export const STATUS_DOT_COLOR = {
  // Video / film / TV
  'Plan-to-Watch': 'var(--text-muted)',
  'Currently-Watching': null,
  'Completed': 'var(--text-muted)',
  'On-Hold': '#d9a55a',
  'Dropped': 'var(--text)',
  // Music
  'Plan-to-Listen': 'var(--text-muted)',
  'Currently-Listening': null,
  'Listened': 'var(--text-muted)',
  // Books / written
  'Plan-to-Read': 'var(--text-muted)',
  'Currently-Reading': null,
  'Read': 'var(--text-muted)',
  // Games / play
  'Plan-to-Play': 'var(--text-muted)',
  'Currently-Playing': null,
  'Played': 'var(--text-muted)',
};

// DISPLAY ONLY. The stored value stays the schema's listen-verb ('Plan-to-Listen'
// et al) — frontmatter, the Rust download/import defaults and every filter
// compare against those, so nothing here may leak into a write. Shortened
// user-directed 2026-09-11, applied wherever a status is drawn.
export const STATUS_LABEL = {
  'Plan-to-Listen': 'Planned',
  'Currently-Listening': 'Currently',
};

export const statusLabel = (s) => STATUS_LABEL[s] || s;

// Menu icon per stored status, one meaning per verb across every medium. Keyed on
// the STORED value, never on the shortened label.
const PLAN = IconClock, NOW = IconPlay, DONE = IconCheck;
export const STATUS_ICON = {
  'Plan-to-Watch': PLAN, 'Plan-to-Listen': PLAN, 'Plan-to-Read': PLAN, 'Plan-to-Play': PLAN,
  'Currently-Watching': NOW, 'Currently-Listening': NOW, 'Currently-Reading': NOW, 'Currently-Playing': NOW,
  Completed: DONE, Listened: DONE, Read: DONE, Played: DONE,
  'On-Hold': IconPause,
  Dropped: IconX,
};

export function resolveDot(map, value, accent) {
  if (!value) return null;
  if (!(value in map)) return 'var(--text-muted)';
  return map[value] === null ? accent : map[value];
}
