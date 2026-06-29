// Music module's copy of the cover-art / status-dot helpers. The video
// module owns its own copy at modules/core/library/util.js — duplication is
// preferred over cross-module imports per the W5 plan.

import { mediaUrl } from '@host/api.js';

export function coverSrc(image, width, opts) {
  if (!image) return null;
  const url = mediaUrl(image, opts) || null;
  // Local covers (mortar-pestle-asset:// scheme) support server-side resize via
  // ?w=<n>, which hits the cached-thumbnail path in the Rust asset protocol.
  // Remote URLs (http/data/blob) are returned untouched.
  if (width && url && url.startsWith('mortar-pestle-asset:')) {
    return url + (url.includes('?') ? '&' : '?') + 'w=' + width;
  }
  return url;
}

export const STATUS_DOT_COLOR = {
  'Plan-to-Watch': 'var(--text-muted)',
  'Currently-Watching': null,
  'Completed': 'var(--text-muted)',
  'On-Hold': '#d9a55a',
  'Dropped': 'var(--text)',
  'Plan-to-Listen': 'var(--text-muted)',
  'Currently-Listening': null,
  'Listened': 'var(--text-muted)',
  'Plan-to-Read': 'var(--text-muted)',
  'Currently-Reading': null,
  'Read': 'var(--text-muted)',
  'Plan-to-Play': 'var(--text-muted)',
  'Currently-Playing': null,
  'Played': 'var(--text-muted)',
};

export function resolveDot(map, value, accent) {
  if (!value) return null;
  if (!(value in map)) return 'var(--text-muted)';
  return map[value] === null ? accent : map[value];
}
