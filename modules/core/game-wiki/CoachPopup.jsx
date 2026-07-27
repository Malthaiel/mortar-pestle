// CoachPopup — the gear button's window. Drives the three-phase coaching-notes
// pipeline (`Citadel/Infrastructure/Scripts/coaching/coach.py`) through the
// `coach_job_*` commands and renders whatever state the run is in.
//
// Two targets, one window:
//   { kind: 'scrim' } — the gear on a scrim folder. Creates a Match folder,
//                       because a match gear needs a match folder to sit beside
//                       and coach.py only makes one as a side effect of running.
//   { kind: 'match' } — the real thing: check → confirm → run → gate → done.
//
// The job lives in Rust (`coach_job.rs`), NOT here: a full run is 10-20 minutes
// and closing this window must not kill it. Everything below is a view over
// `coach_job_status` plus the global `coach-job-progress` event, so re-opening
// the gear mid-run re-attaches to the same run.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, invoke } from '@host/api.js';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import { PrimaryBtn, OutlinedBtn, DangerOutlinedBtn } from '@host/components/ui/Button.jsx';
import { FilterChip } from '@host/components/ui/Pill.jsx';
import { TextInput } from '@host/components/ui/Input.jsx';
import { SCRIM_BASE } from './scrimSchema.js';

const TRANSCRIPT = '00-transcript.md';
const PROTECTED = `${SCRIM_BASE.replace(/\/Scrim$/, '')}/Method/protected-terms.md`;

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
  const [confirmRun, setConfirmRun] = useState(false);
  const [keep, setKeep] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [newMatch, setNewMatch] = useState('1');
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
        fromPhase: opts.fromPhase ?? null, only: opts.only ?? null, noGate: opts.noGate ?? false,
      });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [target]);

  // "Keep these and continue": the ticked words go into the anti-match list so
  // the pipeline stops second-guessing them, then the run resumes at phase 2.
  // The list is hand-edited by design, so this appends a dated section rather
  // than merging into an existing one.
  const keepAndContinue = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const words = mine.gateTerms.filter((t) => keep.has(t));
      if (words.length) {
        const r = await api.getRawFileMeta(PROTECTED, 'gamewiki');
        const stamp = new Date().toISOString().slice(0, 10);
        const block = `\n## Kept from a review stop (${stamp})\n\n${words.map((w) => `- ${w}`).join('\n')}\n`;
        await api.savePage(PROTECTED, r.content.replace(/\s*$/, '\n') + block, r.mtime, 'gamewiki');
      }
      await invoke('coach_job_clear');
      await start({ fromPhase: 2 });
    } catch (e) {
      setErr(String(e?.message || e));
      setBusy(false);
    }
  }, [mine, keep, start]);

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
  } else if (mine?.status === 'gate') {
    // ── The review stop ──────────────────────────────────────────────────────
    body = (
      <>
        <Note>
          It stopped part-way. These are words it heard but couldn&apos;t place. Tap any that are a
          real person, a nickname, a joke or a build name — those get remembered and left alone from
          now on. Leave the rest untapped.
        </Note>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 260, overflowY: 'auto', marginBottom: 16 }}>
          {mine.gateTerms.map((t, i) => (
            <FilterChip key={`${t}-${i}`} active={keep.has(t)} accent={accent}
              onClick={() => setKeep((s) => {
                const next = new Set(s);
                if (next.has(t)) next.delete(t); else next.add(t);
                return next;
              })}>{t}</FilterChip>
          ))}
        </div>
        <Row>
          <PrimaryBtn onClick={keepAndContinue} disabled={busy} accent={accent}>
            {keep.size ? `Keep ${keep.size} and carry on` : 'Carry on'}
          </PrimaryBtn>
          <OutlinedBtn onClick={async () => { await invoke('coach_job_clear'); start({ noGate: true }); }} disabled={busy}>
            Start over without this check
          </OutlinedBtn>
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
  } else if (transcript === 'missing') {
    // ── Nothing to work from ─────────────────────────────────────────────────
    body = (
      <>
        <Note>
          Nothing to work from yet. This needs the talk-through written out as words, saved inside
          this match&apos;s folder under the name <code>{TRANSCRIPT}</code>.
        </Note>
        <Row>
          <PrimaryBtn accent={accent} onClick={reveal}>Open the folder</PrimaryBtn>
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
          <PrimaryBtn accent={accent} disabled={busy} onClick={() => setConfirmRun(true)}>Make the notes</PrimaryBtn>
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
        open={confirmRun}
        title="This spends real money"
        message={'A short match costs about a dollar; a full hour of talking costs about six. '
          + 'It runs for ten to twenty minutes and you can stop it at any point, but whatever has '
          + 'already been spent stays spent. Go ahead?'}
        confirmLabel="Go ahead"
        cancelLabel="Not now"
        onCancel={() => setConfirmRun(false)}
        onConfirm={() => { setConfirmRun(false); start(); }}
      />
    </>
  );
}
