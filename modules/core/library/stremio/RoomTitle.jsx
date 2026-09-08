// A title you do not own yet — a show in the TV room, a film in the Movies room:
// the Cinemeta record plus the Add to Library button. Once added, the route hands
// off to the owned page (SeriesDetail), so this page exists only for the
// not-owned case.
//
// The anime gate lives in Rust — `tv_add_to_library` / `movie_add_to_library`
// refuse rather than write, and hand back a reason. This page turns each reason
// into the right offer: a jump to the Anime room, or a jump to the card that
// already owns the title. Checking here as well would be a second copy of a rule
// with one owner.

import { useEffect, useMemo, useState } from 'react';
import { videoApi } from '../api.js';
import { coverSrc } from '../util.js';
import { encodePath } from '../paths.js';
import LoadingScreen from '../LoadingScreen.jsx';
import { room, roomHome, go } from './util.js';

const ANIME_HOME = '/tools/library/anime';

function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

export default function RoomTitle({ accent, kind = 'series', imdbId }) {
  const cfg = room(kind);
  const HOME = roomHome(kind);
  const noun = cfg.hasEpisodes ? 'show' : 'film';
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [refused, setRefused] = useState(null);
  const { series } = cfg.useStats();

  // Already on the shelf → offer the owned page instead of a second Add.
  const owned = useMemo(
    () => (series || []).find(s => s.imdbId === imdbId) || null,
    [series, imdbId],
  );

  useEffect(() => {
    let cancelled = false;
    setDetail(null); setError(null); setRefused(null);
    videoApi.cinemetaDetail(kind, imdbId)
      .then(d => { if (!cancelled) setDetail(d); })
      .catch(e => { if (!cancelled) setError(errText(e, `Could not load this ${noun}.`)); });
    return () => { cancelled = true; };
  }, [imdbId, kind, noun]);

  const onAdd = async () => {
    if (adding) return;
    setAdding(true); setError(null); setRefused(null);
    try {
      const res = await cfg.addToLibrary(imdbId);
      if (res && res.ok) {
        // The shelf stores reload off this event, the same way a download does.
        window.dispatchEvent(new CustomEvent('video-library-changed', { detail: {} }));
        go(HOME + '/' + encodePath(res.seriesPath));
        return;
      }
      setRefused((res && res.refused) || { reason: 'unknown', message: `Could not add this ${noun}.` });
    } catch (e) {
      setError(errText(e, `Could not add this ${noun}.`));
    } finally {
      setAdding(false);
    }
  };

  if (error && !detail) return <Centered accent={accent}>{error}</Centered>;
  if (!detail) return <LoadingScreen accent={accent} />;

  const poster = coverSrc(detail.poster);
  const seasons = (detail.seasons || []).filter(n => n > 0).length;
  // A film has no seasons, no episode count and no Continuing/Ended status; its
  // runtime is the fact that matters instead.
  const facts = (cfg.hasEpisodes ? [
    detail.year,
    seasons ? `${seasons} season${seasons === 1 ? '' : 's'}` : null,
    detail.episodes && detail.episodes.length ? `${detail.episodes.length} episodes` : null,
    detail.imdbRating ? `★ ${detail.imdbRating}` : null,
    detail.status,
  ] : [
    detail.year,
    detail.runtime,
    detail.imdbRating ? `★ ${detail.imdbRating}` : null,
    detail.director && detail.director.length ? detail.director.join(', ') : null,
  ]).filter(Boolean).join('  ·  ');

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 24px 40px' }}>
      <div style={{ display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ width: 200, flexShrink: 0, aspectRatio: '2 / 3', background: 'var(--surface-3)', borderRadius: 10, overflow: 'hidden' }}>
          {poster && <img src={poster} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        </div>

        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
            {detail.name}
          </h2>
          {facts && (
            <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', color: 'var(--text-faint)' }}>
              {facts}
            </div>
          )}
          {detail.genres && detail.genres.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{detail.genres.join(', ')}</div>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
            {owned ? (
              <button onClick={() => go(HOME + '/' + encodePath(owned.path))} className="candy-btn is-primary" style={{ cursor: 'pointer' }}>
                <span className="candy-face">Open in your library</span>
              </button>
            ) : (
              <button onClick={onAdd} disabled={adding} className="candy-btn is-primary"
                style={{ cursor: adding ? 'default' : 'pointer', opacity: adding ? 0.6 : 1 }}>
                <span className="candy-face">{adding ? 'Adding' : 'Add to Library'}</span>
              </button>
            )}
          </div>

          {refused && <Refused refused={refused} accent={accent} home={HOME} />}
          {error && <div style={{ fontSize: 12, color: 'var(--text)' }}>{error}</div>}

          {detail.description && (
            <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text)', maxWidth: 620 }}>
              {detail.description}
            </p>
          )}
          {detail.cast && detail.cast.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Cast: {detail.cast.slice(0, 6).join(', ')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// The refusal reasons Rust can hand back, each with the one thing worth doing next.
function Refused({ refused, accent, home }) {
  const toAnime = refused.reason === 'anime' || refused.reason === 'already-in-anime';
  const owned = refused.seriesPath;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '10px 12px', borderRadius: 8,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 12, color: 'var(--text)' }}>{refused.message}</span>
      {toAnime && (
        <button onClick={() => go(owned ? `${ANIME_HOME}/${encodePath(owned)}` : ANIME_HOME)}
          data-own-press className="candy-btn" data-shape="chip" style={{ marginLeft: 'auto', '--accent': accent }}>
          <span className="candy-face" style={{ fontSize: 11 }}>Go to Anime →</span>
        </button>
      )}
      {!toAnime && owned && (
        <button onClick={() => go(`${home}/${encodePath(owned)}`)}
          data-own-press className="candy-btn" data-shape="chip" style={{ marginLeft: 'auto', '--accent': accent }}>
          <span className="candy-face" style={{ fontSize: 11 }}>Open it →</span>
        </button>
      )}
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
      {children}
    </div>
  );
}
