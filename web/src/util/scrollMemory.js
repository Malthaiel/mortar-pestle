// Remember a scroll box's position across unmount/remount — and across a webview
// reload.
//
// The scrim overlay is the forcing case: on Shift+C HIDE, the Rust side runs
// location.reload() on the overlay webview (src-tauri/src/lib.rs hide_overlay_host,
// dev builds) so Vite HMR reaches the occluded window. A reload re-executes ALL
// JS, so a module-level in-memory store is wiped before the next Shift+C SHOW —
// nothing to restore. So positions are kept in localStorage (survives the reload;
// the overlay + main window share one origin, so keys must be unique per surface).
//
// Usage: const ref = useScrollMemory(key); <div ref={ref} style={{overflowY:'auto'}}/>
// A null/undefined key opts out (no memory). Each surface passes a key unique to
// it (else two boxes share one position).

import { useRef, useLayoutEffect } from 'react';

const PREFIX = 'scroll-pos:';
// Debounce disk writes — a scroll fires ~60 events/sec (native AND the eased
// glide, which sets scrollTop each frame); we only need the resting position.
const timers = new Map(); // key -> timeout

function read(key) {
  try { const s = localStorage.getItem(PREFIX + key); return s == null ? null : parseFloat(s); }
  catch { return null; }
}
function write(key, v) {
  if (timers.has(key)) clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    try { localStorage.setItem(PREFIX + key, String(Math.round(v))); } catch { /* private mode */ }
  }, 150));
}

export function useScrollMemory(key) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || key == null) return;
    const saved = read(key);
    if (saved != null && saved > 0) {
      el.scrollTop = saved;
      // The tree can still be laying out (cascade reveal) at mount, so this frame's
      // scrollHeight may clamp scrollTop short — retry once after paint if it fell
      // short and the user hasn't scrolled away.
      requestAnimationFrame(() => {
        if (el.isConnected && el.scrollTop < saved) el.scrollTop = saved;
      });
    }
    const onScroll = () => write(key, el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      // Flush the final position now (React unmount path, e.g. a route change) so a
      // reload right after still restores it. The overlay's location.reload() skips
      // React cleanup, but the debounced write above has already landed by Shift+C.
      if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); }
      try { localStorage.setItem(PREFIX + key, String(Math.round(el.scrollTop))); } catch { /* private mode */ }
    };
  }, [key]);
  return ref;
}
