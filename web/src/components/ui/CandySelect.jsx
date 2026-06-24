// Generic candy <select> replacement — a custom dropdown styled to match the
// app's candy controls. Mirrors StatusDropdown's structure (trigger button +
// absolute height-clip overlay menu, click-outside + Esc) but is module-agnostic:
// no status dot, no clear-on-reselect. The trigger shows the current option's
// label; pass a `placeholder` for command-style menus where no option stays
// selected (e.g. the video chapters jump menu).
//
// Keyboard: focus stays on the trigger while open, so all navigation lives on
// the trigger's onKeyDown — ↑/↓ move the highlight (wrapping), Home/End jump to
// the ends, Enter/Space pick the highlighted option, type-ahead jumps to the
// first label matching recent keystrokes, Esc closes. When closed, ↑/↓/Enter/
// Space open the menu. (StatusDropdown shares the same keyboard model.)
//
// IMPORTANT: the menu is an absolute sibling INSIDE the trigger's relative
// wrapper — never portal it to document.body. The video player requests
// fullscreen on its own subtree (.video-cinema), so a body-portaled menu would
// render outside the fullscreen element and disappear in fullscreen.
//
// Props:
//   value        current value (matched against options for the trigger label)
//   options      [{ value, label }]
//   onChange     (value) => void   — receives the raw option value
//   title        tooltip / aria-label on the trigger
//   placeholder  shown when no option matches value (default '')
//   direction    'up' | 'down' (default 'down') — 'up' for the bottom control bar
//   compact      smaller trigger + menu, fills its row — for the subtitle panel
//   disabled     disables the trigger
// Styling: trigger = two-layer .candy-btn[data-shape="select"]; the overlay menu
// keeps its own .candy-select-menu / .candy-select-option classes (no portal).

import { useEffect, useRef, useState } from 'react';

export default function CandySelect({
  value, options, onChange, title, placeholder = '',
  direction = 'down', compact = false, disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef(null);
  const listRef = useRef(null);
  const typeahead = useRef({ str: '', t: 0 });
  const current = options.find(o => o.value === value);

  // On open, highlight the selected option (or the first); clear on close.
  useEffect(() => {
    if (!open) { setActiveIndex(-1); return; }
    const sel = options.findIndex(o => o.value === value);
    setActiveIndex(sel >= 0 ? sel : 0);
  }, [open]);

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    listRef.current
      .querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // Click-outside + Escape close. The mousedown listener is CAPTURE phase (like
  // StatusDropdown) so a parent's bubble-phase stopPropagation — e.g. the
  // subtitle panel's — can't swallow it and leave the menu stuck open.
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

  const pick = (v) => { onChange(v); setOpen(false); };

  // All keyboard navigation — focus stays on the trigger while the menu is open.
  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); setOpen(true);
      }
      return;
    }
    const n = options.length;
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (!n) return;
    if (e.key === 'ArrowDown')      { e.preventDefault(); setActiveIndex(i => (i + 1) % n); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIndex(i => (i - 1 + n) % n); }
    else if (e.key === 'Home')      { e.preventDefault(); setActiveIndex(0); }
    else if (e.key === 'End')       { e.preventDefault(); setActiveIndex(n - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (activeIndex >= 0 && options[activeIndex]) pick(options[activeIndex].value);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: accumulate typed chars within 600ms, then jump to the first
      // option whose label starts with the buffer.
      const ta = typeahead.current;
      const now = Date.now();
      ta.str = now - ta.t > 600 ? e.key : ta.str + e.key;
      ta.t = now;
      const q = ta.str.toLowerCase();
      const hit = options.findIndex(o => (o.label || '').toLowerCase().startsWith(q));
      if (hit >= 0) setActiveIndex(hit);
    }
  };

  const sfx = compact ? ' is-compact' : '';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className={'candy-btn' + sfx}
        data-shape="select"
        data-own-press
        title={title}
        aria-label={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open && activeIndex >= 0 ? `csopt-${activeIndex}` : undefined}
        onKeyDown={onKeyDown}
        onClick={() => !disabled && setOpen(o => !o)}
      >
        <span className="candy-face">
          <span>{current ? current.label : placeholder}</span>
          <span aria-hidden style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}>▾</span>
        </span>
      </button>

      {/* Overlay menu — absolute sibling, NO portal (see file header). */}
      <div
        ref={listRef}
        role="listbox"
        className={'candy-select-menu is-' + direction + sfx}
        data-open={open ? 'true' : 'false'}
        style={{ maxHeight: open ? 320 : 0, opacity: open ? 1 : 0 }}
      >
        <div style={{ padding: 4 }}>
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isActive = i === activeIndex;
            return (
              <button
                key={o.value}
                id={`csopt-${i}`}
                data-idx={i}
                type="button"
                role="option"
                aria-selected={isSel}
                className={'candy-select-option' + (isSel ? ' is-selected' : '') + (isActive ? ' is-active' : '')}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => pick(o.value)}
              >
                <span style={{ flex: 1, textAlign: 'left' }}>{o.label}</span>
                {isSel && <span aria-hidden style={{ fontSize: 11 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
