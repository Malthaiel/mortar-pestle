// Shared MyAnimeList-style detail header — used by BOTH the owned view
// (SeriesDetail) and the discovery view (DiscoveryDetail). Layout:
//
//   Title (large)                                        [ MyAnimeList ↗ ]
//   English title
//   ┌─ LEFT ──┐  ┌─ RIGHT COLUMN (over the synopsis) ───────────────────┐
//   │ cover   │  │ ┌score┐ ┌─ left stats ─┐ ┌─ trailer ─┐  (equal height) │
//   │ (small) │  │ │     │ │ Ranked  Pop  │ │  ▶ thumb   │                │
//   │ Japanese│  │ │     │ │ Members …    │ │           │                │
//   │ Synonyms│  │ └─────┘ └──────────────┘ └───────────┘                │
//   │ Source… │  │ ┌─ controls ────────────────────────────────────────┐ │
//   │ chips   │  │ │ [Rating][Status][Play][Reveal][More] (uniform)    │ │
//   │ histo   │  │ └───────────────────────────────────────────────────┘ │
//   └─────────┘  │ Synopsis · Background · Characters · …                 │
//                └───────────────────────────────────────────────────────┘
//
// Score + left-stats + trailer panels (equal height) and the controls panel sit
// at the TOP of the right column, OVER the synopsis (passed as `rightColumn`).
// Source/Rating/Broadcast/Aired sit under the alt-titles in the left column.
// Premiered / Type / Studios render as clickable candy chips (taxon discovery).

import { cloneElement } from 'react';
import { go as goTaxon } from './TaxonLinks.jsx';
import { BODY_COLOR as FILM_BODY_COLOR } from './AnimeMainColumn.jsx';
import { candyCenterOffset } from '@host/util/candy.js';
import ImageLightbox, { useLightbox } from './ImageLightbox.jsx';
import AnimeStatistics from './AnimeStatistics.jsx';
import AnimeTrailer, { normalizeTrailer } from './AnimeTrailer.jsx';
import { IconStarMark } from '@host/components/icons.jsx';

// 15% off the 260 the film poster shipped at (2026-09-12).
// Exported: the music detail pages size their sleeve column off the same
// constant rather than restating it.
export const FILM_POSTER_W = 221;

// The separator between two facts on the film's fact line. Module scope and
// exported so the album and playlist fact lines use the same mark.
export const FILM_DOT = <span aria-hidden>·</span>;

const fmtNum = (n) => (n == null || n === '' ? null : Number(n).toLocaleString());

// An ISO day as the reader's own long date. Exported because the Releases tab
// prints the same kind of day and must not re-derive the guard below.
//
// A bare YYYY-MM-DD parses as UTC midnight, which then renders as the PREVIOUS
// day in any timezone behind UTC -- 1979-06-22 showed as June 21. Build it from
// the parts so the date means the calendar day it states. Anything unparseable
// passes through as written rather than rendering "Invalid Date".
export const prettyDate = (iso) => {
  if (iso == null || iso === '') return null;
  // A MusicBrainz date can stop at the year or the month: name only what is
  // known, never a made-up 1st of January.
  const p = String(iso).match(/^(\d{4})(?:-(\d{2}))?$/);
  if (p) return p[2] ? new Date(+p[1], +p[2] - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : p[1];
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};
const has = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '');

// Label/value row for the alt-titles + the left-column Information block. The
// parent class (.anime-alt-titles / .anime-info-block) drives layout. Empty → skip.
function InfoRow({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

// A taxonomy row (Genres / Themes / Demographic / Producers) rendered to match the
// alt-titles label/value rows: a mono-uppercase label over comma-joined value text.
// Each value stays clickable (a .taxon-link) → taxon discovery page.
function TaxonTextRow({ label, kind, values, accent }) {
  const vals = (Array.isArray(values) ? values : [values]).filter(v => v != null && v !== '');
  if (!vals.length) return null;
  return (
    <div>
      <span>{label}</span>
      <span>
        {vals.map((v, i) => (
          <span key={v}>
            <span
              className="taxon-link"
              role="button"
              tabIndex={0}
              onClick={() => goTaxon(kind, v)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTaxon(kind, v); } }}
              title={`Discover ${v}`}
              style={{ '--accent': accent || 'var(--accent)' }}
            >{v}</span>{i < vals.length - 1 ? ', ' : ''}
          </span>
        ))}
      </span>
    </div>
  );
}

// Hero number — big value OVER a small mono-uppercase label. Null/empty → skipped,
// so equal-column dividers redistribute over survivors. `lead` = pre-value glyph
// (accent ★ for Score); `sub` = faint line under the label (vote count).
function HeroStat({ k, v, lead, sub }) {
  if (v == null || v === '') return null;
  return (
    <div className="anime-hero-stat">
      <span className="hv">{lead}{v}</span>
      <span className="hk">{k}</span>
      {sub != null && <span className="hsub">{sub}</span>}
    </div>
  );
}

// Clickable taxon chip for the meta rail. Same chip + goTaxon contract as the old
// StatLinkCell, lifted via candyCenterOffset() (reads the chip's own --cbtn-depth)
// so it centers against the plain-text facts despite its downward shadow slab.
function MetaChip({ kind, value, accent }) {
  return (
    <button type="button" data-own-press onClick={() => goTaxon(kind, value)}
      className="candy-btn" data-shape="chip" title={`Discover ${value}`}
      style={{ '--accent': accent || 'var(--accent)', ...candyCenterOffset() }}
    ><span className="candy-face">{value}</span></button>
  );
}

// External-source button — IMDb, Letterboxd, TMDb. 26px on a film to match the
// Download button, which is the size every control on that page shares. A film
// draws them NEUTRAL (accent on hover, like every candy button); every other
// domain keeps the standing-accent is-primary it always had.
function SourceBtn({ label, name = label, url, filmLayout }) {
  return (
    <button
      onClick={() => { window.location.hash = '/tools/browser/' + encodeURIComponent(url); }}
      title={`Open this title on ${name} in the in-app browser`}
      data-shape={filmLayout ? 'chip' : undefined}
      className={filmLayout ? 'candy-btn' : 'candy-btn is-primary'}
      style={{ height: filmLayout ? 26 : 30 }}
    ><span className="candy-face" style={{ fontSize: 11 }}>{label}</span></button>
  );
}

// Gap between the poster, the source run and whatever follows in the poster
// column. Exported with the two parts below so the album page's column cannot
// drift from the film's. The poster's tile band paints outside layout, so the
// gap is the album track list's own formula (--credit-gap + the band): the
// visible space under the poster equals the space between two tracks (16 left
// 5.5px against the tracks' 6, measured 2026-09-26).
// The poster's press depth: 1.5x a tile's, so the press reads bigger
// (user-directed 2026-09-26; 2x read too deep). Whole px: 10.5 paints a
// half-shaded row. The gap above follows it.
export const POSTER_DEPTH = 'round(var(--candy-tile-depth) * 1.5, 1px)';
export const POSTER_COL_GAP = `calc(var(--credit-gap) + ${POSTER_DEPTH})`;

// The film's source buttons as one fused run, centred under the poster.
// Exported: the album page puts Last.fm / MusicBrainz / RYM under its sleeve.
// A source may carry a short `label` for the button and its full `name` for
// the tooltip.
export function SourceRun({ sources }) {
  return (
    <div className="candy-split" style={{ '--cbtn-size': '26px', alignSelf: 'center' }}>
      {sources.map(x => <SourceBtn key={x.label} {...x} filmLayout />)}
    </div>
  );
}

// Every cover button (this poster, the album sleeve, the music cover tiles) grows
// its outline with its own width, as the rail tiles scale theirs by --tile-px
// (user-directed 2026-09-25) at HALF the rate of the width: 4px on a 96px music
// tile, ~6.6px on the 221px sleeve. Fully in step (1/24 of the width, ~9px) was
// tried the same day and read as far too thick. Floored at the tile shape's 4px:
// border widths paint rounded DOWN to whole pixels, so a 95.8px tile's 3.99px
// painted as 3px, thinner than before (photographed 2026-09-25). Rounded down to
// whole px at the source, as borders paint floored anyway.
export const COVER_BTN_STYLE = {
  '--cbtn-frame': 'round(down, max(4px, 2px + 100cqi / 48), 1px)',
};
// The container every cover button sits in, exactly its width. Not the button
// itself: an element's cqi resolves against its ANCESTOR container, so the
// button's own ledge shadow (spread = -frame) read 40px off the page while its
// face read the button (2026-09-26). Here the button and face agree.
export const COVER_BOX_STYLE = { containerType: 'inline-size', width: '100%' };
// The picture box inside every cover button: it sits in the face's own padding
// and wears the button's exact outline (--cbtn-outline at --cbtn-frame, so it
// darkens with the band on hover), and the button's own corner radius read
// off the face, equal not concentric (user-directed 2026-09-26; concentric goes
// square on big covers; the flush fill of 2026-09-25 is retired).
export const COVER_PIC_STYLE = {
  border: 'var(--cbtn-frame) solid var(--cbtn-outline)',
  borderRadius: 'inherit', overflow: 'hidden',
};
// The small grid tiles (album + playlist) halve the tile face's 8px gap around
// the picture; at ~96px the full 8px read too wide (user-directed 2026-09-26).
export const COVER_TILE_FACE_STYLE = { padding: 4 };

// The poster as a candy tile that opens the full picture. Exported: the album
// page wears the same tile for its sleeve, at a square aspect, and matches the
// music cover tiles (COVER_PIC_STYLE).
// `onClick` replaces opening the tile's own lightbox (the album sleeve opens
// its picture viewer; each picture in that viewer's list picks itself), and
// `active` lights the tile as the one on show.
// `children` stand in for the picture (a playlist's collage) and keep the tile
// pressable.
export function PosterTile({ image, title, accent, aspect = '2 / 3', onClick, active, children }) {
  const lb = useLightbox();
  return (
    <>
      <div style={COVER_BOX_STYLE}>
      <button
        type="button"
        disabled={!image && !children}
        onClick={onClick || (() => lb.show(image, title))}
        className={'candy-btn' + (active ? ' is-active' : '')}
        data-shape="tile"
        title={image ? `View ${title} cover` : title}
        style={{ ...COVER_BTN_STYLE, '--cbtn-depth': POSTER_DEPTH, '--accent': accent, width: '100%', padding: 0, cursor: image ? 'zoom-in' : 'default' }}
      >
        <span className="candy-face">
          <div style={{
            ...COVER_PIC_STYLE,
            width: '100%', aspectRatio: aspect, background: 'var(--surface-3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {children || (image
              ? <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 24, color: 'var(--text-muted)' }}>—</span>)}
          </div>
        </span>
      </button>
      </div>
      {!onClick && <ImageLightbox {...lb} accent={accent} />}
    </>
  );
}

export default function AnimeDetailHeader({
  title, subtitle, malId, image, sourceUrl, sourceLabel,
  score, scoredBy, rank, popularity, members,
  genres, themes, demographics, studios, producers,
  premiered, format, episodes, duration,
  source, contentRating, broadcast, aired, trailer,
  director, cast, writer, country, crew, budget, boxOffice,
  synonyms, titleJapanese, titleEnglish,
  released, filmLayout, extraSources, backdrop,
  accent, topRight, rating, actions, rightColumn,
}) {
  const a = accent || 'var(--accent)';

  const synList = Array.isArray(synonyms) ? synonyms.filter(Boolean) : [];
  const hasAltTitles = synList.length > 0 || has(titleJapanese);
  const studiosVal = Array.isArray(studios)
    ? (studios.filter(Boolean).join(', ') || null)
    : (has(studios) ? studios : null);

  const scoreShown = score != null && score !== '';
  const trailerObj = normalizeTrailer(trailer);
  const hasTrailer = !filmLayout && !!trailerObj;
  // Left stats panel: ranked/popularity/members (large) over premiered/type/
  // studios/episodes/duration (small). Source/Rating/Broadcast/Aired live in the
  // left column under the alt-titles; the trailer takes the third top-row slot.
  const hasStatsLeft = !filmLayout && (rank != null || popularity != null || members != null
    || has(premiered) || has(format) || has(studiosVal) || has(episodes) || has(duration));
  // On a film every one of these has moved out to the tab strip, so the left
  // column below the poster is empty and must not draw an empty frame.
  const hasMoreInfo = filmLayout
    ? (has(source) || has(contentRating) || has(broadcast) || has(aired))
    : (has(source) || has(contentRating) || has(broadcast) || has(aired)
      || has(director) || has(cast) || has(writer) || has(country)
      || has(crew) || budget != null || boxOffice != null);
  // Film/TV credits. Arrays join; InfoRow drops a null row entirely, so an
  // anime card (which carries none of these) grows no empty labels.
  const list = (v) => (Array.isArray(v) ? (v.filter(Boolean).join(', ') || null) : (has(v) ? v : null));
  // A film's card holds every one of TMDb's 24 cast and 40 crew, because a
  // card is the record. This column is 200px wide, so the PAGE shows a
  // readable head of each and says how many it left — the same bargain
  // RoomTitle.jsx:141 already strikes on the pre-add page.
  const capped = (v, n) => {
    const a = Array.isArray(v) ? v.filter(Boolean) : [];
    if (!a.length) return null;
    const rest = a.length - n;
    return a.slice(0, n).join(', ') + (rest > 0 ? `  +${rest} more` : '');
  };
  // Crew is ordered by TMDb's own department weighting, which buries the
  // director under stunts on some films. Pull the jobs a viewer actually
  // asks about to the front, then let the rest follow.
  const CREW_FIRST = ['Director', 'Screenplay', 'Writer', 'Novel', 'Story', 'Producer',
    'Original Music Composer', 'Director of Photography', 'Editor'];
  const crewShown = capped(
    (Array.isArray(crew) ? crew : []).slice().sort((a, b) => {
      const rank = (s) => {
        const i = CREW_FIRST.findIndex(j => String(s).endsWith(`— ${j}`) || String(s).endsWith(`-- ${j}`));
        return i < 0 ? CREW_FIRST.length : i;
      };
      return rank(a) - rank(b);
    }),
    8,
  );
  // Whole dollars, no cents — TMDb reports these to the dollar and a film's
  // budget is an approximation anyway. Absent (not $0) when unknown; the Rust
  // client already filtered TMDb's 0-means-unknown to null.
  const money = (n) => (typeof n === 'number' && n > 0
    ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : null);
  // Genres/themes/demographics/producers stay clickable chips in the left column.
  const hasChips = has(genres) || has(themes) || has(demographics) || has(producers);
  // Meta rail facts — Episodes/Duration as plain text after the taxon chips. The
  // leading middot is suppressed (via hasMetaChips) when no chips precede them.
  const metaFacts = [
    has(episodes) ? `${episodes} ep${Number(episodes) === 1 ? '' : 's'}` : null,
    has(duration) ? duration : null,
  ].filter(Boolean).join(' · ');
  const hasMetaChips = has(premiered) || has(format) || has(studiosVal);

  // A film leads with its release DAY, not a season label. Read from the card's
  // own ISO string; anything unparseable passes through as written rather than
  // rendering "Invalid Date".
  const filmDate = prettyDate(released);
  // One "open the source" button per site. Anime passes a malId and gets the MAL
  // link; other domains pass the url and label they belong to, plus whatever
  // `extraSources` the page could resolve (Letterboxd / TMDb on a film).
  const sources = [
    (sourceUrl || malId)
      ? { label: sourceLabel || 'MyAnimeList', url: sourceUrl || ('https://myanimelist.net/anime/' + malId) }
      : null,
    ...(Array.isArray(extraSources) ? extraSources : []),
  ].filter(x => x && x.url);
  const sourceBtns = sources.map(x => <SourceBtn key={x.label} {...x} filmLayout={filmLayout} />);
  // Sits beside the title: who directed it. The DATE used to live here too;
  // it now sits on the fact line below, immediately left of the runtime, so
  // when-and-how-long read as one pair. Stated in exactly one place either way.
  // Sits beside the title: who directed it. The DATE used to live here too;
  // it now sits on the fact line below, immediately left of the runtime, so
  // when-and-how-long read as one pair. Stated in exactly one place either way.
  const directedBy = list(director) ? `Directed by ${list(director)}` : null;
  const filmByline = directedBy;
  // The left-to-right fact line under the title. Genres stay clickable here
  // because the left column's Genres row is hidden on a film — this line
  // REPLACES that row rather than repeating it.
  const filmGenres = Array.isArray(genres) ? genres.filter(Boolean) : [];
  const hasFilmFacts = scoreShown || filmGenres.length > 0 || has(filmDate) || has(duration);
  const dot = FILM_DOT;

  return (
    // A film pads deeper at the top so more of the backdrop shows above the
    // poster and title. That padding lives in .film-detail (library.css), not
    // here: it is derived from the backdrop's own aspect and mask stops, and an
    // inline style would beat the stylesheet and re-fork the number.
    // The backdrop is unaffected either way: an absolutely positioned child lays
    // out against the PADDING box, so it stays pinned to the top edge while the
    // content slides down.
    <div className={filmLayout ? 'film-detail' : undefined}
      style={{ padding: filmLayout ? undefined : '28px 28px 24px', borderBottom: filmLayout ? 'none' : '1px solid var(--border)' }}>
      {/* The wide TMDb scene still, behind everything. Films only, and only when
          the card actually carries one — an absent Backdrop key just means the
          header keeps the flat background it always had. */}
      {filmLayout && backdrop && (
        <div className="film-backdrop" aria-hidden>
          {/* A real <img>, not a background-image: the box then takes its height
              from the FILE, so the still is never cropped at any window width and
              no aspect ratio is restated here. */}
          <img src={backdrop} alt="" />
        </div>
      )}
      {/* Title bar — title + English (+ subtitle) stacked on the left; the MyAnimeList
          button on the right, vertically centered between the title and English.
          A film skips this band entirely: its title sits beside the poster and
          its source buttons ride that same line, so nothing floats alone up here. */}
      {!filmLayout && (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: 'var(--text)', lineHeight: 1.12, letterSpacing: '-0.015em' }}>{title}</h2>
          {has(titleEnglish) && titleEnglish !== title && (
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.25 }}>{titleEnglish}</div>
          )}
          {subtitle && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{subtitle}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {sourceBtns}
          {topRight}
        </div>
      </div>
      )}

      {/* Left column (cover + info + chips) | right column (panels over synopsis) */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: filmLayout ? 0 : 18 }}>
        {/* ── LEFT COLUMN ── */}
        <div style={{ width: filmLayout ? FILM_POSTER_W : 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: POSTER_COL_GAP }}>
          {/* Cover → lightbox */}
          <PosterTile image={image} title={title} accent={a} />

          {/* Source buttons sit under the poster on a film: the title line above
              carries enough already, and the poster column is the one place they
              are the full column width with nothing to compete with. */}
          {filmLayout && sources.length > 0 && <SourceRun sources={sources} />}

          {/* Information — unified MAL-style label/value list: Japanese, Synonyms,
              Source, Rating, Broadcast, Aired, Genres, Themes, Demographic, Producers.
              Taxa values stay clickable (text links) for taxon discovery. */}
          {(hasAltTitles || hasMoreInfo || hasChips) && (
            <div className="anime-alt-titles">
              <InfoRow label="Japanese" value={has(titleJapanese) ? titleJapanese : null} />
              <InfoRow label="Synonyms" value={synList.length ? synList.join(', ') : null} />
              <InfoRow label="Source" value={has(source) ? source : null} />
              <InfoRow label="Rating" value={has(contentRating) ? contentRating : null} />
              <InfoRow label="Broadcast" value={has(broadcast) ? broadcast : null} />
              <InfoRow label="Aired" value={has(aired) ? aired : null} />
              {/* On a film these move up to the title line and out to the Cast
                  and Crew rails, so the column never says it twice. */}
              {!filmLayout && <InfoRow label="Director" value={list(director)} />}
              {!filmLayout && <InfoRow label="Cast" value={capped(cast, 8) || list(cast)} />}
              {!filmLayout && <InfoRow label="Writer" value={list(writer)} />}
              {!filmLayout && <InfoRow label="Country" value={list(country)} />}
              {!filmLayout && <InfoRow label="Crew" value={crewShown} />}
              {!filmLayout && <InfoRow label="Budget" value={money(budget)} />}
              {!filmLayout && <InfoRow label="Box Office" value={money(boxOffice)} />}
              {!filmLayout && <TaxonTextRow label="Genres" kind="genre" values={genres} accent={a} />}
              <TaxonTextRow label="Themes" kind="theme" values={themes} accent={a} />
              <TaxonTextRow label="Demographic" kind="demographic" values={demographics} accent={a} />
              <TaxonTextRow label="Producers" kind="producer" values={producers} accent={a} />
            </div>
          )}

          {/* Score histogram + status breakdown (live Jikan fetch) */}
          {malId ? <AnimeStatistics malId={malId} accent={a} /> : null}
        </div>

        {/* ── RIGHT COLUMN — score + left stats + trailer + controls OVER synopsis ── */}
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* FILM HEAD — title beside the poster, release date + director on the
              same line, then rating / date / genres / runtime left to right. */}
          {filmLayout && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 'calc(28px * var(--film-head))', fontWeight: 700, color: 'var(--text)', lineHeight: 1.12, letterSpacing: '-0.015em' }}>{title}</h2>
                {filmByline && <span style={{ fontSize: 'calc(13px * var(--film-head))', color: FILM_BODY_COLOR }}>{filmByline}</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {topRight}
                </div>
              </div>
              {hasFilmFacts && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'calc(12px * var(--film-head))', color: FILM_BODY_COLOR }}>
                  {scoreShown && (
                    <span>
                      <span className="anime-hero-star" aria-hidden="true"><IconStarMark size="0.95em"/> </span>{score}
                    </span>
                  )}
                  {scoreShown && (filmGenres.length > 0 || has(duration)) ? dot : null}
                  {filmGenres.map((g, i) => (
                    <span key={g}>
                      <span
                        className="taxon-link"
                        role="button"
                        tabIndex={0}
                        onClick={() => goTaxon('genre', g)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTaxon('genre', g); } }}
                        title={`Discover ${g}`}
                        style={{ '--accent': a }}
                      >{g}</span>{i < filmGenres.length - 1 ? ',' : ''}
                    </span>
                  ))}
                  {filmGenres.length > 0 && (has(filmDate) || has(duration)) ? dot : null}
                  {has(filmDate) && <span>{filmDate}</span>}
                  {has(filmDate) && has(duration) ? dot : null}
                  {has(duration) && <span>{duration}</span>}
                </div>
              )}
            </div>
          )}
          {((!filmLayout && (scoreShown || hasStatsLeft || hasTrailer)) || rating || actions) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(!filmLayout && (scoreShown || hasStatsLeft || hasTrailer)) && (
                <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap', '--panel-h': '124px' }}>
                  {/* UNIFIED PANEL — hero numbers (hairline-divided) + meta rail; takes the freed width */}
                  {(scoreShown || hasStatsLeft) && (
                    <div className="candy-panel anime-unified-panel" style={{ flex: 1.4, minWidth: 280 }}>
                      <div className="anime-hero-row">
                        <HeroStat k="Score" v={scoreShown ? score : null}
                          lead={<span className="anime-hero-star" aria-hidden="true"><IconStarMark size="0.95em"/> </span>}
                          sub={scoredBy != null ? fmtNum(scoredBy) : null} />
                        <HeroStat k="Ranked" v={rank != null ? `#${fmtNum(rank)}` : null} />
                        <HeroStat k="Popularity" v={popularity != null ? `#${fmtNum(popularity)}` : null} />
                        <HeroStat k="Members" v={fmtNum(members)} />
                      </div>
                      {(hasMetaChips || metaFacts) && (
                        <div className="anime-meta-rail">
                          {(Array.isArray(premiered) ? premiered : [premiered]).filter(v => v != null && v !== '')
                            .map(v => <MetaChip key={`s-${v}`} kind="season" value={v} accent={a} />)}
                          {(Array.isArray(format) ? format : [format]).filter(v => v != null && v !== '')
                            .map(v => <MetaChip key={`t-${v}`} kind="type" value={v} accent={a} />)}
                          {(Array.isArray(studios) ? studios : [studios]).filter(v => v != null && v !== '')
                            .map(v => <MetaChip key={`st-${v}`} kind="studio" value={v} accent={a} />)}
                          {metaFacts && <span className="anime-meta-fact">{hasMetaChips ? '· ' : ''}{metaFacts}</span>}
                        </div>
                      )}
                    </div>
                  )}
                  {/* TRAILER — 16:9, fills the row height to match the stats panel */}
                  {hasTrailer && (
                    <div style={{ flexShrink: 0, display: 'flex' }}>
                      <AnimeTrailer trailer={trailerObj} accent={a} fill />
                    </div>
                  )}
                </div>
              )}

              {/* CONTROLS — uniform-height buttons, evenly spaced, vertically centered */}
              {!filmLayout && (rating || actions) && (
                <div className={filmLayout ? 'anime-controls-box is-bare' : 'candy-panel anime-controls-box'}>
                  <div className="anime-rail-controls">
                    {rating}
                    {actions}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Synopsis + credits etc. (passed by the page) */}
          {/* On a film the controls belong on the tab strip line, and the tab
              strip lives inside the main column — so they are handed down
              rather than rendered in their own box above it. */}
          {filmLayout && (rating || actions)
            ? cloneElement(rightColumn, { tabActions: <>{rating}{actions}</> })
            : rightColumn}
        </div>
      </div>
    </div>
  );
}
