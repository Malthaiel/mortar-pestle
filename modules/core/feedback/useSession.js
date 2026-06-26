import { useState, useEffect, useCallback } from 'react';

// Loads + caches the signed-in session ({ signedIn, userId, profile }) on mount.
// `refresh()` re-reads it (call after sign-in / sign-out / profile save).
export function useSession(fb) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await fb.getSession();
      setSession(s || { signedIn: false });
    } catch {
      setSession({ signedIn: false });
    } finally {
      setLoading(false);
    }
  }, [fb]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // True if the user has a profile handle. Re-checks the server once when the
  // cached session has none — the handle may have just been set in the Settings
  // → Feedback drawer, which doesn't remount the board, so the local copy goes
  // stale. Lets write-gates avoid both raw FK errors and falsely blocking a user
  // who already has a handle.
  const ensureHandle = useCallback(async () => {
    if (session?.profile?.handle) return true;
    const s = await fb.getSession().catch(() => null);
    if (s) setSession(s);
    return !!s?.profile?.handle;
  }, [session, fb]);

  return { session, loading, refresh, setSession, ensureHandle };
}
