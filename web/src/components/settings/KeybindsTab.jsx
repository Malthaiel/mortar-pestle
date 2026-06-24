// Settings ▸ Keybinds. Rebind every host shortcut via press-to-record.
//
// Behavior:
//   - Click a row to enter listening state. The row's border pulses in
//     accent; chips become a live modifier preview that updates as you hold
//     Shift / Alt / Ctrl / Meta.
//   - Press a non-modifier key while holding any modifiers -> captures as a
//     chord. The captured key cap visually "presses down" with a brief
//     translateY animation.
//   - Hold a modifier alone for 1 second without pressing any other key ->
//     captures as a modifier-only hold binding (for hold-style actions like
//     sidebar peek).
//   - Press Escape (no modifiers) -> cancel without changing the binding.
//   - Press Backspace (no modifiers) -> clear the binding (set to undefined,
//     which falls back to the registry default on next access; or treats as
//     unbound depending on the matcher's null-check).
//   - If the new binding collides with another action, the colliding action
//     is auto-unbound (reset to its default) and a toast announces the swap.
//
// Reset:
//   - Per-row ↺ icon (visible only when the row's binding differs from default)
//   - "Reset all keybinds" footer button (resets the whole keybinds object)

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KEYBINDS_DEFAULT,
  getFullRegistry,
} from '../../keybinds/registry.js';
import { formatBinding, IS_MAC } from '../../keybinds/format.js';
import { bindingsEqual } from '../../keybinds/match.js';
import { OutlinedBtn, IconBtn } from '../ui/Button.jsx';
import { SectionHeader } from '../ui/Section.jsx';

const HOLD_MS = 1000;

const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta']);

function liveChipsFromModifiers(mods) {
  const chips = [];
  if (mods.meta)  chips.push(IS_MAC ? '⌘' : 'Ctrl');
  if (mods.ctrl && !mods.meta) chips.push('Ctrl');
  if (mods.alt)   chips.push(IS_MAC ? '⌥' : 'Alt');
  if (mods.shift) chips.push(IS_MAC ? '⇧' : 'Shift');
  return chips;
}

function captureFromEvent(e) {
  // Modifier-only events emit e.key in MODIFIER_KEYS; the row's effect
  // handles those separately to time the 1-second hold detection.
  // This handler is for non-modifier press: build a chord with whatever
  // modifiers are active.
  const modifiers = [];
  if (e.metaKey || e.ctrlKey) modifiers.push('meta');
  if (e.altKey)  modifiers.push('alt');
  if (e.shiftKey) modifiers.push('shift');
  return { kind: 'chord', key: e.key, modifiers };
}

export default function KeybindsTab({ settings, setSetting, accent, initialFilter, onClearFilter }) {
  const accentColor = accent || 'var(--text)';
  const keybinds = settings?.keybinds || KEYBINDS_DEFAULT;
  const [listeningId, setListeningId] = useState(null);
  const [toast, setToast] = useState(null);

  const groups = useMemo(() => {
    const map = new Map();
    for (const e of getFullRegistry()) {
      const list = map.get(e.group) || [];
      list.push(e);
      map.set(e.group, list);
    }
    return [...map.entries()];
  }, []);

  function applyBinding(actionId, binding) {
    // Scan EFFECTIVE bindings across the full registry (module rows may not
    // exist in settings.keybinds yet — they still conflict via defaults).
    const conflict = getFullRegistry()
      .map(en => [en.id, keybinds[en.id] ?? KEYBINDS_DEFAULT[en.id]])
      .find(([id, b]) => id !== actionId && bindingsEqual(b, binding));
    const next = { ...keybinds, [actionId]: binding };
    if (conflict) {
      // Reset the conflicting action to its default rather than leaving it
      // undefined; defaults are still useful even if they overlap something.
      // The user can re-bind the displaced action manually after.
      next[conflict[0]] = KEYBINDS_DEFAULT[conflict[0]];
      const entry = getFullRegistry().find(x => x.id === conflict[0]);
      setToast({
        actionLabel: entry?.label || conflict[0],
        chips: formatBinding(binding),
      });
    }
    setSetting('keybinds', next);
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  function resetRow(actionId) {
    applyBinding(actionId, KEYBINDS_DEFAULT[actionId]);
  }

  function resetAll() {
    setSetting('keybinds', { ...KEYBINDS_DEFAULT });
    setListeningId(null);
  }

  return (
    <>
      <style>{`
        @keyframes keybindRowPulse {
          0%, 100% { box-shadow: 0 0 0 1px var(--row-accent-soft), 0 0 0 0 transparent; }
          50%      { box-shadow: 0 0 0 1px var(--row-accent), 0 0 12px 2px var(--row-accent-soft); }
        }
        @keyframes keyCapPress {
          0%   { transform: translateY(0); box-shadow: 0 1.5px 0 var(--border-2), inset 0 1px 0 rgba(255,255,255,0.06); }
          50%  { transform: translateY(1.5px); box-shadow: 0 0 0 var(--border-2), inset 0 1px 2px rgba(0,0,0,0.18); }
          100% { transform: translateY(0); box-shadow: 0 1.5px 0 var(--border-2), inset 0 1px 0 rgba(255,255,255,0.06); }
        }
        @keyframes toastIn {
          from { transform: translateY(-12px); opacity: 0; }
          to   { transform: translateY(0);     opacity: 1; }
        }
      `}</style>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <SectionHeaderInline title="Keybinds" subtitle="Click a binding to record a new one. Esc cancels, Backspace clears. Modifier-only hold bindings (like Shift to peek) capture after a 1-second hold with no follow-up key." />

        {initialFilter && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
              color: 'var(--text-muted)',
            }}>Showing {initialFilter} keybinds only</span>
            <OutlinedBtn small onClick={onClearFilter}>Show all ✕</OutlinedBtn>
          </div>
        )}

        {(initialFilter ? groups.filter(([g]) => g === initialFilter) : groups).map(([groupName, entries]) => (
          <div key={groupName} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              fontSize: 10, fontFamily: 'var(--font-mono)',
              letterSpacing: '0.1em', textTransform: 'uppercase',
              color: 'var(--text-faint)', fontWeight: 600,
              padding: '4px 0 2px',
            }}>{groupName}</div>
            <div style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface)',
              overflow: 'hidden',
            }}>
              {entries.map((entry, i) => (
                <KeybindRow
                  key={entry.id}
                  entry={entry}
                  binding={keybinds[entry.id]}
                  listening={listeningId === entry.id}
                  isLast={i === entries.length - 1}
                  accent={accentColor}
                  onStart={() => setListeningId(entry.id)}
                  onCancel={() => setListeningId(null)}
                  onCapture={(b) => { applyBinding(entry.id, b); setListeningId(null); }}
                  onClear={() => { applyBinding(entry.id, KEYBINDS_DEFAULT[entry.id]); setListeningId(null); }}
                  onReset={() => resetRow(entry.id)}
                />
              ))}
            </div>
          </div>
        ))}

        <div style={{
          marginTop: 8, paddingTop: 14,
          borderTop: '1px solid var(--border-soft)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <OutlinedBtn small onClick={resetAll}>Reset all keybinds</OutlinedBtn>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'absolute',
          top: 16, right: 26,
          background: 'var(--surface)',
          border: `1px solid ${accentColor}`,
          borderLeftWidth: 4,
          borderRadius: 'var(--radius-md)',
          padding: '10px 14px',
          fontSize: 12.5,
          color: 'var(--text)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          zIndex: 4,
          maxWidth: 320,
          animation: 'toastIn 200ms cubic-bezier(0.16, 1, 0.3, 1)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ color: 'var(--text-muted)' }}>Reset</span>
          <strong style={{ color: 'var(--text)' }}>{toast.actionLabel}</strong>
          <span style={{ color: 'var(--text-muted)' }}>— conflict with</span>
          <span style={{ display: 'inline-flex', gap: 3 }}>
            {toast.chips.map((c, i) => (
              <span key={i} style={{
                fontFamily: 'var(--font-mono)', fontSize: 10.5,
                padding: '1px 6px', borderRadius: 4,
                background: `color-mix(in oklch, ${accentColor} 8%, transparent)`,
                color: accentColor,
              }}>{c}</span>
            ))}
          </span>
        </div>
      )}
    </>
  );
}

function SectionHeaderInline({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
        {title}
      </h2>
      {subtitle && (
        <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 560 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function KeybindRow({ entry, binding, listening, isLast, accent, onStart, onCancel, onCapture, onClear, onReset }) {
  const [liveMods, setLiveMods] = useState({ meta: false, ctrl: false, alt: false, shift: false });
  const [pressFlash, setPressFlash] = useState(false);
  const holdTimerRef = useRef(null);
  const isDefault = bindingsEqual(binding, entry.default);
  const effectiveBinding = binding ?? entry.default;

  // Listening: capture keydown / keyup events globally while this row is active.
  useEffect(() => {
    if (!listening) {
      setLiveMods({ meta: false, ctrl: false, alt: false, shift: false });
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      return;
    }

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const mods = {
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };
      setLiveMods(mods);

      // Pure Escape -> cancel
      if (e.key === 'Escape' && !mods.meta && !mods.ctrl && !mods.alt && !mods.shift) {
        onCancel();
        return;
      }
      // Pure Backspace -> clear (reset to default)
      if (e.key === 'Backspace' && !mods.meta && !mods.ctrl && !mods.alt && !mods.shift) {
        onClear();
        return;
      }

      // Non-modifier press -> capture chord
      if (!MODIFIER_KEYS.has(e.key)) {
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        setPressFlash(true);
        const binding = captureFromEvent(e);
        // Brief animation breathing room before capture commits
        setTimeout(() => { setPressFlash(false); onCapture(binding); }, 160);
        return;
      }

      // Modifier-only press -> arm the hold timer if not already armed
      if (!holdTimerRef.current && !e.repeat) {
        const modifier = e.key === 'Control' ? 'Ctrl' : e.key;
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          setPressFlash(true);
          setTimeout(() => {
            setPressFlash(false);
            onCapture({ kind: 'hold', modifier });
          }, 160);
        }, HOLD_MS);
      }
    };

    const onKeyUp = (e) => {
      const mods = {
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };
      setLiveMods(mods);
      // If all modifiers released before the timer fires, cancel the hold.
      if (holdTimerRef.current && !mods.meta && !mods.ctrl && !mods.alt && !mods.shift) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    };

    const onBlur = () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      onCancel();
    };

    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    };
  }, [listening, onCancel, onCapture, onClear]);

  const liveChips = liveChipsFromModifiers(liveMods);
  const chipsToShow = listening
    ? (liveChips.length > 0 ? liveChips : ['…'])
    : formatBinding(effectiveBinding);
  const isPlaceholder = listening && liveChips.length === 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { if (!listening) onStart(); }}
      onKeyDown={(e) => {
        if (!listening && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onStart();
        }
      }}
      style={{
        // Use CSS custom properties keyed on the accent so the pulse keyframes
        // can reference them without recomputing inline shadows each tick.
        '--row-accent':       accent,
        '--row-accent-soft':  `color-mix(in oklch, ${accent} 28%, transparent)`,
        position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12,
        padding: '11px 14px',
        borderBottom: isLast ? 'none' : '1px solid var(--border-soft)',
        background: listening ? `color-mix(in oklch, ${accent} 4%, transparent)` : 'transparent',
        cursor: listening ? 'default' : 'pointer',
        transition: 'background 160ms ease',
        animation: listening ? 'keybindRowPulse 1.4s ease-in-out infinite' : 'none',
        borderRadius: 0,
        outline: 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
        <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{entry.label}</span>
        {listening && (
          <span style={{
            fontSize: 10.5, color: accent,
            fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>Listening… Esc cancels · Backspace clears</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="candy-chip-row" style={{ '--candy-gap': '4px' }}>
          {chipsToShow.map((label, i) => (
            <KeyCap
              key={i}
              label={label}
              accent={accent}
              pressing={pressFlash && i === chipsToShow.length - 1}
              ghost={isPlaceholder}
              listening={listening}
            />
          ))}
        </div>
        {!isDefault && !listening && (
          <IconBtn
            size={26}
            title="Reset to default"
            onClick={(e) => { e.stopPropagation(); onReset(); }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15A9 9 0 1 0 6 5.3L1 10"/>
            </svg>
          </IconBtn>
        )}
      </div>
    </div>
  );
}

function KeyCap({ label, accent, pressing, ghost, listening }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 24, height: 22,
      padding: '0 7px',
      fontSize: 11, fontFamily: 'var(--font-mono)',
      color: ghost ? 'var(--text-faint)' : (listening ? accent : 'var(--text)'),
      background: listening
        ? `color-mix(in oklch, ${accent} 6%, var(--surface))`
        : 'var(--surface)',
      border: listening
        ? `1px solid ${accent}`
        : '1px solid var(--border-2)',
      borderTopColor: listening ? accent : 'var(--border)',
      borderLeftColor: listening ? accent : 'var(--border)',
      borderRadius: 5,
      boxShadow: '0 1.5px 0 var(--border-2), inset 0 1px 0 rgba(255,255,255,0.06)',
      animation: pressing ? 'keyCapPress 160ms ease' : 'none',
      transition: 'color 120ms ease, background 120ms ease, border-color 120ms ease',
      userSelect: 'none',
    }}>
      {label}
    </span>
  );
}
