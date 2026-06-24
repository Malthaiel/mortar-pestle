// Shared candy status dropdown — a custom <select> replacement used by the
// media modules (music, video). The trigger is a candy button; clicking unrolls
// an absolute menu (height-clip ~180ms) that floats over content. Click-outside
// + Esc close. onChange receives the chosen status string ('' clears, since
// re-selecting the current status toggles it off). dotFor(status) returns that
// status's dot color — each module passes its own status→color map, so the
// component stays module-agnostic. Styling: .status-candy / .status-candy-menu /
// .status-candy-option in styles.css; accent mixes resolve against a local
// --accent set inline here.
//
// Keyboard: focus stays on the trigger while open, so all navigation lives on
// the trigger's onKeyDown — ↑/↓ move the highlight (wrapping), Home/End jump to
// the ends, Enter/Space pick the highlighted status (re-picking the current one
// clears it), type-ahead jumps to the first status matching recent keystrokes,
// Esc closes. When closed, ↑/↓/Enter/Space open the menu. (Mirrors CandySelect.)

import { useEffect, useRef, useState } from 'react';

export default function StatusDropdown({ value, accent, placeholder, title, statuses, disabled, onChange, dotFor }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef(null);
  const listRef = useRef(null);
  const typeahead = useRef({ str: '', t: 0 });
  const dot = dotFor ? dotFor(value) : null;

  // On open, highlight the selected status (or the first); clear on close.
  useEffect(() => {
    if (!open) { setActiveIndex(-1); return; }
    const sel = statuses.indexOf(value);
    setActiveIndex(sel >= 0 ? sel : 0);
  }, [open]);

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    listRef.current
      .querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // Click-outside + Escape close (mirrors the ContextMenu capture pattern).
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (s) => {
    onChange(s === value ? '' : s);   // re-selecting the current status clears it
    setOpen(false);
  };

  // All keyboard navigation — focus stays on the trigger while the menu is open.
  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); setOpen(true);
      }
      return;
    }
    const n = statuses.length;
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (!n) return;
    if (e.key === 'ArrowDown')      { e.preventDefault(); setActiveIndex(i => (i + 1) % n); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIndex(i => (i - 1 + n) % n); }
    else if (e.key === 'Home')      { e.preventDefault(); setActiveIndex(0); }
    else if (e.key === 'End')       { e.preventDefault(); setActiveIndex(n - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (activeIndex >= 0 && statuses[activeIndex] != null) pick(statuses[activeIndex]);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: accumulate typed chars within 600ms, then jump to the first
      // status whose label starts with the buffer.
      const ta = typeahead.current;
      const now = Date.now();
      ta.str = now - ta.t > 600 ? e.key : ta.str + e.key;
      ta.t = now;
      const q = ta.str.toLowerCase();
      const hit = statuses.findIndex(s => (s || '').toLowerCase().startsWith(q));
      if (hit >= 0) setActiveIndex(hit);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative', '--accent': accent || 'var(--accent)' }}>
      <button
        type="button"
        className="status-candy"
        data-own-press
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open && activeIndex >= 0 ? `scopt-${activeIndex}` : undefined}
        onKeyDown={onKeyDown}
        onClick={() => !disabled && setOpen(o => !o)}
      >
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: dot || 'transparent',
          border: dot ? 'none' : '1px solid var(--border-2)',
          flexShrink: 0,
        }}/>
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
          color: value ? 'var(--text)' : 'var(--text-muted)',
          whiteSpace: 'nowrap',
        }}>{value || placeholder}</span>
        <span aria-hidden style={{
          marginLeft: 2, fontSize: 9, color: 'var(--text-muted)',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}>▾</span>
      </button>

      {/* Overlay menu — height-clip unroll downward (~180ms). */}
      <div
        ref={listRef}
        role="listbox"
        className="status-candy-menu"
        data-open={open ? 'true' : 'false'}
        style={{ maxHeight: open ? 320 : 0, opacity: open ? 1 : 0 }}
      >
        <div style={{ padding: 4 }}>
          {statuses.map((s, i) => {
            const isSel = s === value;
            const isActive = i === activeIndex;
            const sd = dotFor ? dotFor(s) : null;
            return (
              <button
                key={s}
                id={`scopt-${i}`}
                data-idx={i}
                type="button"
                role="option"
                aria-selected={isSel}
                className={'status-candy-option' + (isSel ? ' is-selected' : '') + (isActive ? ' is-active' : '')}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => pick(s)}
              >
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: sd || 'transparent',
                  border: sd ? 'none' : '1px solid var(--border-2)',
                }}/>
                <span style={{ flex: 1, textAlign: 'left' }}>{s}</span>
                {isSel && <span aria-hidden style={{ fontSize: 11 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
