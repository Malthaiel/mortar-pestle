// The bell button + unread badge. Registers its DOM node with the store so
// toasts can fly into it and the panel can anchor off it. The badge pops on
// every unread increase; the bell pulses when a fly clone lands (absorbKey).
// Both motions gate under the pulse-indicators bucket.
//
// `variant` picks the skin: 'titlebar' (the live one — a 28px accent-hover
// CircleChip in the titlebar's left cluster) or 'dock' (the original
// DockButton, kept for any future dock mount).

import { useEffect, useRef, useState } from 'react';
import DockButton from '../components/dock/DockButton.jsx';
import { CircleChip } from '../components/ui/Button.jsx';
import { candyCenterOffset } from '../util/candy.js';
import { IconBell } from '../components/icons.jsx';
import { useNotifications } from './NotificationProvider.jsx';

export default function NotificationBell({ label, onClick, isActive, accent, onContextMenu, variant = 'dock' }) {
  const { unreadCount, registerBell, absorbKey } = useNotifications();
  const wrapRef = useRef(null);
  const prevCount = useRef(unreadCount);
  const [tick, setTick] = useState(0);          // remount key → badge pop on increase
  const [absorbing, setAbsorbing] = useState(false);

  useEffect(() => {
    registerBell(wrapRef.current);
    return () => registerBell(null);
  }, [registerBell]);

  useEffect(() => {
    if (unreadCount > prevCount.current) setTick(t => t + 1);
    prevCount.current = unreadCount;
  }, [unreadCount]);

  useEffect(() => {
    if (absorbKey === 0) return undefined;
    setAbsorbing(true);
    const t = setTimeout(() => setAbsorbing(false), 380);
    return () => clearTimeout(t);
  }, [absorbKey]);

  return (
    <span
      ref={wrapRef}
      data-notif-bell
      style={{
        display: 'inline-flex', position: 'relative',
        // Optical-centre lift goes on the WRAPPER, not the button, so the
        // absolutely-positioned unread badge rides along with it. That costs us
        // the var candyCenterOffset() reads: --cbtn-depth is declared on
        // .candy-btn, so on a wrapper it falls through to the FULL --candy-depth
        // and lifts 3.5px while the plain CircleChips beside it lift 2.5px —
        // the bell sat 1px high. Re-declare the circle shape's own depth here so
        // the fallback resolves to the same number the button uses.
        ...(variant === 'titlebar' ? { '--cbtn-depth': 'var(--candy-depth-small)', ...candyCenterOffset() } : null),
        animation: absorbing ? 'bellAbsorb 380ms cubic-bezier(0.34,1.56,0.64,1)' : undefined,
      }}
    >
      {variant === 'titlebar' ? (
        <CircleChip title={label} onClick={onClick} size={28} className="is-hover-accent">
          <IconBell size={16}/>
        </CircleChip>
      ) : (
        <DockButton Icon={IconBell} label={label} onClick={onClick} isActive={isActive} accent={accent} onContextMenu={onContextMenu} />
      )}
      {unreadCount > 0 && (
        <span
          key={tick}
          aria-label={`${unreadCount} unread notifications`}
          style={{
            position: 'absolute', top: -3, right: -3, zIndex: 1,
            minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 8, background: 'var(--accent)', color: '#fff',
            fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)', lineHeight: 1,
            border: `1.5px solid ${variant === 'titlebar' ? 'var(--surface)' : 'var(--dock-bg, oklch(0.190 0.005 78))'}`,
            pointerEvents: 'none',
            animation: 'badgeTick 320ms cubic-bezier(0.34,1.56,0.64,1)',
          }}
        >{unreadCount > 99 ? '99+' : unreadCount}</span>
      )}
    </span>
  );
}
