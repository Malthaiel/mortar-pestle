// Shared sticky page-title header for every .md viewer (Docs, vault PageView,
// Deadlock). Renders an optional breadcrumb + a title row with an optional
// last-updated chip. When `editable`, clicking the title turns it into an inline
// rename input (Enter/blur commit → onRename(cleanName), Esc cancels; path
// separators stripped, mirroring NameInputModal). Generalised + renamed from the
// old pages/docs/DocsHeader — reuses the same docs-* CSS so it renders identically.

import { useState, useRef, useEffect } from 'react';

function formatMtime(mtime) {
  if (!mtime) return '';
  const d = new Date(mtime);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function PageTitleHeader({ title, breadcrumb, mtime, accent, editable = false, onRename, actions }) {
  const updated = formatMtime(mtime);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef(null);

  // Keep the draft in sync with the live title while not editing (e.g. after a
  // rename navigates to the new page, or when switching pages).
  useEffect(() => { if (!editing) setDraft(title); }, [title, editing]);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const commit = () => {
    setEditing(false);
    const clean = draft.replace(/[\\/]/g, '').trim(); // strip path separators (NameInputModal)
    if (clean && clean !== title) onRename?.(clean);
    else setDraft(title);
  };
  const cancel = () => { setEditing(false); setDraft(title); };

  return (
    <header className="docs-header">
      {breadcrumb && <div className="docs-breadcrumb">{breadcrumb}</div>}
      <div className="docs-title-row">
        {editable && editing ? (
          <input
            ref={inputRef}
            className="docs-title docs-title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel(); }}
            onBlur={commit}
          />
        ) : (
          <h1
            className={`docs-title${editable ? ' is-editable' : ''}`}
            onClick={editable ? () => setEditing(true) : undefined}
            title={editable ? 'Click to rename' : undefined}
          >{title}</h1>
        )}
        {updated && (
          <span className="docs-updated-chip" title={`Last updated ${updated}`}>
            <span style={{ color: accent }}>●</span> Updated {updated}
          </span>
        )}
        {actions && <div className="docs-title-actions">{actions}</div>}
      </div>
    </header>
  );
}
