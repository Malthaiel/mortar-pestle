// Scrim Overlay Panel — the FULL scrim editor as a draggable candy panel in the
// Overlay Host. The panel picks WHICH scrim (header: scrim picker + New + close);
// the body is the reused ScrimViewer in `overlay` mode (focused-match only), which
// owns all editing/saving + the live-target + dictation/screenshot capture. This
// replaces the former compact live-notes card — all of that functionality now lives
// in the one reused ScrimViewer, so the overlay and the in-app page are the same UI.
// Accent resolves free — --accent is painted on :root by the host's SttProvider/
// useSettings (see OverlayHostView).
import { useState } from 'react';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import { useScrimOverlay } from './useScrimOverlay.js';
import ScrimViewer from '@modules/core/game-wiki/ScrimViewer.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';

// "(06-16-26) Reliquary VS The Mafia.md" → "Reliquary VS The Mafia" (date dropped).
function titleOf(path) {
  const base = String(path || '').replace(/\.md$/, '').split('/').pop();
  const m = base.match(/^\((\d{2}-\d{2}-\d{2})\)\s*(.*)$/);
  return m ? m[2] : base;
}

export default function ScrimOverlayPanel() {
  const { style: dragStyle, dragProps } = useOverlayPanelDrag('overlay-panel-scrim', { x: 40, y: 40 });
  const { scrims, selectedPath, selectScrim, closeScrim, createScrim } = useScrimOverlay();
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
      <div className="candy-card ov-scrim-panel">
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
              placeholder="Pick a scrim…"
              title="Scrim"
              chevron={false}
            />
          </div>
          <div style={{ flex: 1 }} />
          {selectedPath && (live
            ? (
              <button type="button" data-no-drag className="candy-btn" data-shape="select" data-own-press title="Exit live mode — the full panel returns" onClick={() => setLive(false)}>
                <span className="candy-face"><span>Exit Live</span></span>
              </button>
            ) : (
              <button type="button" data-no-drag className="candy-btn" data-shape="select" data-own-press title="Minimize — collapse the scrim panel" onClick={closeScrim}>
                <span className="candy-face"><span>Minimize</span></span>
              </button>
            ))}
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
          ? <div className="ov-scrim-body"><ScrimViewer path={selectedPath} overlay live={live} onLive={setLive} /></div>
          : !creating && <div className="ov-scrim-empty">Pick a scrim above (+ Add Scrim is at the bottom of the list).</div>}
      </div>
    </div>
  );
}
