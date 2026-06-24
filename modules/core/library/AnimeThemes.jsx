// Opening / ending theme songs for one anime. Pure presentational — the strings
// arrive already parsed (from the owned card's frontmatter or the discovery
// detail). Two stacked sections, each a list of .anime-themes__item rows.
// Renders nothing when both lists are empty.

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 12,
    }}>{children}</div>
  );
}

function ThemeList({ title, items, accent }) {
  if (!items || !items.length) return null;
  return (
    <section style={{ '--accent': accent || 'var(--accent)' }}>
      <SectionHeader>{title}</SectionHeader>
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
