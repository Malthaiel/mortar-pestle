// Cardio preset builder/combiner (Health Column epic, sub-plan 5). Multi-field
// form → AppWindow (clone of SplitEditorWindow). A preset IS an ordered, editable
// sequence of segments {type, duration, zone?} — a single-segment preset is just
// length 1; combining is adding segments (the locked "12m HIIT → 15m Zone 2").
// Reorder via grip + index keys (editing an input never remounts the row).
import { useEffect, useState } from 'react';
import AppWindow from '../ui/AppWindow.jsx';
import DraggableSidebarList from '../DraggableSidebarList.jsx';
import { IconPlus, IconTrash, IconCheck, IconGrip } from '../icons.jsx';

function newId(prefix) {
  const rnd = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10));
  return `${prefix}-${rnd}`;
}
const moved = (rows, from, to) => {
  const next = rows.slice();
  const [m] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, m);
  return next;
};

const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, color: 'var(--text)', padding: '7px 9px', font: 'inherit', width: '100%' };
const gripStyle = { display: 'inline-flex', alignItems: 'center', color: 'var(--text-faint)', cursor: 'grab', flexShrink: 0 };

export default function CardioComboWindow({ open, onClose, accent = 'var(--accent)', initial = null, onSave }) {
  const [name, setName] = useState('');
  const [seq, setSeq] = useState([]); // [{type, duration, zone}]
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name || '');
    setSeq(initial?.sequence?.length
      ? initial.sequence.map((s) => ({ type: s.type || '', duration: s.duration ?? 10, zone: s.zone || '' }))
      : [{ type: '', duration: 20, zone: '' }]);
  }, [open, initial]);

  const addSeg = () => setSeq((s) => [...s, { type: '', duration: 10, zone: '' }]);
  const setSeg = (i, patch) => setSeq((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const removeSeg = (i) => setSeq((s) => s.filter((_, j) => j !== i));
  const reorderSeg = (from, to) => setSeq((s) => moved(s, from, to));

  const totalMin = seq.reduce((a, s) => a + (Number(s.duration) || 0), 0);
  const canSave = name.trim() && seq.some((s) => s.type.trim());
  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave({
        id: initial?.id || newId('cardio'),
        file: initial?.file,
        name: name.trim(),
        sequence: seq
          .filter((s) => s.type.trim())
          .map((s) => {
            const seg = { type: s.type.trim(), duration: Number(s.duration) || 0 };
            const z = s.zone && String(s.zone).trim();
            if (z) seg.zone = String(s.zone).trim();
            return seg;
          }),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppWindow
      open={open}
      onClose={onClose}
      accent={accent}
      title={initial ? 'Edit Cardio Preset' : 'New Cardio Preset'}
      width="min(560px, 92vw)"
      height="min(600px, 86vh)"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="candy-btn" data-shape="chip" onClick={onClose}><span className="candy-face">Cancel</span></button>
          <button type="button" className="candy-btn" data-shape="chip" disabled={!canSave || saving} onClick={save} style={!canSave ? { opacity: 0.5 } : undefined}>
            <span className="candy-face"><IconCheck size={13} /> {saving ? 'Saving…' : 'Save preset'}</span>
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Name</span>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="HIIT → Zone 2" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Sequence ({seq.length} · {totalMin} min total)</span>
          <DraggableSidebarList
            items={seq}
            keyExtractor={(_s, i) => `seg-${i}`}
            onReorder={reorderSeg}
            renderItem={(s, idx) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, marginBottom: 6 }}>
                <span style={gripStyle}><IconGrip size={13} /></span>
                <input value={s.type} onChange={(e) => setSeg(idx, { type: e.target.value })} placeholder="Type (Bike, Zone 2…)" style={{ ...inputStyle, padding: '4px 7px', flex: 1, minWidth: 0 }} />
                <input type="number" min="0" value={s.duration} onChange={(e) => setSeg(idx, { duration: e.target.value })} title="Minutes" style={{ ...inputStyle, padding: '4px 5px', width: 48, textAlign: 'center' }} />
                <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>m</span>
                <input value={s.zone} onChange={(e) => setSeg(idx, { zone: e.target.value })} placeholder="zone" title="Zone (optional)" style={{ ...inputStyle, padding: '4px 5px', width: 58, textAlign: 'center' }} />
                <button type="button" className="candy-btn" data-shape="icon" title="Remove" onClick={() => removeSeg(idx)} style={{ flexShrink: 0 }}>
                  <span className="candy-face"><IconTrash size={12} /></span>
                </button>
              </div>
            )}
          />
          <button type="button" className="candy-btn" data-shape="chip" onClick={addSeg} style={{ alignSelf: 'flex-start' }}>
            <span className="candy-face"><IconPlus size={12} /> Add segment</span>
          </button>
        </div>
      </div>
    </AppWindow>
  );
}
