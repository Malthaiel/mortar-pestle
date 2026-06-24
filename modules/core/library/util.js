// Shared helpers for the video tool (SeriesBrowser, SeriesDetail, EpisodeRow).

import { mediaUrl } from '@host/api.js';

export function coverSrc(image) {
  if (!image) return null;
  return mediaUrl(image) || null;
}

// Status dot colors. `null` means "use the page accent" (active state).
// Covers both video (watch-verb) and music (listen-verb) status enums.
export const STATUS_DOT_COLOR = {
  // Video
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

export const DOWNLOAD_DOT_COLOR = {
  'Queued': 'var(--text-faint)',
  'Downloading': null,
  'Failed': '#e07b7b',
  'Error': '#e07b7b',
  'Stalled': '#d9a55a',
};

export function resolveDot(map, value, accent) {
  if (!value) return null;
  if (!(value in map)) return 'var(--text-muted)';
  return map[value] === null ? accent : map[value];
}
