// Popover panel anchored above the ⚙ button in VideoControls. Lets the user
// tweak subtitle rendering (size, weight, background, position, sync)
// — all settings except sync persist globally; sync persists per-episode.
//
// Every row drives an mpv property; `subProps` in PlayerControlsView.jsx is the
// single translation point. Most of them only bite when Override is on, because
// mpv's default `sub-ass-override=scale` protects a release's own ASS
// typesetting (signs, karaoke) from our styling. Those rows dim rather than
// disappear, so the panel's shape does not jump when the switch is thrown.

import { useState } from 'react';
import { useVideoPlayer } from './VideoPlayerProvider.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { IconPalette, IconSquare, IconTypeText } from '@host/components/icons.jsx';
import { candyCenterOffset } from '@host/util/candy.js';

export default function SubtitleSettingsPanel() {
  const v = useVideoPlayer();
  const s = v.subSettings;
  const sync = v.subSync;
  // Rows mpv ignores while it is rendering the release's own ASS styling.
  const styled = !!s.assOverride;

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
        fontFamily: 'var(--font-body)',
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
          fontSize: 13, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'white', fontWeight: 700,
        }}>Subtitles</span>
        <button
          onClick={v.resetSubSettings}
          className="candy-btn"
          data-size="small"
          style={candyCenterOffset()}
        ><span className="candy-face">Reset</span></button>
      </div>

      {/* The gate. Off keeps the release's own signs and karaoke; on hands the
          look below to mpv's sub-* properties. */}
      <Row label="Override">
        <CandySelect icon={IconPalette} value={styled ? 'on' : 'off'} compact options={[
          { value: 'off', label: 'Keep release style' },
          { value: 'on',  label: 'Use my style' },
        ]} onChange={(x) => v.updateSubSetting('assOverride', x === 'on')}/>
      </Row>

      <Row label="Size">
        <Slider min={12} max={64} step={1} value={s.size}
                onChange={(x) => v.updateSubSetting('size', x)}/>
        <Readout>{s.size}px</Readout>
      </Row>

      <Row label="Position">
        <Slider min={0} max={1} step={0.01} value={s.position}
                onChange={(x) => v.updateSubSetting('position', x)}/>
        <Readout>{Math.round(s.position * 100)}%</Readout>
      </Row>

      <Row label="Style" dim={!styled}>
        <CandySelect icon={IconSquare} value={s.bgStyle} compact options={[
          { value: 'box',     label: 'Box' },
          { value: 'shadow',  label: 'Shadow' },
          { value: 'outline', label: 'Outline' },
          { value: 'none',    label: 'None' },
        ]} onChange={(x) => v.updateSubSetting('bgStyle', x)}/>
      </Row>

      {s.bgStyle === 'box' && (
        <Row label="BG opacity" dim={!styled}>
          <Slider min={0} max={1} step={0.05} value={s.bgOpacity}
                  onChange={(x) => v.updateSubSetting('bgOpacity', x)}/>
          <Readout>{Math.round(s.bgOpacity * 100)}%</Readout>
        </Row>
      )}

      {s.bgStyle === 'shadow' && (
        <Row label="Shadow size" dim={!styled}>
          <Slider min={0} max={20} step={1} value={s.shadowSize}
                  onChange={(x) => v.updateSubSetting('shadowSize', x)}/>
          <Readout>{s.shadowSize}px</Readout>
        </Row>
      )}

      {s.bgStyle === 'outline' && (
        <Row label="Outline size" dim={!styled}>
          <Slider min={0} max={10} step={0.5} value={s.outlineSize}
                  onChange={(x) => v.updateSubSetting('outlineSize', x)}/>
          <Readout>{s.outlineSize}px</Readout>
        </Row>
      )}

      {/* mpv's sub-bold is a flag, so there is no middle weight to offer. */}
      <Row label="Weight" dim={!styled}>
        <CandySelect icon={IconTypeText} value={String(s.fontWeight)} compact options={[
          { value: '400', label: 'Normal' },
          { value: '700', label: 'Bold' },
        ]} onChange={(x) => v.updateSubSetting('fontWeight', Number(x))}/>
      </Row>

      <Row label="Letter sp" dim={!styled}>
        <Slider min={-2} max={8} step={0.5} value={s.letterSpacing}
                onChange={(x) => v.updateSubSetting('letterSpacing', x)}/>
        <Readout>{s.letterSpacing}</Readout>
      </Row>

      <Row label="Sync">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
          <NudgeBtn onClick={() => v.nudgeSubSync(-0.1)}>−</NudgeBtn>
          <span style={{
            flex: 1, textAlign: 'center', fontFamily: 'var(--font-mono)',
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

function Row({ label, children, dim = false }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      opacity: dim ? 0.35 : 1,
      pointerEvents: dim ? 'none' : 'auto',
      transition: 'opacity 0.15s ease',
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
      fontSize: 10, fontFamily: 'var(--font-mono)',
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
