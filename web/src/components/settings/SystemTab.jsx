// System settings tab — three sub-tabs on the shared Topbar: System (the
// in-app Build pipeline + the update loop, merged), Downloads (history
// retention, moved from the retired top-level Downloads tab), and Recycling
// Bin (retention sliders). The Vault status strip moved to the Vaults tab.
// Extracted from SettingsDrawer.jsx; build/update internals unchanged.

import { useEffect, useRef, useState } from 'react';
import { invoke, subscribeBuildEvents } from '../../api.js';
import { playReorderDrop } from '../../hooks/useTactileSound.js';
import { useUpdateStatus, applyUpdate, revertUpdate, setPollInterval } from '../../hooks/useUpdateStatus.js';
import { Seg, OutlinedBtn, Slider, Topbar } from '../ui/index.js';
import EnableToggle from '../ui/EnableToggle.jsx';
import { SectionBand, Row, StackedRow } from './section-primitives.jsx';
import { TAB_SECTIONS, scopeFor, scopeModified } from './settings-registry.js';
import { SETTINGS_DEFAULTS } from '../../hooks/useSettings.js';

export default function SystemTab({ settings, setSetting, accent, section, onSectionChange }) {
  const active = section || TAB_SECTIONS.system.default;
  return (
    <div>
      <Topbar
        tiles={TAB_SECTIONS.system.sections.map(s => ({
          id: s.id, label: s.label,
          dot: scopeModified(scopeFor({ tab: 'system', section: s.id }), settings, SETTINGS_DEFAULTS),
        }))}
        activeId={active}
        accent={accent}
        onSelect={onSectionChange}
        style={{ padding: '0 0 12px', background: 'transparent', marginBottom: 16 }}
      />
      {active === 'system' && (
        <>
          <BuildSection accent={accent}/>
          <UpdatesSection settings={settings} setSetting={setSetting} accent={accent}/>
        </>
      )}
      {active === 'downloads' && <DownloadsPanel settings={settings} setSetting={setSetting} accent={accent}/>}
      {active === 'recycle'   && <RecyclePanel   settings={settings} setSetting={setSetting} accent={accent}/>}
    </div>
  );
}

// ── Downloads (history retention) ────────────────────────────────────────────

function DownloadsPanel({ settings, setSetting, accent }) {
  const dl = settings.downloads || { historyCap: 100, historyExpiryDays: 30 };
  return (
    <SectionBand title="History">
      <StackedRow label="Keep recent downloads" anchor="set-downloadsHistoryCap"
        hint="Maximum number of finished downloads shown in the popup and stored on disk.">
        <Slider value={dl.historyCap} min={10} max={500} step={10} unit=""
          accent={accent} onChange={(v) => setSetting('downloads', { historyCap: v })}/>
      </StackedRow>
      <StackedRow label="Expire after" anchor="set-downloadsHistoryExpiryDays"
        hint="Days before a finished download is pruned from history. 0 = keep forever.">
        <Slider value={dl.historyExpiryDays} min={0} max={365} step={1} unit="d"
          accent={accent} onChange={(v) => setSetting('downloads', { historyExpiryDays: v })}/>
      </StackedRow>
    </SectionBand>
  );
}

// ── Recycling bin ────────────────────────────────────────────────────────────

function RecyclePanel({ settings, setSetting, accent }) {
  return (
    <SectionBand title="Recycling bin">
      <StackedRow label="Keep deleted items" anchor="set-recycleBinMaxItems"
        hint="Maximum items kept in the recycling bin. The oldest fall off first when exceeded.">
        <Slider value={settings.recycleBinMaxItems} min={10} max={2000} step={10} unit=""
          accent={accent} onChange={(v) => setSetting('recycleBinMaxItems', v)}/>
      </StackedRow>
      <StackedRow label="Expire after" anchor="set-recycleBinRetentionDays"
        hint="Days before a deleted item is permanently purged from the bin.">
        <Slider value={settings.recycleBinRetentionDays} min={1} max={365} step={1} unit="d"
          accent={accent} onChange={(v) => setSetting('recycleBinRetentionDays', v)}/>
      </StackedRow>
    </SectionBand>
  );
}

// ── Build section (Rebuild App button + live stream + phase ladder) ─────────

const BUILD_MODE_OPTIONS = [
  { value: 'web',     label: 'Web' },
  { value: 'app',     label: 'App' },
  { value: 'release', label: 'Release' },
];

const PHASES_BY_MODE = {
  web:     ['web', 'done'],
  app:     ['web', 'rust', 'done'],
  release: ['web', 'rust', 'bundle', 'done'],
};

const PHASE_LABELS = { web: 'Web', rust: 'Rust', bundle: 'Bundle', done: 'Done' };
const MODE_LABELS  = { web: 'Web', app: 'App', release: 'Release' };

function formatElapsed(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function BuildSection({ accent }) {
  const [mode, setMode] = useState('app');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [outputTail, setOutputTail] = useState([]);
  const [outputOpen, setOutputOpen] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [lastMode, setLastMode] = useState(null);
  const [hidden, setHidden] = useState(false);
  const startedAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;
    (async () => {
      try {
        const snap = await invoke('build_app_status');
        if (cancelled) return;
        if (snap && snap.repoOk === false) {
          setHidden(true);
          return;
        }
        if (snap && snap.running) {
          setRunning(true);
          setMode(snap.mode);
          setLastMode(snap.mode);
          setPhase(snap.phase || null);
          setOutputTail(snap.outputTail || []);
          startedAtRef.current = snap.startedAtMs || Date.now();
          setElapsedMs(Date.now() - startedAtRef.current);
        } else if (snap && snap.lastExitCode != null) {
          setLastResult({ exitCode: snap.lastExitCode, elapsedMs: snap.lastElapsedMs || 0 });
          setLastMode(snap.mode);
          setOutputTail(snap.outputTail || []);
          setPhase(snap.phase || null);
        }
      } catch {
        // Tauri-IPC not ready or status call failed; keep optimistic defaults.
      }
      if (cancelled) return;
      unsubscribe = subscribeBuildEvents((name, payload) => {
        if (name === 'build-stdout' || name === 'build-stderr') {
          setOutputTail(prev => {
            const next = prev.concat(payload?.line ?? '');
            return next.length > 200 ? next.slice(next.length - 200) : next;
          });
        } else if (name === 'build-phase') {
          if (payload?.phase) setPhase(payload.phase);
        } else if (name === 'build-done') {
          setRunning(false);
          setPhase('done');
          setLastResult({
            exitCode: payload?.exitCode ?? -1,
            elapsedMs: payload?.elapsedMs ?? 0,
            error: payload?.error,
          });
          if (payload?.exitCode === 0) playReorderDrop();
        }
      });
    })();
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [running]);

  const handleClick = async () => {
    if (running) return;
    setRunning(true);
    setPhase(null);
    setOutputTail([]);
    setLastResult(null);
    setLastMode(mode);
    setOutputOpen(true);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    try {
      await invoke('build_app_start', { mode });
    } catch (e) {
      setRunning(false);
      setLastResult({
        exitCode: -1,
        elapsedMs: 0,
        error: (e && (e.message || String(e))) || 'failed to start build',
      });
    }
  };

  if (hidden) return null;

  return (
    <SectionBand title="Build">
      <style>{`
        @keyframes aos-build-breath {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.012); }
        }
        [data-aos-building="true"] {
          animation: aos-build-breath 1.6s ease-in-out infinite;
        }
      `}</style>
      <Row label="Mode">
        <Seg
          value={mode}
          options={BUILD_MODE_OPTIONS}
          onChange={v => { if (!running) setMode(v); }}
          accent={accent}
        />
      </Row>
      <Row label="">
        <RebuildButton running={running} elapsedMs={elapsedMs} onClick={handleClick}/>
      </Row>
      {(running || phase) && (
        <Row label="">
          <PhaseLadder mode={running ? mode : (lastMode || mode)} phase={phase} accent={accent}/>
        </Row>
      )}
      {outputTail.length > 0 && (
        <OutputPanel
          lines={outputTail}
          open={outputOpen}
          onToggle={() => setOutputOpen(o => !o)}
          running={running}
        />
      )}
      {lastResult && !running && (
        <BuildResultLine result={lastResult} mode={lastMode || mode}/>
      )}
      {mode === 'web' && !running && (
        <div style={{
          fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
          lineHeight: 1.5,
        }}>
          Bundles `web/` only — running app stays on its baked dist until the next App or Release build.
        </div>
      )}
    </SectionBand>
  );
}

function RebuildButton({ running, elapsedMs, onClick }) {
  const [hover, setHover] = useState(false);
  const label = running ? `Building — ${formatElapsed(elapsedMs)}` : 'Rebuild App';
  const interactive = !running;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      data-aos-building={running ? 'true' : 'false'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '7px 14px',
        background: running
          ? 'color-mix(in oklch, var(--text) 6%, transparent)'
          : (hover ? 'var(--hover)' : 'transparent'),
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        color: running ? 'var(--text)' : (hover ? 'var(--text)' : 'var(--text-muted)'),
        fontFamily: 'var(--font-body)',
        fontSize: 12,
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
        cursor: interactive ? 'pointer' : 'not-allowed',
        minWidth: 150,
        textAlign: 'left',
        transition: 'background 80ms ease, color 80ms ease, border-color 80ms ease',
      }}
    >{label}</button>
  );
}

function PhaseLadder({ mode, phase, accent }) {
  const phases = PHASES_BY_MODE[mode] || PHASES_BY_MODE.app;
  const accentColor = accent || 'var(--text)';
  const currentIdx = phase ? phases.indexOf(phase) : -1;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {phases.map((p, i) => {
        const past   = currentIdx > i;
        const active = currentIdx === i;
        const lit    = active || past;
        return (
          <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: 44 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: active ? accentColor : 'transparent',
                border: `1px solid ${lit ? accentColor : 'var(--border)'}`,
                boxShadow: active ? `0 0 6px ${accentColor}aa` : 'none',
                transition: 'background 160ms cubic-bezier(0.32, 0.72, 0, 1), border-color 160ms cubic-bezier(0.32, 0.72, 0, 1), box-shadow 160ms cubic-bezier(0.32, 0.72, 0, 1)',
              }}/>
              <span style={{
                fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: lit ? 'var(--text-muted)' : 'var(--text-faint)',
                transition: 'color 160ms cubic-bezier(0.32, 0.72, 0, 1)',
              }}>{PHASE_LABELS[p]}</span>
            </div>
            {i < phases.length - 1 && (
              <span style={{
                width: 18, height: 1,
                background: past ? accentColor : 'var(--border)',
                transition: 'background 160ms cubic-bezier(0.32, 0.72, 0, 1)',
                marginTop: -12,
              }}/>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OutputPanel({ lines, open, onToggle, running }) {
  const scrollRef = useRef(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines, open]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  };

  const count = lines.length;
  const tailLine = lines[count - 1] || '';
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-2)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          letterSpacing: '0.04em',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <span style={{
          width: 8, display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 160ms ease',
          fontFamily: 'var(--font-mono)',
        }}>▸</span>
        <span style={{ textTransform: 'uppercase' }}>Output · {count} line{count === 1 ? '' : 's'}</span>
        {!open && tailLine && (
          <span style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: 'var(--text-faint)', letterSpacing: 0,
          }}>{tailLine}</span>
        )}
        {running && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#d9a55a', flexShrink: 0 }}/>
        )}
      </button>
      {open && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            borderTop: '1px solid var(--border)',
            maxHeight: 240,
            overflowY: 'auto',
            padding: '8px 10px',
            background: 'var(--surface)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.45,
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {lines.map((line, i) => (<div key={i}>{line}</div>))}
        </div>
      )}
    </div>
  );
}

function BuildResultLine({ result, mode }) {
  const ok = result.exitCode === 0;
  const elapsed = formatElapsed(result.elapsedMs);
  const modeLabel = MODE_LABELS[mode] || 'App';
  const text = ok
    ? `✓ Built (${modeLabel}) — ${elapsed}`
    : `✗ Build failed (exit ${result.exitCode})${result.error ? ` — ${result.error}` : ' — see output'}`;
  return (
    <div style={{
      fontSize: 11, fontFamily: 'var(--font-mono)',
      color: ok ? '#6fb56f' : '#e07b7b',
    }}>{text}</div>
  );
}

// ── Updates ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_OPTIONS = [
  { value: 10000, label: '10s' },
  { value: 30000, label: '30s' },
  { value: 60000, label: '1m' },
  { value: 300000, label: '5m' },
];

function UpdatesSection({ settings, setSetting, accent }) {
  const status = useUpdateStatus();
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const autoCheck = settings.dev?.autoCheckUpdates !== false;
  const pollInterval = settings.dev?.updatePollInterval ?? 30000;
  const builtAt = (status.diskMtimeSecs && status.available)
    ? new Date(status.diskMtimeSecs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  // Push the persisted interval to the Rust loop on mount so the loop
  // honors the stored preference after app restart. Run-once is fine —
  // subsequent changes go through handlePollChange below.
  useEffect(() => { setPollInterval(pollInterval).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRestart = async () => {
    if (busy) return;
    setBusy('restart');
    setErr(null);
    try {
      await applyUpdate(status.diskSha256Prefix);
    } catch (e) {
      setErr((e && (e.message || e.toString())) || 'restart failed');
      setBusy(null);
    }
  };
  const handleRevert = async () => {
    if (busy) return;
    setBusy('revert');
    setErr(null);
    try {
      await revertUpdate();
    } catch (e) {
      setErr((e && (e.message || e.toString())) || 'revert failed');
      setBusy(null);
    }
  };
  const handlePollChange = (ms) => {
    setSetting('dev', { updatePollInterval: ms });
    setPollInterval(ms).catch(e => setErr(e?.message || 'poll interval failed'));
  };

  return (
    <SectionBand title="Updates">
      <Row label="Notify me about new builds" anchor="set-autoCheckUpdates">
        <EnableToggle
          enabled={autoCheck}
          accent={accent}
          onChange={v => setSetting('dev', { autoCheckUpdates: v })}
          title="Show sidebar dot + toast when a fresh npm run tauri build lands. Rebuilds happen regardless."
        />
      </Row>
      {autoCheck && (
        <Row label="Check cadence" anchor="set-updatePollInterval">
          <Seg
            value={pollInterval}
            onChange={handlePollChange}
            options={POLL_INTERVAL_OPTIONS}
            accent={accent}
          />
        </Row>
      )}
      {status.available && autoCheck && (
        <StackedRow label="Update available" hint={builtAt ? `Built ${builtAt} · ${status.diskSha256Prefix?.slice(0, 8)}…` : 'A fresh build is ready'}>
          <OutlinedBtn small onClick={handleRestart} disabled={!!busy}>
            {busy === 'restart' ? '…' : 'Restart'}
          </OutlinedBtn>
        </StackedRow>
      )}
      {!status.available && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          Up to date{status.currentSha256Prefix ? ` · ${status.currentSha256Prefix.slice(0, 8)}…` : ''}
        </div>
      )}
      {status.prevExists && (
        <Row label="Previous build">
          <OutlinedBtn small onClick={handleRevert} disabled={!!busy}>
            {busy === 'revert' ? '…' : 'Revert to previous'}
          </OutlinedBtn>
        </Row>
      )}
      {err && (
        <div style={{ fontSize: 11, color: '#e07b7b', marginTop: 6, fontFamily: 'var(--font-mono)' }}>{err}</div>
      )}
    </SectionBand>
  );
}
