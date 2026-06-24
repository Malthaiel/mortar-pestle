// Live "max detail" credits for one anime, keyed by MAL id. Mounted on both the
// owned (SeriesDetail) and not-owned (DiscoveryDetail) detail pages, so the same
// rich view appears whether or not the title is in the library. Three stacked
// sections — Characters (with Japanese + English voice actors), Staff, and
// Related anime — each fetched independently so one failing endpoint doesn't
// blank the others. Portraits hot-link from MAL; nothing is persisted. Related
// entries route through /tools/library/anime/title/<id>, which adaptively resolves to
// the owned or discovery view.

import { useEffect, useRef, useState } from 'react';
import { videoApi } from './api.js';
import PosterRow from './PosterRow.jsx';
import useInView from './useInView.js';

function initials(text) {
  const w = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return w.slice(0, 2).map(s => s[0].toUpperCase()).join('');
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

// Fetch one Jikan endpoint for `id`; null = loading, [] = empty/failed.
function useJikan(fn, id) {
  const [data, setData] = useState(null);
  const reqId = useRef(0);
  useEffect(() => {
    if (!id) { setData([]); return; }
    const my = ++reqId.current;
    setData(null);
    Promise.resolve(fn(id))
      .then(r => { if (my === reqId.current) setData(r || []); })
      .catch(() => { if (my === reqId.current) setData([]); });
    // fn is a stable module singleton; only id drives the refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return data;
}

export default function AnimeCredits({ malId, accent }) {
  const id = Number(malId) || 0;
  const characters = useJikan(videoApi.animeCharacters, id);
  const staff = useJikan(videoApi.animeStaff, id);
  const relations = useJikan(videoApi.animeRelations, id);
  const [charsExpanded, setCharsExpanded] = useState(false);
  const [staffExpanded, setStaffExpanded] = useState(false);

  // New title → collapse the expanders again.
  useEffect(() => { setCharsExpanded(false); setStaffExpanded(false); }, [id]);

  if (!id) return null;

  const loadingAll = characters === null && staff === null && relations === null;
  const emptyAll =
    characters !== null && characters.length === 0 &&
    staff !== null && staff.length === 0 &&
    relations !== null && relations.length === 0;
  if (emptyAll && !loadingAll) return null;

  // Mains first, then supporting (side) characters. The collapsed rail shows a
  // capped slice (≈ the Top Anime / This Season page size); "See all" expands
  // to the full uncapped grid.
  const CHAR_CAP = 12;
  const allChars = [...(characters || []).filter(c => c.role === 'Main'),
                    ...(characters || []).filter(c => c.role !== 'Main')];
  const shownChars = charsExpanded ? allChars : allChars.slice(0, CHAR_CAP);

  const STAFF_CAP = 12;
  const shownStaff = staffExpanded ? (staff || []) : (staff || []).slice(0, STAFF_CAP);

  return (
    <div style={{ padding: '0 0 8px', display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Related — leads the main column (MAL order); candy tile rails per type. */}
      {relations && relations.length > 0 && (
        <section>
          <SectionHeader>Related</SectionHeader>
          {/* Type blocks sit side by side (header + its poster row) and wrap. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
            {relations.map(r => (
              <div key={r.relation} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>{r.relation}</span>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {r.entries.map(e => <RelatedCard key={e.malId} entry={e} accent={accent} />)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Characters — MAL-style inline two-up rows: character | primary VA. The
          capped slice shows first; "See all" expands to the full list in place. */}
      {characters === null
        ? <CreditsSkeleton title="Characters" />
        : characters.length > 0 && (
          <section>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
              <h3 style={{
                margin: 0, fontSize: 15, fontWeight: 700,
                color: 'var(--text)', letterSpacing: '-0.01em',
              }}>Characters</h3>
              {allChars.length > CHAR_CAP && (
                <div style={{ marginLeft: 'auto' }}>
                  <button onClick={() => setCharsExpanded(e => !e)} data-own-press
                          className="candy-btn" data-shape="chip" style={{ '--accent': accent }}>
                    <span className="candy-face" style={{ fontSize: 11 }}>
                      {charsExpanded ? 'Show less ↑' : 'See all →'}
                    </span>
                  </button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {shownChars.map(c => <CharacterVaRow key={c.malId || c.name} c={c} accent={accent} />)}
            </div>
          </section>
        )}

      {/* Staff — horizontal candy tile rail; See all expands to a grid. */}
      {staff === null
        ? <CreditsSkeleton title="Staff" />
        : staff.length > 0 && (
          <PosterRow
            title="Staff"
            accent={accent}
            colWidth={112}
            layout={staffExpanded ? 'grid' : 'row'}
            seeAllLabel={staffExpanded ? 'Show less ↑' : 'See all →'}
            onSeeAll={() => setStaffExpanded(e => !e)}
          >
            {shownStaff.map(p => <StaffCard key={p.malId || p.name} p={p} accent={accent} />)}
          </PosterRow>
        )}
    </div>
  );
}

// One MAL-style row: the character (portrait + name + role) on the left, the
// primary voice actor (name + language + portrait, mirrored to the trailing
// edge) on the right. voiceActors arrives Japanese-first from the backend, so
// [0] is the preferred (Japanese when present) VA. Each half is its own button
// routing independently — character → /character/<id>, VA → /voiceactor/<id>.
// The .anime-cv-row halves are framed surfaces (not candy buttons), so plain
// buttons are safe; appearance:none immunizes them against the WebKitGTK
// native-button bug inside the transformed .page-tx ancestor.
// Portrait fallback sized to match the .anime-cv-row .cv-portrait box (52×74).
const CV_PLACEHOLDER = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600,
  color: 'var(--text-muted)', userSelect: 'none',
};
// One MAL-style pair inside a single framed rectangle: the character and the
// primary voice actor each rendered as their own candy button (candy press +
// depth), VA mirrored to the trailing edge. onClick lives on the candy-btn base
// (the immovable hit target); content sits in the pointer-events:none face.
function CharacterVaRow({ c, accent }) {
  const va = (c.voiceActors || [])[0];
  const charClickable = c.malId > 0;
  const vaClickable = va && va.malId > 0;
  const goChar = () => { if (charClickable) window.location.hash = '/tools/library/anime/character/' + c.malId; };
  const goVa = () => { if (vaClickable) window.location.hash = '/tools/library/anime/voiceactor/' + va.malId; };
  const a = accent || 'var(--accent)';
  return (
    <div className="anime-cv-row" style={{ '--accent': a }}>
      <button
        type="button"
        onClick={goChar}
        disabled={!charClickable}
        className="candy-btn anime-cv-row__char"
        title={charClickable ? `Open ${c.name}` : c.name}
        style={{ '--accent': a, cursor: charClickable ? 'pointer' : 'default' }}
      >
        <span className="candy-face">
          {c.image
            ? <img className="cv-portrait" src={c.image} alt="" loading="lazy" />
            : <span className="cv-portrait" style={CV_PLACEHOLDER}>{initials(c.name)}</span>}
          <span className="cv-text">
            <span className="cv-name">{c.name}</span>
            {c.role && <span className="cv-sub">{c.role}</span>}
          </span>
        </span>
      </button>
      {va ? (
        <button
          type="button"
          onClick={goVa}
          disabled={!vaClickable}
          className="candy-btn anime-cv-row__va"
          title={vaClickable ? `Open ${va.name}` : va.name}
          style={{ '--accent': a, cursor: vaClickable ? 'pointer' : 'default' }}
        >
          <span className="candy-face">
            {va.image
              ? <img className="cv-portrait" src={va.image} alt="" loading="lazy" />
              : <span className="cv-portrait" style={CV_PLACEHOLDER}>{initials(va.name)}</span>}
            <span className="cv-text">
              <span className="cv-name">{va.name}</span>
              {va.language && <span className="cv-sub">{va.language}</span>}
            </span>
          </span>
        </button>
      ) : <div />}
    </div>
  );
}

// Poster card matching the Characters rail (photo 3/4 + name + positions).
// Clickable → the person page (/voiceactor/<id>, which now also serves staff),
// so a candy tile (interactive) like the character cards. Positions clamp to one
// line with a title tooltip.
function StaffCard({ p, accent }) {
  const positions = (p.positions || []).join(', ');
  const clickable = p.malId > 0;
  const go = () => { if (clickable) window.location.hash = '/tools/library/anime/voiceactor/' + p.malId; };
  return (
    <button
      type="button"
      onClick={go}
      disabled={!clickable}
      className="candy-btn"
      data-shape="tile"
      title={clickable ? `Open ${p.name}` : p.name}
      style={{
        '--accent': accent || 'var(--accent)',
        width: '100%',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <div className="candy-face" style={{ padding: 0, overflow: 'hidden', textAlign: 'left' }}>
      <div style={{
        aspectRatio: '3 / 4', background: 'var(--surface-3)', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {p.image
          ? <img src={p.image} alt="" loading="lazy"
                 style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600,
              color: 'var(--text-muted)', userSelect: 'none',
            }}>{initials(p.name)}</span>}
      </div>
      <div style={{ padding: '7px 8px 9px' }}>
        <div style={{
          fontSize: 10, fontWeight: 600, color: 'var(--text)', lineHeight: 1.2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{p.name}</div>
        {positions && (
          <div title={positions} style={{
            fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{positions}</div>
        )}
      </div>
      </div>
    </button>
  );
}

// Related title with a lazily-fetched poster. The /relations endpoint carries
// no images, so each card pulls its cover from anime_detail on mount (riding the
// shared Jikan throttle); the title renders immediately and the poster streams
// in. Routes through the adaptive /title/<id> page (owned or discovery).
function RelatedCard({ entry, accent }) {
  const [ref, inView] = useInView();
  const [img, setImg] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    Promise.resolve(videoApi.animeDetail(entry.malId))
      .then(d => { if (!cancelled) setImg((d && d.image) || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [inView, entry.malId]);
  const show = img && !failed;
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => { window.location.hash = '/tools/library/anime/title/' + entry.malId; }}
      className="candy-btn"
      data-shape="tile"
      title={`Open ${entry.name}`}
      style={{
        '--accent': accent || 'var(--accent)',
        width: 116, cursor: 'pointer',
      }}
    >
      <div className="candy-face" style={{ padding: 0, overflow: 'hidden', textAlign: 'left' }}>
      <div style={{
        aspectRatio: '2 / 3', background: 'var(--surface-3)', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {show
          ? <img src={img} alt="" loading="lazy" onError={() => setFailed(true)}
                 style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600,
              color: 'var(--text-muted)', userSelect: 'none',
            }}>{initials(entry.name)}</span>}
      </div>
      <div style={{
        padding: '7px 8px 9px', fontSize: 11, fontWeight: 600, color: 'var(--text)',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden', lineHeight: 1.25,
      }}>{entry.name}</div>
      </div>
    </button>
  );
}

// Skeleton shimmer placeholder for a credits rail (Characters / Staff), shown
// while its Jikan fetch is in flight — the page now reveals before credits
// resolve. A row of poster-shaped blocks matching the 112px rail cards.
function CreditsSkeleton({ title }) {
  const blocks = Array.from({ length: 6 });
  return (
    <section>
      <SectionHeader>{title}</SectionHeader>
      <div style={{ display: 'flex', gap: 14, overflow: 'hidden' }}>
        {blocks.map((_, i) => (
          <div key={i} style={{ width: 112, flexShrink: 0 }}>
            <div className="ftv-skeleton" style={{ width: '100%', aspectRatio: '3 / 4', borderRadius: 8 }} />
            <div className="ftv-skeleton" style={{ height: 9, marginTop: 6, borderRadius: 4, width: '82%' }} />
          </div>
        ))}
      </div>
    </section>
  );
}
