// Goals editor (Health Column epic, sub-plan 3 Nutrition). Calories + a macro-%
// split (grams auto-derive, shown live) + optional custom key-micro targets;
// the rest of the micros compare vs the bundled FDA Daily Values. A multi-field
// form → AppWindow, not a Popover (DESIGN.md §214). Saves Health/Goals.md.
import { useEffect, useState } from 'react';
import { deriveTargets, STANDARD_DV } from '../../util/nutritionTotals.js';
import AppWindow from '../ui/AppWindow.jsx';
import { IconPlus, IconTrash, IconCheck } from '../icons.jsx';

const MICRO_KEYS = Object.keys(STANDARD_DV);

export default function GoalsWindow({ open, onClose, accent = 'var(--accent)', initial = null, onSave }) {
  const [calories, setCalories] = useState(2000);
  const [proteinPct, setProteinPct] = useState(30);
  const [carbPct, setCarbPct] = useState(40);
  const [fatPct, setFatPct] = useState(30);
  const [microTargets, setMicroTargets] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCalories(initial?.calories ?? 2000);
    setProteinPct(initial?.protein_pct ?? 30);
    setCarbPct(initial?.carb_pct ?? 40);
    setFatPct(initial?.fat_pct ?? 30);
    setMicroTargets(initial?.micro_targets || []);
    setSaving(false);
  }, [open, initial]);

  const pctSum = Number(proteinPct || 0) + Number(carbPct || 0) + Number(fatPct || 0);
  const derived = deriveTargets({ calories: Number(calories) || 0, protein_pct: proteinPct, carb_pct: carbPct, fat_pct: fatPct }) || { protein: 0, carb: 0, fat: 0 };

  const addMicro = () => {
    const used = new Set(microTargets.map((m) => m.key));
    const next = MICRO_KEYS.find((k) => !used.has(k)) || MICRO_KEYS[0];
    setMicroTargets((rows) => [...rows, { key: next, target: STANDARD_DV[next].dv, unit: STANDARD_DV[next].unit }]);
  };
  const setMicro = (idx, patch) => setMicroTargets((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeMicro = (idx) => setMicroTargets((rows) => rows.filter((_, i) => i !== idx));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({
        calories: Number(calories) || 0,
        protein_pct: Number(proteinPct) || 0,
        carb_pct: Number(carbPct) || 0,
        fat_pct: Number(fatPct) || 0,
        micro_targets: microTargets
          .filter((m) => m.key && m.target !== '' && m.target != null)
          .map((m) => ({ key: m.key, target: Number(m.target) || 0, unit: STANDARD_DV[m.key]?.unit || m.unit || '' })),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' };
  const inputStyle = { background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, color: 'var(--text)', padding: '8px 10px', font: 'inherit' };
  const PctField = ({ label, value, set, grams }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
      <span style={labelStyle}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input type="number" min="0" max="100" value={value} onChange={(e) => set(e.target.value)} style={{ ...inputStyle, width: 56, textAlign: 'right' }} />
        <span style={labelStyle}>%</span>
      </div>
      <span style={{ ...labelStyle, color: 'var(--text-muted)' }}>{grams} g</span>
    </div>
  );

  return (
    <AppWindow
      open={open}
      onClose={onClose}
      accent={accent}
      title="Nutrition Goals"
      width="min(560px, 92vw)"
      height="min(600px, 86vh)"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="candy-btn" data-shape="chip" onClick={onClose}><span className="candy-face">Cancel</span></button>
          <button type="button" className="candy-btn" data-shape="chip" disabled={saving} onClick={save}>
            <span className="candy-face"><IconCheck size={13} /> {saving ? 'Saving…' : 'Save goals'}</span>
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Daily calories</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" min="0" value={calories} onChange={(e) => setCalories(e.target.value)} style={{ ...inputStyle, width: 120, textAlign: 'right' }} />
            <span style={labelStyle}>kcal</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={labelStyle}>Macro split</span>
            <span style={{ ...labelStyle, color: pctSum === 100 ? 'var(--text-faint)' : 'var(--error)' }}>{pctSum}% {pctSum !== 100 ? '(should total 100)' : ''}</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <PctField label="Protein" value={proteinPct} set={setProteinPct} grams={derived.protein} />
            <PctField label="Carbs" value={carbPct} set={setCarbPct} grams={derived.carb} />
            <PctField label="Fat" value={fatPct} set={setFatPct} grams={derived.fat} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={labelStyle}>Custom micro targets</span>
            <button type="button" className="candy-btn" data-shape="icon" title="Add target" onClick={addMicro}>
              <span className="candy-face"><IconPlus size={13} /></span>
            </button>
          </div>
          <span style={{ ...labelStyle, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>
            Anything not listed compares against the standard FDA Daily Value.
          </span>
          {microTargets.map((m, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select value={m.key} onChange={(e) => setMicro(idx, { key: e.target.value, unit: STANDARD_DV[e.target.value]?.unit })} style={{ ...inputStyle, flex: 1 }}>
                {MICRO_KEYS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
              </select>
              <input type="number" min="0" value={m.target} onChange={(e) => setMicro(idx, { target: e.target.value })} style={{ ...inputStyle, width: 80, textAlign: 'right' }} />
              <span style={{ ...labelStyle, width: 28 }}>{STANDARD_DV[m.key]?.unit}</span>
              <button type="button" className="candy-btn" data-shape="icon" title="Remove" onClick={() => removeMicro(idx)}>
                <span className="candy-face"><IconTrash size={13} /></span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </AppWindow>
  );
}
