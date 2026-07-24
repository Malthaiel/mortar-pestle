// OverviewPage — the scrim-level editor for `<scrimFolder>/Overview.md` (GameWiki
// Unification Phase 4, extracted from the retired ScrimViewer's overview pane).
// SLIM since the per-match two-process redesign (VOD Report Final Improvements
// M1): reports generate ONLY inside a match, so this page is Score + VOD Review
// (legacy scrim-level recording) + Extract VOD Comms + Add Notes, plus the
// Coaching Setup content INLINE: roster, track indices, your name, matchup
// fields. Saving rides scrimShared's per-file useDocSave loop against
// Overview.md only.

import { useEffect, useRef, useState } from 'react';
import { api, invoke } from '@host/api.js';
import { navigate } from '@host/router.js';
import RecordButton from '@modules/studio/overlay/RecordButton.jsx';
import { IconFolder, IconPlayCircle } from '@host/components/icons.jsx';
import { parseOverview, serializeOverview } from './scrimSchema.js';
import { scrimSidecarPath } from './matchData.js';
import {
  useDocSave, useSttUp, useScrimRecord,
  useCommsJobBridge, notify, pickFile, trackIndex,
  loadTrackDefaults, saveTrackDefault, loadYourName, LS_YOUNAME_KEY,
  mergeOverview, overviewPath,
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

export default function OverviewPage({ folder, accent, nav = navigate, overlay = false }) {
  const { doc, err, saveState, docRef, applyEdit, flushSave, flushIfDirty, reload } =
    useDocSave({ path: overviewPath(folder), parse: parseOverview, serialize: serializeOverview, merge: mergeOverview });

  const [sttUp, setSttUp] = useSttUp();
  const [vodBusy, setVodBusy] = useState({ on: false, phase: '' });
  const [yourName, setYourName] = useState(loadYourName);
  const [trackDefaults, setTrackDefaults] = useState(loadTrackDefaults);
  const [trackCount, setTrackCount] = useState(0);
  const vodRef = useRef(false);

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

  // The scrim-level Generate Report pipeline (size gate → normalize → draft →
  // verify → save, module-scope run state) is GONE — reports generate only
  // inside a match now (VOD Report Final Improvements, locked decision 1). M4
  // rebuilds the pipeline as the per-match FINAL report generate on the same
  // vodReport.js lineage; the retired implementation lives in git history
  // (pre-M1 OverviewPage.jsx).

  // Add Notes — append a player-written .md/.txt under a `## <basename>` header
  // to the .vodnotes sidecar; the next final-report generate feeds it to the prompt.
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
          <button className="candy-btn" data-shape="chip" onClick={addVodNotes}
            title="Add player-written notes (.md/.txt) to feed the next final-report generation">
            <span className="candy-face">Add Notes</span>
          </button>
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
