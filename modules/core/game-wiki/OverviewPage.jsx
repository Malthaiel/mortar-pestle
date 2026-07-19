// OverviewPage — the scrim-level editor for `<scrimFolder>/Overview.md` (GameWiki
// Unification Phase 4, extracted from the retired ScrimViewer's overview pane).
// Score + VOD Review + the VOD pipeline chips (Extract VOD Comms → Generate
// Report → Open Report), plus the Coaching Setup content INLINE (the old
// AppWindow popup): roster, track indices, your name, and the matchup fields.
// Saving rides scrimShared's per-file useDocSave loop against Overview.md only.

import { useEffect, useRef, useState } from 'react';
import { api, invoke } from '@host/api.js';
import { navigate } from '@host/router.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import RecordButton from '@modules/studio/overlay/RecordButton.jsx';
import { IconFolder, IconPlayCircle } from '@host/components/icons.jsx';
import { useSettings } from '@host/hooks/useSettings.js';
import { parseOverview, serializeOverview, parseMatchFile } from './scrimSchema.js';
import { sidecarPath, scrimSidecarPath } from './matchData.js';
import { compileNotes, renderCoachingSummary } from './noteCompile.js';
import { parseCommsSidecar } from './commsCompile.js';
import { buildTranscriptBlock, generateReport, normalizeTranscript, transcriptHash, verifyReport } from './vodReport.js';
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

export default function OverviewPage({ folder, accent, nav = navigate, overlay = false }) {
  const { settings } = useSettings();
  const { doc, err, saveState, docRef, applyEdit, flushSave, flushIfDirty, reload } =
    useDocSave({ path: overviewPath(folder), parse: parseOverview, serialize: serializeOverview, merge: mergeOverview });

  const [sttUp, setSttUp] = useSttUp();
  const aiConfigured = useAiConfigured(settings);
  const [vodBusy, setVodBusy] = useState({ on: false, phase: '' });
  const [reporting, setReporting] = useState(false);
  const [reportPhase, setReportPhase] = useState('');
  const [yourName, setYourName] = useState(loadYourName);
  const [trackDefaults, setTrackDefaults] = useState(loadTrackDefaults);
  const [trackCount, setTrackCount] = useState(0);
  const vodRef = useRef(false);
  const reportRef = useRef(false);

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
  const generateVodReport = async () => {
    if (reportRef.current) return;
    const commsPath = scrimSidecarPath(folder, 'vodcomms');
    let segments;
    try { segments = parseCommsSidecar((await api.getRawFileMeta(commsPath, 'gamewiki')).content).segments; }
    catch { notify('error', 'No VOD comms', 'Extract VOD Comms first — the report reads that transcript.'); return; }
    if (!segments.length) { notify('error', 'Empty transcript', 'The VOD comms transcript has no segments to report on.'); return; }
    reportRef.current = true; setReporting(true);
    try {
      const fm = docRef.current?.frontmatter || {};
      const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
      const opponent = (fm['Team 1'] === coachedTeam ? fm['Team 2'] : fm['Team 1']) || '';
      const agents = await resolveAgents(settings);

      const scPath = scrimSidecarPath(folder, 'vodreport');
      let prior = null;
      try { prior = JSON.parse((await api.getRawFileMeta(scPath, 'gamewiki')).content); } catch { /* first run */ }
      let priorActionItems = [];
      try { priorActionItems = openHomework(JSON.parse((await api.getRawFileMeta(teamSidecarPath(coachedTeam), 'gamewiki')).content)); } catch { /* no team memory yet */ }
      let notesBlock = '';
      try { notesBlock = (await api.getRawFileMeta(scrimSidecarPath(folder, 'vodnotes'), 'gamewiki')).content; } catch { /* no notes */ }

      setReportPhase('Normalizing');
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

      setReportPhase('Analyzing');
      const draft = await generateReport(invoke, { transcriptBlock, teams: { opponent }, coachedTeam, priorActionItems, notesBlock, brainContext: brain.text, matchDigests, coachNotesBlock, prior }, agents);

      setReportPhase('Fact-checking');
      const { report, ran: verified } = await verifyReport(invoke, { report: draft, matchDigests, lexicon }, agents);

      report.meta.passes = [...(norm.discarded ? [] : ['normalize']), 'draft', ...(verified ? ['verify'] : [])];
      report.meta.brainSections = brain.sections.filter((s) => s.present).map((s) => s.label);
      report.meta.warnings = [...brain.warnings, ...(norm.warning ? [norm.warning] : []), ...report.meta.warnings];

      setReportPhase('Saving');
      await api.savePage(scPath, JSON.stringify(report), null, 'gamewiki');

      const stamp = new Date().toISOString().slice(0, 10);
      const count = (report.actionItems || []).length;
      applyEdit((o) => ({ ...o, scrim: { ...o.scrim, 'VOD Report': `generated ${stamp} · ${count} item${count === 1 ? '' : 's'}` } }));
      flushSave();
      nav('/game-wiki/' + encodePagePath(`${folder}/Report/tldr`));
      updateTeamProgress(coachedTeam).catch(() => {});
      notify('success', 'Report generated', `${count} action item${count === 1 ? '' : 's'}.`);
    } catch (e) {
      const msg = {
        AUTH: ['AI backend not configured', 'Add an Anthropic API key or Claude CLI in Settings → Agents.'],
        NETWORK: ['Network error', e?.message || 'Could not reach the model.'],
        UPSTREAM: ['Model error', e?.message || 'The model returned an unexpected response.'],
      }[e?.code] || ['Report failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      reportRef.current = false; setReporting(false); setReportPhase('');
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
            disabled={reporting || !scrim['VOD Comms'] || !aiConfigured}
            onClick={generateVodReport}
            title={!scrim['VOD Comms'] ? 'Extract VOD Comms first — the report reads that transcript'
              : !aiConfigured ? 'Configure an AI backend in Settings → Agents (API key or Claude CLI)'
                : 'Generate Report — Claude organizes the review into an action list'}
            style={reporting ? { opacity: 0.6, cursor: 'progress' } : undefined}>
            <span className="candy-face">{reporting ? (reportPhase || 'Asking Claude') : 'Generate Report'}</span>
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
    </div>
  );
}
