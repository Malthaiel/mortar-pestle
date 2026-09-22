// Playlist cover renderer. Priority: a custom uploaded image (passed as the
// single `image`), else a 2×2 collage built from the first four tracks' album
// covers (`urls`), else a styled initials tile. Each <img> falls back to a blank
// accent tile on load error (album covers are remote CAA URLs and can fail).

import { useState } from 'react';
import { coverSrc } from './util.js';

function initials(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '♪';
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// Every source this renders — a custom playlist cover and the album covers the
// collage is built from — lives in the Library vault, so the root is not a
// per-caller choice. The collage branches used to omit it, which resolved album
// covers against the wrong root: coverSrc returned nothing, the tile fell
// through to its blank state, and a collage-backed playlist showed no cover at
// all (Macroblank, 2026-09-10).
// The failure flag is keyed to the SRC, not to the component instance: this tile
// is long-lived (the player widget's cover swaps picture per track), and a plain
// boolean latched false on the first error and never re-checked. The widget's
// cover mounts before setMediaLibraryRoot runs, so its very first URL resolves
// against no Library root, 404s once, and the tile stayed blank for the rest of
// the session while the same cover painted fine everywhere else (2026-09-22).
function Tile({ src, accent, alt }) {
  const [bad, setBad] = useState(null);
  const ok = bad !== src;
  const url = coverSrc(src, 320, { library: true });
  if (url && ok) {
    return (
      <img
        src={url}
        alt={alt || ''}
        loading="lazy"
        decoding="async"
        onError={() => setBad(src)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: `color-mix(in oklch, ${accent || 'var(--text-muted)'} 14%, var(--surface-2))`,
      }}
    />
  );
}

// `image` — explicit custom cover (relative path or URL). `urls` — up to 4 album
// covers for the collage. `title` — for the initials fallback.
export default function CollageCover({ image, urls = [], title, accent, style }) {
  const base = {
    width: '100%',
    height: '100%',
    display: 'block',
    background: 'var(--surface-2)',
    ...style,
  };

  if (image) {
    return (
      <div style={base}>
        <Tile src={image} accent={accent} alt={title} />
      </div>
    );
  }

  const tiles = (urls || []).filter(Boolean).slice(0, 4);

  if (tiles.length === 0) {
    return (
      <div
        style={{
          ...base,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          fontSize: 'clamp(18px, 30%, 52px)',
          letterSpacing: '0.04em',
          userSelect: 'none',
          background: `color-mix(in oklch, ${accent || 'var(--text-muted)'} 16%, var(--surface-2))`,
        }}
      >
        {initials(title)}
      </div>
    );
  }

  if (tiles.length === 1) {
    return (
      <div style={base}>
        <Tile src={tiles[0]} accent={accent} alt={title} />
      </div>
    );
  }

  // 2–4 covers → 2×2 mosaic. With 2 or 3, repeat to fill the four cells.
  const cells = tiles.length >= 4 ? tiles.slice(0, 4) : [...tiles, ...tiles, ...tiles, ...tiles].slice(0, 4);
  return (
    <div
      style={{
        ...base,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 1,
      }}
    >
      {cells.map((s, i) => (
        <Tile key={i} src={s} accent={accent} alt={title} />
      ))}
    </div>
  );
}
