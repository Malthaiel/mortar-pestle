// Dock "Agents" launcher — the repurposed Design dock button. A dock icon whose
// popover opens UPWARD from the bar (mirrors DockVaultSwitcher) and lists the
// agents from the registry: Atelier → enters Design Mode, Concierge → opens its
// chat window. Rendered by Dock.jsx's renderBtn special-case for id 'design-mode'
// (kept to avoid a dock.order migration).

import { useEffect, useRef, useState } from 'react';
import { Popover } from '../ui';
import DockButton from './DockButton.jsx';
import { IconSparkles } from '../icons.jsx';
import { listAgents } from '../../agents/agents-registry.js';
import { openConcierge } from '../../agents/concierge/ConciergeProvider.jsx';

export default function DockAgentsButton({ label, accent, settings, setSetting, onContextMenu }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const designOn = !!settings?.agents?.mode;

  const toggle = () => {
    if (!open && wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };

  const launch = (id) => {
    setOpen(false);
    if (id === 'atelier') setSetting('agents', { mode: true });
    // Concierge exits Design Mode first — one agent surface at a time (they share
    // the global agent-chat event stream).
    else if (id === 'concierge') { setSetting('agents', { mode: false }); openConcierge(); }
  };

  return (
    <span ref={wrapRef} style={{ display: 'inline-flex', position: 'relative' }}>
      <DockButton
        Icon={IconSparkles}
        label={label}
        onClick={toggle}
        isActive={open || designOn}
        accent={accent}
        onContextMenu={onContextMenu}
      />

      {open && rect && (
        <Popover
          open
          onClose={() => setOpen(false)}
          portal={false}
          closeOnOutside={false}
          escToClose={false}
          role="menu"
          ariaLabel="Agents"
          style={{
            position: 'fixed', zIndex: 200,
            bottom: window.innerHeight - rect.top + 8,
            left: Math.max(8, Math.min(rect.left + rect.width / 2 - 115, window.innerWidth - 238)),
            width: 230,
          }}
          bodyStyle={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          {listAgents().map((a) => {
            const isOn = a.id === 'atelier' && designOn;
            return (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                onClick={() => launch(a.id)}
                style={{
                  appearance: 'none', border: 0, textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 9px', borderRadius: 8,
                  background: isOn ? `color-mix(in oklch, ${accent || 'var(--accent)'} 14%, transparent)` : 'transparent',
                  color: 'var(--text)', cursor: 'pointer', width: '100%',
                }}
                onMouseEnter={(e) => { if (!isOn) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { if (!isOn) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{a.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{a.tagline}</span>
                </span>
                {isOn && (
                  <span style={{ fontSize: 9.5, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>on</span>
                )}
              </button>
            );
          })}
        </Popover>
      )}
    </span>
  );
}
