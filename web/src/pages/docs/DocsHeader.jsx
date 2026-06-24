// Sticky page header for the docs main pane. Breadcrumb above title, title
// row with last-updated chip.

function formatMtime(mtime) {
  if (!mtime) return '';
  const d = new Date(mtime);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function DocsHeader({ title, category, mtime, accent }) {
  const updated = formatMtime(mtime);
  return (
    <header className="docs-header">
      <div className="docs-breadcrumb">
        <span>Docs</span>
        {category && <>
          <span className="docs-breadcrumb-sep">›</span>
          <span>{category}</span>
        </>}
      </div>
      <div className="docs-title-row">
        <h1 className="docs-title">{title}</h1>
        {updated && (
          <span className="docs-updated-chip" title={`Last updated ${updated}`}>
            <span style={{ color: accent }}>●</span> Updated {updated}
          </span>
        )}
      </div>
    </header>
  );
}
