// Keyboard shortcuts cheatsheet — opened by pressing `?` anywhere outside
// an editable field. Lists every globally bound shortcut, grouped by area.
// Closed by `?` again, Esc, click-outside, or the explicit close button.
//
// Dynamic rows are derived from the keybind registry (settings.keybinds with
// defaults fallback), so user rebinds in Settings ▸ Keybinds reflect here
// live. Static rows below capture non-customizable interactions (modal
// dismissal, mouse gestures).

import { useEffect, useMemo } from 'react';
import { getFullRegistry } from '../keybinds/registry.js';
import { formatBinding } from '../keybinds/format.js';

const STATIC_GROUPS = [
  {
    label: 'Modal dismissal',
    items: [
      { keys: ['Esc'], desc: 'Close any open modal / drawer' },
    ],
  },
  {
    label: 'Mouse gestures',
    items: [
      { keys: ['Hold'], desc: 'Long-press a sidebar pill to lift and rearrange' },
      { keys: ['Esc'],  desc: 'Cancel an in-flight reorder mid-drag' },
    ],
  },
];

function buildDynamicGroups(keybinds) {
  const byGroup = new Map();
  for (const entry of getFullRegistry()) {
    const binding = keybinds?.[entry.id] ?? entry.default;
    const row = { keys: formatBinding(binding), desc: entry.label };
    const list = byGroup.get(entry.group) || [];
    list.push(row);
    byGroup.set(entry.group, list);
  }
  return [...byGroup.entries()].map(([label, items]) => ({ label, items }));
}

export default function KeyboardHintsOverlay({ open, onClose, accent, keybinds }) {
  const groups = useMemo(
    () => [...buildDynamicGroups(keybinds), ...STATIC_GROUPS],
    [keybinds],
  );
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const accentColor = accent || 'var(--text)';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1200,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div onClick={onClose} className="candy-backdrop"/>
      <div role="dialog" aria-label="Keyboard shortcuts" className="candy-modal" style={{
        position: 'relative',
        width: 460, maxHeight: '78vh',
        overflow: 'hidden',
        animation: 'fadeIn 0.18s ease',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            Keyboard shortcuts
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 11,
              padding: '4px 6px', borderRadius: 4,
              fontFamily: 'var(--font-mono)',
            }}
          >Esc</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '10px 18px 14px' }}>
          {groups.map(g => (
            <div key={g.label} style={{ marginTop: 12 }}>
              <div style={{
                fontSize: 9, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-faint)', fontWeight: 600,
                marginBottom: 6,
              }}>{g.label}</div>
              {g.items.map((it, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', gap: 12,
                }}>
                  <span style={{
                    fontSize: 12.5, color: 'var(--text)',
                    flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{it.desc}</span>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    {it.keys.map((k, j) => (
                      <span key={j} style={{
                        fontSize: 10, fontFamily: 'var(--font-mono)',
                        color: accentColor,
                        border: '1px solid var(--border-2)',
                        background: `color-mix(in oklch, ${accentColor} 4%, transparent)`,
                        borderRadius: 4, padding: '1px 6px',
                        minWidth: 18, textAlign: 'center',
                      }}>{k}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
