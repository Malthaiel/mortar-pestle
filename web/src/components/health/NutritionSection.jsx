// Nutrition section of the Health Column (Health Column epic, sub-plan 3).
// Live day ledger: calorie ring + 3 macro bars + 8 key-micro chips (rest under
// "more"), today's logged meals with a bin-able delete, and the meal/goals/log
// surfaces. Day-log writes (log/delete) are isToday-gated — they share the
// daily-note mtime cache with the session writers, so off-today they'd write
// against the wrong base; viewing a past day is read-only. Library writes
// (meals/goals) are not day-bound.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { sumDay, deriveTargets, naturalSugar, weeklyMacroAvg, STANDARD_DV, DEFAULT_MICROS } from '../../util/nutritionTotals.js';
import { useHealthLibrary } from '../../hooks/useHealthLibrary.js';
import PaneHeader from '../planner/PaneHeader.jsx';
import { StatChip } from '../ui/Stat.jsx';
import { IconPlus, IconTrash } from '../icons.jsx';
import NutritionRing from './NutritionRing.jsx';
import MealBuilderWindow from './MealBuilderWindow.jsx';
import GoalsWindow from './GoalsWindow.jsx';
import LogMealPopover from './LogMealPopover.jsx';

const MACROS = [
  { key: 'protein', label: 'Protein' },
  { key: 'carb', label: 'Carbs' },
  { key: 'fat', label: 'Fat' },
];

const MICRO_LABELS = {
  vitamin_d: 'Vit D', vitamin_a: 'Vit A', vitamin_c: 'Vit C', vitamin_e: 'Vit E', vitamin_k: 'Vit K',
  vitamin_b6: 'Vit B6', vitamin_b12: 'Vit B12', added_sugars: 'Added sugar', natural_sugar: 'Natural sugar',
  saturated_fat: 'Sat fat', trans_fat: 'Trans fat',
};
const microLabel = (k) => MICRO_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Resolve a micro's consumed amount from the day totals (sugars live on the
// dedicated sugar field; natural_sugar is computed).
function microValue(consumed, key) {
  if (key === 'natural_sugar') return { amount: naturalSugar(consumed.sugar), unit: 'g' };
  if (key === 'added_sugars') return { amount: consumed.sugar.added, unit: 'g' };
  if (key === 'total_sugars') return { amount: consumed.sugar.total, unit: 'g' };
  const m = consumed.micros[key];
  return { amount: m?.amount ?? null, unit: m?.unit ?? (STANDARD_DV[key]?.unit || '') };
}
const microTarget = (targets, key) => (targets?.micros?.[key] != null ? targets.micros[key] : (STANDARD_DV[key]?.dv ?? null));

// Candy circle "+" — greyed and inert off-today (creation is today-only).
function AddCircle({ isToday, onClick, label, triggerRef }) {
  return (
    <button
      ref={triggerRef}
      type="button"
      data-own-press
      className="candy-btn health-log-trigger"
      data-shape="circle"
      disabled={!isToday}
      title={isToday ? label : 'Switch to today to log'}
      aria-label={label}
      style={isToday ? undefined : { opacity: 0.45 }}
      onClick={onClick}
    >
      <span className="candy-face"><IconPlus size={14} /></span>
    </button>
  );
}

// Target/consumed bar. Shows consumed-only (no "/ target") before goals exist.
function MacroBar({ label, consumed = 0, target = 0, accent }) {
  const frac = target > 0 ? Math.min(1, consumed / target) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>
        <span>{label}</span>
        <span>{target > 0 ? `${Math.round(consumed)} / ${Math.round(target)} g` : `${Math.round(consumed)} g`}</span>
      </div>
      <div style={{ position: 'relative', height: 4, borderRadius: 2, background: `color-mix(in oklch, ${accent} 14%, transparent)` }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, background: accent, borderRadius: 2, transition: 'width 200ms ease' }} />
      </div>
    </div>
  );
}

export default function NutritionSection({ accent = 'var(--accent)', isToday = false, pivotDs, refreshTick = 0, history = [] }) {
  const lib = useHealthLibrary();
  const [day, setDay] = useState({ meals: [], mtime: null, exists: false });
  const [builderOpen, setBuilderOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logPos, setLogPos] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const logBtnRef = useRef(null);

  const refreshDay = useCallback(async () => {
    if (!pivotDs) return;
    try { setDay(await api.health.readDay(pivotDs)); } catch { /* keep last */ }
  }, [pivotDs]);

  useEffect(() => { refreshDay(); }, [refreshDay, refreshTick]);

  // Anchor the log popover under the "+".
  useLayoutEffect(() => {
    if (!logOpen) { setLogPos(null); return; }
    const r = logBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 324;
    setLogPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8)) });
  }, [logOpen]);

  const consumed = sumDay(day.meals);
  const targets = deriveTargets(lib.goals);
  const weekAvg = weeklyMacroAvg(history);

  const onLog = useCallback(async (entry) => {
    await api.health.logMeal(pivotDs, entry);
    await refreshDay();
  }, [pivotDs, refreshDay]);

  const onDeleteMeal = useCallback(async (meal) => {
    await api.health.deleteMealLog(pivotDs, { time: meal.time, name: meal.name });
    await refreshDay();
  }, [pivotDs, refreshDay]);

  const moreMicros = Object.keys(STANDARD_DV).filter((k) => !DEFAULT_MICROS.includes(k));

  const renderMicro = (key) => {
    const { amount, unit } = microValue(consumed, key);
    const target = microTarget(targets, key);
    const reported = amount != null;
    const pct = reported && target ? Math.round((amount / target) * 100) : null;
    return (
      <StatChip
        key={key}
        label={microLabel(key)}
        value={reported ? `${amount}${unit}` : '—'}
        sub={pct != null ? `${pct}%` : (reported ? '' : 'n/r')}
        dot={reported ? accent : undefined}
      />
    );
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <PaneHeader>Nutrition</PaneHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="candy-btn" data-shape="chip" title="New meal" onClick={() => setBuilderOpen(true)}>
            <span className="candy-face">Meal</span>
          </button>
          <button type="button" className="candy-btn" data-shape="chip" title="Goals" onClick={() => setGoalsOpen(true)}>
            <span className="candy-face">Goals</span>
          </button>
          <AddCircle isToday={isToday} label="Log food" triggerRef={logBtnRef} onClick={() => setLogOpen((v) => !v)} />
        </div>
      </div>

      {/* Ledger hero */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <NutritionRing value={consumed.kcal} goal={targets?.kcal || 0} accent={accent} />
        {!lib.loading && !lib.goals && (
          <button type="button" className="candy-btn" data-shape="chip" onClick={() => setGoalsOpen(true)}>
            <span className="candy-face">Set goals to track targets</span>
          </button>
        )}
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {MACROS.map((m) => (
            <MacroBar key={m.key} label={m.label} accent={accent} consumed={consumed[m.key]} target={targets?.[m.key] || 0} />
          ))}
        </div>
      </div>

      {/* Micros */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {DEFAULT_MICROS.map(renderMicro)}
          {showMore && moreMicros.map(renderMicro)}
        </div>
        <button type="button" className="candy-btn" data-shape="chip" onClick={() => setShowMore((v) => !v)} style={{ alignSelf: 'center' }}>
          <span className="candy-face">{showMore ? 'Less' : 'More micros'}</span>
        </button>
      </div>

      {/* Today's logged meals */}
      {day.meals.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <PaneHeader>Logged</PaneHeader>
          {day.meals.map((meal, i) => (
            <div key={`${meal.time || ''}:${meal.name}:${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {meal.time && <span style={{ color: 'var(--text-faint)', width: 38 }}>{meal.time}</span>}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meal.name}</span>
              <span style={{ color: 'var(--text-faint)' }}>{Math.round(meal.kcal)}</span>
              <button type="button" className="candy-btn" data-shape="icon" title={isToday ? 'Delete' : 'Switch to today to edit'} disabled={!isToday} onClick={() => onDeleteMeal(meal)} style={isToday ? undefined : { opacity: 0.4 }}>
                <span className="candy-face"><IconTrash size={12} /></span>
              </button>
            </div>
          ))}
        </div>
      )}

      {builderOpen && (
        <MealBuilderWindow
          open={builderOpen}
          onClose={() => setBuilderOpen(false)}
          accent={accent}
          supplements={lib.supplements}
          onSave={lib.saveMeal}
        />
      )}
      {goalsOpen && (
        <GoalsWindow
          open={goalsOpen}
          onClose={() => setGoalsOpen(false)}
          accent={accent}
          initial={lib.goals}
          onSave={lib.saveGoals}
        />
      )}
      <LogMealPopover
        open={logOpen && !!logPos}
        onClose={() => setLogOpen(false)}
        style={{ position: 'fixed', zIndex: 1100, top: logPos?.top, left: logPos?.left }}
        accent={accent}
        meals={lib.meals}
        supplements={lib.supplements}
        onLog={onLog}
      />
    </section>
  );
}
