// Browse-page result card. Square Cover Art Archive cover (hot-linked) with an
// onError fallback to a styled initials placeholder, then title / artist / year
// beneath. Modeled on CoverArtCard's tile, trimmed of library-only chrome
// (status dot, rating, play button). Click → preview (wired in SF2).

import { useState } from 'react';

function initials(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '♪'; // ♪
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

export default function BrowseResultCard({ result, accent, onSelect, inLibrary }) {
  const [imgFailed, setImgFailed] = useState(false);
  // 250px thumbnail (CAA serves these natively) instead of the full-size
  // `/front` original — cards render at ≤170px, so the original was ~10–30×
  // more pixels to download + decode, the main source of Music-tab lag.
  const cover = result.mbid
    ? `https://coverartarchive.org/release-group/${result.mbid}/front-250`
    : null;
  const showImg = cover && !imgFailed;
  const meta = [result.year || null, result.primaryType || null].filter(Boolean).join(' · ');
  const activate = () => onSelect && onSelect(result);
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  };
  const body = (
    <>
      <div style={{
        position: 'relative',
        width: '100%', aspectRatio: '1 / 1',
        background: 'var(--surface-2)',
        borderRadius: 6, overflow: 'hidden',
      }}>
        {showImg ? (
          <img
            src={cover} alt="" loading="lazy" decoding="async"
            onError={() => setImgFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `color-mix(in oklch, ${accent || 'var(--text-muted)'} 16%, var(--surface-2))`,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 600,
            letterSpacing: '0.04em', userSelect: 'none',
          }}>
            {initials(result.artist || result.title)}
          </div>
        )}
        {inLibrary && (
          <span style={{
            position: 'absolute', top: 6, right: 6,
            width: 20, height: 20, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: accent || 'var(--text-muted)', color: 'white', fontSize: 12,
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          }} title="Already in your library">✓</span>
        )}
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div title={result.title} style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{result.title}</div>
        <div title={result.artist} style={{
          fontSize: 11, color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{result.artist}</div>
        {meta && (
          <div style={{
            fontSize: 10, color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', marginTop: 3,
            fontVariantNumeric: 'tabular-nums',
          }}>{meta}</div>
        )}
      </div>
    </>
  );
  return onSelect ? (
    <div
      onClick={activate}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
      className="candy-btn"
      data-shape="tile"
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face">{body}</div>
    </div>
  ) : (
    <div
      className="candy-card"
      style={{ '--accent': accent || 'var(--accent)', padding: 8 }}
    >
      {body}
    </div>
  );
}
