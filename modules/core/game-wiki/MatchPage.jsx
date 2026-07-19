// MatchPage — the per-match editor for `<scrimFolder>/Matches/Match <n>.md`
// (GameWiki Unification Phase 4, the retired ScrimViewer's match card as a full
// pane). Fields + notes/timer + the whole per-match pipeline: Run Process,
// Extract Comms (Rust job via the shared bridge), Classify (AI), Review Comms,
// speaker relabels. Saving rides scrimShared's per-file useDocSave loop; opaque
// subsections write through writeMerged so the doc and the disk stay one thing.
// Overlay mode adds Scoreboard/Record chips, the dictate mic, and publishes the
// dictation live-target (this match) — persisted so F8 keeps landing here while
// other pages are browsed.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api, invoke } from '@host/api.js';
import RecordButton from '@modules/studio/overlay/RecordButton.jsx';
import { IconFolder, IconPlayCircle } from '@host/components/icons.jsx';
import { candyGap } from '@host/util/candy.js';
import { useSettings } from '@host/hooks/useSettings.js';
import { parseMatchFile, serializeMatchFile, mergeMatch, getNotes, ensureNotes } from './scrimSchema.js';
import { sidecarPath, renderSummary, MATCH_DATA_PLACEHOLDER, clock, extractMeta, fmtLocalTime, extractSpatial } from './matchData.js';
import { compileNotes, renderCoachingSummary, parseTimedNote, sortByTimeAsc } from './noteCompile.js';
import { parseSegments, parseCommsSidecar, buildCommsSidecar, renderCommsSummary } from './commsCompile.js';
import { labelForCluster } from './diarize.js';
import { enrollPrint } from './voiceprints.js';
import { buildMomentsDigest, classifyMoments, reconcile, renderAutoClassification, sideFromTeamFields, mergedItemToBullet } from './autoClassify.js';
import { buildFights, judgeTeamfights, summarize } from './teamfightComms.js';
import { readStopwatch } from './useStopwatch.js';
import CommsTranscriptView from './CommsTranscriptView.jsx';
import TeamfightCommsView from './TeamfightCommsView.jsx';
import MatchViewPopup from './MatchViewPopup.jsx';
import ReviewModal from './ReviewModal.jsx';
import {
  useDocSave, useSttUp, useAiConfigured, resolveAgents, useScrimRecord,
  useCommsJobBridge, updateTeamProgress, notify, pickFile, trackIndex,
  loadTrackDefaults, matchPath, readOverviewFm, setOverviewScrimFields, setOpaque,
  readTeamStore, writeTeamStore, DICTATION_TARGET_KEY,
  EditField, MiniBtn, Scoreboard, TeamNotes, SaveTag, CoachingSummaryView,
  AutoClassificationView, SilentDeathAudit, SpeakersPanel,
  wrap, inner, card, sectionTitle, labelStyle,
  MP4_FILTERS, IMG_FILTERS, STT_MODEL,
} from './scrimShared.jsx';

export default function MatchPage({ folder, n, accent, overlay = false }) {
  const { settings } = useSettings();
  const parse = useCallback((c) => parseMatchFile(c, n), [n]);
  const { doc, err, saveState, docRef, applyEdit, flushSave, flushIfDirty, writeMerged } =
    useDocSave({ path: matchPath(folder, n), parse, serialize: serializeMatchFile, merge: mergeMatch });

  // Scrim-level context (teams, tracks) lives in Overview.md — loaded once, and
  // re-read fresh inside actions that depend on it.
  const [fm, setFmState] = useState({});
  useEffect(() => {
    let c = false;
    readOverviewFm(folder).then((f) => { if (!c) setFmState(f); });
    return () => { c = true; };
  }, [folder]);
  const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
  const enemyTeam = (fm['Team 1'] === coachedTeam ? fm['Team 2'] : fm['Team 1']) || '';
  const coachedRef = useRef('');
  useEffect(() => { coachedRef.current = coachedTeam; }, [coachedTeam]);

  const [coachedRoster, setCoachedRoster] = useState([]);
  useEffect(() => {
    let c = false;
    if (!coachedTeam) { setCoachedRoster([]); return undefined; }
    readTeamStore(coachedTeam).then((s) => { if (!c) setCoachedRoster(s.roster || []); }).catch(() => {});
    return () => { c = true; };
  }, [coachedTeam]);

  const [sttUp, setSttUp] = useSttUp();
  const aiConfigured = useAiConfigured(settings);
  const [running, setRunning] = useState(false);
  const [commsBusy, setCommsBusy] = useState({ on: false, phase: '' });
  const [classifying, setClassifying] = useState(false);
  const [classifyPhase, setClassifyPhase] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [tfReady, setTfReady] = useState(false);
  const [tfOpen, setTfOpen] = useState(false);
  const [matchPopup, setMatchPopup] = useState(false);
  const [review, setReview] = useState(null); // { teamName, items }
  const [commsRelabelKey, setCommsRelabelKey] = useState(0);
  const [dictating, setDictating] = useState(false);
  const runningRef = useRef(false);
  const commsRef = useRef(false);
  const classifyRef = useRef(false);
  const tfRef = useRef(false);

  const rec = useScrimRecord({
    base: folder.split('/').pop(),
    onFiled: (target, p) => {
      if (target === `match:${n}`) { applyEdit((m) => ({ ...m, fields: { ...m.fields, 'Scrim Recording': p } })); flushSave(); }
    },
  });

  // Cached .tfcomms review probe → the "Open Review" chip without a regenerate.
  useEffect(() => {
    let c = false;
    api.getRawFileMeta(sidecarPath(folder, n, 'tfcomms'), 'gamewiki')
      .then(() => { if (!c) setTfReady(true); })
      .catch(() => { if (!c) setTfReady(false); });
    return () => { c = true; };
  }, [folder, n]);

  // ── Run Process — deadlock-api fetch → sidecar + opaque summaries + series Score ──
  const runProcess = async () => {
    const m = docRef.current;
    if (!m || runningRef.current) return;
    const matchId = String(m.fields['Match ID'] || '').trim();
    if (!matchId) { notify('error', 'Match ID required', 'Enter a Match ID for this match first.'); return; }
    if (!/^\d+$/.test(matchId)) { notify('error', 'Invalid Match ID', 'Match ID must be a number.'); return; }
    runningRef.current = true; setRunning(true);
    try {
      await flushIfDirty();
      const data = await invoke('deadlock_fetch_match', { matchId });
      const scPath = sidecarPath(folder, n);
      await api.savePage(scPath, JSON.stringify(data), null, 'gamewiki');
      const body = renderSummary(data, scPath.split('/').pop());
      const autoTime = fmtLocalTime(extractMeta(data).startTime);
      await writeMerged((mm) => {
        let next = autoTime ? { ...mm, fields: { ...mm.fields, Time: autoTime } } : mm;
        const summaryBody = renderCoachingSummary(compileNotes(getNotes(next)?.bullets || []));
        next = setOpaque(next, 'Match Data', body);
        return setOpaque(next, 'Coaching Summary', summaryBody);
      });
      // Series Score across all matches → the Overview ## Scrim bullet.
      const score = await deriveScore(data);
      if (score != null) await setOverviewScrimFields(folder, { Score: score });
      notify('success', 'Run Process complete', `Match ${matchId} — data + notes compiled.`);
    } catch (e) {
      const msg = {
        NOT_FOUND: ['No such match', `deadlock-api has no match ${matchId}.`],
        RATE_LIMITED: ['Rate limited', 'deadlock-api is rate-limiting — wait a moment and retry.'],
        NETWORK: ['Network error', e?.message || 'Could not reach deadlock-api.'],
        INVALID: ['Invalid Match ID', e?.message || 'Match ID must be a number.'],
        UPSTREAM: ['deadlock-api error', e?.message || 'Unexpected response from deadlock-api.'],
      }[e?.code] || ['Run Process failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      runningRef.current = false; setRunning(false);
    }
  };

  // Coached-team W–L across every fetched match in the folder (this match uses
  // the just-fetched payload; siblings read their .matchdata sidecars).
  const deriveScore = async (currentData) => {
    const ofm = await readOverviewFm(folder);
    const coached = ofm['Coached Team'] || ofm['Team 1'] || '';
    const list = await api.listFolderRaw(`${folder}/Matches`, 'gamewiki').catch(() => null);
    const ns = (list?.files || [])
      .map((f) => Number((f.match(/^Match (\d+)\.md$/) || [])[1]))
      .filter((x) => Number.isFinite(x) && x > 0);
    let w = 0, l = 0, any = false;
    for (const k of ns) {
      let mf;
      try { mf = parseMatchFile((await api.getRawFileMeta(matchPath(folder, k), 'gamewiki')).content, k); } catch { continue; }
      const { coachedSide } = sideFromTeamFields(mf.fields, coached);
      if (coachedSide == null) continue;
      let winner = null;
      if (k === n) winner = extractMeta(currentData).winningTeam;
      else { try { winner = extractMeta(JSON.parse((await api.getRawFileMeta(sidecarPath(folder, k), 'gamewiki')).content)).winningTeam; } catch { winner = null; } }
      if (winner == null) continue;
      any = true; if (winner === coachedSide) w++; else l++;
    }
    return any ? `${w}-${l}` : null;
  };

  // ── Extract Comms — start the Rust-owned job; the bridge owns completion ──
  const extractComms = async () => {
    const m = docRef.current;
    if (!m || commsRef.current) return;
    const video = String(m.fields['Scrim Recording'] || '').trim();
    if (!video) { notify('error', 'No recording', 'Set a Scrim Recording (.mp4) for this match first.'); return; }
    let up = false;
    try { up = (await invoke('stt_status')) != null; } catch { up = false; }
    if (!up) { setSttUp(false); notify('error', 'Speech engine unavailable', 'The transcription engine is not running — reopen the app and try again.'); return; }
    const ofm = await readOverviewFm(folder);
    const defs = loadTrackDefaults();
    const commsIdx = trackIndex(ofm['Comms Track'] ?? defs.comms);
    const micIdx = trackIndex(ofm['Mic Track'] ?? defs.mic);
    commsRef.current = true; setCommsBusy({ on: true, phase: 'Extracting audio' });
    try {
      await flushIfDirty();
      const coached = ofm['Coached Team'] || ofm['Team 1'] || '';
      const store = await readTeamStore(coached);
      await invoke('comms_job_start', {
        video, commsTrack: commsIdx, micTrack: micIdx, model: STT_MODEL,
        maxSpeakers: (store.roster || []).length || 8, scrimPath: folder, kind: 'match', matchN: n,
      });
    } catch (e) {
      commsRef.current = false; setCommsBusy({ on: false, phase: '' });
      notify('error', 'Extract Comms failed', e?.message || String(e));
    }
  };
  const cancelComms = () => { if (commsRef.current) { setCommsBusy((b) => ({ ...b, phase: 'Cancelling' })); invoke('comms_job_cancel').catch(() => {}); } };

  useCommsJobBridge({
    scrimFolder: folder,
    filter: (p) => p.kind === 'match' && Number(p.matchN) === n,
    setBusy: (b) => { commsRef.current = b.on; setCommsBusy(b); },
    // finishMatchJob wrote the opaque ### Comms Transcript on disk — merge it into
    // the mounted doc (local fields kept, opaque refreshed) + remount comms views.
    onFinished: (p) => {
      if (p.kind === 'match' && Number(p.matchN) === n) {
        writeMerged((mm) => mm).then(() => setCommsRelabelKey((k) => k + 1)).catch(() => {});
      }
    },
  });

  // ── Classify (AI) + merge-review save ──
  const classify = async (side, teamName) => {
    const m = docRef.current;
    if (!m || classifyRef.current || side == null || !teamName) return;
    classifyRef.current = true; setClassifying(true); setClassifyPhase('Reading match data');
    try {
      await flushIfDirty();
      const raw = JSON.parse((await api.getRawFileMeta(sidecarPath(folder, n), 'gamewiki')).content);
      const digest = buildMomentsDigest(raw, side);
      if (!digest.moments.length) { notify('error', 'Nothing to classify', 'No notable moments found for that side in this match.'); return; }
      const notesSub = getNotes(docRef.current, teamName);
      const userNotes = (notesSub?.bullets || []).map((b, i) => { const p = parseTimedNote(b); return { noteId: `n${i}`, at: p.at, atSec: p.atSec, label: p.classification, text: p.text }; });
      let commsSlice = '';
      try {
        const cr = await api.getRawFileMeta(sidecarPath(folder, n, 'comms'), 'gamewiki');
        commsSlice = (JSON.parse(cr.content) || []).map((s) => s.text).filter(Boolean).join(' ');
      } catch { /* no comms — fine */ }
      const agents = await resolveAgents(settings);
      setClassifyPhase('Asking Claude');
      const fresh = await classifyMoments(invoke, digest, agents, { commsSlice, userNotes });
      setClassifyPhase('Saving');
      const scPath = sidecarPath(folder, n, 'autoclass');
      let store = { teams: {} };
      try { store = JSON.parse((await api.getRawFileMeta(scPath, 'gamewiki')).content) || { teams: {} }; if (!store.teams) store.teams = {}; } catch { /* first run */ }
      const reconciled = reconcile(fresh, store.teams[teamName]);
      store.teams[teamName] = { side, model: agents.model, suggestions: reconciled };
      await api.savePage(scPath, JSON.stringify(store), null, 'gamewiki');
      await writeMerged((mm) => setOpaque(mm, `Auto Classification (${teamName})`, renderAutoClassification(store.teams[teamName])));
      setReview({ teamName, items: reconciled });
    } catch (e) {
      const msg = {
        AUTH: ['AI backend not configured', 'Add an Anthropic API key or Claude CLI in Settings → Agents.'],
        NETWORK: ['Network error', e?.message || 'Could not reach the model.'],
        UPSTREAM: ['Model error', e?.message || 'The model returned an unexpected response.'],
        INVALID: ['Classify failed', e?.message || 'Bad input.'],
      }[e?.code] || ['Classify failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      classifyRef.current = false; setClassifying(false); setClassifyPhase('');
    }
  };

  const saveReview = async (teamName, kept, dropped) => {
    try {
      const bullets = sortByTimeAsc(kept, (it) => it.atSec).ordered.map(mergedItemToBullet);
      const scPath = sidecarPath(folder, n, 'autoclass');
      let store = { teams: {} };
      try { store = JSON.parse((await api.getRawFileMeta(scPath, 'gamewiki')).content) || { teams: {} }; if (!store.teams) store.teams = {}; } catch { /* first run */ }
      const prev = store.teams?.[teamName] || {};
      store.teams[teamName] = { side: prev.side ?? null, model: prev.model || 'opus', suggestions: [...kept, ...dropped] };
      await api.savePage(scPath, JSON.stringify(store), null, 'gamewiki');
      await writeMerged((mm) => {
        const w = ensureNotes(mm, teamName);
        const withNotes = { ...w, subsections: w.subsections.map((s) => (s.kind === 'notes' && s.team === teamName ? { ...s, bullets } : s)) };
        return setOpaque(withNotes, `Auto Classification (${teamName})`, renderAutoClassification(store.teams[teamName]));
      });
      setReview(null);
      notify('success', 'Notes updated', `${teamName} — ${bullets.length} note${bullets.length === 1 ? '' : 's'} from review.`);
    } catch (e) {
      notify('error', 'Save failed', e?.message || String(e));
    }
  };

  // ── Review Comms (teamfight judge) ──
  const reviewComms = async (side, team) => {
    if (tfRef.current) return;
    let raw, segments;
    try { raw = JSON.parse((await api.getRawFileMeta(sidecarPath(folder, n), 'gamewiki')).content); }
    catch { notify('error', 'No match data', 'Run Process first — the review needs the match data.'); return; }
    try { segments = parseSegments((await api.getRawFileMeta(sidecarPath(folder, n, 'comms'), 'gamewiki')).content); }
    catch { notify('error', 'No comms', 'Extract Comms first — the review reads that transcript.'); return; }
    const offsetS = Number(docRef.current?.fields?.['Comms Offset']) || 0;
    const fights = buildFights(extractSpatial(raw).deaths, segments, { side, offsetS });
    if (!fights.length) { notify('info', 'No teamfights', 'No death clusters found to review in this match.'); return; }
    tfRef.current = true; setReviewing(true);
    try {
      const agents = await resolveAgents(settings);
      const judged = await judgeTeamfights(invoke, { fights, coachedTeam: team, roster: coachedRoster }, agents);
      const report = { generated: new Date().toISOString().slice(0, 10), model: agents.model, fights: judged, summary: summarize(judged) };
      await api.savePage(sidecarPath(folder, n, 'tfcomms'), JSON.stringify(report), null, 'gamewiki');
      setTfReady(true); setTfOpen(true);
      updateTeamProgress(team).catch(() => {});
      const missed = judged.reduce((a, f) => a + (f.missed || []).length, 0);
      notify('success', 'Comms reviewed', `${judged.length} teamfight${judged.length === 1 ? '' : 's'} · ${missed} missed call${missed === 1 ? '' : 's'}.`);
    } catch (e) {
      const msg = {
        AUTH: ['AI backend not configured', 'Add an Anthropic API key or Claude CLI in Settings → Agents.'],
        NETWORK: ['Network error', e?.message || 'Could not reach the model.'],
        UPSTREAM: ['Model error', e?.message || 'The model returned an unexpected response.'],
      }[e?.code] || ['Review failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      tfRef.current = false; setReviewing(false);
    }
  };

  // ── Speaker cluster relabel (Speakers panel / inline transcript) ──
  const reassignCluster = async (cid, name) => {
    try {
      const scPath = sidecarPath(folder, n, 'comms');
      const vm = parseCommsSidecar((await api.getRawFileMeta(scPath, 'gamewiki')).content);
      const cl = (vm.clusters || []).find((c) => Number(c.clusterId) === Number(cid));
      const team = coachedRef.current;
      if (name && cl?.embedding?.length) {
        const store = await readTeamStore(team);
        const prints = enrollPrint(store.prints || {}, name, cl.embedding);
        const roster = (store.roster || []).includes(name) ? store.roster : [...(store.roster || []), name];
        await writeTeamStore(team, { roster, prints });
        setCoachedRoster(roster);
      }
      const label = name || labelForCluster(Number(cid), {});
      const segments = (vm.segments || []).map((s) => (Number(s.cluster) === Number(cid) ? { ...s, speaker: label } : s));
      await api.savePage(scPath, JSON.stringify(buildCommsSidecar({ segments, clusters: vm.clusters || [], micSpeaker: vm.micSpeaker })), null, 'gamewiki');
      const durationS = segments.length ? Math.max(...segments.map((s) => Number(s.t1Ms) || 0)) / 1000 : 0;
      await writeMerged((mm) => setOpaque(mm, 'Comms Transcript', renderCommsSummary({ n, segments, durationS, sidecarFileName: scPath.split('/').pop() })));
      setCommsRelabelKey((k) => k + 1);
    } catch (e) {
      notify('error', 'Relabel failed', e?.message || String(e));
    }
  };

  // ── Notes plumbing ──
  const setNotes = (team, bullets) => applyEdit((mm) => {
    const w = ensureNotes(mm, team);
    return { ...w, subsections: w.subsections.map((s) => (s.kind === 'notes' && s.team === team ? { ...s, bullets } : s)) };
  });
  const setMatchField = (k, v) => applyEdit((mm) => ({ ...mm, fields: { ...mm.fields, [k]: v } }));

  // Dictated/typed live-capture append (overlay): stamped with the running game
  // clock, saved through this page's own loop (single writer while mounted).
  const appendNote = useCallback((text) => {
    const t = String(text || '').trim();
    if (!t) return;
    const team = coachedRef.current;
    const sw = readStopwatch(`gw-sw:${folder}:m${n}:${team}`);
    const stamped = sw.running ? `[${clock(sw.elapsedSec)}] ${t}` : t;
    applyEdit((mm) => {
      const w = ensureNotes(mm, team);
      return { ...w, subsections: w.subsections.map((s) => (s.kind === 'notes' && s.team === team ? { ...s, bullets: [...(s.bullets || []), stamped] } : s)) };
    });
    flushSave();
    invoke('overlay_note_toast', { text: t }).catch(() => {});
  }, [folder, n, applyEdit, flushSave]);

  // Dictate button — its OWN stt_start_dictation session (client Channel), distinct
  // from the hotkey PTT path (overlay-dictation-committed), so they never double-append.
  const toggleDictate = useCallback(() => {
    if (dictating) { invoke('stt_stop_dictation').catch(() => {}); return; }
    const model = settings?.stt?.defaultModel || 'base.en';
    const segs = [];
    const ch = new Channel();
    ch.onmessage = (ev) => {
      switch (ev.kind) {
        case 'segment': segs.push(ev.text ?? ''); break;
        case 'final': { const t = (ev.text ?? segs.join(' ')).replace(/\s+/g, ' ').trim(); if (t) appendNote(t); setDictating(false); break; }
        case 'error': setDictating(false); break;
        case 'done': setDictating(false); break;
        default: break;
      }
    };
    setDictating(true);
    invoke('stt_start_dictation', { model, onEvent: ch }).catch(() => setDictating(false));
  }, [dictating, settings, appendNote]);

  // ── Overlay live-target: opening this match page makes it the F8 dictation
  //    target; persisted so it survives Shift+C reloads + browsing other pages. ──
  useEffect(() => {
    if (!overlay) return;
    invoke('overlay_go_live', { target: { scrimPath: folder, matchN: n, coachedTeam: coachedTeam || null } }).catch(() => {});
    try { localStorage.setItem(DICTATION_TARGET_KEY, JSON.stringify({ folder, n, coached: coachedTeam })); } catch { /* private mode */ }
  }, [overlay, folder, n, coachedTeam]);

  // Overlay capture listeners for THIS match (the panel handles unmounted targets).
  useEffect(() => {
    if (!overlay) return undefined;
    const subs = [
      listen('overlay-dictation-committed', (e) => {
        const p = e.payload || {};
        if (p.scrimPath === folder && Number(p.matchN) === n) appendNote(p.text);
      }),
      listen('capture-screenshot-saved', (e) => {
        const pth = e.payload?.path;
        if (!pth) return;
        if (String(docRef.current?.fields?.['Scoreboard'] || '').trim()) return;
        setMatchField('Scoreboard', pth);
        flushSave();
      }),
    ];
    return () => subs.forEach((s) => s.then((u) => u()).catch(() => {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setMatchField/flushSave stable enough per mount
  }, [overlay, folder, n, appendNote]);

  const takeScoreboardShot = () => { invoke('capture_screenshot').catch(() => {}); };

  const paneInner = overlay ? { padding: 8, fontFamily: 'var(--font-mono)', '--accent': accent } : { ...inner, '--accent': accent };
  if (err) return <div style={wrap}><div style={paneInner}><p style={{ color: 'var(--error)' }}>Couldn’t open this match: {err}</p></div></div>;
  if (!doc) return <div style={wrap}><div style={paneInner}><p style={{ color: 'var(--text-muted)' }}>Loading</p></div></div>;

  const m = doc;
  const matchData = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === 'Match Data') || {}).body;
  const populated = matchData && matchData !== MATCH_DATA_PLACEHOLDER;
  const summaryBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === 'Coaching Summary') || {}).body;
  const hasSummary = !!(summaryBody && summaryBody.trim());
  const commsBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === 'Comms Transcript') || {}).body;
  const hasComms = !!(commsBody && commsBody.trim());
  const { coachedSide, enemySide } = sideFromTeamFields(m.fields, coachedTeam);
  const autoBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === `Auto Classification (${coachedTeam})`) || {}).body;
  const hasAuto = !!(autoBody && autoBody.trim());
  const enemyAutoBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === `Auto Classification (${enemyTeam})`) || {}).body;
  const hasEnemyAuto = !!(enemyAutoBody && enemyAutoBody.trim());
  const cardBox = overlay ? undefined : card;

  return (
    <div style={wrap}>
      <div style={paneInner}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><SaveTag state={saveState} /></div>
        <div style={cardBox}>
          <div style={{ marginBottom: candyGap(8) }}>
            <div style={sectionTitle}>Match {n}</div>
            <div className="candy-chip-row" style={{ marginTop: 4 }}>
              {overlay && (
                <button className="candy-btn" data-shape="chip" onClick={takeScoreboardShot}
                  title="Capture a scoreboard screenshot for this match">
                  <span className="candy-face">Scoreboard</span>
                </button>
              )}
              {overlay && (
                <button className="candy-btn" data-shape="chip"
                  disabled={rec.busyElsewhere(`match:${n}`) || !rec.alive}
                  onClick={() => (rec.recTarget === `match:${n}` ? rec.stop() : rec.start({ kind: 'match', n }))}
                  title={!rec.alive ? 'Studio engine is down — reopen the app'
                    : rec.busyElsewhere(`match:${n}`) ? 'Another recording is running — stop it first'
                      : rec.recTarget === `match:${n}` ? 'Stop — the file drops into Scrim Recording'
                        : 'Record this match into the scrim folder'}>
                  <span className="candy-face">{rec.recTarget === `match:${n}` ? 'Stop' : 'Record'}</span>
                </button>
              )}
              {populated && (
                <button className="candy-btn" data-shape="chip" onClick={() => setMatchPopup(true)} title="Open the full match view">
                  <span className="candy-face">View Full Match</span>
                </button>
              )}
              <button className="candy-btn" data-shape="chip"
                disabled={commsBusy.on || running || !m.fields['Scrim Recording'] || !sttUp}
                onClick={extractComms}
                title={!m.fields['Scrim Recording']
                  ? 'Set a Scrim Recording (.mp4) for this match first'
                  : !sttUp ? 'Speech engine unavailable — reopen the app'
                    : 'Extract Comms — transcribe this match recording'}
                style={commsBusy.on ? { opacity: 0.6, cursor: 'progress' } : undefined}>
                <span className="candy-face">{commsBusy.on ? (commsBusy.phase || 'Working') : 'Extract Comms'}</span>
              </button>
              {commsBusy.on && (
                <button className="candy-btn" data-shape="chip" onClick={cancelComms} title="Cancel transcription"><span className="candy-face">×</span></button>
              )}
              <button className="candy-btn" data-shape="chip"
                disabled={running || commsBusy.on}
                onClick={runProcess}
                title="Run Process — pull this match's data from deadlock-api by Match ID"
                style={running ? { opacity: 0.6, cursor: 'progress' } : undefined}>
                <span className="candy-face">{running ? 'Running' : 'Run Process'}</span>
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 14 }}>
            <EditField label="Match ID" value={m.fields['Match ID']} onChange={(v) => setMatchField('Match ID', v)} onCommit={flushSave} placeholder="e.g. 38291042" />
            <EditField label="Time" value={m.fields['Time']} onChange={(v) => setMatchField('Time', v)} onCommit={flushSave} placeholder="e.g. 7:42 PM" />
            <EditField label="Amber" value={m.fields['Amber']} onChange={(v) => setMatchField('Amber', v)} onCommit={flushSave} placeholder="team on Amber side" />
            <EditField label="Sapphire" value={m.fields['Sapphire']} onChange={(v) => setMatchField('Sapphire', v)} onCommit={flushSave} placeholder="team on Sapphire side" />
            <EditField label="Comms Offset" value={m.fields['Comms Offset']} onChange={(v) => setMatchField('Comms Offset', v)} onCommit={flushSave} placeholder="s of pre-game in recording" />
          </div>
          <EditField label="Scrim Recording" value={m.fields['Scrim Recording']} onChange={(v) => setMatchField('Scrim Recording', v)} onCommit={flushSave} placeholder="/path/to/match.mp4"
            right={<>
              {!overlay && (
                <RecordButton recording={rec.recTarget === `match:${n}`} disabled={rec.busyElsewhere(`match:${n}`) || !rec.alive} accent={accent}
                  onToggle={() => (rec.recTarget === `match:${n}` ? rec.stop() : rec.start({ kind: 'match', n }))} />
              )}
              <MiniBtn icon={IconFolder} title="Select .mp4" onClick={async () => { const p = await pickFile(MP4_FILTERS); if (p) { setMatchField('Scrim Recording', p); flushSave(); } }} />
              {m.fields['Scrim Recording'] && <MiniBtn icon={IconPlayCircle} title="Open recording" onClick={() => invoke('coaching_open_path', { path: m.fields['Scrim Recording'] }).catch(() => {})} />}
            </>} />
          <EditField label="Scoreboard" value={m.fields['Scoreboard']} onChange={(v) => setMatchField('Scoreboard', v)} onCommit={flushSave} placeholder="/path/to/scoreboard.png"
            right={<MiniBtn icon={IconFolder} title="Select screenshot" onClick={async () => { const p = await pickFile(IMG_FILTERS); if (p) { setMatchField('Scoreboard', p); flushSave(); } }} />} />
          <Scoreboard path={m.fields['Scoreboard']} />
          {/* Coached team only — enemy notes on disk still round-trip verbatim. */}
          <TeamNotes team={coachedTeam} bullets={getNotes(m, coachedTeam)?.bullets || []} overlay={overlay}
            dictating={dictating} onDictate={overlay ? toggleDictate : undefined}
            onChange={(b) => setNotes(coachedTeam, b)} onCommit={flushSave} storageKey={`gw-sw:${folder}:m${n}:${coachedTeam}`} />
          {hasSummary && (
            <div style={{ marginTop: 8 }}>
              <CoachingSummaryView body={summaryBody} />
            </div>
          )}
          {hasComms && (
            <SpeakersPanel key={`sp:${commsBody}:${commsRelabelKey}`} sidecarPath={sidecarPath(folder, n, 'comms')}
              roster={coachedRoster} onReassign={reassignCluster} />
          )}
          <div style={{ marginTop: 8 }}>
            <div style={labelStyle}>Comms Transcript</div>
            {hasComms
              ? <CommsTranscriptView key={`ct:${commsBody}:${commsRelabelKey}`} sidecarPath={sidecarPath(folder, n, 'comms')}
                  roster={coachedRoster} onReassign={reassignCluster} />
              : <div className="text-trim" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not yet extracted — click <strong>Extract Comms</strong>.</div>}
          </div>
          {hasComms && populated && coachedSide != null && (
            <div style={{ marginTop: 8 }}>
              <div style={labelStyle}>Silent Deaths</div>
              <SilentDeathAudit key={`${commsBody}:${matchData}`}
                matchSidecar={sidecarPath(folder, n)}
                commsSidecar={sidecarPath(folder, n, 'comms')}
                side={coachedSide}
                offsetS={Number(m.fields['Comms Offset']) || 0} />
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <div style={labelStyle}>Auto Classification</div>
            <div className="candy-chip-row">
              <button className="candy-btn" data-shape="chip"
                disabled={!populated || coachedSide == null || !aiConfigured || classifying || running || commsBusy.on}
                onClick={() => classify(coachedSide, coachedTeam)}
                title={!populated ? 'Run Process first — Classify needs the match data'
                  : coachedSide == null ? 'Fill the Amber/Sapphire team fields so the coached side resolves'
                    : !aiConfigured ? 'Configure an AI backend in Settings → Agents (API key or Claude CLI)'
                      : `Classify ${coachedTeam || 'the coached team'} — merges the AI with your notes`}
                style={classifying ? { opacity: 0.6, cursor: 'progress' } : undefined}>
                <span className="candy-face">{classifying ? (classifyPhase || 'Working') : `Classify ${coachedTeam || 'coached'}`}</span>
              </button>
              <button className="candy-btn" data-shape="chip"
                disabled={!populated || enemySide == null || !aiConfigured || classifying || running || commsBusy.on}
                onClick={() => classify(enemySide, enemyTeam)}
                title={!populated ? 'Run Process first'
                  : enemySide == null ? 'Fill the Amber/Sapphire team fields so the enemy side resolves'
                    : !aiConfigured ? 'Configure an AI backend in Settings → Agents'
                      : `Classify ${enemyTeam || 'the enemy team'}`}
                style={classifying ? { opacity: 0.6, cursor: 'progress' } : undefined}>
                <span className="candy-face">Classify {enemyTeam || 'enemy'}</span>
              </button>
            </div>
            {!populated && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: candyGap(8) }}>Pull match data first (Run Process), then Classify.</div>}
            {populated && coachedSide == null && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: candyGap(8) }}>Fill the <strong>Amber</strong> / <strong>Sapphire</strong> fields above with each team so the sides resolve.</div>}
            {hasAuto && (
              <div style={{ marginTop: candyGap(8) }}>
                <div style={{ ...labelStyle, color: 'var(--accent)', marginBottom: 2 }}>{coachedTeam || 'Coached'}</div>
                <AutoClassificationView key={autoBody} sidecarPath={sidecarPath(folder, n, 'autoclass')} team={coachedTeam} />
              </div>
            )}
            {hasEnemyAuto && (
              <div style={{ marginTop: candyGap(8) }}>
                <div style={{ ...labelStyle, color: 'var(--text-muted)', marginBottom: 2 }}>{enemyTeam} · enemy</div>
                <AutoClassificationView key={enemyAutoBody} sidecarPath={sidecarPath(folder, n, 'autoclass')} team={enemyTeam} />
              </div>
            )}
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={labelStyle}>Teamfight Comms</div>
            <div className="candy-chip-row">
              <button className="candy-btn" data-shape="chip"
                disabled={!populated || !hasComms || coachedSide == null || !aiConfigured || reviewing || running || commsBusy.on || classifying}
                onClick={() => reviewComms(coachedSide, coachedTeam)}
                title={!populated ? 'Run Process first — the review needs the match data'
                  : !hasComms ? 'Extract Comms first — the review reads that transcript'
                    : coachedSide == null ? 'Fill the Amber/Sapphire team fields so the coached side resolves'
                      : !aiConfigured ? 'Configure an AI backend in Settings → Agents (API key or Claude CLI)'
                        : 'Review Comms — Claude judges each teamfight’s callouts (good / missed / wrong / late)'}
                style={reviewing ? { opacity: 0.6, cursor: 'progress' } : undefined}>
                <span className="candy-face">{reviewing ? 'Asking Claude' : 'Review Comms'}</span>
              </button>
              {tfReady && !reviewing && (
                <button className="candy-btn" data-shape="chip" onClick={() => setTfOpen(true)} title="Open the teamfight comms review">
                  <span className="candy-face">Open Review</span>
                </button>
              )}
            </div>
            {populated && !hasComms && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: candyGap(8) }}>Extract Comms first, then Review Comms.</div>}
          </div>
        </div>

        {matchPopup && (
          <MatchViewPopup sidecarPath={sidecarPath(folder, n)} matchN={n} accent={accent} onClose={() => setMatchPopup(false)} />
        )}
        {tfOpen && (
          <TeamfightCommsView sidecarPath={sidecarPath(folder, n, 'tfcomms')} accent={accent} onClose={() => setTfOpen(false)} />
        )}
        {review && (
          <ReviewModal accent={accent} teamName={review.teamName} items={review.items}
            onSave={(kept, dropped) => saveReview(review.teamName, kept, dropped)} onClose={() => setReview(null)} />
        )}
      </div>
    </div>
  );
}
