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
import { IconPlus, IconX } from '@host/components/icons.jsx';

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

  const doCreate = async () => {
    await createScrim(t1, t2).catch(() => {});
    setCreating(false); setT1(''); setT2('');
  };

  return (
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, ...dragStyle }}>
      <div className="candy-card ov-scrim-panel">
        {/* Header (drag handle) — title · scrim picker · New · close */}
        <div className="candy-center-row ov-scrim-head" {...dragProps} style={{ touchAction: 'none' }}>
          <span className="ov-scrim-title section-title">▣ Scrim</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <CandySelect
              value={selectedPath}
              options={scrims.map((s) => ({ value: s.path, label: titleOf(s.path) }))}
              onChange={selectScrim}
              placeholder="Pick a scrim…"
              title="Scrim"
            />
          </div>
          <button type="button" data-no-drag className="candy-btn" data-shape="icon" data-size="small" title="New scrim" aria-label="New scrim" onClick={() => setCreating((v) => !v)}>
            <span className="candy-face"><IconPlus size={13} /></span>
          </button>
          {selectedPath && (
            <button type="button" data-no-drag className="candy-btn" data-shape="icon" data-size="small" title="Close scrim" aria-label="Close scrim" onClick={closeScrim}>
              <span className="candy-face"><IconX size={13} /></span>
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
          ? <div className="ov-scrim-body"><ScrimViewer path={selectedPath} overlay /></div>
          : !creating && <div className="ov-scrim-empty">Pick a scrim above, or + to create one.</div>}
      </div>
    </div>
  );
}
