// Control bar rendered below the <video> inside the modal. Reads everything
// from useVideoPlayer() — no props.

import { useEffect, useRef, useState } from 'react';
import { useVideoPlayer } from './VideoPlayerProvider.jsx';
import { IconVolume, IconPlay, IconPause, IconSkip, IconSkipBack, IconRewind, IconFastForward, IconSettings, IconMaximize, IconRotateCw } from '@host/components/icons.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import SubtitleSettingsPanel from './SubtitleSettingsPanel.jsx';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ICON = 14;   // uniform glyph size inside the 27px circle buttons

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

export default function VideoControls() {
  const v = useVideoPlayer();
  const [subPanelOpen, setSubPanelOpen] = useState(false);
  const subAnchorRef = useRef(null);
  useEffect(() => {
    if (!subPanelOpen) return;
    const onDown = (e) => {
      if (subAnchorRef.current && !subAnchorRef.current.contains(e.target)) {
        setSubPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [subPanelOpen]);
  const dur = v.duration || 0;
  const pct = dur > 0 ? (v.effectiveTime / dur) * 100 : 0;

  const onSeek = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    v.seek(Math.max(0, Math.min(1, x)) * dur);
  };

  return (
    <div style={{
      width: '100%',
      display: 'flex', flexDirection: 'column', gap: 10,
      color: 'var(--text-muted)',
    }}>
      {/* Seek bar */}
      <div
        onClick={onSeek}
        className="candy-groove"
        style={{ height: 8, cursor: 'pointer' }}
      >
        <div className="candy-groove__fill" style={{ width: `${pct}%` }}/>
        {v.probe && v.probe.chapters && v.probe.chapters.map(ch => (
          <div key={ch.id} title={ch.title} style={{
            position: 'absolute',
            left: `${(ch.start / dur) * 100}%`,
            top: -2, bottom: -2,
            width: 3,
            background: 'rgba(255,255,255,0.45)',
          }}/>
        ))}
      </div>

      {/* Transport row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        fontFamily: 'var(--font-mono)', fontSize: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <IconBtn onClick={v.prev} title="Previous episode" size={27}><IconSkipBack size={ICON}/></IconBtn>
          <IconBtn onClick={() => v.skip(-10)} title="Back 10s" size={27}><IconRewind size={ICON}/></IconBtn>
          <IconBtn onClick={v.toggle} title={v.isPlaying ? 'Pause' : 'Play'} size={27} primary>
            {v.isPlaying ? <IconPause size={ICON}/> : <IconPlay size={ICON}/>}
          </IconBtn>
          <IconBtn onClick={() => v.skip(+10)} title="Forward 10s" size={27}><IconFastForward size={ICON}/></IconBtn>
          <IconBtn onClick={v.next} title="Next episode" size={27}><IconSkip size={ICON}/></IconBtn>
        </div>

        <span style={{ marginLeft: 8, color: 'white', minWidth: 140 }}>
          {fmt(v.effectiveTime)} / {fmt(dur)}
        </span>

        <span style={{ flex: 1 }}/>

        {/* Speed */}
        <CandySelect
          value={String(v.speed)}
          options={SPEEDS.map(s => ({ value: String(s), label: `${s}×` }))}
          onChange={(val) => v.setSpeed(Number(val))}
          title="Playback speed"
          direction="up"
        />

        {/* Audio track */}
        {v.probe && v.probe.audio && v.probe.audio.length > 1 && (
          <CandySelect
            value={String(v.audioIdx)}
            options={v.probe.audio.map((t, i) => ({
              value: String(i),
              label: `${(t.language || 'und').toUpperCase()}${t.title ? ' · ' + t.title.slice(0, 18) : ''}`,
            }))}
            onChange={(val) => v.setAudioTrack(Number(val))}
            title="Audio track"
            direction="up"
          />
        )}

        {/* Subtitle track */}
        {v.probe && v.probe.subtitles && v.probe.subtitles.length > 0 && (
          <CandySelect
            value={String(v.subIdx)}
            options={[
              { value: '-1', label: 'Subs: Off' },
              ...v.probe.subtitles.map((t, i) => ({
                value: String(i),
                label: `Subs: ${(t.language || 'und').toUpperCase()}${t.forced ? ' (F)' : ''}`,
              })),
            ]}
            onChange={(val) => v.setSubtitleTrack(Number(val))}
            title="Subtitle track"
            direction="up"
          />
        )}

        {/* Subtitle settings gear */}
        {v.probe && v.probe.subtitles && v.probe.subtitles.length > 0 && v.subIdx >= 0 && (
          <div ref={subAnchorRef} style={{ position: 'relative' }}>
            <IconBtn
              onClick={() => setSubPanelOpen(o => !o)}
              title="Subtitle settings"
              size={27}
            ><IconSettings size={ICON}/></IconBtn>
            {subPanelOpen && <SubtitleSettingsPanel/>}
          </div>
        )}

        {/* Chapters (only if any) */}
        {v.probe && v.probe.chapters && v.probe.chapters.length > 0 && (
          <CandySelect
            value=""
            placeholder={`Chapters (${v.probe.chapters.length})`}
            options={v.probe.chapters.map(c => ({
              value: String(c.start),
              label: `${fmt(c.start)} — ${c.title}`,
            }))}
            onChange={(val) => { const t = Number(val); if (Number.isFinite(t)) v.seek(t); }}
            title="Jump to chapter"
            direction="up"
          />
        )}

        {/* Refresh stream — reload the current episode, resume at the same spot */}
        <IconBtn onClick={v.refresh} title="Refresh stream" size={27}><IconRotateCw size={ICON}/></IconBtn>

        {/* Volume */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 150 }}>
          <span style={{ color: 'rgba(255,255,255,0.7)', display: 'inline-flex', flexShrink: 0 }}>
            <IconVolume size={18}/>
          </span>
          <VolumeSlider value={v.volume} onChange={v.setVolume} accent="var(--accent, #c0392b)"/>
        </div>

        <IconBtn onClick={v.requestFullscreen} title="Fullscreen" size={27}><IconMaximize size={ICON}/></IconBtn>
      </div>
    </div>
  );
}

function IconBtn({ children, onClick, title, size = 27, primary = false }) {
  return (
    <button
      onClick={onClick} title={title}
      data-own-press
      className={primary ? 'candy-btn is-primary' : 'candy-btn'}
      data-shape="circle"
      style={{ width: size, height: size }}
    ><span className="candy-face">{children}</span></button>
  );
}

function VolumeSlider({ value, onChange, accent }) {
  const pct = Math.round(value * 100);
  const [dragging, setDragging] = useState(false);
  const onDown = (e) => {
    const el = e.currentTarget;
    const apply = (clientX) => {
      const r = el.getBoundingClientRect();
      onChange(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
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
      title={`Volume ${pct}%`}
      style={{
        flex: 1, height: 18,
        display: 'flex', alignItems: 'center',
        cursor: 'pointer',
        padding: '7px 0',
      }}
    >
      <div className="candy-groove" style={{ width: '100%', height: 4, position: 'relative' }}>
        <div className="candy-groove__fill" style={{ width: pct + '%' }}/>
        <div style={{
          position: 'absolute', top: '50%', left: pct + '%',
          width: dragging ? 14 : 12, height: dragging ? 14 : 12,
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
