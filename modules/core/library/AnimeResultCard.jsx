// Browse-page result card for anime. Square MAL cover (hot-linked from the Jikan
// `image` URL) with an onError fallback to a styled initials placeholder, a
// content-type badge (top-left), then title / English title / year·type·eps
// beneath. Modeled on the music BrowseResultCard. Corner chips (in-library ✓ /
// quick-add +) were removed by request — ownership state lives on the detail
// page and the topbar tiles.

import { useState } from 'react';
import { prefetchTitle } from './api.js';

function initials(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

export default function AnimeResultCard({ result, accent, onSelect }) {
  const [imgFailed, setImgFailed] = useState(false);
  const cover = result.image || null;
  const showImg = cover && !imgFailed;
  const meta = [
    result.year || null,
    result.episodes ? `${result.episodes} ep` : null,
    result.score ? `★ ${result.score}` : null,
  ].filter(Boolean).join(' · ');
  const sub = result.titleEnglish && result.titleEnglish !== result.title ? result.titleEnglish : null;
  const activate = () => onSelect && onSelect(result);
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  };
  const body = (
    <>
      <div style={{
        position: 'relative',
        width: '100%', aspectRatio: '2 / 3',
        background: 'var(--surface-2)',
        borderRadius: 6, overflow: 'hidden',
      }}>
        {showImg ? (
          <img
            src={cover} alt="" loading="lazy"
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
            {initials(result.title)}
          </div>
        )}
        {result.type && (
          <span style={{
            position: 'absolute', top: 6, left: 6,
            padding: '2px 6px', borderRadius: 5,
            background: 'rgba(0,0,0,0.62)', color: 'white',
            fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
            fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
          }}>{result.type}</span>
        )}
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div title={result.title} style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{result.title}</div>
        {sub && (
          <div title={sub} style={{
            fontSize: 11, color: 'var(--text-muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{sub}</div>
        )}
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
      onMouseEnter={() => prefetchTitle(result.malId)}
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
