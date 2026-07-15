// Scrim Overlay Panel — the FULL scrim editor as a draggable candy panel in the
// Overlay Host. Headerless: scrim switching lives in ScrimViewer's tree toolbar
// (Switch-scrim popover, fed by this panel), minimize lives in the bottom-left
// ScrimOverlayLauncher chip, and the panel drags by any empty spot. The body is
// the reused ScrimViewer in `overlay` mode (focused-match only), which owns all
// editing/saving + the live-target + dictation/screenshot capture.
// Accent resolves free — --accent is painted on :root by the host's SttProvider/
// useSettings (see OverlayHostView).
import { useState, useEffect, useRef, useCallback } from 'react';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import { useScrimOverlay } from './useScrimOverlay.js';
import ScrimViewer from '@modules/core/game-wiki/ScrimViewer.jsx';

// Panel presence — shared with ScrimOverlayLauncher via localStorage + a window
// event (the OverlayBrowserPanel pattern). Default OPEN; hiding keeps the panel
// mounted (display:none) so the timer, drafts, and dictation survive a minimize.
export const OPEN_EVT = 'overlay-scrim-open-changed';
const OPEN_KEY = 'overlay-scrim-open';
export const isPanelOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };
export const setPanelOpen = (v) => {
  try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(OPEN_EVT, { detail: !!v }));
};

// All-direction edge/corner resize — the panel is content-height until the user drags a
// vertical edge (then height is pinned). A left/top edge also slides the panel (nudgeX/
// nudgeY) so the opposite edge stays put. Width persists always; height once the user set it.
const SCRIM_W_KEY = 'overlay-panel-scrim-width';
const SCRIM_H_KEY = 'overlay-panel-scrim-height';
const SCRIM_MIN_W = 360, SCRIM_MAX_W = 900, SCRIM_DEFAULT_W = 460;
const SCRIM_MIN_H = 220, SCRIM_MAX_H = 1400;
const vpW = () => (typeof window !== 'undefined' && window.innerWidth) || SCRIM_MAX_W;
const vpH = () => (typeof window !== 'undefined' && window.innerHeight) || SCRIM_MAX_H;
const clampScrimW = (w) => Math.min(Math.max(w, SCRIM_MIN_W), Math.min(SCRIM_MAX_W, vpW()));
const clampScrimH = (h) => Math.min(Math.max(h, SCRIM_MIN_H), Math.min(SCRIM_MAX_H, vpH() - 20));
const loadScrimW = () => { try { const v = parseInt(localStorage.getItem(SCRIM_W_KEY), 10); return Number.isFinite(v) ? clampScrimW(v) : SCRIM_DEFAULT_W; } catch { return SCRIM_DEFAULT_W; } };
const loadScrimH = () => { try { const v = parseInt(localStorage.getItem(SCRIM_H_KEY), 10); return Number.isFinite(v) ? clampScrimH(v) : null; } catch { return null; } };
// 8 handles: 4 edges + 4 corners. Each key maps to a horizontal edge (l/r) and/or a
// vertical edge (t/b) it drives.
const RESIZE_HANDLES = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'];

// "(06-16-26) Reliquary VS The Mafia.md" → "Reliquary VS The Mafia" (date dropped).
function titleOf(path) {
  const base = String(path || '').replace(/\.md$/, '').split('/').pop();
  const m = base.match(/^\((\d{2}-\d{2}-\d{2})\)\s*(.*)$/);
  return m ? m[2] : base;
}

export default function ScrimOverlayPanel() {
  const { style: dragStyle, dragProps, nudgeX, nudgeY, commitPos } = useOverlayPanelDrag('overlay-panel-scrim', { x: 40, y: 40 });
  const { scrims, selectedPath, selectScrim, createScrim } = useScrimOverlay();
  // Minimized/open — driven by the bottom-left launcher chip.
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);
  // Resize (all edges + corners). Refs feed the pointer handlers the current size without
  // re-binding them each frame. height stays null (content-height) until a vertical edge
  // is grabbed, then it's seeded from the panel's measured box.
  const [width, setWidth] = useState(loadScrimW);
  const [height, setHeight] = useState(loadScrimH);
  const widthRef = useRef(width); widthRef.current = width;
  const heightRef = useRef(height); heightRef.current = height;
  const panelRef = useRef(null);
  const resize = useRef(null);
  const startResize = (hx, vy) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (vy && heightRef.current == null && panelRef.current) setHeight(clampScrimH(panelRef.current.getBoundingClientRect().height));
    resize.current = { hx, vy, lastX: e.clientX, lastY: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
  };
  const moveResize = useCallback((e) => {
    const r = resize.current; if (!r) return;
    const dx = e.clientX - r.lastX, dy = e.clientY - r.lastY; r.lastX = e.clientX; r.lastY = e.clientY;
    if (r.hx) {
      const cur = widthRef.current;
      const nw = clampScrimW(r.hx === 'right' ? cur + dx : cur - dx);
      if (nw !== cur) { if (r.hx === 'left') nudgeX(cur - nw); setWidth(nw); } // left edge: keep right fixed
    }
    if (r.vy) {
      const cur = heightRef.current; if (cur == null) return;
      const nh = clampScrimH(r.vy === 'bottom' ? cur + dy : cur - dy);
      if (nh !== cur) { if (r.vy === 'top') nudgeY(cur - nh); setHeight(nh); } // top edge: keep bottom fixed
    }
  }, [nudgeX, nudgeY]);
  const endResize = useCallback((e) => {
    if (!resize.current) return;
    resize.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    try {
      localStorage.setItem(SCRIM_W_KEY, String(widthRef.current));
      if (heightRef.current != null) localStorage.setItem(SCRIM_H_KEY, String(heightRef.current));
    } catch { /* ignore */ }
    commitPos();
  }, [commitPos]);
  const resizeProps = { onPointerMove: moveResize, onPointerUp: endResize, onPointerCancel: endResize };
  const [creating, setCreating] = useState(false);
  const [t1, setT1] = useState('');
  const [t2, setT2] = useState('');
  // Slim live mode — owned here (ScrimViewer's Go Live toolbar toggle drives it via
  // onLive). Persisted: the overlay reopens in whichever mode it was last in
  // (mirrors the overlay-scrim-selected pattern).
  const [live, setLiveState] = useState(() => {
    try { return localStorage.getItem('overlay-scrim-live') === '1'; } catch { return false; }
  });
  const setLive = (v) => {
    setLiveState(v);
    try { localStorage.setItem('overlay-scrim-live', v ? '1' : '0'); } catch { /* private mode */ }
  };

  const doCreate = async () => {
    await createScrim(t1, t2).catch(() => {});
    setCreating(false); setT1(''); setT2('');
  };

  return (
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, display: open ? undefined : 'none', ...dragStyle }}>
      {/* Topbar = the Studio panel's header copied 1-1 (user call 2026-07-15,
          reversing the whole-panel drag): the ⠿ grip row is the ONLY drag handle,
          so the panel body never fights inner controls. Picker stays in the tree
          toolbar; minimize stays on the launcher chip. */}
      <div ref={panelRef} className="candy-card ov-scrim-panel" style={{ width, ...(height != null ? { height, maxHeight: 'none' } : null) }}>
        <div className="candy-center-row ov-studio-head" {...dragProps} style={{ touchAction: 'none' }}>
          <span className="ov-studio-title section-title">Scrim Overlay</span>
          <span className="stt-grip" aria-hidden="true">⠿</span>
        </div>
        {creating && (
          <div className="candy-center-row" style={{ gap: 6, padding: '0 2px' }}>
            <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
              <input className="candy-face" autoFocus placeholder="Team 1 (coached)" value={t1}
                onChange={(e) => setT1(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doCreate(); }} />
            </div>
            <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
              <input className="candy-face" placeholder="Team 2" value={t2}
                onChange={(e) => setT2(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doCreate(); }} />
            </div>
            <button type="button" data-no-drag className="candy-btn" data-shape="chip" data-size="small" onClick={doCreate}>
              <span className="candy-face">Create</span>
            </button>
          </div>
        )}

        {/* Body — the reused full editor, focused-match mode. The Switch-scrim popover
            (tree toolbar) gets the scrim list + select/create from here. */}
        {selectedPath
          ? <div className="ov-scrim-body" style={height != null ? { flex: 1 } : undefined}>
              <ScrimViewer path={selectedPath} overlay live={live} onLive={setLive} fill={height != null}
                scrims={scrims.map((s) => ({ path: s.path, label: titleOf(s.path) }))}
                onSelectScrim={selectScrim} onAddScrim={() => setCreating(true)} />
            </div>
          : !creating && (
            // No scrim open → no viewer, so no toolbar to swap from. List the scrims
            // right here (same candy row pills as the popover) so picking is one click.
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 2px' }}>
              {scrims.length === 0 && <div className="ov-scrim-empty">No scrims yet — Add Scrim below.</div>}
              {scrims.map((s) => (
                <button key={s.path} type="button" data-no-drag className="candy-btn" data-shape="row" onClick={() => selectScrim(s.path)} style={{ width: '100%' }}>
                  <span className="candy-face">{titleOf(s.path)}</span>
                </button>
              ))}
              <button type="button" data-no-drag className="candy-btn" data-shape="row" onClick={() => setCreating(true)} style={{ width: '100%' }}>
                <span className="candy-face">+ Add Scrim</span>
              </button>
            </div>
          )}
        {/* Resize — hairline grab strips on every edge + corner. */}
        {RESIZE_HANDLES.map((k) => (
          <div key={k} className={`ov-resize-edge e-${k}`} data-no-drag title="Resize" aria-label="Resize scrim panel"
            onPointerDown={startResize(k.includes('l') ? 'left' : k.includes('r') ? 'right' : null, k.includes('t') ? 'top' : k.includes('b') ? 'bottom' : null)}
            {...resizeProps} />
        ))}
      </div>
    </div>
  );
}
