// Split builder/editor (Health Column epic, sub-plan 4). Multi-field form →
// AppWindow (clone of MealBuilderWindow). Edits a workout split: name, the
// ordered cycle of day labels (reorder via grip; a day with no exercises IS a
// rest day), and the selected day's target exercises (name / sets / free-text
// reps / optional free-text weight). The anchor (which cycle day is "today") is
// set at ACTIVATION via the chooser — an existing split's active/anchor pass
// through unchanged here. Reorder keys are index-based so editing a label input
// never remounts the row (no focus loss); drag handles are non-interactive
// IconGrip spans (buttons/inputs block pickup per DraggableSidebarList).
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

export default function SplitEditorWindow({ open, onClose, accent = 'var(--accent)', initial = null, onSave }) {
  const [name, setName] = useState('');
  const [cycle, setCycle] = useState([]);          // [label]
  const [days, setDays] = useState({});            // { label: [{name,sets,reps,weight}] }
  const [selected, setSelected] = useState(null);  // label being edited
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const c = initial?.cycle?.length ? [...initial.cycle] : ['Day 1', 'Rest'];
    setName(initial?.name || '');
    setCycle(c);
    setDays(initial?.days ? JSON.parse(JSON.stringify(initial.days)) : { 'Day 1': [], Rest: [] });
    setSelected(c[0] || null);
  }, [open, initial]);

  // Cycle ops -----------------------------------------------------------------
  const addDay = () => {
    let n = cycle.length + 1;
    let label = `Day ${n}`;
    while (cycle.includes(label)) label = `Day ${++n}`;
    setCycle((c) => [...c, label]);
    setDays((d) => ({ ...d, [label]: [] }));
    setSelected(label);
  };
  const renameDay = (idx, next) => {
    const old = cycle[idx];
    setCycle((c) => c.map((l, i) => (i === idx ? next : l)));
    setDays((d) => {
      const nd = { ...d };
      nd[next] = nd[old] || [];
      if (next !== old) delete nd[old];
      return nd;
    });
    setSelected((s) => (s === old ? next : s));
  };
  const removeDay = (idx) => {
    const label = cycle[idx];
    const rest = cycle.filter((_, i) => i !== idx);
    setCycle(rest);
    setDays((d) => { const nd = { ...d }; delete nd[label]; return nd; });
    setSelected((s) => (s === label ? (rest[0] || null) : s));
  };
  const reorderCycle = (from, to) => setCycle((c) => moved(c, from, to));

  // Exercise ops (selected day) -----------------------------------------------
  const exRows = (selected && days[selected]) || [];
  const setExRows = (fn) => setDays((d) => ({ ...d, [selected]: fn(d[selected] || []) }));
  const addEx = () => setExRows((r) => [...r, { name: '', sets: 3, reps: '10', weight: null }]);
  const setEx = (idx, patch) => setExRows((r) => r.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  const removeEx = (idx) => setExRows((r) => r.filter((_, i) => i !== idx));
  const reorderEx = (from, to) => setExRows((r) => moved(r, from, to));

  const canSave = name.trim() && cycle.length > 0;
  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const cleanDays = {};
      for (const label of cycle) {
        cleanDays[label] = (days[label] || [])
          .filter((e) => e.name.trim())
          .map((e) => ({
            name: e.name.trim(),
            sets: Number(e.sets) || 0,
            reps: String(e.reps).trim() || '0',
            weight: e.weight && String(e.weight).trim() ? String(e.weight).trim() : null,
          }));
      }
      await onSave({
        id: initial?.id || newId('split'),
        file: initial?.file,
        name: name.trim(),
        cycle,
        days: cleanDays,
        active: initial?.active ?? false,
        anchorDate: initial?.anchorDate ?? null,
        anchorIndex: initial?.anchorIndex ?? 0,
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
      title={initial ? 'Edit Split' : 'New Split'}
      width="min(680px, 92vw)"
      height="min(680px, 88vh)"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="candy-btn" data-shape="chip" onClick={onClose}><span className="candy-face">Cancel</span></button>
          <button type="button" className="candy-btn" data-shape="chip" disabled={!canSave || saving} onClick={save} style={!canSave ? { opacity: 0.5 } : undefined}>
            <span className="candy-face"><IconCheck size={13} /> {saving ? 'Saving…' : 'Save split'}</span>
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Name */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Name</span>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Push / Pull / Legs" />
        </div>

        {/* Cycle */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Cycle ({cycle.length} days · empty = rest)</span>
          <DraggableSidebarList
            items={cycle}
            keyExtractor={(_l, i) => `cyc-${i}`}
            onReorder={reorderCycle}
            renderItem={(label, idx) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', background: selected === label ? `color-mix(in oklch, ${accent} 14%, transparent)` : 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, marginBottom: 6 }}>
                <span style={gripStyle}><IconGrip size={13} /></span>
                <input value={label} onChange={(e) => renameDay(idx, e.target.value)} style={{ ...inputStyle, padding: '4px 7px' }} />
                <button type="button" className={`candy-btn${selected === label ? ' is-active' : ''}`} data-shape="chip" title="Edit this day" onClick={() => setSelected(label)}>
                  <span className="candy-face">{(days[label] || []).length || 'rest'}</span>
                </button>
                <button type="button" className="candy-btn" data-shape="icon" title="Remove day" onClick={() => removeDay(idx)} style={{ flexShrink: 0 }}>
                  <span className="candy-face"><IconTrash size={12} /></span>
                </button>
              </div>
            )}
          />
          <button type="button" className="candy-btn" data-shape="chip" onClick={addDay} style={{ alignSelf: 'flex-start' }}>
            <span className="candy-face"><IconPlus size={12} /> Add day</span>
          </button>
        </div>

        {/* Selected day's exercises */}
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={labelStyle}>{selected} — exercises ({exRows.length})</span>
            {exRows.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>No exercises — this is a rest day.</span>}
            <DraggableSidebarList
              items={exRows}
              keyExtractor={(_e, i) => `${selected}-ex-${i}`}
              onReorder={reorderEx}
              renderItem={(e, idx) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, marginBottom: 6 }}>
                  <span style={gripStyle}><IconGrip size={13} /></span>
                  <input value={e.name} onChange={(ev) => setEx(idx, { name: ev.target.value })} placeholder="Exercise" style={{ ...inputStyle, padding: '4px 7px', flex: 1, minWidth: 0 }} />
                  <input type="number" min="0" value={e.sets} onChange={(ev) => setEx(idx, { sets: ev.target.value })} title="Sets" style={{ ...inputStyle, padding: '4px 4px', width: 42, textAlign: 'center' }} />
                  <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>×</span>
                  <input value={e.reps} onChange={(ev) => setEx(idx, { reps: ev.target.value })} title="Reps (free-text: 8, 8-12, AMRAP)" placeholder="reps" style={{ ...inputStyle, padding: '4px 5px', width: 56, textAlign: 'center' }} />
                  <input value={e.weight ?? ''} onChange={(ev) => setEx(idx, { weight: ev.target.value })} title="Weight (optional)" placeholder="wt" style={{ ...inputStyle, padding: '4px 5px', width: 58, textAlign: 'center' }} />
                  <button type="button" className="candy-btn" data-shape="icon" title="Remove" onClick={() => removeEx(idx)} style={{ flexShrink: 0 }}>
                    <span className="candy-face"><IconTrash size={12} /></span>
                  </button>
                </div>
              )}
            />
            <button type="button" className="candy-btn" data-shape="chip" onClick={addEx} style={{ alignSelf: 'flex-start' }}>
              <span className="candy-face"><IconPlus size={12} /> Add exercise</span>
            </button>
          </div>
        )}
      </div>
    </AppWindow>
  );
}
