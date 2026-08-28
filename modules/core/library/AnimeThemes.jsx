// Opening / ending theme songs for one anime. Pure presentational — the strings
// arrive already parsed (from the owned card's frontmatter or the discovery
// detail). Two stacked sections, each a list of .anime-themes__item rows.
// Renders nothing when both lists are empty.



import { EyebrowHeading } from '@host/components/ui/Eyebrow.jsx';
function ThemeList({ title, items, accent }) {
  if (!items || !items.length) return null;
  return (
    <section style={{ '--accent': accent || 'var(--accent)' }}>
      <EyebrowHeading>{title}</EyebrowHeading>
      <div className="anime-themes">
        {items.map((t, i) => (
          <div key={i} className="anime-themes__item">{t}</div>
        ))}
      </div>
    </section>
  );
}

export default function AnimeThemes({ openings, endings, accent }) {
  const ops = openings || [];
  const eds = endings || [];
  if (!ops.length && !eds.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <ThemeList title="Opening Theme" items={ops} accent={accent} />
      <ThemeList title="Ending Theme" items={eds} accent={accent} />
    </div>
  );
}
