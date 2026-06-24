// The notification history panel — pops up above the dock bell. Renders through
// the shared Popover template: candy floating surface, anchored to the registered
// bell rect via useAnchoredRect (falls back to centered-above-dock if the bell is
// gone, e.g. hover-dock collapsed). Esc + click-outside close (the bell itself is
// exempt so it toggles). Opening marks everything read. Rows show per-type accent
// glyph + title + message + relative time; click an actionable row to run its
// action; × removes a row; Clear all sweeps the list.

import { useEffect, useState } from 'react';
import { useNotifications, runNotificationAction, NOTIF_GLYPH } from './NotificationProvider.jsx';
import { Popover, useAnchoredRect, OutlinedBtn } from '../components/ui';
import { IconX } from '../components/icons.jsx';
import { timeAgo } from '../util/time.js';

const PANEL_W = 340;

export default function NotificationPanel({ open, onClose, accent }) {
  const { notifications, markAllRead, remove, clearAll, getBellRect } = useNotifications();
  const [clearing, setClearing] = useState(false);
  const pos = useAnchoredRect(() => getBellRect?.(), { open, width: PANEL_W });

  useEffect(() => { if (open) markAllRead(); }, [open, markAllRead]);

  if (!open || !pos) return null;

  const doClear = () => {
    setClearing(true);
    setTimeout(() => { clearAll(); setClearing(false); onClose?.(); }, 260);
  };

  const onRowClick = async (n) => {
    if (!n.action) return;
    try { await runNotificationAction(n.action); } catch {}
    if (n.action.kind === 'undo-note') remove(n.id);
    if (n.action.kind === 'open-album') onClose?.();
  };

  return (
    <Popover
      open
      onClose={onClose}
      accent={accent}
      title="Notifications"
      outsideExempt="[data-notif-bell]"
      headerActions={notifications.length > 0 ? <OutlinedBtn small onClick={doClear}>Clear all</OutlinedBtn> : null}
      style={{
        position: 'fixed', left: pos.left, bottom: pos.bottom, width: PANEL_W,
        maxHeight: 420, zIndex: 130, transformOrigin: 'bottom center',
        animation: 'notifPanelIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      {notifications.length === 0 ? (
        <div style={{ padding: '32px 20px', textAlign: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>All clear</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Updates, downloads, and alerts collect here.
          </div>
        </div>
      ) : (
        <div style={{ padding: 6 }}>
          {notifications.map((n, i) => (
            <div
              key={n.id}
              onClick={() => onRowClick(n)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px', borderRadius: 8, marginBottom: 2,
                background: n.read ? 'transparent' : `color-mix(in oklch, ${n.accent} 8%, transparent)`,
                cursor: n.action ? 'pointer' : 'default',
                animation: clearing ? `notifSweep 220ms cubic-bezier(0.7,0,0.84,0) ${i * 25}ms both` : undefined,
              }}
            >
              <span aria-hidden="true" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                background: `color-mix(in oklch, ${n.accent} 18%, transparent)`,
                color: n.accent, fontWeight: 700, fontSize: 12,
              }}>{NOTIF_GLYPH[n.iconKey] || '•'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {n.title}
                </div>
                {n.message && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1, lineHeight: 1.4, wordBreak: 'break-word' }}>
                    {n.message}
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>
                  {timeAgo(new Date(n.createdAt).toISOString())}{n.action ? ` · ${n.action.label}` : ''}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); remove(n.id); }}
                title="Dismiss" aria-label="Dismiss notification"
                style={{
                  flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-faint)', padding: 2, display: 'flex', lineHeight: 1,
                }}
              ><IconX /></button>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}
