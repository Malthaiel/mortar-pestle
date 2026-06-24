// SF6 of Design Mode plan — wraps the Tauri `agent_chat` invoke + the three
// streaming events (`agent-chunk`, `agent-done`, `agent-error`) into a
// React hook with `{ messages, streaming, error, send }`. Coalesces all
// streamed deltas into the latest assistant message.

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSettings } from '../../hooks/useSettings.js';

export function useAgentChat({ buildSystem }) {
  const { settings } = useSettings();
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const unlistenRef = useRef([]);
  // SF4 — recipe round-trips mark their turn `hidden` so the tray-centric flow
  // doesn't push the (often whole-file) prompt + response into the visible
  // transcript. Set by `send({hidden})`, read when the streamed assistant
  // message is created, cleared on done/error. Atelier never sets it.
  const pendingHiddenRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const subs = await Promise.all([
        listen('agent-chunk', ({ payload }) => {
          if (cancelled) return;
          const text = payload?.text || '';
          if (!text) return;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
              return [...prev.slice(0, -1), { ...last, content: last.content + text }];
            }
            return [...prev, { role: 'assistant', content: text, streaming: true, hidden: pendingHiddenRef.current }];
          });
        }),
        listen('agent-done', () => {
          if (cancelled) return;
          pendingHiddenRef.current = false;
          setStreaming(false);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, streaming: false }];
            }
            return prev;
          });
        }),
        listen('agent-error', ({ payload }) => {
          if (cancelled) return;
          pendingHiddenRef.current = false;
          setStreaming(false);
          setError(payload || { code: 'UNKNOWN', message: 'unknown error' });
        }),
      ]);
      unlistenRef.current = subs;
    })();
    return () => {
      cancelled = true;
      unlistenRef.current.forEach((u) => u && u());
      unlistenRef.current = [];
    };
  }, []);

  const send = useCallback(
    // opts.hidden  — flag this turn's user + assistant messages `hidden` (SF4
    //                recipe round-trips render in the tray, not the transcript).
    // opts.history — false ⇒ isolated context (just this message), so a recipe
    //                isn't polluted by prior chat. Defaults preserve Atelier.
    async (text, opts = {}) => {
      if (!text || !text.trim() || streaming) return;
      setError(null);
      const userMsg = { role: 'user', content: text };
      if (opts.hidden) userMsg.hidden = true;
      const next = [...messages, userMsg];
      setMessages(next);
      setStreaming(true);
      pendingHiddenRef.current = !!opts.hidden;
      try {
        const source = opts.history === false ? [userMsg] : next;
        const apiMessages = source
          .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.streaming))
          .map((m) => ({ role: m.role, content: m.content }));
        const backend = settings.agents?.authBackend || 'api-key';
        const model   = settings.agents?.model || 'opus';
        const cliPath = settings.agents?.claudeCliPath || '';
        const system = await buildSystem({ backend });
        if (backend === 'claude-cli') {
          await invoke('agent_chat_cli', { system, messages: apiMessages, model, cliPath });
        } else {
          await invoke('agent_chat', { system, messages: apiMessages, model });
        }
      } catch (e) {
        pendingHiddenRef.current = false;
        setStreaming(false);
        setError(typeof e === 'object' && e ? e : { code: 'INVOKE', message: String(e) });
      }
    },
    [messages, streaming, buildSystem, settings.agents],
  );

  return { messages, streaming, error, send };
}
