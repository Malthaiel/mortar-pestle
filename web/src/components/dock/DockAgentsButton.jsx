// Dock "Agents" launcher — a dock icon whose popover opens UPWARD from the bar
// (mirrors DockVaultSwitcher) and lists the agents from the registry; each opens
// its own chat window. Rendered by Dock.jsx's renderBtn special-case for id
// 'design-mode' — that id is kept to avoid a dock.order migration, and no longer
// refers to a Design Mode.

import { useEffect, useRef, useState } from 'react';
import { Popover } from '../ui';
import DockButton from './DockButton.jsx';
import { IconSparkles } from '../icons.jsx';
import { listAgents } from '../../agents/agents-registry.js';
import { openConcierge } from '../../agents/concierge/ConciergeProvider.jsx';
import { openAnalyst } from '../../agents/analyst/AnalystProvider.jsx';

export default function DockAgentsButton({ label, accent, onContextMenu }) {
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

  const toggle = () => {
    if (!open && wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };

  const launch = (id) => {
    setOpen(false);
    if (id === 'concierge') openConcierge();
    // Analyst's provider centralizes its own exclusion (closes Concierge).
    else if (id === 'analyst') openAnalyst();
  };

  return (
    <span ref={wrapRef} style={{ display: 'inline-flex', position: 'relative' }}>
      <DockButton
        Icon={IconSparkles}
        label={label}
        onClick={toggle}
        isActive={open}
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
          {listAgents().map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                onClick={() => launch(a.id)}
                style={{
                  appearance: 'none', border: 0, textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 9px', borderRadius: 8,
                  background: 'transparent',
                  color: 'var(--text)', cursor: 'pointer', width: '100%',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{a.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{a.tagline}</span>
                </span>
              </button>
          ))}
        </Popover>
      )}
    </span>
  );
}
