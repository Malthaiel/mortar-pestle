// SF6 of Design Mode plan — message input for Atelier chat. Single textarea,
// Enter sends, Shift+Enter newlines, disabled while streaming. The mention
// chip + send-button area is laid out so SF8 (Markup mode) can drop
// `@ComponentName` chips into the slot above the textarea without
// re-wrapping any of this code.

import { useEffect, useRef, useState } from 'react';

export default function ChatInput({ onSend, streaming, accent, mentions = [], onClearMention, seedText, seedNonce = 0, onSeedConsumed, placeholder = 'Ask Atelier', busyPlaceholder = 'Atelier is thinking…' }) {
  const [text, setText] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [text]);

  // SF5 — seed from an external prefill ("Ask Concierge" on a text selection).
  // Keyed on the nonce so re-asking re-seeds even with identical text; appends
  // below any in-progress text, then focuses with the cursor at the end. One-shot:
  // onSeedConsumed clears the provider seed so a later reopen can't re-inject it.
  useEffect(() => {
    if (!seedText) return;
    setText((prev) => (prev.trim() ? prev.replace(/\s+$/, '') + '\n\n' + seedText + '\n\n' : seedText + '\n\n'));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch (e) {}
    });
    onSeedConsumed && onSeedConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

  const canSend = text.trim().length > 0 && !streaming;
  const submit = () => {
    if (!canSend) return;
    const payload = mentions.length > 0
      ? mentions.map(m => `@${m.name}`).join(' ') + '\n' + text.trim()
      : text.trim();
    onSend(payload);
    setText('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      data-aos-no-mark
      style={{
        borderTop: '1px solid var(--border-soft)',
        padding: '8px 10px 10px',
        display: 'flex', flexDirection: 'column', gap: 6,
        background: 'var(--surface)',
      }}
    >
      {mentions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {mentions.map((m) => (
            <MentionChip key={m.id} mention={m} accent={accent} onClear={() => onClearMention?.(m.id)}/>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? busyPlaceholder : placeholder}
          disabled={streaming}
          rows={1}
          style={{
            flex: 1, minWidth: 0,
            padding: '8px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-soft)',
            borderRadius: 10,
            color: 'var(--text)',
            fontFamily: 'var(--font-body)',
            fontSize: 13,
            lineHeight: 1.45,
            resize: 'none',
            outline: 'none',
            opacity: streaming ? 0.7 : 1,
            transition: 'background 120ms ease, border 120ms ease',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = accent || 'var(--text)'; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = 'var(--border-soft)'; }}
        />
        <SendButton accent={accent} enabled={canSend} onClick={submit}/>
      </div>
    </div>
  );
}

function SendButton({ accent, enabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      title={enabled ? 'Send' : 'Type a message'}
      style={{
        width: 30, height: 30, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: enabled ? (accent || 'var(--text)') : 'transparent',
        color: enabled ? '#fff' : 'var(--text-faint)',
        border: enabled ? 'none' : '1px solid var(--border-soft)',
        borderRadius: 8,
        cursor: enabled ? 'pointer' : 'not-allowed',
        transition: 'background 120ms ease, transform 120ms ease',
      }}
      onMouseDown={(e) => { if (enabled) e.currentTarget.style.transform = 'scale(0.96)'; }}
      onMouseUp={(e)   => { e.currentTarget.style.transform = 'scale(1)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12l14-7-5 14-3-6-6-1z"/>
      </svg>
    </button>
  );
}

function MentionChip({ mention, accent, onClear }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 4px 2px 8px',
      background: `color-mix(in oklch, ${accent || 'var(--text)'} 12%, transparent)`,
      border: `1px solid color-mix(in oklch, ${accent || 'var(--text)'} 24%, transparent)`,
      borderRadius: 999,
      fontSize: 11, fontWeight: 600,
      color: accent || 'var(--text)',
      fontFamily: 'var(--font-mono)',
    }}>
      @{mention.name}
      <button
        type="button"
        onClick={onClear}
        title="Drop mention"
        style={{
          width: 14, height: 14, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none',
          color: 'inherit', cursor: 'pointer', opacity: 0.6,
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
          padding: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.6; }}
      >×</button>
    </span>
  );
}
