// Searchable picker for choosing an Idea page to move a note into. Lists every
// .md directly under Pulse/Ideas (via api.getPulseFolder), filtered client-side
// as you type. Portaled + candy-modal styled; Esc closes, ↑/↓ select, Enter
// picks. onPick receives the chosen page { path, name, title }.
//
// Note: only top-level Pulse/Ideas pages are listed; Domain subfolders aren't
// traversed yet (the folder is flat in practice).

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';

export default function IdeaPickerModal({ open, onClose, onPick }) {
  const [pages, setPages] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setSelected(0);
    let cancelled = false;
    api.getPulseFolder('Ideas')
      .then(r => {
        if (cancelled) return;
        const list = (r.pages || []).slice()
          .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
        setPages(list);
      })
      .catch(() => { if (!cancelled) setPages([]); });
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter(p =>
      (p.title || p.name).toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }, [pages, query]);

  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  if (!open) return null;

  const pick = (p) => { if (p) onPick?.(p); };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(filtered.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(filtered[selected]); }
  };

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: '14vh',
    }}>
      <div onClick={onClose} className="candy-backdrop" />
      <div role="dialog" aria-label="Move note to an Idea" className="candy-modal" style={{
        position: 'relative', width: 420, maxHeight: '60vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        animation: 'fadeIn 0.16s ease',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '13px 15px', borderBottom: '1px solid var(--border-soft)',
        }}>
          <span style={{
            fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--text-faint)',
          }}>Move to</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search Ideas…"
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font-body)',
            }}
          />
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
            border: '1px solid var(--border-2)', borderRadius: 4, padding: '2px 6px',
          }}>Esc</span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-faint)', fontSize: 12 }}>
              No ideas match.
            </div>
          ) : filtered.map((p, i) => (
            <button
              key={p.path}
              type="button"
              onMouseEnter={() => setSelected(i)}
              onClick={() => pick(p)}
              style={{
                width: '100%', textAlign: 'left',
                display: 'flex', flexDirection: 'column', gap: 1,
                padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: i === selected ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                color: 'var(--text)',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.title || p.name}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {p.path.replace(/^Pulse\//, '').replace(/\.md$/, '')}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
