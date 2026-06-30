// Capture HUD panel — the in-game Clip / Record / Screenshot HUD in the
// overlay-host, in the app's candy language (Overlay epic; promoted from the
// "Capture HUD (Overlay A)" prototype). The whole slab is one draggable candy
// button (.video-cinema dark scope + the .music-tile nesting pattern); the three
// nested action buttons take pointer priority. Drag via useOverlayPanelDrag (CSS
// transform); the transient flash is a host-local screen-anchored toast
// (showToast, owned by OverlayHostView — a fixed toast can't live inside the
// transformed panel). Invoke/listen logic unchanged from the original HUD.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';

const CLIP_SECS = 30;

const SVG = { width: 19, height: 19, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const IconClip = () => (
  <svg {...SVG}><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>
);
const IconRecord = () => (
  <svg {...SVG}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
);
const IconStop = () => (
  <svg {...SVG}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
);
const IconShot = () => (
  <svg {...SVG}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
);

export default function CaptureHudPanel({ showToast }) {
  const [recording, setRecording] = useState(false);
  const { style: dragStyle, dragProps } = useOverlayPanelDrag('overlay-panel-capture', { x: 480, y: 40 });

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
        // Folded engine error (disjoint payload: code/message, no `state`).
        showToast('Save failed');
      }
    }).then((u) => { un = u; }).catch(() => {});
    return () => { if (un) un(); };
  }, [showToast]);

  // Save confirmations — the engine emits these only after the file is on disk.
  useEffect(() => {
    const subs = [
      listen('capture-screenshot-saved', () => showToast('Screenshot saved')),
      listen('capture-saved', () => showToast('Clip saved ✓')),
    ];
    return () => subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  }, [showToast]);

  const clip = async () => {
    try {
      await invoke('capture_save_replay', { windowSecs: CLIP_SECS });
      showToast(`Clipped last ${CLIP_SECS}s`);
    } catch (e) {
      const msg = String(e?.message || e || '');
      showToast(/arm|ring/i.test(msg) ? 'Arm the replay ring first' : 'Clip failed — engine down?');
    }
  };

  const toggleRecord = async () => {
    try {
      if (recording) { await invoke('capture_stop'); showToast('Saving…'); }
      else { await invoke('capture_start'); showToast('Recording started'); }
    } catch {
      showToast('Capture engine unavailable');
    }
  };

  const screenshot = async () => {
    try { await invoke('capture_screenshot'); showToast('Screenshot…'); }
    catch { showToast('Screenshot failed'); }
  };

  return (
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, ...dragStyle }}>
      <div className="capture-hud candy-btn" role="button" tabIndex={0} {...dragProps} style={{ touchAction: 'none' }}>
        <div className="candy-face">
          <div className="acts candy-center-row">
            <button type="button" className="candy-btn is-hover-accent" data-shape="icon" title="Clip" aria-label="Clip" onClick={clip}>
              <span className="candy-face"><IconClip/></span>
            </button>
            <button type="button" className={`candy-btn is-hover-accent${recording ? ' is-active' : ''}`} data-shape="icon" title={recording ? 'Stop' : 'Record'} aria-label={recording ? 'Stop' : 'Record'} onClick={toggleRecord}>
              <span className="candy-face">{recording ? <IconStop/> : <IconRecord/>}</span>
            </button>
            <button type="button" className="candy-btn is-hover-accent" data-shape="icon" title="Screenshot" aria-label="Screenshot" onClick={screenshot}>
              <span className="candy-face"><IconShot/></span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
