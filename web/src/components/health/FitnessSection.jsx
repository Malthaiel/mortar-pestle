// Fitness section of the Health Column (Health Column epic, sub-plans 4–6).
// Workout half (4): active split → today's day → "Start" snapshots the targets
// into `## Workout`, then each exercise is a checkbox + free-text actuals. Cardio
// half (5): apply a preset (N frozen `## Cardio` bullets) or quick-add one, each
// a checkbox + actual-duration. Streak chip (6) sits in the header behind the
// opt-in "Show streak counter" setting. Owns the single useWorkoutSplits /
// useCardioPresets instances (so the seed hooks mount once) and the split/preset
// editors. Day writes are isToday-gated like NutritionSection (shared daily-note
// mtime cache).
//
// A logged ## Workout snapshot renders FIRST, regardless of live-split state — a
// past workout you logged stays visible even if you later delete/deactivate the
// split or that cycle-day becomes rest (the on-disk bullets are the source of
// truth; the cardio half already renders unconditionally).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useSettings } from '../../hooks/useSettings.js';
import { useWorkoutSplits } from '../../hooks/useWorkoutSplits.js';
import { useTodayWorkout, isRestDay } from '../../hooks/useTodayWorkout.js';
import { useCardioPresets } from '../../hooks/useCardioPresets.js';
import { computeFitnessStreak } from '../../util/fitnessStreak.js';
import PaneHeader from '../planner/PaneHeader.jsx';
import { IconCheck, IconTrash, IconDumbbell, IconPlus, IconHeartPulse, IconSparkles } from '../icons.jsx';
import SplitChooserPopover from './SplitChooserPopover.jsx';
import SplitEditorWindow from './SplitEditorWindow.jsx';
import CardioChooserPopover from './CardioChooserPopover.jsx';
import CardioComboWindow from './CardioComboWindow.jsx';

const mono12 = { fontFamily: 'var(--font-mono)', fontSize: 12 };
const subHeader = { fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' };
const actualInput = { width: 60, flexShrink: 0, background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 6, color: 'var(--text)', padding: '3px 6px', font: 'inherit', fontSize: 10.5 };

// One logged exercise: done toggle + name + frozen target + free-text actuals
// (committed on blur so each keystroke isn't a day-log write).
function ExerciseRow({ ex, index, isToday, onPatch, accent }) {
  const [actual, setActual] = useState(ex.actual ?? '');
  useEffect(() => { setActual(ex.actual ?? ''); }, [ex.actual]);
  const commit = () => { const v = actual.trim(); if (v !== (ex.actual ?? '')) onPatch(index, ex, { actual: v || null }); };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono12 }}>
      <button type="button" className="candy-btn" data-shape="icon" disabled={!isToday} title={ex.done ? 'Done' : 'Mark done'} onClick={() => onPatch(index, ex, { done: !ex.done })} style={{ flexShrink: 0, opacity: isToday ? 1 : 0.5 }}>
        <span className="candy-face" style={{ color: ex.done ? accent : 'var(--text-faint)' }}>{ex.done ? <IconCheck size={12} /> : '○'}</span>
      </button>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: ex.done ? 'line-through' : 'none', opacity: ex.done ? 0.55 : 1 }}>{ex.name}</span>
      <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{ex.sets}×{ex.reps}{ex.weight ? ` @${ex.weight}` : ''}</span>
      <input value={actual} onChange={(e) => setActual(e.target.value)} onBlur={commit} disabled={!isToday} placeholder="actual" title="Actual sets/reps/weight" style={actualInput} />
    </div>
  );
}

// One logged cardio segment: done toggle + type + frozen target + actual duration.
// Addressed by its render-list `index` so two identical segments stay distinct.
function CardioRow({ seg, index, isToday, onPatch, onDelete, accent }) {
  const [actual, setActual] = useState(seg.actual ?? '');
  useEffect(() => { setActual(seg.actual ?? ''); }, [seg.actual]);
  const commit = () => { const v = actual.trim(); if (v !== (seg.actual ?? '')) onPatch(index, seg, { actual: v || null }); };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono12 }}>
      <button type="button" className="candy-btn" data-shape="icon" disabled={!isToday} title={seg.done ? 'Done' : 'Mark done'} onClick={() => onPatch(index, seg, { done: !seg.done })} style={{ flexShrink: 0, opacity: isToday ? 1 : 0.5 }}>
        <span className="candy-face" style={{ color: seg.done ? accent : 'var(--text-faint)' }}>{seg.done ? <IconCheck size={12} /> : '○'}</span>
      </button>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: seg.done ? 'line-through' : 'none', opacity: seg.done ? 0.55 : 1 }}>{seg.type}</span>
      <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{seg.minutes}m{seg.zone ? ` (${seg.zone})` : ''}</span>
      <input value={actual} onChange={(e) => setActual(e.target.value)} onBlur={commit} disabled={!isToday} placeholder="actual" title="Actual duration" style={actualInput} />
      <button type="button" className="candy-btn" data-shape="icon" disabled={!isToday} title="Remove" onClick={() => onDelete(index, seg)} style={{ flexShrink: 0, opacity: isToday ? 1 : 0.4 }}>
        <span className="candy-face"><IconTrash size={11} /></span>
      </button>
    </div>
  );
}

export default function FitnessSection({ accent = 'var(--accent)', isToday = false, pivotDs, refreshTick = 0, history = [] }) {
  const { settings } = useSettings();
  const { splits, setActive, saveSplit, deleteSplit } = useWorkoutSplits();
  const today = useTodayWorkout(splits, pivotDs);
  const { presets, savePreset, deletePreset } = useCardioPresets();
  const [day, setDay] = useState({ workout: null, cardio: [], mtime: null, exists: false });

  // Opt-in streak chip (default off — "loss is silent"). isRestDs lets a planned
  // rest day be a neutral skip rather than a streak break.
  const streak = settings.showFitnessStreak
    ? computeFitnessStreak(history, { isRestDs: (ds) => isRestDay(today.split, ds) === true })
    : null;

  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserPos, setChooserPos] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const splitBtnRef = useRef(null);

  const [cardioOpen, setCardioOpen] = useState(false);
  const [cardioPos, setCardioPos] = useState(null);
  const [comboOpen, setComboOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState(null);
  const cardioBtnRef = useRef(null);

  const refreshDay = useCallback(async () => {
    if (!pivotDs) return;
    try { setDay(await api.health.readDay(pivotDs)); } catch { /* keep last */ }
  }, [pivotDs]);
  useEffect(() => { refreshDay(); }, [refreshDay, refreshTick]);

  const anchor = (ref, setter, open) => {
    if (!open) { setter(null); return; }
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const W = 300;
    setter({ top: r.bottom + 8, left: Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8)) });
  };
  useLayoutEffect(() => { anchor(splitBtnRef, setChooserPos, chooserOpen); }, [chooserOpen]);
  useLayoutEffect(() => { anchor(cardioBtnRef, setCardioPos, cardioOpen); }, [cardioOpen]);

  const workout = day.workout;
  const patchExercise = useCallback(async (index, ex, patch) => {
    await api.health.editWorkout(pivotDs, index, { ...ex, ...patch });
    await refreshDay();
  }, [pivotDs, refreshDay]);
  const startWorkout = useCallback(async () => {
    if (!today.dayLabel) return;
    await api.health.logWorkout(pivotDs, { day_label: today.dayLabel, exercises: today.targets.map((t) => ({ name: t.name, sets: t.sets, reps: t.reps, weight: t.weight ?? null, done: false })) });
    await refreshDay();
  }, [pivotDs, today, refreshDay]);
  const clearWorkout = useCallback(async () => { await api.health.deleteWorkout(pivotDs); await refreshDay(); }, [pivotDs, refreshDay]);

  const patchCardio = useCallback(async (index, seg, patch) => {
    await api.health.editCardio(pivotDs, index, { ...seg, ...patch });
    await refreshDay();
  }, [pivotDs, refreshDay]);
  const deleteCardioSeg = useCallback(async (index, seg) => {
    await api.health.deleteCardio(pivotDs, index, { type: seg.type, minutes: seg.minutes, zone: seg.zone ?? null });
    await refreshDay();
  }, [pivotDs, refreshDay]);

  const openNew = () => { setEditing(null); setEditorOpen(true); };
  const openEdit = (s) => { setEditing(s); setEditorOpen(true); };
  const openNewPreset = () => { setEditingPreset(null); setComboOpen(true); };
  const openEditPreset = (p) => { setEditingPreset(p); setComboOpen(true); };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Workout */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <PaneHeader>Fitness</PaneHeader>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {streak && streak.current > 0 && (
              <span title={`Current streak ${streak.current} day${streak.current === 1 ? '' : 's'} · longest ${streak.longest}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: accent }}>
                <IconSparkles size={12} /> {streak.current}
              </span>
            )}
            <button ref={splitBtnRef} type="button" data-own-press className="candy-btn health-split-trigger" data-shape="chip" title="Workout splits" onClick={() => setChooserOpen((v) => !v)}>
              <span className="candy-face"><IconDumbbell size={13} /> {today.split ? today.split.name : 'Split'}</span>
            </button>
          </div>
        </div>

        {workout ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={subHeader}>{workout.day_label}</span>
              <button type="button" className="candy-btn" data-shape="icon" disabled={!isToday} title={isToday ? 'Clear workout' : 'Switch to today to edit'} onClick={clearWorkout} style={isToday ? undefined : { opacity: 0.4 }}><span className="candy-face"><IconTrash size={12} /></span></button>
            </div>
            {workout.exercises.map((ex, i) => <ExerciseRow key={`${ex.name}:${i}`} ex={ex} index={i} isToday={isToday} onPatch={patchExercise} accent={accent} />)}
          </div>
        ) : !today.split ? (
          <button type="button" className="candy-btn" data-shape="chip" onClick={() => setChooserOpen(true)} style={{ alignSelf: 'flex-start' }}><span className="candy-face">Choose a split</span></button>
        ) : today.isRest ? (
          <div style={{ ...mono12, color: 'var(--text-faint)' }}>Rest day — {today.dayLabel}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ ...mono12, color: 'var(--text-faint)' }}>{today.dayLabel} — {today.targets.length} exercise{today.targets.length === 1 ? '' : 's'}</span>
            <button type="button" className="candy-btn" data-shape="chip" disabled={!isToday} onClick={startWorkout} title={isToday ? `Start ${today.dayLabel}` : 'Switch to today to log'} style={{ alignSelf: 'flex-start', ...(isToday ? {} : { opacity: 0.5 }) }}><span className="candy-face">Start {today.dayLabel}</span></button>
          </div>
        )}
      </div>

      {/* Cardio */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="candy-center-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ ...subHeader, display: 'inline-flex', alignItems: 'center', gap: 5 }}><IconHeartPulse size={12} /> Cardio</span>
          <button ref={cardioBtnRef} type="button" data-own-press className="candy-btn health-cardio-trigger" data-shape="circle" disabled={!isToday} title={isToday ? 'Log cardio' : 'Switch to today to log'} onClick={() => setCardioOpen((v) => !v)} style={isToday ? undefined : { opacity: 0.45 }}>
            <span className="candy-face"><IconPlus size={14} /></span>
          </button>
        </div>
        {(day.cardio || []).length === 0 ? (
          <span style={{ color: 'var(--text-muted)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>No cardio logged.</span>
        ) : (
          day.cardio.map((seg, i) => <CardioRow key={`${seg.type}:${seg.minutes}:${seg.zone || ''}:${i}`} seg={seg} index={i} isToday={isToday} onPatch={patchCardio} onDelete={deleteCardioSeg} accent={accent} />)
        )}
      </div>

      <SplitChooserPopover open={chooserOpen && !!chooserPos} onClose={() => setChooserOpen(false)} style={{ position: 'fixed', zIndex: 1100, top: chooserPos?.top, left: chooserPos?.left }} accent={accent} splits={splits} onActivate={setActive} onEdit={openEdit} onDelete={deleteSplit} onNew={openNew} />
      {editorOpen && <SplitEditorWindow open={editorOpen} onClose={() => setEditorOpen(false)} accent={accent} initial={editing} onSave={saveSplit} />}

      <CardioChooserPopover open={cardioOpen && !!cardioPos} onClose={() => setCardioOpen(false)} style={{ position: 'fixed', zIndex: 1100, top: cardioPos?.top, left: cardioPos?.left }} accent={accent} presets={presets} pivotDs={pivotDs} onLogged={refreshDay} onEdit={openEditPreset} onDelete={deletePreset} onNew={openNewPreset} />
      {comboOpen && <CardioComboWindow open={comboOpen} onClose={() => setComboOpen(false)} accent={accent} initial={editingPreset} onSave={savePreset} />}
    </section>
  );
}
