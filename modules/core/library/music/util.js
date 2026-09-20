// Music module's copy of the cover-art / status-dot helpers. The video
// module owns its own copy at modules/core/library/util.js — duplication is
// preferred over cross-module imports per the W5 plan.

import { mediaUrl } from '@host/api.js';
import { navigate } from '@host/router.js';

// The one route to an artist. Music has no artist PAGE — the Browse search is
// the only artist surface the app has — so every place that makes an artist
// name clickable (the credits panel, the album header) goes through this.
export const toBrowse = (q) => navigate('/tools/library/music/browse/q/' + encodeURIComponent(q));

// The one cover-tile grid for the whole music module (album browser panel, home,
// library, browse, playlists). Two rules are baked in, both easy to get wrong:
//
//  1. Tracks are 1fr with NO max-width, so tiles always consume the row and
//     resize continuously as a pane is dragged; the grid gains a column the
//     instant another TILE_MIN-wide tile fits. A per-tile cap would stop the
//     growth but strand the slack as dead space. Tile width therefore runs
//     TILE_MIN … TILE_MIN + (TILE_MIN + TILE_GAP) / columns  (93–148px here).
//     The peak lands at the FEWEST columns any surface shows (2), so it reduces
//     to 1.5 * TILE_MIN + 8 — lower the floor to lower the peak, one knob.
//  2. A candy tile's press-depth band is a box-shadow BELOW it, outside layout,
//     so a uniform `gap` reads ~10.5px tighter vertically than horizontally
//     (see util/candy.js). The row gap adds --candy-tile-depth back; the column
//     gap must NOT — the shadow points down, not sideways.
//
// A container using this should pad its bottom edge to
// `calc(TILE_GAPpx + var(--candy-tile-depth))` so the last row's band clears.
export const TILE_MIN = 93;    // -> peak 147.5px (1.5 * 93 + 8)
export const TILE_GAP = 8;    // VISUAL separation, equal on all sides (4px grid)
export const TILE_GRID = {
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN}px, 1fr))`,
  columnGap: TILE_GAP,
  rowGap: `calc(${TILE_GAP}px + var(--candy-tile-depth))`,
};

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

// PlaylistTrack -> player queue item. Each track keeps its own album cover/artist
// (playlists span albums), which is why playback uses playTracks, not
// playAlbumTracks. Lives here rather than in PlaylistDetail because the player's
// own last-played restore needs it too, and importing it from PlaylistDetail
// would cycle back through MusicPlayerProvider.
export function trackToQueueItem(t, pl) {
  return {
    albumPath: t.albumPath || pl.path,
    albumTitle: t.albumTitle || pl.title,
    albumImage: t.albumImage || pl.image || null,
    artist: t.artist || '',
    n: t.n,
    title: t.title,
    audioPath: t.audioPath,
    available: t.available,
    // A row carrying its own source link streams from that link directly;
    // otherwise streaming needs a real album card to resolve against, so rows
    // whose album is gone (recycled) stay truly unavailable.
    streamable: !!t.watchUrl || (!t.available && !!t.albumPath && t.n != null),
    watchUrl: t.watchUrl || null,
    wikilink: t.wikilink || null,
    duration: t.duration ?? null,
  };
}

// A loose YouTube search hit as a player queue item. Same field set
// trackToQueueItem builds, minus any album card: `watchUrl`
// is what music_stream_resolve keys on instead of albumPath + n.
export function youtubeQueueItem(hit) {
  return {
    albumPath: null,
    albumTitle: 'YouTube',
    albumImage: null,
    artist: hit.uploader || '',
    n: null,
    title: hit.title || '',
    audioPath: null,
    available: false,
    streamable: true,
    watchUrl: hit.watchUrl,
    wikilink: null,
    duration: hit.duration ?? null,
  };
}
