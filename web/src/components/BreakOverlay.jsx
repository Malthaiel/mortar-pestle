// Planner break overlay — appears for ~6s when a focus session ends,
// dismissable. Shows a time-of-day greeting + a rotating motivational
// quote (pulled from a small curated set, picked at random per break).
//
// Listens for `planner:phase-complete` with detail.phase === 'focus'
// (i.e. the user just finished a focus block and is now in break). Also
// listens for `planner:phase-complete` with detail.phase === 'break'
// to close itself (rare — the user may already have dismissed).
//
// Auto-dismiss timer is 6500ms; user click (or Esc) closes immediately.

import { useEffect, useState } from 'react';

const QUOTES = [
  '"Discipline is choosing between what you want now and what you want most." — Augusta Scattergood',
  '"The best way to predict the future is to invent it." — Alan Kay',
  '"Slow is smooth. Smooth is fast." — Navy SEALs',
  '"You do not rise to the level of your goals. You fall to the level of your systems." — James Clear',
  '"Make the change you want to see in the world." — Mahatma Gandhi',
  '"What gets measured gets managed." — Peter Drucker',
  '"It always seems impossible until it’s done." — Nelson Mandela',
  '"Focus on being productive instead of busy." — Tim Ferriss',
  '"The shortest answer is doing." — George Herbert',
  '"Quality is not an act, it is a habit." — Aristotle',
  '"Hero builds: be fearless. Item builds: be patient." — Ranked Deadlock player, probably',
];

function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 5)  return 'Late night, hero.';
  if (h < 12) return 'Good morning.';
  if (h < 17) return 'Good afternoon.';
  if (h < 21) return 'Good evening.';
  return 'Good night.';
}

export default function BreakOverlay({ accent }) {
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState('');
  const [hi, setHi] = useState('');

  useEffect(() => {
    const onPhase = (e) => {
      const d = e.detail || {};
      if (d.phase === 'focus') {
        // Entering break
        setQuote(QUOTES[Math.floor(Math.random() * QUOTES.length)]);
        setHi(greeting());
        setOpen(true);
        const t = setTimeout(() => setOpen(false), 6500);
        return () => clearTimeout(t);
      }
      if (d.phase === 'break') setOpen(false);
    };
    window.addEventListener('planner:phase-complete', onPhase);
    return () => window.removeEventListener('planner:phase-complete', onPhase);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const accentColor = accent || 'var(--text)';

  return (
    <div
      role="dialog"
      aria-label="Break"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 1300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.62)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        animation: 'backdropIn 0.32s ease',
        cursor: 'pointer',
      }}
    >
      <div style={{
        maxWidth: 540, padding: '40px 48px',
        textAlign: 'center',
        animation: 'fadeIn 0.42s ease',
      }}>
        <div style={{
          fontSize: 10, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.18em', textTransform: 'uppercase',
          color: accentColor, fontWeight: 700,
          marginBottom: 10,
        }}>Break</div>
        <div style={{
          fontSize: 32, fontWeight: 700,
          color: 'var(--text)',
          letterSpacing: '-0.02em', lineHeight: 1.1,
          marginBottom: 22,
        }}>{hi}</div>
        <div style={{
          fontSize: 14, fontWeight: 400,
          color: 'var(--text-muted)',
          lineHeight: 1.55,
          letterSpacing: '-0.005em',
          fontStyle: 'italic',
        }}>{quote}</div>
        <div style={{
          marginTop: 28,
          fontSize: 10, fontFamily: 'var(--font-mono)',
          color: 'var(--text-faint)',
          letterSpacing: '0.08em',
        }}>Click anywhere to dismiss</div>
      </div>
    </div>
  );
}
