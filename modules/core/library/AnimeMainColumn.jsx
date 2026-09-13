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
import { usePersistedState } from '@host/components/vault-tree/useTreeExpansion.js';
import { EyebrowHeading } from '@host/components/ui/Eyebrow.jsx';

// Body prose colour — the synopsis tone every other film text now matches.
export const BODY_COLOR = 'color-mix(in oklch, var(--text-2), var(--text-muted) 33%)';

// A film's credits arrive as flat string lists written by Rust: "Tom Skerritt as
// Dallas" (cast) or "Ridley Scott — Director" (crew). Splitting on the LAST
// separator keeps a name containing " as " intact.
function splitCredit(entry, sep) {
  const i = entry.lastIndexOf(sep);
  if (i < 0) return { name: entry, role: '' };
  return { name: entry.slice(0, i).trim(), role: entry.slice(i + sep.length).trim() };
}

// Cast / Crew as FUSED PAIRS: a headshot button welded on top of the name chip,
// the two reading as one unit -- the vertical twin of .candy-split (which is
// row-only: it overlaps with margin-left and squares the start/end corners, so
// a column needs its own rule set, .candy-stack).
//
// The name chip is UNCHANGED from the plain-chip version: same .candy-btn
// [data-shape="chip"], same name + role, same auto width. The photo simply
// takes whatever width that name needs, cropped to fill. Both halves press.
//
// Images arrive as a list parallel to the names BY INDEX (Rust writes
// `Cast Images` / `Crew Images` alongside `Cast` / `Crew`, an empty string where
// TMDb has no headshot), so the pairing is positional -- never re-sort one list
// without the other.
function CreditPair({ name, role, image }) {
  const title = role ? `${name} — ${role}` : name;
  return (
    <span className="candy-stack" title={title}>
      <span className="candy-btn film-credit-photo" data-shape="chip">
        <span className="candy-face">
          {image
            ? <img src={image} alt="" loading="lazy" />
            : <span className="film-credit-nophoto" aria-hidden>—</span>}
        </span>
      </span>
      <span className="candy-btn" data-shape="chip">
        <span className="candy-face">
          {name}
          {role && <span className="film-credit-role">{role}</span>}
        </span>
      </span>
    </span>
  );
}

// No portraits at all in a list (TMDb had none for anyone) -> fall back to the
// bare chips rather than a run of empty grey boxes.
function CreditList({ entries, images, sep }) {
  const rows = (entries || []).filter(Boolean).map(e => splitCredit(e, sep));
  if (!rows.length) return null;
  const imgs = Array.isArray(images) ? images : [];
  const anyPhoto = imgs.some(Boolean);
  return (
    <div className={'film-credit-list' + (anyPhoto ? ' has-photos' : '')}>
      {rows.map((r, i) => (anyPhoto
        ? <CreditPair key={`${r.name}-${i}`} name={r.name} role={r.role} image={imgs[i] || ''} />
        : (
          <span key={`${r.name}-${i}`} className="candy-btn" data-shape="chip"
            title={r.role ? `${r.name} — ${r.role}` : r.name}>
            <span className="candy-face">
              {r.name}
              {r.role && <span className="film-credit-role">{r.role}</span>}
            </span>
          </span>
        )))}
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

function FilmColumn({
  accent, synopsis, cast, crew, castImages, crewImages, writer, studios, country, budget, boxOffice, trailer,
}) {
  const [tab, setTab] = usePersistedState('library:filmTab', 'Cast');
  const trailerObj = normalizeTrailer(trailer);
  const active = FILM_TABS.includes(tab) ? tab : 'Cast';
  const details = [
    ['Studios', list(studios)],
    ['Country', list(country)],
    ['Budget', money(budget)],
    ['Box Office', money(boxOffice)],
  ].filter(([, v]) => v != null && v !== '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {synopsis && (
        <p style={{
          margin: 0, fontSize: 13, lineHeight: 1.6, color: BODY_COLOR,
          maxWidth: 760, whiteSpace: 'pre-wrap',
        }}>{synopsis}</p>
      )}
      {/* .candy-split — the shared default for a run of buttons that reads as
          ONE unit (Component Map § Default Components), the same fused shell the
          titlebar's Settings / Recycling bin / Processes / Downloads run uses.
          CSS-only: a div plus ordinary .candy-btn children, sized by --cbtn-size. */}
      <div className="candy-split" style={{ '--accent': accent || 'var(--accent)', '--cbtn-size': '26px' }}>
        {FILM_TABS.map(t => (
          <button
            key={t}
            type="button"
            data-own-press
            data-shape="chip"
            className={'candy-btn is-hover-accent' + (t === active ? ' is-active' : '')}
            onClick={() => setTab(t)}
          ><span className="candy-face">{t}</span></button>
        ))}
      </div>
      <div>
        {active === 'Cast' && ((cast || []).length
          ? <CreditList entries={cast} images={castImages} sep=" as " />
          : <EmptyTab>No cast listed.</EmptyTab>)}
        {active === 'Crew' && (
          <>
            <CreditList entries={crew} images={crewImages} sep=" — " />
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
        {active === 'Releases' && <EmptyTab>No release information on this card yet.</EmptyTab>}
        {active === 'Videos' && (trailerObj
          ? <div style={{ maxWidth: 420 }}><AnimeTrailer trailer={trailerObj} accent={accent} /></div>
          : <EmptyTab>No videos on this card.</EmptyTab>)}
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
  cast, crew, castImages, crewImages, filmLayout, writer, studios, country, budget, boxOffice, trailer,
}) {
  if (filmLayout) {
    return (
      <FilmColumn
        accent={accent} synopsis={synopsis} cast={cast} crew={crew} writer={writer}
        castImages={castImages} crewImages={crewImages}
        studios={studios} country={country} budget={budget} boxOffice={boxOffice}
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
