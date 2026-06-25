// Overlay A — the transient in-game capture HUD, rendered in the always-on-top
// `overlay-capture` window (hash #/overlay/capture). Shown while Shift+C is held
// (the capture daemon's `overlay` hotkey → host bridge → window.show/hide); the
// three actions fire by mouse-click: Clip the last N seconds of the replay ring,
// toggle Recording, and Screenshot. Standalone webview (no app chrome / theme
// context), so everything is inline-styled for reliability.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';

// v1 quick-clip window — the user's "past 30s". (Configurable length is a tracked
// follow-up: the overlay is a standalone webview with no settings context yet.)
const CLIP_SECS = 30;

// Make the window see-through except our panel (the Tauri window is
// `transparent:true`; without a transparent html/body the webview paints opaque).
function useTransparentRoot() {
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = [html.style.background, body.style.background];
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => { html.style.background = prev[0]; body.style.background = prev[1]; };
  }, []);
}

function HudButton({ label, sub, onClick, tone }) {
  const [hover, setHover] = useState(false);
  const accent = tone === 'rec' ? '#e0574f' : tone === 'shot' ? '#5aa9e6' : '#6fb56f';
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        padding: '10px 6px', cursor: 'pointer', userSelect: 'none',
        borderRadius: 10, border: `1.5px solid ${accent}`,
        background: hover ? `color-mix(in oklch, ${accent} 28%, rgba(20,20,24,0.9))` : 'rgba(28,28,34,0.86)',
        color: '#fff', font: '600 13px/1.1 var(--font-mono, ui-monospace, monospace)',
        transition: 'background 90ms ease',
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 500 }}>{sub}</span>
    </button>
  );
}

export default function OverlayCaptureView() {
  useTransparentRoot();
  const [recording, setRecording] = useState(false);
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);

  const showFlash = (msg) => {
    setFlash(msg);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2200);
  };

  // ── Drag-to-move (WI-4) ───────────────────────────────────────────────────
  // The overlay is hold-to-show + interactive (WS_EX_NOACTIVATE), so pointer
  // events fire and setPosition works without activation. Grab anywhere on the
  // panel EXCEPT a button (pointer-only drag — no HTML5 DnD); persist the dropped
  // position so the HUD reopens where the user left it. outerPosition() is
  // physical px; screen-delta is CSS px, so scale by devicePixelRatio.
  const win = getCurrentWindow();
  const dragRef = useRef(null);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('overlay-capture-pos') || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        win.setPosition(new PhysicalPosition(saved.x, saved.y)).catch(() => {});
      }
    } catch { /* no/garbled saved position — leave at the configured default */ }
  }, []);
  const onPointerDown = (e) => {
    if (e.target.closest('button')) return; // let button presses through
    e.preventDefault();
    // Capture the pointer + start coords SYNCHRONOUSLY (before the async IPC) so no
    // early moves are lost; fill the window origin once outerPosition() resolves.
    const sx = e.screenX, sy = e.screenY;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
    win.outerPosition()
      .then((pos) => { dragRef.current = { sx, sy, wx: pos.x, wy: pos.y }; })
      .catch(() => { /* denied/unavailable — drag stays inert */ });
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dpr = window.devicePixelRatio || 1;
    const nx = Math.round(d.wx + (e.screenX - d.sx) * dpr);
    const ny = Math.round(d.wy + (e.screenY - d.sy) * dpr);
    win.setPosition(new PhysicalPosition(nx, ny)).catch(() => {});
  };
  const endDrag = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    win.outerPosition()
      .then((p) => { try { localStorage.setItem('overlay-capture-pos', JSON.stringify({ x: p.x, y: p.y })); } catch {} })
      .catch(() => {});
  };

  // Reflect recording state: initial fetch + live `capture-state` events.
  useEffect(() => {
    let un = null;
    invoke('get_capture_state').then((s) => { if (s && typeof s.recording === 'boolean') setRecording(s.recording); }).catch(() => {});
    listen('capture-state', (e) => {
      const d = e.payload;
      if (!d) return;
      if (typeof d.state === 'string') {
        if (typeof d.recording === 'boolean') setRecording(d.recording);
      } else if (d.code || d.message) {
        // Folded engine error (disjoint payload: code/message, no `state`). The
        // save-time mux finalize failure lands here — surface it instead of the
        // old optimistic "Recording stopped" that masked a non-save.
        showFlash('Save failed');
      }
    }).then((u) => { un = u; }).catch(() => {});
    return () => { if (un) un(); clearTimeout(flashTimer.current); };
  }, []);

  // Screenshot saved → confirm. (The scoreboard auto-fill during a live scrim is
  // handled by the scrim overlay, which owns the active-match context.)
  useEffect(() => {
    const subs = [
      listen('capture-screenshot-saved', () => showFlash('Screenshot saved')),
      // Real save confirmation — the engine emits this only after the .mp4 is on
      // disk, so it (not the stop click) is the source of truth for a saved clip.
      listen('capture-saved', () => showFlash('Clip saved ✓')),
    ];
    return () => subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  }, []);

  const clip = async () => {
    try {
      await invoke('capture_save_replay', { windowSecs: CLIP_SECS });
      showFlash(`Clipped last ${CLIP_SECS}s`);
    } catch (e) {
      const msg = String(e?.message || e || '');
      showFlash(/arm|ring/i.test(msg) ? 'Arm the replay ring first' : 'Clip failed — engine down?');
    }
  };

  const toggleRecord = async () => {
    try {
      if (recording) { await invoke('capture_stop'); showFlash('Saving…'); }
      else { await invoke('capture_start'); showFlash('Recording started'); }
    } catch {
      showFlash('Capture engine unavailable');
    }
  };

  const screenshot = async () => {
    try { await invoke('capture_screenshot'); showFlash('Screenshot…'); }
    catch { showFlash('Screenshot failed'); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, padding: 8, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
        background: 'rgba(18,18,22,0.78)', border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 14, padding: 10, backdropFilter: 'blur(6px)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
        cursor: 'move', userSelect: 'none', touchAction: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 2px 8px' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: '#fff', opacity: 0.85 }}>
            ▣ CAPTURE
          </span>
          <span style={{ fontSize: 10, color: recording ? '#e0574f' : 'rgba(255,255,255,0.5)', fontWeight: 600 }}>
            {recording ? '● REC' : 'idle'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <HudButton label="Clip" sub={`last ${CLIP_SECS}s`} tone="clip" onClick={clip} />
          <HudButton label={recording ? 'Stop' : 'Record'} sub={recording ? 'recording' : 'start'} tone="rec" onClick={toggleRecord} />
          <HudButton label="Shot" sub="screenshot" tone="shot" onClick={screenshot} />
        </div>
        <div style={{ height: 14, marginTop: 6, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
          {flash || ''}
        </div>
      </div>
    </div>
  );
}
