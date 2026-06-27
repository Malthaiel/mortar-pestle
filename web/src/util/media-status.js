// Shared status-dot palette for media pages (PageView renders any vault page
// including media entries; needs the status colors to draw frontmatter chips).
// The music + video modules keep their own copies under modules/core/<name>/
// util.js so they remain decoupled from host shape per the module-SDK rules.

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

export function resolveDot(map, value, accent) {
  if (!value) return null;
  if (!(value in map)) return 'var(--text-muted)';
  return map[value] === null ? accent : map[value];
}
