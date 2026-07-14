// SF6 of Design Mode plan — message list inside the Atelier chat window.
// Auto-scrolls to bottom on new content. Empty state introduces Atelier in
// the persona's voice. User messages are right-aligned + neutral; assistant
// messages are left-aligned with an avatar gutter that pulses while
// streaming.

import { memo, useEffect, useRef } from 'react';
import AtelierAvatar from './AtelierAvatar.jsx';

export default function MessageList({ messages, streaming, accent, error, emptyName, emptyTagline, emptyBlurb }) {
  const scrollRef = useRef(null);
  // Pin-to-bottom: only auto-scroll when the user is already near the bottom,
  // so scrolling up to read earlier messages isn't yanked back on every
  // streaming chunk. Sending a new user message re-pins.
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') pinnedRef.current = true;
    if (!pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // SF4 — recipe round-trips run `hidden` (tray-centric flow), so visibility is
  // computed from non-hidden messages only. Atelier never sets `hidden`.
  const visible = messages.filter((m) => !m.hidden);
  const isEmpty = visible.length === 0;

  return (
    <div
      ref={scrollRef}
      data-aos-no-mark
      onScroll={handleScroll}
      style={{
        flex: 1, minHeight: 0,
        overflowY: 'auto',
        padding: '14px 14px 6px',
        display: 'flex', flexDirection: 'column', gap: 12,
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

const Message = memo(function Message({ msg, accent }) {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}>
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
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}>
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
});

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
