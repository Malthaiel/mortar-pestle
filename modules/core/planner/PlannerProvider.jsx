import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '@host/api.js';
import { useHashRoute } from '@host/router.js';
import { useSettings } from '@host/hooks/useSettings.js';
import { PlannerContext, usePlanner } from '@host/hooks/usePlanner.js';
import { registerCommandAction } from '@host/command-actions.js';
import { useModuleSettings } from '@host/hooks/useSettings.js';
import { useFrameEditing } from '@host/hooks/useFrameEditing.js';
import { smartTitleCase } from '@host/util/titlecase.js';
import { useVault } from './useVault.js';
import { plannerApi } from './api.js';
import { DRAG_DURATIONS } from './dragDurations.js';
import {
  descFromSession, descFromPlan, resolveDesc, computePullPlan, findNextBlock, trimToNowOp,
} from './blockPull.js';
import { NextBlockToast } from './BlockTimerUI.jsx';

// Re-export usePlanner so Planner-internal components can keep their
// relative imports (`from './PlannerProvider.jsx'`). The actual Context +
// hook live in host so host code (PageView, etc.) can also consume them.
export { usePlanner };

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dateStr(new Date()); }

const FOCUS_MINS = 30;
const BREAK_MINS = 5;
const FOCUS_SECS = FOCUS_MINS * 60;

function loadTimerState() {
  try {
    const raw = localStorage.getItem('focus_timer');
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.sessionStart) s.sessionStart = new Date(s.sessionStart);
    return s;
  } catch { return null; }
}

function saveTimerState(state) {
  try {
    const s = { ...state };
    if (s.sessionStart instanceof Date) s.sessionStart = s.sessionStart.toISOString();
    localStorage.setItem('focus_timer', JSON.stringify(s));
  } catch {}
}

function restoreTimerState(durSecs) {
  const saved = loadTimerState();
  if (!saved || !saved.phase) return null;
  // Block runs restore against their absolute wall-clock target — the generic
  // path below reconstructs the end from durSecs (the 30-min default), which
  // is wrong for arbitrary block spans.
  if (saved.blockRun && saved.blockRun.targetEpochMs) {
    if (saved.running && saved.sessionStart) {
      const target = saved.blockRun.targetEpochMs + (saved.pausedDuration || 0) * 1000;
      const remaining = Math.round((target - Date.now()) / 1000);
      if (remaining <= 0) {
        return { ...saved, secsLeft: 0, running: false, sessionComplete: true };
      }
      return { ...saved, secsLeft: remaining, running: true, sessionComplete: false };
    }
    return { ...saved, running: false, sessionComplete: false };
  }
  if (saved.running && saved.sessionStart) {
    const totalSecs = durSecs + (saved.pausedDuration || 0);
    const expectedEnd = new Date(saved.sessionStart.getTime() + totalSecs * 1000);
    const now = new Date();
    if (now >= expectedEnd) {
      return { ...saved, secsLeft: 0, running: false, sessionComplete: true };
    }
    const remaining = Math.round((expectedEnd - now) / 1000);
    return { ...saved, secsLeft: Math.max(0, remaining), running: true, sessionComplete: false };
  }
  return {
    phase: saved.phase, secsLeft: saved.secsLeft ?? durSecs, running: false,
    sessionStart: null, pausedDuration: saved.pausedDuration || 0,
    pomCount: saved.pomCount || 0, sessionComplete: false,
  };
}

export function PlannerProvider({ children }) {
  // Module-registered providers can't receive props. Resolve accent/settings
  // internally via the host's useSettings + the active page's accentKey.
  const route = useHashRoute();
  const { settings, setSetting } = useSettings(route.accentKey);
  const { settings: moduleSettings } = useModuleSettings('planner');
  const autoCaps = moduleSettings.autoCaps === true;
  const accent = settings.accentColor;

  // ── Timer state ─────────────────────────────────────────────────────────
  const [phase, setPhase] = useState('focus');
  const [secsLeft, setSecsLeft] = useState(FOCUS_SECS);
  const [running, setRunning] = useState(false);
  const [pomCount, setPomCount] = useState(0);
  const [sessionStart, setSessionStart] = useState(null);
  const [pausedDuration, setPausedDuration] = useState(0);
  const [dragMins, setDragMins] = useState(null);
  const [durationOverride, setDurationOverride] = useState({});
  const intervalRef = useRef(null);
  const pauseStartRef = useRef(null);

  // ── Block-timer state ───────────────────────────────────────────────────
  // blockRun = { key, label, endMins, dateKey, targetEpochMs } while a
  // calendar-block timer is active. Ref mirror keeps handlePhaseComplete's
  // branch readable without widening its dependency churn.
  const [blockRun, setBlockRun] = useState(null);
  const blockRunRef = useRef(null);
  useEffect(() => { blockRunRef.current = blockRun; }, [blockRun]);
  const [nextPrompt, setNextPrompt] = useState(null);

  // ── Calendar / nav state ────────────────────────────────────────────────
  const [pivotDate, setPivotDate] = useState(new Date());
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('focus_view_mode') || 'day'; } catch { return 'day'; }
  });
  const [customDays, setCustomDays] = useState(() => {
    try { return Math.max(1, Math.min(10, parseInt(localStorage.getItem('focus_custom_days')) || 3)); }
    catch { return 3; }
  });
  useEffect(() => { try { localStorage.setItem('focus_view_mode', viewMode); } catch {} }, [viewMode]);
  useEffect(() => { try { localStorage.setItem('focus_custom_days', String(customDays)); } catch {} }, [customDays]);

  // ── Vault hook ──────────────────────────────────────────────────────────
  const {
    vaultStatus, vaultName, vaultTasks, planBlocks,
    sessions, recentNotes, routineItems, loadVault, loadRecent, loadRoutine,
    setSessions, setVaultTasks, setRoutineItems,
  } = useVault({ viewMode, pivotDate, customDays });

  // #17: provider-owned date tick — todayKey rolls at midnight even with
  // CalendarPanel unmounted (its own tick only runs while mounted, which is
  // why the widget calendar used to freeze on yesterday overnight). The pivot
  // follows the rollover only when it sat on the old today, so a deliberate
  // pivot elsewhere survives.
  const [todayKey, setTodayKey] = useState(() => todayStr());
  const todayKeyRef = useRef(todayKey);
  todayKeyRef.current = todayKey;
  useEffect(() => {
    let t;
    function tick() {
      const ds = todayStr();
      const prev = todayKeyRef.current;
      if (ds !== prev) {
        setTodayKey(ds);
        setPivotDate(pd => (dateStr(pd) === prev ? new Date() : pd));
      }
      t = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    }
    t = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(t);
  }, []);

  // Today's frame segments + override writer for the block-pull engine.
  // Provider-owned (not dock-owned) so pulls and the completion prompt keep
  // working if the dock collapses. Keyed by todayKey so segments re-fetch at
  // the midnight rollover.
  const blockFrameKeys = useMemo(() => [todayKey], [todayKey]);
  const {
    frameSegments: blockFrameSegments,
    refreshOverrides: refreshBlockOverrides,
  } = useFrameEditing(blockFrameKeys);

  // ── Active selection ─────────────────────────────────────────────────────
  const [activeVaultRaw, setActiveVaultRaw] = useState(null);
  const [activePlanKey, setActivePlanKey] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeNote, setActiveNote] = useState('');
  const [taskDrag, setTaskDrag] = useState(null);

  // ── Dock collapse ───────────────────────────────────────────────────────
  const [dockCollapsed, setDockCollapsed] = useState(() => {
    try { return localStorage.getItem('pomo_dock_collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('pomo_dock_collapsed', dockCollapsed ? '1' : '0'); } catch {}
  }, [dockCollapsed]);
  const toggleDockCollapsed = useCallback(() => setDockCollapsed(v => !v), []);

  const focusSecs = (durationOverride.focus || FOCUS_MINS) * 60;
  const breakSecs = (durationOverride.break || BREAK_MINS) * 60;

  const activePlanBlock = useMemo(() => (
    activePlanKey
      ? planBlocks.find(b => `${b.start}-${b.end}-${b.title}` === activePlanKey)
      : null
  ), [activePlanKey, planBlocks]);

  const activeVaultTask = useMemo(() => (
    activeVaultRaw ? vaultTasks.find(t => t.raw === activeVaultRaw) : null
  ), [activeVaultRaw, vaultTasks]);

  const activeSession = useMemo(() => (
    activeSessionId ? sessions.find(s => s.id === activeSessionId) : null
  ), [activeSessionId, sessions]);

  const activeTaskName = blockRun?.label
    || activePlanBlock?.title
    || activeVaultTask?.display
    || activeSession?.task
    || 'Focus session';

  const activeTaskDisplay = activePlanBlock
    ? { name: activePlanBlock.title, time: `${activePlanBlock.start}–${activePlanBlock.end}` }
    : activeVaultTask
      ? { name: activeVaultTask.display, project: activeVaultTask.project }
      : activeSession
        ? { name: activeSession.task, time: `${activeSession.start}–${activeSession.end}` }
        : null;

  // ── Timer restore + persistence ─────────────────────────────────────────
  const restorePendingRef = useRef(null);
  useEffect(() => {
    const rest = restoreTimerState(FOCUS_SECS);
    if (rest) {
      setPhase(rest.phase);
      setSecsLeft(rest.secsLeft);
      setRunning(rest.running);
      setSessionStart(rest.sessionStart ? new Date(rest.sessionStart) : null);
      setPausedDuration(rest.pausedDuration || 0);
      setPomCount(rest.pomCount || 0);
      if (rest.blockRun) {
        // Sync the ref NOW so a pending completion routes through the
        // block-mode branch (the mirror effect hasn't run yet).
        blockRunRef.current = rest.blockRun;
        setBlockRun(rest.blockRun);
      }
      if (rest.sessionComplete) restorePendingRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    saveTimerState({ phase, secsLeft, running, sessionStart, pausedDuration, pomCount, blockRun });
  }, [phase, secsLeft, running, sessionStart, pausedDuration, pomCount, blockRun]);

  useEffect(() => {
    const api = plannerApi();
    if (!api) return;
    if (running) api.dirty.set('session-active');
    else api.dirty.clear();
  }, [running]);

  useEffect(() => {
    if (!running && !sessionStart) {
      setSecsLeft(phase === 'focus' ? focusSecs : breakSecs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSecs, breakSecs, phase]);

  // ── Block-timer helpers (shared by completion + controls) ───────────────
  // Uniform descriptors for every block on today's calendar — real sessions,
  // merged frame segments, and plan-fence blocks.
  const todayDescs = useCallback(() => {
    const ds = todayStr();
    const out = [];
    for (const s of sessions) if (s.dateKey === ds) out.push(descFromSession(s));
    for (const f of blockFrameSegments) if (f.dateKey === ds) out.push(descFromSession(f));
    for (const b of planBlocks) out.push(descFromPlan(b, ds));
    return out;
  }, [sessions, blockFrameSegments, planBlocks]);

  const notifyError = useCallback((message) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
      type: 'planner-block', title: 'Planner', message,
      accent: 'var(--text)', iconKey: 'alert', duration: 6000,
    } }));
  }, []);

  // Stop an active block run without logging anything — the block itself is
  // the record. Resets to the idle focus default.
  const stopBlockRun = useCallback(() => {
    setBlockRun(null);
    blockRunRef.current = null;
    setRunning(false);
    setSessionStart(null);
    setPausedDuration(0);
    pauseStartRef.current = null;
    setPhase('focus');
    setSecsLeft(focusSecs);
  }, [focusSecs]);

  // Block-mode completion: next-block prompt, nothing else. No session append
  // (the block IS the record), no pomCount, no break swap, and deliberately
  // NO `planner:phase-complete` — that event summons the full-screen
  // BreakOverlay, which is break-swap UX. Shared by the natural countdown end
  // and the finish-early control. Completions are silent + still by design
  // (tick/chime/confetti removed in the Planner Overhaul epic).
  const completeBlockRun = useCallback((run) => {
    if (run.dateKey === todayStr()) {
      const now = new Date();
      const next = findNextBlock(todayDescs(), now.getHours() * 60 + now.getMinutes(), run.key);
      if (next) setNextPrompt({ label: next.label, ref: next.ref });
    }
    setBlockRun(null);
    blockRunRef.current = null;
    setRunning(false);
    setSessionStart(null);
    setPausedDuration(0);
    pauseStartRef.current = null;
    setSecsLeft(focusSecs);
  }, [todayDescs, focusSecs]);

  // ── Phase complete ──────────────────────────────────────────────────────
  const handlePhaseComplete = useCallback(() => {
    if (blockRunRef.current) {
      completeBlockRun(blockRunRef.current);
      return;
    }
    if (phase === 'focus') {
      const end = new Date();
      const start = sessionStart || new Date(end.getTime() - focusSecs * 1000);
      const adjustedEnd = new Date(end.getTime() + pausedDuration * 1000);
      const sTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
      const eTime = `${pad(adjustedEnd.getHours())}:${pad(adjustedEnd.getMinutes())}`;
      const durMin = Math.round((adjustedEnd - start) / 60000);

      const newSession = {
        id: `${sTime}:::${eTime}:::${activeTaskName}:::${Date.now()}`,
        task: activeTaskName,
        start: sTime, end: eTime, durMin, notes: activeNote, type: 'focus',
        dateKey: todayStr(),
      };
      setSessions(prev => [...prev, newSession]);
      setActiveNote('');

      api.appendSession(todayStr(), { task: activeTaskName, start: sTime, end: eTime, notes: activeNote })
        .catch(console.warn);

      const nextCount = pomCount + 1;
      setPomCount(nextCount);
      setPhase('break');
      setSecsLeft(breakSecs);
      setDurationOverride(o => { const n = { ...o }; delete n.focus; return n; });

      // Session-complete event — the break overlay listens for it to swap in.
      // Completion is otherwise silent + still by design (tick/chime/confetti
      // removed in the Planner Overhaul epic).
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('planner:phase-complete', {
          detail: { phase: 'focus', nextCount },
        }));
      }
    } else {
      setPhase('focus');
      setSecsLeft(focusSecs);
      setDurationOverride(o => { const n = { ...o }; delete n.break; return n; });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('planner:phase-complete', {
          detail: { phase: 'break' },
        }));
      }
    }
    setRunning(false);
    setSessionStart(null);
    setPausedDuration(0);
    pauseStartRef.current = null;
  }, [phase, sessionStart, focusSecs, pausedDuration, activeTaskName, activeNote, breakSecs, setSessions, completeBlockRun]);

  useEffect(() => {
    if (restorePendingRef.current) {
      restorePendingRef.current = false;
      handlePhaseComplete();
    }
  }, [handlePhaseComplete]);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setSecsLeft(s => {
          if (s <= 1) { clearInterval(intervalRef.current); handlePhaseComplete(); return 0; }
          return s - 1;
        });
      }, 1000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [running, phase, focusSecs, breakSecs, handlePhaseComplete]);

  // ── Timer controls ──────────────────────────────────────────────────────
  const toggleTimer = useCallback(() => {
    if (!running) {
      if (phase === 'focus' && !sessionStart) setSessionStart(new Date());
      if (pauseStartRef.current) {
        const pausedSecs = Math.round((new Date() - pauseStartRef.current) / 1000);
        setPausedDuration(d => d + pausedSecs);
        pauseStartRef.current = null;
      }
      setRunning(true);
    } else {
      // Block runs can't pause — pause would silently drift the finish past
      // the block's calendar end. The dock swaps PAUSE out for cancel +
      // finish-early; this guards the keybind/palette paths too.
      if (blockRunRef.current) return;
      setRunning(false);
      pauseStartRef.current = new Date();
    }
  }, [running, phase, sessionStart]);

  const resetTimer = useCallback(() => {
    if (blockRunRef.current) { stopBlockRun(); return; }
    setRunning(false);
    setSessionStart(null);
    setPausedDuration(0);
    pauseStartRef.current = null;
    setDurationOverride(o => { const n = { ...o }; delete n[phase]; return n; });
    setSecsLeft(phase === 'focus' ? FOCUS_MINS * 60 : BREAK_MINS * 60);
  }, [phase, stopBlockRun]);

  const endSessionEarly = useCallback(() => {
    // Ending a block run early is a plain stop — no partial session is
    // appended (the calendar block already represents the plan).
    if (blockRunRef.current) { stopBlockRun(); return; }
    if (phase !== 'focus' || !sessionStart) return;
    const end = pauseStartRef.current ?? new Date();
    const sTime = `${pad(sessionStart.getHours())}:${pad(sessionStart.getMinutes())}`;
    const eTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;

    api.appendSession(todayStr(), { task: activeTaskName, start: sTime, end: eTime, notes: activeNote })
      .catch(console.warn);

    setActiveNote('');
    setPomCount(c => c + 1);
    setPhase('break');
    setSecsLeft(breakSecs);
    setRunning(false);
    setSessionStart(null);
    setPausedDuration(0);
    pauseStartRef.current = null;
    setDurationOverride(o => { const n = { ...o }; delete n.focus; return n; });
  }, [phase, sessionStart, activeTaskName, activeNote, breakSecs, stopBlockRun]);

  const skipPhase = useCallback(() => {
    if (blockRunRef.current) { stopBlockRun(); return; }
    setRunning(false);
    setSessionStart(null);
    setPausedDuration(0);
    pauseStartRef.current = null;
    setPhase(p => p === 'focus' ? 'break' : 'focus');
    setSecsLeft(phase === 'focus' ? breakSecs : focusSecs);
  }, [phase, breakSecs, focusSecs, stopBlockRun]);

  // ── Dial drag ───────────────────────────────────────────────────────────
  const idle = !running && !sessionStart;
  const handleDragStart = useCallback((m) => { setDragMins(m); }, []);
  const handleDrag = useCallback((m) => { setDragMins(m); }, []);
  const handleDragEnd = useCallback(() => {
    if (dragMins != null) {
      const mins = dragMins;
      setDurationOverride(o => ({ ...o, [phase]: mins }));
      setSecsLeft(mins * 60);
      setDragMins(null);
    }
  }, [dragMins, phase]);

  // ── Block-timer actions ─────────────────────────────────────────────────
  // Start the focus timer against a block: it counts down to the block's END
  // minute whenever it's started (late = remaining only, early = span + head
  // start). durationOverride is deliberately untouched — nothing leaks into
  // later dial sessions and there's nothing to restore afterward.
  const startBlockTimer = useCallback((post) => {
    const now = new Date();
    const nowSecs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const remaining = post.endMins * 60 - nowSecs;
    if (remaining < 60) {
      notifyError(`“${post.label}” ends in under a minute — nothing to run.`);
      return;
    }
    const target = new Date(now);
    target.setHours(0, 0, 0, 0);
    const run = {
      key: post.key, label: post.label, endMins: post.endMins,
      dateKey: post.dateKey, targetEpochMs: target.getTime() + post.endMins * 60_000,
    };
    blockRunRef.current = run;
    setBlockRun(run);
    setPhase('focus');
    setSecsLeft(remaining);
    setSessionStart(now);
    setPausedDuration(0);
    pauseStartRef.current = null;
    setNextPrompt(null);
    setRunning(true);
  }, [notifyError]);

  // Execute a pull plan. ORDER CONTRACT (two mtime regimes): all writerCall
  // ops (sessions + plan blocks — chained daily mtime) must run BEFORE all
  // frame overrides (setOverride re-reads its own mtime and bypasses the
  // writer cache), then one loadVault() re-syncs the cache via api.today().
  // computePullPlan emits ops already in that order. A mid-sequence failure
  // aborts the rest; whatever persisted stays (visible after the reload).
  const executePull = useCallback(async (plan) => {
    try {
      for (const op of plan.writes) {
        if (op.type === 'session') {
          const r = await api.updateSession(op.ds, op.oldId, op.newSession);
          if (r && r.ok === false) throw new Error(r.error || 'Session not found');
        } else if (op.type === 'plan') {
          const r = await api.updatePlanBlock(op.ds, op.oldBlock, op.newBlock);
          if (r && r.ok === false) throw new Error(r.error || 'Plan block not found');
        } else {
          await api.dailyFrame.setOverride(op.ds, op.frameId, op.override);
        }
      }
    } catch (e) {
      console.warn('[block-pull] write failed:', e);
      notifyError('Couldn’t finish the pull — calendar reloaded to what persisted.');
      await loadVault().catch(() => {});
      refreshBlockOverrides();
      return false;
    }
    await loadVault().catch(() => {});
    refreshBlockOverrides();
    return true;
  }, [loadVault, refreshBlockOverrides, notifyError]);

  // Finish a block run early: trim the block's calendar end to the actual
  // finish (the pull-forward trim semantics — session/plan/frame alike), then
  // run the normal completion. A run outside its calendar span (started early
  // without a pull, or inside the first minute) completes with no trim —
  // there's nothing truthful to write.
  const finishBlockEarly = useCallback(async () => {
    const run = blockRunRef.current;
    if (!run) return;
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const all = todayDescs();
    const desc = run.dateKey === todayStr() ? all.find(d => d.key === run.key) : null;
    const op = desc ? trimToNowOp(desc, all, nowMins) : null;
    if (op) {
      const ok = await executePull({ writes: [op] });
      if (!ok) return; // toasted + reloaded inside executePull; keep the run
    }
    completeBlockRun(run);
  }, [todayDescs, executePull, completeBlockRun]);

  // Pull source (+ manually selected later blocks) to now, then start the
  // source's timer. Everything re-resolves against fresh data at execution.
  const pullAndStart = useCallback(async (sourceDesc, selectedDescs = []) => {
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const all = todayDescs();
    const source = resolveDesc(sourceDesc.ref, all);
    if (!source) { notifyError('That block changed — pull cancelled.'); return; }
    const selected = selectedDescs.map(d => resolveDesc(d.ref, all)).filter(Boolean);
    const plan = computePullPlan({ source, selected, allBlocks: all, nowMins });
    if (plan.refusal) { notifyError(plan.refusal); return; }
    if (await executePull(plan)) startBlockTimer(plan.post);
  }, [todayDescs, executePull, startBlockTimer, notifyError]);

  // Stop whatever is running, then hand off to the clicked block's action.
  // A dial focus run logs its partial session (mirrors endSessionEarly minus
  // the break swap); a block run is discarded silently; a break just stops.
  const switchToBlock = useCallback((proceed) => {
    if (blockRunRef.current) {
      blockRunRef.current = null;
      setBlockRun(null);
      setRunning(false);
      setSessionStart(null);
      setPausedDuration(0);
      pauseStartRef.current = null;
    } else if (phase === 'focus' && sessionStart) {
      const end = pauseStartRef.current ?? new Date();
      const sTime = `${pad(sessionStart.getHours())}:${pad(sessionStart.getMinutes())}`;
      const eTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
      api.appendSession(todayStr(), { task: activeTaskName, start: sTime, end: eTime, notes: activeNote })
        .catch(console.warn);
      setActiveNote('');
      setPomCount(c => c + 1);
      setRunning(false);
      setSessionStart(null);
      setPausedDuration(0);
      pauseStartRef.current = null;
      setDurationOverride(o => { const n = { ...o }; delete n.focus; return n; });
    } else {
      setRunning(false);
      setSessionStart(null);
      setPausedDuration(0);
      pauseStartRef.current = null;
      setPhase('focus');
    }
    proceed();
  }, [phase, sessionStart, activeTaskName, activeNote]);

  // Completion-toast action: start the next block fresh — pulled to now if it
  // hasn't started yet, remaining-only if its window already opened.
  const handleNextPromptAction = useCallback(async () => {
    const prompt = nextPrompt;
    setNextPrompt(null);
    if (!prompt) return;
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const all = todayDescs();
    const desc = resolveDesc(prompt.ref, all);
    if (!desc || desc.endMins <= nowMins) {
      notifyError('That block is gone — pick one from the calendar.');
      return;
    }
    if (desc.startMins > nowMins) {
      await pullAndStart(desc, []);
    } else {
      startBlockTimer({ key: desc.key, label: desc.label, endMins: desc.endMins, dateKey: desc.ref.ds });
    }
  }, [nextPrompt, todayDescs, pullAndStart, startBlockTimer, notifyError]);

  // ── Vault actions ───────────────────────────────────────────────────────
  const toggleVaultTask = useCallback(async (raw) => {
    try {
      const r = await api.toggleTask(raw);
      if (r.error) console.warn(r.error);
      if (r.tasks) setVaultTasks(r.tasks);
    } catch (e) { console.warn(e); }
  }, [setVaultTasks]);

  const toggleRoutineTask = useCallback(async (taskName) => {
    try {
      const r = await api.toggleRoutine(taskName);
      if (r.error) console.warn(r.error);
      if (r.items) setRoutineItems(r.items);
    } catch (e) { console.warn(e); }
  }, [setRoutineItems]);

  const handleSessionCreate = useCallback(async (ds, startTime, endTime, taskName, notes = '') => {
    const raw = taskName || activeTaskName;
    const name = autoCaps ? smartTitleCase(raw) : raw;
    let end = endTime;
    if (!end) {
      const [sh, sm] = startTime.split(':').map(Number);
      const endMins = sh * 60 + sm + DRAG_DURATIONS.task;
      end = `${pad(Math.floor(endMins / 60) % 24)}:${pad(endMins % 60)}`;
    }
    await api.appendSession(ds, { task: name, start: startTime, end, notes });
    await loadVault();
  }, [activeTaskName, autoCaps, loadVault]);

  const handleSessionResize = useCallback(async (ds, sessionId, newStart, newEnd) => {
    const sess = sessions.filter(s => s.dateKey === ds).find(s => s.id === sessionId);
    if (!sess) return;
    await api.updateSession(ds, sessionId, {
      task: sess.task, start: newStart, end: newEnd, notes: sess.notes || '',
    });
    await loadVault();
  }, [sessions, loadVault]);

  const handleSessionRename = useCallback(async (ds, sessionId, newTask) => {
    const sess = sessions.filter(s => s.dateKey === ds).find(s => s.id === sessionId);
    if (!sess) return;
    await api.updateSession(ds, sessionId, {
      task: autoCaps ? smartTitleCase(newTask) : newTask,
      start: sess.start, end: sess.end, notes: sess.notes || '',
    });
    await loadVault();
  }, [sessions, autoCaps, loadVault]);

  const handleSessionMove = useCallback(async (srcDs, sessionId, targetDs, newStart, newEnd) => {
    const sess = sessions.filter(s => s.dateKey === srcDs).find(s => s.id === sessionId);
    if (!sess) return;
    await api.deleteSession(srcDs, sessionId);
    await api.appendSession(targetDs, { task: sess.task, start: newStart, end: newEnd, notes: sess.notes || '' });
    await loadVault();
  }, [sessions, loadVault]);

  const handleSessionDelete = useCallback(async (ds, sessionId) => {
    await api.deleteSession(ds, sessionId);
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    await loadVault();
  }, [setSessions, loadVault]);

  // Re-time a non-fixed plan block in place (today's plan fence). Plan blocks are
  // today-only, so `ds` is always today; the Rust writer matches the fence line by
  // (old start, end, title) and rewrites its times. Undo is wired in CalendarPane.
  const handlePlanBlockMove = useCallback(async (ds, block, newStart, newEnd) => {
    await api.updatePlanBlock(
      ds,
      { start: block.start, end: block.end, title: block.title },
      { start: newStart, end: newEnd, title: block.title },
    );
    await loadVault();
  }, [loadVault]);

  const handleFreeform = useCallback(async (text) => {
    await api.freeformNote(text);
  }, []);

  const handleUpdateNote = useCallback(async (ds, idx, text) => {
    const noteEntry = recentNotes.find(n => n.dateStr === ds && n.idx === idx);
    if (!noteEntry) return;
    await api.updateSessionNote(ds, noteEntry.id, text);
    await loadRecent();
  }, [recentNotes, loadRecent]);

  // ── Task drag ───────────────────────────────────────────────────────────
  // Generic "drag onto the calendar" primitive — pointer-based (WebKitGTK has
  // no working HTML5 DnD). Carries a `kind` + `payload` so the active task, a
  // library block, and a quick note all share one drag/overlay/drop path.
  const startPaneDrag = useCallback((kind, payload, label, e) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    function move(ev) {
      if (!started) {
        if ((ev.clientX - sx) ** 2 + (ev.clientY - sy) ** 2 < 16) return;
        started = true;
      }
      setTaskDrag({ kind, payload, label, taskName: payload.taskName, x: ev.clientX, y: ev.clientY });
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setTaskDrag(null);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);
  // Active-task drag keeps its original call shape; thin wrapper over the above.
  const startTaskDrag = useCallback((taskName, e) => {
    startPaneDrag('task', { taskName }, taskName, e);
  }, [startPaneDrag]);

  const handleTaskDrop = useCallback((ds, startTime) => {
    if (!taskDrag) return;
    const taskName = taskDrag.taskName;
    const [sh, sm] = startTime.split(':').map(Number);
    const endDate = new Date(0, 0, 0, sh, sm + DRAG_DURATIONS.task);
    const endTime = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;
    api.appendSession(ds, { task: taskName, start: startTime, end: endTime, notes: '' })
      .then(() => loadVault()).catch(console.warn);
    setTaskDrag(null);
  }, [taskDrag, loadVault]);

  const selectVaultTask = useCallback((raw) => {
    setActiveVaultRaw(raw); setActivePlanKey(null); setActiveSessionId(null);
  }, []);

  const selectPlanBlock = useCallback((block, key) => {
    setActivePlanKey(key); setActiveVaultRaw(null); setActiveSessionId(null);
  }, []);

  const selectSession = useCallback((s) => {
    setActiveSessionId(s.id); setActivePlanKey(null); setActiveVaultRaw(null);
  }, []);

  // Register Cmd+K palette actions for Planner control. The label flips
  // between Start / Pause based on `running` so the palette reflects what
  // pressing Enter actually does.
  useEffect(() => {
    const unsubs = [
      registerCommandAction({
        id: 'planner.toggle',
        label: running ? 'Pause Planner' : 'Start Planner',
        keywords: ['planner', 'planner', 'timer', 'focus', 'break'],
        run: () => toggleTimer(),
      }),
      registerCommandAction({
        id: 'planner.skip',
        label: phase === 'focus' ? 'Skip to break' : 'Skip to focus',
        keywords: ['planner', 'planner', 'phase', 'next'],
        run: () => skipPhase(),
      }),
      registerCommandAction({
        id: 'planner.reset',
        label: 'Reset Planner',
        keywords: ['planner', 'planner', 'timer', 'restart'],
        run: () => resetTimer(),
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [running, phase, toggleTimer, skipPhase, resetTimer]);

  const value = {
    // theme / settings
    accent, settings, setSetting,
    // timer state
    phase, secsLeft, running, pomCount, sessionStart, pausedDuration,
    dragMins, durationOverride, idle, focusSecs, breakSecs,
    pauseStartRef,
    // calendar view state
    pivotDate, viewMode, customDays,
    setPivotDate, setViewMode, setCustomDays,
    // vault data
    vaultStatus, vaultName, vaultTasks, planBlocks,
    sessions, recentNotes, routineItems,
    loadVault, loadRecent, loadRoutine,
    setSessions, setVaultTasks, setRoutineItems,
    // active selection
    activeVaultRaw, activePlanKey, activeSessionId, activeNote,
    setActiveVaultRaw, setActivePlanKey, setActiveSessionId, setActiveNote,
    activeTaskName, activeTaskDisplay,
    selectVaultTask, selectPlanBlock, selectSession,
    // pane drag (active task / library block / quick note → calendar)
    taskDrag,
    startTaskDrag, startPaneDrag, handleTaskDrop,
    // timer controls
    toggleTimer, resetTimer, endSessionEarly, skipPhase,
    handleDragStart, handleDrag, handleDragEnd,
    // block timers (Planner dock calendar)
    blockRun, startBlockTimer, stopBlockRun, finishBlockEarly, pullAndStart, switchToBlock,
    // session/vault mutations
    toggleVaultTask, toggleRoutineTask,
    handleSessionCreate, handleSessionResize, handleSessionMove, handleSessionDelete, handleSessionRename,
    handlePlanBlockMove, handleFreeform, handleUpdateNote,
    // dock
    dockCollapsed, toggleDockCollapsed,
  };

  return (
    <PlannerContext.Provider value={value}>
      {children}
      <NextBlockToast
        accent={accent}
        prompt={nextPrompt}
        onAction={handleNextPromptAction}
        onDismiss={() => setNextPrompt(null)}
      />
    </PlannerContext.Provider>
  );
}
