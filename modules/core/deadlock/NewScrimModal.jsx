// New Scrim modal — the relocated home of the old ScrimListLanding Team 1 / Team 2
// form, now triggered from a right-click "New Scrim" on the Scrim folder in
// DeadlockTree. Dumb collector: hands { team1, team2 } to onSubmit; the parent owns
// the create/uniq/navigate/refresh (it has the existing-scrim list + the tree hook).
// Mirrors NameInputModal's shell (backdrop click / Esc = cancel).

import { useEffect, useRef, useState } from 'react';
import { OutlinedBtn } from '@host/components/ui/Button.jsx';
import { candyGap } from '@host/util/candy.js';

export default function NewScrimModal({ open, error, onSubmit, onCancel }) {
  const [t1, setT1] = useState('');
  const [t2, setT2] = useState('');
  const ref1 = useRef(null);

  useEffect(() => { if (open) { setT1(''); setT2(''); } }, [open]);
  useEffect(() => { if (open) { const el = ref1.current; if (el) el.focus(); } }, [open]);

  if (!open) return null;

  const submit = () => { onSubmit?.({ team1: t1.trim(), team2: t2.trim() }); };

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)', backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="candy-section"
        style={{ width: 420, maxWidth: '90vw', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>New Scrim</div>
        {error && <div style={{ fontSize: 12.5, color: 'var(--error)' }}>{error}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="candy-btn" data-shape="field">
            <input className="candy-face" ref={ref1} placeholder="Team 1 (Coached)" value={t1}
              onChange={(e) => setT1(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); } else if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); } }}/>
          </div>
          <div className="candy-btn" data-shape="field">
            <input className="candy-face" placeholder="Team 2" value={t2}
              onChange={(e) => setT2(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); } else if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); } }}/>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: candyGap(4, true) }}>
          <OutlinedBtn small onClick={onCancel}>Cancel</OutlinedBtn>
          <OutlinedBtn small onClick={submit}>Create scrim</OutlinedBtn>
        </div>
      </div>
    </div>
  );
}