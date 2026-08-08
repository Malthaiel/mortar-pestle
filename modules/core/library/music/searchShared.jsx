// Shared pieces of the Music search surfaces — the All/Albums/Songs/Artists tab
// definition and the plain result row. Both MusicHome's landing search and
// AlbumBrowser's library pane render these, so they live in one place rather
// than as two drifting copies (MusicHome's old ArtistRow was the original).

import { useState } from 'react';
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

// One search result as a full-width row: title, optional sub-line, optional
// right-aligned readout. `dim` greys a track whose audio isn't on disk.
export function ResultRow({ title, sub, right, dim, selected, onClick, onContextMenu }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={dim ? `${title} — not downloaded` : title}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        textAlign: 'left', width: '100%', padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
        background: hover || selected ? 'var(--surface-2)' : 'transparent',
        cursor: 'pointer', transition: 'background 120ms ease',
        opacity: dim ? 0.5 : 1,
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        {sub && <span style={{
          fontSize: 11, color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{sub}</span>}
      </span>
      {right && (
        <span style={{
          fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums', flexShrink: 0,
        }}>{right}</span>
      )}
    </button>
  );
}

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
