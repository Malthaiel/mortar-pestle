// STT Overlay Panel — the in-game speech-to-text transcription panel (Overlay
// epic sub-plan 3; promoted from the "STT Overlay Panel (Overlay B)" prototype).
// Panel #2 of the Overlay Host, beside the Capture HUD. A pure useStt() consumer:
// OverlayHostView mounts a SECOND <SttProvider> for this panel (the app-level one
// still serves the main window), so it gets the full dictation API + the global
// F8 push-to-talk relay for free. Click the mic OR hold F8 → VU + mm:ss timer +
// streaming editable text → on `final` it auto-copies to the clipboard (host-local
// toast) and lands in a localStorage history. STT is stubbed on Windows v1
// (engineDown) — the offline state is intentional. Drag via useOverlayPanelDrag
// (CSS transform); the header is the drag handle.
import { useState, useEffect, useRef, useCallback } from 'react';
import { useStt } from '@modules/studio/overlay/SttProvider.jsx';
import RecordButton from '@modules/studio/overlay/RecordButton.jsx';
import VuMeter from '@modules/studio/overlay/VuMeter.jsx';
import TranscriptView from '@modules/studio/overlay/TranscriptView.jsx';
import { insertTranscriptToDailyLog } from '@modules/studio/overlay/insertToDailyLog.js';
import { api } from '@host/api.js';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import '@modules/studio/overlay/stt.css'; // SttPage owns this import in the main app; the host route never mounts SttPage, so pull it in ourselves for the reused .stt-vu / .stt-transcript chrome.

const HISTORY_KEY = 'overlay-stt-history';
const HISTORY_CAP = 20;
const todayDs = () => new Date().toISOString().slice(0, 10);

function loadHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function saveHistory(a) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(a)); } catch { /* quota / private mode */ } }

function rel(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function mmss(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const IconChevrons = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 11 5-5 5 5"/><path d="m7 18 5-5 5 5"/></svg>
);
const IconX = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
);

export default function SttOverlayPanel({ showToast }) {
  const { engineDown, modelReady, recording, fileBusy, vu, text, settled, toggleDictation, setText } = useStt();
  const { style: dragStyle, dragProps } = useOverlayPanelDrag('overlay-panel-stt', { x: 60, y: 40 });

  const [autoCopy, setAutoCopy] = useState(() => localStorage.getItem('overlay-stt-autocopy') !== 'off');
  const [compact, setCompact] = useState(() => localStorage.getItem('overlay-stt-compact') === 'on');
  const [history, setHistory] = useState(loadHistory);
  const [elapsed, setElapsed] = useState(0);

  // mm:ss recording timer — ticks while recording, resets on idle.
  useEffect(() => {
    if (!recording) { setElapsed(0); return undefined; }
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const pushHistory = useCallback((t) => {
    setHistory((prev) => {
      const next = [{ id: `${Date.now()}-${prev.length}`, text: t, ts: Date.now() }, ...prev].slice(0, HISTORY_CAP);
      saveHistory(next);
      return next;
    });
  }, []);

  const doCopy = useCallback(async (t) => {
    const v = (t || '').trim();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      showToast('✓ Copied', 1600);
    } catch {
      // ponytail: verify-first. If writeText throws NotAllowedError on the
      // unfocused NOACTIVATE host, add a Rust clipboard fallback — not before.
      showToast('Copy failed', 1600);
    }
  }, [showToast]);

  // Fire once per final (settled false→true): land in history + auto-copy. The
  // prevSettled guard stops re-firing while the user edits the settled text.
  const prevSettled = useRef(false);
  useEffect(() => {
    if (settled && !prevSettled.current) {
      const t = (text || '').trim();
      if (t) { pushHistory(t); if (autoCopy) doCopy(t); }
    }
    prevSettled.current = settled;
  }, [settled, text, autoCopy, doCopy, pushHistory]);

  const toggleAutoCopy = () => setAutoCopy((v) => { localStorage.setItem('overlay-stt-autocopy', v ? 'off' : 'on'); return !v; });
  const toggleCompact = () => setCompact((v) => { localStorage.setItem('overlay-stt-compact', v ? 'off' : 'on'); return !v; });

  const sendNote = async () => {
    const r = await insertTranscriptToDailyLog(text);
    showToast(r?.ok ? 'Sent to Quick Notes' : 'Send failed', 1600);
  };
  const sendTask = async () => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try { await api.daySections.addTask(todayDs(), clean); showToast('Sent to Planner', 1600); }
    catch { showToast('Send failed', 1600); }
  };
  const delHistory = (id) => setHistory((prev) => { const next = prev.filter((r) => r.id !== id); saveHistory(next); return next; });

  const micDisabled = engineDown || !modelReady || fileBusy;
  const lastResult = history[0]?.text || text;
  const statusLabel = recording ? 'Listening…' : engineDown ? 'Voice engine offline' : 'Ready · click or hold F8';
  const canSend = !!(text || '').trim();

  return (
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, ...dragStyle }}>
      <div className={`stt-overlay candy-card${compact ? ' is-compact' : ''}`}>
        <div className="stt-head" {...dragProps} style={{ touchAction: 'none' }}>
          <span className="stt-title">Transcription</span>
          <span className="stt-head-actions">
            <button type="button" className="candy-btn" data-shape="icon" data-size="small" title={compact ? 'Expand' : 'Compact'} aria-label={compact ? 'Expand' : 'Compact'} aria-pressed={compact} onClick={toggleCompact}>
              <span className="candy-face"><IconChevrons/></span>
            </button>
            <span className="stt-grip" aria-hidden="true">⠿</span>
          </span>
        </div>

        <div className="stt-rec">
          <RecordButton recording={recording} disabled={micDisabled} onToggle={toggleDictation} />
          <div className="stt-status">
            {!compact && <VuMeter rms={vu} active={recording} />}
            <div className="stt-meta">
              <span className={`stt-label${recording ? '' : ' idle'}`}>{statusLabel}</span>
              {recording && <span className="stt-timer">{mmss(elapsed)}</span>}
            </div>
          </div>
        </div>

        {compact ? (
          <div className="stt-compact-last" title={lastResult}>{lastResult || 'No transcript yet'}</div>
        ) : (
          <>
            <TranscriptView
              text={text}
              settled={settled}
              busy={recording || fileBusy}
              placeholder={engineDown ? 'Voice engine offline' : 'Your transcript appears here'}
              onChange={setText}
            />
            <div className="stt-controls">
              <button type="button" className={`candy-btn${autoCopy ? ' is-active' : ''}`} data-size="small" title="Auto-copy to clipboard on final" aria-pressed={autoCopy} onClick={toggleAutoCopy}>
                <span className="candy-face">Auto-copy</span>
              </button>
            </div>
            <div className="stt-send">
              <span className="lbl">Send</span>
              <button type="button" className="candy-btn" data-size="small" disabled={!canSend} onClick={sendNote}><span className="candy-face">Note</span></button>
              <button type="button" className="candy-btn" data-size="small" disabled={!canSend} onClick={sendTask}><span className="candy-face">Task</span></button>
              <button type="button" className="candy-btn" data-size="small" disabled={!canSend} title="Copy for Claude (paste into Concierge)" onClick={() => doCopy(text)}><span className="candy-face">Claude</span></button>
            </div>
            {history.length > 0 && (
              <div className="stt-history">
                <div className="stt-h-head">History</div>
                <div className="stt-history-scroll">
                  {history.map((r) => (
                    <div className="stt-row" key={r.id}>
                      <span className="stt-row-text" title={r.text}>{r.text}</span>
                      <span className="stt-row-ts">{rel(r.ts)}</span>
                      <button type="button" className="candy-btn" data-size="small" onClick={() => doCopy(r.text)}><span className="candy-face">Copy</span></button>
                      <button type="button" className="candy-btn" data-shape="icon" data-size="small" title="Delete" aria-label="Delete" onClick={() => delHistory(r.id)}><span className="candy-face"><IconX/></span></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
