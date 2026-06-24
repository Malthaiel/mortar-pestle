// Voice settings page (Settings → Modules › Voice, Phase 5 SF3). A stacked
// candy-row model picker (Download / Use now / Set default / Delete, where
// download ≠ activate), a Force-CPU backend toggle with a live backend readout,
// and VAD sensitivity + hangover sliders. The model list + cache status come from
// the engine (stt_list_models); the resident model + load actions come from the
// always-mounted SttProvider (useStt). Persists to settings.stt. Primitives mirror
// the sibling CaptureSettingsTab + SoundsTab (section-primitives, EnableToggle,
// the ModulePage candy-btn recipe, the DownloadsPanel progress bar).

import { useCallback, useEffect, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SectionBand, Row, StackedRow } from '@host/components/settings/section-primitives.jsx';
import EnableToggle from '@host/components/ui/EnableToggle.jsx';
import { useStt } from './SttProvider.jsx';

function notify({ title, message, type = 'info', accent = 'var(--accent)', iconKey = 'bell', duration = 3000 }) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: { type, title, message, accent, iconKey, duration, dismissOnClick: true },
  }));
}
const errorNotify = (title, message) =>
  notify({ type: 'error', title, message, accent: 'var(--error)', iconKey: 'alert', duration: 4500 });

const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

function backendLabel(b) {
  if (b === 'vulkan') return 'Vulkan (GPU)';
  if (b === 'cuda') return 'CUDA (GPU)';
  if (b === 'cpu') return 'CPU';
  return b;
}

const hint = { fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5, paddingTop: 2 };
const mono = { fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 600 };
const slider = (accent) => ({ width: '100%', accentColor: accent });
const badgeStyle = (accent) => ({
  fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase',
  padding: '1px 6px', borderRadius: 'var(--radius-sm)',
  background: `color-mix(in oklch, ${accent} 18%, transparent)`, color: accent,
});
const kbd = {
  fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text)',
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '2px 8px', whiteSpace: 'nowrap',
};

// Compact candy action button (the ModulePage back-button recipe). `.candy-face`
// is pointer-events:none, so the click lands on the <button>.
function PickerBtn({ onClick, accent, children, title, disabled, tone }) {
  return (
    <button
      type="button" className="candy-btn" data-shape="row" data-own-press
      onClick={onClick} title={title} disabled={disabled}
      style={{ '--accent': tone || accent, width: 'auto', flexShrink: 0, opacity: disabled ? 0.5 : 1 }}
    >
      <span className="candy-face" style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, justifyContent: 'center', whiteSpace: 'nowrap' }}>
        {children}
      </span>
    </button>
  );
}

function useModelList() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const refresh = useCallback(() => {
    invoke('stt_list_models')
      .then((list) => { setModels(Array.isArray(list) ? list : []); setErr(null); })
      .catch((e) => setErr(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { models, loading, err, refresh };
}

// Live global-shortcut snapshot — seeded from stt_status().hotkeys, then kept fresh
// by the `stt-hotkeys` relay event (initial bind / ShortcutsChanged / rebind). A
// self-contained settings-local hook, mirroring CaptureSettingsTab's useCaptureSnapshot
// (the snapshot is a Settings concern; the SttProvider owns dictation, not hotkeys).
function useSttHotkeys() {
  const [hotkeys, setHotkeys] = useState(null);
  useEffect(() => {
    let alive = true;
    invoke('stt_status')
      .then((s) => { if (alive && s?.hotkeys) setHotkeys(s.hotkeys); })
      .catch(() => {});
    const sub = listen('stt-hotkeys', (e) => { if (e.payload) setHotkeys(e.payload); });
    return () => { alive = false; sub.then((un) => un()).catch(() => {}); };
  }, []);
  return hotkeys;
}

// Push-to-talk band — the live (read-only) trigger + a rebind path. `can_configure`
// (portal v2+) lights an in-place Rebind; the KDE Shortcuts deep-link is always the
// fallback. The trigger is shown, never hidden (the no-hidden-keybind rule); it is
// rebound through the compositor, not in-app. Clone of CaptureSettingsTab's HotkeyRows.
function PushToTalkBand({ accent }) {
  const hk = useSttHotkeys();
  const shortcuts = hk?.shortcuts || [];
  const rebind = () => invoke('stt_rebind_hotkeys').catch(() => {});
  const openKde = () => invoke('stt_open_kde_settings').catch(() => {});
  return (
    <SectionBand title="Push-to-talk" anchor="set-stt-hotkeys">
      {!hk?.bound ? (
        <div style={hint}>{hk?.last_error ? `Shortcut unavailable: ${hk.last_error}` : 'Shortcut not bound yet.'}</div>
      ) : shortcuts.length === 0 ? (
        <div style={hint}>No shortcut bound.</div>
      ) : shortcuts.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{s.description || s.id}</span>
          <span style={kbd}>{s.trigger_description || '—'}</span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, flexWrap: 'wrap' }}>
        {hk?.can_configure && <PickerBtn onClick={rebind} accent={accent} title="Reconfigure in place">Rebind…</PickerBtn>}
        <PickerBtn onClick={openKde} accent={accent} title="Open KDE global shortcuts">Open KDE Shortcuts</PickerBtn>
      </div>
      <div style={hint}>
        Hold the shortcut to dictate while the app is unfocused — on release the transcript is appended to today’s Quick Notes.{' '}
        {hk?.can_configure ? 'Use Rebind to reconfigure in place.' : 'Reconfigure it in KDE System Settings → Shortcuts.'}
      </div>
    </SectionBand>
  );
}

export default function SttSettingsTab({ settings, setSetting, accent }) {
  const stt = settings.stt || {};
  const accentColor = accent || 'var(--accent)';
  const { models, loading, err, refresh } = useModelList();
  const sttCtx = useStt();
  const resident = sttCtx?.model?.name || null;
  const backend = sttCtx?.model?.backend || null;

  const [progress, setProgress] = useState({});      // name -> pct (downloading)
  const [confirmDel, setConfirmDel] = useState(null); // model name pending delete confirm

  const download = useCallback((name) => {
    setProgress((p) => ({ ...p, [name]: 0 }));
    const ch = new Channel();
    ch.onmessage = (ev) => {
      switch (ev.kind) {
        case 'progress':
          setProgress((p) => ({ ...p, [name]: typeof ev.pct === 'number' ? ev.pct : 0 }));
          break;
        case 'error':
          // A user cancel surfaces as code 'cancelled' — not a failure toast.
          if (ev.code !== 'cancelled') errorNotify('Download failed', ev.message || ev.code || name);
          setProgress((p) => { const n = { ...p }; delete n[name]; return n; });
          break;
        case 'done':
          setProgress((p) => { const n = { ...p }; delete n[name]; return n; });
          if (ev.ok) { notify({ title: 'Downloaded', message: `${name} is ready`, accent: accentColor }); refresh(); }
          break;
        default: break;
      }
    };
    invoke('stt_download_model', { name, onEvent: ch }).catch((e) => {
      errorNotify('Download failed', e?.message || String(e));
      setProgress((p) => { const n = { ...p }; delete n[name]; return n; });
    });
  }, [refresh, accentColor]);

  // Reuses the shared cancel flag (stt_cancel) — the worker's download loop honors
  // it (SF1). Serialized with transcription, so it only aborts the download.
  const cancelDownload = useCallback(() => { invoke('stt_cancel').catch(() => {}); }, []);

  const doDelete = useCallback((name) => {
    setConfirmDel(null);
    invoke('stt_delete_model', { name })
      .then(() => {
        // Repoint the default if we deleted it → another cached model, else base.en.
        if (stt.defaultModel === name) {
          const fallback = models.find((m) => m.cached && m.name !== name)?.name || 'base.en';
          setSetting('stt', { defaultModel: fallback });
        }
        // Unload if it was the resident model (→ no-model state in the Voice page).
        if (resident === name) sttCtx?.unload?.();
        notify({ title: 'Deleted', message: `${name} removed from cache`, accent: accentColor });
        refresh();
      })
      .catch((e) => errorNotify('Delete failed', e?.message || String(e)));
  }, [stt.defaultModel, models, resident, sttCtx, setSetting, refresh, accentColor]);

  const setDefault = useCallback((name) => {
    setSetting('stt', { defaultModel: name });
    notify({ title: 'Default set', message: `${name} loads on launch`, accent: accentColor });
  }, [setSetting, accentColor]);

  const useNow = useCallback((name) => {
    sttCtx?.useModelNow?.(name);
    notify({ title: 'Loading model', message: `Switching to ${name}…`, accent: accentColor });
  }, [sttCtx, accentColor]);

  const toggleForceCpu = useCallback((next) => setSetting('stt', { forceCpu: !!next }), [setSetting]);
  const setVad = useCallback((k, v) => setSetting('stt', { [k]: v }), [setSetting]);

  return (
    <div>
      <SectionBand title="Models" anchor="set-stt-models">
        {loading ? (
          <div style={hint}>Loading models…</div>
        ) : err ? (
          <div style={{ ...hint, color: 'var(--error)' }}>Couldn’t reach the voice engine: {err}</div>
        ) : models.length === 0 ? (
          <div style={hint}>No models in the registry.</div>
        ) : models.map((m) => (
          <ModelRow
            key={m.name}
            m={m}
            accent={accentColor}
            isDefault={stt.defaultModel === m.name}
            isResident={resident === m.name}
            pct={progress[m.name]}
            confirming={confirmDel === m.name}
            onDownload={() => download(m.name)}
            onCancel={cancelDownload}
            onUse={() => useNow(m.name)}
            onSetDefault={() => setDefault(m.name)}
            onAskDelete={() => setConfirmDel(m.name)}
            onConfirmDelete={() => doDelete(m.name)}
            onCancelDelete={() => setConfirmDel(null)}
          />
        ))}
        <div style={hint}>
          Download caches a model for later — it doesn’t switch the active one. Use <b>Use now</b> to load it immediately, or <b>Set default</b> to load it on launch.
        </div>
      </SectionBand>

      <SectionBand title="Engine" anchor="set-stt-engine">
        <Row label="Active backend">
          <span style={mono}>{backend ? backendLabel(backend) : (resident ? '—' : 'no model loaded')}</span>
        </Row>
        <Row label="Force CPU" anchor="set-stt-forcecpu">
          <EnableToggle enabled={!!stt.forceCpu} accent={accentColor} onChange={toggleForceCpu} title="Force CPU" />
        </Row>
        <div style={hint}>
          Off uses the GPU (Vulkan) when available, falling back to CPU. On forces CPU — slower, but frees the GPU. Toggling reloads the active model immediately.
        </div>
      </SectionBand>

      <PushToTalkBand accent={accentColor} />

      <SectionBand title="Voice detection" anchor="set-stt-vad">
        <StackedRow
          label={`Sensitivity — ${(stt.vadThreshold ?? 0.5).toFixed(2)}`}
          hint="Higher needs louder, clearer speech to open a segment (fewer false triggers); lower catches quieter speech.">
          <input
            type="range" min={0.1} max={0.9} step={0.05}
            value={stt.vadThreshold ?? 0.5}
            onChange={(e) => setVad('vadThreshold', Number(e.target.value))}
            style={slider(accentColor)}
            aria-label="Voice detection sensitivity"
          />
        </StackedRow>
        <StackedRow
          label={`Hangover — ${stt.hangoverMs ?? 300} ms`}
          hint="How long a segment stays open after speech stops, so brief pauses don’t split a sentence.">
          <input
            type="range" min={100} max={1500} step={50}
            value={stt.hangoverMs ?? 300}
            onChange={(e) => setVad('hangoverMs', Number(e.target.value))}
            style={slider(accentColor)}
            aria-label="Voice detection hangover (ms)"
          />
        </StackedRow>
        <div style={hint}>Applied when you start the next dictation.</div>
      </SectionBand>
    </div>
  );
}

function ModelRow({
  m, accent, isDefault, isResident, pct, confirming,
  onDownload, onCancel, onUse, onSetDefault, onAskDelete, onConfirmDelete, onCancelDelete,
}) {
  const downloading = pct != null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 36 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{m.name}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>{fmtSize(m.size_bytes)}</span>
          {m.multilingual && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>multilingual</span>}
          {isResident && <span style={badgeStyle(accent)}>active</span>}
          {isDefault && !isResident && <span style={badgeStyle(accent)}>default</span>}
        </div>
        {downloading && (
          <div style={{ marginTop: 6, height: 4, borderRadius: 2, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(pct)}%`, height: '100%', background: accent, transition: 'width 200ms ease' }} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
        {confirming ? (
          <>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Delete?</span>
            <PickerBtn onClick={onConfirmDelete} accent={accent} tone="var(--error)" title="Confirm delete">Yes</PickerBtn>
            <PickerBtn onClick={onCancelDelete} accent={accent} title="Keep it">No</PickerBtn>
          </>
        ) : downloading ? (
          <PickerBtn onClick={onCancel} accent={accent} title="Cancel download">Cancel</PickerBtn>
        ) : m.cached ? (
          <>
            {!isResident && <PickerBtn onClick={onUse} accent={accent} title="Load this model now">Use now</PickerBtn>}
            {!isDefault && <PickerBtn onClick={onSetDefault} accent={accent} title="Load this model on launch">Set default</PickerBtn>}
            <PickerBtn onClick={onAskDelete} accent={accent} title="Delete from cache">Delete</PickerBtn>
          </>
        ) : (
          <PickerBtn onClick={onDownload} accent={accent} title="Download + verify">Download</PickerBtn>
        )}
      </div>
    </div>
  );
}
