// Meal builder (Health Column epic, sub-plan 3 Nutrition). A multi-field form →
// AppWindow, not a Popover (DESIGN.md §214). Search the offline USDA DB, add
// ingredient rows (grams), see LIVE computed totals, optionally attach saved
// supplements, and save a Library meal page with FROZEN totals + the ingredient
// fdc_id/grams (the editable definition — a day-log bullet never references it).
//
// Reorder is pointer-only via DraggableSidebarList (no HTML5 DnD): the row's
// description text is the non-interactive drag area; the grams input + remove
// button block pickup by default.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { sumMealTotals } from '../../util/nutritionTotals.js';
import { useFoodSearch } from '../../hooks/useFoodSearch.js';
import AppWindow from '../ui/AppWindow.jsx';
import DraggableSidebarList from '../DraggableSidebarList.jsx';
import { IconSearch, IconTrash, IconCheck } from '../icons.jsx';

function newId(prefix) {
  const rnd = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10));
  return `${prefix}-${rnd}`;
}

const fmt = (n) => (n == null ? '—' : Math.round(n * 10) / 10);

export default function MealBuilderWindow({ open, onClose, accent = 'var(--accent)', supplements = [], initial = null, onSave }) {
  const [name, setName] = useState('');
  const [ingredients, setIngredients] = useState([]); // [{ fdc_id, grams, description }]
  const [foodMap, setFoodMap] = useState({});         // { fdc_id: FoodDetail }
  const [supplementIds, setSupplementIds] = useState([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const { results, loading } = useFoodSearch(query);
  const reqRef = useRef(0);

  // Prefill on open (new vs edit).
  useEffect(() => {
    if (!open) return;
    setName(initial?.name || '');
    setSupplementIds(initial?.supplementIds || []);
    setQuery('');
    const ings = (initial?.ingredients || []).map((i) => ({ ...i, description: i.description || `#${i.fdc_id}` }));
    setIngredients(ings);
    // Fetch details for any prefilled ingredients so totals compute.
    const myReq = ++reqRef.current;
    Promise.all(ings.map((i) => api.usda.food(i.fdc_id).then((d) => [i.fdc_id, d]).catch(() => null)))
      .then((pairs) => {
        if (myReq !== reqRef.current) return;
        const map = {};
        for (const p of pairs) if (p) map[p[0]] = p[1];
        setFoodMap(map);
      });
  }, [open, initial]);

  const addIngredient = useCallback(async (hit) => {
    setQuery('');
    try {
      const detail = await api.usda.food(hit.fdc_id);
      setFoodMap((m) => ({ ...m, [hit.fdc_id]: detail }));
      setIngredients((rows) => [...rows, { fdc_id: hit.fdc_id, grams: 100, description: hit.description }]);
    } catch { /* surfaced by absence; the row simply isn't added */ }
  }, []);

  const setGrams = useCallback((idx, grams) => {
    setIngredients((rows) => rows.map((r, i) => (i === idx ? { ...r, grams } : r)));
  }, []);
  const removeIngredient = useCallback((idx) => {
    setIngredients((rows) => rows.filter((_, i) => i !== idx));
  }, []);
  const reorder = useCallback((from, to) => {
    setIngredients((rows) => {
      const next = rows.slice();
      const [m] = next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, m);
      return next;
    });
  }, []);
  const toggleSupp = useCallback((id) => {
    setSupplementIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }, []);

  const totals = sumMealTotals(ingredients, foodMap);

  const canSave = name.trim() && ingredients.length > 0;
  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave({
        id: initial?.id || newId('meal'),
        file: initial?.file,
        name: name.trim(),
        ingredients: ingredients.map(({ fdc_id, grams }) => ({ fdc_id, grams: Number(grams) || 0 })),
        totals: { kcal: totals.kcal, protein: totals.protein, carb: totals.carb, fat: totals.fat },
        micros: totals.micros,
        sugar: totals.sugar,
        supplementIds,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' };
  const inputStyle = { background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, color: 'var(--text)', padding: '8px 10px', font: 'inherit', width: '100%' };

  return (
    <AppWindow
      open={open}
      onClose={onClose}
      accent={accent}
      title={initial ? 'Edit Meal' : 'New Meal'}
      width="min(680px, 92vw)"
      height="min(640px, 86vh)"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="candy-btn" data-shape="chip" onClick={onClose}>
            <span className="candy-face">Cancel</span>
          </button>
          <button type="button" className="candy-btn" data-shape="chip" disabled={!canSave || saving} onClick={save} style={!canSave ? { opacity: 0.5 } : undefined}>
            <span className="candy-face"><IconCheck size={13} /> {saving ? 'Saving…' : 'Save meal'}</span>
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>Name</span>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Chicken &amp; Rice Bowl" />
        </div>

        {/* Ingredient search */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
          <span style={labelStyle}>Add ingredient (USDA)</span>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }}><IconSearch size={14} /></span>
            <input style={{ ...inputStyle, paddingLeft: 30 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search foods…" />
          </div>
          {query.trim() && (
            <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8, background: 'var(--bg-elev)' }}>
              {loading && <div style={{ padding: 10, ...labelStyle }}>Searching…</div>}
              {!loading && results.length === 0 && <div style={{ padding: 10, ...labelStyle }}>No matches</div>}
              {results.map((hit) => (
                <button key={hit.fdc_id} type="button" onClick={() => addIngredient(hit)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--border-soft)', color: 'var(--text)', padding: '8px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12.5 }}>
                  {hit.description}
                  {hit.data_type === 'branded_food' && <span style={{ ...labelStyle, marginLeft: 6 }}>branded</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Ingredient rows */}
        {ingredients.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={labelStyle}>Ingredients ({ingredients.length})</span>
            <DraggableSidebarList
              items={ingredients}
              keyExtractor={(it, i) => `${it.fdc_id}:${i}`}
              onReorder={reorder}
              renderItem={(it, idx) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, marginBottom: 6 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, cursor: 'grab' }}>{it.description}</span>
                  <input type="number" min="0" value={it.grams} onChange={(e) => setGrams(idx, e.target.value)}
                    style={{ ...inputStyle, width: 64, padding: '4px 6px', textAlign: 'right' }} />
                  <span style={labelStyle}>g</span>
                  <button type="button" className="candy-btn" data-shape="icon" title="Remove" onClick={() => removeIngredient(idx)} style={{ flexShrink: 0 }}>
                    <span className="candy-face"><IconTrash size={13} /></span>
                  </button>
                </div>
              )}
            />
          </div>
        )}

        {/* Live totals */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <span><strong style={{ color: accent }}>{fmt(totals.kcal)}</strong> kcal</span>
          <span>{fmt(totals.protein)}p</span>
          <span>{fmt(totals.carb)}c</span>
          <span>{fmt(totals.fat)}f</span>
          <span style={{ color: 'var(--text-faint)' }}>sugar {totals.sugar.total == null ? 'n/r' : `${fmt(totals.sugar.total)}g`} / {totals.sugar.added == null ? 'n/r' : `${fmt(totals.sugar.added)}g`}</span>
        </div>

        {/* Attach supplements */}
        {supplements.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={labelStyle}>Attach supplements</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {supplements.map((s) => {
                const on = supplementIds.includes(s.id);
                return (
                  <button key={s.id} type="button" className={`candy-btn${on ? ' is-active' : ''}`} data-shape="chip" onClick={() => toggleSupp(s.id)}>
                    <span className="candy-face">{on && <IconCheck size={12} />} {s.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </AppWindow>
  );
}
