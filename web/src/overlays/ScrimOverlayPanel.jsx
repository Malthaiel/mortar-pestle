// Scrim Overlay Panel — the Deadlock Live Scrim Notes overlay as a draggable candy
// panel in the Overlay Host (Overlay epic sub-plan 4), replacing the standalone
// transparent `overlay-scrim` window. Mirrors OverlayStudioPanel's shell + header-
// grip drag and ScrimViewer's candy notes idiom (RetagButton classification chip,
// data-shape="field" inputs, icon timer). All logic lives in useScrimOverlay; this
// is pure view. Live-gated: renders only while a scrim is live (target set), so the
// host shows just the Studio panel otherwise. Accent resolves free — --accent is
// painted on :root by the Studio panel's SttProvider, mounted alongside in the host.
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import { useScrimOverlay } from './useScrimOverlay.js';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import RetagButton from '@modules/core/game-wiki/RetagButton.jsx';
import { clock } from '@modules/core/game-wiki/matchData.js';
import { formatTimedBullet } from '@modules/core/game-wiki/noteCompile.js';
import { IconPlay, IconPause, IconRotateCw, IconX } from '@host/components/icons.jsx';

export default function ScrimOverlayPanel() {
  const { style: dragStyle, dragProps } = useOverlayPanelDrag('overlay-panel-scrim', { x: 40, y: 40 });
  const s = useScrimOverlay();
  if (!s.target) return null; // not live — the panel isn't present
  const {
    matches, matchN, selectMatch, coachedTeam, goOffline,
    sw, rows, notesCount, dictating, liveText, draft, setDraft, addNote,
    onText, onRetag, onDelete, flash,
  } = s;

  return (
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, ...dragStyle }}>
      <div className="candy-card ov-scrim-panel">
        {/* Header (drag handle) — title · match selector · coached team · go offline */}
        <div className="candy-center-row ov-scrim-head" {...dragProps} style={{ touchAction: 'none' }}>
          <span className="ov-scrim-title section-title">▣ Scrim</span>
          <CandySelect
            value={matchN}
            options={matches.map((m) => ({ value: m.n, label: `Match ${m.n}` }))}
            onChange={selectMatch}
            title="Active match"
          />
          <span className="ov-scrim-team" title={coachedTeam}>{coachedTeam}</span>
          <button type="button" className="candy-btn" data-shape="icon" data-size="small" title="Go offline" aria-label="Go offline" onClick={goOffline}>
            <span className="candy-face"><IconX size={13} /></span>
          </button>
        </div>

        {/* Timer */}
        <div className="candy-center-row" style={{ gap: 6 }}>
          <button type="button" className="candy-btn" data-shape="icon" data-size="small" title={sw.running ? 'Pause timer' : 'Start timer'} onClick={sw.toggle}>
            <span className="candy-face">{sw.running ? <IconPause size={13} /> : <IconPlay size={13} />}</span>
          </button>
          <span className={`ov-scrim-clock${sw.running ? ' is-running' : ''}`}>{clock(sw.elapsedSec)}</span>
          <button type="button" className="candy-btn" data-shape="icon" data-size="small" title="Reset timer" onClick={sw.reset}>
            <span className="candy-face"><IconRotateCw size={13} /></span>
          </button>
          <span className={`ov-scrim-status${dictating ? ' is-live' : ''}`}>
            {dictating ? '🎙 listening…' : (flash || `${notesCount} note${notesCount === 1 ? '' : 's'}`)}
          </span>
        </div>

        {/* Notes list */}
        <div className="ov-scrim-notes">
          {rows.map((row) => (
            <div className="ov-scrim-note" key={row._i}>
              <RetagButton label={row.classification} onPick={(c) => onRetag(row, c)} allowClear />
              <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
                <input
                  className="candy-face"
                  value={formatTimedBullet({ atSec: row.atSec, classification: null, text: row.text })}
                  placeholder="note…"
                  onChange={(e) => onText(row, e.target.value)}
                />
              </div>
              <button type="button" className="candy-btn" data-shape="icon" data-size="small" title="Remove note" aria-label="Remove note" onClick={() => onDelete(row)}>
                <span className="candy-face"><IconX size={12} /></span>
              </button>
            </div>
          ))}
          {rows.length === 0 && !dictating && (
            <div className="ov-scrim-empty">No notes yet — type below or hold your dictation key.</div>
          )}
        </div>

        {/* Note input (shows the live transcript while dictating) */}
        <div className="candy-btn" data-shape="field" style={{ width: '100%' }}>
          <input
            className="candy-face"
            value={dictating ? liveText : draft}
            readOnly={dictating}
            placeholder={dictating ? 'listening…' : (sw.running ? `Add a note…  (stamped @ ${clock(sw.elapsedSec)})` : 'Add a note…')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !dictating) { e.preventDefault(); addNote(draft); setDraft(''); } }}
          />
        </div>
      </div>
    </div>
  );
}
