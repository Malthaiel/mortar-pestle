import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeEvents } from '@host/api.js';
import { getVisibleDays } from './CalendarPanel.jsx';

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dateStr(new Date()); }

// Single hook that owns the network surface for the vault: today's note,
// sessions for the visible date range, and the SSE invalidation
// stream. Returns plain values + imperative helpers used by App.
export function useVault({ viewMode, pivotDate, customDays }) {
  const [vaultStatus, setVaultStatus] = useState('loading'); // loading | connected | no-note | error
  const [vaultName, setVaultName] = useState('Citadel');
  const [vaultTasks, setVaultTasks] = useState([]);
  const [planBlocks, setPlanBlocks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [recentNotes, setRecentNotes] = useState([]);
  const [routineItems, setRoutineItems] = useState([]);

  // Capture the latest visible-range params so SSE handlers always reload the
  // right window without needing to re-subscribe on every change.
  const viewRef = useRef({ viewMode, pivotDate, customDays });
  useEffect(() => { viewRef.current = { viewMode, pivotDate, customDays }; }, [viewMode, pivotDate, customDays]);

  const loadVault = useCallback(async () => {
    try {
      const today = await api.today();
      if (!today.exists) {
        setVaultStatus('no-note');
        setVaultTasks([]);
        setPlanBlocks([]);
      } else {
        setVaultStatus('connected');
        setVaultTasks(today.tasks);
        setPlanBlocks(today.planBlocks);
      }

      const { viewMode: vm, pivotDate: pd, customDays: cd } = viewRef.current;
      const visible = getVisibleDays(vm, pd, cd);
      const dayMap = new Map();
      for (const d of visible) dayMap.set(dateStr(d), d);
      dayMap.set(todayStr(), new Date());

      const datesNeeded = [...dayMap.keys()].filter(ds => ds !== todayStr());
      // api.days() never shipped post-sidecar — the real range IPC lands with
      // the sessions store (epic #11). Guard the call so the missing fn can't
      // throw before setSessions below: that throw made committed drafts
      // vanish until reopen and left non-today columns sessionless (epic #9).
      const days = (datesNeeded.length && typeof api.days === 'function')
        ? await api.days(datesNeeded)
        : {};
      const all = [];
      for (const ds of dayMap.keys()) {
        if (ds === todayStr()) {
          if (today.exists) all.push(...today.sessions.map(s => ({ ...s, dateKey: ds })));
        } else if (days[ds]?.exists) {
          all.push(...days[ds].sessions.map(s => ({ ...s, dateKey: ds })));
        }
      }
      setSessions(all);
    } catch (e) {
      console.warn('loadVault:', e);
      setVaultStatus('error');
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try { const r = await api.recentNotes(); setRecentNotes(r.notes || []); }
    catch (e) { console.warn('recentNotes:', e); }
  }, []);

  const loadRoutine = useCallback(async () => {
    try { const r = await api.routine(); setRoutineItems(r.items || []); }
    catch (e) { console.warn('routine:', e); }
  }, []);

  // Initial load + re-load on visible range changes
  useEffect(() => { loadVault(); }, [loadVault, viewMode, pivotDate, customDays]);
  useEffect(() => { loadRecent(); }, [loadRecent]);
  useEffect(() => { loadRoutine(); }, [loadRoutine]);

  // SSE subscription
  useEffect(() => {
    const unsub = subscribeEvents((name, data) => {
      if (name === 'today') { loadVault(); loadRecent(); loadRoutine(); return; }
      if (name === 'routine') { loadRoutine(); return; }
      if (name === 'day') {
        const ds = data;
        const { viewMode: vm, pivotDate: pd, customDays: cd } = viewRef.current;
        const visible = getVisibleDays(vm, pd, cd);
        if (visible.some(d => dateStr(d) === ds) || ds === todayStr()) {
          loadVault();
          loadRecent();
        }
        return;
      }
    });
    return unsub;
  }, [loadVault, loadRecent, loadRoutine]);

  return {
    vaultStatus, vaultName,
    vaultTasks, planBlocks, sessions,
    recentNotes, routineItems,
    loadVault, loadRecent, loadRoutine,
    setSessions, setVaultTasks, setRoutineItems,
  };
}
