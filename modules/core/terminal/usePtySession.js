// Lifecycle of one PTY session: open → bidirectional message flow → cleanup.
//
// Tauri-only (SF12 deleted the WebSocket fallback):
//   invoke('pty_open', { cols, rows, onEvent: channel }), then pty_write /
//   pty_resize / pty_close keyed by sessionId. Channel<PtyEvent> dispatches
//   { kind: 'data', text } and { kind: 'exit', exit_code, signal }.
//
// Two entry points:
//   createPtySession(...) — imperative factory used by TerminalProvider (one
//     session per tab, lifetime spans many React renders).
//   usePtySession(...)    — thin React hook wrapper.

import { useEffect, useRef, useState } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';

export function createPtySession({ onData, onExit, onStatus, initialCols = 80, initialRows = 24 } = {}) {
  let sessionId = null;
  let cancelled = false;
  let status = 'connecting';

  const setStatus = (next) => {
    status = next;
    try { onStatus?.(next); } catch {}
  };

  const channel = new Channel();
  channel.onmessage = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'data' && typeof msg.text === 'string') {
      try { onData?.(msg.text); } catch {}
      return;
    }
    if (msg.kind === 'exit') {
      try {
        onExit?.({
          exitCode: msg.exit_code ?? null,
          signal: msg.signal ?? null,
        });
      } catch {}
      if (!cancelled) setStatus('closed');
    }
  };

  (async () => {
    try {
      const res = await invoke('pty_open', {
        cols: initialCols,
        rows: initialRows,
        onEvent: channel,
      });
      if (cancelled) {
        try { await invoke('pty_close', { sessionId: res.sessionId }); } catch {}
        return;
      }
      sessionId = res.sessionId;
      setStatus('open');
    } catch (err) {
      if (cancelled) return;
      setStatus('error');
      const message = err?.message || String(err);
      try { onExit?.({ exitCode: -1, signal: null, error: message }); } catch {}
    }
  })();

  return {
    send(data) {
      if (!sessionId) return;
      invoke('pty_write', { sessionId, data }).catch(() => {});
    },
    resize(cols, rows) {
      if (!sessionId) return;
      invoke('pty_resize', { sessionId, cols, rows }).catch(() => {});
    },
    close() {
      cancelled = true;
      if (sessionId) {
        invoke('pty_close', { sessionId }).catch(() => {});
      }
    },
    get status() { return status; },
  };
}

export function usePtySession({ onData, onExit, initialCols = 80, initialRows = 24, enabled = true } = {}) {
  const [status, setStatus] = useState('idle');
  const sessionRef = useRef(null);
  const onDataRef = useRef(onData);
  const onExitRef = useRef(onExit);
  onDataRef.current = onData;
  onExitRef.current = onExit;

  useEffect(() => {
    if (!enabled) return undefined;
    const session = createPtySession({
      onData: (d) => onDataRef.current?.(d),
      onExit: (e) => onExitRef.current?.(e),
      onStatus: setStatus,
      initialCols, initialRows,
    });
    sessionRef.current = session;
    return () => session.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    send: (data) => sessionRef.current?.send(data),
    resize: (cols, rows) => sessionRef.current?.resize(cols, rows),
    close: () => sessionRef.current?.close(),
    status,
  };
}
