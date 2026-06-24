// Shared status-dot palette for media pages (PageView renders any vault page
// including media entries; needs the status colors to draw frontmatter chips).
// The music + video modules keep their own copies under modules/core/<name>/
// util.js so they remain decoupled from host shape per the module-SDK rules.

export const STATUS_DOT_COLOR = {
  // Video / film / TV
  'Plan-to-Watch': 'var(--text-muted)',
  'Currently-Watching': null,
  'Completed': '#6fb56f',
  'On-Hold': '#d9a55a',
  'Dropped': '#e07b7b',
  // Music
  'Plan-to-Listen': 'var(--text-muted)',
  'Currently-Listening': null,
  'Listened': '#6fb56f',
  // Books / written
  'Plan-to-Read': 'var(--text-muted)',
  'Currently-Reading': null,
  'Read': '#6fb56f',
  // Games / play
  'Plan-to-Play': 'var(--text-muted)',
  'Currently-Playing': null,
  'Played': '#6fb56f',
};

export function resolveDot(map, value, accent) {
  if (!value) return null;
  if (!(value in map)) return 'var(--text-muted)';
  return map[value] === null ? accent : map[value];
}
