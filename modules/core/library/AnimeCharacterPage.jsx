// In-app character detail page, reached by clicking a character on an anime's
// detail view (/tools/library/anime/character/<malId>). Pulls the character's bio, the
// Japanese + English voice actors, and the anime it appears in from Jikan's
// /characters/{id}/full in one call. The voice actors live HERE now (moved off
// the anime page's character cards). Renders under the persistent AnimeTopBar;
// a "← Back" affordance returns to the originating anime since the topbar has
// no tile for character pages.

import { useEffect, useRef, useState } from 'react';
import { videoApi } from './api.js';
import LoadingScreen from './LoadingScreen.jsx';
import ImageLightbox, { useLightbox } from './ImageLightbox.jsx';

function initials(text) {
  const w = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return w.slice(0, 2).map(s => s[0].toUpperCase()).join('');
}

function Portrait({ src, alt, accent, width = 180, height, ratio = '3 / 4', radius = 10, fontSize = 48 }) {
  const [failed, setFailed] = useState(false);
  const show = src && !failed;
  return (
    <div style={{
      width, ...(height ? { height } : { aspectRatio: ratio }), flexShrink: 0, borderRadius: radius, overflow: 'hidden',
      background: `color-mix(in oklch, ${accent || 'var(--text-muted)'} 14%, var(--surface-2))`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {show
        ? <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)}
               style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <span style={{
            fontFamily: 'var(--font-mono)', fontSize, fontWeight: 600, color: 'var(--text-muted)',
            userSelect: 'none',
          }}>{initials(alt)}</span>}
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 12,
    }}>{children}</div>
  );
}

export default function AnimeCharacterPage({ malId, accent }) {
  const id = Number(malId) || 0;
  const [data, setData] = useState(null);   // null = loading
  const [error, setError] = useState(null);
  const reqId = useRef(0);
  const lb = useLightbox();

  useEffect(() => {
    if (!id) { setError('Invalid character.'); return; }
    const my = ++reqId.current;
    setData(null); setError(null);
    Promise.resolve(videoApi.characterFull(id))
      .then(d => { if (my === reqId.current) setData(d || {}); })
      .catch(e => { if (my === reqId.current) setError((e && e.message) || 'Failed to load character.'); });
  }, [id]);

  useEffect(() => {
    if (data && data.name) {
      document.title = 'Anime · ' + data.name;
      return () => { document.title = 'Citadel'; };
    }
  }, [data]);

  if (error) return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!data) return <LoadingScreen accent={accent} />;

  const vas = data.voiceActors || [];
  const appearances = data.appearances || [];

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {/* Back — the topbar has no tile for a character page. */}
      <div style={{ padding: '12px 24px 0' }}>
        <button type="button" onClick={() => window.history.back()} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
        }}>← Back</button>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', gap: 24, padding: '14px 24px 24px', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={!data.image}
          onClick={() => lb.show(data.image, data.name)}
          className="candy-btn"
          data-shape="tile"
          title={data.image ? `View ${data.name}` : data.name}
          style={{ '--accent': accent || 'var(--accent)', width: 180, padding: 0, cursor: data.image ? 'zoom-in' : 'default' }}
        >
          <span className="candy-face" style={{ padding: 0, overflow: 'hidden' }}>
            <Portrait src={data.image} alt={data.name} accent={accent} width={180} height={240} radius={0} />
          </span>
        </button>
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: 'var(--text)', lineHeight: 1.15 }}>{data.name || '—'}</h2>
          {data.nameKanji && <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>{data.nameKanji}</div>}
          {data.about && (
            <p style={{
              marginTop: 6, fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)',
              maxWidth: 680, whiteSpace: 'pre-wrap',
            }}>{data.about}</p>
          )}
        </div>
      </div>

      {/* Voice actors */}
      <div style={{ padding: '0 24px 22px' }}>
        <SectionHeader>Voice Actors</SectionHeader>
        {vas.length === 0
          ? <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>No voice actors listed.</div>
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {vas.map((va, i) => {
                const clickable = va.malId > 0;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!clickable}
                    onClick={() => { if (clickable) window.location.hash = '/tools/library/anime/voiceactor/' + va.malId; }}
                    className="candy-btn"
                    data-shape="tile"
                    title={clickable ? `Open ${va.name}` : va.name}
                    style={{
                      '--accent': accent || 'var(--accent)',
                      width: '100%', cursor: clickable ? 'pointer' : 'default',
                    }}
                  >
                    <div className="candy-face" style={{ padding: 10, display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left' }}>
                    <Portrait src={va.image} alt={va.name} accent={accent} width={56} ratio="1 / 1" radius={6} fontSize={18} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 600, color: 'var(--text)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{va.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{va.language}</div>
                    </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
      </div>

      {/* Appears in */}
      {appearances.length > 0 && (
        <div style={{ padding: '0 24px 28px' }}>
          <SectionHeader>Appears In</SectionHeader>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {appearances.map(a => (
              <button key={a.malId} type="button"
                onClick={() => { window.location.hash = '/tools/library/anime/title/' + a.malId; }}
                className="candy-btn"
                data-shape="tile"
                title={`Open ${a.title}`}
                style={{
                  '--accent': accent || 'var(--accent)',
                  width: 116, cursor: 'pointer',
                }}
              >
                <div className="candy-face" style={{ padding: 0, overflow: 'hidden', textAlign: 'left' }}>
                <div style={{
                  height: 174, background: 'var(--surface-3)', overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {a.image
                    ? <img src={a.image} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 600, color: 'var(--text-muted)' }}>{initials(a.title)}</span>}
                </div>
                <div style={{ padding: '7px 8px 9px' }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: 'var(--text)',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden', lineHeight: 1.25,
                  }}>{a.title}</div>
                  {a.role && (
                    <div style={{
                      fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
                      textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4,
                    }}>{a.role}</div>
                  )}
                </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      <ImageLightbox {...lb} accent={accent} />
    </div>
  );
}

function Centered({ children, tone }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: tone === 'error' ? 'var(--text)' : 'var(--text-faint)', fontSize: 13, padding: 40,
    }}>{children}</div>
  );
}
