// Shared pieces of the Music search surfaces — the All/Albums/Songs/Artists tab
// definition and the plain result row. Both MusicHome's landing search and
// AlbumBrowser's library pane render these, so they live in one place rather
// than as two drifting copies (MusicHome's old ArtistRow was the original).

import { usePersistedState } from '@host/components/vault-tree/useTreeExpansion.js';

export const SEARCH_TABS = [
  { value: 'all',     label: 'All' },
  { value: 'albums',  label: 'Albums' },
  { value: 'songs',   label: 'Songs' },
  { value: 'artists', label: 'Artists' },
];

// Which catalogue(s) a query hits. Local-library results always render — this
// only gates the two remote sources.
export const SEARCH_SOURCES = [
  { value: 'both', label: 'Both' },
  { value: 'mb',   label: 'MusicBrainz' },
  { value: 'yt',   label: 'YouTube' },
];

const VALID = new Set(SEARCH_TABS.map(t => t.value));
const VALID_SRC = new Set(SEARCH_SOURCES.map(s => s.value));

// localStorage-backed tab choice. Guards against a stale/garbage stored value
// so a renamed tab can never wedge the surface into rendering nothing.
export function useSearchTab(key) {
  const [raw, setRaw] = usePersistedState(key, 'all');
  return [VALID.has(raw) ? raw : 'all', setRaw];
}

// Same contract for the source selector.
export function useSearchSource(key) {
  const [raw, setRaw] = usePersistedState(key, 'both');
  return [VALID_SRC.has(raw) ? raw : 'both', setRaw];
}

// Track-highlight handoff between the browser pane and the detail pane.
// Deliberately NOT a window event: the browser selects the album and marks the
// track in the same click, so an event would fire while AlbumDetail is still
// mounted on the PREVIOUS album and would be rejected. A parked value is read
// by whichever AlbumDetail mounts next, whenever that happens.
let pending = null;

export function markTrackHighlight(albumPath, n, disc) {
  pending = { albumPath, n, disc };
}

// Returns {n, disc} once for a matching album, then forgets it — so a highlight
// never reappears when you navigate back later.
export function consumeTrackHighlight(albumPath) {
  if (!pending || pending.albumPath !== albumPath) return null;
  const { n, disc } = pending;
  pending = null;
  return { n, disc };
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ResultRow moved to ./ResultRow.jsx (2026-08-08). This module exports hooks,
// and React Fast Refresh will not hot-update a module exporting both a hook and
// a component — every edit here used to invalidate and re-execute AlbumBrowser,
// MusicHome and AlbumDetail. Import it from its own file.

// Rows for a list of local track hits (music_search_tracks shape).
export function trackRowProps(hit) {
  return {
    title: hit.title,
    sub: [hit.artist, hit.albumTitle].filter(Boolean).join(' · '),
    right: fmtDuration(hit.duration),
    dim: !hit.available,
  };
}

// Rows for a list of MusicBrainz recording hits (music_search_recordings shape).
export function recordingRowProps(hit) {
  return {
    title: hit.title,
    sub: [hit.artist, hit.release].filter(Boolean).join(' · '),
    right: fmtDuration(hit.length),
  };
}

// A pasted YouTube link is a source, not a search term — the search surfaces
// use this to skip the MusicBrainz stacks (a URL can only return junk there)
// and show the single YouTube row. Mirrors YT_URL_RE in download_album.py,
// which is what actually resolves it.
const YT_URL_RE = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/|youtu\.be\/)/i;
export const isYoutubeUrl = (q) => YT_URL_RE.test((q || '').trim());

// Rows for a list of YouTube hits (music_search_youtube shape).
export function youtubeRowProps(hit) {
  return {
    title: hit.title,
    sub: hit.uploader || '',
    right: fmtDuration(hit.duration),
  };
}
