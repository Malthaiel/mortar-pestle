// Central notification store — the single source of truth for every transient
// toast in the app. Replaces the old per-toast components (ConflictToast,
// UpdateAvailableToast, MusicErrorToast). Listens for the three host toast
// events plus a generic `agentic:notify` bridge (used by the music module's
// download stack and any future source). Each event becomes a record that is
// (a) recorded into a persisted history (localStorage, cap 100, marked unread)
// and (b) — for transient types — shown as a live toast that, on dismiss,
// "flies" into the dock bell. The bell + NotificationPanel read this store via
// useNotifications().

import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { applyUpdate } from '../hooks/useUpdateStatus.js';
import { checkForUpdate } from '../hooks/useNetworkUpdate.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { sharedEvents } from '../module-sdk/index.js';

const NotificationCtx = createContext(null);
export const useNotifications = () => useContext(NotificationCtx);

const STORAGE_KEY = 'notifications:history:v1';
const CAP = 100;

// iconKey → glyph. Matches the text glyphs the original toasts painted in their
// accent bubbles (↻ for update, ! for errors/conflict).
export const NOTIF_GLYPH = { rotate: '↻', alert: '!', conflict: '!', download: '↓', bell: '•' };

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(n => n && typeof n === 'object' && n.id && n.type).slice(0, CAP);
  } catch { return []; }
}

let _seq = 0;
function genId(type) { _seq += 1; return `${type}-${Date.now()}-${_seq}`; }

// Startup network-update check runs at most once per app session (survives
// StrictMode's mount/unmount/mount and any provider remount).
let _netStartupKicked = false;

// Resolve a serialized action (kind + payload) to its live handler. Shared by
// the toast action buttons and the panel row-click — reuses the exact handlers
// the old toasts used so behavior is identical.
export async function runNotificationAction(action) {
  if (!action || !action.kind) return;
  if (action.kind === 'restart') { await applyUpdate(action.payload?.diskSha256Prefix); return; }
  if (action.kind === 'reload')  { await api.today(); window.dispatchEvent(new CustomEvent('agentic:conflict-reloaded')); return; }
  if (action.kind === 'undo-note') {
    const p = action.payload || {};
    if (p.op === 'restore-move') await api.noteActions.restoreMovedNote(p);
    else if (p.op === 'restore-carry' || p.op === 'restore-task') await api.noteActions.restoreFromToday(p);
    else if (p.op === 'restore-new-stub') await api.noteActions.restoreNewStub(p);
    else if (p.op === 'restore-toggle') await api.noteActions.restoreToggle(p);
    else if (p.op === 'restore-deleted-note') await api.noteActions.restoreDeletedNote(p);
    else if (p.op === 'restore-deleted-task') await api.noteActions.restoreDeletedTask(p);
    return;
  }
  if (action.kind === 'open-album') {
    const p = action.payload?.albumPath;
    if (p) navigate('/tools/library/music/downloaded/' + encodeURIComponent(p));
    return;
  }
  if (action.kind === 'open-settings-system') {
    sharedEvents.emit('host:open-settings', { tab: 'system' });
  }
}

export function NotificationProvider({ settings, children }) {
  const [notifications, setNotifications] = useState(loadHistory);
  const [dismissed, setDismissed] = useState({});   // ephemeral: transient ids no longer shown
  const [flying, setFlying] = useState([]);          // active fly-to-dock clones
  const [absorbKey, setAbsorbKey] = useState(0);     // bumped when a clone lands → bell pulse

  // Refs mirror state/props so the once-registered listeners never read stale
  // values without re-subscribing on every history change.
  const bellRef = useRef(null);
  const conflictIdRef = useRef(null);                // id of the live conflict toast (single instance)
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;
  const autoCheckRef = useRef(settings?.dev?.autoCheckUpdates);
  autoCheckRef.current = settings?.dev?.autoCheckUpdates;

  // Persist history (cap-bounded) on every change.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(0, CAP))); } catch {}
  }, [notifications]);

  const addNotification = useCallback((partial) => {
    const rec = {
      id: partial.id || genId(partial.type || 'info'),
      type: partial.type || 'info',
      title: partial.title || '',
      message: partial.message || '',
      accent: partial.accent || 'var(--accent)',
      iconKey: partial.iconKey || 'bell',
      createdAt: partial.createdAt || Date.now(),
      read: false,
      transient: partial.transient !== false,                 // default true; downloads pass false
      duration: partial.duration === undefined ? null : partial.duration,
      dismissOnClick: !!partial.dismissOnClick,
      sourceId: partial.sourceId || null,
      action: partial.action || null,
    };
    let added = true;
    setNotifications(prev => {
      if (rec.type === 'download' && rec.sourceId &&
          prev.some(n => n.type === 'download' && n.sourceId === rec.sourceId)) {
        added = false; return prev;                           // download dedupe (survives widget remount)
      }
      return [rec, ...prev].slice(0, CAP);
    });
    if (added && rec.type === 'conflict' && rec.transient) conflictIdRef.current = rec.id;
    return added ? rec.id : null;
  }, []);

  const dismiss = useCallback((id, opts = {}) => {
    if (!id) return;
    setDismissed(prev => (prev[id] ? prev : { ...prev, [id]: true }));
    if (conflictIdRef.current === id) conflictIdRef.current = null;
    if (opts.silent) return;
    // Fly-to-dock unless gated off / no bell anchor / no source rect.
    const flyoutOn = typeof document !== 'undefined' && document.body?.dataset?.animFlyout !== 'off';
    const bell = bellRef.current;
    const src = opts.sourceRect;
    if (!flyoutOn || !bell || !src) return;
    let t; try { t = bell.getBoundingClientRect(); } catch { return; }
    if (!t || (!t.width && !t.height)) return;
    _seq += 1;
    setFlying(prev => [...prev, {
      id: `fly-${_seq}`,
      sourceRect: { left: src.left, top: src.top, width: src.width, height: src.height },
      targetRect: { left: t.left, top: t.top, width: t.width, height: t.height },
      accent: opts.accent || 'var(--accent)',
      iconKey: opts.iconKey || 'bell',
      title: opts.title || '',
    }]);
  }, []);

  const finishFly = useCallback((flyId) => {
    setFlying(prev => prev.filter(f => f.id !== flyId));
    setAbsorbKey(k => k + 1);
  }, []);

  const remove = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]); setDismissed({}); conflictIdRef.current = null;
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications(prev => prev.some(n => !n.read) ? prev.map(n => n.read ? n : { ...n, read: true }) : prev);
  }, []);

  const registerBell = useCallback((node) => { bellRef.current = node || null; }, []);
  const getBellRect = useCallback(() => {
    try { return bellRef.current?.getBoundingClientRect() || null; } catch { return null; }
  }, []);

  // Startup network-update check (GitHub Releases) — gated by the same
  // `autoCheckUpdates` setting as the local dev-build signal. A few seconds
  // after launch, once per session; on a found update it raises a subtle,
  // dismissible toast that deep-links into Settings ▸ System to install.
  useEffect(() => {
    if (autoCheckRef.current === false || _netStartupKicked) return;
    _netStartupKicked = true;
    // Deliberately no cleanup-cancel: the one-shot timer should survive
    // StrictMode's mount/unmount/mount so the check actually fires in dev.
    setTimeout(async () => {
      try {
        const update = await checkForUpdate();
        if (update) addNotification({
          type: 'update', title: 'Update available',
          message: `Version ${update.version} is ready to install`,
          accent: 'var(--accent)', iconKey: 'rotate', duration: 8000,
          action: { label: 'View update', kind: 'open-settings-system' },
        });
      } catch { /* no published release yet / offline — stay silent */ }
    }, 3000);
  }, [addNotification]);

  // ── Event wiring (registered once) ──────────────────────────────────────────
  useEffect(() => {
    const dismissActiveByType = (...types) => setDismissed(prev => {
      const next = { ...prev };
      notificationsRef.current.forEach(n => { if (n.transient && types.includes(n.type)) next[n.id] = true; });
      return next;
    });

    const onUpdate = (e) => {
      if (autoCheckRef.current === false) return;
      const d = e.detail || {};
      const builtAt = (typeof d.diskMtimeSecs === 'number')
        ? new Date(d.diskMtimeSecs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      addNotification({
        type: 'update', title: 'Update available', message: builtAt ? `Built ${builtAt}` : '',
        accent: 'var(--accent)', iconKey: 'rotate', duration: 8000,
        action: { label: 'Restart now', kind: 'restart', payload: { diskSha256Prefix: d.diskSha256Prefix } },
      });
    };
    const onMusicError = (e) => {
      const d = e.detail || {};
      addNotification({
        type: 'music-error', title: `Couldn't play ${d.title || 'track'}`,
        message: d.message || 'playback failed', accent: 'var(--error)', iconKey: 'alert',
        duration: 5000, dismissOnClick: true,
      });
    };
    const onConflict = () => {
      if (conflictIdRef.current) return;                      // single live conflict (matches old toast)
      addNotification({
        type: 'conflict', title: 'Daily note changed externally',
        accent: '#e0a06b', iconKey: 'conflict', duration: null,
        action: { label: 'Reload', kind: 'reload' },
      });
    };
    const onConflictResolved = () => { if (conflictIdRef.current) dismiss(conflictIdRef.current, { silent: true }); };
    const onUpdateDismiss = () => dismissActiveByType('update');
    const onHash = () => { dismissActiveByType('update', 'conflict'); conflictIdRef.current = null; };
    const onNotify = (e) => { if (e.detail) addNotification(e.detail); };

    window.addEventListener('agentic:update-available', onUpdate);
    window.addEventListener('agentic:update-available-dismiss', onUpdateDismiss);
    window.addEventListener('agentic:music-play-error', onMusicError);
    window.addEventListener('agentic:conflict', onConflict);
    window.addEventListener('agentic:conflict-dismiss', onConflictResolved);
    window.addEventListener('agentic:conflict-reloaded', onConflictResolved);
    window.addEventListener('agentic:notify', onNotify);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('agentic:update-available', onUpdate);
      window.removeEventListener('agentic:update-available-dismiss', onUpdateDismiss);
      window.removeEventListener('agentic:music-play-error', onMusicError);
      window.removeEventListener('agentic:conflict', onConflict);
      window.removeEventListener('agentic:conflict-dismiss', onConflictResolved);
      window.removeEventListener('agentic:conflict-reloaded', onConflictResolved);
      window.removeEventListener('agentic:notify', onNotify);
      window.removeEventListener('hashchange', onHash);
    };
  }, [addNotification, dismiss]);

  const active = notifications.filter(n => n.transient && !dismissed[n.id]);
  const unreadCount = notifications.reduce((a, n) => a + (n.read ? 0 : 1), 0);

  const value = {
    notifications, active, unreadCount, absorbKey,
    addNotification, dismiss, remove, clearAll, markAllRead,
    registerBell, getBellRect, runAction: runNotificationAction,
  };

  return (
    <NotificationCtx.Provider value={value}>
      {children}
      {flying.length > 0 && createPortal(
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 131 }}>
          {flying.map(f => <FlyClone key={f.id} fly={f} onDone={() => finishFly(f.id)} />)}
        </div>,
        document.body,
      )}
    </NotificationCtx.Provider>
  );
}

// A single fly-to-dock clone — animated with the Web Animations API (transform
// only). Gated upstream: dismiss() only spawns one when data-anim-flyout != off.
function FlyClone({ fly, onDone }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') { onDone(); return; }
    const s = fly.sourceRect, t = fly.targetRect;
    const dx = (t.left + t.width / 2) - (s.left + s.width / 2);
    const dy = (t.top + t.height / 2) - (s.top + s.height / 2);
    const anim = el.animate([
      { transform: 'translate(0px,0px) scale(1)', opacity: 0.96 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 44}px) scale(0.55)`, opacity: 0.85, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.1)`, opacity: 0 },
    ], { duration: 440, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
    let done = false;
    const finish = () => { if (!done) { done = true; onDone(); } };
    anim.onfinish = finish; anim.oncancel = finish;
    return () => { try { anim.cancel(); } catch {} };
  }, []);

  const s = fly.sourceRect;
  return (
    <div ref={ref} style={{
      position: 'absolute', left: s.left, top: s.top,
      width: Math.max(120, s.width), height: s.height,
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      boxSizing: 'border-box', background: 'var(--bg-elev, #1a1a1a)',
      border: '1px solid var(--border)',
      borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.28)', color: 'var(--text)',
      fontFamily: 'var(--font-sans)', fontSize: 13, overflow: 'hidden',
      transformOrigin: 'center', willChange: 'transform, opacity',
    }}>
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
        background: `color-mix(in oklch, ${fly.accent} 18%, transparent)`,
        color: fly.accent, fontWeight: 700, fontSize: 13,
      }}>{NOTIF_GLYPH[fly.iconKey] || '•'}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
        {fly.title}
      </span>
    </div>
  );
}
