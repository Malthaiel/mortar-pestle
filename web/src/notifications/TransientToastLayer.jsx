// Renders the live (transient) notifications as bottom-right toast cards — the
// generic replacement for ConflictToast / UpdateAvailableToast / MusicErrorToast.
// One card per `active` notification; each ToastRow owns a mount-once auto-dismiss
// timer (keyed by id so parent re-renders never reset it) and, on dismiss,
// measures its rect and hands it to the store for the fly-to-dock animation. The
// card chrome itself is the shared <Toast> primitive.

import { useEffect, useRef, useState } from 'react';
import { useNotifications, runNotificationAction, NOTIF_GLYPH } from './NotificationProvider.jsx';
import { OutlinedBtn, Toast } from '../components/ui';

export default function TransientToastLayer() {
  const { active, dismiss, remove } = useNotifications();
  if (!active.length) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 20, right: 20, zIndex: 100,
      display: 'flex', flexDirection: 'column-reverse', gap: 10,
      pointerEvents: 'none', maxWidth: 'calc(100vw - 40px)',
    }}>
      {active.map(n => <ToastRow key={n.id} n={n} onDismiss={dismiss} onRemove={remove} />)}
    </div>
  );
}

function ToastRow({ n, onDismiss, onRemove }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState(null);

  const dismissWithFly = () => {
    let rect = null;
    try { rect = ref.current?.getBoundingClientRect(); } catch {}
    onDismiss(n.id, rect ? { sourceRect: rect, accent: n.accent, iconKey: n.iconKey, title: n.title } : {});
  };

  // Mount-once auto-dismiss timer. eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (n.duration == null) return undefined;
    const t = setTimeout(dismissWithFly, n.duration);
    return () => clearTimeout(t);
  }, []);

  const onAction = async () => {
    if (busy || !n.action) return;
    setBusy(true); setErrMsg(null);
    try {
      await runNotificationAction(n.action);
      if (n.action.kind === 'undo-note') { onRemove?.(n.id); return; }
      // restart never returns; reload self-dismisses via the conflict-reloaded event.
    } catch (e) {
      setErrMsg((e && (e.message || e.toString())) || 'action failed');
      setBusy(false);
    }
  };

  return (
    <Toast
      innerRef={ref}
      accent={n.accent}
      glyph={NOTIF_GLYPH[n.iconKey] || '•'}
      title={n.title}
      message={n.message}
      error={errMsg}
      clickable={n.dismissOnClick}
      onClick={dismissWithFly}
      actions={n.action ? (
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <OutlinedBtn small onClick={onAction} disabled={busy}>{busy ? '…' : n.action.label}</OutlinedBtn>
          {n.type === 'update' && (
            <OutlinedBtn small onClick={dismissWithFly} disabled={busy}>Later</OutlinedBtn>
          )}
        </div>
      ) : null}
    />
  );
}
