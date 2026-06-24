// Clickable anime taxonomy — Studios / Genres / Themes / Demographics /
// Producers. Each value is a candy chip that opens the native in-app discovery
// grid (anime_discover) for that taxon. Producers share MAL's producer-id space
// with studios, so both route via the `studio` resolver. The row label is a
// bold white header. TaxonRow is exported so the detail header can place rows.

const KIND_LABEL = {
  genre: 'Genres', theme: 'Themes', demographic: 'Demographic',
  studio: 'Studios', producer: 'Producers', type: 'Type', season: 'Premiered',
};
// Route segment per kind — producers resolve through the studio/producer lookup.
const KIND_ROUTE = {
  genre: 'genre', theme: 'theme', demographic: 'demographic',
  studio: 'studio', producer: 'studio', type: 'type', season: 'season',
};

export function go(kind, name) {
  window.location.hash =
    '/tools/library/anime/browse/' + KIND_ROUTE[kind] + '/' + encodeURIComponent(name);
}

export function TaxonRow({ kind, label, values, accent }) {
  if (!values || values.length === 0) return null;
  const a = accent || 'var(--accent)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{label || KIND_LABEL[kind]}:</span>
      <div className="candy-chip-row">
        {values.map(v => (
          <button
            key={v}
            type="button"
            data-own-press
            onClick={() => go(kind, v)}
            className="candy-btn"
            data-shape="chip"
            title={`Discover ${v} on MyAnimeList`}
            style={{ '--accent': a }}
          ><span className="candy-face">{v}</span></button>
        ))}
      </div>
    </div>
  );
}

export default function TaxonLinks({ studios, genres, themes, demographics, producers, accent, gap = 8 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      <TaxonRow kind="genre" values={genres} accent={accent} />
      <TaxonRow kind="theme" values={themes} accent={accent} />
      <TaxonRow kind="demographic" values={demographics} accent={accent} />
      <TaxonRow kind="studio" values={studios} accent={accent} />
      <TaxonRow kind="producer" values={producers} accent={accent} />
    </div>
  );
}
