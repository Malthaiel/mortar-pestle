// scrimShared — the machinery OverviewPage + MatchPage share (GameWiki
// Unification Phase 4, extracted from the retired monolithic ScrimViewer).
// Dumb field/notes/roster components, the per-file save loop (useDocSave), the
// in-app recording hook, the team voiceprint store, the disk-based comms-job
// finishers, and the cross-scrim team-progress walk. Everything here is scoped
// to ONE scrim folder (`…/Scrim/<base>/`) and the v2 per-file schema
// (Overview.md + Matches/Match <n>.md).

import { useCallback, useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { api, invoke } from '@host/api.js';
import useBroadcastState from '@modules/studio/broadcast/useBroadcastState.js';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { candyGap } from '@host/util/candy.js';
import { IconPlus, IconMic } from '@host/components/icons.jsx';
import {
  parseOverview, serializeOverview, parseMatchFile, serializeMatchFile, ensureNotes,
} from './scrimSchema.js';
import { sidecarPath, scrimSidecarPath, clock, extractSpatial } from './matchData.js';
import { parseTimedNote, formatTimedBullet, sortByTimeAsc, secFromClock } from './noteCompile.js';
import { parseCommsSidecar, parseSegments, buildCommsSidecar, renderCommsSummary } from './commsCompile.js';
import { alignDiarization, mergeTranscripts, labelForCluster, speakerColor } from './diarize.js';
import { matchClusters, parseVoiceprints, DEFAULT_THRESHOLD } from './voiceprints.js';
import { auditSilentDeaths } from './deathAudit.js';
import {
  matchMetrics, sumMatchMetrics, aggregateTeam, renderTeamPage,
  teamSidecarPath, teamPagePath, normIssue,
} from './teamProgress.js';
import { summarize } from './teamfightComms.js';
import { sideFromTeamFields } from './autoClassify.js';
import { useStopwatch, readStopwatch } from './useStopwatch.js';
import RetagButton from './RetagButton.jsx';
import { classColor } from './classColors.js';
import { SCRIM_BASE } from './GameWikiTree.jsx';

// Stable api shim for useBroadcastState (game-wiki has no api.invoke — bare
// `invoke` is the module contract); module-scoped so the hook's deps never churn.
const BCAST_API = { invoke };

const SAVE_DEBOUNCE_MS = 700;
// The comms-transcription model (Deadlock Scrim Coaching SF1 gate, 2026-06-17): the
// cached large-v3-turbo — best coherence on player names + in-game announcer callouts
// for coaching review (~0.04 RTF on Vulkan; deviates from the spec's base.en default).
export const STT_MODEL = 'large-v3-turbo-q5_0';
export const MP4_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm'] }];
export const IMG_FILTERS = [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }];
export const NOTES_FILTERS = [{ name: 'Notes', extensions: ['md', 'txt'] }];

// Per-team voiceprint store (SF6, Comms Diarization): Deadlock/Coaching/Teams/<Team>/.voiceprints.json
// — the coached team's roster + saved voiceprints, reused across that team's scrims. The
// Teams/<Team>/ subdir is created on first write (vault_write_file → atomic_write mkdir-parents).
export const TEAMS_BASE = 'Deadlock/Coaching/Teams';
export const teamStorePath = (team) => `${TEAMS_BASE}/${String(team || '').trim()}/.voiceprints.json`;

export async function readTeamStore(team) {
  if (!String(team || '').trim()) return { roster: [], prints: {} };
  try { const r = await api.getRawFileMeta(teamStorePath(team), 'gamewiki'); return parseVoiceprints(r.content); }
  catch { return { roster: [], prints: {} }; }
}
export async function writeTeamStore(team, store) {
  if (!String(team || '').trim()) return;
  await api.savePage(teamStorePath(team), JSON.stringify({ roster: store.roster || [], prints: store.prints || {} }), null, 'gamewiki');
}

// localStorage: global track defaults (0-based OBS track indices) + your mic-track name. Remembered
// across scrims; the track indices are overridable per scrim via the Comms/Mic Track frontmatter.
const LS_TRACKS = 'gw-coach-tracks';   // { comms, mic }
const LS_YOUNAME = 'gw-coach-name';    // string
export const LS_YOUNAME_KEY = LS_YOUNAME;

export function loadTrackDefaults() {
  try { const j = JSON.parse(localStorage.getItem(LS_TRACKS) || '{}'); return { comms: j.comms ?? '', mic: j.mic ?? '' }; }
  catch { return { comms: '', mic: '' }; }
}
export function saveTrackDefault(key, val) {
  const d = loadTrackDefaults(); d[key] = val;
  try { localStorage.setItem(LS_TRACKS, JSON.stringify(d)); } catch { /* private mode */ }
}
export const loadYourName = () => { try { return localStorage.getItem(LS_YOUNAME) || ''; } catch { return ''; } };

// A track field ("" / non-numeric / negative → null = "not set"); a set value routes -map 0:a:<n>.
export function trackIndex(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Native file-open dialog → absolute path string (or null if cancelled). The path
// is stored verbatim in the .md (never copied — multi-GB recordings stay in place).
export async function pickFile(filters) {
  const picked = await openDialog({ directory: false, multiple: false, filters });
  return typeof picked === 'string' ? picked : (picked?.path || null);
}

// App-wide toast — the shared NotificationProvider listens for `agentic:notify`
// and styles by accent/iconKey (red "!" for errors, mirroring the app's own toasts).
export function notify(type, title, message) {
  const err = type === 'error';
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: {
      type: err ? 'deadlock-error' : 'deadlock-info', title, message,
      accent: err ? 'var(--error)' : 'var(--accent)', iconKey: err ? 'alert' : 'bell',
      duration: err ? 6000 : 3500,
    },
  }));
}

export const wrap = { flex: 1, minHeight: 0, overflowY: 'auto' };
export const inner = { maxWidth: 720, margin: '0 auto', padding: '20px 28px 64px', fontFamily: 'var(--font-mono)' };
export const card = {
  border: '1px solid color-mix(in oklch, var(--text) 12%, transparent)',
  background: 'color-mix(in oklch, var(--text) 4%, transparent)',
  borderRadius: 12, padding: '14px 16px', marginBottom: 16,
};
export const sectionTitle = { fontSize: 15, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--text)' };
export const labelStyle = { fontSize: 12, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text)', marginBottom: 8 };
export const valueStyle = { fontSize: 14, color: 'var(--text)', wordBreak: 'break-word' };
export const removeBtn = { border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px', flexShrink: 0 };

// ── Per-file doc helpers ─────────────────────────────────────────────────────

export const overviewPath = (scrimFolder) => `${scrimFolder}/Overview.md`;
export const matchPath = (scrimFolder, n) => `${scrimFolder}/Matches/Match ${n}.md`;

// Overview merge: user-edited regions (frontmatter + ## Scrim bullets) from local,
// extraBlocks from fresh when present (mirrors mergeScrim's extraBlocks rule).
export function mergeOverview(local, fresh) {
  if (!fresh) return local;
  return {
    frontmatter: local.frontmatter,
    scrim: local.scrim,
    extraBlocks: (fresh.extraBlocks && fresh.extraBlocks.length) ? fresh.extraBlocks : (local.extraBlocks || []),
  };
}

// Set (or add) an opaque `### <heading>` subsection on a parsed match.
export function setOpaque(m, heading, body) {
  const subs = m.subsections || [];
  const has = subs.some((s) => s.kind === 'opaque' && s.heading === heading);
  return {
    ...m,
    subsections: has
      ? subs.map((s) => (s.kind === 'opaque' && s.heading === heading ? { ...s, body } : s))
      : [...subs, { kind: 'opaque', heading, body }],
  };
}

export async function readOverviewFm(scrimFolder) {
  try { return parseOverview((await api.getRawFileMeta(overviewPath(scrimFolder), 'gamewiki')).content).frontmatter || {}; }
  catch { return {}; }
}

// Disk-based opaque write on a match FILE (fresh-parse + conflict retry). Safe to
// run beside a mounted MatchPage: its save loop pulls opaque sections fresh from
// disk on every merge, so this write is never clobbered.
export async function writeMatchOpaque(scrimFolder, n, heading, body) {
  const p = matchPath(scrimFolder, n);
  const doWrite = async () => {
    const r = await api.getRawFileMeta(p, 'gamewiki');
    const m = setOpaque(parseMatchFile(r.content, n), heading, body);
    await api.savePage(p, serializeMatchFile(m), r.mtime ?? null, 'gamewiki');
  };
  try { await doWrite(); } catch (e) { if (e?.code === 'CONFLICT') await doWrite(); else throw e; }
}

// Overlay dictation target (Phase 5): the last match page opened in the overlay,
// persisted so the target survives Shift+C reloads. { folder, n, coached }.
export const DICTATION_TARGET_KEY = 'overlay-dictation-target';

// Disk-based transform of a match file (fresh-parse + conflict retry) — the
// no-mounted-page write path for overlay dictation/screenshot fallbacks.
async function editMatchFile(scrimFolder, n, transform) {
  const p = matchPath(scrimFolder, n);
  const doWrite = async () => {
    const r = await api.getRawFileMeta(p, 'gamewiki');
    const m = transform(parseMatchFile(r.content, n));
    await api.savePage(p, serializeMatchFile(m), r.mtime ?? null, 'gamewiki');
  };
  try { await doWrite(); } catch (e) { if (e?.code === 'CONFLICT') await doWrite(); else throw e; }
}

// Append a dictated note to a match's coached-team notes on disk, stamped with
// the match's running stopwatch (same [m:ss] form as a typed note).
export async function appendMatchNote(scrimFolder, n, team, text) {
  const t = String(text || '').trim();
  if (!t) return;
  const sw = readStopwatch(`gw-sw:${scrimFolder}:m${n}:${team}`);
  const stamped = sw.running ? `[${clock(sw.elapsedSec)}] ${t}` : t;
  await editMatchFile(scrimFolder, n, (m) => {
    const w = ensureNotes(m, team);
    return { ...w, subsections: w.subsections.map((s) => (s.kind === 'notes' && s.team === team ? { ...s, bullets: [...(s.bullets || []), stamped] } : s)) };
  });
}

// Fill a match field on disk only when it's still empty (screenshot auto-file).
export async function setMatchFieldIfEmpty(scrimFolder, n, field, value) {
  if (!value) return;
  const r = await api.getRawFileMeta(matchPath(scrimFolder, n), 'gamewiki');
  if (String(parseMatchFile(r.content, n).fields?.[field] || '').trim()) return;
  await editMatchFile(scrimFolder, n, (m) => (
    String(m.fields?.[field] || '').trim() ? m : { ...m, fields: { ...m.fields, [field]: value } }
  ));
}

// Disk-based ## Scrim bullet update on Overview.md (fresh-parse + conflict retry).
export async function setOverviewScrimFields(scrimFolder, fields) {
  const p = overviewPath(scrimFolder);
  const doWrite = async () => {
    const r = await api.getRawFileMeta(p, 'gamewiki');
    const o = parseOverview(r.content);
    await api.savePage(p, serializeOverview({ ...o, scrim: { ...o.scrim, ...fields } }), r.mtime ?? null, 'gamewiki');
  };
  try { await doWrite(); } catch (e) { if (e?.code === 'CONFLICT') await doWrite(); else throw e; }
}

// ── The per-file save loop (the old ScrimViewer writeback, parameterized) ────
// read fresh (opaque truth + fresh mtime) → merge local edits → serialize →
// savePage with the just-read mtime; conflict retries once; overlapping saves
// serialize. `parse`/`serialize`/`merge` come from the page (Overview or Match).
export function useDocSave({ path, parse, serialize, merge }) {
  const [doc, setDocState] = useState(null);
  const [err, setErr] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const docRef = useRef(null);
  const lastSavedRef = useRef(null);
  const saveTimer = useRef(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const doSave = useCallback(async () => {
    const local = docRef.current;
    if (!local) return;
    if (savingRef.current) { pendingRef.current = true; return; }
    savingRef.current = true;
    if (mountedRef.current) setSaveState('saving');
    const setSafe = (s) => { if (mountedRef.current) setSaveState(s); };
    try {
      let fresh = local, freshMtime = null;
      try { const r = await api.getRawFileMeta(path, 'gamewiki'); fresh = parse(r.content); freshMtime = r.mtime ?? null; }
      catch { /* file missing/new — write local as-is */ }
      const content = serialize(merge(local, fresh));
      if (content === lastSavedRef.current) { setSafe('saved'); }
      else {
        try {
          await api.savePage(path, content, freshMtime, 'gamewiki');
          lastSavedRef.current = content;
          setSafe('saved');
        } catch (e) {
          if (e?.code === 'CONFLICT') {
            const r2 = await api.getRawFileMeta(path, 'gamewiki');
            const content2 = serialize(merge(docRef.current, parse(r2.content)));
            await api.savePage(path, content2, r2.mtime ?? null, 'gamewiki');
            lastSavedRef.current = content2;
            setSafe('saved');
          } else { console.error('scrim save failed', e); setSafe('error'); }
        }
      }
    } finally {
      savingRef.current = false;
      if (pendingRef.current) { pendingRef.current = false; doSave(); }
    }
  }, [path, parse, serialize, merge]);

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => doSave(), SAVE_DEBOUNCE_MS);
  }, [doSave]);
  const flushSave = useCallback(() => { clearTimeout(saveTimer.current); doSave(); }, [doSave]);
  const applyEdit = useCallback((mutator) => {
    const next = mutator(docRef.current);
    docRef.current = next;
    setDocState(next);
    scheduleSave();
  }, [scheduleSave]);
  // Await-able "make the on-disk file current" for pipeline steps that merge from disk.
  const flushIfDirty = useCallback(async () => {
    clearTimeout(saveTimer.current);
    if (docRef.current && serialize(docRef.current) !== lastSavedRef.current) await doSave();
  }, [doSave, serialize]);
  // Adopt an externally merged+saved doc (pipeline writes that bypass the debounce).
  const adopt = useCallback((mergedDoc, content) => {
    docRef.current = mergedDoc;
    lastSavedRef.current = content;
    if (mountedRef.current) setDocState(mergedDoc);
  }, []);
  // Disk-owned write: fresh-parse → merge local → transform → save (retry once) → adopt.
  const writeMerged = useCallback(async (transform) => {
    const doWrite = async () => {
      const r = await api.getRawFileMeta(path, 'gamewiki').catch(() => null);
      const fresh = r ? parse(r.content) : docRef.current;
      const merged = transform(merge(docRef.current, fresh));
      const content = serialize(merged);
      await api.savePage(path, content, r?.mtime ?? null, 'gamewiki');
      adopt(merged, content);
    };
    try { await doWrite(); } catch (e) { if (e?.code === 'CONFLICT') await doWrite(); else throw e; }
  }, [path, parse, serialize, merge, adopt]);
  const reload = useCallback(async () => {
    const r = await api.getRawFileMeta(path, 'gamewiki');
    const p = parse(r.content);
    adopt(p, serialize(p));
  }, [path, parse, serialize, adopt]);

  // Load on path change; flush a pending edit for the outgoing path before switching.
  useEffect(() => {
    let cancelled = false;
    setDocState(null); setErr(null); setSaveState('idle');
    docRef.current = null; lastSavedRef.current = null;
    api.getRawFileMeta(path, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        const parsed = parse(r.content);
        docRef.current = parsed;
        lastSavedRef.current = serialize(parsed);
        setDocState(parsed);
      })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e)); });
    return () => {
      cancelled = true;
      clearTimeout(saveTimer.current);
      if (docRef.current && serialize(docRef.current) !== lastSavedRef.current) doSave();
    };
  }, [path, parse, serialize, doSave]);

  return { doc, err, saveState, docRef, applyEdit, scheduleSave, flushSave, flushIfDirty, adopt, writeMerged, reload };
}

// ── Engine probes ────────────────────────────────────────────────────────────

// STT engine reachability — probes on mount + every supervisor status change.
export function useSttUp() {
  const [sttUp, setSttUp] = useState(true);
  useEffect(() => {
    let dead = false;
    const probe = () => invoke('stt_status')
      .then((s) => { if (!dead) setSttUp(s != null); })
      .catch(() => { if (!dead) setSttUp(false); });
    probe();
    const sub = listen('stt-engine-status', probe);
    return () => { dead = true; sub.then((un) => un()).catch(() => {}); };
  }, []);
  return [sttUp, setSttUp];
}

// AI backend availability — Anthropic key or resolvable `claude` CLI.
export function useAiConfigured(settings) {
  const [aiConfigured, setAiConfigured] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hasKey = await invoke('design_get_api_key').catch(() => false);
      if (hasKey) { if (!cancelled) setAiConfigured(true); return; }
      const cli = await invoke('design_cli_auth_status', { cliPath: settings?.agents?.claudeCliPath || '' }).catch(() => null);
      // Only flip to unavailable on a concrete answer; an errored check stays optimistic.
      if (!cancelled && cli) setAiConfigured(!!cli.installed);
    })();
    return () => { cancelled = true; };
  }, [settings?.agents?.claudeCliPath]);
  return aiConfigured;
}

// Resolve the AI backend args (honor settings.agents; fall back to key-detect).
export async function resolveAgents(settings) {
  const ag = settings?.agents || {};
  let backend = ag.authBackend;
  if (!backend) backend = (await invoke('design_get_api_key').catch(() => false)) ? 'api-key' : 'claude-cli';
  return { authBackend: backend, model: ag.model || 'opus', claudeCliPath: ag.claudeCliPath || '' };
}

// ── In-app scrim recording (broadcast engine, multi-track) ──────────────────
// start_record's {dir, stem} land the file in Videos\…\Scrims\<base>\; stop
// returns {path} → onFiled(target, path) lets the page fill its field. One
// recording at a time (engine-enforced busy).
export function useScrimRecord({ base, onFiled }) {
  const bcast = useBroadcastState(BCAST_API);
  const [recTarget, setRecTarget] = useState(null); // 'vod' | 'match:<n>'
  const recActive = !!bcast.snapshot?.recording?.active;
  useEffect(() => { if (!recActive) setRecTarget(null); }, [recActive]);
  const bReq = (op, args) => invoke('broadcast_request', { op, args });
  // Dedicated scenes, created on first use: matches film the game (game_capture),
  // VOD reviews film the whole screen (monitor_capture — engine defaults the id).
  const ensureScrimScene = async (kind) => {
    const cfg = kind === 'screen'
      ? { name: 'Scrim — Screen', id: 'monitor_capture', src: 'Screen' }
      : { name: 'Scrim — Game', id: 'game_capture', src: 'Game' };
    const snap = await bReq('get_state');
    if (!(snap?.scenes || []).some((s) => s.name === cfg.name)) {
      await bReq('create_scene', { name: cfg.name });
      await bReq('create_source', { scene: cfg.name, id: cfg.id, name: cfg.src });
    }
    if (snap?.current_scene !== cfg.name) await bReq('set_current_scene', { name: cfg.name });
  };
  const start = async (target) => { // {kind:'match', n} | {kind:'vod'}
    try {
      const dir = await invoke('coaching_scrim_dir', { base });
      await ensureScrimScene(target.kind === 'vod' ? 'screen' : 'game');
      const stem = target.kind === 'vod' ? `${base} — VOD Review` : `${base} — Match ${target.n}`;
      await bReq('start_record', { dir, stem });
      setRecTarget(target.kind === 'vod' ? 'vod' : `match:${target.n}`);
    } catch (e) {
      notify('error', 'Record failed', e?.message || String(e));
    }
  };
  const stop = async () => {
    const target = recTarget;
    try {
      const r = await bReq('stop_record');
      if (r?.path && target) onFiled(target, r.path);
    } catch (e) {
      notify('error', 'Stop failed', e?.message || String(e));
    } finally { setRecTarget(null); }
  };
  const busyElsewhere = (id) => recActive && recTarget !== id;
  return { recTarget, start, stop, busyElsewhere, alive: bcast.alive };
}

// ── Comms-job finishers (disk-based — independent of any mounted page) ───────

// Post-process + persist a finished MATCH comms job: cluster-match against the
// coached team's voiceprints, align comms text, merge mic ∪ comms by time → the
// object .commstranscript sidecar + the opaque ### Comms Transcript in the match
// file. `diarization: null` ⇒ legacy single-downmix (speaker-null transcript).
export async function finishMatchJob(scrimFolder, matchN, result, setPhase = () => {}) {
  const scPath = sidecarPath(scrimFolder, matchN, 'comms');
  let label = String(matchN);
  try { label = String(parseMatchFile((await api.getRawFileMeta(matchPath(scrimFolder, matchN), 'gamewiki')).content, matchN).fields['Match ID'] || matchN); } catch { /* label falls back to n */ }
  const finishOpaque = async (segs, payload) => {
    setPhase('Saving');
    await api.savePage(scPath, JSON.stringify(payload), null, 'gamewiki');
    const durationS = segs.length ? Math.max(...segs.map((s) => Number(s.t1Ms) || 0)) / 1000 : 0;
    const body = renderCommsSummary({ n: matchN, segments: segs, durationS, sidecarFileName: scPath.split('/').pop() });
    await writeMatchOpaque(scrimFolder, matchN, 'Comms Transcript', body);
  };
  const micNote = result.micSkipped ? ' · mic silent, skipped' : '';
  if (!result.diarization) {
    const raw = result.commsSegments || [];
    const segs = raw.length ? raw : (result.commsFinalText ? [{ t0Ms: 0, t1Ms: 0, text: result.commsFinalText }] : []);
    await finishOpaque(segs, segs.map((seg) => ({ ...seg, speaker: null, cluster: null })));
    notify('success', 'Comms extracted', `Match ${label} — ${segs.length} segment${segs.length === 1 ? '' : 's'} transcribed.`);
    return;
  }
  const fm = await readOverviewFm(scrimFolder);
  const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
  const store = await readTeamStore(coachedTeam);
  const nameMap = matchClusters(result.diarization.clusters || [], store.prints || {}, DEFAULT_THRESHOLD);
  const aligned = alignDiarization(result.commsSegments || [], result.diarization.segments || []);
  const yourName = loadYourName() || 'You';
  const merged = mergeTranscripts({ micSegments: result.micSegments || [], commsSegments: aligned, micSpeaker: yourName, nameMap });
  await finishOpaque(merged, buildCommsSidecar({ segments: merged, clusters: result.diarization.clusters || [], micSpeaker: yourName }));
  const voices = result.diarization.numSpeakers ?? (result.diarization.clusters || []).length;
  const named = Object.values(nameMap).filter(Boolean).length;
  notify('success', 'Comms extracted', `Match ${label} — ${merged.length} segments · ${voices} voice${voices === 1 ? '' : 's'}${named ? ` · ${named} auto-named` : ''}${micNote}.`);
}

// Post-process + persist a finished VOD comms job: one .vodcomms sidecar for the
// whole scrim + the `- VOD Comms:` pointer bullet in Overview.md.
export async function finishVodJob(scrimFolder, result, setPhase = () => {}) {
  const fm = await readOverviewFm(scrimFolder);
  const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
  const store = await readTeamStore(coachedTeam);
  const nameMap = matchClusters(result.diarization?.clusters || [], store.prints || {}, DEFAULT_THRESHOLD);
  const aligned = alignDiarization(result.commsSegments || [], result.diarization?.segments || []);
  const coachName = loadYourName() || 'Coach';
  const merged = mergeTranscripts({ micSegments: result.micSegments || [], commsSegments: aligned, micSpeaker: coachName, nameMap });
  setPhase('Saving');
  await api.savePage(scrimSidecarPath(scrimFolder, 'vodcomms'), JSON.stringify(buildCommsSidecar({ segments: merged, clusters: result.diarization?.clusters || [], micSpeaker: coachName })), null, 'gamewiki');
  const stamp = new Date().toISOString().slice(0, 10);
  await setOverviewScrimFields(scrimFolder, { 'VOD Comms': `extracted ${stamp} · ${merged.length} segments` });
  const voices = result.diarization?.numSpeakers ?? (result.diarization?.clusters || []).length;
  const named = Object.values(nameMap).filter(Boolean).length;
  notify('success', 'VOD comms extracted', `${merged.length} segments · ${voices} voice${voices === 1 ? '' : 's'}${named ? ` · ${named} auto-named` : ''}${result.micSkipped ? ' · coach mic silent, skipped' : ''}.`);
}

// Comms-job bridge (gate-blocker 2): follow + finish the Rust-owned comms job from
// ANY mount. Re-attaches on mount (a running job restores the busy UI; a
// done-unconsumed one is finished right here), and the global progress/done events
// drive live phase text + completion. comms_job_take is take-once under the Rust
// mutex, so with several pages mounted only ONE consumer post-processes.
//   filter(p) → true when this page cares (kind/matchN match); busy UI only.
//   Any job for this scrim folder is CONSUMED here regardless of filter — the
//   finishers are disk-based, so a job for an unmounted match still lands.
export function useCommsJobBridge({ scrimFolder, filter, setBusy, onFinished }) {
  useEffect(() => {
    let dead = false;
    const phaseText = (p) => `${p.phase}${p.pct != null ? ` ${Math.round(p.pct)}%` : ''}`;
    const showBusy = (p) => { if (filter(p)) setBusy({ on: true, phase: phaseText(p) }); };
    const clearBusy = (p) => { if (filter(p)) setBusy({ on: false, phase: '' }); };
    const finish = async (p) => {
      const result = await invoke('comms_job_take').catch(() => null);
      if (!result) { clearBusy(p); return; } // another mounted page consumed it
      try {
        const setPhase = (t) => { if (!dead && filter(p)) setBusy({ on: true, phase: t }); };
        if (p.kind === 'vod') await finishVodJob(scrimFolder, result, setPhase);
        else await finishMatchJob(scrimFolder, p.matchN, result, setPhase);
        if (!dead) onFinished?.(p);
      } catch (e) {
        notify('error', p.kind === 'vod' ? 'Extract VOD Comms failed' : 'Extract Comms failed', e?.message || String(e));
      } finally { clearBusy(p); }
    };
    (async () => {
      const st = await invoke('comms_job_status').catch(() => null);
      if (dead || !st || st.scrimPath !== scrimFolder) return;
      if (st.status === 'running') showBusy(st);
      else if (st.status === 'done') { showBusy(st); await finish(st); }
      else {
        // stale error/cancelled job whose done event died with the old webview
        await invoke('comms_job_clear').catch(() => {});
        if (st.status === 'error') notify('error', st.kind === 'vod' ? 'Extract VOD Comms failed' : 'Extract Comms failed', st.error || 'unknown error');
      }
    })();
    const subs = [
      listen('comms-job-progress', (e) => {
        const p = e.payload || {};
        if (p.scrimPath !== scrimFolder || p.status !== 'running') return;
        showBusy(p);
      }),
      listen('comms-job-done', (e) => {
        const p = e.payload || {};
        if (p.scrimPath !== scrimFolder) return;
        if (p.ok) { finish(p); return; }
        invoke('comms_job_clear').catch(() => {});
        clearBusy(p);
        if (p.cancelled) notify('success', p.kind === 'vod' ? 'VOD comms cancelled' : 'Comms cancelled', 'Transcription was cancelled — nothing saved.');
        else notify('error', p.kind === 'vod' ? 'Extract VOD Comms failed' : 'Extract Comms failed', p.error || 'unknown error');
      }),
    ];
    return () => { dead = true; subs.forEach((s) => s.then((un) => un())); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter/setBusy/onFinished are stable per page
  }, [scrimFolder]);
}

// ── Team Progress (sub-plan 12) — cross-scrim memory, v2 folder walk ─────────
// Walk every scrim folder for this team, read each Overview + .vodreport +
// per-match sidecars, compute team-level metrics, aggregate into the
// .teamprogress.<Team>.json sidecar, and regenerate the app-owned Teams/<Team>.md
// page (fully generated — plain overwrite is safe). Runs after each Generate
// Report / Review Comms; best-effort.
export async function updateTeamProgress(team) {
  if (!String(team || '').trim()) return null;
  try {
    const root = await api.listFolderRaw(SCRIM_BASE, 'gamewiki').catch(() => null);
    const scrims = [];
    for (const dir of root?.subfolders || []) {
      const folder = `${SCRIM_BASE}/${dir}`;
      let fm;
      try { fm = parseOverview((await api.getRawFileMeta(overviewPath(folder), 'gamewiki')).content).frontmatter || {}; } catch { continue; }
      const coached = fm['Coached Team'] || fm['Team 1'] || '';
      if (normIssue(coached) !== normIssue(team)) continue; // not this team's scrim

      let report = null;
      try { report = JSON.parse((await api.getRawFileMeta(scrimSidecarPath(folder, 'vodreport'), 'gamewiki')).content); } catch { /* no report yet */ }

      const mlist = await api.listFolderRaw(`${folder}/Matches`, 'gamewiki').catch(() => null);
      const ns = (mlist?.files || [])
        .map((f) => Number((f.match(/^Match (\d+)\.md$/) || [])[1]))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);

      const perMatch = [];
      let segTotal = 0, durTotalS = 0, silentTotal = 0, haveComms = false;
      let tfFights = 0, tfJumbled = 0, tfMissed = 0, haveTf = false;
      for (const n of ns) {
        let m;
        try { m = parseMatchFile((await api.getRawFileMeta(matchPath(folder, n), 'gamewiki')).content, n); } catch { continue; }
        const { coachedSide } = sideFromTeamFields(m.fields, coached);
        if (coachedSide == null) continue;
        let raw = null;
        try { raw = JSON.parse((await api.getRawFileMeta(sidecarPath(folder, n), 'gamewiki')).content); } catch { continue; }
        perMatch.push(matchMetrics(raw, coachedSide));
        try {
          const cm = (await api.getRawFileMeta(sidecarPath(folder, n, 'comms'), 'gamewiki')).content;
          const segs = parseSegments(cm);
          haveComms = true;
          segTotal += segs.filter((s) => String(s.text || '').trim()).length;
          durTotalS += segs.length ? Math.max(...segs.map((s) => Number(s.t1Ms) || 0)) / 1000 : 0;
          const offsetS = Number(m.fields['Comms Offset']) || 0;
          silentTotal += auditSilentDeaths(extractSpatial(raw).deaths, segs, { side: coachedSide, offsetS }).silent.length;
        } catch { /* no comms for this match */ }
        try {
          const tf = JSON.parse((await api.getRawFileMeta(sidecarPath(folder, n, 'tfcomms'), 'gamewiki')).content);
          const s = tf.summary || summarize(tf.fights || []);
          if (s.fights) { haveTf = true; tfFights += s.fights; tfJumbled += (s.jumbled || 0); tfMissed += (s.missed || 0); }
        } catch { /* no comms review for this match */ }
      }
      if (!perMatch.length && !report) continue;
      const metrics = {
        ...sumMatchMetrics(perMatch),
        calloutRate: haveComms && durTotalS > 0 ? Math.round((segTotal / (durTotalS / 60)) * 10) / 10 : null,
        silentDeaths: haveComms ? silentTotal : null,
        commsJumbled: haveTf && tfFights ? Math.round((tfJumbled / tfFights) * 100) / 100 : null,
        commsMissed: haveTf && tfFights ? Math.round((tfMissed / tfFights) * 100) / 100 : null,
      };
      scrims.push({ date: fm['Date'] || '', report, metrics });
    }
    const agg = aggregateTeam({ team, scrims });
    const stamp = new Date().toISOString().slice(0, 10);
    agg.updated = stamp;
    await api.savePage(teamSidecarPath(team), JSON.stringify(agg), null, 'gamewiki');
    await api.savePage(teamPagePath(team), renderTeamPage(agg, stamp), null, 'gamewiki');
    return agg;
  } catch (e) { console.error('team progress update failed', e); return null; }
}

// ── Shared presentational components (lifted verbatim from ScrimViewer) ──────

export function EditField({ label, value, onChange, onCommit, placeholder, right }) {
  return (
    <div style={{ marginBottom: candyGap(8, true) }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
          <input
            className="candy-face"
            value={value || ''}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onCommit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
          />
        </div>
        {right}
      </div>
    </div>
  );
}

// Track picker — EditField's shell with a CandySelect fed by the recording's REAL
// audio-track count (coaching_audio_track_count). Free-text indices produced two
// failures: out-of-range (opaque ffmpeg "Stream map '' matches no streams", now
// guarded in Rust) and wrong-but-existing (an empty wav → a silently empty
// transcript, no error at all). Only picking from the file itself kills the second.
// Labels carry both numberings — ffmpeg counts audio from 0, OBS labels from 1.
// `count` 0 = no recording set yet / probe failed.
export function TrackField({ label, value, count, onChange }) {
  const options = Array.from({ length: count }, (_, i) => ({
    value: String(i),
    label: `Track ${i} (OBS ${i + 1})`,
  }));
  return (
    <div style={{ marginBottom: candyGap(8, true) }}>
      <div style={labelStyle}>{label}</div>
      <CandySelect
        value={String(value ?? '')}
        options={options}
        onChange={onChange}
        title={label}
        placeholder={count ? 'Pick a track' : 'Set a VOD Review first'}
        disabled={!count}
      />
    </div>
  );
}

export function MiniBtn({ icon: Icon, title, onClick, active, shape = 'icon', style }) {
  return (
    <button className={`candy-btn${active ? ' is-active' : ''}`} data-shape={shape} title={title} onClick={onClick}
      style={{ width: 30, height: 30, flexShrink: 0, ...style }}>
      <span className="candy-face"><Icon size={15} /></span>
    </button>
  );
}

// Inline scoreboard — read via the coaching_read_image Rust command (returns a data:
// URL for any user-picked path, dodging the mortar-pestle-asset:// allowlist). For the
// user's eyes only; the pipeline never reads it.
export function Scoreboard({ path }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null); setFailed(false);
    if (!path) return undefined;
    invoke('coaching_read_image', { path })
      .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [path]);
  if (!path) return null;
  if (failed) return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Couldn’t load screenshot (moved or unreadable).</div>;
  if (!src) return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Loading screenshot</div>;
  return <img src={src} alt="Scoreboard" style={{ maxWidth: '100%', borderRadius: 8, marginTop: 8, display: 'block', border: '1px solid color-mix(in oklch, var(--text) 12%, transparent)' }} />;
}

// Count-up game clock (sub-plan 5; press-the-clock redesign, user pick 2026-07-15):
// the clock chip IS the whole timer control — tap toggles Start/Pause, hold ~600ms
// resets. Running: the digits breathe (inline `breath` animation on an inner span,
// NOT .candy-face — the candy press animates the face's transform).
export function TimerControls({ sw }) {
  const holdT = useRef(null);
  const held = useRef(false);
  const startHold = () => { held.current = false; holdT.current = setTimeout(() => { held.current = true; sw.reset(); }, 600); };
  const cancelHold = () => { clearTimeout(holdT.current); held.current = false; };
  return (
    <button className="candy-btn" data-shape="chip"
      onPointerDown={startHold}
      onPointerUp={() => clearTimeout(holdT.current)}
      onPointerLeave={cancelHold} onPointerCancel={cancelHold}
      onClick={() => { if (held.current) { held.current = false; return; } sw.toggle(); }}
      title={sw.running ? 'Tap to pause. Hold to reset.' : 'Tap to start. Hold to reset.'}
      style={{ minWidth: 64 }}>
      <span className="candy-face" style={{ fontVariantNumeric: 'tabular-nums', ...(sw.running ? null : { color: 'var(--text-muted)' }) }}>
        <span style={sw.running ? { display: 'inline-block', animation: 'breath 4s ease-in-out infinite' } : undefined}>{clock(sw.elapsedSec)}</span>
      </span>
    </button>
  );
}

// Per-team notes — the canonical, timestamped, classified list (sub-plan 5). Rows
// render time-ascending (untimed last) but edits map back to the ORIGINAL index.
// When the timer runs, a new note via ENTER is stamped with the elapsed time.
export function NotesEditor({ bullets, onChange, onCommit, storageKey, overlay, dictating, onDictate }) {
  const [draft, setDraft] = useState('');
  const sw = useStopwatch(storageKey);
  // Overlay: bounded scroll window (~3 rows) pinned to the newest note, so 20+ notes
  // never grow the panel — the add-field below stays on screen.
  const listRef = useRef(null);
  useEffect(() => { if (overlay && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [overlay, bullets.length]);
  // Bottom composer bar (user pick 2026-07-15, iteration 2): the note field hides
  // behind the + button — press + to reveal it below the bar, Enter commits, Escape
  // or + again hides it.
  const [composeOpen, setComposeOpen] = useState(false);
  const addBullet = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...bullets, sw.running ? `[${clock(sw.elapsedRef.current)}] ${t}` : t]);
    setDraft(''); onCommit();
  };
  const setAt = (i, nb) => onChange(bullets.map((x, j) => (j === i ? nb : x)));
  const onText = (row, raw) => {
    const m = /^\[(\d{1,2}):([0-5]\d)\]\s*/.exec(raw);
    const atSec = m ? Number(m[1]) * 60 + Number(m[2]) : null;
    setAt(row._i, formatTimedBullet({ atSec, classification: row.classification, text: m ? raw.slice(m[0].length) : raw }));
  };
  const onRetag = (row, c) => setAt(row._i, formatTimedBullet({ atSec: row.atSec, classification: c, text: row.text }));
  const { ordered, untimedCount } = sortByTimeAsc(bullets.map((b, i) => ({ ...parseTimedNote(b), _i: i })), (x) => x.atSec);
  const firstUntimed = ordered.length - untimedCount;
  const bar = overlay && onDictate;
  return (
    <div style={{ marginTop: overlay ? 0 : 8, marginBottom: overlay ? 'var(--cbtn-depth)' : candyGap(8, true) }}>
      <div ref={listRef} data-spacing-intent="notes list hugs the control bar (legacy 2px, pre-grid)" style={overlay ? { maxHeight: 165, overflowY: 'auto', minHeight: 0 } : undefined}>
      {ordered.map((row, k) => (
        <div key={row._i}>
          {untimedCount > 0 && firstUntimed > 0 && k === firstUntimed && (
            <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '6px 0 2px' }}>Untimed</div>
          )}
          <div className="candy-center-row" style={{ gap: 6, marginBottom: candyGap(4, true) }}>
            <RetagButton label={row.classification} onPick={(c) => onRetag(row, c)} allowClear />
            <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
              <input
                className="candy-face"
                value={formatTimedBullet({ atSec: row.atSec, classification: null, text: row.text })}
                placeholder="note"
                onChange={(e) => onText(row, e.target.value)}
                onBlur={onCommit}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
              />
            </div>
            <button onClick={() => { onChange(bullets.filter((_, j) => j !== row._i)); onCommit(); }} title="Remove note" style={removeBtn}>×</button>
          </div>
        </div>
      ))}
      </div>
      {/* Bottom control bar (user pick 2026-07-15, iteration 3): a centered
          [+][mic] cluster below the notes. + toggles the note field; mic dictates. */}
      {bar && (
        <div className="candy-center-row" style={{ justifyContent: 'center', gap: 8, marginTop: 2 }}>
          <MiniBtn shape="circle" style={{ '--cbtn-depth': 'var(--candy-depth)' }} icon={IconPlus} title={composeOpen ? 'Hide the note field' : 'Add a note'} onClick={() => setComposeOpen((v) => !v)} active={composeOpen} />
          {onDictate && (
            <MiniBtn shape="circle" style={{ '--cbtn-depth': 'var(--candy-depth)' }} icon={IconMic} title={dictating ? 'Stop dictating' : 'Dictate a note — speech-to-text appended to this match'} onClick={onDictate} active={dictating} />
          )}
        </div>
      )}
      {(!bar || composeOpen) && (
        <div className="candy-btn" data-shape="field" style={{ width: '100%', marginTop: bar ? candyGap(8, true) : 2 }}>
          <input
            className="candy-face"
            autoFocus={!!bar}
            value={draft}
            placeholder={sw.running ? `Add a note  (stamped @ ${clock(sw.elapsedSec)})` : 'Add a note'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addBullet(); }
              if (e.key === 'Escape') setComposeOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

// Collapsed-by-default per-team notes: a "Create Notes" button until opened — or
// auto-opened once the team already has notes.
export function TeamNotes({ team, bullets, onChange, onCommit, storageKey, overlay, dictating, onDictate }) {
  const [opened, setOpened] = useState(false);
  if (!opened && bullets.length === 0) {
    return (
      <button className="candy-btn" data-shape="row" onClick={() => setOpened(true)} style={{ width: '100%', marginTop: 8, marginBottom: candyGap(8) }}>
        <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconPlus size={14} /> Create Notes{team ? ` · ${team}` : ''}</span>
      </button>
    );
  }
  return <NotesEditor bullets={bullets} onChange={onChange} onCommit={onCommit} storageKey={storageKey} overlay={overlay} dictating={dictating} onDictate={onDictate} />;
}

export function SaveTag({ state }) {
  const map = { saving: ['Saving', 'var(--text-muted)'], error: ['Save failed — edit to retry', 'var(--error)'] };
  const m = map[state];
  if (!m) return null;
  return <span style={{ fontSize: 11, color: m[1] }}>{m[0]}</span>;
}

// Renders the persisted ### Coaching Summary body — a snapshot of the last Run
// Process; the _(…)_ marker line is hidden.
export function CoachingSummaryView({ body }) {
  const items = [];
  let header = null;
  for (const raw of String(body || '').split('\n')) {
    const t = raw.trim();
    if (!t || /^_\(.*\)_$/.test(t)) continue;
    if (t.startsWith('#### ')) items.push({ type: 'group', text: t.slice(5) });
    else if (t.startsWith('- ')) items.push({ type: 'note', text: t.slice(2) });
    else if (!header) header = t;
  }
  if (!header && !items.length) return null;
  return (
    <div style={{ marginTop: 2 }}>
      {header && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>{header}</div>}
      {items.map((it, i) => (it.type === 'group'
        ? <div key={i} style={{ ...labelStyle, color: it.text === 'Unclassified' ? 'var(--text-muted)' : 'var(--accent)', marginTop: 8, marginBottom: 3 }}>{it.text}</div>
        : <div key={i} style={{ ...valueStyle, fontSize: 13, display: 'flex', gap: 6, marginBottom: 2 }}><span style={{ color: 'var(--text-muted)' }}>•</span><span>{it.text}</span></div>))}
    </div>
  );
}

// Read-only AI provenance for one team from the .autoclass sidecar — collapsed
// history: what the AI suggested + your final review state, time-ascending.
export function AutoClassificationView({ sidecarPath: scPath, team }) {
  const [sugg, setSugg] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getRawFileMeta(scPath, 'gamewiki')
      .then((r) => { if (!cancelled) { const j = JSON.parse(r.content || '{}'); setSugg(j.teams?.[team]?.suggestions || []); } })
      .catch(() => { if (!cancelled) setSugg([]); });
    return () => { cancelled = true; };
  }, [scPath, team]);
  if (sugg == null) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading</div>;
  if (!sugg.length) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No AI provenance yet.</div>;
  const { ordered, untimedCount } = sortByTimeAsc(sugg, (s) => secFromClock(s.at));
  const firstUntimed = ordered.length - untimedCount;
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: 0, fontFamily: 'var(--font-mono)' }}>
        {open ? '▾' : '▸'} AI provenance ({sugg.length})
      </button>
      {open && ordered.map((s, k) => {
        const dropped = s.review === 'rejected' || s.dropped;
        const label = s.userLabel || s.classification;
        return (
          <div key={s.momentId}>
            {untimedCount > 0 && firstUntimed > 0 && k === firstUntimed && (
              <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '4px 0 2px' }}>Untimed</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 6, opacity: dropped ? 0.4 : 0.85 }}>
              <span style={{ ...labelStyle, marginBottom: 0, color: classColor(label), minWidth: 76, textDecoration: dropped ? 'line-through' : 'none' }}>{label || '—'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {s.at || 'untimed'}{s.subject ? ` · ${s.subject}` : ''}{s.source ? ` · ${s.source}` : ''}{s.review && s.review !== 'pending' ? ` · ${s.review}` : ''}
                </div>
                <div style={{ ...valueStyle, fontSize: 13 }}>{s.rationale}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Silent-Death Audit (sub-plan 10) — coached-team deaths with no comms segment in
// the ~10 s before them. Pure cross-ref of the two sidecars, no AI.
export function SilentDeathAudit({ matchSidecar, commsSidecar, side, offsetS }) {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    Promise.all([
      api.getRawFileMeta(matchSidecar, 'gamewiki'),
      api.getRawFileMeta(commsSidecar, 'gamewiki'),
    ]).then(([md, cm]) => {
      if (cancelled) return;
      let raw;
      try { raw = JSON.parse(md.content); } catch { setState({ status: 'error' }); return; }
      const audit = auditSilentDeaths(extractSpatial(raw).deaths, parseSegments(cm.content), { side, offsetS });
      setState({ status: 'ready', audit });
    }).catch(() => { if (!cancelled) setState({ status: 'missing' }); });
    return () => { cancelled = true; };
  }, [matchSidecar, commsSidecar, side, offsetS]);

  const { status, audit } = state;
  if (status === 'loading') return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Checking callouts</div>;
  if (status === 'missing') return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Needs both match data and a comms transcript.</div>;
  if (status === 'error') return <div style={{ fontSize: 12, color: 'var(--error)' }}>Couldn’t parse the stored match data.</div>;
  if (!audit.total) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No coached-team deaths recorded.</div>;
  if (!audit.silent.length) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>All {audit.total} deaths had comms nearby.</div>;
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
        {audit.silent.length} of {audit.total} deaths had no comms in the 10 s before them:
      </div>
      {audit.silent.map((d, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 2, fontSize: 12.5 }}>
          <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{clock(d.t)}</span>
          <span style={{ color: 'var(--text)' }}>{d.hero}</span>
        </div>
      ))}
    </div>
  );
}

// Per-team roster editor (SF6 Comms Diarization) — the coached team's player names,
// stored in the team's voiceprint store + reused across that team's scrims.
export function RosterEditor({ team, onSaved }) {
  const [roster, setRoster] = useState(null); // null = loading
  const [draft, setDraft] = useState('');
  const storeRef = useRef({ roster: [], prints: {} });
  useEffect(() => {
    let cancelled = false;
    setRoster(null); setDraft('');
    if (!String(team || '').trim()) { setRoster([]); return undefined; }
    readTeamStore(team).then((s) => { if (!cancelled) { storeRef.current = s; setRoster(s.roster || []); } })
      .catch(() => { if (!cancelled) setRoster([]); });
    return () => { cancelled = true; };
  }, [team]);
  const update = (names) => { storeRef.current = { ...storeRef.current, roster: names }; setRoster(names); };
  const commit = () => { writeTeamStore(team, storeRef.current).then(() => onSaved?.(storeRef.current.roster)).catch(() => {}); };
  if (!String(team || '').trim()) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Set a Coached Team (below) to build its roster.</div>;
  if (roster == null) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading roster</div>;
  const addName = () => { const t = draft.trim(); setDraft(''); if (!t || roster.includes(t)) return; update([...roster, t]); commit(); };
  return (
    <div style={{ marginBottom: candyGap(8, true) }}>
      <div style={labelStyle}>Roster{team ? ` · ${team}` : ''}</div>
      {roster.map((n, i) => (
        <div key={i} className="candy-center-row" style={{ gap: 6, marginBottom: candyGap(4, true) }}>
          <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
            <input className="candy-face" value={n}
              onChange={(e) => update(roster.map((x, j) => (j === i ? e.target.value : x)))}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </div>
          <button onClick={() => { update(roster.filter((_, j) => j !== i)); commit(); }} title="Remove player" style={removeBtn}>×</button>
        </div>
      ))}
      <div className="candy-btn" data-shape="field" style={{ width: '100%', marginTop: 2 }}>
        <input className="candy-face" value={draft} placeholder="Add a player"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addName(); } }} />
      </div>
    </div>
  );
}

// Speakers panel (SF6) — one row per detected voice cluster → a roster-name
// dropdown. Assigning enrolls/retrains that player's print and relabels every
// segment of the cluster (onReassign = MatchPage.reassignCluster).
export function SpeakersPanel({ sidecarPath: scPath, roster, onReassign }) {
  const [vm, setVm] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.getRawFileMeta(scPath, 'gamewiki')
      .then((r) => { if (!cancelled) setVm(parseCommsSidecar(r.content)); })
      .catch(() => { if (!cancelled) setVm({ segments: [], clusters: [], micSpeaker: 'You' }); });
    return () => { cancelled = true; };
  }, [scPath]);
  if (!vm) return null;
  const clusters = vm.clusters || [];
  if (!clusters.length) return null;
  const options = [{ value: '', label: 'Unknown' }, ...roster.map((n) => ({ value: n, label: n }))];
  const labelOf = (cid) => { const s = (vm.segments || []).find((x) => Number(x.cluster) === Number(cid)); return s?.speaker || labelForCluster(cid, {}); };
  return (
    <div style={{ marginTop: 8 }}>
      <div style={labelStyle}>Speakers</div>
      {clusters.map((c) => {
        const cur = labelOf(c.clusterId);
        const val = roster.includes(cur) ? cur : '';
        return (
          <div key={c.clusterId} className="candy-center-row" style={{ gap: 8, marginBottom: candyGap(4, true) }}>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', minWidth: 84, color: speakerColor(val) }}>{labelForCluster(c.clusterId, {})}</span>
            <CandySelect value={val} options={options} onChange={(n) => onReassign(c.clusterId, n)} title="Assign this voice to a player" placeholder={cur} compact />
          </div>
        );
      })}
    </div>
  );
}
