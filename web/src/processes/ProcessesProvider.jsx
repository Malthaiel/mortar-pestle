// Global process registry — the single host-side source of truth for the
// title-bar Processes button (badge) and the Processes window. It owns NO jobs:
// every engine in the app already keeps its own state cell and already emits a
// global Tauri progress/done event, so this subscribes to those SAME events and
// hydrates in-flight work from the matching `*_status` command. Nothing here
// re-derives elapsed or progress — each snapshot carries its own live numbers.
//
// Deliberately NOT a rewrite of anything: the DownloadsProvider idiom (liveById
// map, one normalizer per source, active/recent split) is copied wholesale.
//
// TWO INTAKE LANES:
//   A — Rust-owned jobs (the SOURCES table). Global event + `*_status` hydrate.
//   B — JS-lifetime jobs with no Rust job cell (the analyst `run_claude_cli`
//       Deadlock-notes run). They register themselves through the exported
//       beginProcess/updateProcess/endProcess helpers, which ride an
//       `agentic:process` CustomEvent — the same bridge idiom as
//       `agentic:notify` in NotificationProvider. A lane-B row dies with the
//       webview; a lane-A row survives navigation and reload.
//
// DOWNLOADS ARE DELIBERATELY ABSENT — music/anime/STT-model downloads keep the
// Downloads dock button + popup and are not duplicated here.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const Ctx = createContext(null);

const EMPTY = {
  active: [], recent: [], activeCount: 0,
  cancel: () => {}, setWindowOpen: () => {},
};

export function useProcesses() {
  return useContext(Ctx) || EMPTY;
}

const RECENT_CAP = 10;

// ── Lane B: the JS-side registration bridge ─────────────────────────────────
// Two lines at a call site is the whole contract:
//   beginProcess('deadlock-notes', { title: 'Deadlock notes', kind: 'notes' });
//   endProcess('deadlock-notes', { state: 'done' });

function emitProcess(detail) {
  window.dispatchEvent(new CustomEvent('agentic:process', { detail }));
}

export function beginProcess(id, row = {}) {
  emitProcess({ op: 'begin', id, startedMs: Date.now(), ...row });
}
export function updateProcess(id, patch = {}) {
  emitProcess({ op: 'update', id, ...patch });
}
export function endProcess(id, patch = {}) {
  emitProcess({ op: 'end', id, ...patch });
}

// ── Row helpers ─────────────────────────────────────────────────────────────

// One row shape for every source. `active` is a boolean rather than a state
// union because the ten engines below share no state vocabulary.
function row(o) {
  return {
    id: o.id,
    kind: o.kind,                     // icon key
    title: o.title,
    subtitle: o.subtitle || '',
    statusLine: o.statusLine || '',
    progress: o.progress ?? null,     // 0..1, or null for indeterminate work
    startedMs: o.startedMs ?? null,   // only when the source actually reports one
    active: !!o.active,
    canCancel: !!o.canCancel,
    error: o.error || null,
    pids: o.pids || [],               // phase 2
  };
}

const pct1 = (n) => (n == null ? null : Math.max(0, Math.min(1, n)));

// ── Lane A normalizers — one per source ─────────────────────────────────────

function normExport(s) {
  if (!s || s.state === 'idle') return null;
  const running = s.state === 'running';
  const speed = s.speed ? `${s.speed.toFixed(1)}x` : null;
  const eta = s.etaSecs != null && s.etaSecs >= 0 ? `${Math.round(s.etaSecs)}s left` : null;
  return row({
    id: 'vedit-export', kind: 'render', title: 'Render',
    subtitle: s.outputPath ? s.outputPath.split(/[\\/]/).pop() : 'Video export',
    statusLine: running
      ? [`${Math.round(s.pct || 0)}%`, speed, eta].filter(Boolean).join(' · ')
      : s.state === 'error' ? (s.error || 'Render failed')
        : s.state === 'cancelled' ? 'Stopped' : 'Rendered',
    progress: pct1((s.pct || 0) / 100),
    active: running, canCancel: running, error: s.error || null,
    pids: s.childPid ? [s.childPid] : [],
  });
}

function normCoach(s) {
  if (!s) return null;
  const running = s.status === 'running';
  const chunks = s.chunk != null && s.chunkTotal ? ` · chunk ${s.chunk}/${s.chunkTotal}` : '';
  const cost = s.cost ? ` · $${s.cost.toFixed(2)}` : '';
  return row({
    id: 'coach-job', kind: 'notes', title: 'Coaching notes',
    subtitle: `${s.scrim || ''}${s.matchN ? ` · match ${s.matchN}` : ''}`,
    statusLine: running ? `Phase ${s.phase || 0}${chunks}${cost}`
      : s.status === 'gate' ? 'Waiting for your review'
        : s.status === 'error' ? (s.error || 'Failed').split('\n')[0]
          : s.status === 'cancelled' ? 'Stopped' : `Done${cost}`,
    // Phase 1 chunks are the only real ratio the pipeline exposes.
    progress: running && s.chunkTotal ? pct1((s.chunk || 0) / s.chunkTotal) : null,
    startedMs: s.startedMs || null,
    active: running, canCancel: running, error: s.error || null,
    pids: s.pid ? [s.pid] : [],
  });
}

function normComms(s) {
  if (!s) return null;
  const running = s.status === 'running';
  return row({
    id: 'comms-job', kind: 'mic', title: 'Comms extraction',
    subtitle: s.matchN ? `Match ${s.matchN}` : (s.kind === 'vod' ? 'VOD comms' : ''),
    statusLine: running ? (s.phase || 'Working')
      : s.status === 'error' ? (s.error || 'Failed')
        : s.status === 'cancelled' ? 'Stopped' : 'Done',
    progress: running ? pct1(s.pct != null ? s.pct / 100 : null) : null,
    active: running, canCancel: running, error: s.error || null,
  });
}

function normImport(j) {
  const running = j.state === 'queued' || j.state === 'parsing' || j.state === 'importing';
  return row({
    id: `import:${j.id}`, kind: 'package', title: 'Library import',
    subtitle: j.source || j.kind || '',
    statusLine: running
      ? (j.total ? `${j.index || 0}/${j.total}${j.currentTitle ? ` · ${j.currentTitle}` : ''}` : j.state)
      : j.state === 'error' ? (j.error || 'Import failed')
        : j.state === 'cancelled' ? 'Stopped' : (j.summary || 'Imported'),
    progress: j.total ? pct1((j.index || 0) / j.total) : null,
    active: running, canCancel: running, error: j.error || null,
    pids: j.childPid ? [j.childPid] : [],
  });
}

function normBuild(s) {
  if (!s) return null;
  if (!s.running && s.lastExitCode == null) return null;
  return row({
    id: 'build-app', kind: 'terminal', title: 'Rebuild app',
    subtitle: s.mode ? `${s.mode} build` : '',
    statusLine: s.running ? (s.phase ? `${s.phase}…`.replace('…', '') : 'Starting')
      : s.lastExitCode === 0 ? 'Built' : `Failed (exit ${s.lastExitCode})`,
    progress: null,
    startedMs: s.startedAtMs || null,
    active: !!s.running, canCancel: !!s.running,
    pids: s.childPid ? [s.childPid] : [],
  });
}

function normSkillRun(r) {
  const running = r.status === 'running';
  return row({
    id: `skill:${r.jobId}`, kind: 'terminal', title: r.slug || 'Skill run',
    subtitle: r.command || '',
    statusLine: running ? 'Running' : r.status === 'cancelled' ? 'Stopped' : 'Finished',
    progress: null,
    // startedAt is seconds (f64) on the Rust side.
    startedMs: r.startedAt ? Math.round(r.startedAt * 1000) : null,
    active: running, canCancel: running,
  });
}

// Capture yields up to two rows off one snapshot: the recording, and the armed
// replay ring. Envelope is snake_case (the engine's own wire shape).
function normCapture(s) {
  if (!s) return [];
  const out = [];
  const recording = s.state === 'recording' || s.recording === true;
  if (recording || s.state === 'starting' || s.state === 'finalizing') {
    out.push(row({
      id: 'capture-record', kind: 'video', title: 'Recording',
      subtitle: s.game || 'Game capture',
      statusLine: s.state === 'recording' ? (s.codec || 'Recording') : s.state,
      startedMs: s.started_at_unix_ms || null,
      active: true, canCancel: true,
    }));
  }
  if (s.armed) {
    out.push(row({
      id: 'capture-replay', kind: 'video', title: 'Replay buffer',
      subtitle: s.game || 'Armed', statusLine: 'Armed',
      active: true, canCancel: true,
    }));
  }
  return out;
}

function normBroadcast(s) {
  if (!s) return [];
  const out = [];
  const rec = s.recording || {};
  if (rec.active) {
    out.push(row({
      id: 'broadcast-record', kind: 'broadcast', title: 'Broadcast recording',
      subtitle: rec.path ? String(rec.path).split(/[\\/]/).pop() : '',
      statusLine: rec.paused ? 'Paused' : 'Recording',
      startedMs: rec.elapsed_ns ? Date.now() - Math.round(rec.elapsed_ns / 1e6) : null,
      active: true, canCancel: true,
    }));
  }
  const st = s.stream || {};
  if (st.status && st.status !== 'idle') {
    out.push(row({
      id: 'broadcast-stream', kind: 'broadcast', title: 'Stream',
      subtitle: st.reconnects ? `${st.reconnects} reconnects` : '',
      statusLine: st.error || st.status,
      startedMs: st.elapsed_ns ? Date.now() - Math.round(st.elapsed_ns / 1e6) : null,
      active: st.status !== 'error', canCancel: true, error: st.error || null,
    }));
  }
  return out;
}

// ── Cancel routing ──────────────────────────────────────────────────────────

function cancelRow(r) {
  const id = r.id;
  if (id === 'vedit-export') return invoke('vedit_export_cancel');
  if (id === 'coach-job') return invoke('coach_job_cancel');
  if (id === 'comms-job') return invoke('comms_job_cancel');
  if (id === 'build-app') return invoke('build_app_cancel');
  if (id === 'capture-record') return invoke('capture_stop');
  if (id === 'capture-replay') return invoke('capture_disarm');
  if (id === 'broadcast-record') return invoke('broadcast_stop_record');
  if (id === 'broadcast-stream') return invoke('broadcast_request', { op: 'stop_stream', args: null });
  if (id === 'stt-dictation') return invoke('stt_stop_dictation');
  if (id.startsWith('import:')) return invoke('library_import_cancel', { jobId: id.slice(7) });
  if (id.startsWith('skill:')) return invoke('skills_cancel_run', { jobId: id.slice(6) });
  if (id === 'deadlock-notes') return invoke('coaching_cancel');
  // Clip prep: one arg-free command kills the running remux (the editor lane
  // is serialized, so there is at most one child).
  if (id.startsWith('remux:')) return invoke('vedit_proxy_cancel');
  return Promise.resolve();
}

// ── Provider ────────────────────────────────────────────────────────────────

export default function ProcessesProvider({ children }) {
  const [byId, setById] = useState({});          // id -> row (+ finishedAt once terminal)
  const [stats, setStats] = useState({});        // pid -> { cpuPct, rssBytes, alive }
  // The sampler reads the CURRENT rows without re-arming its interval on every
  // progress tick, so the ref is the live view of `byId`.
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const [windowOpen, setWindowOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = windowOpen;

  // Upsert stamps finishedAt on the active -> terminal edge, so `recent` can be
  // ordered without any source having to report a finish time.
  const upsert = useCallback((r) => {
    if (!r) return;
    setById((prev) => {
      const was = prev[r.id];
      const finishedAt = r.active ? null : (was && !was.active ? was.finishedAt : Date.now());
      return { ...prev, [r.id]: { ...r, finishedAt } };
    });
  }, []);

  const upsertMany = useCallback((rows) => rows.forEach(upsert), [upsert]);

  // A source that yields a variable set of rows (capture, broadcast) must also
  // retire the rows it stopped yielding — otherwise a finished recording sticks
  // around as permanently active.
  const syncGroup = useCallback((prefixes, rows) => {
    const live = new Set(rows.map((r) => r.id));
    setById((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((id) => {
        if (prefixes.includes(id) && !live.has(id) && next[id].active) {
          next[id] = { ...next[id], active: false, canCancel: false, statusLine: 'Finished', finishedAt: Date.now() };
        }
      });
      rows.forEach((r) => {
        const was = next[r.id];
        next[r.id] = { ...r, finishedAt: r.active ? null : (was && !was.active ? was.finishedAt : Date.now()) };
      });
      return next;
    });
  }, []);

  // Hydrate every in-flight job once on mount (covers a reload mid-run).
  useEffect(() => {
    let alive = true;
    const guard = (fn) => (v) => { if (alive) fn(v); };
    invoke('vedit_export_status').then(guard((s) => upsert(normExport(s)))).catch(() => {});
    invoke('coach_job_status').then(guard((s) => upsert(normCoach(s)))).catch(() => {});
    invoke('comms_job_status').then(guard((s) => upsert(normComms(s)))).catch(() => {});
    invoke('build_app_status').then(guard((s) => upsert(normBuild(s)))).catch(() => {});
    invoke('library_import_status').then(guard((js) => upsertMany((js || []).map(normImport)))).catch(() => {});
    invoke('get_capture_state').then(guard((s) => syncGroup(['capture-record', 'capture-replay'], normCapture(s)))).catch(() => {});
    invoke('broadcast_get_state').then(guard((s) => syncGroup(['broadcast-record', 'broadcast-stream'], normBroadcast(s)))).catch(() => {});
    return () => { alive = false; };
  }, [upsert, upsertMany, syncGroup]);

  // Lane A subscriptions. Every one of these events already fires app-wide
  // whether or not anything listens, so this costs nothing while idle.
  useEffect(() => {
    const subs = [
      listen('vedit-export-progress', (e) => upsert(normExport(e.payload))),
      listen('vedit-export-done', (e) => upsert(normExport(e.payload))),
      listen('coach-job-progress', (e) => upsert(normCoach(e.payload))),
      listen('coach-job-done', (e) => upsert(normCoach(e.payload))),
      listen('comms-job-progress', (e) => upsert(normComms(e.payload))),
      listen('comms-job-done', (e) => upsert(normComms(e.payload))),
      listen('library-import-progress', (e) => { if (e.payload?.id) upsert(normImport(e.payload)); }),
      listen('library-import-done', () => {
        invoke('library_import_status').then((js) => upsertMany((js || []).map(normImport))).catch(() => {});
      }),
      // build-phase carries a phase, not the snapshot — re-read the cell.
      listen('build-phase', () => { invoke('build_app_status').then((s) => upsert(normBuild(s))).catch(() => {}); }),
      listen('build-done', () => { invoke('build_app_status').then((s) => upsert(normBuild(s))).catch(() => {}); }),
      listen('capture-state', (e) => {
        const p = e.payload;
        if (p && typeof p.state === 'string' && ('recording' in p || 'config' in p)) {
          syncGroup(['capture-record', 'capture-replay'], normCapture(p));
        }
      }),
      listen('broadcast-state', (e) => {
        const p = e.payload;
        if (p && typeof p.state === 'string' && ('recording' in p || 'scenes' in p)) {
          syncGroup(['broadcast-record', 'broadcast-stream'], normBroadcast(p));
        }
      }),
      // Voice: the engine relays dictation globally but carries no ratio, so the
      // row is deliberately indeterminate. File transcription has no global
      // event at all — those call sites use lane B.
      listen('stt-dictation-started', () => upsert(row({
        id: 'stt-dictation', kind: 'mic', title: 'Dictation', subtitle: 'Voice',
        statusLine: 'Listening', active: true, canCancel: true,
      }))),
      listen('stt-final', () => upsert(row({
        id: 'stt-dictation', kind: 'mic', title: 'Dictation', subtitle: 'Voice',
        statusLine: 'Finished', active: false,
      }))),
      listen('stt-error', (e) => upsert(row({
        id: 'stt-dictation', kind: 'mic', title: 'Dictation', subtitle: 'Voice',
        statusLine: e.payload?.message || 'Failed', active: false, error: e.payload?.message || 'Failed',
      }))),
    ];
    return () => subs.forEach((p) => p.then((f) => f()).catch(() => {}));
  }, [upsert, upsertMany, syncGroup]);

  // Lane B — JS-registered jobs.
  useEffect(() => {
    const onProcess = (e) => {
      const d = e.detail || {};
      if (!d.id) return;
      setById((prev) => {
        const was = prev[d.id];
        if (d.op === 'end') {
          return { ...prev, [d.id]: { ...(was || row({ id: d.id, kind: d.kind, title: d.title || d.id })), ...d, active: false, canCancel: false, finishedAt: Date.now() } };
        }
        const base = was || row({ id: d.id, kind: d.kind || 'notes', title: d.title || d.id });
        return { ...prev, [d.id]: { ...base, ...d, active: true, finishedAt: null } };
      });
    };
    window.addEventListener('agentic:process', onProcess);
    return () => window.removeEventListener('agentic:process', onProcess);
  }, []);

  // Skill runs are Channel-based with no global event, so they are the one lane
  // that has to be asked. Polled ONLY while the window is open.
  useEffect(() => {
    if (!windowOpen) return undefined;
    let alive = true;
    const poll = () => {
      invoke('skills_list_runs').then((res) => {
        if (!alive) return;
        const rows = (res?.runs || []).map(normSkillRun);
        syncGroup(rows.map((r) => r.id), rows);
      }).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [windowOpen, syncGroup]);

  // CPU + memory, 1 Hz, ONLY while the window is open. Each row carries the
  // pid of the helper program its engine spawned; Windows is asked about those
  // pids and nothing else. A closed window samples nothing at all.
  useEffect(() => {
    if (!windowOpen) return undefined;
    let alive = true;
    const tick = () => {
      const pids = [];
      Object.values(byIdRef.current).forEach((r) => {
        if (r.active) r.pids.forEach((p) => { if (p && !pids.includes(p)) pids.push(p); });
      });
      if (!pids.length) { if (alive) setStats({}); return; }
      invoke('process_stats', { pids }).then((list) => {
        if (!alive) return;
        const next = {};
        (list || []).forEach((s) => { next[s.pid] = s; });
        setStats(next);
      }).catch(() => {});
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); setStats({}); };
  }, [windowOpen]);

  const { active, recent, activeCount } = useMemo(() => {
    const withStats = (r) => {
      if (!r.active || !r.pids.length) return r;
      let cpu = null;
      let rss = null;
      r.pids.forEach((p) => {
        const s = stats[p];
        if (!s) return;
        if (s.cpuPct != null) cpu = (cpu || 0) + s.cpuPct;
        if (s.rssBytes != null) rss = (rss || 0) + s.rssBytes;
      });
      return { ...r, cpuPct: cpu, rssBytes: rss };
    };
    const rows = Object.values(byId).map(withStats);
    const act = rows.filter((r) => r.active).sort((a, b) => (b.startedMs || 0) - (a.startedMs || 0));
    const rec = rows.filter((r) => !r.active)
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
      .slice(0, RECENT_CAP);
    return { active: act, recent: rec, activeCount: act.length };
  }, [byId, stats]);

  const cancel = useCallback((r) => { cancelRow(r).catch(() => {}); }, []);

  const value = useMemo(
    () => ({ active, recent, activeCount, cancel, setWindowOpen }),
    [active, recent, activeCount, cancel],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
