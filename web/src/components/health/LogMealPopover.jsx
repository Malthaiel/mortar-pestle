// Log popover (Health Column epic, sub-plan 3 Nutrition). A compact chooser
// (Popover, per DESIGN.md §214 — the rich form lives in MealBuilderWindow):
//   • Saved   — pick a Library meal + servings → log meal.totals × servings,
//               freezing its attached supplements as nested sub-bullets.
//   • Quick   — USDA search → grams → log a one-ingredient snapshot bullet with
//               NO Library page (provenance-agnostic; identical bullet shape).
//   • Supp    — log a single supplement standalone (0-kcal bullet, own micros).
// Every entry stores FROZEN computed numbers + NO id/reference (snapshot by
// construction). Time defaults to now.
import { useState } from 'react';
import { api } from '../../api.js';
import { sumMealTotals } from '../../util/nutritionTotals.js';
import { useFoodSearch } from '../../hooks/useFoodSearch.js';
import Popover from '../ui/Popover.jsx';
import { IconSearch } from '../icons.jsx';

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function entryFromMeal(meal, servings, suppLib) {
  const s = Number(servings) || 1;
  const scale = (v) => (v == null ? null : r1(v * s));
  return {
    time: nowHHMM(),
    name: meal.name,
    kcal: scale(meal.totals?.kcal ?? 0),
    protein: scale(meal.totals?.protein ?? 0),
    carb: scale(meal.totals?.carb ?? 0),
    fat: scale(meal.totals?.fat ?? 0),
    sugar: { total: scale(meal.sugar?.total), added: scale(meal.sugar?.added) },
    micros: (meal.micros || []).map((m) => ({ ...m, amount: r1(m.amount * s) })),
    // Attached supplements freeze at log time (not scaled by servings).
    supplements: (meal.supplementIds || [])
      .map((id) => suppLib.find((x) => x.id === id))
      .filter(Boolean)
      .map((su) => ({ name: su.name, dose: su.dose, micros: su.micros })),
  };
}

export default function LogMealPopover({ open, onClose, style, accent = 'var(--accent)', meals = [], supplements = [], onLog }) {
  const [mode, setMode] = useState('saved');
  const [selectedMealId, setSelectedMealId] = useState(null);
  const [servings, setServings] = useState(1);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null); // { detail, grams }
  const [busy, setBusy] = useState(false);
  const { results, loading } = useFoodSearch(query);

  const reset = () => { setSelectedMealId(null); setServings(1); setQuery(''); setPicked(null); };
  const close = () => { reset(); onClose(); };

  const doLog = async (entry) => {
    if (busy) return;
    setBusy(true);
    try { await onLog(entry); close(); }
    finally { setBusy(false); }
  };

  const logSavedMeal = () => {
    const meal = meals.find((m) => m.id === selectedMealId);
    if (meal) doLog(entryFromMeal(meal, servings, supplements));
  };
  const pickFood = async (hit) => {
    setQuery(hit.description);
    try { const detail = await api.usda.food(hit.fdc_id); setPicked({ detail, grams: 100 }); } catch { /* not added */ }
  };
  const logQuick = () => {
    if (!picked) return;
    const t = sumMealTotals([{ fdc_id: picked.detail.fdc_id, grams: Number(picked.grams) || 0 }], { [picked.detail.fdc_id]: picked.detail });
    doLog({ time: nowHHMM(), name: picked.detail.description, kcal: t.kcal, protein: t.protein, carb: t.carb, fat: t.fat, sugar: t.sugar, micros: t.micros, supplements: [] });
  };
  const logSupp = (su) => doLog({ time: nowHHMM(), name: su.name, kcal: 0, protein: 0, carb: 0, fat: 0, sugar: { total: null, added: null }, micros: su.micros || [], supplements: [] });

  const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' };
  const inputStyle = { background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, color: 'var(--text)', padding: '7px 9px', font: 'inherit', width: '100%' };
  const rowBtn = (sel) => ({ display: 'block', width: '100%', textAlign: 'left', background: sel ? `color-mix(in oklch, ${accent} 16%, transparent)` : 'none', border: 'none', borderBottom: '1px solid var(--border-soft)', color: 'var(--text)', padding: '8px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12.5 });

  const TabBtn = ({ id, children }) => (
    <button type="button" className={`candy-btn${mode === id ? ' is-active' : ''}`} data-shape="chip" onClick={() => { setMode(id); reset(); }}>
      <span className="candy-face">{children}</span>
    </button>
  );

  return (
    <Popover open={open} onClose={close} accent={accent} ariaLabel="Log food" style={style} bodyStyle={{ padding: 12 }} outsideExempt=".health-log-trigger">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 300 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <TabBtn id="saved">Saved</TabBtn>
          <TabBtn id="quick">Quick add</TabBtn>
          <TabBtn id="supp">Supplement</TabBtn>
        </div>

        {mode === 'saved' && (
          <>
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
              {meals.length === 0 && <div style={{ padding: 10, ...labelStyle }}>No saved meals yet — build one with “New meal”.</div>}
              {meals.map((m) => (
                <button key={m.id} type="button" style={rowBtn(selectedMealId === m.id)} onClick={() => setSelectedMealId(m.id)}>
                  {m.name} <span style={{ ...labelStyle, marginLeft: 4 }}>{Math.round(m.totals?.kcal ?? 0)} kcal</span>
                </button>
              ))}
            </div>
            {selectedMealId && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={labelStyle}>Servings</span>
                <input type="number" min="0.25" step="0.25" value={servings} onChange={(e) => setServings(e.target.value)} style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
                <button type="button" className="candy-btn" data-shape="chip" disabled={busy} onClick={logSavedMeal} style={{ marginLeft: 'auto' }}>
                  <span className="candy-face">Log</span>
                </button>
              </div>
            )}
          </>
        )}

        {mode === 'quick' && (
          <>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }}><IconSearch size={13} /></span>
              <input style={{ ...inputStyle, paddingLeft: 28 }} value={query} onChange={(e) => { setQuery(e.target.value); setPicked(null); }} placeholder="Search foods…" />
            </div>
            {!picked && query.trim() && (
              <div style={{ maxHeight: 170, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
                {loading && <div style={{ padding: 10, ...labelStyle }}>Searching…</div>}
                {!loading && results.length === 0 && <div style={{ padding: 10, ...labelStyle }}>No matches</div>}
                {results.map((hit) => (
                  <button key={hit.fdc_id} type="button" style={rowBtn(false)} onClick={() => pickFood(hit)}>{hit.description}</button>
                ))}
              </div>
            )}
            {picked && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" min="0" value={picked.grams} onChange={(e) => setPicked((p) => ({ ...p, grams: e.target.value }))} style={{ ...inputStyle, width: 80, textAlign: 'right' }} />
                <span style={labelStyle}>g</span>
                <button type="button" className="candy-btn" data-shape="chip" disabled={busy} onClick={logQuick} style={{ marginLeft: 'auto' }}>
                  <span className="candy-face">Log</span>
                </button>
              </div>
            )}
          </>
        )}

        {mode === 'supp' && (
          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
            {supplements.length === 0 && <div style={{ padding: 10, ...labelStyle }}>No saved supplements yet.</div>}
            {supplements.map((su) => (
              <button key={su.id} type="button" style={rowBtn(false)} disabled={busy} onClick={() => logSupp(su)}>
                {su.name}{su.dose ? <span style={{ ...labelStyle, marginLeft: 4 }}>{su.dose}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}
