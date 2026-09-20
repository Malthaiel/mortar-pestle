// Nutrition section of the Health Column (Health Column epic, sub-plan 3).
// Live day ledger: calorie ring + 3 macro bars + 8 key-micro chips (rest under
// "more"), today's logged meals with a bin-able delete, and the meal/goals/log
// surfaces. Day-log writes (log/delete) are isToday-gated — they share the
// daily-note mtime cache with the session writers, so off-today they'd write
// against the wrong base; viewing a past day is read-only. Library writes
// (meals/goals) are not day-bound.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { sumDay, deriveTargets, naturalSugar, weeklyMacroAvg, STANDARD_DV, DEFAULT_MICROS } from '../../util/nutritionTotals.js';
import { useHealthLibrary } from '../../hooks/useHealthLibrary.js';
import PaneHeader from '../planner/PaneHeader.jsx';
import { Cluster, useRailOrder } from '../ui/Rail.jsx';
import { candyGap } from '../../util/candy.js';
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
  vitamin_b6: 'Vit B6', vitamin_b12: 'Vit B12', added_sugars: 'Added Sugar', natural_sugar: 'Natural Sugar',
  saturated_fat: 'Sat Fat', trans_fat: 'Trans Fat',
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
// Everything in STANDARD_DV that isn't one of the eight defaults — static, so
// it lives out here and the strip's item array keeps a stable identity.
const MORE_MICROS = Object.keys(STANDARD_DV).filter((k) => !DEFAULT_MICROS.includes(k));
const ALL_MICROS = [...DEFAULT_MICROS, ...MORE_MICROS];

// Every micro chip is the SAME width so the wrapped lines read as columns, and
// its text is centred inside that width. That width is a share of the line, not
// a typed constant: capped at half, floored at CHIP_MIN, so two chips fill the
// pane at any seam position instead of stranding space at its right edge — and
// a lone chip on a last odd line stays half-width instead of stretching.
const CHIP_MIN = 138;

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
  // Null until something in the window is logged — the readout strip then hides.
  const weekAvg = weeklyMacroAvg(history);

  const onLog = useCallback(async (entry) => {
    await api.health.logMeal(pivotDs, entry);
    await refreshDay();
  }, [pivotDs, refreshDay]);

  const onDeleteMeal = useCallback(async (meal) => {
    await api.health.deleteMealLog(pivotDs, { time: meal.time, name: meal.name });
    await refreshDay();
  }, [pivotDs, refreshDay]);

  // Persisted left-to-right order for the micro strip. applyOrder (inside
  // useRailOrder) keeps ids it has never seen in their natural place, so
  // toggling "More micros" simply appends the extra chips until they are dragged.
  const microKeys = useMemo(
    () => (showMore ? ALL_MICROS : DEFAULT_MICROS).map((id) => ({ id })),
    [showMore],
  );
  const { ordered: orderedMicros, onReorder: onReorderMicros } = useRailOrder(microKeys, 'health:micros');

  // One micro as a candy chip. Press and HOLD to lift it, then drag it anywhere
  // in the run — sideways within a line, up or down between lines. See Cluster
  // in ui/Rail.jsx; the order persists under `health:micros`.
  const renderMicro = ({ id: key }) => {
    const { amount, unit } = microValue(consumed, key);
    const target = microTarget(targets, key);
    const reported = amount != null;
    const pct = reported && target ? Math.round((amount / target) * 100) : null;
    return (
      <button type="button" className="candy-btn" data-shape="chip" title={microLabel(key)} style={{ width: '100%' }}>
        <span className="candy-face" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {reported && <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, flexShrink: 0 }} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{microLabel(key)}</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{reported ? `${amount}${unit}` : '—'}</span>
          <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.6 }}>{pct != null ? `${pct}%` : (reported ? '' : 'n/r')}</span>
        </span>
      </button>
    );
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <PaneHeader>Nutrition</PaneHeader>
        {/* No gap: this header sits in the Planner's one-gap scope, and a gap on
            the tag outranks it — 6px here left this the only 6px row in a window
            of 8px rows. */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
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
            <span className="candy-face">Set Goals to Track Targets</span>
          </button>
        )}
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {MACROS.map((m) => (
            <MacroBar key={m.key} label={m.label} accent={accent} consumed={consumed[m.key]} target={targets?.[m.key] || 0} />
          ))}
        </div>
        {weekAvg && (
          <div style={{
            width: '100%', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            gap: 8, fontSize: 11, color: 'var(--text-muted)',
          }}>
            <span>{weekAvg.daysLogged}d avg</span>
            <span style={{ display: 'flex', gap: 12 }}>
              <span>{weekAvg.kcal} kcal</span>
              {MACROS.map((m) => <span key={m.key}>{m.label} {weekAvg[m.key]}g</span>)}
            </span>
          </div>
        )}
      </div>

      {/* Micros. The chips above this gap are candy controls now, each drawing a
          5px shadow slab below its box, so a declared 16 painted 9 (measured
          2026-09-02). candyGap adds the depth back, which is the same rule the
          run's own rowGap follows — one helper, both gaps, nothing restated. */}
      <div style={{ display: 'flex', flexDirection: 'column', rowGap: candyGap(16, true) }}>
        <Cluster
          items={orderedMicros}
          onReorder={onReorderMicros}
          renderItem={renderMicro}
          // maxWidth is FLOORED to a whole pixel. A 339px pane halves to 166.5,
          // which puts the right column on x.5 — exactly between two screen
          // pixels. A chip mid-slide sits on its own fast-paint layer, and a
          // layer rounds x.5 DOWN while ordinary layout painting rounds it UP,
          // so a reordered neighbour landed 1px left and only closed the gap
          // ~90ms later when the layer retired (measured 2026-09-02: left edge
          // 218.5 for six captured frames, then 219.5). Rows never showed it
          // because their pitch is a whole 35. space-between hands the pixel the
          // floor gives up back to the gap, so the run still ends flush right.
          getItemStyle={() => ({ flex: `1 1 ${CHIP_MIN}px`, maxWidth: 'round(down, calc(50% - 3px), 1px)' })}
          // Chips stack downward here, so the ROW gap has to clear each chip's
          // depth lip (util/candy.js); side by side the lip points away and 6 is
          // already the painted gap.
          style={{ columnGap: 6, rowGap: candyGap(6, true), justifyContent: 'space-between' }}
        />
        <button type="button" className="candy-btn" data-shape="chip" onClick={() => setShowMore((v) => !v)} style={{ alignSelf: 'center' }}>
          <span className="candy-face">{showMore ? 'Less' : 'More Micros'}</span>
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
