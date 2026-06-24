// GradeControls — suite columns 1–2 (Color Grading SF7): the three CDL wheels
// and the Sat/Temp/Tint + creative-LUT column. Pure controls: ColorSuite owns
// the draft/commit gesture protocol (draftPatch → live GL via the pipeline
// draft slot; gestureEnd/commitPatch → ONE undo op per gesture).

import { useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import ColorWheel from './ColorWheel.jsx';
import CurveEditor from './CurveEditor.jsx';
import { lutState, registerLutText, lastCompileMs } from './gradePipeline.js';
import { OutlinedBtn } from '@host/components/ui/Button.jsx';
import { Seg } from '@host/components/ui/Pill.jsx';

const mono = { fontFamily: '"DM Mono", monospace' };

const rowLabel = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  width: 36,
  flexShrink: 0,
  userSelect: 'none',
};

const WHEELS = [
  { key: 'lift', label: 'Lift', neutral: [0, 0, 0], puckScale: 0.25, min: -0.5, max: 0.5 },
  { key: 'gamma', label: 'Gamma', neutral: [0, 0, 0], puckScale: 0.5, min: -1, max: 1 },
  { key: 'gain', label: 'Gain', neutral: [1, 1, 1], puckScale: 0.5, min: 0, max: 2 },
];

export function WheelsColumn({ working, accent, draftPatch, gestureEnd, commitPatch }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, height: '100%', padding: '0 10px' }}>
      {WHEELS.map((w) => (
        <ColorWheel
          key={w.key}
          label={w.label}
          value={working[w.key] || w.neutral}
          accent={accent}
          puckScale={w.puckScale}
          min={w.min}
          max={w.max}
          onDraft={(triple) => draftPatch({ [w.key]: triple })}
          onGestureEnd={() => gestureEnd(w.label)}
          onReset={() => commitPatch({ [w.key]: w.neutral }, `Reset ${w.label.toLowerCase()}`)}
        />
      ))}
    </div>
  );
}

// Slider row with commit-on-release (ClipAudioStrip recipe): drags stream
// through draftPatch, pointer/key release commits the gesture.
function SliderRow({ label, value, min, max, neutral, fmt, accent, onDraftValue, onEnd, onResetValue }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onPointerUp={onEnd} onKeyUp={onEnd}>
      <span style={rowLabel} onDoubleClick={onResetValue} title="Double-click to reset">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.005}
        value={value}
        onChange={(e) => onDraftValue(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0, accentColor: accent }}
      />
      <span style={{ ...mono, fontSize: 10, color: 'var(--text-muted)', width: 40, textAlign: 'right', flexShrink: 0 }}>
        {fmt(value)}
      </span>
    </div>
  );
}

const pct = (v) => `${Math.round(v * 100)}%`;
const signed = (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

export function SatLutColumn({
  working, accent, api, projName,
  draftPatch, gestureEnd, commitPatch, commitGrade, onNotice,
}) {
  const busyRef = useRef(false);

  const loadLut = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const picked = await open({
        multiple: false,
        title: 'Load .cube LUT',
        filters: [{ name: 'Cube LUT', extensions: ['cube'] }],
      });
      if (!picked) return;
      const r = await api.invoke('vedit_lut_import', { name: projName, path: picked });
      registerLutText(r.file, r.text);
      commitPatch({ lut: { file: r.file, name: r.name, intensity: 1 } }, 'Load LUT');
    } catch (e) {
      // Surface the failure — the webview console is invisible in the dev
      // workflow, and a silent catch here once masked a broken import path.
      onNotice?.(`LUT load failed: ${typeof e === 'string' ? e : e?.message || e}`);
      console.error('[vedit-lut]', e);
    } finally {
      busyRef.current = false;
    }
  };

  const lut = working.lut;
  const offline = lut && lutState(lut.file) === 'missing';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, height: '100%', padding: '0 14px' }}>
      <SliderRow
        label="Temp" value={working.temp ?? 0} min={-1} max={1} fmt={signed} accent={accent}
        onDraftValue={(v) => draftPatch({ temp: v })}
        onEnd={() => gestureEnd('Temp')}
        onResetValue={() => commitPatch({ temp: 0 }, 'Reset temp')}
      />
      <SliderRow
        label="Tint" value={working.tint ?? 0} min={-1} max={1} fmt={signed} accent={accent}
        onDraftValue={(v) => draftPatch({ tint: v })}
        onEnd={() => gestureEnd('Tint')}
        onResetValue={() => commitPatch({ tint: 0 }, 'Reset tint')}
      />
      <SliderRow
        label="Sat" value={working.sat ?? 1} min={0} max={2} fmt={pct} accent={accent}
        onDraftValue={(v) => draftPatch({ sat: v })}
        onEnd={() => gestureEnd('Saturation')}
        onResetValue={() => commitPatch({ sat: 1 }, 'Reset saturation')}
      />

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!lut ? (
          <OutlinedBtn small onClick={loadLut}>Load LUT…</OutlinedBtn>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }} title={lut.file}>
                {lut.name || lut.file}
              </span>
              {offline && (
                <span style={{ ...mono, fontSize: 9, color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 3, padding: '0 4px', flexShrink: 0 }}>
                  OFFLINE
                </span>
              )}
              <button
                type="button"
                title="Remove LUT"
                onClick={() => commitPatch({ lut: null }, 'Remove LUT')}
                style={{ ...mono, fontSize: 11, background: 'none', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-faint)', cursor: 'pointer', padding: '0 5px', flexShrink: 0 }}
              >
                ×
              </button>
            </div>
            <SliderRow
              label="Mix" value={lut.intensity ?? 1} min={0} max={1} fmt={pct} accent={accent}
              onDraftValue={(v) => draftPatch({ lut: { ...lut, intensity: v } })}
              onEnd={() => gestureEnd('LUT intensity')}
              onResetValue={() => commitPatch({ lut: { ...lut, intensity: 1 } }, 'Reset LUT intensity')}
            />
          </>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <OutlinedBtn small onClick={() => commitGrade(undefined, 'Reset grade')}>Reset grade</OutlinedBtn>
          {import.meta.env.DEV && (
            <span style={{ ...mono, fontSize: 9.5, color: 'var(--text-faint)' }} title="last LUT compile">
              {lastCompileMs.toFixed(1)} ms
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Curves column (SF8) ────────────────────────────────────────────────────

const DIAG = [[0, 0], [1, 1]];

const CURVE_TABS = [
  { value: 'm', label: 'M', stroke: null, gesture: 'Master curve' },
  { value: 'r', label: 'R', stroke: '#e06a6a', gesture: 'Red curve' },
  { value: 'g', label: 'G', stroke: '#6abf6a', gesture: 'Green curve' },
  { value: 'b', label: 'B', stroke: '#6a8fe0', gesture: 'Blue curve' },
  { value: 'hue', label: 'HUE', stroke: null, gesture: 'Hue-vs-sat' },
];

// Faint hue strip behind the hue-vs-sat plot (x = hue axis).
const HUE_BG = [
  'linear-gradient(to right, hsla(0,85%,55%,0.22), hsla(60,85%,55%,0.22), hsla(120,85%,55%,0.22), hsla(180,85%,55%,0.22), hsla(240,85%,55%,0.22), hsla(300,85%,55%,0.22), hsla(360,85%,55%,0.22))',
  'var(--surface)',
].join(', ');

// Channel write that collapses an all-identity curves object back to null
// (the schema's absent-= identity rule).
const setChannel = (curves, ch, pts) => {
  const next = { ...(curves || {}), [ch]: pts && pts.length ? pts : null };
  return next.m || next.r || next.g || next.b ? next : null;
};

export function CurvesColumn({ working, accent, draftPatch, gestureEnd, commitPatch }) {
  const [tab, setTab] = useState('m');
  const cfg = CURVE_TABS.find((t) => t.value === tab);
  const isHue = tab === 'hue';
  const pts = isHue ? working.hueSat || [] : working.curves?.[tab] || DIAG;

  const onDraft = (p) => draftPatch(
    isHue ? { hueSat: p && p.length ? p : null } : { curves: setChannel(working.curves, tab, p) },
  );
  const onReset = () => commitPatch(
    isHue ? { hueSat: null } : { curves: setChannel(working.curves, tab, null) },
    `Reset ${cfg.gesture.toLowerCase()}`,
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', padding: '0 10px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <Seg options={CURVE_TABS.map(({ value, label }) => ({ value, label }))} value={tab} onChange={setTab} accent={accent} />
        <OutlinedBtn small onClick={onReset} title={`Reset ${cfg.gesture.toLowerCase()}`}>⟲</OutlinedBtn>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CurveEditor
          key={tab /* drag refs must not leak across channels */}
          points={pts}
          wrap={isHue}
          identity={isHue ? 'one' : 'diag'}
          yMax={isHue ? 2 : 1}
          accent={accent}
          stroke={cfg.stroke}
          background={isHue ? HUE_BG : undefined}
          onDraft={onDraft}
          onGestureEnd={() => gestureEnd(cfg.gesture)}
        />
      </div>
    </div>
  );
}
