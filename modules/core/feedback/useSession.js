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

  return { session, loading, refresh, setSession };
}
