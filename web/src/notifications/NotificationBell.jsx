// The bell button + unread badge. Registers its DOM node with the store so
// toasts can fly into it and the panel can anchor off it. The badge pops on
// every unread increase; the bell pulses when a fly clone lands (absorbKey).
// Both motions gate under the pulse-indicators bucket.
//
// `variant` picks the skin:
//   'split'    — the live one. A bare 28px accent-hover CircleChip mounted as a
//                DIRECT child of the titlebar's fused .candy-split run. No
//                wrapper: .candy-split matches its direct .candy-btn children
//                for the :first-child / :last-child rounding, so a wrapper
//                <span> would swallow those rules and break the shell. The ref
//                and the unread badge therefore ride the BUTTON, and the badge
//                takes the run's in-face shape (the shared Badge in ui/Button.jsx) so it
//                stops AT the seam instead of painting over its neighbour.
//   'titlebar' — the pre-fusion standalone chip, wrapper and all.
//   'dock'     — the original DockButton, kept for any future dock mount.

import { useEffect, useRef, useState } from 'react';
import DockButton from '../components/dock/DockButton.jsx';
import { CircleChip, Badge } from '../components/ui/Button.jsx';
import { candyCenterOffset } from '../util/candy.js';
import { IconBell } from '../components/icons.jsx';
import { useNotifications } from './NotificationProvider.jsx';

export default function NotificationBell({ label, tipDesc, onClick, isActive, accent, onContextMenu, variant = 'dock' }) {
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

  // Both skins want the same optical-centre lift, and both want the unread pill
  // to move with it. In 'split' that is automatic — lift and badge both live on
  // the button. In 'titlebar' the lift sits on the WRAPPER so the absolutely
  // positioned badge rides along; that costs the var candyCenterOffset() reads
  // (--cbtn-depth is declared on .candy-btn, so on a wrapper it falls through to
  // the FULL --candy-depth and lifts 3.5px against its neighbours' 2.5px), which
  // is why the circle shape's own depth is re-declared alongside it.
  const lift = { '--cbtn-depth': 'var(--candy-depth-small)', ...candyCenterOffset() };

  if (variant === 'split') {
    return (
      <CircleChip
        ref={wrapRef}
        data-notif-bell
        title={label}
        data-tip-desc={tipDesc}
        onClick={onClick}
        size={28}
        className={isActive ? 'is-active' : ''}
        style={{
          ...lift,
          animation: absorbing ? 'bellAbsorb 380ms cubic-bezier(0.34,1.56,0.64,1)' : undefined,
        }}
      >
        <IconBell size={16}/>
        {unreadCount > 0 && (
          <Badge key={tick} pulse={`${unreadCount} unread notifications`}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </Badge>
        )}
      </CircleChip>
    );
  }

  return (
    <span
      ref={wrapRef}
      data-notif-bell
      style={{
        display: 'inline-flex', position: 'relative',
        ...(variant === 'titlebar' ? lift : null),
        animation: absorbing ? 'bellAbsorb 380ms cubic-bezier(0.34,1.56,0.64,1)' : undefined,
      }}
    >
      {variant === 'titlebar' ? (
        <CircleChip title={label} onClick={onClick} size={28}>
          <IconBell size={16}/>
        </CircleChip>
      ) : (
        <DockButton Icon={IconBell} label={label} onClick={onClick} isActive={isActive} accent={accent} onContextMenu={onContextMenu} />
      )}
      {unreadCount > 0 && (
        <Badge key={tick} pulse={`${unreadCount} unread notifications`}>
          {unreadCount > 99 ? '99+' : unreadCount}
        </Badge>
      )}
    </span>
  );
}
