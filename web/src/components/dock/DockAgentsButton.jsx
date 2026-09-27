// The "Agents" launcher — a button whose popover lists the agents from the
// registry; each opens its own chat window.
//
// `variant` picks the skin and the direction the popover travels:
//   'titlebar' — the live one. A 28px accent-hover CircleChip mounted as a
//                DIRECT child of a fused .candy-split run in the titlebar's
//                right cluster, popover dropping DOWN from the strip like the
//                account menu beside it. No wrapper <span>: .candy-split rounds
//                its direct .candy-btn children, and the popover is fixed off a
//                measured rect anyway, so the ref rides the button.
//   'dock'     — the original dock icon, popover rising UP off the bar (mirrors
//                TreeVaultSwitcher). Kept for any future dock mount; nothing
//                renders it since the launcher left the Dock 2026-09-15.

import { useEffect, useRef, useState } from 'react';
import { Popover } from '../ui';
import DockButton from './DockButton.jsx';
import { CircleChip } from '../ui/Button.jsx';
import { candyCenterOffset } from '../../util/candy.js';
import { IconBot } from '../icons.jsx';
import { listAgents } from '../../agents/agents-registry.js';
import { openConcierge } from '../../agents/concierge/ConciergeProvider.jsx';
import { openAnalyst } from '../../agents/analyst/AnalystProvider.jsx';

export default function DockAgentsButton({ label, tipDesc, accent, onContextMenu, variant = 'dock' }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    // The dock skin's wrapper contains the popover, so containment alone
    // dismisses correctly. The titlebar skin has no wrapper — wrapRef is the
    // button — so a mousedown INSIDE the menu would close it before the item's
    // click ever fired. [data-agents-menu] exempts the panel in both skins.
    const onDown = (e) => {
      if (e.target.closest?.('[data-agents-menu]')) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
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

  const titlebar = variant === 'titlebar';

  const button = titlebar ? (
    <CircleChip
      ref={wrapRef}
      title={label}
      data-tip-desc={tipDesc}
      onClick={toggle}
      size={28}
      className={open ? 'is-active' : ''}
      style={candyCenterOffset()}
      onContextMenu={onContextMenu}
    ><IconBot size={16}/></CircleChip>
  ) : (
    <DockButton
      Icon={IconBot}
      label={label}
      onClick={toggle}
      isActive={open}
      accent={accent}
      onContextMenu={onContextMenu}
    />
  );

  const panel = open && rect && (
        <Popover
          open
          onClose={() => setOpen(false)}
          // Portalled in the titlebar skin ON PURPOSE: left inline it would be
          // the .candy-split run's last child, and the shell's
          // `.candy-btn:last-child` rounding would stop matching the Agents
          // button — its round outer end would square off every time the menu
          // opened. It is position:fixed either way, so nothing else changes.
          portal={titlebar}
          closeOnOutside={false}
          escToClose={false}
          role="menu"
          ariaLabel="Agents"
          panelProps={{ 'data-agents-menu': '' }}
          style={{
            position: 'fixed', zIndex: 200,
            // Down from the strip, up off the bar — the only difference between
            // the two skins is which edge of the measured rect it hangs from.
            ...(titlebar
              ? { top: rect.bottom + 8 }
              : { bottom: window.innerHeight - rect.top + 8 }),
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
  );

  // The titlebar skin is a DIRECT .candy-split child, so it cannot take the
  // wrapper the dock skin uses; the popover is fixed off a measured rect either
  // way, and the outside-click guard reads wrapRef, which now points at the
  // button itself.
  return titlebar ? <>{button}{panel}</> : (
    <span ref={wrapRef} style={{ display: 'inline-flex', position: 'relative' }}>
      {button}
      {panel}
    </span>
  );
}
