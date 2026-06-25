// Renders the live PTY output of a skill run in an xterm.js terminal.
// Stream chunks (raw bytes with ANSI escapes from a real PTY) are written
// straight into the terminal — colors, cursor movement, progress bars,
// etc. all render as they would in a real shell.
//
// Transport: SF8 — Tauri 2.x `Channel<SkillEvent>` via skillsApi.subscribeRun
// when running inside the Tauri shell, fetch fallback via SSE EventSource
// when running as a browser tab against the Node server. Both transports
// normalize to the same `{ kind, text|exit_code }` tagged-union shape.
//
// On mount we fit to container size, push the size to the server via
// resizeRun so the PTY's COLUMNS/LINES match what we render, re-fit on
// container resize.
//
// Creative: SF8 chunk-burst pulse — when ≥5 stdout chunks arrive within
// 1.5s the terminal frame gets a 250ms accent-tinted box-shadow glow. Gives
// a tactile "data flowing" signal that survives ANSI scrollback where the
// cursor-positioning escapes don't visibly advance the rendered output.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { skillsApi } from './api.js';
import { Dot, OutlinedBtn, DangerOutlinedBtn } from '@host/components/ui/index.js';

const CHUNK_PULSE_WINDOW_MS = 1500;
const CHUNK_PULSE_THRESHOLD = 5;
const CHUNK_PULSE_DURATION_MS = 280;

export default function SkillOutput({ jobId, onCleared, accent }) {
  const [exitCode, setExitCode] = useState(null);
  const [status, setStatus] = useState('running');  // 'running' | 'done' | 'cancelled'
  const [cancelling, setCancelling] = useState(false);
  const [pulsing, setPulsing] = useState(false);
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  // Spin up terminal exactly once per jobId
  useEffect(() => {
    if (!jobId || !hostRef.current) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,             // read-only view; no keyboard input is fed back
      scrollback: 5000,
      fontFamily: 'var(--font-mono), "DM Mono", "JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      theme: {
        background:  getCssVar('--surface-2') || '#161616',
        foreground:  getCssVar('--text')      || '#e6e6e6',
        cursor:      getCssVar('--text')      || '#e6e6e6',
        selectionBackground: 'rgba(255,255,255,0.18)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    const dims = { cols: term.cols, rows: term.rows };
    // Defer initial fit one frame so the flex container has measured layout.
    requestAnimationFrame(() => {
      try { fit.fit(); } catch {}
      const next = { cols: term.cols, rows: term.rows };
      if (next.cols !== dims.cols || next.rows !== dims.rows) {
        dims.cols = next.cols; dims.rows = next.rows;
      }
      skillsApi.resizeRun(jobId, dims.cols, dims.rows).catch(() => {});
    });

    // Re-fit on container resize.
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
      const next = { cols: term.cols, rows: term.rows };
      if (next.cols !== dims.cols || next.rows !== dims.rows) {
        dims.cols = next.cols; dims.rows = next.rows;
        skillsApi.resizeRun(jobId, next.cols, next.rows).catch(() => {});
      }
    });
    ro.observe(hostRef.current);

    // Chunk-burst detector: sliding window of stdout chunk timestamps. On
    // ≥5 inside 1.5s, fire the SF8 skill-chunk-pulse keyframe for 280ms
    // (250ms anim + 30ms slack). Window resets on each pulse to prevent
    // immediate re-fire from the same burst.
    const burstTimestamps = [];
    let pulseTimeout = null;
    const tickBurst = () => {
      const now = performance.now();
      burstTimestamps.push(now);
      while (burstTimestamps.length && burstTimestamps[0] < now - CHUNK_PULSE_WINDOW_MS) {
        burstTimestamps.shift();
      }
      if (burstTimestamps.length >= CHUNK_PULSE_THRESHOLD) {
        burstTimestamps.length = 0;
        setPulsing(false);
        // Reflow forces the keyframe to restart even on rapid back-to-back bursts.
        requestAnimationFrame(() => {
          setPulsing(true);
          if (pulseTimeout) clearTimeout(pulseTimeout);
          pulseTimeout = setTimeout(() => setPulsing(false), CHUNK_PULSE_DURATION_MS);
        });
      }
    };

    // Unified handler — both Tauri Channel and SSE fetch-fallback normalize
    // to the same `{ kind, text|exit_code }` tagged-union shape.
    const handleEvent = (msg) => {
      if (!msg || !msg.kind) return;
      if (msg.kind === 'replay' || msg.kind === 'stdout') {
        term.write(msg.text || '');
        if (msg.kind === 'stdout') tickBurst();
      } else if (msg.kind === 'done') {
        setExitCode(msg.exit_code ?? 0);
        setStatus('done');
      } else if (msg.kind === 'cancelled') {
        setExitCode(msg.exit_code ?? 0);
        setStatus('cancelled');
      }
    };
    const unsub = skillsApi.subscribeRun(jobId, handleEvent);

    setStatus('running');
    setExitCode(null);
    setCancelling(false);
    setPulsing(false);

    return () => {
      if (pulseTimeout) clearTimeout(pulseTimeout);
      try { unsub(); } catch {}
      ro.disconnect();
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
    };
  }, [jobId]);

  const onCancel = async () => {
    if (status !== 'running' || cancelling) return;
    setCancelling(true);
    try { await skillsApi.cancelRun(jobId); }
    catch (err) { console.warn('cancel failed:', err); setCancelling(false); }
  };

  if (!jobId) return null;

  const accentColor = accent || 'var(--text)';
  const dotColor = status === 'running'
    ? accentColor
    : status === 'cancelled'
      ? '#d9a55a'
      : (exitCode === 0 ? '#6fb56f' : '#e07b7b');
  const dotGlow = status === 'running';
  const statusLabel = status === 'running'
    ? 'Running'
    : status === 'cancelled'
      ? `Cancelled · exit ${exitCode}`
      : (exitCode === 0 ? `Done · exit 0` : `Failed · exit ${exitCode}`);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10,
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          fontSize: 9, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--text-faint)', fontWeight: 700,
        }}>
          <Dot color={dotColor} glow={dotGlow}/>
          Output
        </span>
        <span style={{
          fontSize: 9, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: dotColor,
          fontWeight: 600,
        }}>{statusLabel}</span>
        <span style={{ flex: 1 }}/>
        <span style={{
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          color: 'var(--text-muted)',
          fontSize: 9, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
          fontVariantNumeric: 'tabular-nums',
        }}>job {jobId.slice(0, 8)}</span>
        {status === 'running' && (
          <DangerOutlinedBtn onClick={onCancel} disabled={cancelling} small>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </DangerOutlinedBtn>
        )}
        {status !== 'running' && onCleared && (
          <OutlinedBtn onClick={() => onCleared()} small>Clear</OutlinedBtn>
        )}
      </div>
      <div
        ref={hostRef}
        style={{
          flex: 1, minHeight: 200,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: 8,
          overflow: 'hidden',
          animation: pulsing
            ? 'skill-chunk-pulse 250ms cubic-bezier(0.32, 0.72, 0, 1)'
            : 'none',
        }}
      />
    </div>
  );
}


function getCssVar(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}
