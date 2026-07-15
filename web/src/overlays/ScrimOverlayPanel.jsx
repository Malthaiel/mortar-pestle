// Scrim Overlay Panel — the FULL scrim editor as a draggable candy panel in the
// Overlay Host. The panel picks WHICH scrim (header: scrim picker + New + close);
// the body is the reused ScrimViewer in `overlay` mode (focused-match only), which
// owns all editing/saving + the live-target + dictation/screenshot capture. This
// replaces the former compact live-notes card — all of that functionality now lives
// in the one reused ScrimViewer, so the overlay and the in-app page are the same UI.
// Accent resolves free — --accent is painted on :root by the host's SttProvider/
// useSettings (see OverlayHostView).
import { useState, useRef, useCallback } from 'react';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import { useScrimOverlay } from './useScrimOverlay.js';
import ScrimViewer from '@modules/core/game-wiki/ScrimViewer.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';

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
  const { scrims, selectedPath, selectScrim, closeScrim, createScrim } = useScrimOverlay();
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
  // Slim live mode — owned here so the head button can flip to "Exit Live" (the
  // slim panel itself carries no Live chip). Persisted: the overlay reopens in
  // whichever mode it was last in (mirrors the overlay-scrim-selected pattern).
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
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, ...dragStyle }}>
      <div ref={panelRef} className="candy-card ov-scrim-panel" style={{ width, ...(height != null ? { height, maxHeight: 'none' } : null) }}>
        {/* Header (drag handle) — Scrim menu · scrim picker (+ Add Scrim lives at the
            bottom of its list) · Minimize (Exit Live while slim). The match picker is
            retired — ScrimViewer's tree drives match selection now (Scrim Tree, Phase 4). */}
        <div className="candy-center-row ov-scrim-head" data-spacing-intent="candy-center lift" {...dragProps} style={{ touchAction: 'none' }}>
          <CandySelect
            value={null}
            options={[]}
            onChange={() => {}}
            placeholder="Scrim"
            title="Scrim menu"
            chevron={false}
          />
          <div style={{ minWidth: 0 }}>
            <CandySelect
              value={selectedPath}
              options={[...scrims.map((s) => ({ value: s.path, label: titleOf(s.path) })), { value: '__create__', label: '+ Add Scrim' }]}
              onChange={(v) => { if (v === '__create__') setCreating(true); else selectScrim(v); }}
              placeholder="Pick a scrim"
              title="Scrim"
              chevron={false}
            />
          </div>
          <div style={{ flex: 1 }} />
          {selectedPath && (
            <button type="button" data-no-drag className="candy-btn" data-shape="select" data-own-press title="Minimize — collapse the scrim panel" onClick={closeScrim}>
              <span className="candy-face"><span>Minimize</span></span>
            </button>
          )}
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

        {/* Body — the reused full editor, focused-match mode */}
        {selectedPath
          ? <div className="ov-scrim-body" style={height != null ? { flex: 1 } : undefined}><ScrimViewer path={selectedPath} overlay live={live} onLive={setLive} fill={height != null} /></div>
          : !creating && <div className="ov-scrim-empty">Pick a scrim above (+ Add Scrim is at the bottom of the list).</div>}
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
