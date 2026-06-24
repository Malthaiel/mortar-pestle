// STT verification panel — THROWAWAY dev tool (lives in the DEV-gated DevTab
// chunk). Exercises the Voice Transcription Rust backend end-to-end so a human
// can gate it: load a model, transcribe a .wav, and press-to-talk dictate with
// a live VU meter + VAD segments. Mirrors DevServerPanel's structure/styling.
//
// Backend command surface (Rust snake_case params → JS camelCase invoke args):
//   stt_load_model      { name, onEvent }                                  (streaming)
//   stt_transcribe_file { path, onEvent }                                  (streaming)
//   stt_start_dictation { model, vadThreshold?, hangoverMs?, onEvent }     (streaming)
//   stt_stop_dictation  {}      → backend emits a terminal 'final'
//   stt_cancel          {}
//   stt_unload          {}
//   stt_status          {}      → opaque object | null
//
// SttEvent wire shape (Channel `ev`, internally tagged by `kind`):
//   { kind:'model_loaded', name, sha, backend }
//   { kind:'progress', pct }                    // 0..=100
//   { kind:'segment', text, t0Ms, t1Ms }        // text "" until SF3
//   { kind:'final', text }                      // terminal for file + stop_dictation
//   { kind:'vu', rms }                          // ~25 Hz mic level during dictation
//   { kind:'error', code, message }
//   { kind:'done', ok }                         // ALWAYS the last streaming event
import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { PrimaryBtn, OutlinedBtn, TextInput } from '../ui/index.js';
import { invoke } from '../../api.js';

const mono = { fontFamily: 'var(--font-mono)', fontSize: 11 };
const EVENT_LOG_CAP = 20;

function SectionLabel({ children, style }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
      textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
      margin: '20px 0 10px', ...style,
    }}>{children}</div>
  );
}

// Mirror api.js's toast channel: surfaced errors escalate to a notification.
function emitErrorToast(message) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: { type: 'note-error', title: 'STT', message: String(message || ''), accent: 'var(--error)', iconKey: 'alert', duration: 5000 },
  }));
}

// One-line summary of an SttEvent for the raw event log.
function fmtEvent(ev) {
  if (!ev || typeof ev !== 'object') return String(ev);
  switch (ev.kind) {
    case 'model_loaded': return `model_loaded · ${ev.name} · ${ev.backend} · ${shortSha(ev.sha)}`;
    case 'progress':     return `progress · ${ev.pct}%`;
    case 'segment':      return `segment · ${ev.t0Ms}→${ev.t1Ms}ms · "${ev.text ?? ''}"`;
    case 'final':        return `final · "${ev.text ?? ''}"`;
    case 'vu':           return `vu · ${typeof ev.rms === 'number' ? ev.rms.toFixed(3) : ev.rms}`;
    case 'error':        return `error · ${ev.code} · ${ev.message}`;
    case 'done':         return `done · ok=${ev.ok}`;
    default:             return JSON.stringify(ev);
  }
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length > 10 ? sha.slice(0, 10) : (sha ?? '—');
}

export default function SttDevPanel({ accent }) {
  const aliveRef = useRef(true);
  // Set true on (re)mount, not just at declaration: React 18 StrictMode dev does
  // mount → unmount → remount, and the cleanup below fires `false` on that throwaway
  // unmount. Without re-setting `true` here the ref stays false forever and every
  // guarded state write (incl. `done → setModelBusy(false)`) is silently dropped.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // shared raw event log (newest last, capped)
  const [events, setEvents] = useState([]);
  const pushEvent = useCallback((ev) => {
    if (!aliveRef.current) return;
    setEvents((prev) => {
      const next = [...prev, { t: Date.now(), text: fmtEvent(ev) }];
      return next.length > EVENT_LOG_CAP ? next.slice(next.length - EVENT_LOG_CAP) : next;
    });
  }, []);

  // shared error line (last 'error' event or thrown invoke)
  const [lastError, setLastError] = useState(null);
  const noteError = useCallback((code, message) => {
    if (!aliveRef.current) return;
    setLastError({ code: code || 'ERROR', message: message || '' });
    emitErrorToast(message || code);
  }, []);

  // ---------------- Model section ----------------
  const [modelName, setModelName] = useState('base.en');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelPct, setModelPct] = useState(null);   // download progress, or null
  const [modelInfo, setModelInfo] = useState(null); // { name, sha, backend }

  const loadModel = useCallback(() => {
    if (modelBusy) return;
    setModelBusy(true);
    setModelPct(null);
    const ch = new Channel();
    ch.onmessage = (ev) => {
      pushEvent(ev);
      if (!aliveRef.current) return;
      switch (ev.kind) {
        case 'progress': setModelPct(ev.pct); break;
        case 'model_loaded': setModelInfo({ name: ev.name, sha: ev.sha, backend: ev.backend }); break;
        case 'error': noteError(ev.code, ev.message); break;
        case 'done': setModelBusy(false); setModelPct(null); break;
        default: break;
      }
    };
    invoke('stt_load_model', { name: modelName.trim(), onEvent: ch }).catch((e) => {
      noteError('INVOKE', e?.message || String(e));
      if (aliveRef.current) { setModelBusy(false); setModelPct(null); }
    });
  }, [modelBusy, modelName, pushEvent, noteError]);

  // ---------------- File transcribe section ----------------
  const [filePath, setFilePath] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [filePct, setFilePct] = useState(null);
  const [fileSegments, setFileSegments] = useState([]); // accumulated segment texts
  const [fileFinal, setFileFinal] = useState('');

  const transcribeFile = useCallback(() => {
    if (fileBusy) return;
    const path = filePath.trim();
    if (!path) { noteError('INPUT', 'Enter an absolute .wav path'); return; }
    setFileBusy(true);
    setFilePct(null);
    setFileSegments([]);
    setFileFinal('');
    const ch = new Channel();
    ch.onmessage = (ev) => {
      pushEvent(ev);
      if (!aliveRef.current) return;
      switch (ev.kind) {
        case 'progress': setFilePct(ev.pct); break;
        case 'segment':
          if (ev.text) setFileSegments((prev) => [...prev, ev.text]);
          break;
        case 'final': setFileFinal(ev.text ?? ''); break;
        case 'error': noteError(ev.code, ev.message); break;
        case 'done': setFileBusy(false); setFilePct(null); break;
        default: break;
      }
    };
    invoke('stt_transcribe_file', { path, onEvent: ch }).catch((e) => {
      noteError('INVOKE', e?.message || String(e));
      if (aliveRef.current) { setFileBusy(false); setFilePct(null); }
    });
  }, [fileBusy, filePath, pushEvent, noteError]);

  // ---------------- Dictation section ----------------
  const [dictModel, setDictModel] = useState('base.en');
  const [vadThreshold, setVadThreshold] = useState('0.5');
  const [hangoverMs, setHangoverMs] = useState('300');
  const [dictActive, setDictActive] = useState(false);
  const [vu, setVu] = useState(0);          // smoothed/scaled 0..1 for the meter
  const [dictSegments, setDictSegments] = useState([]); // [{ t0Ms, t1Ms, text }]
  const [dictFinal, setDictFinal] = useState('');

  const startDictation = useCallback(() => {
    if (dictActive) return;
    setDictActive(true);
    setVu(0);
    setDictSegments([]);
    setDictFinal('');
    const args = { model: dictModel.trim(), onEvent: undefined };
    const vt = parseFloat(vadThreshold);
    const ho = parseInt(hangoverMs, 10);
    if (Number.isFinite(vt)) args.vadThreshold = vt;
    if (Number.isFinite(ho)) args.hangoverMs = ho;
    const ch = new Channel();
    ch.onmessage = (ev) => {
      pushEvent(ev);
      if (!aliveRef.current) return;
      switch (ev.kind) {
        case 'vu': {
          // Dev meter: amplify (×3) so speech is clearly visible, clamp 0..1.
          const rms = typeof ev.rms === 'number' ? ev.rms : 0;
          setVu(Math.max(0, Math.min(1, rms * 3)));
          break;
        }
        case 'segment':
          setDictSegments((prev) => [...prev, { t0Ms: ev.t0Ms, t1Ms: ev.t1Ms, text: ev.text ?? '' }]);
          break;
        case 'final': setDictFinal(ev.text ?? ''); break;
        case 'error': noteError(ev.code, ev.message); break;
        case 'done': setDictActive(false); setVu(0); break;
        default: break;
      }
    };
    args.onEvent = ch;
    invoke('stt_start_dictation', args).catch((e) => {
      noteError('INVOKE', e?.message || String(e));
      if (aliveRef.current) { setDictActive(false); setVu(0); }
    });
  }, [dictActive, dictModel, vadThreshold, hangoverMs, pushEvent, noteError]);

  const stopDictation = useCallback(() => {
    // The backend emits a terminal 'final' (then 'done') which flips dictActive.
    invoke('stt_stop_dictation').catch((e) => noteError('INVOKE', e?.message || String(e)));
  }, [noteError]);

  // ---------------- Utility buttons ----------------
  const [statusJson, setStatusJson] = useState(null);
  const runStatus = useCallback(async () => {
    try {
      const r = await invoke('stt_status');
      if (aliveRef.current) setStatusJson(r === null ? 'null' : JSON.stringify(r, null, 2));
    } catch (e) { noteError('INVOKE', e?.message || String(e)); }
  }, [noteError]);
  const runUnload = useCallback(async () => {
    try { await invoke('stt_unload'); if (aliveRef.current) { setModelInfo(null); setStatusJson(null); } }
    catch (e) { noteError('INVOKE', e?.message || String(e)); }
  }, [noteError]);
  const runCancel = useCallback(async () => {
    try { await invoke('stt_cancel'); }
    catch (e) { noteError('INVOKE', e?.message || String(e)); }
  }, [noteError]);

  // ------------------------------------------------------------- render ----
  return (
    <div style={{ maxWidth: 680 }}>
      <SectionLabel style={{ marginTop: 0 }}>Voice Transcription (STT)</SectionLabel>
      <div style={{ ...mono, color: 'var(--text-muted)', marginBottom: 12 }}>
        End-to-end verify · load model → transcribe file → press-to-talk dictate
      </div>

      {lastError && (
        <div style={{ ...mono, color: 'var(--error)', marginBottom: 12, fontWeight: 700 }} title={lastError.message}>
          ✕ {lastError.code}: {lastError.message}
        </div>
      )}

      {/* ---- Model ---- */}
      <SectionLabel style={{ marginTop: 0 }}>Model</SectionLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextInput value={modelName} onChange={setModelName} accent={accent}
          placeholder="base.en" disabled={modelBusy} style={{ width: 160, ...mono }} />
        <PrimaryBtn small accent={accent} onClick={loadModel} disabled={modelBusy}>
          {modelBusy ? 'Loading…' : 'Load model'}
        </PrimaryBtn>
      </div>
      <div style={{ ...mono, marginTop: 8, lineHeight: 1.6, color: 'var(--text-muted)', minHeight: 16 }}>
        {modelPct != null && <span>⟳ downloading {modelPct}%</span>}
        {modelPct == null && modelInfo && (
          <span>
            <span style={{ color: '#4fc878', fontWeight: 700 }}>●</span>{' '}
            loaded {modelInfo.name} · {modelInfo.backend} · <span style={{ color: 'var(--text-faint)' }}>{shortSha(modelInfo.sha)}</span>
          </span>
        )}
        {modelPct == null && !modelInfo && <span style={{ color: 'var(--text-faint)' }}>—</span>}
      </div>

      {/* ---- File transcribe ---- */}
      <SectionLabel>Transcribe file</SectionLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextInput value={filePath} onChange={setFilePath} accent={accent}
          placeholder="/abs/path/to/audio.wav" disabled={fileBusy} style={{ width: 360, ...mono }} />
        <PrimaryBtn small accent={accent} onClick={transcribeFile} disabled={fileBusy}>
          {fileBusy ? 'Transcribing…' : 'Transcribe'}
        </PrimaryBtn>
      </div>
      <div style={{ ...mono, color: 'var(--text-faint)', marginTop: 6 }}>
        Tip: paste the absolute path to <b>iskariel-stt/tests/fixtures/jfk.wav</b> (relative to repo root).
      </div>
      <div style={{ ...mono, marginTop: 8, lineHeight: 1.6, color: 'var(--text-muted)', minHeight: 16 }}>
        {filePct != null
          ? <span>⟳ {filePct}%</span>
          : (fileSegments.length || fileFinal)
            ? <span style={{ color: 'var(--text-faint)' }}>{fileSegments.length} segment(s)</span>
            : <span style={{ color: 'var(--text-faint)' }}>—</span>}
      </div>
      {(fileFinal || fileSegments.length > 0) && (
        <textarea readOnly value={fileFinal || fileSegments.join(' ')}
          style={{
            ...mono, width: '100%', maxWidth: 560, minHeight: 70, marginTop: 6,
            padding: '8px 10px', resize: 'vertical', color: 'var(--text)',
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 8, outline: 'none', whiteSpace: 'pre-wrap',
          }} />
      )}

      {/* ---- Dictation ---- */}
      <SectionLabel>Dictation (press-to-talk)</SectionLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ ...mono, color: 'var(--text-faint)' }}>model</label>
        <TextInput value={dictModel} onChange={setDictModel} accent={accent}
          placeholder="base.en" disabled={dictActive} style={{ width: 120, ...mono }} />
        <label style={{ ...mono, color: 'var(--text-faint)' }}>vadThreshold</label>
        <TextInput value={vadThreshold} onChange={setVadThreshold} accent={accent} type="number"
          placeholder="0.5" disabled={dictActive} style={{ width: 70, ...mono }} />
        <label style={{ ...mono, color: 'var(--text-faint)' }}>hangoverMs</label>
        <TextInput value={hangoverMs} onChange={setHangoverMs} accent={accent} type="number"
          placeholder="300" disabled={dictActive} style={{ width: 70, ...mono }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <PrimaryBtn small accent={accent} onClick={startDictation} disabled={dictActive}>▶ Start</PrimaryBtn>
        <OutlinedBtn small onClick={stopDictation} disabled={!dictActive}>■ Stop</OutlinedBtn>
        {dictActive && <span style={{ ...mono, color: '#4fc878', fontWeight: 700 }}>● live</span>}
      </div>
      {/* live VU meter */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ ...mono, color: 'var(--text-faint)', width: 28 }}>VU</span>
        <div style={{
          flex: 1, maxWidth: 360, height: 12, borderRadius: 6,
          background: 'var(--surface-2)', border: '1px solid var(--border)', overflow: 'hidden',
        }}>
          <div style={{
            width: `${Math.round(vu * 100)}%`, height: '100%',
            background: accent || 'var(--accent)',
            transition: 'width 60ms linear',
          }} />
        </div>
        <span style={{ ...mono, color: 'var(--text-faint)', width: 36 }}>{vu.toFixed(2)}</span>
      </div>
      {/* VAD segments */}
      <div style={{ ...mono, marginTop: 6, lineHeight: 1.6, color: 'var(--text-muted)', maxHeight: 120, overflowY: 'auto' }}>
        {dictSegments.length === 0 && <span style={{ color: 'var(--text-faint)' }}>no segments yet</span>}
        {dictSegments.map((s, i) => (
          <div key={i}>
            <span style={{ color: 'var(--text-faint)' }}>{s.t0Ms}→{s.t1Ms}ms</span>
            {s.text ? <> · {s.text}</> : ''}
          </div>
        ))}
      </div>
      {dictFinal && (
        <div style={{ ...mono, marginTop: 6, color: 'var(--text)' }}>
          <span style={{ color: 'var(--text-faint)' }}>final:</span> {dictFinal}
        </div>
      )}

      {/* ---- Utility ---- */}
      <SectionLabel>Utility</SectionLabel>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <OutlinedBtn small onClick={runStatus}>↻ Status</OutlinedBtn>
        <OutlinedBtn small onClick={runUnload}>Unload</OutlinedBtn>
        <OutlinedBtn small onClick={runCancel}>Cancel</OutlinedBtn>
      </div>
      {statusJson != null && (
        <pre style={{
          ...mono, marginTop: 8, padding: '8px 10px', color: 'var(--text-muted)',
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 8, overflowX: 'auto', maxWidth: 560, whiteSpace: 'pre-wrap',
        }}>{statusJson}</pre>
      )}

      {/* ---- Raw event log ---- */}
      <SectionLabel>Event log (last {EVENT_LOG_CAP})</SectionLabel>
      <div style={{
        ...mono, lineHeight: 1.6, color: 'var(--text-muted)',
        background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 10px', maxWidth: 560, maxHeight: 180, overflowY: 'auto',
      }}>
        {events.length === 0 && <span style={{ color: 'var(--text-faint)' }}>—</span>}
        {events.map((e, i) => (
          <div key={i} style={{ color: e.text.startsWith('error') ? 'var(--error)' : undefined }}>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}
