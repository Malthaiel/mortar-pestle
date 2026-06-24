import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { insertTranscriptToDailyLog } from './insertToDailyLog.js';
import { useSettings } from '@host/hooks/useSettings.js';

// App-level STT context (registered as a module `provider` slot, so it mounts
// once near the app root in studio builds and STAYS mounted — dictation survives
// navigating away from /tools/stt; the page is a pure consumer). It owns the
// dictation + file-transcribe state, preloads the speech model on mount so the
// first record is instant, mirrors the supervisor engine status, and listens on
// the module event bus for the capture clip → transcribe hand-off.
//
// Backend surface is frozen (see Docs/Backend/STT): streaming commands take
// `onEvent: Channel`; events are { kind, ... } with camelCase fields.

// Fallback only — settings.stt.defaultModel (default 'small.en') is the real source;
// this covers the brief window before settings hydrate on first paint.
const DEFAULT_MODEL = 'base.en';

const SttCtx = createContext(null);
export const useStt = () => useContext(SttCtx);

function notify({ title, message, accent = 'var(--accent)', iconKey = 'bell', type = 'info', duration = 3000 }) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: { type, title, message, accent, iconKey, duration, dismissOnClick: true },
  }));
}

export default function SttProvider({ api, children }) {
  // Phase 5: the resident/default model + Force-CPU backend come from settings.stt
  // (replacing the hardcoded DEFAULT_MODEL). useSettings re-syncs across instances,
  // so a Force-CPU toggle in the Voice settings page reaches this always-mounted
  // provider and reloads the resident model (see the effect below).
  const { settings } = useSettings();
  const sttCfg = settings.stt || {};
  const forceCpu = !!sttCfg.forceCpu;

  const [engine, setEngine] = useState(null);       // EngineStatus { state, restartCount, lastExitCode, message } | null
  const [modelName, setModelName] = useState(() => sttCfg.defaultModel || DEFAULT_MODEL);
  const [model, setModel] = useState(null);         // { name, sha, backend } | null
  const [modelReady, setModelReady] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);

  const [mode, setMode] = useState('idle');         // 'idle' | 'dictating' | 'transcribing'
  const [recording, setRecording] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [vu, setVu] = useState(0);                  // raw RMS (VuMeter maps to dB)
  const [progress, setProgress] = useState(null);   // 0..100 | null (file mode)
  const [text, setText] = useState('');             // transcript (editable after settle)
  const [settled, setSettled] = useState(false);    // true after the terminal `final`
  const [error, setError] = useState(null);         // { code, message } | null

  const aliveRef = useRef(true);
  const segmentsRef = useRef([]);
  // Reset alive on EVERY mount — React StrictMode (dev) mounts → unmounts →
  // remounts, and a cleanup that only ever sets false would leave aliveRef
  // permanently false on the second mount, so every Channel event handler below
  // would bail and the model would never register as loaded.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // --- speech model preload (so press-to-talk is instant) ---
  // `useGpu`: null = auto (GPU-first, CPU fallback); false = Force-CPU. `setModelName`
  // tracks the resident model so the header + picker reflect what's actually loaded.
  const loadModel = useCallback((name, useGpu = null) => {
    setModelLoading(true);
    setModelReady(false);
    setError(null);
    setModelName(name);
    const ch = new Channel();
    ch.onmessage = (ev) => {
      if (!aliveRef.current) return;
      switch (ev.kind) {
        case 'model_loaded':
          setModel({ name: ev.name, sha: ev.sha, backend: ev.backend });
          setModelReady(true);
          break;
        case 'error':
          // A user-initiated cancel is a clean stop, not a failure — the `done`
          // that follows resets state; don't flash the error banner.
          if (ev.code === 'cancelled') break;
          setError({ code: ev.code, message: ev.message });
          break;
        case 'done':
          setModelLoading(false);
          break;
        default: break;
      }
    };
    api.invoke('stt_load_model', { name, useGpu, onEvent: ch }).catch((e) => {
      if (!aliveRef.current) return;
      setError({ code: 'INVOKE', message: e?.message || String(e) });
      setModelLoading(false);
    });
  }, [api]);

  // Preload the default model ONCE on mount, but ONLY if it is already cached — a
  // first-run download is a deliberate user action (no silent ~500MB fetch), per the
  // locked decision. Not cached → leave the no-model state up (the Voice page + the
  // no-model CTA offer a one-click download). Ref-guarded so settings re-syncs don't
  // re-trigger it (Set default applies on next launch, not live).
  const didPreload = useRef(false);
  useEffect(() => {
    if (didPreload.current) return;
    didPreload.current = true;
    const name = sttCfg.defaultModel || DEFAULT_MODEL;
    api.invoke('stt_list_models')
      .then((list) => {
        const entry = Array.isArray(list) ? list.find((m) => m.name === name) : null;
        if (aliveRef.current && entry?.cached) loadModel(name, forceCpu ? false : null);
      })
      .catch(() => {});
  }, [api, loadModel, sttCfg.defaultModel, forceCpu]);

  // Force-CPU toggled in Settings → reload the resident model on the new backend
  // immediately (the locked behavior). Skips the initial render via the ref.
  const prevForceCpu = useRef(forceCpu);
  useEffect(() => {
    if (prevForceCpu.current === forceCpu) return;
    prevForceCpu.current = forceCpu;
    if (modelReady || modelLoading) loadModel(modelName, forceCpu ? false : null);
  }, [forceCpu, modelName, modelReady, modelLoading, loadModel]);

  // --- supervisor engine status (drives the live indicator + unavailable state) ---
  useEffect(() => {
    let unlisten = null;
    listen('stt-engine-status', (e) => { if (aliveRef.current && e.payload) setEngine(e.payload); })
      .then((un) => { unlisten = un; }).catch(() => {});
    // Initial liveness — stt_status degrades to null when the engine is down.
    api.invoke('stt_status')
      .then((s) => {
        if (!aliveRef.current) return;
        setEngine((cur) => cur ?? (s == null ? { state: 'down', message: 'engine not running' } : { state: 'running' }));
      })
      .catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, [api]);

  // --- global STT relay: hotkey-driven dictation while unfocused ---
  // The always-on Rust relay (lib.rs) re-emits engine events as `stt-*` Tauri
  // events (raw snake_case engine data, NOT the per-call Channel's camelCase). A
  // UI session owns its per-call Channel, so we reflect ONLY a HOTKEY session here
  // — guarded on `source==='hotkey'` + a recording mirror so a UI session never
  // double-handles vu/segment/final. The transcript is appended to today's daily
  // log host-side (the relay); here we just mirror it into the panel + toast.
  const recordingRef = useRef(false);
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  const hotkeyDictatingRef = useRef(false);
  useEffect(() => {
    const subs = [
      listen('stt-dictation-started', (e) => {
        if (!aliveRef.current) return;
        // Only a HOTKEY session lacks a per-call Channel; ignore a 'client' start
        // (startDictation already drives it) and any start while already recording.
        if (e.payload?.source !== 'hotkey' || recordingRef.current) return;
        hotkeyDictatingRef.current = true;
        segmentsRef.current = [];
        setText(''); setSettled(false); setError(null); setVu(0);
        setMode('dictating'); setRecording(true);
      }),
      listen('stt-vu', (e) => {
        if (aliveRef.current && hotkeyDictatingRef.current) {
          setVu(typeof e.payload?.rms === 'number' ? e.payload.rms : 0);
        }
      }),
      listen('stt-segment', (e) => {
        if (!aliveRef.current || !hotkeyDictatingRef.current) return;
        segmentsRef.current.push({ text: e.payload?.text ?? '', t0Ms: e.payload?.t0_ms, t1Ms: e.payload?.t1_ms });
        setText(segmentsRef.current.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim());
      }),
      listen('stt-final', (e) => {
        if (!aliveRef.current || !hotkeyDictatingRef.current) return;
        setText((e.payload?.text ?? segmentsRef.current.map((s) => s.text).join(' ')).replace(/\s+/g, ' ').trim());
        setSettled(true); setRecording(false); setMode('idle'); setVu(0);
        hotkeyDictatingRef.current = false;
      }),
      listen('stt-error', (e) => {
        // A hotkey dictation failed (no per-call Channel to carry it) — clear the
        // stuck recording state + surface it. UI errors arrive on their Channel.
        if (!aliveRef.current || !hotkeyDictatingRef.current) return;
        setError({ code: e.payload?.code || 'internal', message: e.payload?.message || 'dictation failed' });
        setRecording(false); setMode('idle'); setVu(0);
        hotkeyDictatingRef.current = false;
      }),
      listen('stt-dictation-saved', (e) => {
        if (!aliveRef.current) return;
        const p = e.payload || {};
        if (p.ok) notify({ title: 'Dictation saved', message: 'Added to today’s Quick Notes' });
        else notify({ type: 'error', title: 'Dictation not saved', message: 'Couldn’t write to today’s log', accent: 'var(--error)', iconKey: 'alert', duration: 4500 });
      }),
    ];
    return () => { subs.forEach((pr) => pr.then((un) => un()).catch(() => {})); };
  }, []);

  // --- dictation (toggle) ---
  const startDictation = useCallback(() => {
    if (recording || fileBusy) return;
    segmentsRef.current = [];
    setText(''); setSettled(false); setError(null); setVu(0);
    setMode('dictating'); setRecording(true);
    const ch = new Channel();
    ch.onmessage = (ev) => {
      if (!aliveRef.current) return;
      switch (ev.kind) {
        case 'vu':
          setVu(typeof ev.rms === 'number' ? ev.rms : 0);
          break;
        case 'segment':
          segmentsRef.current.push({ text: ev.text ?? '', t0Ms: ev.t0Ms, t1Ms: ev.t1Ms });
          setText(segmentsRef.current.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim());
          break;
        case 'final':
          setText((ev.text ?? segmentsRef.current.map((s) => s.text).join(' ')).replace(/\s+/g, ' ').trim());
          setSettled(true); setRecording(false); setMode('idle'); setVu(0);
          break;
        case 'error':
          // A user-initiated cancel is a clean stop, not a failure — the `done`
          // that follows resets state; don't flash the error banner.
          if (ev.code === 'cancelled') break;
          setError({ code: ev.code, message: ev.message });
          break;
        case 'done':
          setRecording(false); setVu(0);
          if (!ev.ok) setMode('idle');
          break;
        default: break;
      }
    };
    api.invoke('stt_start_dictation', { model: modelName, useGpu: forceCpu ? false : null, onEvent: ch }).catch((e) => {
      if (!aliveRef.current) return;
      setError({ code: 'INVOKE', message: e?.message || String(e) });
      setRecording(false); setMode('idle');
    });
  }, [api, recording, fileBusy, modelName, forceCpu]);

  const stopDictation = useCallback(() => {
    if (!recording) return;
    // The engine answers + emits the terminal `final` on the dictation channel,
    // which settles the text and clears `recording`.
    api.invoke('stt_stop_dictation').catch(() => {});
  }, [api, recording]);

  const toggleDictation = useCallback(() => {
    if (recording) stopDictation(); else startDictation();
  }, [recording, startDictation, stopDictation]);

  // --- file transcription ---
  const startFileTranscribe = useCallback((path) => {
    if (!path || recording || fileBusy) return;
    segmentsRef.current = [];
    setText(''); setSettled(false); setError(null); setProgress(0);
    setMode('transcribing'); setFileBusy(true);
    const ch = new Channel();
    ch.onmessage = (ev) => {
      if (!aliveRef.current) return;
      switch (ev.kind) {
        case 'progress':
          setProgress(typeof ev.pct === 'number' ? ev.pct : null);
          break;
        case 'segment':
          segmentsRef.current.push({ text: ev.text ?? '', t0Ms: ev.t0Ms, t1Ms: ev.t1Ms });
          setText(segmentsRef.current.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim());
          break;
        case 'final':
          setText((ev.text ?? segmentsRef.current.map((s) => s.text).join(' ')).replace(/\s+/g, ' ').trim());
          setSettled(true); setFileBusy(false); setMode('idle'); setProgress(null);
          break;
        case 'error':
          // A user-initiated cancel is a clean stop, not a failure — the `done`
          // that follows resets state; don't flash the error banner.
          if (ev.code === 'cancelled') break;
          setError({ code: ev.code, message: ev.message });
          break;
        case 'done':
          setFileBusy(false); setProgress(null);
          if (!ev.ok) setMode('idle');
          break;
        default: break;
      }
    };
    api.invoke('stt_transcribe_file', { path, onEvent: ch }).catch((e) => {
      if (!aliveRef.current) return;
      setError({ code: 'INVOKE', message: e?.message || String(e) });
      setFileBusy(false); setMode('idle');
    });
  }, [api, recording, fileBusy]);

  const pickFile = useCallback(async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: 'Transcribe an audio or video file',
        filters: [
          { name: 'Audio / Video', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'opus', 'aac', 'mp4', 'mkv', 'webm', 'mov'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      const path = typeof picked === 'string' ? picked : picked?.path;
      if (path) startFileTranscribe(path);
    } catch (e) {
      if (aliveRef.current) setError({ code: 'DIALOG', message: e?.message || String(e) });
    }
  }, [startFileTranscribe]);

  const cancel = useCallback(() => {
    if (fileBusy) api.invoke('stt_cancel').catch(() => {}); // finish-then-discard
  }, [api, fileBusy]);

  // --- capture clip → transcribe hand-off (module event bus) ---
  useEffect(() => {
    if (!api?.events?.on) return undefined;
    return api.events.on('stt:transcribe-file', (payload) => {
      const p = payload?.path;
      if (p) startFileTranscribe(p);
    });
  }, [api, startFileTranscribe]);

  // --- transcript actions ---
  const copy = useCallback(async () => {
    const t = (text || '').trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      notify({ title: 'Copied', message: 'Transcript copied to clipboard' });
    } catch (e) {
      notify({ type: 'error', title: 'Copy failed', message: e?.message || '', accent: 'var(--error)', iconKey: 'alert', duration: 4000 });
    }
  }, [text]);

  const insertToNote = useCallback(async () => {
    const t = (text || '').trim();
    if (!t) return;
    try {
      const r = await insertTranscriptToDailyLog(t);
      if (r?.ok) notify({ title: 'Inserted', message: 'Added to today’s Quick Notes' });
      else notify({ type: 'error', title: 'Insert failed', message: 'Could not write to today’s log', accent: 'var(--error)', iconKey: 'alert', duration: 4000 });
    } catch (e) {
      notify({ type: 'error', title: 'Insert failed', message: e?.message || '', accent: 'var(--error)', iconKey: 'alert', duration: 4000 });
    }
  }, [text]);

  const clear = useCallback(() => {
    segmentsRef.current = [];
    setText(''); setSettled(false); setError(null); setProgress(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // --- Phase 5 model management (consumed by the Voice settings page) ---
  // Load a model live ("Use now"); honors the current Force-CPU setting.
  const useModelNow = useCallback((name) => {
    loadModel(name, forceCpu ? false : null);
  }, [loadModel, forceCpu]);

  // Drop the resident model (after deleting it from cache) → no-model state.
  const unload = useCallback(() => {
    api.invoke('stt_unload').catch(() => {});
    setModel(null); setModelReady(false);
  }, [api]);

  // Open Settings → Modules › Voice (the model-management home).
  const openSettings = useCallback(() => {
    api?.events?.emit?.('host:open-settings', { path: 'modules/stt' });
  }, [api]);

  // First-run / no-model CTA: download a model (streaming `progress`), then load it.
  // Reuses the `progress` state for the bar; on success chains into loadModel.
  const downloadModel = useCallback((name) => {
    setError(null); setModelLoading(true); setProgress(0);
    const ch = new Channel();
    ch.onmessage = (ev) => {
      if (!aliveRef.current) return;
      switch (ev.kind) {
        case 'progress':
          setProgress(typeof ev.pct === 'number' ? ev.pct : null);
          break;
        case 'error':
          // User-cancelled download (Settings) → clean stop, not an error.
          if (ev.code !== 'cancelled') setError({ code: ev.code, message: ev.message });
          setModelLoading(false); setProgress(null);
          break;
        case 'done':
          setProgress(null);
          if (ev.ok) loadModel(name, forceCpu ? false : null);
          else setModelLoading(false);
          break;
        default: break;
      }
    };
    api.invoke('stt_download_model', { name, onEvent: ch }).catch((e) => {
      if (!aliveRef.current) return;
      setError({ code: 'INVOKE', message: e?.message || String(e) });
      setModelLoading(false); setProgress(null);
    });
  }, [api, loadModel, forceCpu]);

  const engineDown = !!engine && (engine.state === 'down' || engine.state === 'failed');

  const value = useMemo(() => ({
    engine, engineDown,
    modelName, model, modelReady, modelLoading,
    mode, recording, fileBusy, vu, progress, text, settled, error,
    startDictation, stopDictation, toggleDictation,
    startFileTranscribe, pickFile, cancel,
    setText, copy, insertToNote, clear, clearError, loadModel,
    useModelNow, unload, openSettings, downloadModel,
  }), [
    engine, engineDown, modelName, model, modelReady, modelLoading,
    mode, recording, fileBusy, vu, progress, text, settled, error,
    startDictation, stopDictation, toggleDictation,
    startFileTranscribe, pickFile, cancel,
    copy, insertToNote, clear, clearError, loadModel,
    useModelNow, unload, openSettings, downloadModel,
  ]);

  return <SttCtx.Provider value={value}>{children}</SttCtx.Provider>;
}
