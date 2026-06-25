import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import Toast from '@host/components/ui/Toast.jsx';
import { PrimaryBtn, OutlinedBtn, IconBtn } from '@host/components/ui/Button.jsx';
import { IconClapperboard, IconTrash } from '@host/components/icons.jsx';
import { newProject, normalizeProject, newId, defaultTitle, TITLE_FONTS } from './project.js';
import { evaluate, transformAtFrame, gainAtFrame } from './keyframes/engine.js';
import useAutosave from './useAutosave.js';
import { pickAndImport } from './importQueue.js';
import BinPanel from './BinPanel.jsx';
import PreviewPlayer from './PreviewPlayer.jsx';
import Timeline, { clampStartToGap } from './Timeline.jsx';
import ExportDialog from './ExportDialog.jsx';
import ParityPanel from './color/ParityPanel.jsx';
import CompositeParityPanel from './CompositeParityPanel.jsx';
import EncodeSmokePanel from './EncodeSmokePanel.jsx';
import AudioParityPanel from './audio/AudioParityPanel.jsx';
import ColorSuite from './color/ColorSuite.jsx';
import MixSuite from './MixSuite.jsx';
import * as editOps from './editList.js';
import * as gradeOps from './color/gradeOps.js';
import { registerLutText, markLutMissing, lutState } from './color/gradePipeline.js';
import { listen } from '@tauri-apps/api/event';
import useUndoStack from './useUndoStack.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { makeEditorKeydown } from './keybinds.js';

// Cuts-only NLE (Video Editor Phase 1). No project open → the Projects picker
// on the shared AppWindow shell (its inline fadeIn satisfies the
// animation-gate rule). Open project → sequence inspector strip + the three
// panes: Bin (left, SF4), Preview (center, SF5 Projection Booth), Timeline
// (bottom, SF6 — functional chrome only; the creative checkpoint was waived
// 2026-06-10: core functionality first).

const paneLabel = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  padding: '10px 12px',
  userSelect: 'none',
};
const mono = { fontFamily: '"DM Mono", monospace' };

const GAIN_PRESETS = [['+6 dB', 2], ['+3 dB', 1.41], ['0 dB', 1], ['−3 dB', 0.71], ['−6 dB', 0.5], ['−12 dB', 0.25]];

// Clip inspector strip (SF9): gain slider committing ONE op on release +
// mute toggle. SF8: `gain` is the EFFECTIVE value at the playhead (static, or
// kf-evaluated when armed); onGain routes to a keyframe when gain is armed.
function ClipAudioStrip({ gain, mute, clipId, accent, onGain, onMute }) {
  const [draft, setDraft] = useState(null);
  useEffect(() => { setDraft(null); }, [clipId, gain]);
  const val = draft ?? gain ?? 1;
  const commit = () => {
    if (draft != null && draft !== gain) onGain(draft);
    setDraft(null);
  };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} onPointerUp={commit} onKeyUp={commit}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Gain</span>
      <input
        type="range"
        min={0}
        max={2}
        step={0.01}
        value={val}
        onChange={(e) => setDraft(Number(e.target.value))}
        style={{ width: 90, accentColor: accent }}
      />
      <span style={{ ...mono, fontSize: 11, color: 'var(--text-muted)', width: 38 }}>{Math.round(val * 100)}%</span>
      <button
        onClick={onMute}
        style={{
          ...mono,
          fontSize: 10.5,
          background: 'none',
          border: `1px solid ${mute ? (accent || 'var(--accent)') : 'var(--border)'}`,
          color: mute ? (accent || 'var(--accent)') : 'var(--text-faint)',
          borderRadius: 6,
          padding: '2px 8px',
          cursor: 'pointer',
        }}
      >
        {mute ? 'MUTED' : 'MUTE'}
      </button>
    </div>
  );
}

// Commit-on-blur numeric field (Enter = blur). Committed values only — the
// autosave contract is dirty-on-commit, never per keystroke.
function NumField({ label, value, width = 64, min, max, float = false, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = float ? Number(draft) : Math.round(Number(draft));
    if (!Number.isFinite(n) || n < min || n > max || n === value) {
      setDraft(String(value));
      return;
    }
    onCommit(float ? Math.round(n * 1000) / 1000 : n);
  };
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{label}</span>
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        spellCheck={false}
        style={{ ...mono, fontSize: 12.5, width, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px' }}
      />
    </label>
  );
}

// Per-clip transform inspector (Compositing & Titles SF2/SF6/SF8). `t` is the
// EFFECTIVE transform at the playhead (static, or kf-evaluated when a param is
// armed); each field routes through onField(field, value) so the parent decides
// static-vs-keyframe. scale & crop are not keyframable this sub-plan.
function TransformStrip({ t, onField }) {
  const cr = t.crop || {};
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <NumField label="X%" width={52} value={Math.round((t.x ?? 0) * 100)} min={-300} max={300} onCommit={v => onField('x', v / 100)} />
      <NumField label="Y%" width={52} value={Math.round((t.y ?? 0) * 100)} min={-300} max={300} onCommit={v => onField('y', v / 100)} />
      <NumField label="Scale%" width={56} value={Math.round((t.scale ?? 1) * 100)} min={1} max={1000} onCommit={v => onField('scale', v / 100)} />
      <NumField label="Rot°" width={52} value={Math.round(t.rot ?? 0)} min={-360} max={360} onCommit={v => onField('rot', v)} />
      <NumField label="Op%" width={52} value={Math.round((t.opacity ?? 1) * 100)} min={0} max={100} onCommit={v => onField('opacity', v / 100)} />
      <NumField label="Crop L" width={48} value={Math.round((cr.l ?? 0) * 100)} min={0} max={95} onCommit={v => onField('crop.l', v / 100)} />
      <NumField label="T" width={44} value={Math.round((cr.t ?? 0) * 100)} min={0} max={95} onCommit={v => onField('crop.t', v / 100)} />
      <NumField label="R" width={44} value={Math.round((cr.r ?? 0) * 100)} min={0} max={95} onCommit={v => onField('crop.r', v / 100)} />
      <NumField label="B" width={44} value={Math.round((cr.b ?? 0) * 100)} min={0} max={95} onCommit={v => onField('crop.b', v / 100)} />
    </div>
  );
}

// Keyframe controls (Compositing & Titles SF8) — the dedicated row beneath the
// transform strip. Per-param arm toggles (Pos/Rot/Op/Gain) seed a keyframe at
// the playhead on arm and bake-then-clear on disarm; a shared navigator steps
// the playhead between keyframes and sets/deletes a keyframe at the playhead for
// every armed param (one undo). When the playhead sits on a keyframe an ease
// chip cycles linear→in→out→inout. `ph` is the live playhead frame (Inspector's
// rAF). Each multi-param action is one batched undo entry.
const KF_PARAMS = [['pos', 'Pos'], ['rot', 'Rot'], ['opacity', 'Op'], ['gain', 'Gain']];

function KeyframeStrip({ clip, laneIdx, ph, accent, seekToFrame, applyOp, projectRef }) {
  const kf = clip.kf || {};
  const tracks = () => projectRef.current.tracks;
  const armed = (p) => !!kf[p];
  const valAt = (p) => {
    if (p === 'gain') return armed('gain') ? evaluate(kf.gain, ph) : (clip.gain ?? 1);
    if (p === 'pos') return armed('pos') ? evaluate(kf.pos, ph) : { x: clip.transform?.x ?? 0, y: clip.transform?.y ?? 0 };
    if (armed(p)) return evaluate(kf[p], ph);
    return p === 'opacity' ? (clip.transform?.opacity ?? 1) : (clip.transform?.rot ?? 0);
  };
  const toggleArm = (p) => {
    const op = armed(p)
      ? editOps.disarmClipKeyframes(tracks(), laneIdx, clip.id, p, ph)
      : editOps.setKeyframe(tracks(), laneIdx, clip.id, p, ph, valAt(p));
    if (op) applyOp(op);
  };
  const armedParams = KF_PARAMS.map(([p]) => p).filter(armed);
  const frames = [...new Set(Object.keys(kf).flatMap(k => kf[k].map(e => e.f)))].sort((a, b) => a - b);
  const onKf = frames.includes(ph);
  const prevF = [...frames].reverse().find(f => f < ph);
  const nextF = frames.find(f => f > ph);

  const toggleKey = () => {
    let t = tracks();
    const ops = [];
    for (const p of armedParams) {
      const here = kf[p].some(e => e.f === ph);
      const op = here
        ? editOps.setKeyframe(t, laneIdx, clip.id, p, ph, null)
        : editOps.setKeyframe(t, laneIdx, clip.id, p, ph, valAt(p));
      if (op) { t = op.apply(t); ops.push(op); }
    }
    const b = editOps.batch('Keyframe', ops);
    if (b) applyOp(b);
  };
  const cycle = () => {
    let t = tracks();
    const ops = [];
    for (const p of armedParams) {
      if (!kf[p].some(e => e.f === ph)) continue;
      const op = editOps.cycleKeyframeEase(t, laneIdx, clip.id, p, ph);
      if (op) { t = op.apply(t); ops.push(op); }
    }
    const b = editOps.batch('Keyframe ease', ops);
    if (b) applyOp(b);
  };
  const easeName = (() => {
    const p = armedParams.find(p => kf[p].some(e => e.f === ph));
    return (p && kf[p].find(e => e.f === ph)?.ease) || 'linear';
  })();

  const armStyle = (on) => ({ ...mono, fontSize: 10.5, background: 'none', border: `1px solid ${on ? (accent || 'var(--accent)') : 'var(--border)'}`, color: on ? (accent || 'var(--accent)') : 'var(--text-faint)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' });
  const navStyle = (enabled, lit) => ({ ...mono, fontSize: 13, background: 'none', border: 'none', color: lit ? (accent || 'var(--accent)') : (enabled ? 'var(--text-muted)' : 'var(--text-faint)'), cursor: enabled ? 'pointer' : 'default', padding: '0 4px' });

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Keyframes</span>
      {KF_PARAMS.map(([p, lbl]) => (
        <button key={p} style={armStyle(armed(p))} onClick={() => toggleArm(p)} title={`${armed(p) ? 'Disable' : 'Enable'} ${lbl} keyframes`}>{lbl}</button>
      ))}
      {armedParams.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 4 }}>
          <button style={navStyle(prevF != null, false)} disabled={prevF == null} onClick={() => prevF != null && seekToFrame(prevF)} title="Previous keyframe">◄</button>
          <button style={navStyle(true, onKf)} onClick={toggleKey} title={onKf ? 'Delete keyframe at playhead' : 'Set keyframe at playhead'}>◆</button>
          <button style={navStyle(nextF != null, false)} disabled={nextF == null} onClick={() => nextF != null && seekToFrame(nextF)} title="Next keyframe">►</button>
          {onKf && <button style={armStyle(false)} onClick={cycle} title="Cycle keyframe easing">{easeName}</button>}
        </span>
      )}
    </div>
  );
}

// The selected-clip inspector (SF8) — owns ONE rAF that tracks the live playhead
// frame, so per-frame re-renders stay confined to this small subtree (not all of
// EditorPage). Shows the EFFECTIVE transform/gain at the playhead and routes
// field edits: an armed visual param (pos/rot/opacity) or gain writes a keyframe
// at the playhead; everything else writes the static transform.
const TITLE_INPUT = { fontSize: 12, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 7px' };
const SWATCH = { width: 26, height: 22, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer' };

// Title text/style controls (Compositing & Titles SF10), shown in the Inspector
// when the selected clip is a title. Each field commits ONE setTitle undo op;
// position/scale/rotation reuse the shared TransformStrip + on-canvas handles.
function TitleControls({ clip, laneIdx, accent, applyOp, projectRef }) {
  const t = clip.title || {};
  const set = (patch) => applyOp(editOps.setTitle(projectRef.current.tracks, laneIdx, clip.id, patch));
  const tog = (on, label, onClick, title) => (
    <button type="button" title={title} onClick={onClick}
      style={{ ...mono, fontSize: 11, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', background: 'none',
        border: `1px solid ${on ? (accent || 'var(--accent)') : 'var(--border)'}`, color: on ? (accent || 'var(--accent)') : 'var(--text-faint)' }}>{label}</button>
  );
  const bg = t.background;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea value={t.text ?? ''} onChange={e => set({ text: e.target.value })} rows={1} spellCheck={false}
        placeholder="Title text" style={{ ...TITLE_INPUT, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select value={t.font || 'Segoe UI'} onChange={e => set({ font: e.target.value })} style={TITLE_INPUT}>
          {TITLE_FONTS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <NumField label="Size" value={t.size ?? 96} min={1} max={2000} width={66} onCommit={v => set({ size: v })} />
        <input type="color" title="Text color" value={t.color || '#ffffff'} onChange={e => set({ color: e.target.value })} style={SWATCH} />
        {tog(t.bold, 'B', () => set({ bold: !t.bold }), 'Bold')}
        {tog(t.italic, 'I', () => set({ italic: !t.italic }), 'Italic')}
        <span style={{ display: 'inline-flex', gap: 2 }}>
          {['left', 'center', 'right'].map(a => tog(t.align === a, a[0].toUpperCase(), () => set({ align: a }), `Align ${a}`))}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)' }}>STROKE</span>
        <input type="color" title="Stroke color" value={t.stroke?.color || '#000000'} onChange={e => set({ stroke: { ...t.stroke, color: e.target.value } })} style={SWATCH} />
        <NumField label="W" value={t.stroke?.width ?? 0} min={0} max={100} width={56} onCommit={v => set({ stroke: { ...t.stroke, width: v } })} />
        <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', marginLeft: 6 }}>SHADOW</span>
        <input type="color" title="Shadow color" value={t.shadow?.color || '#000000'} onChange={e => set({ shadow: { ...t.shadow, color: e.target.value } })} style={SWATCH} />
        <NumField label="Blur" value={t.shadow?.blur ?? 0} min={0} max={200} width={62} onCommit={v => set({ shadow: { ...t.shadow, blur: v } })} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {tog(!!bg, 'Lower-third bar', () => set({ background: bg ? null : { color: '#000000', padX: 40, padY: 20 } }), 'Toggle background bar')}
        {bg && <input type="color" title="Bar color" value={bg.color || '#000000'} onChange={e => set({ background: { ...bg, color: e.target.value } })} style={SWATCH} />}
        {bg && <NumField label="Pad X" value={bg.padX ?? 0} min={0} max={500} width={66} onCommit={v => set({ background: { ...bg, padX: v } })} />}
        {bg && <NumField label="Pad Y" value={bg.padY ?? 0} min={0} max={500} width={66} onCommit={v => set({ background: { ...bg, padY: v } })} />}
      </div>
    </div>
  );
}

function Inspector({ clip, laneIdx, accent, playheadFrameRef, seekToFrame, applyOp, projectRef }) {
  const [ph, setPh] = useState(() => Math.round(playheadFrameRef.current || 0));
  useEffect(() => {
    let raf;
    const tick = () => {
      const f = Math.round(playheadFrameRef.current || 0);
      setPh(p => (p !== f ? f : p));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playheadFrameRef]);

  const kf = clip.kf || {};
  const eff = transformAtFrame(clip.transform || null, kf, ph) || {};
  const effGain = gainAtFrame(clip.gain ?? 1, kf, ph);
  const tracks = () => projectRef.current.tracks;
  const staticBase = () => {
    const t = clip.transform || {};
    const cr = t.crop || {};
    return { x: t.x ?? 0, y: t.y ?? 0, scale: t.scale ?? 1, rot: t.rot ?? 0, opacity: t.opacity ?? 1, crop: { l: cr.l ?? 0, t: cr.t ?? 0, r: cr.r ?? 0, b: cr.b ?? 0 } };
  };
  const onField = (field, value) => {
    if (field === 'x' || field === 'y') {
      if (kf.pos) {
        const cur = evaluate(kf.pos, ph) || { x: eff.x ?? 0, y: eff.y ?? 0 };
        const nv = field === 'x' ? { x: value, y: cur.y } : { x: cur.x, y: value };
        applyOp(editOps.setKeyframe(tracks(), laneIdx, clip.id, 'pos', ph, nv));
      } else {
        applyOp(editOps.setClipTransform(tracks(), laneIdx, clip.id, { ...staticBase(), [field]: value }));
      }
    } else if (field === 'rot' || field === 'opacity') {
      if (kf[field]) applyOp(editOps.setKeyframe(tracks(), laneIdx, clip.id, field, ph, value));
      else applyOp(editOps.setClipTransform(tracks(), laneIdx, clip.id, { ...staticBase(), [field]: value }));
    } else if (field.startsWith('crop.')) {
      const k = field.slice(5);
      const b = staticBase();
      applyOp(editOps.setClipTransform(tracks(), laneIdx, clip.id, { ...b, crop: { ...b.crop, [k]: value } }));
    } else {
      applyOp(editOps.setClipTransform(tracks(), laneIdx, clip.id, { ...staticBase(), [field]: value }));
    }
  };
  const onGain = (v) => {
    if (kf.gain) applyOp(editOps.setKeyframe(tracks(), laneIdx, clip.id, 'gain', ph, v));
    else applyOp(editOps.setClipProps(tracks(), laneIdx, clip.id, { gain: v }, 'Gain'));
  };
  const onMute = () => applyOp(editOps.setClipProps(tracks(), laneIdx, clip.id, { mute: !clip.mute }, clip.mute ? 'Unmute' : 'Mute'));

  const isTitle = clip.kind === 'title';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {!isTitle && <ClipAudioStrip gain={effGain} mute={clip.mute} clipId={clip.id} accent={accent} onGain={onGain} onMute={onMute} />}
        <TransformStrip t={eff} onField={onField} />
      </div>
      {isTitle && <TitleControls clip={clip} laneIdx={laneIdx} accent={accent} applyOp={applyOp} projectRef={projectRef} />}
      <KeyframeStrip clip={clip} laneIdx={laneIdx} ph={ph} accent={accent} seekToFrame={seekToFrame} applyOp={applyOp} projectRef={projectRef} />
    </div>
  );
}

export default function EditorPage({ api, accent, rest }) {
  // Mode is route-derived (amended decision 1): /tools/video-editor = Edit,
  // /tools/video-editor/color = Color. Reload lands back on the same mode.
  const modeSeg = (rest || '').split('/')[0];
  const mode = modeSeg === 'color' ? 'color' : modeSeg === 'mix' ? 'mix' : 'edit';
  // Dev-only SF11 perf number: module-render start → first painted frame
  // (the route-swap budget's measurable half; the lazy chunk is cached after
  // first visit). Surfaced as a toast once per mount — the webview console
  // is invisible in the dev workflow.
  const mountT0 = useRef(import.meta.env.DEV ? performance.now() : 0);

  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);   // normalized document
  const [projName, setProjName] = useState(null); // sanitized folder name (Rust truth)
  const [newName, setNewName] = useState('');
  const [pickerErr, setPickerErr] = useState('');
  const [saveState, setSaveState] = useState('saved'); // saved | dirty | conflict | error
  const [binToast, setBinToast] = useState(null); // { binId, name }
  const toastTimer = useRef(null);
  // Media session state — keyed by media.id (stable across hash drift when a
  // source file's mtime changes and the re-pin remints its proxy hash).
  const [mediaUrls, setMediaUrls] = useState(() => new Map());
  const [mediaStatus, setMediaStatus] = useState(() => new Map());
  const [importErrors, setImportErrors] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importStatusText, setImportStatusText] = useState('');
  const [overBudget, setOverBudget] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [selection, setSelection] = useState([]); // [{ laneIdx, clipId }] — entry 0 is the anchor (SF8)
  const [bladeMode, setBladeMode] = useState(false);
  const [opToast, setOpToast] = useState(null); // undo/redo feedback text
  const opToastTimer = useRef(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [parityOpen, setParityOpen] = useState(false); // SF5 DEV battery
  const [audioParityOpen, setAudioParityOpen] = useState(false); // Audio Post SF8 DEV battery
  const [compParityOpen, setCompParityOpen] = useState(false); // Compositing SF12 DEV battery
  const [encodeSmokeOpen, setEncodeSmokeOpen] = useState(false); // Delivery & Presets SF9 DEV battery
  const [exportToast, setExportToast] = useState(null); // { path } — completion toast
  const exportToastTimer = useRef(null);
  const playheadFrameRef = useRef(0); // Timeline writes; trim-to-playhead reads
  const playerRef = useRef(null);     // PreviewPlayer imperative surface (keybinds + ruler scrub)
  const audioRef = useRef(null);      // PreviewPlayer mixer surface (SF3 live fader/pan/master)
  const timelineRef = useRef(null);   // Timeline imperative surface (keybind zoom)
  const { push: pushOp, undo: popUndo, redo: popRedo, clear: clearStack } = useUndoStack(200);
  const { openContextMenu } = useContextMenu();
  const mtimeRef = useRef(null);
  // projectRef is the AUTHORITATIVE document; state mirrors it for render.
  // Every mutation goes through updateProject so the ref advances
  // synchronously — flush() can then snapshot mid-event-handler without
  // racing React's render commit (blur-commit → immediate navigation was
  // saving the stale document otherwise).
  const projectRef = useRef(null);
  const updateProject = useCallback((fn) => {
    const next = fn(projectRef.current);
    if (!next) return;
    projectRef.current = next;
    setProject(next);
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setProjects(await api.invoke('vedit_project_list', {}));
    } catch (e) {
      setPickerErr(e?.message || String(e));
    }
  }, [api]);

  useEffect(() => { if (!project) refreshList(); }, [project, refreshList]);

  const { markDirty, flush } = useAutosave({
    api,
    name: projName,
    getSnapshot: () => projectRef.current,
    mtimeRef,
    onStatus: (s) => {
      if (s.state === 'error') setSaveState(s.error?.code === 'CONFLICT' ? 'conflict' : 'error');
      else setSaveState(s.state);
    },
  });

  const openProject = async (name) => {
    setPickerErr('');
    try {
      const r = await api.invoke('vedit_project_read', { name });
      mtimeRef.current = r.mtime;
      setProjName(r.name);
      const doc = normalizeProject(r.data, r.name);
      projectRef.current = doc;
      setProject(doc);
      setSaveState('saved');
      setSelection([]);
      clearStack(); // history is never persisted — fresh open starts clean
    } catch (e) {
      setPickerErr(e?.message || String(e));
    }
  };

  const createProject = async () => {
    const name = newName.trim();
    if (!name) return;
    setPickerErr('');
    try {
      const doc = newProject(name);
      const r = await api.invoke('vedit_project_save', { name, data: doc, mtime: null });
      mtimeRef.current = r.mtime;
      setProjName(r.name);
      const opened = normalizeProject({ ...doc, name: r.name }, r.name);
      projectRef.current = opened;
      setProject(opened);
      setNewName('');
      setSaveState('saved');
      setSelection([]);
      clearStack();
    } catch (e) {
      setPickerErr(e?.message || String(e));
    }
  };

  const closeToPicker = async () => {
    await flush();
    const hashes = (projectRef.current?.media || []).map(m => m.proxyHash).filter(Boolean);
    if (hashes.length) api.invoke('vedit_remux_release', { hashes }).catch(() => {});
    projectRef.current = null;
    setProject(null);
    setProjName(null);
    mtimeRef.current = null;
    setMediaUrls(new Map());
    setMediaStatus(new Map());
    setImportErrors([]);
    setOverBudget(false);
    setSelectedId(null);
    setSelection([]);
    setBladeMode(false);
    clearStack();
  };

  const handleImport = async () => {
    if (!projectRef.current || importing) return;
    setImporting(true);
    try {
      const existing = new Set(projectRef.current.media.map(m => m.proxyHash));
      const { added, rejected } = await pickAndImport({
        api,
        existingHashes: existing,
        onProgress: ({ name, state }) =>
          setImportStatusText(state === 'done' ? '' : `${state} ${name}…`),
      });
      if (added.length) {
        setMediaUrls(prev => {
          const n = new Map(prev);
          for (const a of added) n.set(a.entry.id, a.url);
          return n;
        });
        setMediaStatus(prev => {
          const n = new Map(prev);
          for (const a of added) n.set(a.entry.id, 'ready');
          return n;
        });
        if (added.some(a => a.overBudget)) setOverBudget(true);
        updateProject(p => {
          // Match-first-media: the FIRST clip ever imported sets the sequence
          // while the inspector is untouched; later imports never re-adopt.
          const e0 = added[0].entry;
          const adopt = p.media.length === 0 && !p.sequence.touched && e0.width && e0.height;
          const sequence = adopt
            ? { ...p.sequence, width: e0.width, height: e0.height, fps: e0.fps || p.sequence.fps }
            : p.sequence;
          return { ...p, sequence, media: [...p.media, ...added.map(a => a.entry)] };
        });
        markDirty();
      }
      if (rejected.length) setImportErrors(rejected);
    } finally {
      setImporting(false);
      setImportStatusText('');
    }
  };

  // Project open: re-pin every media entry sequentially (cache hits return on
  // the first poll tick). A missing source or failed remux → offline badge —
  // project open NEVER hard-fails on missing media. A changed source mtime
  // remints the hash: refresh the entry (and its startTimeOffset) in place.
  useEffect(() => {
    if (!projName) return undefined;
    const doc = projectRef.current;
    if (!doc?.media?.length) return undefined;
    let cancelled = false;
    (async () => {
      for (const m of doc.media) {
        if (cancelled) return;
        setMediaStatus(prev => new Map(prev).set(m.id, 'remuxing'));
        try {
          const r = await api.invoke('vedit_remux_start', { path: m.src, audioTrack: 0 });
          if (cancelled) return;
          setMediaUrls(prev => new Map(prev).set(m.id, r.url));
          setMediaStatus(prev => new Map(prev).set(m.id, 'ready'));
          if (r.overBudget) setOverBudget(true);
          if (r.hash !== m.proxyHash) {
            updateProject(p => ({
              ...p,
              media: p.media.map(x => x.id === m.id
                ? { ...x, proxyHash: r.hash, startTimeOffset: r.startTimeOffset || 0 }
                : x),
            }));
            markDirty();
          }
        } catch {
          if (cancelled) return;
          setMediaStatus(prev => new Map(prev).set(m.id, 'offline'));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projName, api]);

  // Auto-select the first ready clip so the preview is never pointlessly idle.
  useEffect(() => {
    if (!project?.media?.length) return;
    if (selectedId && project.media.some(m => m.id === selectedId)) return;
    const firstReady = project.media.find(m => mediaUrls.get(m.id));
    if (firstReady) setSelectedId(firstReady.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, mediaUrls]);

  // Immediate trash + Restore toast — never a confirm modal (the action is
  // reversible; the 30-day purge window is bin-UI copy, not a dialog).
  const deleteProject = async (name) => {
    setPickerErr('');
    try {
      const r = await api.invoke('vedit_project_delete', { name });
      setBinToast({ binId: r.binId, name });
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setBinToast(null), 6000);
      refreshList();
    } catch (e) {
      setPickerErr(e?.message || String(e));
    }
  };

  const restoreProject = async () => {
    if (!binToast) return;
    try {
      const r = await api.invoke('recycle_bin_restore', { id: binToast.binId, conflict: null, renameTo: null });
      if (r.status === 'restored') {
        clearTimeout(toastTimer.current);
        setBinToast(null);
        refreshList();
      } else {
        setPickerErr(`Restore reported "${r.status}" — use the recycling bin to resolve it`);
      }
    } catch (e) {
      setPickerErr(e?.message || String(e));
    }
  };

  const setSequence = (patch) => {
    updateProject(p => ({ ...p, sequence: { ...p.sequence, ...patch, touched: true } }));
    markDirty();
  };

  // SF7/SF8: every timeline mutation is an editList op — { apply, invert }
  // pairs applied here AND pushed onto the in-memory undo stack (cap 200).
  // Op factories return null for no-ops, so geometry keys don't churn and no
  // save fires. All useCallback: identities feed Timeline's memoized LaneArea
  // (perf contract).
  const editCtx = useCallback(() => {
    const p = projectRef.current;
    return { seqFps: p?.sequence.fps || 30, mediaById: new Map((p?.media || []).map(m => [m.id, m])) };
  }, []);

  const showOpToast = useCallback((text) => {
    setOpToast(text);
    clearTimeout(opToastTimer.current);
    opToastTimer.current = setTimeout(() => setOpToast(null), 1800);
  }, []);

  // SF1b: DEV node-viability probe — confirm StereoPanner / DynamicsCompressor
  // / OfflineAudioContext run in this webview (Gain/Analyser already proven by
  // SF1a). The acompressor parity gap is measured by the SF8 harness.
  const runAudioProbe = useCallback(async () => {
    const { probeAudioNodes } = await import('./audio/probe.js');
    const r = await probeAudioNodes();
    console.info('[vedit-audio-probe]', r);
    showOpToast(r.ok
      ? `Audio probe OK — nodes run, peak R/L ${r.peakR}/${r.peakL}`
      : `Audio probe FAIL — ${r.error || 'NaN/silent output'}`);
  }, [showOpToast]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    requestAnimationFrame(() => {
      showOpToast(`route mount→paint ${(performance.now() - mountT0.current).toFixed(0)} ms`);
    });
  }, [showOpToast]);

  // Ops come in two shapes: tracks ops ({ apply, invert }) and document ops
  // ({ applyDoc, invertDoc } — e.g. master volume). The stack treats both
  // uniformly.
  const applyOp = useCallback((op) => {
    if (!op) return;
    updateProject(p => (op.applyDoc ? op.applyDoc(p) : { ...p, tracks: op.apply(p.tracks) }));
    markDirty();
    pushOp(op);
  }, [updateProject, markDirty, pushOp]);

  const doUndo = useCallback(() => {
    const op = popUndo();
    if (!op) return;
    updateProject(p => (op.invertDoc ? op.invertDoc(p) : { ...p, tracks: op.invert(p.tracks) }));
    markDirty();
    setSelection([]);
    showOpToast(`Undid: ${op.label}`);
  }, [popUndo, updateProject, markDirty, showOpToast]);

  const doRedo = useCallback(() => {
    const op = popRedo();
    if (!op) return;
    updateProject(p => (op.applyDoc ? op.applyDoc(p) : { ...p, tracks: op.apply(p.tracks) }));
    markDirty();
    setSelection([]);
    showOpToast(`Redid: ${op.label}`);
  }, [popRedo, updateProject, markDirty, showOpToast]);

  const moveClip = useCallback((clipId, fromIdx, toIdx, newStart) => {
    const p = projectRef.current;
    if (!p) return;
    applyOp(editOps.move(editCtx(), p.tracks, fromIdx, clipId, toIdx, newStart));
  }, [applyOp, editCtx]);

  const trimClip = useCallback((laneIdx, clipId, edge, value) => {
    const p = projectRef.current;
    if (!p) return;
    applyOp(edge === 'in'
      ? editOps.trimIn(editCtx(), p.tracks, laneIdx, clipId, value)
      : editOps.trimOut(editCtx(), p.tracks, laneIdx, clipId, value));
  }, [applyOp, editCtx]);

  const splitClip = useCallback((laneIdx, clipId, frame) => {
    const p = projectRef.current;
    if (!p) return;
    applyOp(editOps.splitAt(editCtx(), p.tracks, laneIdx, clipId, frame));
  }, [applyOp, editCtx]);

  // SF8 selection: shift-click on the anchor's lane selects the contiguous
  // start-range on that lane; shift-click elsewhere (or plain click)
  // re-anchors. Marquee deferred — no precedent in the app.
  const selectClip = useCallback((laneIdx, clipId, shiftKey) => {
    if (!clipId) { setSelection([]); return; }
    setSelection(prev => {
      const anchor = prev[0];
      if (shiftKey && anchor && anchor.laneIdx === laneIdx) {
        const clips = projectRef.current?.tracks[laneIdx]?.clips || [];
        const a = clips.find(c => c.id === anchor.clipId);
        const b = clips.find(c => c.id === clipId);
        if (a && b) {
          const lo = Math.min(a.start, b.start);
          const hi = Math.max(a.start, b.start);
          const range = clips.filter(c => c.start >= lo && c.start <= hi)
            .map(c => ({ laneIdx, clipId: c.id }));
          return [anchor, ...range.filter(r => r.clipId !== anchor.clipId)];
        }
      }
      return [{ laneIdx, clipId }];
    });
  }, []);

  // Deletes act on explicit targets so the menu can hit a clip that wasn't
  // selected yet (selection state lands async). Bottom-up (start DESC) so
  // ripple shifts can't disturb later targets; batched into ONE undo entry.
  const deleteClips = useCallback((targets, ripple) => {
    const p = projectRef.current;
    if (!p || !targets.length) return;
    const withStart = targets
      .map(s => ({ ...s, start: p.tracks[s.laneIdx]?.clips.find(c => c.id === s.clipId)?.start }))
      .filter(s => s.start != null)
      .sort((a, b) => b.start - a.start);
    const ops = [];
    let ts = p.tracks;
    for (const s of withStart) {
      const op = ripple ? editOps.rippleDelete(ts, s.laneIdx, s.clipId) : editOps.remove(ts, s.laneIdx, s.clipId);
      if (op) { ops.push(op); ts = op.apply(ts); }
    }
    const base = ripple ? 'Ripple delete' : 'Delete';
    applyOp(editOps.batch(withStart.length > 1 ? `${base} ×${withStart.length}` : base, ops));
    setSelection([]);
  }, [applyOp]);

  // Context menu via the host shell (NEVER the deprecated
  // components/ui/ContextMenu.jsx): blade-here at the right-clicked frame,
  // trim-to-playhead both edges (playhead frame from the Timeline ref — the
  // rVFC route is dead on this platform), ripple-delete, delete (danger),
  // shortcut labels. Right-click adopts an unselected clip as the target.
  // ── SF10: grade clipboard + preview bypass ──────────────────────────────
  // (declared ABOVE clipMenu — its dep array reads these at definition time,
  // and a later `const` is a TDZ ReferenceError that blanks the whole app.)
  // Clipboard sentinel: undefined = never copied, null = copied identity
  // (paste then RESETS targets), object = shared grade reference.
  const gradeClipboard = useRef(undefined);
  const [gradeBypass, setGradeBypass] = useState(false);
  const copyGradeFrom = useCallback((laneIdx, clipId) => {
    const clip = projectRef.current?.tracks[laneIdx]?.clips.find(c => c.id === clipId);
    if (!clip) return;
    gradeClipboard.current = clip.grade ?? null;
    showOpToast(clip.grade ? 'Grade copied' : 'Identity copied');
  }, [showOpToast]);
  const pasteGradeTo = useCallback((targets) => {
    if (gradeClipboard.current === undefined) {
      showOpToast('No grade copied');
      return;
    }
    applyOp(gradeOps.setClipsGrade(
      projectRef.current.tracks, targets, gradeClipboard.current ?? undefined, 'Paste grade',
    ));
  }, [applyOp, showOpToast]);
  const toggleBypass = useCallback(() => {
    setGradeBypass(b => {
      showOpToast(b ? 'Grades on' : 'Grades bypassed');
      return !b;
    });
  }, [showOpToast]);

  const clipMenu = useCallback((laneIdx, clipId, frame, e) => {
    const p = projectRef.current;
    const clip = p?.tracks[laneIdx]?.clips.find(c => c.id === clipId);
    if (!clip) return;
    setSelection(prev => (prev.some(s => s.clipId === clipId) ? prev : [{ laneIdx, clipId }]));
    const targets = selection.some(s => s.clipId === clipId) ? selection : [{ laneIdx, clipId }];
    const ph = Math.round(playheadFrameRef.current || 0);
    const inside = ph > clip.start && ph < clip.start + clip.dur;
    const name = p.media.find(m => m.id === clip.mediaId)?.src.split('/').pop() || 'Clip';
    openContextMenu(e, [
      { label: 'Blade here', onClick: () => splitClip(laneIdx, clipId, frame) },
      { label: 'Trim start to playhead', disabled: !inside, onClick: () => trimClip(laneIdx, clipId, 'in', ph) },
      { label: 'Trim end to playhead', disabled: !inside, onClick: () => trimClip(laneIdx, clipId, 'out', ph) },
      { sep: true },
      {
        label: clip.mute ? 'Unmute' : 'Mute',
        onClick: () => applyOp(editOps.setClipProps(p.tracks, laneIdx, clipId, { mute: !clip.mute }, clip.mute ? 'Unmute' : 'Mute')),
      },
      {
        label: 'Gain',
        children: GAIN_PRESETS.map(([lbl, g]) => ({
          label: lbl,
          onClick: () => applyOp(editOps.setClipProps(p.tracks, laneIdx, clipId, { gain: g }, 'Gain')),
        })),
      },
      { sep: true },
      { label: 'Copy grade', shortcut: 'Ctrl+Shift+C', onClick: () => copyGradeFrom(laneIdx, clipId) },
      {
        label: targets.length > 1 ? `Paste grade (${targets.length})` : 'Paste grade',
        shortcut: 'Ctrl+Shift+V',
        disabled: gradeClipboard.current === undefined,
        onClick: () => pasteGradeTo(targets),
      },
      { sep: true },
      { label: 'Ripple delete', shortcut: 'Shift+Del', onClick: () => deleteClips(targets, true) },
      { label: 'Delete', danger: true, shortcut: 'Del', onClick: () => deleteClips(targets, false) },
    ], { accent, header: name });
  }, [selection, openContextMenu, accent, splitClip, trimClip, deleteClips, applyOp, copyGradeFrom, pasteGradeTo]);

  // SF6: bin→timeline drop. Duration = full source length in SEQUENCE frames;
  // start frame-quantized + clamped into the nearest free gap.
  const insertClipFromBin = (laneIdx, frame, media) => {
    const p = projectRef.current;
    if (!p || !p.tracks[laneIdx]) return;
    const fps = p.sequence.fps || 30;
    const dur = Math.max(1, Math.round((media.duration || 1) * fps));
    const start = clampStartToGap(p.tracks[laneIdx].clips, Math.max(0, frame), dur, null);
    updateProject(pp => ({
      ...pp,
      tracks: pp.tracks.map((t, i) => i === laneIdx
        ? { ...t, clips: [...t.clips, { id: newId(), mediaId: media.id, start, dur, in: 0, gain: 1, mute: false }].sort((a, b) => a.start - b.start) }
        : t),
    }));
    markDirty();
  };

  // Add a title clip at the playhead on the topmost track that's free there (so
  // it composites over the video below); fall back to the top track's next gap.
  // The title carries default styling and is auto-selected to open the editor.
  const addTitle = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    const fps = p.sequence.fps || 30;
    const ph = Math.max(0, Math.round(playheadFrameRef.current || 0));
    const dur = Math.round(5 * fps);
    let laneIdx = p.tracks.length - 1;
    for (let i = p.tracks.length - 1; i >= 0; i--) {
      if (!p.tracks[i].clips.some(c => c.start <= ph && c.start + c.dur > ph)) { laneIdx = i; break; }
    }
    const start = clampStartToGap(p.tracks[laneIdx].clips, ph, dur, null);
    const op = editOps.insertTitle(p.tracks, laneIdx, start, dur, defaultTitle());
    if (!op) return;
    applyOp(op);
    setSelection([{ laneIdx, clipId: op.clipId }]);
  }, [applyOp]);

  // SF6: bin→timeline drag — the startPaneDrag pattern (PlannerProvider
  // :435-453) module-locally: pointer-based ghost chip (HTML5 DnD is dead on
  // WebKitGTK), drop hit-testing against [data-track-lane] rects on release;
  // frame math reads the scroller's data-ppf + scrollLeft so EditorPage
  // carries no timeline geometry of its own. The ghost moves via direct
  // style writes — never a per-move re-render of the whole page.
  const binGhostRef = useRef(null);
  const startBinDrag = (media, e) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    const ghost = binGhostRef.current;
    function move(ev) {
      if (!started) {
        if ((ev.clientX - sx) ** 2 + (ev.clientY - sy) ** 2 < 16) return;
        started = true;
        if (ghost) {
          ghost.textContent = (media.src || '').split('/').pop();
          ghost.style.display = 'block';
        }
        window.getSelection?.()?.removeAllRanges?.();
      }
      if (ghost) ghost.style.transform = `translate3d(${ev.clientX + 14}px, ${ev.clientY + 12}px, 0)`;
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (ghost) ghost.style.display = 'none';
      if (!started) return;
      for (const laneEl of document.querySelectorAll('[data-track-lane]')) {
        const r = laneEl.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom) {
          const scroller = laneEl.closest('[data-tl-scroll]');
          const ppf = Number(scroller?.dataset.ppf) || 2;
          const frame = Math.max(0, Math.round((ev.clientX - r.left + (scroller?.scrollLeft || 0)) / ppf));
          insertClipFromBin(Number(laneEl.dataset.trackLane), frame, media);
          break;
        }
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const selectedClipIds = useMemo(() => new Set(selection.map(s => s.clipId)), [selection]);

  // SF9: the flattened program — the ONE artifact driving both preview and
  // (later) export. Recomputed on every document change.
  // Deps are the slices flatten reads — NOT the whole project — so pure-mixer
  // ops (project.mixer) don't churn the flatten (Audio Post SF2). tracks/media
  // refs only change on edit ops, which is exactly when a re-flatten is due.
  const segments = useMemo(() => {
    if (!project) return [];
    const ctx = { seqFps: project.sequence.fps || 30, mediaById: new Map(project.media.map(m => [m.id, m])) };
    return editOps.flattenEditList(ctx, project.tracks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.tracks, project?.sequence?.fps, project?.media]);
  // Layer-stack regions for the multi-layer preview compositor (SF5) — same
  // tracks/media deps as segments; the engine still plays `segments` (topmost).
  const compositeRegions = useMemo(() => {
    if (!project) return [];
    const ctx = { seqFps: project.sequence.fps || 30, mediaById: new Map(project.media.map(m => [m.id, m])) };
    return editOps.flattenComposite(ctx, project.tracks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.tracks, project?.sequence?.fps, project?.media]);
  const urlFor = useCallback((id) => mediaUrls.get(id) || null, [mediaUrls]);

  // ── Color grading (SF7): grade commit + project-open LUT prefetch ──────
  const commitGrade = useCallback((laneIdx, clipId, grade, label) => {
    applyOp(gradeOps.setClipGrade(projectRef.current.tracks, laneIdx, clipId, grade, label));
  }, [applyOp]);


  // Prefetch every creative-LUT text the loaded project references so grades
  // compile with their LUT without per-clip awaits; a failed read marks the
  // file missing (OFFLINE badge) and the grade previews without that stage.
  const [lutEpoch, setLutEpoch] = useState(0);
  useEffect(() => {
    if (!project || !projName) return undefined;
    const files = new Set();
    for (const t of project.tracks) {
      for (const c of t.clips) if (c.grade?.lut?.file) files.add(c.grade.lut.file);
    }
    let cancelled = false;
    (async () => {
      for (const f of files) {
        if (lutState(f) !== 'pending') continue;
        try {
          const r = await api.invoke('vedit_lut_read', { name: projName, file: f });
          registerLutText(f, r.text);
        } catch {
          markLutMissing(f);
        }
        if (!cancelled) setLutEpoch((e) => e + 1);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projName]);

  // SF11 — full module keybind map (keybinds.js): transport (Space/K/L/J),
  // blade, frame/second stepping, Delete/ripple, Home/End, =/− zoom,
  // undo/redo, Ctrl+S. Route-scoped by construction (EditorPage mounts only
  // on the editor route; the only other Ctrl+Z lives inside PlannerModal — no
  // collision); installed only with a project open so the picker keeps
  // native key behavior (Space/Enter activate focused buttons there).
  useEffect(() => {
    if (!project) return undefined;
    const onKey = makeEditorKeydown({
      save: flush,
      undo: doUndo,
      redo: doRedo,
      toggle: () => playerRef.current?.toggle(),
      pause: () => playerRef.current?.pause(),
      rateUp: () => playerRef.current?.cycleRate(),
      jumpBy: (s) => playerRef.current?.jumpBy(s),
      step: (d) => playerRef.current?.step(d),
      home: () => playerRef.current?.seekTo(0),
      end: () => { const t = segments[segments.length - 1]?.t1 || 0; playerRef.current?.seekTo(t); },
      blade: () => setBladeMode(b => !b),
      del: (ripple) => { if (selection.length) deleteClips(selection, ripple); },
      zoom: (dir) => timelineRef.current?.zoomBy(dir > 0 ? 1.2 : 1 / 1.2),
      colorMode: () => api.router.navigate(mode === 'color' ? '/tools/video-editor' : '/tools/video-editor/color'),
      gradeBypass: toggleBypass,
      copyGrade: () => { const s = selection[0]; if (s) copyGradeFrom(s.laneIdx, s.clipId); },
      pasteGrade: () => { if (selection.length) pasteGradeTo(selection); },
    });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, segments, selection, deleteClips, doUndo, doRedo, flush, mode, api, toggleBypass, copyGradeFrom, pasteGradeTo]);

  // Completion toast with Reveal — fires even if the dialog was closed
  // mid-render (the job lives in Rust).
  useEffect(() => {
    const p = listen('vedit-export-done', (e) => {
      if (e.payload?.state === 'done' && e.payload.outputPath) {
        setExportToast({ path: e.payload.outputPath });
        clearTimeout(exportToastTimer.current);
        exportToastTimer.current = setTimeout(() => setExportToast(null), 8000);
      }
    });
    return () => p.then(un => un());
  }, []);

  const saveLabel = {
    saved: 'saved',
    dirty: 'unsaved…',
    conflict: 'conflict — changed on disk',
    error: 'save failed',
  }[saveState];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {project && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '8px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{project.name}</div>
          <NumField label="W" value={project.sequence.width} min={16} max={8192} onCommit={v => setSequence({ width: v })} />
          <NumField label="H" value={project.sequence.height} min={16} max={8192} onCommit={v => setSequence({ height: v })} />
          <NumField label="FPS" value={project.sequence.fps} min={1} max={240} float width={72} onCommit={v => setSequence({ fps: v })} />
          <OutlinedBtn small accent={accent} onClick={addTitle}>+ Title</OutlinedBtn>
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => setParityOpen(true)}
              style={{
                ...mono,
                fontSize: 10.5,
                padding: '3px 8px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-faint)',
                cursor: 'pointer',
              }}
            >
              PARITY
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={runAudioProbe}
              style={{
                ...mono,
                fontSize: 10.5,
                padding: '3px 8px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-faint)',
                cursor: 'pointer',
              }}
            >
              AUDIO PROBE
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => setAudioParityOpen(true)}
              style={{
                ...mono,
                fontSize: 10.5,
                padding: '3px 8px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-faint)',
                cursor: 'pointer',
              }}
            >
              AUDIO PARITY
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => setCompParityOpen(true)}
              style={{
                ...mono,
                fontSize: 10.5,
                padding: '3px 8px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-faint)',
                cursor: 'pointer',
              }}
            >
              COMP PARITY
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={() => setEncodeSmokeOpen(true)}
              style={{
                ...mono,
                fontSize: 10.5,
                padding: '3px 8px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text-faint)',
                cursor: 'pointer',
              }}
            >
              ENC SMOKE
            </button>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ ...mono, fontSize: 11.5, color: saveState === 'conflict' || saveState === 'error' ? 'var(--error)' : 'var(--text-faint)' }}>
            {saveLabel}
          </div>
          <div className="candy-center-row" style={{ gap: 8 }}>
            <PrimaryBtn small accent={accent} onClick={() => setExportOpen(true)} disabled={segments.length === 0}>
              Export
            </PrimaryBtn>
            <OutlinedBtn small onClick={closeToPicker}>Projects</OutlinedBtn>
          </div>
        </div>
      )}

      {project && selection.length === 1 && (() => {
        const s = selection[0];
        const c = project.tracks[s.laneIdx]?.clips.find(x => x.id === s.clipId);
        if (!c) return null;
        return (
          <Inspector
            clip={c}
            laneIdx={s.laneIdx}
            accent={accent}
            playheadFrameRef={playheadFrameRef}
            seekToFrame={(f) => playerRef.current?.seekTo(f / (project.sequence.fps || 30))}
            applyOp={applyOp}
            projectRef={projectRef}
          />
        );
      })()}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <aside style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          {project ? (
            <BinPanel
              media={project.media}
              status={mediaStatus}
              urls={mediaUrls}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onImport={handleImport}
              importing={importing}
              statusText={importStatusText}
              errors={importErrors}
              onDismissErrors={() => setImportErrors([])}
              overBudget={overBudget}
              accent={accent}
              onDragToTimeline={startBinDrag}
            />
          ) : (
            <div style={paneLabel}>Bin</div>
          )}
        </aside>
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {project ? (
            <PreviewPlayer
              url={selectedId ? mediaUrls.get(selectedId) || null : null}
              fps={project.media.find(m => m.id === selectedId)?.fps || project.sequence.fps}
              accent={accent}
              segments={segments}
              compositeRegions={compositeRegions}
              urlFor={urlFor}
              seqFps={project.sequence.fps || 30}
              seqW={project.sequence.width}
              seqH={project.sequence.height}
              selectedClipId={selection.length === 1 ? selection[0].clipId : null}
              onSetTransform={(trackId, clipId, tr) => {
                const laneIdx = projectRef.current.tracks.findIndex(t => t.id === trackId);
                if (laneIdx >= 0) applyOp(editOps.setClipTransform(projectRef.current.tracks, laneIdx, clipId, tr));
              }}
              masterVolume={project.masterVolume ?? 1}
              onMasterVolume={(v) => applyOp(editOps.setMasterVolume(projectRef.current, v))}
              onPlayheadTime={(t) => { playheadFrameRef.current = t * (projectRef.current?.sequence.fps || 30); }}
              controlsRef={playerRef}
              gradeBypass={gradeBypass}
              mixer={project.mixer}
              audioRef={audioRef}
            />
          ) : (
            <div style={paneLabel}>Preview</div>
          )}
        </main>
      </div>
      <footer style={{ height: mode === 'color' ? 320 : mode === 'mix' ? 300 : 240, flexShrink: 0, borderTop: '1px solid var(--border)', minHeight: 0 }}>
        {project ? (
          mode === 'color' ? (
            <ColorSuite
              project={project}
              selection={selection}
              playheadFrameRef={playheadFrameRef}
              accent={accent}
              api={api}
              projName={projName}
              lutEpoch={lutEpoch}
              onSelectClip={(laneIdx, clipId) => selectClip(laneIdx, clipId, false)}
              onSeekFrame={(f) => playerRef.current?.seekTo(f / (project.sequence.fps || 30))}
              onCommitGrade={commitGrade}
              onNotice={showOpToast}
              bypass={gradeBypass}
              onToggleBypass={toggleBypass}
            />
          ) : mode === 'mix' ? (
            <MixSuite
              project={project}
              accent={accent}
              masterVolume={project.masterVolume ?? 1}
              audioRef={audioRef}
              onTrackMix={(trackId, patch, label) => applyOp(editOps.setTrackMix(projectRef.current, trackId, patch, label))}
              onMasterMix={(patch, label) => applyOp(editOps.setMasterMix(projectRef.current, patch, label))}
              onMasterVolume={(v) => applyOp(editOps.setMasterVolume(projectRef.current, v))}
              playheadFrameRef={playheadFrameRef}
              onTrackVolumeKeyframe={(trackId, frame, value) => applyOp(editOps.setTrackVolumeKeyframe(projectRef.current, trackId, frame, value))}
              onTrackVolumeDisarm={(trackId, frame) => applyOp(editOps.disarmTrackVolume(projectRef.current, trackId, frame))}
            />
          ) : (
            <Timeline
              project={project}
              accent={accent}
              onMoveClip={moveClip}
              updateProject={updateProject}
              markDirty={markDirty}
              selectedClipIds={selectedClipIds}
              onSelectClip={selectClip}
              bladeMode={bladeMode}
              onToggleBlade={() => setBladeMode(b => !b)}
              onSplitClip={splitClip}
              onTrimClip={trimClip}
              onClipMenu={clipMenu}
              playheadFrameRef={playheadFrameRef}
              timelineRef={timelineRef}
              onScrub={(f) => playerRef.current?.seekTo(f / (project.sequence.fps || 30))}
            />
          )
        ) : (
          <div style={paneLabel}>{mode === 'color' ? 'Color' : mode === 'mix' ? 'Mix' : 'Timeline'}</div>
        )}
      </footer>

      <AppWindow
        open={!project}
        onClose={() => { if (window.history.length > 1) window.history.back(); else api.router.navigate('/vault'); }}
        escToClose={false}
        closeOnBackdrop={false}
        title="Projects"
        icon={<IconClapperboard />}
        accent={accent}
        width={560}
        height="min(520px, 80vh)"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createProject(); }}
              placeholder="Project name"
              spellCheck={false}
              style={{ flex: 1, fontSize: 13, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px' }}
            />
            <PrimaryBtn small accent={accent} onClick={createProject} disabled={!newName.trim()}>New Project</PrimaryBtn>
          </div>
          {pickerErr && <div style={{ ...mono, fontSize: 12, color: 'var(--error)' }}>{pickerErr}</div>}
          {projects.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No projects yet — name one above and hit New Project.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {projects.map(p => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    className="candy-btn"
                    data-shape="row"
                    data-own-press
                    onClick={() => openProject(p.name)}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    <span className="candy-face" style={{ width: '100%', justifyContent: 'space-between', padding: '0 12px', fontSize: 13 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)', flexShrink: 0 }}>
                        {new Date(p.mtime).toLocaleString()}
                      </span>
                    </span>
                  </button>
                  <IconBtn title="Move to recycling bin" size={30} onClick={() => deleteProject(p.name)}>
                    <IconTrash size={15} />
                  </IconBtn>
                </div>
              ))}
            </div>
          )}
        </div>
      </AppWindow>

      <div
        ref={binGhostRef}
        style={{ position: 'fixed', left: 0, top: 0, display: 'none', zIndex: 1300, pointerEvents: 'none', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text)', boxShadow: '0 6px 18px rgba(0,0,0,0.35)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      />

      {binToast && (
        <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 1100 }}>
          <Toast
            accent={accent || 'var(--accent)'}
            glyph={<IconTrash size={13} />}
            title="Moved to the recycling bin"
            message={`${binToast.name} — restorable for 30 days`}
            actions={<PrimaryBtn small accent={accent} onClick={restoreProject}>Restore</PrimaryBtn>}
          />
        </div>
      )}

      {opToast && (
        <div style={{ position: 'fixed', left: 18, bottom: 18, zIndex: 1100 }}>
          <Toast accent={accent || 'var(--accent)'} title={opToast} />
        </div>
      )}

      {project && (
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          api={api}
          accent={accent}
          project={project}
          regions={compositeRegions}
          mediaStatus={mediaStatus}
        />
      )}

      {import.meta.env.DEV && audioParityOpen && (
        <AudioParityPanel onClose={() => setAudioParityOpen(false)} api={api} accent={accent} />
      )}
      {import.meta.env.DEV && parityOpen && (
        <ParityPanel onClose={() => setParityOpen(false)} api={api} accent={accent} />
      )}
      {import.meta.env.DEV && compParityOpen && (
        <CompositeParityPanel onClose={() => setCompParityOpen(false)} api={api} accent={accent} />
      )}
      {import.meta.env.DEV && encodeSmokeOpen && (
        <EncodeSmokePanel onClose={() => setEncodeSmokeOpen(false)} api={api} accent={accent} />
      )}

      {exportToast && (
        <div style={{ position: 'fixed', right: 18, bottom: 84, zIndex: 1100 }}>
          <Toast
            accent={accent || 'var(--accent)'}
            glyph={<IconClapperboard size={13} />}
            title="Render complete"
            message={exportToast.path.split('/').pop()}
            actions={(
              <PrimaryBtn small accent={accent} onClick={() => api.invoke('reveal_in_files', { path: exportToast.path }).catch(() => {})}>
                Reveal
              </PrimaryBtn>
            )}
          />
        </div>
      )}
    </div>
  );
}
