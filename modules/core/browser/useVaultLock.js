// Vault lock lifecycle + clipboard auto-clear.
//
// The JS idle timer is the PRIMARY auto-lock; a throttled `creds_touch` keeps
// Rust's `last_active` in sync so its safety-floor (which self-locks on the next
// command past the idle window if this timer ever dies) doesn't trip mid-use.
//
// Lock-on-app-hidden uses `visibilitychange` (fires on minimize / app-switch).
// NOTE: true "lock when the window loses focus to another app while still
// visible" needs a Rust window-focus event — the JS `window.blur` event also
// fires when focus moves to the in-app native web view (a sibling GTK widget),
// which would lock the vault every time you click the page. So we deliberately
// do NOT bind raw `blur`. See the SF3 gate note.

import { useEffect } from 'react';
import * as creds from './credsStore.js';

const TOUCH_THROTTLE_MS = 60_000;

export function useVaultLock(status) {
  const unlocked = !!status?.unlocked;
  const idleSecs = Math.max(60, status?.idleTimeoutSecs || 900);
  const lockOnBlur = status?.lockOnBlur !== false;

  useEffect(() => {
    if (!unlocked) return undefined;
    let timer = null;
    let lastTouch = 0;

    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { creds.lock(); }, idleSecs * 1000);
      const now = Date.now();
      if (now - lastTouch > TOUCH_THROTTLE_MS) {
        lastTouch = now;
        creds.touch();
      }
    };
    const onVisibility = () => {
      if (lockOnBlur && document.hidden) creds.lock();
    };
    const onUnload = () => { creds.lock(); };
    const onFocus = () => { creds.resyncOnFocus(); }; // re-sync; keyring-reunlock if opted in

    const activity = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'];
    activity.forEach(e => window.addEventListener(e, reset, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('focus', onFocus);
    reset();

    return () => {
      if (timer) clearTimeout(timer);
      activity.forEach(e => window.removeEventListener(e, reset));
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('focus', onFocus);
    };
  }, [unlocked, idleSecs, lockOnBlur]);
}

/**
 * Copy a secret to the clipboard, then wipe it after `clearSecs` — but only if
 * the clipboard still holds what we wrote (read-back compare) so we don't clobber
 * something the user copied afterward. If the clipboard can't be read (permission
 * denied), we clear anyway: a password manager errs toward not leaving secrets.
 * Returns true on a successful initial write.
 */
export async function copySecret(text, clearSecs = 30) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  if (clearSecs > 0 && text) {
    setTimeout(async () => {
      let current = null;
      try { current = await navigator.clipboard.readText(); } catch { current = null; }
      if (current === null || current === text) {
        try { await navigator.clipboard.writeText(''); } catch { /* ignore */ }
      }
    }, clearSecs * 1000);
  }
  return true;
}
