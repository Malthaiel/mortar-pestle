// Popover panel anchored above the ⚙ button in VideoControls. Lets the user
// tweak subtitle rendering (size, font, weight, background, position, sync)
// — all settings except sync persist globally; sync persists per-episode.

import { useState } from 'react';
import { useVideoPlayer } from './VideoPlayerProvider.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { candyCenterOffset } from '@host/util/candy.js';

export default function SubtitleSettingsPanel() {
  const v = useVideoPlayer();
  const s = v.subSettings;
  const sync = v.subSync;

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="candy-modal"
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 10px)',
        right: 0,
        padding: '14px 14px 12px',
        width: 300,
        color: 'var(--text)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 12,
        display: 'flex', flexDirection: 'column', gap: 10,
        zIndex: 20,
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, marginBottom: 2,
      }}>
        <span style={{
          fontSize: 13, fontFamily: 'monospace', letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'white', fontWeight: 700,
        }}>Subtitles</span>
        <button
          onClick={v.resetSubSettings}
          className="candy-btn"
          data-size="small"
          style={candyCenterOffset()}
        ><span className="candy-face">Reset</span></button>
      </div>

      <Row label="Size">
        <Slider min={12} max={64} step={1} value={s.size}
                onChange={(x) => v.updateSubSetting('size', x)}/>
        <Readout>{s.size}px</Readout>
      </Row>

      <Row label="Style">
        <CandySelect value={s.bgStyle} compact direction="down" options={[
          { value: 'box',     label: 'Box' },
          { value: 'shadow',  label: 'Shadow' },
          { value: 'outline', label: 'Outline' },
          { value: 'none',    label: 'None' },
        ]} onChange={(x) => v.updateSubSetting('bgStyle', x)}/>
      </Row>

      {s.bgStyle === 'box' && (
        <Row label="BG opacity">
          <Slider min={0} max={1} step={0.05} value={s.bgOpacity}
                  onChange={(x) => v.updateSubSetting('bgOpacity', x)}/>
          <Readout>{Math.round(s.bgOpacity * 100)}%</Readout>
        </Row>
      )}

      {s.bgStyle === 'shadow' && (
        <Row label="Shadow size">
          <Slider min={0} max={20} step={1} value={s.shadowSize}
                  onChange={(x) => v.updateSubSetting('shadowSize', x)}/>
          <Readout>{s.shadowSize}px</Readout>
        </Row>
      )}

      {s.bgStyle === 'outline' && (
        <Row label="Outline size">
          <Slider min={0} max={10} step={0.5} value={s.outlineSize}
                  onChange={(x) => v.updateSubSetting('outlineSize', x)}/>
          <Readout>{s.outlineSize}px</Readout>
        </Row>
      )}

      <Row label="Position">
        <Slider min={0} max={1} step={0.01} value={s.position}
                onChange={(x) => v.updateSubSetting('position', x)}/>
        <Readout>{Math.round(s.position * 100)}%</Readout>
      </Row>

      <Row label="Font">
        <CandySelect value={s.fontFamily} compact direction="down" options={[
          { value: 'sans',  label: 'Sans' },
          { value: 'serif', label: 'Serif' },
          { value: 'mono',  label: 'Mono' },
        ]} onChange={(x) => v.updateSubSetting('fontFamily', x)}/>
      </Row>

      <Row label="Weight">
        <CandySelect value={String(s.fontWeight)} compact direction="down" options={[
          { value: '400', label: 'Normal' },
          { value: '500', label: 'Medium' },
          { value: '700', label: 'Bold' },
        ]} onChange={(x) => v.updateSubSetting('fontWeight', Number(x))}/>
      </Row>

      <Row label="Letter sp">
        <Slider min={-2} max={8} step={0.5} value={s.letterSpacing}
                onChange={(x) => v.updateSubSetting('letterSpacing', x)}/>
        <Readout>{s.letterSpacing}</Readout>
      </Row>

      <Row label="Line ht">
        <Slider min={0.9} max={2.0} step={0.05} value={s.lineHeight}
                onChange={(x) => v.updateSubSetting('lineHeight', x)}/>
        <Readout>{s.lineHeight.toFixed(2)}</Readout>
      </Row>

      <Row label="Sync">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
          <NudgeBtn onClick={() => v.nudgeSubSync(-0.1)}>−</NudgeBtn>
          <span style={{
            flex: 1, textAlign: 'center', fontFamily: 'monospace',
            fontSize: 11, color: sync === 0 ? 'var(--text-faint)' : 'var(--text)',
          }}>
            {sync > 0 ? '+' : ''}{sync.toFixed(1)}s
          </span>
          <NudgeBtn onClick={() => v.nudgeSubSync(+0.1)}>+</NudgeBtn>
          <NudgeBtn onClick={() => v.resetSubSync()} title="Reset sync">↺</NudgeBtn>
        </div>
      </Row>

    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <label style={{
        width: 78, flexShrink: 0,
        fontSize: 11, color: 'var(--text-2)',
      }}>{label}</label>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

function Readout({ children }) {
  return (
    <span style={{
      width: 44, textAlign: 'right',
      fontSize: 10, fontFamily: 'monospace',
      color: 'var(--text-muted)',
    }}>{children}</span>
  );
}

// Draggable track-and-thumb slider — visual match to the volume slider in
// VideoControls and the music sidebar. Generalized for arbitrary min/max/step.
function Slider({ min, max, step, value, onChange, accent = 'var(--accent, #c0392b)' }) {
  const [dragging, setDragging] = useState(false);
  const range = max - min;
  const pct = range > 0 ? Math.max(0, Math.min(1, (value - min) / range)) * 100 : 0;
  const decimals = (String(step).split('.')[1] || '').length;

  const onDown = (e) => {
    const el = e.currentTarget;
    const apply = (clientX) => {
      const r = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      let next = min + ratio * range;
      if (step > 0) next = Math.round(next / step) * step;
      next = Math.min(max, Math.max(min, next));
      if (decimals > 0) next = Number(next.toFixed(decimals));
      onChange(next);
    };
    setDragging(true);
    apply(e.clientX);
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      onMouseDown={onDown}
      style={{
        flex: 1, height: 14,
        display: 'flex', alignItems: 'center',
        cursor: 'pointer',
        padding: '6px 0',
        minWidth: 0,
      }}
    >
      <div className="candy-groove" style={{ width: '100%', height: 3, position: 'relative' }}>
        <div className="candy-groove__fill" style={{ width: pct + '%' }}/>
        <div style={{
          position: 'absolute', top: '50%', left: pct + '%',
          width: dragging ? 12 : 10, height: dragging ? 12 : 10,
          background: accent,
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          transition: 'width 0.1s ease, height 0.1s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        }}/>
      </div>
    </div>
  );
}


function NudgeBtn({ children, onClick, title }) {
  return (
    <button
      onClick={onClick} title={title}
      data-own-press
      className="candy-btn"
      data-shape="circle"
      style={{ flexShrink: 0 }}
    ><span className="candy-face">{children}</span></button>
  );
}
