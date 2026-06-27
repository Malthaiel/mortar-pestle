// In-app person page, reached by clicking a voice actor on a character page OR a
// staff member on an anime page (/tools/library/anime/voiceactor/<malId> — the route is
// person-id based; the name is historical). Pulls the person's bio, the anime
// they voiced, AND the anime they worked on as staff from Jikan's
// /people/{id}/full (deduped server-side). "Staff Roles" lists staff credits;
// "Voiced In" sorts by Popularity (anime members) or Newest (year) — Jikan
// returns neither per-role, so those are enriched LAZILY via one anime_detail
// per title, capped (default 30) with a "Show more" that extends BOTH the enrich
// window and the rendered card count; the list reflows as metadata streams in.
// Staff Roles cap at 30 with a "See all" toggle. Each section appears only when
// it has entries.

import { useEffect, useMemo, useRef, useState } from 'react';
import { videoApi } from './api.js';
import { FilterChip as Pill } from '@host/components/ui/index.js';
import LoadingScreen from './LoadingScreen.jsx';
import ImageLightbox, { useLightbox } from './ImageLightbox.jsx';

const ENRICH_STEP = 30;
const STAFF_CAP = 30;

function initials(text) {
  const w = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return w.slice(0, 2).map(s => s[0].toUpperCase()).join('');
}

function compact(n) {
  if (!n) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
  return String(n);
}

function Portrait({ src, alt, accent, width = 160, ratio = '3 / 4', radius = 10, fontSize = 44 }) {
  const [failed, setFailed] = useState(false);
  const show = src && !failed;
  return (
    <div style={{
      width, aspectRatio: ratio, flexShrink: 0, borderRadius: radius, overflow: 'hidden',
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

export default function AnimeVoiceActorPage({ malId, accent }) {
  const id = Number(malId) || 0;
  const [data, setData] = useState(null);   // null = loading
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('popularity');   // 'popularity' | 'newest'
  const [meta, setMeta] = useState({});      // animeId → { members, year }
  const [enrichTarget, setEnrichTarget] = useState(ENRICH_STEP);
  const [staffExpanded, setStaffExpanded] = useState(false);
  const reqId = useRef(0);
  const metaRef = useRef({});
  const lb = useLightbox();
  useEffect(() => { metaRef.current = meta; }, [meta]);

  useEffect(() => {
    if (!id) { setError('Invalid voice actor.'); return; }
    const my = ++reqId.current;
    setData(null); setError(null); setMeta({}); setEnrichTarget(ENRICH_STEP);
    Promise.resolve(videoApi.personFull(id))
      .then(d => { if (my === reqId.current) setData(d || {}); })
      .catch(e => { if (my === reqId.current) setError((e && e.message) || 'Failed to load voice actor.'); });
  }, [id]);

  useEffect(() => {
    if (data && data.name) {
      document.title = 'Anime · ' + data.name;
      return () => { document.title = 'Citadel'; };
    }
  }, [data]);

  const roles = (data && data.roles) || [];
  const staffRoles = (data && data.staffRoles) || [];

  // Lazily enrich the first `enrichTarget` roles for sort metadata, ONE AT A
  // TIME (Jikan calls fully serialize backend-side). Sequential + cancellable so
  // navigating away stops further calls instead of leaving dozens queued ahead
  // of the next page's fetches. Results stream into `meta`, which `sorted` recomputes from.
  useEffect(() => {
    if (!roles.length) return;
    let cancelled = false;
    (async () => {
      for (const r of roles.slice(0, enrichTarget)) {
        if (cancelled) return;
        if (r.animeId in metaRef.current) continue;
        try {
          const d = await videoApi.animeDetail(r.animeId);
          if (cancelled) return;
          setMeta(m => ({ ...m, [r.animeId]: { members: d.members || 0, year: d.year || 0 } }));
        } catch {
          if (cancelled) return;
          setMeta(m => ({ ...m, [r.animeId]: { members: 0, year: 0 } }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles, enrichTarget]);

  const sorted = useMemo(() => {
    const arr = [...roles];
    const m = (r) => meta[r.animeId] || {};
    if (sort === 'newest') arr.sort((a, b) => (m(b).year || 0) - (m(a).year || 0));
    else arr.sort((a, b) => (m(b).members || 0) - (m(a).members || 0));
    return arr;
  }, [roles, meta, sort]);

  if (error) return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!data) return <LoadingScreen accent={accent} />;

  const enrichedCount = Object.keys(meta).length;
  const enrichCeil = Math.min(enrichTarget, roles.length);
  const moreToEnrich = enrichTarget < roles.length;
  const shownStaff = staffExpanded ? staffRoles : staffRoles.slice(0, STAFF_CAP);
  const moreStaff = staffRoles.length > STAFF_CAP;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {/* Back — the topbar has no tile for a voice-actor page. */}
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
          style={{ '--accent': accent || 'var(--accent)', width: 160, padding: 0, cursor: data.image ? 'zoom-in' : 'default' }}
        >
          <span className="candy-face" style={{ padding: 0, overflow: 'hidden' }}>
            <Portrait src={data.image} alt={data.name} accent={accent} width={160} radius={0} />
          </span>
        </button>
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: 'var(--text)', lineHeight: 1.15 }}>{data.name || '—'}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
            {[staffRoles.length && `${staffRoles.length} staff ${staffRoles.length === 1 ? 'credit' : 'credits'}`,
              roles.length && `${roles.length} voiced`].filter(Boolean).join('  ·  ') || 'No anime credits listed'}
          </div>
          {data.about && (
            <p style={{
              marginTop: 6, fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)',
              maxWidth: 680, whiteSpace: 'pre-wrap',
            }}>{data.about}</p>
          )}
        </div>
      </div>

      {/* Empty state — Jikan returned neither staff nor voice credits. */}
      {staffRoles.length === 0 && roles.length === 0 && (
        <div style={{
          padding: '8px 24px 28px', fontSize: 13, color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)', letterSpacing: '0.03em',
        }}>No public credits listed for this person.</div>
      )}

      {/* Staff Roles — anime this person worked on (non-voice). Shown first,
          above Voiced In; each section appears only when it has entries. */}
      {staffRoles.length > 0 && (
        <div style={{ padding: '0 24px 28px' }}>
          <div style={{
            fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            padding: '0 0 10px', borderBottom: '1px solid var(--border)', marginBottom: 14,
          }}>Staff Roles</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {shownStaff.map(r => <StaffRoleCard key={r.animeId} role={r} accent={accent} />)}
          </div>
          {moreStaff && (
            <div style={{ marginTop: 14 }}>
              <button type="button" onClick={() => setStaffExpanded(v => !v)} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: accent || 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.04em',
              }}>{staffExpanded ? 'See less ↑' : `See all (${staffRoles.length}) ↓`}</button>
            </div>
          )}
        </div>
      )}

      {/* Voiced In — sortable VA filmography (lazily enriched). */}
      {roles.length > 0 && (
        <div style={{ padding: '0 24px 28px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '0 0 10px', borderBottom: '1px solid var(--border)', marginBottom: 14,
          }}>
            <span style={{
              fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
              letterSpacing: '0.08em', textTransform: 'uppercase', marginRight: 'auto',
            }}>Voiced In</span>
            <Pill active={sort === 'popularity'} accent={accent} onClick={() => setSort('popularity')}>Popularity</Pill>
            <Pill active={sort === 'newest'} accent={accent} onClick={() => setSort('newest')}>Newest</Pill>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {sorted.slice(0, enrichTarget).map(r => <RoleCard key={r.animeId} role={r} meta={meta[r.animeId]} accent={accent} />)}
          </div>
          <div style={{
            marginTop: 14, fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span>
              Sorted across {enrichedCount}/{enrichCeil} enriched
              {roles.length > enrichCeil ? ` (of ${roles.length})` : ''}
            </span>
            {moreToEnrich && (
              <button type="button" onClick={() => setEnrichTarget(t => t + ENRICH_STEP)} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: accent || 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.04em',
              }}>Show more ▾</button>
            )}
          </div>
        </div>
      )}
      <ImageLightbox {...lb} accent={accent} />
    </div>
  );
}

function RoleCard({ role, meta, accent }) {
  const year = meta && meta.year ? meta.year : null;
  const members = meta && meta.members ? compact(meta.members) : null;
  return (
    <button
      type="button"
      onClick={() => { window.location.hash = '/tools/library/anime/title/' + role.animeId; }}
      className="candy-btn"
      data-shape="tile"
      title={`Open ${role.title}`}
      style={{
        '--accent': accent || 'var(--accent)',
        width: 132, cursor: 'pointer',
      }}
    >
      <div className="candy-face" style={{ padding: 0, overflow: 'hidden', textAlign: 'left' }}>
      <div style={{
        aspectRatio: '2 / 3', background: 'var(--surface-3)', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {role.image
          ? <img src={role.image} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--text-muted)' }}>{initials(role.title)}</span>}
      </div>
      <div style={{ padding: '7px 9px 9px' }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden', lineHeight: 1.25,
        }}>{role.title}</div>
        {role.character && (
          <div style={{
            fontSize: 10, color: 'var(--text-muted)', marginTop: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{role.character}</div>
        )}
        {(year || members || role.role) && (
          <div style={{
            fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
            letterSpacing: '0.04em', marginTop: 4,
            display: 'flex', gap: 6, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums',
          }}>
            {year && <span>{year}</span>}
            {members && <span>{members}♥</span>}
            {role.role && <span style={{ textTransform: 'uppercase' }}>{role.role}</span>}
          </div>
        )}
      </div>
      </div>
    </button>
  );
}

// Staff-credit card → its anime. Mirrors RoleCard's poster shape, but lists the
// position(s) held instead of a character/popularity line. No lazy enrichment.
function StaffRoleCard({ role, accent }) {
  const positions = (role.positions || []).join(', ');
  return (
    <button
      type="button"
      onClick={() => { window.location.hash = '/tools/library/anime/title/' + role.animeId; }}
      className="candy-btn"
      data-shape="tile"
      title={`Open ${role.title}`}
      style={{
        '--accent': accent || 'var(--accent)',
        width: 132, cursor: 'pointer',
      }}
    >
      <div className="candy-face" style={{ padding: 0, overflow: 'hidden', textAlign: 'left' }}>
      <div style={{
        aspectRatio: '2 / 3', background: 'var(--surface-3)', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {role.image
          ? <img src={role.image} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--text-muted)' }}>{initials(role.title)}</span>}
      </div>
      <div style={{ padding: '7px 9px 9px' }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden', lineHeight: 1.25,
        }}>{role.title}</div>
        {positions && (
          <div title={positions} style={{
            fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
            letterSpacing: '0.04em', marginTop: 4, textTransform: 'uppercase',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{positions}</div>
        )}
      </div>
      </div>
    </button>
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
