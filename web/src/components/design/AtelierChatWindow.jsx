// SF6/SF7/SF8/SF9 of Design Mode plan — the Atelier chat window.
//   SF6 anchored it bottom-right
//   SF7 made it draggable
//   SF8 added pointer-mode (Markup) + MarkupOverlay + reveal chip
//   SF9 added Edit mode + TokenBubble + commit-to-source via design_*_file
//
// Agents SF1: the portaled/draggable window frame + header were extracted into
// the shared <AgentChatWindow> shell. This component now owns only Atelier's
// design-specific surface — pointer modes, token bubble, pending-edits tray,
// selection reveal — and composes them into the shell via headerControls /
// preWindow / children slots. Behaviour is unchanged.

import { Fragment, useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentChat } from './useAgentChat.js';
import { makeBuildSystem } from './atelier-system-prompt.js';
import { useDesignPointer } from './DesignPointer.jsx';
import { useLiveOverrides, getOrCreateSelClass } from './useLiveOverrides.js';
import MarkupOverlay from './MarkupOverlay.jsx';
import { readReveal } from './computed-style-reveal.js';
import TokenBubble from './TokenBubble.jsx';
import PendingEditsTray from './PendingEditsTray.jsx';
import AtelierAvatar from './AtelierAvatar.jsx';
import MessageList from './MessageList.jsx';
import ChatInput from './ChatInput.jsx';
import AgentChatWindow from '../agents/AgentChatWindow.jsx';

const STYLES_CSS_PATH = 'web/src/styles.css';

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

async function commitOverrideToSource(override) {
  if (override.target !== 'var') {
    throw new Error('Commit-to-source only supports CSS-variable overrides in v1');
  }
  const text = await invoke('design_read_file', { relPath: STYLES_CSS_PATH });
  const pattern = new RegExp(`(\\s*${override.name}:\\s*)[^;]+;`);
  if (!pattern.test(text)) {
    throw new Error(`Token ${override.name} not found in :root of ${STYLES_CSS_PATH}`);
  }
  const patched = text.replace(pattern, `$1${override.value};`);
  if (patched === text) throw new Error('No-op patch (value unchanged?)');
  await invoke('design_write_file', { relPath: STYLES_CSS_PATH, content: patched });
}

export default function AtelierChatWindow({ settings, setSetting, accent, exiting = false }) {
  const buildSystem = useMemo(() => makeBuildSystem(), []);
  const { messages, streaming, error, send } = useAgentChat({ buildSystem });
  const [mentions, setMentions] = useState([]);
  const [lastReveal, setLastReveal] = useState(null);
  const [editTarget, setEditTarget] = useState(null); // { element, reveal, selClass }
  const [trayOpen, setTrayOpen] = useState(false);
  const { pointerMode, setPointerMode } = useDesignPointer();
  const { pending, setOverride, clearOverride, clearSelClass, clearById, clearAll } = useLiveOverrides();

  // Enrich pending with off-screen flag (recomputed each render so toggling
  // tabs / scrolling updates the indicator).
  const enrichedPending = useMemo(() => pending.map((p) => {
    let found = false;
    try {
      found = !!document.querySelector(
        `[data-aos-source="${CSS.escape(p.source)}"][data-aos-component="${CSS.escape(p.component)}"]`
      );
    } catch { /* malformed source string — leave as off-screen */ }
    return { ...p, sourceFound: found };
  }), [pending]);

  const close = () => setSetting('agents', { mode: false });
  const clearMention = (id) => setMentions((m) => m.filter((x) => x.id !== id));

  const handleSend = (text) => {
    send(text);
    setMentions([]);
    setLastReveal(null);
  };

  const handlePick = useCallback((target, reveal) => {
    if (!reveal) return;
    if (pointerMode === 'markup') {
      setMentions((m) => {
        if (m.some((x) => x.name === reveal.label && x.source === reveal.source)) return m;
        return [...m, { id: uid(), name: reveal.label, source: reveal.source }];
      });
      setLastReveal(reveal);
    } else if (pointerMode === 'edit') {
      const selClass = getOrCreateSelClass(target);
      target.classList.add(selClass);
      setEditTarget({ element: target, reveal, selClass });
    }
  }, [pointerMode]);

  const handleCommit = useCallback(async (override) => {
    try {
      await commitOverrideToSource(override);
      clearOverride(override.selClass, override.name);
    } catch (e) {
      console.error('[design] commit failed:', e);
      alert(`Commit failed: ${e?.message || e}`);
      throw e;
    }
  }, [clearOverride]);

  const handleTrayCommitOne = useCallback(async (edit) => {
    try {
      await commitOverrideToSource(edit);
      clearById(edit.id);
    } catch (e) {
      console.error('[design] tray commit failed:', e);
      alert(`Commit failed: ${e?.message || e}`);
    }
  }, [clearById]);

  const handleTrayDiscardOne = useCallback((edit) => {
    clearById(edit.id);
  }, [clearById]);

  const handleTrayCommitAll = useCallback(async () => {
    const commitable = pending.filter((p) => p.target === 'var');
    const ok = [];
    for (const edit of commitable) {
      try {
        await commitOverrideToSource(edit);
        ok.push(edit.id);
      } catch (e) {
        console.error('[design] tray commit-all: failed on', edit.name, e);
      }
    }
    for (const id of ok) clearById(id);
  }, [pending, clearById]);

  const handleTrayDiscardAll = useCallback(() => {
    clearAll();
  }, [clearAll]);

  const closeBubble = () => setEditTarget(null);

  const showMarkupOverlay = (pointerMode === 'markup' || pointerMode === 'edit') && !exiting;
  const showBubble = pointerMode === 'edit' && editTarget && !exiting;

  // Design-layer siblings that live outside the chat window (portaled by the
  // shell alongside the window frame).
  const preWindow = (
    <>
      {showMarkupOverlay && <MarkupOverlay accent={accent} onPick={handlePick}/>}
      {showBubble && (
        <TokenBubble
          element={editTarget.element}
          reveal={editTarget.reveal}
          selClass={editTarget.selClass}
          accent={accent}
          pending={pending}
          setOverride={setOverride}
          clearOverride={clearOverride}
          clearSelClass={clearSelClass}
          onClose={closeBubble}
          onCommit={handleCommit}
        />
      )}
    </>
  );

  // Right-side header controls: pending-overrides pill + the pointer-mode toggle.
  const headerControls = (
    <>
      {pending.length > 0 && (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setTrayOpen((v) => !v)}
          title={`${pending.length} pending override${pending.length === 1 ? '' : 's'} — click to ${trayOpen ? 'close' : 'open'} tray`}
          style={{
            padding: '2px 7px',
            background: trayOpen
              ? (accent || 'var(--text)')
              : `color-mix(in oklch, ${accent || 'var(--text)'} 12%, transparent)`,
            color: trayOpen ? '#fff' : (accent || 'var(--text)'),
            border: trayOpen
              ? 'none'
              : `1px solid color-mix(in oklch, ${accent || 'var(--text)'} 24%, transparent)`,
            borderRadius: 999,
            fontFamily: 'var(--font-mono)',
            fontSize: 10, fontWeight: 700,
            letterSpacing: '0.04em',
            cursor: 'pointer',
            transition: 'background 100ms ease, color 100ms ease',
          }}
        >{pending.length} pending</button>
      )}
      <PointerToggle accent={accent} pointerMode={pointerMode} setPointerMode={setPointerMode}/>
    </>
  );

  return (
    <AgentChatWindow
      settings={settings}
      setSetting={setSetting}
      exiting={exiting}
      avatar={<AtelierAvatar accent={accent} streaming={streaming} size={11}/>}
      title="Atelier"
      subtitle="design mode"
      closeTitle="Close Design mode (Esc)"
      onClose={close}
      headerControls={headerControls}
      preWindow={preWindow}
    >
      {trayOpen && (
        <PendingEditsTray
          pending={enrichedPending}
          accent={accent}
          onCommit={handleTrayCommitOne}
          onDiscard={handleTrayDiscardOne}
          onCommitAll={handleTrayCommitAll}
          onDiscardAll={handleTrayDiscardAll}
          onClose={() => setTrayOpen(false)}
        />
      )}
      <MessageList
        messages={messages}
        streaming={streaming}
        accent={accent}
        error={error}
      />
      {lastReveal && (
        <SelectionRevealRow
          reveal={lastReveal}
          accent={accent}
          onDismiss={() => setLastReveal(null)}
          onPickLevel={(el) => handlePick(el, readReveal(el))}
        />
      )}
      <ChatInput
        onSend={handleSend}
        streaming={streaming}
        accent={accent}
        mentions={mentions}
        onClearMention={clearMention}
      />
    </AgentChatWindow>
  );
}

function PointerToggle({ accent, pointerMode, setPointerMode }) {
  const items = [
    { id: 'off',    label: 'Off',  title: 'Pointer off — normal chat (Esc to clear pointer)' },
    { id: 'markup', label: 'Mark', title: 'Markup — hover + click components to push @chips' },
    { id: 'edit',   label: 'Edit', title: 'Edit — pick a component to tweak its tokens' },
  ];
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center',
        background: 'var(--surface-2)',
        border: '1px solid var(--border-soft)',
        borderRadius: 6,
        padding: 1,
        gap: 0,
      }}
    >
      {items.map((it) => {
        const active = pointerMode === it.id;
        return (
          <button
            key={it.id}
            type="button"
            title={it.title}
            onClick={() => setPointerMode(it.id)}
            style={{
              padding: '2px 7px',
              background: active ? (accent || 'var(--text)') : 'transparent',
              color: active ? '#fff' : 'var(--text-muted)',
              border: 'none',
              borderRadius: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.04em',
              cursor: 'pointer',
              transition: 'background 100ms ease, color 100ms ease',
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function SelectionRevealRow({ reveal, accent, onDismiss, onPickLevel }) {
  const pathOnly = reveal.source.replace(/:\d+:\d+$/, '');
  const crumbs = reveal.crumbs?.length ? reveal.crumbs : [{ el: null, label: reveal.label || reveal.name }];
  return (
    <div
      data-aos-no-mark
      style={{
        padding: '6px 10px',
        background: 'var(--surface-2)',
        borderTop: '1px solid var(--border-soft)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--text-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexShrink: 0,
        lineHeight: 1.35,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span style={{ opacity: 0.5, margin: '0 3px' }}>›</span>}
            <button
              type="button"
              onClick={() => c.el && onPickLevel?.(c.el)}
              title={c.el ? `Mark ${c.label}` : c.label}
              style={{
                background: 'none', border: 'none', padding: 0,
                cursor: c.el ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 'inherit', letterSpacing: 'inherit',
                fontWeight: i === crumbs.length - 1 ? 700 : 600,
                color: i === crumbs.length - 1 ? (accent || 'var(--text)') : 'var(--text-muted)',
              }}
            >
              {c.label}
            </button>
          </Fragment>
        ))}
        {' · '}
        <span title={reveal.source}>{pathOnly}</span>
        {' · radius '}{reveal.radius}
        {' · pad '}{reveal.padding}
        {' · '}{reveal.color}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        style={{
          width: 16, height: 16, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none',
          color: 'var(--text-faint)', cursor: 'pointer', opacity: 0.7,
          fontSize: 12, lineHeight: 1, padding: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
      >×</button>
    </div>
  );
}
