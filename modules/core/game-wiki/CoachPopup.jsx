// CoachPopup — the gear button's window. Drives the three-phase coaching-notes
// pipeline (`Citadel/Infrastructure/Scripts/coaching/coach.py`) through the
// `coach_job_*` commands and renders whatever state the run is in.
//
// Two targets, one window:
//   { kind: 'scrim' } — the gear on a scrim folder. Creates a Match folder,
//                       because a match gear needs a match folder to sit beside
//                       and coach.py only makes one as a side effect of running.
//   { kind: 'match' } — the real thing: check → confirm → run → done.
//
// The job lives in Rust (`coach_job.rs`), NOT here: a full run is 10-20 minutes
// and closing this window must not kill it. Everything below is a view over
// `coach_job_status` plus the global `coach-job-progress` event, so re-opening
// the gear mid-run re-attaches to the same run.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { api, invoke } from '@host/api.js';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import { PrimaryBtn, OutlinedBtn, DangerOutlinedBtn } from '@host/components/ui/Button.jsx';
import { TextInput } from '@host/components/ui/Input.jsx';
import { SCRIM_BASE } from './scrimSchema.js';
import { mergeTranscripts } from './diarize.js';
import { coachTranscribe } from './coachTranscribe.js';

const TRANSCRIPT = '00-transcript.md';

// The coaching path forces the best model regardless of `settings.stt.defaultModel`.
// The `small` default invents proper nouns that were never spoken, and every invented
// name lands in `01-unmatched.md` as a term to adjudicate — 48 of them, on one match.
// Fetched on demand (574 MB, SHA-verified) the first time this runs.
const COACH_MODEL = 'large-v3-turbo-q5_0';

// Plain-words stages for the write-it-out pass, in the order they run.
const STT_STAGES = [
  'Pulling the two sounds apart',
  'Getting the listener ready',
  'Listening to you',
  'Listening to everyone else',
  'Saving',
];

// Which sound track holds what, numbered the way OBS labels them (from 1). The recording keeps
// the mic and Discord on separate tracks, so who spoke is known by construction — no voice
// matching, no guessing. `coaching_extract_audio` counts from 0, hence the -1 at the call.
//
// ponytail: hard-coded on purpose. Nothing inside the file says which track is which (every
// stream is a nameless "OBS Audio Handler"), and the broadcast engine only knows its OWN scene,
// never the OBS that made these. Job 4 makes the app record it, and then the layout is ours by
// construction and these two lines come out. A picker built now is a picker deleted then.
const MIC_TRACK = 1;    // your voice, alone
const COMMS_TRACK = 3;  // Discord — everyone else

// Everyone who is not the coach. METHOD-A §8a merges them into one Student anyway, so the
// Discord pass needs no per-person labels — one cluster id, one name.
const STUDENT = 'Student';

// `coach.py` binds phase 2 with "the coach is the speaker labelled <coach_label>, every other
// label is the Student", so this exact string has to appear in the transcript. It is read from
// the pipeline's own config rather than duplicated, because renaming it there and silently
// producing coach-less transcripts here is a wrong set of notes, not a failed run.
const COACH_CONFIG = 'Infrastructure/Scripts/coaching/config.json';
const COACH_LABEL_FALLBACK = 'Malthaiel';

async function coachLabel() {
  try {
    const raw = await api.getRawFile(COACH_CONFIG);
    return JSON.parse(raw).coach_label || COACH_LABEL_FALLBACK;
  } catch {
    return COACH_LABEL_FALLBACK;
  }
}

// One streaming `stt_*` command as a promise. Every one of them ends in a `done` event,
// and an `error` always arrives just before it — so the error is remembered and thrown
// once `done` lands, rather than racing the terminator.
function runStt(cmd, args, onEvent) {
  return new Promise((resolve, reject) => {
    let failed = null;
    const ch = new Channel();
    ch.onmessage = (ev) => {
      if (ev?.kind === 'error') { failed = `${ev.code}: ${ev.message}`; return; }
      if (ev?.kind === 'done') {
        if (failed || !ev.ok) reject(new Error(failed || 'the voice engine stopped'));
        else resolve();
        return;
      }
      onEvent?.(ev);
    };
    invoke(cmd, { ...args, onEvent: ch }).catch(reject);
  });
}

// Plain-words stage names. coach.py's own labels (Normalizer / Author / Auditor)
// are METHOD-A vocabulary and mean nothing outside the method document.
const STAGES = ['Getting ready', 'Fixing misheard words', 'Writing the notes', 'Checking the notes'];

const matchFolder = (scrim, n) => `${SCRIM_BASE}/${scrim}/Match ${n}`;

// Whole minutes since the run started — a seconds-resolution timer on a
// 20-minute job is noise.
function elapsedLabel(startedMs) {
  if (!startedMs) return '';
  const mins = Math.floor((Date.now() - startedMs) / 60000);
  return mins < 1 ? 'just started' : `${mins} min so far`;
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function Row({ children }) {
  return <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>;
}

function Note({ children }) {
  return <p style={{ opacity: 0.7, lineHeight: 1.55, margin: '0 0 14px' }}>{children}</p>;
}

// The raw coach.py output, behind the details toggle.
function Details({ lines }) {
  return (
    <pre style={{
      margin: '12px 0 0', padding: 12, maxHeight: 220, overflow: 'auto',
      background: 'var(--surface-2)', border: '1px solid var(--border-soft)',
      borderRadius: 8, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap',
    }}>{lines.join('\n')}</pre>
  );
}

export default function CoachPopup({ target, onClose, accent, onFolderChange, onOpenNotes }) {
  const [job, setJob] = useState(null);
  const [transcript, setTranscript] = useState('checking'); // checking | present | missing
  const [showDetails, setShowDetails] = useState(false);
  // null = no confirm open; otherwise the pending run's options. `{ only: 3 }` is
  // the cheap test — it re-runs just the audit over phase 1+2 output that already
  // exists, so the whole chain (spawn, stream, parse, done) is exercised for a
  // fraction of a full run.
  const [confirmRun, setConfirmRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [newMatch, setNewMatch] = useState('1');
  // The write-it-out pass: null when idle, else { stage, pct }. Unlike the coaching run
  // this lives in the window, so closing it throws the work away (the window says so).
  const [stt, setStt] = useState(null);
  // Re-render once a minute so the elapsed line advances during a run.
  const [, tick] = useState(0);

  const isMatch = target?.kind === 'match';
  const folder = isMatch ? matchFolder(target.scrim, target.match) : null;

  // Only show a job that belongs to THIS match — the cell is process-global and
  // may still hold a finished run for a different one.
  const mine = useMemo(
    () => (isMatch && job && job.scrim === target.scrim && job.matchN === target.match ? job : null),
    [job, isMatch, target],
  );
  const running = mine?.status === 'running';

  // Re-attach on mount, then follow the global event.
  useEffect(() => {
    invoke('coach_job_status').then(setJob).catch(() => {});
    const p = listen('coach-job-progress', (e) => setJob(e.payload || null));
    return () => { p.then((f) => f()).catch(() => {}); };
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [running]);

  // Is the transcript there? Re-checked whenever the window opens on a match.
  useEffect(() => {
    if (!isMatch) return undefined;
    let cancelled = false;
    setTranscript('checking');
    api.getRawFile(`${folder}/${TRANSCRIPT}`, 'gamewiki')
      .then((c) => { if (!cancelled) setTranscript(c && c.trim() ? 'present' : 'missing'); })
      .catch(() => { if (!cancelled) setTranscript('missing'); });
    return () => { cancelled = true; };
  }, [isMatch, folder]);

  const start = useCallback(async (opts = {}) => {
    setErr(null);
    setBusy(true);
    try {
      await invoke('coach_job_start', {
        scrim: target.scrim, matchN: target.match,
        fromPhase: opts.fromPhase ?? null, only: opts.only ?? null,
      });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [target]);

  const createMatch = useCallback(async () => {
    const n = parseInt(newMatch, 10);
    if (!Number.isInteger(n) || n < 1) { setErr('Type a whole number, like 1.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await api.createFolder(matchFolder(target.scrim, n), 'gamewiki');
      await onFolderChange?.();
      onClose();
    } catch (e) {
      setErr(String(e?.message || e));
      setBusy(false);
    }
  }, [newMatch, target, onFolderChange, onClose]);

  const reveal = () => invoke('coaching_reveal_path', { path: folder }).catch(() => {});

  // Listen to one sound track of the recording. `coaching_extract_audio` shells ffmpeg to pull
  // that track out on its own, and the engine hears nothing but it — so every word it returns
  // belongs to whoever that track records. The WAV is cached by file+track, so a second run
  // over the same recording skips the pulling-apart.
  const trackSegments = useCallback(async (video, obsTrack, stage) => {
    const wav = await invoke('coaching_extract_audio', { video, track: obsTrack - 1 });
    const segments = [];
    await runStt('stt_transcribe_file', { path: wav }, (ev) => {
      if (ev.kind === 'progress') setStt({ stage, pct: ev.pct });
      else if (ev.kind === 'segment' && ev.text) segments.push({ t0Ms: ev.t0Ms, t1Ms: ev.t1Ms, text: ev.text });
    });
    return segments;
  }, []);

  // Pick a recording and turn it into `00-transcript.md`. Two listening passes — your own
  // track, then everyone else's — stitched back together in time order, written straight into
  // the match folder, which flips this window to Ready.
  //
  // The `stt_*` commands are invoked directly rather than through `useStt`: SttProvider
  // mounts only in the overlay window, and this popup is in the main one.
  const transcribeVideo = useCallback(async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Recording', extensions: ['mp4', 'mkv', 'mov'] }],
    });
    if (!picked) return;
    setErr(null);
    try {
      setStt({ stage: 0, pct: null });
      const label = await coachLabel();

      setStt({ stage: 1, pct: null });
      await runStt('stt_load_model', { name: COACH_MODEL },
        (ev) => { if (ev.kind === 'progress') setStt({ stage: 1, pct: ev.pct }); });

      setStt({ stage: 2, pct: null });
      const micSegments = await trackSegments(picked, MIC_TRACK, 2);
      setStt({ stage: 3, pct: null });
      const commsSegments = await trackSegments(picked, COMMS_TRACK, 3);

      // A track that exists but holds the wrong thing yields silence, and silence would save a
      // half-empty transcript that reads as a real one. Stop and say which track was empty.
      if (!micSegments.length) {
        throw new Error(`Nothing was said on track ${MIC_TRACK} — is that the one your voice goes to?`);
      }
      if (!commsSegments.length) {
        throw new Error(`Nothing was said on track ${COMMS_TRACK} — is that the one everyone else goes to?`);
      }

      setStt({ stage: 4, pct: null });
      const body = coachTranscribe(mergeTranscripts({
        micSegments,
        // One cluster for everybody else — the pipeline merges them anyway.
        commsSegments: commsSegments.map((s) => ({ ...s, cluster: 0 })),
        micSpeaker: label,
        nameMap: { 0: STUDENT },
      }));
      await api.savePage(`${folder}/${TRANSCRIPT}`, body, null, 'gamewiki');
      setTranscript('present');
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setStt(null);
    }
  }, [folder, trackSegments]);

  const title = isMatch
    ? `Coaching notes — Match ${target.match}`
    : `${target?.scrim || 'Scrim'} — set up a match`;

  let body;

  if (!isMatch) {
    // ── Make a Match folder ──────────────────────────────────────────────────
    body = (
      <>
        <Note>
          A match needs its own folder before anything can be made for it. Pick its number and
          this creates it — then drop the written-out talk inside and use that match&apos;s own gear.
        </Note>
        <Row>
          <span>Match number</span>
          <TextInput value={newMatch} onChange={setNewMatch} accent={accent} style={{ width: 90 }} autoFocus />
          <PrimaryBtn onClick={createMatch} disabled={busy} accent={accent}>Make the folder</PrimaryBtn>
        </Row>
      </>
    );
  } else if (running) {
    // ── In flight ────────────────────────────────────────────────────────────
    const pct = mine.chunkTotal ? Math.round((100 * (mine.chunk || 0)) / mine.chunkTotal) : null;
    body = (
      <>
        <div style={{ fontSize: 15, marginBottom: 8 }}>{STAGES[mine.phase] || STAGES[0]}</div>
        <div className="candy-groove" style={{ marginBottom: 10 }}>
          <div className="candy-groove__fill"
            style={{ '--accent': accent || 'var(--accent)', width: `${pct == null ? 8 : pct}%` }} />
        </div>
        <Note>
          Step {Math.max(mine.phase, 1)} of 3
          {mine.chunkTotal ? ` · part ${mine.chunk || 0} of ${mine.chunkTotal}` : ''}
          {' · '}{money(mine.cost)} spent{' · '}{elapsedLabel(mine.startedMs)}.
          <br />You can close this window — it keeps going.
        </Note>
        <Row>
          <DangerOutlinedBtn onClick={() => invoke('coach_job_cancel').catch(() => {})}>Stop</DangerOutlinedBtn>
          <OutlinedBtn onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? 'hide details' : 'show details'}
          </OutlinedBtn>
        </Row>
        {showDetails && <Details lines={mine.lines || []} />}
      </>
    );
  } else if (mine?.status === 'done') {
    // ── Finished ─────────────────────────────────────────────────────────────
    body = (
      <>
        <Note>Done. {money(mine.cost)} spent.</Note>
        <Row>
          <PrimaryBtn accent={accent} onClick={() => { onOpenNotes?.(target.scrim, target.match); onClose(); }}>
            Open the notes
          </PrimaryBtn>
          <OutlinedBtn onClick={reveal}>Open the folder</OutlinedBtn>
          <OutlinedBtn onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? 'hide details' : 'show details'}
          </OutlinedBtn>
        </Row>
        {showDetails && <Details lines={mine.lines || []} />}
      </>
    );
  } else if (mine?.status === 'error' || mine?.status === 'cancelled') {
    // ── Stopped ──────────────────────────────────────────────────────────────
    // The message is kept exactly as the pipeline wrote it — every one of them
    // names a file and a problem, and rewording it loses the file name.
    body = (
      <>
        <Note>{mine.status === 'cancelled' ? 'Stopped by you.' : 'It stopped and could not finish.'}</Note>
        {mine.error && (
          <pre style={{
            margin: '0 0 14px', padding: 12, background: 'var(--surface-2)',
            border: '1px solid var(--border-soft)', borderRadius: 8,
            fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap',
          }}>{mine.error}</pre>
        )}
        <Note>{money(mine.cost)} was spent before it stopped.</Note>
        <Row>
          <PrimaryBtn accent={accent} disabled={busy}
            onClick={async () => { await invoke('coach_job_clear'); setJob(null); }}>Try again</PrimaryBtn>
          <OutlinedBtn onClick={reveal}>Open the folder</OutlinedBtn>
          <OutlinedBtn onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? 'hide details' : 'show details'}
          </OutlinedBtn>
        </Row>
        {showDetails && <Details lines={mine.lines || []} />}
      </>
    );
  } else if (stt) {
    // ── Writing the talk out ─────────────────────────────────────────────────
    body = (
      <>
        <div style={{ fontSize: 15, marginBottom: 8 }}>{STT_STAGES[stt.stage]}</div>
        <div className="candy-groove" style={{ marginBottom: 10 }}>
          <div className="candy-groove__fill"
            style={{ '--accent': accent || 'var(--accent)', width: `${stt.pct == null ? 8 : Math.round(stt.pct)}%` }} />
        </div>
        <Note>
          An hour of talking takes a good while — leave it be. Keep this window open: close it and
          it stops and you would have to start again.
        </Note>
      </>
    );
  } else if (transcript === 'missing') {
    // ── Nothing to work from ─────────────────────────────────────────────────
    body = (
      <>
        <Note>
          Nothing to work from yet. This needs the talk-through written out as words, saved inside
          this match&apos;s folder under the name <code>{TRANSCRIPT}</code>. Point it at the
          recording and it writes that out for you — your voice and everyone else&apos;s are kept
          on separate sound tracks, so it knows who said what without having to guess.
          Costs nothing; it all happens on your own machine.
        </Note>
        <Row>
          <PrimaryBtn accent={accent} onClick={transcribeVideo}>Write it out from a recording</PrimaryBtn>
          <OutlinedBtn onClick={reveal}>Open the folder</OutlinedBtn>
        </Row>
      </>
    );
  } else if (transcript === 'checking') {
    body = <Note>Looking&hellip;</Note>;
  } else {
    // ── Ready ────────────────────────────────────────────────────────────────
    body = (
      <>
        <Note>
          Ready. This reads the whole talk-through, writes the notes, then checks them back against
          what was actually said. It takes about ten to twenty minutes and costs real money —
          roughly a dollar for a short match, up to about six for a full hour.
        </Note>
        <Row>
          <PrimaryBtn accent={accent} disabled={busy} onClick={() => setConfirmRun({})}>Make the notes</PrimaryBtn>
          <OutlinedBtn disabled={busy} onClick={() => setConfirmRun({ only: 3 })}>Cheap test</OutlinedBtn>
          <OutlinedBtn onClick={reveal}>Open the folder</OutlinedBtn>
        </Row>
      </>
    );
  }

  return (
    <>
      <AppWindow open onClose={onClose} title={title} accent={accent} width={620} height="auto">
        <div style={{ padding: '18px 22px 22px' }}>
          {body}
          {err && <p style={{ color: 'var(--error)', marginTop: 14 }}>{err}</p>}
        </div>
      </AppWindow>
      <ConfirmModal
        open={!!confirmRun}
        title="This spends real money"
        message={confirmRun?.only === 3
          ? 'Cheap test: this only re-does the last step, checking notes that were already '
            + 'written. It needs the earlier steps to have run on this match before. A couple of '
            + 'minutes and roughly a dollar and a half. Go ahead?'
          : 'A short match costs about a dollar; a full hour of talking costs about six. '
            + 'It runs for ten to twenty minutes and you can stop it at any point, but whatever '
            + 'has already been spent stays spent. Go ahead?'}
        confirmLabel="Go ahead"
        cancelLabel="Not now"
        onCancel={() => setConfirmRun(null)}
        onConfirm={() => { const o = confirmRun; setConfirmRun(null); start(o || {}); }}
      />
    </>
  );
}
