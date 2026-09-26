// The full right-hand column of an anime detail page (owned + discovery), in MAL
// reading order: trailer → synopsis → background → credits → themes →
// recommendations. The two text sections (Synopsis / Background) are owned here;
// every other block is a self-skipping sibling, so the column passes data
// straight through and each child renders nothing when it has nothing to show.
// Mounted as AnimeDetailHeader's rightColumn on both SeriesDetail (owned) and
// DiscoveryDetail (not-owned), replacing the old inline synopsis + AnimeCredits.
//
// A FILM takes a different shape (filmLayout): the synopsis leads with no
// heading, then one Seg tab strip — Cast · Crew · Details · Releases · Videos —
// shows exactly one section at a time. Everything the header used to list in its
// left column (studios, writer, country, budget, box office) lives in those tabs
// now, so the page says each fact once.

import AnimeCredits from './AnimeCredits.jsx';
import AnimeThemes from './AnimeThemes.jsx';
import AnimeRecommendations from './AnimeRecommendations.jsx';
import AnimeTrailer, { normalizeTrailer } from './AnimeTrailer.jsx';
import { prettyDate } from './AnimeDetailHeader.jsx';
import { usePersistedState } from '@host/components/vault-tree/useTreeExpansion.js';
import { EyebrowHeading } from '@host/components/ui/Eyebrow.jsx';
import { useState } from 'react';
import { characterImage } from '@host/util/characterImage.js';

// Body prose colour — the synopsis tone every other film text now matches.
export const BODY_COLOR = 'color-mix(in oklch, var(--text-2), var(--text-muted) 33%)';

// A film's credits arrive as flat string lists written by Rust: "Tom Skerritt as
// Dallas" (cast) or "Ridley Scott — Director" (crew). Splitting on the LAST
// separator keeps a name containing " as " intact.
function splitCredit(entry, sep) {
  const i = entry.lastIndexOf(sep);
  if (i < 0) return { name: entry, role: '' };
  return { name: entry.slice(0, i).trim(), role: role(entry.slice(i + sep.length)) };
}

// TMDb tags an animated film's every character "(voice)" -- true of the whole
// cast, so it tells the reader nothing and doubles the length of every chip.
const role = (s) => s.trim().replace(/\s*\(voice\)/gi, '');

// One chip: a bold thing, and the quieter thing about it. Cast uses it for
// name/character, Crew for name/job, Releases for country/certificate -- one
// shape, so those three lists can never drift apart visually.
// `character` carries what the tooltip needs to go looking for a picture OF the
// character: the film and its studio. Absent (crew, releases, live action) the
// chip is exactly what it was -- one photo or none.
function Chip({ name, role, img, character }) {
  const [charImg, setCharImg] = useState(null);
  // Asked for on hover, not up front: a cast list is 20 names and a page visit
  // touches two of them. The wait before a tooltip shows usually covers the
  // round trip, and every answer is cached, so a second hover is instant.
  const look = () => {
    if (!character || !role || charImg) return;
    characterImage(character.film, character.studios, role).then(src => src && setCharImg(src));
  };
  // Each face carries its own name under it in the tooltip. With only the actor's
  // photo the role has nowhere to sit, so it drops to the description line rather
  // than being lost.
  return (
    <span className="candy-btn" data-shape="chip"
      title={role ? `${name} — ${role}` : name}
      onPointerEnter={character ? look : undefined}
      data-tip-img={img || undefined}
      data-tip-img2={charImg || undefined}
      data-tip-cap={img ? name : undefined}
      data-tip-cap2={charImg ? role : undefined}
      data-tip-desc={img && !charImg && role ? role : undefined}>
      <span className="candy-face">
        {name}
        {role && <span className="film-credit-role">{role}</span>}
      </span>
    </span>
  );
}

// Cast / Crew as plain chips: name, plus the role beside it. Headshots INLINE
// were tried and reverted (2026-09-12) -- the list stays text. The stored
// portrait rides the hover tooltip instead: `images` is TMDb's list, index-aligned
// with `entries` and blank where TMDb has no photo.
function CreditList({ entries, sep, images, character }) {
  // Pair each entry with its photo BEFORE dropping blanks, or one empty name
  // shifts every portrait after it onto the wrong person.
  const rows = (entries || [])
    .map((e, i) => (e ? { ...splitCredit(e, sep), img: (images || [])[i] } : null))
    .filter(Boolean);
  if (!rows.length) return null;
  return (
    <div className="film-credit-list">
      {rows.map((r, i) => (
        <Chip key={`${r.name}-${i}`} name={r.name} role={r.role} img={r.img} character={character} />
      ))}
    </div>
  );
}

// A country CODE is not a country: the platform already ships the name table for
// the reader's own language, so nothing here holds a list of 200 countries that
// would go stale. An unknown code falls back to the code itself.
const REGION_NAMES = (() => {
  try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; }
})();
const country = (code) => {
  try { return REGION_NAMES?.of(code) || code; } catch { return code; }
};

// Release dates arrive as flat "YYYY-MM-DD|CC|CERT" lines, already sorted by the
// Rust client. Group the run of lines sharing a day into one dated block -- the
// same shape IMDb's release-info page uses, because a film's release is a
// sequence of days, not a list of countries.
//
// No flags: Windows ships no flag glyphs in its emoji font and paints the two
// letters of the code instead, which is worse than the country's own name.
function ReleaseList({ entries }) {
  const days = [];
  for (const e of (entries || []).filter(Boolean)) {
    const [date, code, cert] = String(e).split('|');
    if (!date || !code) continue;
    if (!days.length || days[days.length - 1].date !== date) days.push({ date, rows: [] });
    days[days.length - 1].rows.push({ code, cert });
  }
  if (!days.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {days.map(d => (
        <div key={d.date} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{prettyDate(d.date)}</div>
          <div className="film-credit-list">
            {d.rows.map((r, i) => <Chip key={`${r.code}-${i}`} name={country(r.code)} role={r.cert} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// Label/value row matching the header's Information block, so the Details tab
// reads as the same list it was lifted out of.
function InfoRow({ label, value }) {
  if (value == null || value === '') return null;
  return <div><span>{label}</span><span>{value}</span></div>;
}

const list = (v) => (Array.isArray(v) ? (v.filter(Boolean).join(', ') || null) : (v || null));
// Whole dollars, no cents. Absent (not $0) when unknown — the Rust client
// already filtered TMDb's 0-means-unknown to null.
const money = (n) => (typeof n === 'number' && n > 0
  ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : null);

const FILM_TABS = ['Cast', 'Crew', 'Details', 'Releases', 'Videos'];

// Nothing to show yet — said plainly rather than as a blank panel, so an empty
// tab reads as "no data" instead of "broken".
function EmptyTab({ children }) {
  return <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '4px 0' }}>{children}</div>;
}

function FilmColumn({ tabActions,
  accent, synopsis, cast, crew, castImages, crewImages, writer, studios, countries, releases, budget, boxOffice, trailer,
  filmTitle, genres,
}) {
  const [tab, setTab] = usePersistedState('library:filmTab', 'Cast');
  // Only animated films go looking for a character's face. In live action the
  // "character" picture a wiki returns is usually another photo of the same
  // actor, which says nothing and costs a request.
  const animated = (genres || []).some(g => /animation/i.test(g))
    ? { film: filmTitle, studios }
    : null;
  const trailerObj = normalizeTrailer(trailer);
  const active = FILM_TABS.includes(tab) ? tab : 'Cast';
  const details = [
    ['Studios', list(studios)],
    ['Country', list(countries)],
    ['Budget', money(budget)],
    ['Box Office', money(boxOffice)],
  ].filter(([, v]) => v != null && v !== '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {synopsis && (
        <p style={{
          margin: 0, fontSize: 14, lineHeight: 1.6, color: BODY_COLOR,
          maxWidth: 760, whiteSpace: 'pre-wrap',
        }}>{synopsis}</p>
      )}
      {/* .candy-split — the shared default for a run of buttons that reads as
          ONE unit (Component Map § Default Components), the same fused shell the
          titlebar's Settings / Recycling bin / Processes / Downloads run uses.
          CSS-only: a div plus ordinary .candy-btn children, sized by --cbtn-size. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingBottom: 14, borderBottom: 'var(--candy-frame) solid var(--border)' }}>
        <div className="candy-split" style={{ '--accent': accent || 'var(--accent)', '--cbtn-size': '26px' }}>
          {FILM_TABS.map(t => (
            <button
              key={t}
              type="button"
              data-own-press
              data-shape="chip"
              className={'candy-btn' + (t === active ? ' is-active' : '')}
              onClick={() => setTab(t)}
            ><span className="candy-face">{t}</span></button>
          ))}
        </div>
        {tabActions && <div className="anime-rail-controls">{tabActions}</div>}
      </div>
      <div>
        {active === 'Cast' && ((cast || []).length
          ? <CreditList entries={cast} sep=" as " images={castImages} character={animated} />
          : <EmptyTab>No cast listed.</EmptyTab>)}
        {active === 'Crew' && (
          <>
            <CreditList entries={crew} sep=" — " images={crewImages} />
            {/* Writers arrive as bare names with no job attached, so they ride
                below the jobbed crew rather than pretending to one. */}
            {list(writer) && (
              <div className="anime-alt-titles" style={{ marginTop: 12 }}>
                <InfoRow label="Writer" value={list(writer)} />
              </div>
            )}
            {!(crew || []).length && !list(writer) && <EmptyTab>No crew listed.</EmptyTab>}
          </>
        )}
        {active === 'Details' && (details.length
          ? <div className="anime-alt-titles">{details.map(([k, v]) => <InfoRow key={k} label={k} value={v} />)}</div>
          : <EmptyTab>No details on this card.</EmptyTab>)}
        {active === 'Releases' && ((releases || []).length
          ? <ReleaseList entries={releases} />
          : <EmptyTab>No release dates on this card yet. Refresh details to fetch them.</EmptyTab>)}
        {active === 'Videos' && (trailerObj
          ? <div style={{ maxWidth: 420 }}><AnimeTrailer trailer={trailerObj} accent={accent} /></div>
          : <EmptyTab>No videos on this card.</EmptyTab>)}
      </div>
      </div>
    </div>
  );
}

// Body-text block (Synopsis / Background) — same prose styling as the old
// DiscoveryDetail inline synopsis (13px soft, 1.6 line-height, pre-wrap).
function TextSection({ title, body }) {
  if (!body) return null;
  return (
    <section>
      <EyebrowHeading>{title}</EyebrowHeading>
      <p style={{
        margin: 0, fontSize: 13, lineHeight: 1.6, color: BODY_COLOR,
        maxWidth: 760, whiteSpace: 'pre-wrap',
      }}>{body}</p>
    </section>
  );
}

// Credits, themes and recommendations are all live MAL fetches keyed by malId.
// A card without one (a TV show) has no such data and must not render their
// headings or skeletons — an empty CHARACTERS strip that never fills is worse
// than no strip.
export default function AnimeMainColumn({
  malId, accent, synopsis, background, openings, endings,
  cast, crew, castImages, crewImages, filmLayout, tabActions, writer, studios, country, releases, budget, boxOffice, trailer,
  filmTitle, genres,
}) {
  if (filmLayout) {
    return (
      <FilmColumn tabActions={tabActions}
        accent={accent} synopsis={synopsis} cast={cast} crew={crew} writer={writer}
        castImages={castImages} crewImages={crewImages} filmTitle={filmTitle} genres={genres}
        studios={studios} countries={country} releases={releases} budget={budget} boxOffice={boxOffice}
        trailer={trailer}
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <TextSection title="Synopsis" body={synopsis} />
      <TextSection title="Background" body={background} />
      {malId ? (
        <>
          <AnimeCredits malId={malId} accent={accent} />
          <AnimeThemes openings={openings} endings={endings} accent={accent} />
          <AnimeRecommendations malId={malId} accent={accent} />
        </>
      ) : null}
    </div>
  );
}
