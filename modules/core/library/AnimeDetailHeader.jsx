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

import { go as goTaxon } from './TaxonLinks.jsx';
import { candyCenterOffset } from '@host/util/candy.js';
import ImageLightbox, { useLightbox } from './ImageLightbox.jsx';
import AnimeStatistics from './AnimeStatistics.jsx';
import AnimeTrailer from './AnimeTrailer.jsx';

const fmtNum = (n) => (n == null || n === '' ? null : Number(n).toLocaleString());
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

export default function AnimeDetailHeader({
  title, subtitle, malId, image,
  score, scoredBy, rank, popularity, members,
  genres, themes, demographics, studios, producers,
  premiered, format, episodes, duration,
  source, contentRating, broadcast, aired, trailer,
  synonyms, titleJapanese, titleEnglish,
  accent, topRight, rating, actions, rightColumn,
}) {
  const lb = useLightbox();
  const a = accent || 'var(--accent)';

  const synList = Array.isArray(synonyms) ? synonyms.filter(Boolean) : [];
  const hasAltTitles = synList.length > 0 || has(titleJapanese);
  const studiosVal = Array.isArray(studios)
    ? (studios.filter(Boolean).join(', ') || null)
    : (has(studios) ? studios : null);

  const scoreShown = score != null && score !== '';
  const hasTrailer = !!(trailer && trailer.url);
  // Left stats panel: ranked/popularity/members (large) over premiered/type/
  // studios/episodes/duration (small). Source/Rating/Broadcast/Aired live in the
  // left column under the alt-titles; the trailer takes the third top-row slot.
  const hasStatsLeft = rank != null || popularity != null || members != null
    || has(premiered) || has(format) || has(studiosVal) || has(episodes) || has(duration);
  const hasMoreInfo = has(source) || has(contentRating) || has(broadcast) || has(aired);
  // Genres/themes/demographics/producers stay clickable chips in the left column.
  const hasChips = has(genres) || has(themes) || has(demographics) || has(producers);
  // Meta rail facts — Episodes/Duration as plain text after the taxon chips. The
  // leading middot is suppressed (via hasMetaChips) when no chips precede them.
  const metaFacts = [
    has(episodes) ? `${episodes} ep${Number(episodes) === 1 ? '' : 's'}` : null,
    has(duration) ? duration : null,
  ].filter(Boolean).join(' · ');
  const hasMetaChips = has(premiered) || has(format) || has(studiosVal);

  return (
    <div style={{ padding: '28px 28px 24px', borderBottom: '1px solid var(--border)' }}>
      {/* Title bar — title + English (+ subtitle) stacked on the left; the MyAnimeList
          button on the right, vertically centered between the title and English. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: 'var(--text)', lineHeight: 1.12, letterSpacing: '-0.015em' }}>{title}</h2>
          {has(titleEnglish) && titleEnglish !== title && (
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.25 }}>{titleEnglish}</div>
          )}
          {subtitle && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{subtitle}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {malId ? (
            <button
              onClick={() => { window.location.hash = '/tools/browser/' + encodeURIComponent('https://myanimelist.net/anime/' + malId); }}
              title="Open this title on MyAnimeList in the in-app browser"
              className="candy-btn is-primary"
              style={{ height: 30 }}
            ><span className="candy-face" style={{ fontSize: 11 }}>MyAnimeList ↗</span></button>
          ) : null}
          {topRight}
        </div>
      </div>

      {/* Left column (cover + info + chips) | right column (panels over synopsis) */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 18 }}>
        {/* ── LEFT COLUMN ── */}
        <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Cover → lightbox */}
          <button
            type="button"
            disabled={!image}
            onClick={() => lb.show(image, title)}
            className="candy-btn"
            data-shape="tile"
            title={image ? `View ${title} cover` : title}
            style={{ '--accent': a, width: '100%', padding: 0, cursor: image ? 'zoom-in' : 'default' }}
          >
            <span className="candy-face" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{
                width: '100%', aspectRatio: '2 / 3', background: 'var(--surface-3)',
                overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {image
                  ? <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 24, color: 'var(--text-muted)' }}>—</span>}
              </div>
            </span>
          </button>

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
              <TaxonTextRow label="Genres" kind="genre" values={genres} accent={a} />
              <TaxonTextRow label="Themes" kind="theme" values={themes} accent={a} />
              <TaxonTextRow label="Demographic" kind="demographic" values={demographics} accent={a} />
              <TaxonTextRow label="Producers" kind="producer" values={producers} accent={a} />
            </div>
          )}

          {/* Score histogram + status breakdown (live Jikan fetch) */}
          {malId ? <AnimeStatistics malId={malId} accent={a} /> : null}
        </div>

        {/* ── RIGHT COLUMN — score + left stats + trailer + controls OVER synopsis ── */}
        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(scoreShown || hasStatsLeft || hasTrailer || rating || actions) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(scoreShown || hasStatsLeft || hasTrailer) && (
                <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap', '--panel-h': '124px' }}>
                  {/* UNIFIED PANEL — hero numbers (hairline-divided) + meta rail; takes the freed width */}
                  {(scoreShown || hasStatsLeft) && (
                    <div className="candy-panel anime-unified-panel" style={{ flex: 1.4, minWidth: 280 }}>
                      <div className="anime-hero-row">
                        <HeroStat k="Score" v={scoreShown ? score : null}
                          lead={<span className="anime-hero-star" aria-hidden="true">★ </span>}
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
                      <AnimeTrailer trailer={trailer} accent={a} fill />
                    </div>
                  )}
                </div>
              )}

              {/* CONTROLS — uniform-height buttons, evenly spaced, vertically centered */}
              {(rating || actions) && (
                <div className="candy-panel anime-controls-box">
                  <div className="anime-rail-controls">
                    {rating}
                    {actions}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Synopsis + credits etc. (passed by the page) */}
          {rightColumn}
        </div>
      </div>

      <ImageLightbox {...lb} accent={a} />
    </div>
  );
}
