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

export const DOWNLOAD_DOT_COLOR = {
  'Queued': 'var(--text-faint)',
  'Downloading': null,
  'Failed': 'var(--text)',
  'Error': 'var(--text)',
  'Stalled': '#d9a55a',
};

export function resolveDot(map, value, accent) {
  if (!value) return null;
  if (!(value in map)) return 'var(--text-muted)';
  return map[value] === null ? accent : map[value];
}
