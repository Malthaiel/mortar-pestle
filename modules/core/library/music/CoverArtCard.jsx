// Album cover card used in the AlbumBrowser grid. Square cover, title +
// artist + year beneath. Hover overlays a circular play button.

import { useState } from 'react';
import { coverSrc, STATUS_DOT_COLOR, resolveDot } from './util.js';

export default function CoverArtCard({ album, accent, selected, onSelect, onPlay }) {
  const [hover, setHover] = useState(false);
  const img = coverSrc(album.image, 320);
  const statusDot = resolveDot(STATUS_DOT_COLOR, album.status, accent);
  const activate = () => onSelect(album.path);
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  };
  return (
    <div
      onClick={activate}
      onKeyDown={onKeyDown}
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
      <div style={{
        marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2,
        minWidth: 0,
      }}>
        <div title={album.title} style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{album.title}</div>
        <div title={album.artist} style={{
          fontSize: 11, color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{album.artist}</div>
        <div style={{
          fontSize: 10, color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', marginTop: 3,
          display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
          rowGap: 4,
        }}>
          {album.status && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              color: 'var(--text-muted)',
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: statusDot || 'var(--text-faint)',
                flexShrink: 0,
              }}/>
              <span>{album.status}</span>
            </span>
          )}
          {album.year && (
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{album.year}</span>
          )}
          {album.personalRating > 0 && (
            <span style={{
              color: accent, marginLeft: 'auto', fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            }}>★{album.personalRating}</span>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
