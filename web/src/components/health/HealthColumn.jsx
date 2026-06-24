// Health Column — the Planner's always-on third column (Health Column epic,
// sub-plan 1 Foundation). Two stacked sections: Nutrition (top) and a Fitness
// stub (bottom; splits + cardio are sub-plans 4–5). Mounts after DayPane in
// PlannerModal as a sibling flex child behind its own resize seam.
//
// Mirrors DayPane's refresh skeleton: a 60s real-today tick driving the
// isToday gating (off-today adders grey out in place), and a 150ms-debounced
// vault-watcher tick ('today' / 'day' / 'manifest') that the Phase C data
// hooks will consume. The tick is wired now and harmless until then.
import { useEffect, useState } from 'react';
import { subscribeEvents } from '../../api.js';
import { todayLocalStr } from '../../util/time.js';
import { useHealthHistory } from '../../hooks/useHealthHistory.js';
import NutritionSection from './NutritionSection.jsx';
import FitnessSection from './FitnessSection.jsx';

export default function HealthColumn({ accent = 'var(--accent)', pivotDs }) {
  // Real-today tick (60s) — isToday greys the off-today adders in place.
  const [todayDs, setTodayDs] = useState(todayLocalStr);
  useEffect(() => {
    const id = setInterval(() => {
      const t = todayLocalStr();
      setTodayDs(prev => (prev === t ? prev : t));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const isToday = pivotDs === todayDs;

  // Consolidated refresh — one trailing-debounced tick from the vault watcher.
  // NutritionSection re-reads the day when `tick` bumps (external/own writes).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let t = null;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { setTick(v => v + 1); t = null; }, 150);
    };
    const unsub = subscribeEvents((name) => {
      if (name === 'today' || name === 'day' || name === 'manifest') bump();
    });
    return () => { if (t) clearTimeout(t); unsub(); };
  }, []);

  // 90-day history scan (bounded + cached) → weekly macro avg + workout streak.
  // Re-scans only when todayDs or the debounced watcher tick changes.
  const history = useHealthHistory(todayDs, tick);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <NutritionSection accent={accent} isToday={isToday} pivotDs={pivotDs} refreshTick={tick} history={history.days} />
        <div style={{ height: 1, background: 'var(--border-soft)', flexShrink: 0 }}/>
        <FitnessSection accent={accent} isToday={isToday} pivotDs={pivotDs} refreshTick={tick} history={history.days} />
      </div>
    </div>
  );
}
