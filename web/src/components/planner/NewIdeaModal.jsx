// Modal for spinning a quick note into a new stub Idea page. Title is prefilled
// from the note (editable); Domain is picked from existing Knowledge domains.
// Defaults applied by api.createStubIdea: Status Active, Tier Standard, Created
// today, Source = the daily log. onCreate({ title, domain }).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { PrimaryBtn, OutlinedBtn } from '../ui/index.js';

export default function NewIdeaModal({ open, noteText, onClose, onCreate }) {
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [domains, setDomains] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setTitle((noteText || '').slice(0, 60).trim());
    let cancelled = false;
    api.getKnowledgeDomains()
      .then(r => {
        if (cancelled) return;
        const list = r.domains || [];
        setDomains(list);
        setDomain(list[0]?.name || list[0]?.slug || '');
      })
      .catch(() => { if (!cancelled) setDomains([]); });
    const t = setTimeout(() => inputRef.current?.select(), 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, noteText]);

  if (!open) return null;

  const canCreate = title.trim().length > 0;
  const submit = () => { if (canCreate) onCreate?.({ title: title.trim(), domain }); };

  const field = {
    padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
    color: 'var(--text)', fontSize: 13, outline: 'none', background: 'var(--surface-2)',
  };

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh',
    }}>
      <div onClick={onClose} className="candy-backdrop" />
      <div role="dialog" aria-label="New Idea from note" className="candy-modal" style={{
        position: 'relative', width: 440,
        display: 'flex', flexDirection: 'column', gap: 14, overflow: 'hidden',
        animation: 'fadeIn 0.16s ease', padding: 18,
      }}>
        <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
          New Idea from note
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Title</span>
          <input
            ref={inputRef}
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              else if (e.key === 'Escape') onClose?.();
            }}
            placeholder="Idea title…"
            style={field}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Domain</span>
          <select value={domain} onChange={e => setDomain(e.target.value)} style={field}>
            {domains.length === 0 && <option value="">Uncategorized</option>}
            {domains.map(d => {
              const v = d.name || d.slug;
              return <option key={v} value={v}>{v}</option>;
            })}
          </select>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
          <OutlinedBtn onClick={onClose}>Cancel</OutlinedBtn>
          <PrimaryBtn onClick={submit} disabled={!canCreate}>Create Idea</PrimaryBtn>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.4 }}>
          Creates <code>Pulse/Ideas/{title.trim() || 'Title'}.md</code> with the note as its first bullet.
        </div>
      </div>
    </div>,
    document.body,
  );
}
