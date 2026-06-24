// Owns the persistent state of the terminal tabs panel across SPA navigation.
//
// Persistence model:
//   - Each tab has a long-lived PTY WebSocket (createPtySession), kept open
//     regardless of whether the user is currently viewing /tools/terminal.
//   - Each tab also has an output ring buffer that captures shell output. The
//     buffer is what makes a tab's scrollback survive a route change: when
//     <Terminal/> mounts later, it replays the ring into a fresh xterm
//     instance before subscribing to live output.
//   - xterm.js DOM instances are NOT preserved across route changes
//     (xterm has no detach/reattach API; reparenting its container is
//     unreliable). The buffer replay + the still-running PTY give the user
//     the practically-meaningful continuity: their commands kept running
//     while they were away.
//
// API exposed via context:
//   tabs              [{ id, title, status }]
//   activeId          currently-active tab id (or null)
//   addTab()          creates a new tab + sets it active
//   closeTab(id)      closes PTY, disposes ring, removes from list
//   setActive(id)
//   markPanelOpen(b)  TerminalPage calls true on mount / false on unmount.
//                     Auto-spawn-on-empty only fires while open — otherwise
//                     we'd spawn a hidden shell at app startup.
//   subscribe(id, onData)
//                     xterm components call this on mount to receive replayed
//                     buffer + live output. Returns { unsubscribe, send, resize }.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPtySession } from './usePtySession.js';

const Ctx = createContext(null);

const RING_LIMIT = 256 * 1024;

function makeRing() {
  let buf = '';
  let truncated = false;
  return {
    append(chunk) {
      buf += chunk;
      if (buf.length > RING_LIMIT) {
        const overflow = buf.length - RING_LIMIT;
        buf = buf.slice(overflow);
        if (!truncated) {
          buf = '[...scrollback truncated]\r\n' + buf;
          truncated = true;
        }
      }
    },
    read() { return buf; },
    clear() { buf = ''; truncated = false; },
  };
}

let nextTabId = 1;

export function TerminalProvider({ children }) {
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // id → { session, ring, listener, lastCols, lastRows }
  const tabRefsRef = useRef(new Map());

  const updateStatus = useCallback((id, status) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
  }, []);

  const addTab = useCallback(() => {
    const id = String(nextTabId++);
    const title = `Terminal ${id}`;
    const ring = makeRing();

    const ref = {
      session: null,
      ring,
      listener: null,
      lastCols: 80,
      lastRows: 24,
    };
    tabRefsRef.current.set(id, ref);

    ref.session = createPtySession({
      initialCols: 80,
      initialRows: 24,
      onStatus: (s) => updateStatus(id, s),
      onData: (chunk) => {
        ref.ring.append(chunk);
        try { ref.listener?.(chunk); } catch {}
      },
      onExit: ({ exitCode, signal, error }) => {
        const tag = error
          ? `\r\n\x1b[31m[error: ${error}]\x1b[0m\r\n`
          : `\r\n\x1b[2m[process exited${signal ? ` (signal ${signal})` : exitCode != null ? ` (code ${exitCode})` : ''}]\x1b[0m\r\n`;
        ref.ring.append(tag);
        try { ref.listener?.(tag); } catch {}
        updateStatus(id, 'closed');
      },
    });

    setTabs((prev) => [...prev, { id, title, status: 'connecting' }]);
    setActiveId(id);
    return id;
  }, [updateStatus]);

  const closeTab = useCallback((id) => {
    const ref = tabRefsRef.current.get(id);
    if (ref) {
      try { ref.session?.close(); } catch {}
      ref.listener = null;
      tabRefsRef.current.delete(id);
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // If we just removed the active tab, focus the neighbor — or auto-spawn
      // a fresh tab if this was the last one and the terminal panel is still
      // open. The auto-spawn happens in an effect below to avoid setState
      // ordering issues mid-callback.
      if (id === activeId) {
        if (next.length > 0) {
          // pick the previous-position neighbor when possible
          const idx = prev.findIndex((t) => t.id === id);
          const newActive = next[Math.min(idx, next.length - 1)];
          setActiveId(newActive.id);
        } else {
          setActiveId(null);
        }
      }
      return next;
    });
  }, [activeId]);

  // Auto-spawn a fresh tab whenever the panel is open and the list goes
  // empty. This guarantees the terminal panel always has at least one tab
  // while visible — the established Konsole/iTerm behavior. We gate on
  // panelOpen so the provider doesn't spawn a hidden shell at app startup;
  // tabs only come into existence once the user actually visits the panel.
  useEffect(() => {
    if (panelOpen && tabs.length === 0) {
      addTab();
    }
  }, [panelOpen, tabs.length, addTab]);

  const setActive = useCallback((id) => {
    if (tabRefsRef.current.has(id)) setActiveId(id);
  }, []);

  const markPanelOpen = useCallback((open) => {
    setPanelOpen(open);
  }, []);

  // Called by <Terminal/> on mount. Replays the ring synchronously, then
  // registers the listener for live updates. The returned `unsubscribe` MUST
  // be called on xterm unmount or the ring listener will keep firing into a
  // disposed terminal.
  const subscribe = useCallback((id, onData) => {
    const ref = tabRefsRef.current.get(id);
    if (!ref) {
      return { unsubscribe() {}, send() {}, resize() {} };
    }
    // Replay synchronously so the new xterm picks up the prior session state
    // before the next live chunk arrives.
    const buffered = ref.ring.read();
    if (buffered) {
      try { onData(buffered); } catch {}
    }
    ref.listener = onData;
    return {
      unsubscribe() {
        if (ref.listener === onData) ref.listener = null;
      },
      send(data) {
        ref.session?.send(data);
      },
      resize(cols, rows) {
        ref.lastCols = cols;
        ref.lastRows = rows;
        ref.session?.resize(cols, rows);
      },
    };
  }, []);

  const value = useMemo(
    () => ({ tabs, activeId, addTab, closeTab, setActive, subscribe, markPanelOpen }),
    [tabs, activeId, addTab, closeTab, setActive, subscribe, markPanelOpen],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTerminal() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTerminal must be called inside <TerminalProvider/>');
  return v;
}
