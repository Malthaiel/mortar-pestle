// OverviewPage — the scrim-level editor for `<scrimFolder>/Overview.md` (GameWiki
// Unification Phase 4, extracted from the retired ScrimViewer's overview pane).
// Score + VOD Review + the VOD pipeline chips (Extract VOD Comms → Generate
// Report → Open Report), plus the Coaching Setup content INLINE (the old
// AppWindow popup): roster, track indices, your name, and the matchup fields.
// Saving rides scrimShared's per-file useDocSave loop against Overview.md only.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, invoke } from '@host/api.js';
import { navigate } from '@host/router.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import RecordButton from '@modules/studio/overlay/RecordButton.jsx';
import { IconFolder, IconPlayCircle } from '@host/components/icons.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import Popover from '@host/components/ui/Popover.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { save } from '@tauri-apps/plugin-dialog';
import { useSettings } from '@host/hooks/useSettings.js';
import { parseOverview, serializeOverview, parseMatchFile } from './scrimSchema.js';
import { sidecarPath, scrimSidecarPath } from './matchData.js';
import { compileNotes, renderCoachingSummary } from './noteCompile.js';
import { parseCommsSidecar } from './commsCompile.js';
import { buildTranscriptBlock, generateReport, normalizeTranscript, transcriptHash, verifyReport, validateStamps, serializeReportMarkdown, coerceReport, applyCorrections, EXPORT_SECTIONS } from './vodReport.js';
import { buildMatchDigest } from './matchDigest.js';
import { buildBrainContext, buildLexicon, lexiconStale, LEXICON_PATH } from './analystBrain.js';
import { getNotes } from './scrimSchema.js';
import { openHomework, teamSidecarPath } from './teamProgress.js';
import {
  useDocSave, useSttUp, useAiConfigured, resolveAgents, useScrimRecord,
  useCommsJobBridge, updateTeamProgress, notify, pickFile, trackIndex,
  loadTrackDefaults, saveTrackDefault, loadYourName, LS_YOUNAME_KEY,
  mergeOverview, overviewPath, matchPath,
  EditField, TrackField, MiniBtn, SaveTag, RosterEditor,
  wrap, inner, sectionTitle,
  MP4_FILTERS, NOTES_FILTERS, STT_MODEL, readTeamStore,
} from './scrimShared.jsx';

// Plain-language size estimate for the report gate. Calibrated on one measured run (2026-07-19):
// a 58,877-char transcript across 3 full-size calls ate roughly a quarter of a 5-hour Claude Pro
// session window. Deliberately a rough anchor, not a cost model — it is labelled as a guess in the
// dialog, and the only number stated as fact is the transcript's own size.
const MEASURED_CHARS = 58877;
const MEASURED_CALLS = 3;
const MEASURED_SHARE = 0.25;
export function reportCostNote(segments, cachedNorm) {
  const chars = segments.reduce((n, s) => n + String(s?.text ?? '').length, 0);
  const calls = (cachedNorm ? 0 : 1) + 2; // normalize (cache-skippable) + draft + fact-check
  const share = MEASURED_SHARE * (chars / MEASURED_CHARS) * (calls / MEASURED_CALLS);
  const pct = share >= 0.1 ? `${Math.round(share * 100)}%` : 'a few percent';
  return [
    `This review is ${segments.length.toLocaleString()} lines, about ${(Math.round(chars / 5 / 100) * 100).toLocaleString()} words.`,
    `The whole thing gets sent to Claude ${calls} times${cachedNorm ? ' (the name clean-up is already saved, so that pass is skipped)' : ''}, and can take up to 20 minutes.`,
    `On the Claude Pro plan without an API key, a run this size will probably eat around ${pct} of a 5-hour session. That last number is a rough guess from one earlier run, not a measurement.`,
  ];
}

// ── Report run state, module-scope (survives leaving the page) ───────────────
// generateVodReport below is a plain async chain, so it keeps running when this
// page unmounts — hash routing never reloads the webview. Verified live: a run
// kept streaming across a page switch and landed both its .vodreport sidecar and
// the Overview label on disk. What did NOT survive was the BUTTON: `reporting`
// and `reportPhase` were component state, so a remount repainted "Generate
// Report" over a live run, and a second click would start a whole second run —
// run_claude_cli has no mutex, so nothing downstream would have caught it.
// Hoisting the state out of the component is the entire fix. One run app-wide,
// same shape as the Rust-owned comms job.
// ponytail: dev-only — Vite swaps this module on every save, which would wipe a
// live run's state (the exact bug). Sharing ONE store object through the HMR data
// bag keeps the old module's running pipeline talking to the new module's button.
// `import.meta.hot` is undefined in a prod build, so this collapses to the literal.
const reportStore = import.meta.hot?.data.reportStore
  || { snap: { folder: null, phase: '', chars: 0 }, subs: new Set() };
if (import.meta.hot) import.meta.hot.data.reportStore = reportStore;

const setReportJob = (patch) => {
  reportStore.snap = { ...reportStore.snap, ...patch };
  reportStore.subs.forEach((f) => f());
};
const subscribeReport = (f) => { reportStore.subs.add(f); return () => reportStore.subs.delete(f); };
const getReportSnap = () => reportStore.snap;

// The CLI streams its answer (coaching.rs run_claude_cli), so the button can show it arriving
// instead of one frozen phase word for up to 20 minutes — the only way to tell working from hung.
// Attached once at module scope rather than per-mount: a page-scoped listener died with the page,
// which is why the character count vanished on navigation along with everything else. The flag
// lives on the shared store so an HMR swap re-uses the listener instead of stacking a new one.
if (!reportStore.listening) {
  reportStore.listening = true;
  listen('coaching-progress', (e) => {
    if (reportStore.snap.folder) setReportJob({ chars: Number(e?.payload?.chars) || 0 });
  }).catch(() => { reportStore.listening = false; });
}

export default function OverviewPage({ folder, accent, nav = navigate, overlay = false }) {
  const { settings } = useSettings();
  const { doc, err, saveState, docRef, applyEdit, flushSave, flushIfDirty, reload } =
    useDocSave({ path: overviewPath(folder), parse: parseOverview, serialize: serializeOverview, merge: mergeOverview });

  const [sttUp, setSttUp] = useSttUp();
  const aiConfigured = useAiConfigured(settings);
  const [vodBusy, setVodBusy] = useState({ on: false, phase: '' });
  const [costGate, setCostGate] = useState(null); // { segments, cachedNorm } while the size gate is up
  const [yourName, setYourName] = useState(loadYourName);
  const [trackDefaults, setTrackDefaults] = useState(loadTrackDefaults);
  const [trackCount, setTrackCount] = useState(0);
  // Export-to-.md popover (report → Markdown). Mirrors the section picker the report view used to
  // hold — this is now the app's only Export entry point. Sidecars are read on demand at export time.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportAnchor, setExportAnchor] = useState(null);
  const [exportSel, setExportSel] = useState(() => new Set(['report', 'actions', 'qa']));
  const [exportDest, setExportDest] = useState('');
  const [exportErr, setExportErr] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const vodRef = useRef(false);

  // Whose run is it: this scrim's (show the phase), or another scrim's (grey the
  // button out — one report at a time, app-wide).
  const reportJob = useSyncExternalStore(subscribeReport, getReportSnap);
  const reporting = reportJob.folder === folder;
  const reportElsewhere = reportJob.folder != null && !reporting;

  const base = folder.split('/').pop();
  const setFm = (k, v) => applyEdit((o) => ({ ...o, frontmatter: { ...o.frontmatter, [k]: v } }));
  const setScrimField = (k, v) => applyEdit((o) => ({ ...o, scrim: { ...o.scrim, [k]: v } }));

  const rec = useScrimRecord({
    base,
    onFiled: (target, p) => { if (target === 'vod') { setScrimField('VOD Review', p); flushSave(); } },
  });

  // Probe the chosen VOD for its real audio-track count so the Comms/Mic pickers
  // can only offer tracks that exist. 0 = nothing picked yet, or the probe failed
  // (which disables the pickers rather than silently offering bad indices).
  const vodPath = String(doc?.scrim?.['VOD Review'] || '').trim();
  useEffect(() => {
    if (!vodPath) { setTrackCount(0); return; }
    let live = true;
    invoke('coaching_audio_track_count', { video: vodPath })
      .then((n) => { if (live) setTrackCount(Number(n) || 0); })
      .catch(() => { if (live) setTrackCount(0); });
    return () => { live = false; };
  }, [vodPath]);

  // Extract VOD Comms — the Rust-owned comms job, kind 'vod'; completion lands in
  // the bridge below (finishVodJob is disk-based in scrimShared).
  const extractVodComms = async () => {
    if (vodRef.current) return;
    const video = String(docRef.current?.scrim?.['VOD Review'] || '').trim();
    if (!video) { notify('error', 'No VOD recording', 'Set a VOD Review (.mp4) for this scrim first.'); return; }
    let up = false;
    try { up = (await invoke('stt_status')) != null; } catch { up = false; }
    if (!up) { setSttUp(false); notify('error', 'Speech engine unavailable', 'The transcription engine is not running — reopen the app and try again.'); return; }
    const fm = docRef.current?.frontmatter || {};
    const defs = loadTrackDefaults();
    const commsIdx = trackIndex(fm['Comms Track'] ?? defs.comms);
    const micIdx = trackIndex(fm['Mic Track'] ?? defs.mic);
    if (commsIdx == null) { notify('error', 'No comms track', 'Set the Comms Track (the Discord audio track index) so the team voices can be separated.'); return; }
    vodRef.current = true;
    setVodBusy({ on: true, phase: 'Extracting audio' });
    try {
      await flushIfDirty();
      const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
      const store = await readTeamStore(coachedTeam);
      await invoke('comms_job_start', {
        video, commsTrack: commsIdx, micTrack: micIdx, model: STT_MODEL,
        maxSpeakers: (store.roster || []).length || 8, scrimPath: folder, kind: 'vod', matchN: null,
      });
    } catch (e) {
      vodRef.current = false; setVodBusy({ on: false, phase: '' });
      notify('error', 'Extract VOD Comms failed', e?.message || String(e));
    }
  };
  const cancelVod = () => { if (vodRef.current) { setVodBusy((b) => ({ ...b, phase: 'Cancelling' })); invoke('comms_job_cancel').catch(() => {}); } };

  useCommsJobBridge({
    scrimFolder: folder,
    filter: (p) => p.kind === 'vod',
    setBusy: (b) => { vodRef.current = b.on; setVodBusy(b); },
    // finishVodJob wrote the VOD Comms bullet on disk — re-adopt so the local doc
    // doesn't clobber it on the next save.
    onFinished: () => reload().catch(() => {}),
  });

  // Generate Report — Analyst pipeline (normalize → draft → verify), folder-scoped
  // sidecars, per-match digests from the Matches/ listing.
  // The button opens a size gate first: these runs are 2-3 Claude calls each carrying the WHOLE
  // transcript, on subscription auth, and a run can eat a big slice of a session window. Read the
  // transcript here so the estimate is real, then hand the parsed segments to the pipeline.
  const askVodReport = async () => {
    if (reportStore.snap.folder) return;
    const commsPath = scrimSidecarPath(folder, 'vodcomms');
    let segments;
    try { segments = parseCommsSidecar((await api.getRawFileMeta(commsPath, 'gamewiki')).content).segments; }
    catch { notify('error', 'No VOD comms', 'Extract VOD Comms first — the report reads that transcript.'); return; }
    if (!segments.length) { notify('error', 'Empty transcript', 'The VOD comms transcript has no segments to report on.'); return; }
    // Pass 0 is skipped when the cached .vodnorm matches this transcript — one less full-size call.
    let cachedNorm = false;
    try {
      const c = JSON.parse((await api.getRawFileMeta(scrimSidecarPath(folder, 'vodnorm'), 'gamewiki')).content);
      cachedNorm = c.hash === transcriptHash(segments);
    } catch { /* no cache */ }
    // Match-data presence for the gate's data-free warning: a readable match sidecar = Run Process ran.
    // Empty → the report runs from the transcript alone (buildReportPrompt emits its NO-MATCH-DATA block).
    let hasMatchData = false;
    try {
      const list = await api.listFolderRaw(`${folder}/Matches`, 'gamewiki').catch(() => null);
      for (const f of list?.files || []) {
        const k = Number((f.match(/^Match (\d+)\.md$/) || [])[1]);
        if (!Number.isFinite(k) || k <= 0) continue;
        try { JSON.parse((await api.getRawFileMeta(sidecarPath(folder, k), 'gamewiki')).content); hasMatchData = true; break; } catch { /* no data for this match */ }
      }
    } catch { /* no Matches folder */ }
    setCostGate({ segments, cachedNorm, noMatchData: !hasMatchData });
  };

  const generateVodReport = async (segments) => {
    if (reportStore.snap.folder) return;
    setReportJob({ folder, phase: '', chars: 0 });
    // Where the user was when they pressed Generate. A run can take 20 minutes; if they
    // have moved on since, finishing must not yank them out of whatever they moved on to.
    const hashAtStart = window.location.hash;
    try {
      const fm = docRef.current?.frontmatter || {};
      const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
      const opponent = (fm['Team 1'] === coachedTeam ? fm['Team 2'] : fm['Team 1']) || '';
      const agents = await resolveAgents(settings);

      const scPath = scrimSidecarPath(folder, 'vodreport');
      let prior = null;
      try { prior = JSON.parse((await api.getRawFileMeta(scPath, 'gamewiki')).content); } catch { /* first run */ }
      let priorActionItems = [];
      try { priorActionItems = openHomework(JSON.parse((await api.getRawFileMeta(teamSidecarPath(coachedTeam), 'gamewiki')).content), { excludeScrim: base }); } catch { /* no team memory yet */ }
      let notesBlock = '';
      try { notesBlock = (await api.getRawFileMeta(scrimSidecarPath(folder, 'vodnotes'), 'gamewiki')).content; } catch { /* no notes */ }

      setReportJob({ phase: 'Normalizing', chars: 0 });
      let lexicon = '';
      try {
        lexicon = (await api.getRawFileMeta(LEXICON_PATH, 'gamewiki')).content;
        if (lexiconStale(lexicon)) {
          lexicon = await buildLexicon(api, new Date().toISOString().slice(0, 10));
          await api.savePage(LEXICON_PATH, lexicon, null, 'gamewiki');
        }
      } catch { /* brain missing → buildBrainContext surfaces it loudly */ }
      const brain = await buildBrainContext(api, { coachedTeam });

      // per-match digests + coach notes from the Matches/ listing
      const list = await api.listFolderRaw(`${folder}/Matches`, 'gamewiki').catch(() => null);
      const ns = (list?.files || [])
        .map((f) => Number((f.match(/^Match (\d+)\.md$/) || [])[1]))
        .filter((x) => Number.isFinite(x) && x > 0)
        .sort((a, b) => a - b);
      const matchDigests = [];
      const coachNotes = [];
      for (const k of ns) {
        try { matchDigests.push(buildMatchDigest(JSON.parse((await api.getRawFileMeta(sidecarPath(folder, k), 'gamewiki')).content), { label: `Match ${k}` })); }
        catch { /* no match data for this one */ }
        try {
          const m = parseMatchFile((await api.getRawFileMeta(matchPath(folder, k), 'gamewiki')).content, k);
          const bullets = getNotes(m)?.bullets || [];
          if (bullets.length) coachNotes.push(`### Match ${k}\n${renderCoachingSummary(compileNotes(bullets))}`);
        } catch { /* no such match file */ }
      }
      const coachNotesBlock = coachNotes.join('\n\n');

      const normPath = scrimSidecarPath(folder, 'vodnorm');
      const hash = transcriptHash(segments);
      let cachedNorm = null;
      try { const c = JSON.parse((await api.getRawFileMeta(normPath, 'gamewiki')).content); if (c.hash === hash) cachedNorm = c; } catch { /* no cache */ }
      const norm = await normalizeTranscript(invoke, segments, lexicon, agents, { cached: cachedNorm });
      if (!norm.discarded && !cachedNorm) {
        api.savePage(normPath, JSON.stringify({ hash, corrections: norm.corrections, skipped: norm.skipped }), null, 'gamewiki').catch(() => {});
      }
      const transcriptBlock = buildTranscriptBlock(norm.segments);

      setReportJob({ phase: 'Analyzing', chars: 0 });
      // Land every raw draft emission on disk before it is parsed — this call is the pipeline's
      // most expensive, and a contract slip used to discard it with nothing recoverable.
      const rawPath = scrimSidecarPath(folder, 'vodraw');
      const draft = await generateReport(invoke, {
        transcriptBlock, teams: { opponent }, coachedTeam, priorActionItems, notesBlock,
        brainContext: brain.text, matchDigests, coachNotesBlock, prior,
        onRaw: (raw) => api.savePage(rawPath, raw, null, 'gamewiki'),
      }, agents);

      setReportJob({ phase: 'Fact-checking', chars: 0 });
      const { report, ran: verified } = await verifyReport(invoke, { report: draft, matchDigests, lexicon, segments }, agents);

      // In-pipeline stamp check: any m:ss the model invented (not in the transcript) surfaces as one
      // warning line instead of shipping silently as a clickable-but-dead chip.
      const badStamps = validateStamps(report, segments);
      if (badStamps.length) report.meta.warnings = [...(report.meta.warnings || []), `${badStamps.length} stamp${badStamps.length === 1 ? '' : 's'} outside the transcript: ${badStamps.join(', ')}`];

      report.meta.passes = [...(norm.discarded ? [] : ['normalize']), 'draft', ...(verified ? ['verify'] : [])];
      report.meta.brainSections = brain.sections.filter((s) => s.present).map((s) => s.label);
      report.meta.warnings = [...brain.warnings, ...(norm.warning ? [norm.warning] : []), ...report.meta.warnings];

      setReportJob({ phase: 'Saving', chars: 0 });
      await api.savePage(scPath, JSON.stringify(report), null, 'gamewiki');

      const stamp = new Date().toISOString().slice(0, 10);
      const count = (report.actionItems || []).length;
      applyEdit((o) => ({ ...o, scrim: { ...o.scrim, 'VOD Report': `generated ${stamp} · ${count} item${count === 1 ? '' : 's'}` } }));
      flushSave();
      // Only pull the user to the report if they never left the page that started the run.
      // A 20-minute run that finishes after they've moved on must not hijack where they are —
      // the toast tells them it's ready and Open Report is waiting on the scrim.
      if (window.location.hash === hashAtStart) nav('/game-wiki/' + encodePagePath(`${folder}/Report/tldr`));
      updateTeamProgress(coachedTeam).catch(() => {});
      notify('success', 'Report generated', `${count} action item${count === 1 ? '' : 's'}.`);
    } catch (e) {
      // A timeout carries whatever streamed in before the kill — land it so a fully-billed run is
      // recoverable by hand rather than silently discarded (the old behaviour).
      if (e?.code === 'TIMEOUT' && e?.partial) {
        await api.savePage(scrimSidecarPath(folder, 'vodraw'), e.partial, null, 'gamewiki').catch(() => {});
      }
      const msg = {
        AUTH: ['AI backend not configured', 'Add an Anthropic API key or Claude CLI in Settings → Agents.'],
        NETWORK: ['Network error', e?.message || 'Could not reach the model.'],
        UPSTREAM: ['Model error', e?.message || 'The model returned an unexpected response.'],
        TIMEOUT: ['Report timed out', `${e?.message || 'The model ran past the time limit.'}${e?.partial ? ' — the partial answer was saved next to the scrim.' : ''}`],
      }[e?.code] || ['Report failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      setReportJob({ folder: null, phase: '', chars: 0 });
    }
  };

  // Add Notes — append a player-written .md/.txt under a `## <basename>` header
  // to the .vodnotes sidecar; the next Generate feeds it to the report prompt.
  const addVodNotes = async () => {
    const p = await pickFile(NOTES_FILTERS);
    if (!p) return;
    try {
      const text = await invoke('coaching_read_text', { path: p });
      const notesPath = scrimSidecarPath(folder, 'vodnotes');
      let existing = '';
      try { existing = (await api.getRawFileMeta(notesPath, 'gamewiki')).content; } catch { /* first notes file */ }
      const nb = p.split(/[\\/]/).pop().replace(/\.(md|txt)$/i, '');
      const next = `${existing.trim() ? `${existing.trimEnd()}\n\n` : ''}## ${nb}\n\n${String(text).trim()}\n`;
      await api.savePage(notesPath, next, null, 'gamewiki');
      notify('success', 'Notes added', `${nb} will feed the next report generation.`);
    } catch (e) {
      notify('error', 'Notes failed', e?.message || String(e));
    }
  };

  // Export the stored report to a Markdown file. This page never holds the parsed report, so the
  // .vodreport sidecar is read on export; Segments, when ticked, get the same .vodnorm name-fixes the
  // report view applies so the exported transcript matches what's shown there.
  const openExport = (e) => {
    if (exportOpen) { setExportOpen(false); return; } // toggle — outsideExempt keeps this click in
    setExportErr('');
    setExportAnchor(e.currentTarget.getBoundingClientRect());
    setExportOpen(true);
  };
  const pickExportDest = async () => {
    setExportErr('');
    try {
      const p = await save({ defaultPath: `${base} VOD Review.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (p) setExportDest(p.toLowerCase().endsWith('.md') ? p : `${p}.md`);
    } catch (e) { setExportErr(String(e?.message || e)); }
  };
  const toggleSection = (id) => setExportSel((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const doExport = async () => {
    if (!exportDest || exportSel.size === 0 || exportBusy) return;
    setExportBusy(true);
    setExportErr('');
    try {
      const report = coerceReport(JSON.parse((await api.getRawFileMeta(scrimSidecarPath(folder, 'vodreport'), 'gamewiki')).content));
      let segments = [];
      if (exportSel.has('segments')) {
        try {
          segments = parseCommsSidecar((await api.getRawFileMeta(scrimSidecarPath(folder, 'vodcomms'), 'gamewiki')).content).segments;
          try {
            const c = JSON.parse((await api.getRawFileMeta(scrimSidecarPath(folder, 'vodnorm'), 'gamewiki')).content);
            if (c.hash === transcriptHash(segments) && Array.isArray(c.corrections)) segments = applyCorrections(segments, c.corrections).segments;
          } catch { /* no norm cache → raw transcript */ }
        } catch { /* transcript unavailable → serializer writes an unavailable note */ }
      }
      const md = serializeReportMarkdown(report, exportSel, `${base} VOD Review`, segments);
      await invoke('export_report_file', { path: exportDest, content: md, reveal: true });
      notify('success', 'Exported', exportDest);
      setExportOpen(false);
    } catch (e) {
      setExportErr(String(e?.message || e));
    } finally {
      setExportBusy(false);
    }
  };

  const paneInner = overlay ? { padding: 8, fontFamily: 'var(--font-mono)', '--accent': accent } : { ...inner, '--accent': accent };
  if (err) return <div style={wrap}><div style={paneInner}><p style={{ color: 'var(--error)' }}>Couldn’t open this scrim: {err}</p></div></div>;
  if (!doc) return <div style={wrap}><div style={paneInner}><p style={{ color: 'var(--text-muted)' }}>Loading</p></div></div>;
  const fm = doc.frontmatter || {};
  const scrim = doc.scrim || {};

  return (
    <div style={wrap}>
      <div style={paneInner}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><SaveTag state={saveState} /></div>
        <EditField label="Score" value={scrim['Score']} onChange={(v) => setScrimField('Score', v)} onCommit={flushSave} placeholder="e.g. 2-1" />
        <EditField label="VOD Review" value={scrim['VOD Review']} onChange={(v) => setScrimField('VOD Review', v)} onCommit={flushSave} placeholder="/path/to/review.mp4"
          right={<>
            <RecordButton recording={rec.recTarget === 'vod'} disabled={rec.busyElsewhere('vod') || !rec.alive} accent={accent}
              onToggle={() => (rec.recTarget === 'vod' ? rec.stop() : rec.start({ kind: 'vod' }))} />
            <MiniBtn icon={IconFolder} title="Select .mp4" onClick={async () => { const p = await pickFile(MP4_FILTERS); if (p) { setScrimField('VOD Review', p); flushSave(); } }} />
            {scrim['VOD Review'] && <MiniBtn icon={IconPlayCircle} title="Open recording" onClick={() => invoke('coaching_open_path', { path: scrim['VOD Review'] }).catch(() => {})} />}
          </>} />
        <div className="candy-chip-row" style={{ marginTop: 8, marginBottom: 'var(--candy-depth)' }}>
          <button className="candy-btn" data-shape="chip"
            disabled={vodBusy.on || !scrim['VOD Review'] || !sttUp}
            onClick={extractVodComms}
            title={!scrim['VOD Review'] ? 'Set a VOD Review (.mp4) for this scrim first'
              : !sttUp ? 'Speech engine unavailable — reopen the app'
                : 'Extract VOD Comms — transcribe + split voices in the review recording'}
            style={vodBusy.on ? { opacity: 0.6, cursor: 'progress' } : undefined}>
            <span className="candy-face">{vodBusy.on ? (vodBusy.phase || 'Working') : 'Extract VOD Comms'}</span>
          </button>
          {vodBusy.on && (
            <button className="candy-btn" data-shape="chip" onClick={cancelVod} title="Cancel"><span className="candy-face">×</span></button>
          )}
          <button className="candy-btn" data-shape="chip"
            disabled={reporting || reportElsewhere || !scrim['VOD Comms'] || !aiConfigured}
            onClick={askVodReport}
            title={reportElsewhere ? 'A report is already generating for another scrim — one at a time'
              : !scrim['VOD Comms'] ? 'Extract VOD Comms first — the report reads that transcript'
                : !aiConfigured ? 'Configure an AI backend in Settings → Agents (API key or Claude CLI)'
                  : scrim['VOD Report'] ? 'Regenerate Report — re-runs the pipeline and overwrites the current report (your action-item ticks are kept)'
                    : 'Generate Report — Claude organizes the review into an action list'}
            style={reporting ? { opacity: 0.6, cursor: 'progress' } : undefined}>
            <span className="candy-face">
              {reporting
                ? `${reportJob.phase || 'Asking Claude'}${reportJob.chars ? ` ${Math.round(reportJob.chars / 1000)}k` : ''}`
                : scrim['VOD Report'] ? 'Regenerate Report' : 'Generate Report'}
            </span>
          </button>
          <button className="candy-btn" data-shape="chip" onClick={addVodNotes}
            title="Add player-written notes (.md/.txt) to feed the next report generation">
            <span className="candy-face">Add Notes</span>
          </button>
          {scrim['VOD Report'] && (
            <button className="candy-btn" data-shape="chip" onClick={() => nav('/game-wiki/' + encodePagePath(`${folder}/Report/tldr`))} title="Open the generated report">
              <span className="candy-face">Open Report</span>
            </button>
          )}
          {scrim['VOD Report'] && (
            <button className="candy-btn" data-shape="chip" data-export-trigger onClick={openExport} title="Export this report to a Markdown file">
              <span className="candy-face">Export</span>
            </button>
          )}
        </div>

        {/* Coaching Setup — the old AppWindow popup content, inline (Phase 4). */}
        <div style={{ ...sectionTitle, marginTop: 20, marginBottom: 8 }}>Coaching Setup</div>
        <RosterEditor team={fm['Coached Team'] || fm['Team 1'] || ''} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 14 }}>
          <TrackField label="Comms Track" value={fm['Comms Track'] ?? trackDefaults.comms} count={trackCount}
            onChange={(v) => { setFm('Comms Track', v); flushSave(); saveTrackDefault('comms', v); setTrackDefaults(loadTrackDefaults()); }} />
          <TrackField label="Mic Track" value={fm['Mic Track'] ?? trackDefaults.mic} count={trackCount}
            onChange={(v) => { setFm('Mic Track', v); flushSave(); saveTrackDefault('mic', v); setTrackDefaults(loadTrackDefaults()); }} />
        </div>
        <EditField label="Your Name (mic track)" value={yourName} onChange={setYourName}
          onCommit={() => { try { localStorage.setItem(LS_YOUNAME_KEY, yourName || ''); } catch { /* private mode */ } }}
          placeholder="how your mic track is labeled (default: You)" />
        <div style={{ ...sectionTitle, marginTop: 20, marginBottom: 8 }}>Matchup</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 14 }}>
          <EditField label="Team 1" value={fm['Team 1']} onChange={(v) => setFm('Team 1', v)} onCommit={flushSave} />
          <EditField label="Team 2" value={fm['Team 2']} onChange={(v) => setFm('Team 2', v)} onCommit={flushSave} />
          <EditField label="Coached Team" value={fm['Coached Team']} onChange={(v) => setFm('Coached Team', v)} onCommit={flushSave} />
          <EditField label="Date" value={fm['Date']} onChange={(v) => setFm('Date', v)} onCommit={flushSave} placeholder="YYYY-MM-DD" />
          <EditField label="Scheduled" value={fm['Scheduled']} onChange={(v) => setFm('Scheduled', v)} onCommit={flushSave} placeholder="e.g. 7:00 PM" />
        </div>
      </div>
      <ConfirmModal
        open={!!costGate}
        title="Generate this report?"
        confirmLabel="Generate"
        onCancel={() => setCostGate(null)}
        onConfirm={() => { const g = costGate; setCostGate(null); generateVodReport(g.segments); }}
      >
        {costGate && (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {costGate.noMatchData && (
              <span style={{ color: 'var(--error)' }}>No match data attached (no Match ID / Run Process). The report will run from the review transcript only — souls-curve verdicts, item-timing checks and comms cross-checks are skipped.</span>
            )}
            {reportCostNote(costGate.segments, costGate.cachedNorm).map((line, i) => <span key={i}>{line}</span>)}
          </div>
        )}
      </ConfirmModal>
      <Popover
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        outsideExempt="[data-export-trigger]"
        accent={accent}
        showClose
        title="Export VOD Review"
        style={exportAnchor ? { position: 'fixed', left: Math.min(exportAnchor.left, window.innerWidth - 308), top: Math.min(exportAnchor.bottom + 6, window.innerHeight - 300), width: 300, zIndex: 100000 } : { display: 'none' }}
        bodyStyle={{ padding: 14 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Sections to export:</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {EXPORT_SECTIONS.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                <input type="checkbox" checked={exportSel.has(s.id)} onChange={() => toggleSection(s.id)} style={{ accentColor: accent || 'var(--accent)' }} />
                {s.label}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: exportDest ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={exportDest}>
              {exportDest || 'No destination chosen'}
            </div>
            <OutlinedBtn small onClick={pickExportDest} disabled={exportBusy}>Choose</OutlinedBtn>
          </div>
          {exportErr && <div style={{ fontSize: 11.5, color: 'var(--error)' }}>{exportErr}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <PrimaryBtn small accent={accent} onClick={doExport} disabled={!exportDest || exportSel.size === 0 || exportBusy}>
              {exportBusy ? 'Exporting' : 'Export'}
            </PrimaryBtn>
          </div>
        </div>
      </Popover>
    </div>
  );
}
