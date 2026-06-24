// Full entry editor (new or edit). Fetches the full entry on open (passwords
// never live in the store's summaries), edits all fields incl. folder, tags,
// notes, and custom fields, and writes via creds_upsert / creds_delete.

import { useEffect, useState } from 'react';
import * as creds from './credsStore.js';
import PasswordField from './PasswordField.jsx';

const overlay = {
  position: 'absolute', inset: 0, zIndex: 8, display: 'flex',
  alignItems: 'flex-start', justifyContent: 'center', padding: 24,
  background: 'rgba(0,0,0,0.4)', overflow: 'auto',
};
const card = {
  width: 'min(560px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
  display: 'flex', flexDirection: 'column', maxHeight: '100%', overflow: 'hidden',
};
const head = { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)' };
const body = { padding: 16, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 };
const foot = { display: 'flex', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--border)' };
const label = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 };
const input = {
  width: '100%', padding: '6px 10px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit',
};
const ghost = {
  padding: '7px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', font: 'inherit',
};
function primary(accent) {
  return { padding: '7px 14px', borderRadius: 'var(--radius-md)', border: `1px solid ${accent}`, background: accent, color: '#fff', cursor: 'pointer', font: 'inherit', fontWeight: 600 };
}

const EMPTY = { id: '', title: '', username: '', password: '', origin: '', folder: '', tags: [], notes: '', customFields: [] };

export default function VaultEntryEditor({ entryId, prefillOrigin, folders = [], accent, settings, onSaved, onDeleted, onClose }) {
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const isEdit = !!entryId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (entryId) {
        try {
          const full = await creds.getEntry(entryId);
          if (!cancelled) {
            setForm({
              id: full.id, title: full.title || '', username: full.username || '',
              password: full.password || '', origin: full.origin || '',
              folder: full.folder || '', tags: full.tags || [], notes: full.notes || '',
              customFields: full.customFields || [],
            });
          }
        } catch (e) {
          if (!cancelled) setErr(e?.message || 'Could not load entry.');
        }
      } else {
        setForm({ ...EMPTY, origin: prefillOrigin || '' });
      }
    })();
    return () => { cancelled = true; };
  }, [entryId, prefillOrigin]);

  if (!form) {
    return (
      <div style={overlay} onClick={onClose}>
        <div style={card} onClick={e => e.stopPropagation()}>
          <div style={body}>{err ? <span style={{ color: 'var(--danger,#e5484d)' }}>{err}</span> : 'Loading…'}</div>
        </div>
      </div>
    );
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setField = (i, k, v) => set('customFields', form.customFields.map((c, j) => j === i ? { ...c, [k]: v } : c));
  const addField = () => set('customFields', [...form.customFields, { name: '', value: '', hidden: false }]);
  const rmField = (i) => set('customFields', form.customFields.filter((_, j) => j !== i));

  const quickGen = async () => {
    try {
      const pw = await creds.generate({ length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true });
      set('password', pw);
    } catch (e) { setErr(e?.message || 'Generate failed.'); }
  };

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await creds.upsert({
        id: form.id || null,
        title: form.title,
        username: form.username,
        password: form.password,
        origin: form.origin || null,
        folder: form.folder || null,
        tags: form.tags,
        notes: form.notes,
        customFields: form.customFields.filter(c => c.name || c.value),
      });
      onSaved?.();
    } catch (e) {
      setErr(e?.message || 'Could not save.');
    } finally { setBusy(false); }
  };

  const del = async () => {
    if (!confirmDel) { setConfirmDel(true); return; }
    setBusy(true); setErr('');
    try { await creds.remove(form.id); onDeleted?.(); }
    catch (e) { setErr(e?.message || 'Could not delete.'); setBusy(false); }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={head}>
          <strong style={{ fontSize: 14, flex: 1 }}>{isEdit ? 'Edit login' : 'New login'}</strong>
          <button type="button" style={ghost} onClick={onClose}>✕</button>
        </div>
        <div style={body}>
          <div><label style={label}>Name</label>
            <input style={input} value={form.title} onChange={e => set('title', e.target.value)} autoFocus placeholder="e.g. GitHub" /></div>
          <div><label style={label}>Username / email</label>
            <input style={input} value={form.username} onChange={e => set('username', e.target.value)} autoComplete="off" /></div>
          <div><label style={label}>Password</label>
            <PasswordField value={form.password} onChange={v => set('password', v)} accent={accent}
              onGenerate={quickGen} revealRemaskSecs={settings?.revealRemaskSecs ?? 20} clearSecs={settings?.clipboardClearSecs ?? 30} /></div>
          <div><label style={label}>Site (URL)</label>
            <input style={input} value={form.origin} onChange={e => set('origin', e.target.value)} placeholder="https://example.com" /></div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}><label style={label}>Folder</label>
              <select style={input} value={form.folder} onChange={e => set('folder', e.target.value)}>
                <option value="">Unfiled</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select></div>
            <div style={{ flex: 1 }}><label style={label}>Tags (comma-separated)</label>
              <input style={input} value={form.tags.join(', ')}
                onChange={e => set('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))} /></div>
          </div>
          <div><label style={label}>Notes</label>
            <textarea style={{ ...input, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
          <div>
            <label style={label}>Custom fields</label>
            {form.customFields.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <input style={{ ...input, flex: 1 }} placeholder="name" value={c.name} onChange={e => setField(i, 'name', e.target.value)} />
                <input style={{ ...input, flex: 1 }} type={c.hidden ? 'password' : 'text'} placeholder="value" value={c.value} onChange={e => setField(i, 'value', e.target.value)} />
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 4, alignItems: 'center' }} title="Hide value">
                  <input type="checkbox" checked={c.hidden} onChange={e => setField(i, 'hidden', e.target.checked)} />🔒
                </label>
                <button type="button" style={ghost} onClick={() => rmField(i)}>✕</button>
              </div>
            ))}
            <button type="button" style={ghost} onClick={addField}>＋ Add field</button>
          </div>
          {err && <span style={{ fontSize: 12, color: 'var(--danger,#e5484d)' }}>{err}</span>}
        </div>
        <div style={foot}>
          <button type="button" style={primary(accent)} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" style={ghost} onClick={onClose}>Cancel</button>
          {isEdit && (
            <button type="button" style={{ ...ghost, marginLeft: 'auto', color: 'var(--danger,#e5484d)', borderColor: 'var(--danger,#e5484d)' }} disabled={busy} onClick={del}>
              {confirmDel ? 'Confirm delete' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
