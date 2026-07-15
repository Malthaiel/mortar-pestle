// Smart click-through for the overlay host — the fullscreen transparent webview
// must pass clicks over empty space through to the game, but keep its panels and
// launcher chips clickable. Per-region hit-testing at the Win32 layer can't reach
// the WebView2 child (HTTRANSPARENT/WS_EX_TRANSPARENT are same-thread-scoped), so
// the proven pattern is polling: while click-through is on the webview receives no
// mouse events at all, so JS asks Rust where the cursor is (cursorPosition() —
// global physical px), maps it into CSS px, hit-tests the DOM, and flips the
// window's ignore-cursor-events to match. ~12ms of IPC every 80ms, only while the
// overlay is visible.
import { useEffect } from 'react';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';

const POLL_MS = 80;

export default function useSmartClickThrough(visible, rootRef) {
  useEffect(() => {
    if (!visible) return undefined;
    const win = getCurrentWindow();
    let ignoring = null; // tri-state: null = never set, so the first tick always applies
    let pointerDown = false;
    const setIgnore = (on) => {
      if (ignoring === on) return;
      ignoring = on;
      win.setIgnoreCursorEvents(on).catch(() => {});
    };
    // Mid-drag the cursor can outrun the panel for a frame — flipping to
    // click-through then would eat the pointerup and strand the drag. Capture-phase
    // so it sees pointerdowns that child handlers stopPropagation.
    const onDown = () => { pointerDown = true; };
    const onUp = () => { pointerDown = false; };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);

    const tick = async () => {
      try {
        // Typing guard: a focused text field (Concierge chat, dictation) keeps the
        // window interactive regardless of where the mouse drifts — clicking empty
        // overlay space blurs the field, and the next tick releases to the game.
        const el = document.activeElement;
        const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (pointerDown || typing) { setIgnore(false); return; }
        const [cur, winPos, scale] = await Promise.all([
          cursorPosition(), win.outerPosition(), win.scaleFactor(),
        ]);
        const x = (cur.x - winPos.x) / scale;
        const y = (cur.y - winPos.y) / scale;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
          setIgnore(true); // cursor on another monitor / outside the overlay
          return;
        }
        const hit = document.elementFromPoint(x, y);
        const empty = !hit || hit === document.body || hit === document.documentElement
          || hit === rootRef.current;
        setIgnore(empty);
      } catch { /* transient IPC miss — next tick retries */ }
    };
    const id = setInterval(tick, POLL_MS);
    tick();
    return () => {
      clearInterval(id);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      // Hidden overlays keep their HWND — reset so the next show starts interactive.
      win.setIgnoreCursorEvents(false).catch(() => {});
    };
  }, [visible, rootRef]);
}
