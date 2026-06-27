// SF6 of Design Mode plan — message list inside the Atelier chat window.
// Auto-scrolls to bottom on new content. Empty state introduces Atelier in
// the persona's voice. User messages are right-aligned + neutral; assistant
// messages are left-aligned with an avatar gutter that pulses while
// streaming.

import { useEffect, useRef } from 'react';
import AtelierAvatar from './AtelierAvatar.jsx';

export default function MessageList({ messages, streaming, accent, error, emptyName, emptyTagline, emptyBlurb }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // SF4 — recipe round-trips run `hidden` (tray-centric flow), so visibility is
  // computed from non-hidden messages only. Atelier never sets `hidden`.
  const visible = messages.filter((m) => !m.hidden);
  const isEmpty = visible.length === 0;

  return (
    <div
      ref={scrollRef}
      data-aos-no-mark
      style={{
        flex: 1, minHeight: 0,
        overflowY: 'auto',
        padding: '14px 14px 6px',
        display: 'flex', flexDirection: 'column', gap: 12,
        scrollBehavior: 'smooth',
      }}
    >
      {isEmpty && <EmptyState accent={accent} name={emptyName} tagline={emptyTagline} blurb={emptyBlurb}/>}
      {visible.map((m, i) => (
        <Message key={i} msg={m} accent={accent}/>
      ))}
      {error && <ErrorRow error={error}/>}
    </div>
  );
}

// Persona is parameterized so reusers (Concierge) show their own identity;
// Atelier's copy is the default when the props are omitted.
function EmptyState({
  accent,
  name = 'Atelier',
  tagline = 'designer-in-residence',
  blurb = 'What are we shaping? Ask in plain English, or hover over a component to talk about it directly.',
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: '24px 8px 8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AtelierAvatar accent={accent} size={11}/>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{name}</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          {tagline}
        </span>
      </div>
      <div style={{
        fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55,
        paddingLeft: 22, maxWidth: 320,
      }}>
        {blurb}
      </div>
    </div>
  );
}

function Message({ msg, accent }) {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{
          maxWidth: '78%',
          padding: '8px 12px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-soft)',
          borderRadius: 12,
          borderBottomRightRadius: 4,
          fontSize: 13, lineHeight: 1.5,
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>{msg.content}</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <div style={{ paddingTop: 6, flexShrink: 0 }}>
        <AtelierAvatar accent={accent} streaming={!!msg.streaming}/>
      </div>
      <div style={{
        flex: 1, minWidth: 0,
        padding: '4px 4px 4px 0',
        fontSize: 13, lineHeight: 1.55,
        color: 'var(--text)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {msg.content}
        {msg.streaming && msg.content === '' && (
          <span style={{
            display: 'inline-block', width: 7, height: 14,
            background: 'var(--text-muted)',
            verticalAlign: 'text-bottom',
            animation: 'streamCaret 900ms ease-in-out infinite',
          }}/>
        )}
      </div>
    </div>
  );
}

function ErrorRow({ error }) {
  const code = error?.code || 'ERROR';
  const message = error?.message || String(error);
  return (
    <div style={{
      padding: '8px 12px',
      background: 'color-mix(in oklch, var(--text) 12%, transparent)',
      border: '1px solid color-mix(in oklch, var(--text) 30%, transparent)',
      borderRadius: 10,
      fontSize: 11.5, lineHeight: 1.45,
      color: 'var(--text)',
      fontFamily: 'var(--font-mono)',
    }}>
      <strong style={{ fontWeight: 700 }}>{code}</strong> — {message}
    </div>
  );
}
