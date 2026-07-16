// Overlay Toast — the tiny always-on-top `overlay-toast` window's whole webview.
// Confirms a hidden-overlay dictation note saved: Rust (`overlay_note_toast`)
// positions + shows the window bottom-right of the overlay monitor only while the
// overlay host is hidden, then emits `overlay-note-toast` with the note text. This
// view renders the same bottom-right candy chip the overlay host uses, holds it
// ~2.2s, plays the 180ms fade-out, then asks Rust to hide the window
// (`overlay_toast_done`) — the `hide_overlay_host` animate-then-hide pattern.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const HOLD_MS = 2200;
const FADE_MS = 180;

export default function OverlayToastView() {
  const [msg, setMsg] = useState(null);
  const [leaving, setLeaving] = useState(false);
  // Generation counter — a new note mid-fade restarts the hold instead of
  // hiding the window under the fresh toast.
  const gen = useRef(0);
  const timers = useRef([]);

  // Show a note + drive the dwell/fade/hide cycle. Shared by the live event
  // listener and the mount-time re-pull (show-before-listen cure).
  const showToast = useCallback((text) => {
    const g = ++gen.current;
    timers.current.forEach(clearTimeout);
    setMsg(String(text || 'Note saved'));
    setLeaving(false);
    timers.current = [
      setTimeout(() => { if (gen.current === g) setLeaving(true); }, HOLD_MS),
      setTimeout(() => {
        if (gen.current !== g) return;
        setMsg(null);
        invoke('overlay_toast_done').catch(() => {});
      }, HOLD_MS + FADE_MS),
    ];
  }, []);

  // Transparent root + the dark token scope (the window is transparent:true;
  // without a transparent html/body the webview paints opaque).
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = [html.style.background, body.style.background];
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    body.classList.add('video-cinema');
    return () => {
      html.style.background = prev[0];
      body.style.background = prev[1];
      body.classList.remove('video-cinema');
    };
  }, []);

  useEffect(() => {
    const un = listen('overlay-note-toast', (e) => showToast(e.payload?.text));
    // Show-before-listen cure: a toast emitted before this listener attached (or
    // before the hidden webview woke) is stashed Rust-side — pull it on mount.
    invoke('overlay_toast_pending')
      .then((text) => { if (text) showToast(text); })
      .catch(() => {});
    return () => {
      timers.current.forEach(clearTimeout);
      un.then((u) => u()).catch(() => {});
    };
  }, [showToast]);

  if (!msg) return null;
  return (
    <div className="video-cinema overlay-toast candy-btn" style={{ opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ease` }}>
      <span className="candy-face">{msg}</span>
    </div>
  );
}
