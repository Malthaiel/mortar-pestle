// Album cover card used in every music grid. Cover art ONLY — the title, artist,
// status dot, year and rating that used to sit beneath were removed 2026-08-08
// (user-directed: at the 93-143px tile widths the captions were unreadable clutter).
// Hover overlays a circular play button. Right-click deletes the album (shared menu
// — every grid that renders this tile gets it).

import { useState } from 'react';
import { coverSrc } from './util.js';
import { useAlbumMenu } from './contextMenus.js';

export default function CoverArtCard({ album, accent, selected, onSelect, onPlay }) {
  const [hover, setHover] = useState(false);
  const albumMenu = useAlbumMenu(accent);
  const img = coverSrc(album.image, 320, { library: true });
  const activate = () => onSelect(album.path);
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  };
  return (
    <div
      onClick={activate}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => albumMenu(e, album)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={'candy-btn' + (selected ? ' is-selected' : '')}
      data-shape="tile"
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face">
      <div style={{
        position: 'relative',
        width: '100%', aspectRatio: '1 / 1',
        background: 'var(--surface-2)',
        borderRadius: 6, overflow: 'hidden',
      }}>
        {img && (
          <img src={img} alt="" loading="lazy" decoding="async" style={{
            width: '100%', height: '100%', objectFit: 'cover', display: 'block',
          }}/>
        )}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: 8, opacity: hover ? 1 : 0,
          transition: 'opacity 0.12s ease',
          background: hover ? 'linear-gradient(to top, rgba(0,0,0,0.5), transparent 50%)' : 'transparent',
        }}>
          <button
            onClick={(e) => { e.stopPropagation(); onPlay(album); }}
            onMouseDown={(e) => e.stopPropagation()}
            title="Play album"
            style={{
              pointerEvents: 'auto',
              width: 40, height: 40, borderRadius: '50%',
              border: 'none', background: accent, color: 'white',
              cursor: 'pointer', fontSize: 16,
              boxShadow: '0 4px 10px rgba(0,0,0,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              paddingLeft: 3,
              transform: hover ? 'scale(1)' : 'scale(0.85)',
              transition: 'transform 0.14s ease',
            }}
          >▶</button>
        </div>
      </div>
      </div>
    </div>
  );
}
