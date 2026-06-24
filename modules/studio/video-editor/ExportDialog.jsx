// Export dialog (SF10) — AppWindow shell (its inline fadeIn satisfies the
// animation-gate rule). Decided copy: title **Export**, primary CTA
// **Render**. Closable mid-render: the job lives in Rust and this dialog
// re-syncs from vedit_export_status on every open, so navigation can't
// orphan it. The GTK save dialog itself confirms overwrites (native
// behavior); offline media blocks Render with a reason. Creative checkpoint
// for the completion moment WAIVED 2026-06-10 (core first) — completion is
// a plain done-row here + a host toast with Reveal in EditorPage.

import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { IconClapperboard } from '@host/components/icons.jsx';
import { getLutFor } from './color/gradePipeline.js';
import { serializeCube } from './color/gradeLut.js';
import { resolveColorimetry } from './color/colorimetry.js';
import { layerExports, trackVolumeExpr } from './keyframes/kfExpr.js';
import { drawTitle } from './drawTitle.js';

const mono = { fontFamily: '"DM Mono", monospace' };

const fmtEta = (s) => {
  if (s == null || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.max(0, s % 60)).padStart(2, '0')}`;
};

export default function ExportDialog({ open, onClose, api, accent, project, regions = [], mediaStatus }) {
  const [outPath, setOutPath] = useState('');
  const [status, setStatus] = useState(null); // ExportStatus straight from Rust
  const [err, setErr] = useState('');

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

  const running = status?.state === 'running';
  // Every layer across every region — offline detection must see underlays, not
  // just the topmost clip (flattenComposite carries the full stack).
  const usedIds = [...new Set(regions.flatMap(r => r.layers || []).map(l => l.mediaId).filter(Boolean))];
  const offline = usedIds.filter(id => ['offline', 'error'].includes(mediaStatus.get(id)));
  const empty = !regions.some(r => (r.layers || []).some(l => l.mediaId || l.kind === 'title'));

  const pick = async () => {
    setErr('');
    try {
      const p = await save({
        defaultPath: `${project.name}.mp4`,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      });
      if (p) setOutPath(p.endsWith('.mp4') ? p : `${p}.mp4`);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  };

  const render = async () => {
    setErr('');
    const mediaById = new Map(project.media.map(m => [m.id, m]));
    // Color Grading SF4: serialize each unique grade OBJECT once (split
    // halves share the reference, so they share one cube text) from the same
    // 8-bit-quantized lattice the preview texture uploads (f32q). Identity
    // grades compile to null → the segment takes the ungraded Phase 1 chain.
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
      // SF7: region/layer spatial composite. Each region carries its ordered
      // (bottom→top) layer stack; a gap is a region with no media layers. The
      // Rust identity fast-path keeps a no-transform export byte-identical, so
      // there is ONE JS path (no separate pre-compositing shape).
      regions: regions.map(r => ({
        dur: r.t1 - r.t0,
        layers: (r.layers || []).filter(l => l.mediaId || l.kind === 'title').map(l => {
          if (l.kind === 'title') {
            // SF11: rasterize the title via the SHARED drawTitle (sequence scale)
            // → base64 PNG; Rust loops it (-loop 1). Pos/rot/opacity keyframes
            // reuse layerExports unchanged. No audio, no grade.
            const canvas = drawTitle(l.title, 1);
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
          // SF9: lower ANIMATED keyframes to region-local ffmpeg exprs (Rust just
          // substitutes them); CONSTANT tracks bake into transform/gain here, so a
          // no-motion clip stays on the cheap SF7 literal path. r.t0F rebases time
          // to the region (inputs are -ss-trimmed + setpts).
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
            // source pixel dims → ffmpeg's fit must match computeLayerQuad's f.
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
      width: project.sequence.width,
      height: project.sequence.height,
      fps: project.sequence.fps,
      masterVolume: project.masterVolume ?? 1,
      outputPath: outPath,
      mixer: project.mixer ?? null,
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

  const pct = Math.round((status?.pct || 0) * 100);
  const speedTxt = status?.speed && status.speed > 0.01 ? `${status.speed.toFixed(2)}×` : '—';
  const baseName = (status?.outputPath || outPath || '').split('/').pop();

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ ...mono, flex: 1, minWidth: 0, fontSize: 12, color: outPath ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={outPath}>
            {outPath || 'No destination chosen'}
          </div>
          <OutlinedBtn small onClick={pick} disabled={running}>Choose…</OutlinedBtn>
        </div>

        {offline.length > 0 && (
          <div style={{ ...mono, fontSize: 11.5, color: 'var(--error)' }}>
            {offline.length} source clip{offline.length > 1 ? 's are' : ' is'} offline — restore the files to render.
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
            disabled={!outPath || empty || offline.length > 0 || running}
          >
            Render
          </PrimaryBtn>
        </div>
      </div>
    </AppWindow>
  );
}
