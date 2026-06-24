// The dock bell button + unread badge. Mounted by Dock.jsx's renderBtn
// special-case (mirrors the design-mode aura special-case). Registers its DOM
// node with the store so toasts can fly into it and the panel can anchor above
// it. The badge pops on every unread increase; the bell pulses when a fly clone
// lands (absorbKey). Both motions gate under the pulse-indicators bucket.

import { useEffect, useRef, useState } from 'react';
import DockButton from '../components/dock/DockButton.jsx';
import { IconBell } from '../components/icons.jsx';
import { useNotifications } from './NotificationProvider.jsx';

export default function NotificationBell({ label, onClick, isActive, accent, onContextMenu }) {
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
        animation: absorbing ? 'bellAbsorb 380ms cubic-bezier(0.34,1.56,0.64,1)' : undefined,
      }}
    >
      <DockButton Icon={IconBell} label={label} onClick={onClick} isActive={isActive} accent={accent} onContextMenu={onContextMenu} />
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
            border: '1.5px solid var(--dock-bg, oklch(0.190 0.005 78))', pointerEvents: 'none',
            animation: 'badgeTick 320ms cubic-bezier(0.34,1.56,0.64,1)',
          }}
        >{unreadCount > 99 ? '99+' : unreadCount}</span>
      )}
    </span>
  );
}
