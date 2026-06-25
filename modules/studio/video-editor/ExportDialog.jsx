// Export dialog (SF10) — AppWindow shell (its inline fadeIn satisfies the
// animation-gate rule). Decided copy: title **Export**, primary CTA
// **Render**. Closable mid-render: the job lives in Rust and this dialog
// re-syncs from vedit_export_status on every open, so navigation can't
// orphan it. The native save dialog confirms overwrites; offline media blocks
// Render with a reason.
//
// Delivery & Presets (SF6–SF8): a preset selector (built-ins + user-saved +
// Custom) drives `spec.encode`; on open it probes encoder caps (vedit_encoder_
// probe, cached) to label/guard presets and populate the Custom encoder list;
// a remediation banner auto-falls-back to WebM when no H.264 encoder works (or
// disables Render when ffmpeg itself is missing). Source match sends no encode
// → the byte-identical Phase-1 path. Downscale presets set spec.width/height
// (the filtergraph composites at those dims) and rasterize titles at the same
// ratio so they stay proportioned.

import { useEffect, useMemo, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { IconClapperboard } from '@host/components/icons.jsx';
import { getLutFor } from './color/gradePipeline.js';
import { serializeCube } from './color/gradeLut.js';
import { resolveColorimetry } from './color/colorimetry.js';
import { layerExports, trackVolumeExpr } from './keyframes/kfExpr.js';
import { drawTitle } from './drawTitle.js';
import {
  BUILTIN_PRESETS, FALLBACK_PRESET_ID, CODECS, CONTAINER_LABELS, ENCODER_LABELS,
  presetAvailable, codecAvailable, availableEncodersFor, presetDims, presetExt,
  loadUserPresets, saveUserPreset, deleteUserPreset,
} from './presets.js';

const mono = { fontFamily: '"DM Mono", monospace' };

const fmtEta = (s) => {
  if (s == null || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.max(0, s % 60)).padStart(2, '0')}`;
};

// Swap a path's video extension to match the active container.
const withExt = (path, ext) =>
  path ? path.replace(/\.(mp4|webm)$/i, '') + '.' + ext : path;

// Build the EncodeSpec (camelCase → Rust serde) from the Custom config. Empty
// optional fields are omitted so Rust applies its defaults / auto-resolution.
const customEncode = (c) => ({
  container: c.container,
  codec: c.codec,
  ...(c.encoder ? { encoder: c.encoder } : {}),
  quality: Number(c.quality) || 65,
  ...(c.bitrateKbps ? { bitrateKbps: Number(c.bitrateKbps) } : {}),
  ...(c.audioBitrateKbps ? { audioBitrateKbps: Number(c.audioBitrateKbps) } : {}),
});

export default function ExportDialog({ open, onClose, api, accent, project, regions = [], mediaStatus }) {
  const [outPath, setOutPath] = useState('');
  const [status, setStatus] = useState(null); // ExportStatus straight from Rust
  const [err, setErr] = useState('');
  const [caps, setCaps] = useState(null); // EncoderCaps from vedit_encoder_probe
  const [probing, setProbing] = useState(false);
  const [presetId, setPresetId] = useState('source-mp4');
  const [userPresets, setUserPresets] = useState([]);
  const [custom, setCustom] = useState({
    container: 'mp4', codec: 'h264', encoder: '', quality: 65, bitrateKbps: '', audioBitrateKbps: '',
  });

  // Job status listener (unchanged Phase-1 behavior) — re-sync on every open.
  useEffect(() => {
    if (!open) return undefined;
    let dead = false;
    api.invoke('vedit_export_status', {})
      .then(s => {
        if (!dead && s) {
          setStatus(s);
          if (s.outputPath && s.state === 'running') setOutPath(s.outputPath);
        }
      })
      .catch(() => {});
    const p1 = listen('vedit-export-progress', e => { if (!dead) setStatus(e.payload); });
    const p2 = listen('vedit-export-done', e => { if (!dead) setStatus(e.payload); });
    return () => {
      dead = true;
      p1.then(un => un());
      p2.then(un => un());
    };
  }, [open, api]);

  // SF6/SF8: probe encoder caps + load user presets on open. Cached in Rust, so
  // this is cheap on repeat opens; the Re-probe control forces a refresh.
  const runProbe = (force) => {
    setProbing(true);
    return api.invoke('vedit_encoder_probe', { force: !!force })
      .then(c => { setCaps(c); return c; })
      .catch(() => { setCaps({ encoders: {}, ffmpegPath: '', ffmpegVersion: '' }); return null; })
      .finally(() => setProbing(false));
  };
  useEffect(() => {
    if (!open) return;
    setUserPresets(loadUserPresets(api));
    runProbe(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = status?.state === 'running';
  // Every layer across every region — offline detection must see underlays, not
  // just the topmost clip (flattenComposite carries the full stack).
  const usedIds = [...new Set(regions.flatMap(r => r.layers || []).map(l => l.mediaId).filter(Boolean))];
  const offline = usedIds.filter(id => ['offline', 'error'].includes(mediaStatus.get(id)));
  const empty = !regions.some(r => (r.layers || []).some(l => l.mediaId || l.kind === 'title'));

  const allPresets = useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets]);
  const activePreset = presetId === 'custom'
    ? { id: 'custom', name: 'Custom', container: custom.container, encode: customEncode(custom) }
    : (allPresets.find(p => p.id === presetId) || BUILTIN_PRESETS[0]);

  // ffmpeg present at all? (any encoder probed OK). Distinguishes "no H.264" from
  // "no ffmpeg" for the remediation banner (SF8).
  const ffmpegMissing = !!caps && !Object.values(caps.encoders || {}).some(Boolean);
  const h264Missing = !!caps && !codecAvailable('h264', caps);
  const activeUnavailable = !!caps && !presetAvailable(activePreset, caps);

  // SF8: when H.264 is unavailable (but ffmpeg works), auto-select the WebM
  // fallback once, so the default export still succeeds without H.264.
  useEffect(() => {
    if (h264Missing && !ffmpegMissing && presetId === 'source-mp4') {
      setPresetId(FALLBACK_PRESET_ID);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h264Missing, ffmpegMissing]);

  const ext = presetExt(activePreset);
  const finalPath = withExt(outPath, ext);

  const pick = async () => {
    setErr('');
    try {
      const p = await save({
        defaultPath: `${project.name}.${ext}`,
        filters: [{ name: `${CONTAINER_LABELS[activePreset.container] || ext.toUpperCase()} video`, extensions: [ext] }],
      });
      if (p) setOutPath(withExt(p.endsWith(`.${ext}`) ? p : `${p}.${ext}`, ext));
    } catch (e) {
      setErr(String(e?.message || e));
    }
  };

  const render = async () => {
    setErr('');
    const mediaById = new Map(project.media.map(m => [m.id, m]));
    const seqW = project.sequence.width;
    const seqH = project.sequence.height;
    const dims = presetDims(activePreset, seqW, seqH);
    // Titles author in sequence px (fit=1); rasterize at the export ratio so a
    // downscale keeps them proportioned (video layers auto-scale, frame-relative).
    const titleScale = seqH ? dims.height / seqH : 1;
    // Color Grading SF4: serialize each unique grade OBJECT once (split halves
    // share the reference) from the same 8-bit-quantized lattice the preview
    // uploads. Identity grades compile to null → the ungraded Phase-1 chain.
    const cubeByGrade = new Map();
    const cubeFor = (grade) => {
      if (!grade) return null;
      if (!cubeByGrade.has(grade)) {
        const e = getLutFor(grade);
        cubeByGrade.set(grade, e ? serializeCube(e.f32q) : null);
      }
      return cubeByGrade.get(grade);
    };
    const spec = {
      regions: regions.map(r => ({
        dur: r.t1 - r.t0,
        layers: (r.layers || []).filter(l => l.mediaId || l.kind === 'title').map(l => {
          if (l.kind === 'title') {
            const canvas = drawTitle(l.title, titleScale);
            const le = layerExports(l.kf, r.t0F, project.sequence.fps, l.transform, 0);
            return {
              src: null, srcIn: 0, dur: r.t1 - r.t0, gain: 0, hasAudio: false, startTimeOffset: 0,
              srcW: canvas.width, srcH: canvas.height,
              transform: (le.transform && Object.keys(le.transform).length) ? le.transform : null,
              lut: null, colorMatrix: null, colorRange: null, trackId: null,
              kf: le.exprs ? { ...le.exprs } : null,
              titlePng: canvas.toDataURL('image/png').split(',')[1],
            };
          }
          const m = mediaById.get(l.mediaId);
          const lut = cubeFor(l.grade);
          const cm = lut ? resolveColorimetry(m) : null;
          const le = layerExports(l.kf, r.t0F, project.sequence.fps, l.transform, l.gain);
          const tvExpr = trackVolumeExpr(project.mixer?.tracks?.[l.trackId]?.kf, r.t0F, project.sequence.fps);
          const kf = (le.exprs || tvExpr)
            ? { ...(le.exprs || {}), ...(tvExpr ? { trackVol: tvExpr } : {}) }
            : null;
          return {
            src: m.src,
            srcIn: l.srcIn,
            dur: r.t1 - r.t0,
            gain: le.gain,
            hasAudio: m.hasAudio !== false,
            startTimeOffset: m.startTimeOffset || 0,
            srcW: m.width || 0,
            srcH: m.height || 0,
            transform: (le.transform && Object.keys(le.transform).length) ? le.transform : null,
            lut,
            colorMatrix: cm ? cm.matrix : null,
            colorRange: cm ? cm.range : null,
            trackId: l.trackId ?? null,
            kf,
          };
        }),
      })),
      width: dims.width,
      height: dims.height,
      fps: project.sequence.fps,
      masterVolume: project.masterVolume ?? 1,
      outputPath: finalPath,
      mixer: project.mixer ?? null,
      // Source match (encode: null) → omit → byte-identical Phase-1 path.
      ...(activePreset.encode ? { encode: activePreset.encode } : {}),
    };
    try {
      await api.invoke('vedit_export_start', { spec });
    } catch (e) {
      setErr(String(e?.message || e));
    }
  };

  const cancel = () => api.invoke('vedit_export_cancel', {}).catch(() => {});
  const reveal = () => {
    if (status?.outputPath) api.invoke('reveal_in_files', { path: status.outputPath }).catch(() => {});
  };

  // ── Preset selector options + Custom-panel handlers ─────────────────────────
  const presetOptions = [
    ...allPresets.map(p => ({
      value: p.id,
      label: caps && !presetAvailable(p, caps) ? `${p.name} — no encoder` : p.name,
    })),
    { value: 'custom', label: 'Custom…' },
  ];
  const codecMeta = CODECS.find(c => c.value === custom.codec) || CODECS[0];
  const containerOpts = codecMeta.containers.map(c => ({ value: c, label: CONTAINER_LABELS[c] }));
  const encoderOpts = [
    { value: '', label: 'Auto — best available' },
    ...availableEncodersFor(custom.codec, caps).map(e => ({ value: e, label: ENCODER_LABELS[e] || e })),
  ];
  const setCustomCodec = (codec) => {
    const meta = CODECS.find(c => c.value === codec) || CODECS[0];
    const container = meta.containers.includes(custom.container) ? custom.container : meta.containers[0];
    setCustom({ ...custom, codec, container, encoder: '' });
  };

  const saveCurrentAsPreset = () => {
    const name = (typeof window !== 'undefined' && window.prompt) ? window.prompt('Preset name', 'My preset') : null;
    if (!name) return;
    const id = 'user-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + (userPresets.length + 1);
    const preset = { id, name, container: custom.container, encode: customEncode(custom), user: true };
    setUserPresets(saveUserPreset(api, preset));
    setPresetId(id);
  };
  const deleteActiveUserPreset = () => {
    setUserPresets(deleteUserPreset(api, presetId));
    setPresetId('source-mp4');
  };
  const activeIsUser = !!userPresets.find(p => p.id === presetId);

  const pct = Math.round((status?.pct || 0) * 100);
  const speedTxt = status?.speed && status.speed > 0.01 ? `${status.speed.toFixed(2)}×` : '—';
  const baseName = (status?.outputPath || finalPath || '').split(/[\\/]/).pop();
  const lbl = { ...mono, fontSize: 11, color: 'var(--text-faint)', minWidth: 64 };
  const rowGap = { display: 'flex', alignItems: 'center', gap: 8 };

  return (
    <AppWindow
      open={open}
      onClose={onClose}
      title="Export"
      icon={<IconClapperboard />}
      accent={accent}
      width={520}
      height="auto"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* SF8: remediation banner — proactive, before any render attempt. */}
        {ffmpegMissing && (
          <div style={{ ...mono, fontSize: 11.5, color: 'var(--error)', border: '1px solid color-mix(in oklch, var(--error) 33%, transparent)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>
            <b>ffmpeg not found.</b> Install it and reopen — e.g. <span style={{ color: 'var(--text)' }}>winget install Gyan.FFmpeg</span> — or place ffmpeg.exe on PATH. <button type="button" onClick={() => runProbe(true)} className="candy-btn" data-shape="row" style={{ marginLeft: 4 }}><span className="candy-face">Re-probe</span></button>
          </div>
        )}
        {!ffmpegMissing && h264Missing && (
          <div style={{ ...mono, fontSize: 11.5, color: 'var(--text)', border: '1px solid color-mix(in oklch, var(--accent, #888) 33%, transparent)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5, '--accent': accent }}>
            No working <b>H.264</b> encoder — switched to <b>VP9 / WebM</b>. For H.264, update your GPU driver or install an ffmpeg with libx264.
          </div>
        )}

        {/* SF6: preset + (when Custom) encode controls. */}
        <div style={rowGap}>
          <span style={lbl}>Preset</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <CandySelect
              value={presetId}
              options={presetOptions}
              onChange={setPresetId}
              title="Export preset"
              disabled={running}
            />
          </div>
          {activeIsUser && (
            <OutlinedBtn small onClick={deleteActiveUserPreset} disabled={running}>Delete</OutlinedBtn>
          )}
        </div>

        {presetId === 'custom' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 4, borderLeft: `2px solid color-mix(in oklch, ${accent} 40%, transparent)`, marginLeft: 2 }}>
            <div style={rowGap}>
              <span style={lbl}>Codec</span>
              <div style={{ flex: 1 }}>
                <CandySelect value={custom.codec} options={CODECS.map(c => ({ value: c.value, label: c.label }))} onChange={setCustomCodec} title="Codec" disabled={running} compact />
              </div>
              <span style={lbl}>Container</span>
              <div style={{ flex: 1 }}>
                <CandySelect value={custom.container} options={containerOpts} onChange={(v) => setCustom({ ...custom, container: v })} title="Container" disabled={running || containerOpts.length < 2} compact />
              </div>
            </div>
            <div style={rowGap}>
              <span style={lbl}>Encoder</span>
              <div style={{ flex: 1 }}>
                <CandySelect value={custom.encoder} options={encoderOpts} onChange={(v) => setCustom({ ...custom, encoder: v })} title="Encoder (Auto resolves the best available)" disabled={running} compact />
              </div>
            </div>
            <div style={rowGap}>
              <span style={lbl}>Quality</span>
              <input
                type="range" min={0} max={100} step={1}
                value={custom.quality}
                onChange={(e) => setCustom({ ...custom, quality: Number(e.target.value) })}
                disabled={running || !!custom.bitrateKbps}
                style={{ flex: 1, accentColor: accent }}
              />
              <span style={{ ...mono, fontSize: 12, color: 'var(--text)', minWidth: 28, textAlign: 'right' }}>{custom.quality}</span>
            </div>
            <div style={rowGap}>
              <span style={lbl}>Bitrate</span>
              <input
                type="number" min={0} placeholder="auto (quality)"
                value={custom.bitrateKbps}
                onChange={(e) => setCustom({ ...custom, bitrateKbps: e.target.value })}
                disabled={running}
                style={{ flex: 1, ...mono, fontSize: 12, background: 'var(--bg-soft, #1a1a1a)', color: 'var(--text)', border: '1px solid var(--border, #333)', borderRadius: 6, padding: '4px 8px' }}
              />
              <span style={{ ...mono, fontSize: 11, color: 'var(--text-faint)' }}>kbps</span>
              <span style={lbl}>Audio</span>
              <input
                type="number" min={0} placeholder="192"
                value={custom.audioBitrateKbps}
                onChange={(e) => setCustom({ ...custom, audioBitrateKbps: e.target.value })}
                disabled={running}
                style={{ width: 70, ...mono, fontSize: 12, background: 'var(--bg-soft, #1a1a1a)', color: 'var(--text)', border: '1px solid var(--border, #333)', borderRadius: 6, padding: '4px 8px' }}
              />
              <span style={{ ...mono, fontSize: 11, color: 'var(--text-faint)' }}>kbps</span>
            </div>
            <div>
              <OutlinedBtn small onClick={saveCurrentAsPreset} disabled={running}>Save as preset…</OutlinedBtn>
            </div>
          </div>
        )}

        <div style={rowGap}>
          <div style={{ ...mono, flex: 1, minWidth: 0, fontSize: 12, color: outPath ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={finalPath}>
            {finalPath || 'No destination chosen'}
          </div>
          <OutlinedBtn small onClick={pick} disabled={running}>Choose…</OutlinedBtn>
        </div>

        {offline.length > 0 && (
          <div style={{ ...mono, fontSize: 11.5, color: 'var(--error)' }}>
            {offline.length} source clip{offline.length > 1 ? 's are' : ' is'} offline — restore the files to render.
          </div>
        )}
        {activeUnavailable && !ffmpegMissing && (
          <div style={{ ...mono, fontSize: 11.5, color: 'var(--error)' }}>
            No available encoder for this preset on this machine — pick another or update drivers/ffmpeg.
          </div>
        )}
        {err && <div style={{ ...mono, fontSize: 11.5, color: 'var(--error)' }}>{err}</div>}

        {running && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="candy-groove" style={{ height: 6, '--accent': accent }}>
              <div className="candy-groove__fill" style={{ width: `${pct}%` }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ ...mono, fontSize: 12, color: 'var(--text)' }}>{pct}%</span>
              <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>{speedTxt}</span>
              <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>ETA {fmtEta(status?.etaSecs)}</span>
              <div style={{ flex: 1 }} />
              <OutlinedBtn small onClick={cancel}>Cancel</OutlinedBtn>
            </div>
          </div>
        )}

        {status?.state === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text)' }}>Rendered <b>{baseName}</b></span>
            <div style={{ flex: 1 }} />
            <PrimaryBtn small accent={accent} onClick={reveal}>Reveal</PrimaryBtn>
          </div>
        )}

        {status?.state === 'cancelled' && (
          <div style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>
            Export cancelled — no file was written.
          </div>
        )}

        {status?.state === 'error' && (
          <div style={{ ...mono, fontSize: 11, color: 'var(--error)', whiteSpace: 'pre-wrap', maxHeight: 140, overflowY: 'auto', border: '1px solid color-mix(in oklch, var(--error) 33%, transparent)', borderRadius: 8, padding: '8px 10px' }}>
            {status.error || 'Export failed.'}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <PrimaryBtn
            accent={accent}
            onClick={render}
            disabled={!outPath || empty || offline.length > 0 || running || probing || ffmpegMissing || activeUnavailable}
          >
            Render
          </PrimaryBtn>
        </div>
      </div>
    </AppWindow>
  );
}
