// MixSuite — Mix mode's footer suite (Audio Post SF3 + SF4 + SF5): vertical
// channel strips for each track + a master strip, plus a 4-band parametric EQ
// editor panel on the right. Faders / pan / mute / solo / EQ edit the mixer
// (setTrackMix / setMasterMix / setMasterVolume ops) and drive the live preview
// graph; post-fader peak/RMS meters (+ a master momentary-LUFS readout) read the
// graph's analysers in a single rAF loop, written straight to the DOM (no
// per-frame React). Compressor + GR meter land in SF6.
//
// Gesture protocol (mirrors ColorSuite): a fader / pan / EQ-gain DRAG previews
// imperatively through audioRef (setTrackLive / setMaster / setMasterEq — zero
// React, zero undo churn) and commits ONE op on release. Mute/solo + the EQ
// On/Off toggle are instant single ops; EQ freq/Q inputs preview on change and
// commit on blur.

import { useEffect, useRef, useState } from 'react';
import { trackAudible } from './audio/mix.js';
import { evaluate } from './keyframes/engine.js';

const mono = { fontFamily: '"DM Mono", monospace' };
const paneLabel = {
  fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', padding: '8px 12px', userSelect: 'none', flexShrink: 0,
};

// Vertical fader (0..1, top = max). Custom pointer-drag — rotated range inputs
// are unreliable in WebKitGTK. Draft via onDraft during the gesture; onCommit
// on release with the final value (read from a ref, never the stale closure).
function VFader({ value, onDraft, onCommit, accent }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const lastRef = useRef(value);
  const valFrom = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
  };
  const down = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const v = valFrom(e); lastRef.current = v; onDraft(v);
  };
  const move = (e) => { if (!draggingRef.current) return; const v = valFrom(e); lastRef.current = v; onDraft(v); };
  const up = () => { if (!draggingRef.current) return; draggingRef.current = false; onCommit(lastRef.current); };
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      ref={trackRef}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{ position: 'relative', width: 24, height: '100%', cursor: 'ns-resize', display: 'flex', justifyContent: 'center' }}
    >
      <div style={{ width: 4, height: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }} />
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 0, width: 4, height: `${pct}%`, background: accent, borderRadius: 3, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: '50%', transform: 'translate(-50%, 50%)', bottom: `${pct}%`, width: 18, height: 10, background: 'var(--text)', borderRadius: 3, boxShadow: '0 1px 3px rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
    </div>
  );
}

// Post-fader meter: an RMS fill (body) + a peak line (tick, red near clip).
// Heights are written by MixSuite's rAF loop via the callback refs.
function Meter({ peakRef, rmsRef }) {
  return (
    <div style={{ position: 'relative', width: 7, height: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div ref={rmsRef} style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: '0%', background: 'color-mix(in oklab, var(--accent) 55%, transparent)' }} />
      <div ref={peakRef} style={{ position: 'absolute', left: 0, bottom: '0%', width: '100%', height: 2, background: 'var(--text)', pointerEvents: 'none' }} />
    </div>
  );
}

const dbLabel = (v) => (v <= 0.0001 ? '−∞' : `${20 * Math.log10(v) >= 0 ? '+' : ''}${(20 * Math.log10(v)).toFixed(1)}`);

// Linear amplitude (0..1) → meter fill fraction on a dB scale (floor −60 dB).
// A LINEAR fill makes normal levels invisible (−24 dB ≈ 0.06 → a 6% nub); on a
// dB scale that same level reads ~60%, and a fader/mute change sweeps the bar.
const METER_FLOOR_DB = -60;
const ampToFill = (a) => {
  if (!(a > 0)) return 0;
  const db = 20 * Math.log10(a);
  if (db <= METER_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  return (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
};

const pillStyle = (on, onColor) => ({
  ...mono, fontSize: 10, width: 22, height: 18, borderRadius: 4, cursor: 'pointer', lineHeight: 1,
  border: `1px solid ${on ? onColor : 'var(--border)'}`,
  background: on ? onColor : 'transparent',
  color: on ? '#fff' : 'var(--text-faint)',
});

// EQ select button on a strip: outlined at rest, accent-tinted when this strip
// is the editor target, accent-bordered when its EQ is enabled.
const eqBtnStyle = (active, on, accent) => ({
  ...mono, fontSize: 10, height: 18, padding: '0 6px', borderRadius: 4, cursor: 'pointer', lineHeight: 1, letterSpacing: '0.04em',
  border: `1px solid ${active ? accent : on ? `color-mix(in oklab, ${accent} 55%, var(--border))` : 'var(--border)'}`,
  background: active ? `color-mix(in oklab, ${accent} 20%, transparent)` : 'transparent',
  color: (on || active) ? accent : 'var(--text-faint)',
});
const eqToggleStyle = (on, accent) => ({
  ...mono, fontSize: 10, width: 38, height: 20, borderRadius: 4, cursor: 'pointer', lineHeight: 1,
  border: `1px solid ${on ? accent : 'var(--border)'}`,
  background: on ? accent : 'transparent',
  color: on ? '#fff' : 'var(--text-faint)',
});
const eqNumStyle = {
  ...mono, width: 50, fontSize: 9.5, textAlign: 'center', padding: '2px 2px',
  border: '1px solid var(--border)', borderRadius: 3, background: 'var(--surface)', color: 'var(--text)',
};

// Bipolar vertical gain slider for one EQ band (−18..+18 dB, center = 0 dB).
// Custom pointer-drag (rotated range inputs are unreliable here); fill grows
// from the center line toward the handle. Draft-on-drag, commit-on-release.
const EQ_MIN = -18;
const EQ_MAX = 18;
function EqGainSlider({ value, onDraft, onCommit, accent }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const lastRef = useRef(value);
  const valFrom = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    return Math.round((EQ_MIN + frac * (EQ_MAX - EQ_MIN)) * 10) / 10;
  };
  const down = (e) => { e.currentTarget.setPointerCapture(e.pointerId); draggingRef.current = true; const v = valFrom(e); lastRef.current = v; onDraft(v); };
  const move = (e) => { if (!draggingRef.current) return; const v = valFrom(e); lastRef.current = v; onDraft(v); };
  const up = () => { if (!draggingRef.current) return; draggingRef.current = false; onCommit(lastRef.current); };
  const frac = (Math.max(EQ_MIN, Math.min(EQ_MAX, value)) - EQ_MIN) / (EQ_MAX - EQ_MIN);
  const pct = frac * 100;
  const fillBottom = Math.min(pct, 50);
  const fillHeight = Math.abs(pct - 50);
  return (
    <div
      ref={trackRef}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{ position: 'relative', width: 22, height: '100%', cursor: 'ns-resize', display: 'flex', justifyContent: 'center' }}
    >
      <div style={{ width: 4, height: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }} />
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: '50%', width: 12, height: 1, background: 'var(--border)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: `${fillBottom}%`, width: 4, height: `${fillHeight}%`, background: accent, borderRadius: 2, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: '50%', transform: 'translate(-50%, 50%)', bottom: `${pct}%`, width: 16, height: 9, background: 'var(--text)', borderRadius: 2, boxShadow: '0 1px 2px rgba(0,0,0,0.4)', pointerEvents: 'none' }} />
    </div>
  );
}

// Number input that previews live on change and commits ONE op on blur/Enter
// (keystrokes don't each become an undo entry).
function EqNumInput({ value, min, max, step, title, onLive, onCommit }) {
  const [draft, setDraft] = useState(null);
  return (
    <input
      type="number"
      value={draft ?? value}
      min={min}
      max={max}
      step={step}
      title={title}
      onChange={(e) => { setDraft(e.target.value); const v = Number(e.target.value); if (Number.isFinite(v)) onLive(v); }}
      onBlur={() => { if (draft != null) { const v = Number(draft); if (Number.isFinite(v)) onCommit(v); setDraft(null); } }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      style={eqNumStyle}
    />
  );
}

// One EQ band column: gain slider (primary) + frequency + Q. Emits PATCHES
// ({g}|{f}|{q}); the editor merges them into the band.
function EqBand({ band, accent, onLive, onCommit }) {
  const [gDraft, setGDraft] = useState(null);
  const g = gDraft ?? (band.g ?? 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, width: 58, minHeight: 0 }}>
      <span style={{ ...mono, fontSize: 9, color: 'var(--text-faint)' }}>{g > 0 ? '+' : ''}{g.toFixed(1)}</span>
      <div style={{ flex: 1, minHeight: 40, display: 'flex' }}>
        <EqGainSlider
          value={g}
          accent={accent}
          onDraft={(nv) => { setGDraft(nv); onLive({ g: nv }); }}
          onCommit={(nv) => { setGDraft(null); onCommit({ g: nv }); }}
        />
      </div>
      <EqNumInput value={Math.round(band.f)} min={20} max={20000} step={10} title="frequency (Hz)"
        onLive={(f) => onLive({ f })} onCommit={(f) => onCommit({ f })} />
      <EqNumInput value={band.q} min={0.1} max={10} step={0.1} title="Q"
        onLive={(qv) => onLive({ q: qv })} onCommit={(qv) => onCommit({ q: qv })} />
    </div>
  );
}

const eqPanelStyle = {
  flex: '1 1 auto', minWidth: 300, display: 'flex', flexDirection: 'column',
  minHeight: 0, borderLeft: '1px solid var(--border)',
};

// The parametric EQ editor for the selected strip (track or master). Renders
// from the COMMITTED eq; band edits flow back through onLive/onCommit which
// rebuild the whole {enabled,bands} object.
function EqEditor({ target, label, eq, accent, onLive, onCommit, onToggle }) {
  if (!target) {
    return (
      <div style={eqPanelStyle}>
        <div style={paneLabel}>Equalizer</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', color: 'var(--text-faint)', fontSize: 11, lineHeight: 1.5 }}>
          Click a strip's <span style={{ ...mono, color: 'var(--text-muted)', margin: '0 3px' }}>EQ</span> button to edit its 4-band parametric equalizer.
        </div>
      </div>
    );
  }
  const on = !!(eq && eq.enabled);
  const bands = (eq && Array.isArray(eq.bands) && eq.bands) || [];
  const setBand = (i, patch, commit) => {
    const nextBands = bands.map((b, j) => (j === i ? { ...b, ...patch } : b));
    // Editing a band auto-enables the EQ — a boost with no audible effect is a
    // trap. The On/Off toggle still bypasses explicitly.
    (commit ? onCommit : onLive)({ enabled: true, bands: nextBands });
  };
  return (
    <div style={eqPanelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}>
        <span style={{ ...mono, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text)' }}>{label} · EQ</span>
        <button type="button" onClick={() => onToggle(!on)} style={eqToggleStyle(on, accent)}>{on ? 'On' : 'Off'}</button>
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 8, padding: '0 12px 10px', minHeight: 0, opacity: on ? 1 : 0.5 }}>
        {bands.map((b, i) => (
          <EqBand key={i} band={b} accent={accent} onLive={(p) => setBand(i, p, false)} onCommit={(p) => setBand(i, p, true)} />
        ))}
      </div>
    </div>
  );
}

// Master gain-reduction meter (SF6): a downward fill — the compressor pulls it
// down as it clamps. Height written by MixSuite's rAF loop via the callback ref.
function GrMeter({ grRef }) {
  return (
    <div style={{ position: 'relative', width: 12, alignSelf: 'stretch', minHeight: 60, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div ref={grRef} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '0%', background: 'color-mix(in oklab, #d98a3d 70%, transparent)' }} />
    </div>
  );
}

// One compressor parameter: label + native HORIZONTAL range (reliable in
// WebKitGTK, unlike vertical/rotated) + value readout. Live on drag, commit on
// pointer-up (mirrors the pan slider).
function CompSlider({ label, value, min, max, step, fmt, accent, onLive, onCommit }) {
  const [draft, setDraft] = useState(null);
  const ref = useRef(value);
  const v = draft ?? value;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', width: 64 }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={v}
        onChange={(e) => { const nv = Number(e.target.value); ref.current = nv; setDraft(nv); onLive(nv); }}
        onPointerUp={() => { if (draft != null) { onCommit(ref.current); setDraft(null); } }}
        style={{ flex: 1, accentColor: accent }}
      />
      <span style={{ ...mono, fontSize: 10, color: 'var(--text-muted)', width: 52, textAlign: 'right' }}>{fmt(v)}</span>
    </div>
  );
}

// Master compressor editor (SF6). Editing a param auto-enables (matching the EQ
// trap fix); the On/Off toggle bypasses. GR meter on the left.
function CompEditor({ comp, accent, grRef, onLive, onCommit, onToggle }) {
  const on = !!(comp && comp.enabled);
  const c = comp || {};
  const setC = (patch, commit) => (commit ? onCommit : onLive)({ ...c, ...patch, enabled: true });
  const ms = (s) => `${Math.round((s || 0) * 1000)} ms`;
  return (
    <div style={eqPanelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}>
        <span style={{ ...mono, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text)' }}>Master · Compressor</span>
        <button type="button" onClick={() => onToggle(!on)} style={eqToggleStyle(on, accent)}>{on ? 'On' : 'Off'}</button>
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 12, padding: '0 12px 10px', minHeight: 0, opacity: on ? 1 : 0.5 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <GrMeter grRef={grRef} />
          <span style={{ ...mono, fontSize: 8.5, color: 'var(--text-faint)' }}>GR</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 7, minWidth: 0 }}>
          <CompSlider label="Threshold" value={c.threshold ?? -24} min={-60} max={0} step={1} accent={accent} fmt={(x) => `${x} dB`} onLive={(x) => setC({ threshold: x }, false)} onCommit={(x) => setC({ threshold: x }, true)} />
          <CompSlider label="Ratio" value={c.ratio ?? 4} min={1} max={20} step={0.5} accent={accent} fmt={(x) => `${x}:1`} onLive={(x) => setC({ ratio: x }, false)} onCommit={(x) => setC({ ratio: x }, true)} />
          <CompSlider label="Attack" value={c.attack ?? 0.003} min={0} max={0.2} step={0.001} accent={accent} fmt={ms} onLive={(x) => setC({ attack: x }, false)} onCommit={(x) => setC({ attack: x }, true)} />
          <CompSlider label="Release" value={c.release ?? 0.25} min={0.01} max={1} step={0.01} accent={accent} fmt={ms} onLive={(x) => setC({ release: x }, false)} onCommit={(x) => setC({ release: x }, true)} />
          <CompSlider label="Knee" value={c.knee ?? 30} min={0} max={40} step={1} accent={accent} fmt={(x) => `${x} dB`} onLive={(x) => setC({ knee: x }, false)} onCommit={(x) => setC({ knee: x }, true)} />
          <CompSlider label="Makeup" value={c.makeup ?? 0} min={0} max={24} step={0.5} accent={accent} fmt={(x) => `+${x} dB`} onLive={(x) => setC({ makeup: x }, false)} onCommit={(x) => setC({ makeup: x }, true)} />
        </div>
      </div>
      {/* SF8 (2026-06-22): EQ/pan/loudnorm are exact preview↔export; the master
          compressor preview (Web Audio) is INDICATIVE — its dynamics differ from
          the ffmpeg acompressor the export uses. Disclosed, not hidden. */}
      <div style={{ ...mono, fontSize: 8.5, color: 'var(--text-faint)', padding: '0 12px 8px', lineHeight: 1.35 }}>
        Preview is indicative — the rendered export is the exact compression.
      </div>
    </div>
  );
}

function ChannelStrip({
  label, value, pan, mute, solo, audible, accent,
  onFaderDraft, onFaderCommit, onPanLive, onPanCommit, onMute, onSolo,
  onEq, eqOn, eqActive, onCmp, cmpOn, cmpActive,
  peakRef, rmsRef, lufsRef,
  volKf, ph, onVolKeyframe, onVolDisarm,
}) {
  const [vDraft, setVDraft] = useState(null);
  const [pDraft, setPDraft] = useState(null);
  const panRef = useRef(pan ?? 0);
  const v = vDraft ?? value;
  const p = pDraft ?? pan ?? 0;
  const faderColor = audible ? accent : 'var(--text-faint)';
  return (
    <div style={{ width: 84, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, padding: '8px 6px', borderRight: '1px solid var(--border)', minHeight: 0 }}>
      <span style={{ ...mono, fontSize: 9.5, color: 'var(--text-faint)' }}>{dbLabel(v)}</span>
      <div style={{ flex: 1, minHeight: 24, display: 'flex', gap: 5, alignItems: 'stretch' }}>
        <Meter peakRef={peakRef} rmsRef={rmsRef} />
        <VFader
          value={v}
          accent={faderColor}
          onDraft={(nv) => { setVDraft(nv); onFaderDraft(nv); }}
          onCommit={(nv) => { setVDraft(null); onFaderCommit(nv); }}
        />
      </div>
      {onPanCommit ? (
        <input
          type="range" min={-1} max={1} step={0.01} value={p}
          onChange={(e) => { const nv = Number(e.target.value); panRef.current = nv; setPDraft(nv); onPanLive(nv); }}
          onPointerUp={() => { if (pDraft != null) { onPanCommit(panRef.current); setPDraft(null); } }}
          title={`pan ${p === 0 ? 'C' : p > 0 ? `R${Math.round(p * 100)}` : `L${Math.round(-p * 100)}`}`}
          style={{ width: 66, accentColor: accent }}
        />
      ) : <div style={{ height: 13 }} />}
      {onMute ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" onClick={onMute} title="Mute" style={pillStyle(mute, '#d98a3d')}>M</button>
          <button type="button" onClick={onSolo} title="Solo" style={pillStyle(solo, accent)}>S</button>
        </div>
      ) : lufsRef ? (
        <span ref={lufsRef} style={{ ...mono, fontSize: 9.5, color: 'var(--text-muted)' }}>−∞ LUFS</span>
      ) : <div style={{ height: 18 }} />}
      {(onEq || onCmp) ? (
        <div style={{ display: 'flex', gap: 4 }}>
          {onEq ? <button type="button" onClick={onEq} title="Edit EQ" style={eqBtnStyle(eqActive, eqOn, accent)}>EQ</button> : null}
          {onCmp ? <button type="button" onClick={onCmp} title="Compressor" style={eqBtnStyle(cmpActive, cmpOn, accent)}>CMP</button> : null}
        </div>
      ) : <div style={{ height: 18 }} />}
      {/* SF8 volume automation: KF arms (seeds a keyframe at the playhead from the
          current volume) / disarms (bakes + clears); ◆ sets/deletes a keyframe at
          the playhead. The fader rides the evaluated value and commits to a
          keyframe when armed (wired in MixSuite). */}
      {onVolKeyframe ? (() => {
        const armed = !!(volKf && volKf.length);
        const onPt = armed && volKf.some((k) => k.f === ph);
        return (
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" title={armed ? 'Disable volume automation' : 'Keyframe volume at playhead'}
              onClick={() => (armed ? onVolDisarm() : onVolKeyframe(v))} style={pillStyle(armed, accent)}>KF</button>
            {armed ? (
              <button type="button" title={onPt ? 'Delete keyframe at playhead' : 'Set keyframe at playhead'}
                onClick={() => onVolKeyframe(onPt ? null : v)} style={pillStyle(onPt, accent)}>◆</button>
            ) : null}
          </div>
        );
      })() : <div style={{ height: 18 }} />}
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.04em' }}>{label}</span>
    </div>
  );
}

export default function MixSuite({ project, accent, masterVolume, audioRef, onTrackMix, onMasterMix, onMasterVolume, playheadFrameRef, onTrackVolumeKeyframe, onTrackVolumeDisarm }) {
  const edge = accent || 'var(--accent)';
  const mixer = project?.mixer;
  const tracks = project?.tracks || [];
  const live = () => audioRef?.current;
  const [inspect, setInspect] = useState(null); // { kind: 'eq'|'comp', id } | null
  const [ph, setPh] = useState(0); // live playhead frame (SF8 volume automation)
  const metersRef = useRef({}); // { [id]: { peak: el, rms: el } }
  const lufsRef = useRef(null);
  const grRef = useRef(null);
  const setMeterEl = (id, kind) => (el) => {
    if (!metersRef.current[id]) metersRef.current[id] = {};
    metersRef.current[id][kind] = el;
  };

  // Resolve the EQ editor target (a stale id — track removed — falls back to none).
  const eqId = inspect?.kind === 'eq' ? inspect.id : null;
  const targetMix = eqId === 'master' ? mixer?.master : (eqId ? mixer?.tracks?.[eqId] : null);
  const effTarget = targetMix ? eqId : null;
  const targetEq = targetMix?.eq || null;
  const targetLabel = eqId === 'master' ? 'Master' : (eqId || '').toUpperCase();
  const masterComp = mixer?.master?.comp || null;

  // Live-push an EQ object to the graph during a drag (no op, no React).
  const pushEqLive = (eqObj) => {
    if (!effTarget) return;
    if (effTarget === 'master') { live()?.setMasterEq(eqObj); return; }
    const m = mixer?.tracks?.[effTarget];
    if (!m) return;
    live()?.setTrackLive(effTarget, { volume: m.volume ?? 1, pan: m.pan ?? 0, audible: trackAudible(mixer, effTarget), eq: eqObj });
  };
  const commitEq = (eqObj, label) => {
    if (!effTarget) return;
    if (effTarget === 'master') onMasterMix?.({ eq: eqObj }, label);
    else onTrackMix(effTarget, { eq: eqObj }, label);
  };
  // Master compressor (master-only): live-push to the graph, commit via onMasterMix.
  const pushCompLive = (compObj) => { live()?.setMasterComp(compObj); };
  const commitComp = (compObj, label) => { onMasterMix?.({ comp: compObj }, label); };

  // Single rAF loop reads the graph meters and writes bar geometry straight to
  // the DOM (no per-frame React). LUFS text updates ~10 Hz to avoid jitter.
  useEffect(() => {
    let raf;
    let frame = 0;
    const loop = () => {
      const lv = live()?.meter?.();
      if (lv) {
        for (const id of Object.keys(metersRef.current)) {
          const els = metersRef.current[id];
          const m = id === 'master' ? lv.master : (lv.tracks && lv.tracks[id]) || { peak: 0, rms: 0 };
          if (els.rms) els.rms.style.height = `${ampToFill(m.rms) * 100}%`;
          if (els.peak) {
            els.peak.style.bottom = `${ampToFill(m.peak) * 100}%`;
            els.peak.style.background = m.peak > 0.99 ? 'var(--error)' : 'var(--text)';
          }
        }
        if (lufsRef.current && frame % 6 === 0) {
          const l = lv.master.lufs;
          lufsRef.current.textContent = !Number.isFinite(l) || l < -60 ? '−∞ LUFS' : `${l.toFixed(1)} LUFS`;
        }
        if (grRef.current) {
          const gr = lv.master.gr || 0; // ≤ 0 dB; fill grows downward over a 20 dB range
          grRef.current.style.height = `${Math.min(100, (Math.abs(gr) / 20) * 100)}%`;
        }
      }
      // Track the playhead frame here (one rAF) so armed faders ride the
      // automation + the ◆ lights on a keyframe; guarded so paused = no churn.
      const pf = Math.round(playheadFrameRef?.current || 0);
      setPh((prev) => (prev !== pf ? pf : prev));
      frame += 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={paneLabel}>Mixer</div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ display: 'flex', minHeight: 0, overflowX: 'auto', flex: '0 1 auto' }}>
          {tracks.map((t) => {
            const m = mixer?.tracks?.[t.id] || { volume: 1, pan: 0, mute: false, solo: false };
            const aud = trackAudible(mixer, t.id);
            const volKf = (m.kf && m.kf.volume) || null;
            const effVol = volKf ? evaluate(volKf, ph) : (m.volume ?? 1); // ride the automation
            return (
              <ChannelStrip
                key={t.id}
                label={(t.id || '').toUpperCase()}
                value={effVol}
                pan={m.pan ?? 0}
                mute={!!m.mute}
                solo={!!m.solo}
                audible={aud}
                accent={edge}
                peakRef={setMeterEl(t.id, 'peak')}
                rmsRef={setMeterEl(t.id, 'rms')}
                onEq={() => setInspect({ kind: 'eq', id: t.id })}
                eqOn={!!(m.eq && m.eq.enabled)}
                eqActive={eqId === t.id}
                onFaderDraft={(nv) => live()?.setTrackLive(t.id, { volume: nv, pan: m.pan ?? 0, audible: aud, eq: m.eq })}
                onFaderCommit={(nv) => (volKf
                  ? onTrackVolumeKeyframe?.(t.id, ph, nv)
                  : onTrackMix(t.id, { volume: nv }, 'Track volume'))}
                onPanLive={(nv) => live()?.setTrackLive(t.id, { volume: m.volume ?? 1, pan: nv, audible: aud, eq: m.eq })}
                onPanCommit={(nv) => onTrackMix(t.id, { pan: nv }, 'Track pan')}
                onMute={() => onTrackMix(t.id, { mute: !m.mute }, m.mute ? 'Unmute' : 'Mute')}
                onSolo={() => onTrackMix(t.id, { solo: !m.solo }, m.solo ? 'Unsolo' : 'Solo')}
                volKf={volKf}
                ph={ph}
                onVolKeyframe={(value) => onTrackVolumeKeyframe?.(t.id, ph, value)}
                onVolDisarm={() => onTrackVolumeDisarm?.(t.id, ph)}
              />
            );
          })}
          <ChannelStrip
            label="MASTER"
            value={masterVolume}
            audible
            accent={edge}
            peakRef={setMeterEl('master', 'peak')}
            rmsRef={setMeterEl('master', 'rms')}
            lufsRef={lufsRef}
            onEq={() => setInspect({ kind: 'eq', id: 'master' })}
            eqOn={!!(mixer?.master?.eq && mixer.master.eq.enabled)}
            eqActive={eqId === 'master'}
            onCmp={() => setInspect({ kind: 'comp', id: 'master' })}
            cmpOn={!!(mixer?.master?.comp && mixer.master.comp.enabled)}
            cmpActive={inspect?.kind === 'comp'}
            onFaderDraft={(nv) => live()?.setMaster(nv)}
            onFaderCommit={(nv) => onMasterVolume(nv)}
          />
        </div>
        {inspect?.kind === 'comp' ? (
          <CompEditor
            comp={masterComp}
            accent={edge}
            grRef={grRef}
            onLive={pushCompLive}
            onCommit={(compObj) => commitComp(compObj, 'Compressor')}
            onToggle={(on) => { const compObj = { ...(masterComp || {}), enabled: on }; pushCompLive(compObj); commitComp(compObj, on ? 'Comp on' : 'Comp off'); }}
          />
        ) : (
          <EqEditor
            target={effTarget}
            label={targetLabel}
            eq={targetEq}
            accent={edge}
            onLive={pushEqLive}
            onCommit={(eqObj) => commitEq(eqObj, 'EQ')}
            onToggle={(on) => { const eqObj = { ...(targetEq || { bands: [] }), enabled: on }; pushEqLive(eqObj); commitEq(eqObj, on ? 'EQ on' : 'EQ off'); }}
          />
        )}
      </div>
    </div>
  );
}
