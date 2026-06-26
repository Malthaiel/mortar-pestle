import { useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { TextInput } from '@host/components/ui/Input.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';

const CATEGORIES = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'other', label: 'Other' },
];

export default function ComposeModal({ open, onClose, fb, accent, onCreated }) {
  const [category, setCategory] = useState('feature');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [attachLogs, setAttachLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => { setCategory('feature'); setTitle(''); setBody(''); setAttachLogs(false); setError(''); setBusy(false); };
  const close = () => { onClose?.(); reset(); };

  const submit = async () => {
    setError(''); setBusy(true);
    try {
      const post = await fb.postCreate(category, title.trim(), body.trim(), attachLogs, null);
      onCreated?.(post);
      close();
    } catch (e) { setError(e.message || 'Could not post'); setBusy(false); }
  };

  return (
    <AppWindow open={open} onClose={close} title="New post" accent={accent} width={560} height="auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={label}>Category</label>
          <CandySelect value={category} options={CATEGORIES} onChange={setCategory} title="Category" />
        </div>
        <div>
          <label style={label}>Title</label>
          <TextInput value={title} onChange={setTitle} placeholder="Short summary" accent={accent}
            autoFocus style={{ width: '100%' }} />
        </div>
        <div>
          <label style={label}>Details</label>
          <textarea className="candy-input" value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="What happened, or what you'd like to see…"
            style={{ width: '100%', minHeight: 120, resize: 'vertical', padding: '8px 10px',
              fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)' }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={attachLogs} onChange={(e) => setAttachLogs(e.target.checked)} />
          Attach app version, OS &amp; recent logs (visible to the dev only)
        </label>
        {error && <div style={{ color: 'var(--error)', fontSize: 12 }}>{error}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <OutlinedBtn onClick={close} disabled={busy}>Cancel</OutlinedBtn>
        <PrimaryBtn onClick={submit} disabled={busy || title.trim().length < 3}>{busy ? 'Posting…' : 'Post'}</PrimaryBtn>
      </div>
    </AppWindow>
  );
}

const label = { display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)', marginBottom: 6 };
