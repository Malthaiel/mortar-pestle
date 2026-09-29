// Music module's copy of the cover-art / status-dot helpers. The video
// module owns its own copy at modules/core/library/util.js — duplication is
// preferred over cross-module imports per the W5 plan.

import { mediaUrl } from '@host/api.js';
import { navigate } from '@host/router.js';
import { NAV_H, NAV_TEXT, NAV_ICON } from '@host/components/vault-tree/treeKit.jsx';

// The one route to an artist. Music has no artist PAGE — the Browse search is
// the only artist surface the app has — so every place that makes an artist
// name clickable (the credits panel, the album header) goes through this.
export const toBrowse = (q) => navigate('/tools/library/music/browse/q/' + encodeURIComponent(q));

// The one route to an album you don't own: its release-group page (MusicPage
// browse/rg/<mbid> -> AlbumDetail), straight in, never a search for its name.
export const toRelease = (mbid) => navigate('/tools/library/music/browse/rg/' + encodeURIComponent(mbid));

// Letters and digits only, lowercased: "Tyler, The Creator" matches the
// uploader "TylerTheCreatorVEVO" and "Paranoid Android" the title
// "Radiohead - Paranoid Android (Official Video)". Also how a playlist row
// finds its song on the album card (by title, never by its row number).
export const squash = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

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

// The ONE size knob for every music run: the album page's action run and track
// rows, the library column's run and the top-right search field, all 1-1
// (user-directed 2026-09-29). .candy-split derives corner, seam, overlap and
// part height from --cbtn-size; library.css [data-record-run] lays the label
// and icon sizes on every face under it. The three numbers are the app's nav
// knob (treeKit NAV_H / NAV_TEXT / NAV_ICON), shared with every left sidebar.
export const RUN_SIZE = `${NAV_H}px`;
export const RUN_VARS = { '--cbtn-size': RUN_SIZE, '--chip-label-size': `${NAV_TEXT}px`, '--record-icon': `${NAV_ICON}px` };

export function coverSrc(image, width, opts) {
  if (!image) return null;
  const url = mediaUrl(image, opts) || null;
  // Local covers support server-side resize via ?w=<n>, which hits the cached-
  // thumbnail path in the Rust asset protocol. Remote URLs (http/data/blob) are
  // returned untouched. Both spellings of our own asset URL count: WebKitGTK gets
  // the literal `mortar-pestle-asset://` scheme, WebView2 gets the http origin
  // `http://mortar-pestle-asset.localhost/`. Testing only the scheme form meant
  // the resize never fired on Windows at all, so a 60px widget tile loaded a
  // 3000x3000 PNG (measured 2026-09-22).
  if (width && url && /^(mortar-pestle-asset:|https?:\/\/mortar-pestle-asset\.)/.test(url)) {
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

// Album card -> player queue items (playAlbumTracks), shared with the album
// page, which hands the same items to usePrefetchStreams so the links it
// fetches ahead are keyed exactly as the player will ask for them.
export function albumToQueueItems(album) {
  return album.tracks.map(t => ({
    albumPath:  album.path,
    albumTitle: album.title,
    albumImage: album.image,
    artist:     album.artist,
    n:          t.n,
    title:      t.title,
    audioPath:  t.audioPath,
    available:  t.available,
    streamable: !t.available,
    wikilink:   t.wikilink,
    duration:   t.duration,
    // A Browse album's tracks carry their stream identity (AlbumDetail).
    streamKey:  t.streamKey,
  }));
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
    // A linked row keeps its audioPath with the file gone (an uninstall); the
    // player takes any audioPath as a file to play, so only an on-disk one goes.
    audioPath: t.available ? t.audioPath : null,
    available: t.available,
    // A row carrying its own source link streams from that link directly;
    // otherwise streaming needs a real album card to resolve against, so rows
    // whose album is gone (recycled) stay truly unavailable.
    streamable: !!t.watchUrl || (!t.available && !!t.albumPath && t.n != null),
    // A playlist row's n is its place in the PLAYLIST, not the album's track
    // number, so the album-card resolve (albumPath + n) would fetch the wrong
    // song. A row not on disk streams by album card + TITLE instead (Rust finds
    // the album's n, else searches): streamKey names it and routes
    // streamResolveArgs to that branch.
    streamKey: !t.available && !t.watchUrl ? `${t.albumPath}|${t.title}` : null,
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
