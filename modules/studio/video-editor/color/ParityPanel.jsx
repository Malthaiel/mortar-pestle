// ParityPanel — the Color Grading tech-bet STOP gate (SF5), DEV-only. For
// each fixture × grade cell it renders the SAME frame through BOTH pipelines
// and scores per-channel |Δ| (8-bit):
//   JS side    WebKit decode → texImage2D → FS_PASS / FS_LUT → readPixels at
//              native res (the live preview path, byte for byte).
//   Rust side  vedit_parity_render: ffmpeg -ss → scale=in_color_matrix=…
//              [,format=gbrp,lut3d=interp=trilinear] → rgb24 PNG (the export
//              color pipeline, no geometric scale).
// A cell passes when every channel holds mean ≤ PARITY_MEAN_MAX and p99 ≤
// PARITY_P99_MAX — thresholds sized for the chroma-upsample noise floor the
// two decoders legitimately disagree on. "Demo failure" deliberately
// mis-pins the matrix (bt601 fixture rendered as bt709) so the battery
// demonstrably CAN fail: red numbers + diff heatmap.
//
// Frame addressing: the <video> shows frame n at (n+0.5)/fps; ffmpeg's -ss
// emits the first frame with pts ≥ target, so the Rust side gets
// (n−0.25)/fps (+ startTimeOffset) — both deterministically frame n.
// Fixtures come from scripts/spike/make-parity-fixtures.sh; the untagged-HD
// cell proves the shared bt709 heuristic (wrong-but-consistent is a PASS by
// design — decision 8).

import React, { useEffect, useRef, useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { IconClapperboard } from '@host/components/icons.jsx';
import { createGlDisplay } from './glDisplay.js';
import { parseCube, compileGrade, toRGBA8, serializeCube, LUT_N } from './gradeLut.js';
import { resolveColorimetry } from './colorimetry.js';

const mono = { fontFamily: 'var(--font-mono), monospace' };

// Documented tunable consts (locked decision 5). Floor measured 2026-06-11 on
// the static chart (clean untagged cells): identity G-mean 2.19, s-curve G p99
// 7 — GPU-vs-swscale chroma upsampling on saturated gradients, amplified by
// steep grade slopes. Real errors stay loud: a matrix mis-pin measures mean
// ~8+ / p99 13+. Max is deliberately unthresholded (isolated band-edge pixels).
export const PARITY_MEAN_MAX = 2.5;
export const PARITY_P99_MAX = 8;

const FRAME_IDX = 45; // sampled frame; fixtures run 6 s @ 30 fps

const FIXTURES = [
  { key: 'bt709-1080', path: '/tmp/parity-bt709-1080.mp4' },
  { key: 'bt601-sd', path: '/tmp/parity-bt601-sd.mp4' },
  { key: 'untagged-1080', path: '/tmp/parity-untagged-1080.mp4' },
];

const S_CURVE = [[0, 0], [0.25, 0.18], [0.75, 0.85], [1, 1]];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Synthetic teal–orange creative cube (17³) so the lut cells exercise a real
// parsed .cube without shipping a binary fixture.
function synthCube(n = 17) {
  const lines = ['TITLE "parity synthetic"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const rf = r / (n - 1);
        const gf = g / (n - 1);
        const bf = b / (n - 1);
        const y = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf;
        const t = y * 1.15 - 0.05;
        lines.push([
          clamp01(rf + (t - 0.5) * 0.18).toFixed(6),
          clamp01(gf + (t - 0.5) * 0.05).toFixed(6),
          clamp01(bf - (t - 0.5) * 0.18).toFixed(6),
        ].join(' '));
      }
    }
  }
  return lines.join('\n') + '\n';
}

const SYNTH_CUBE = synthCube();

const base = {
  v: 1, temp: 0, tint: 0, lift: [0, 0, 0], gamma: [0, 0, 0], gain: [1, 1, 1],
  sat: 1, curves: null, hueSat: null, lut: null,
};

// The six battery grades (plan: identity / warm / S-curve+sat / hue-skew /
// LUT@0.7 / everything-on). "warm" mirrors the SF3 TEST_GRADE values.
const GRADES = [
  { key: 'identity', grade: null },
  {
    key: 'warm',
    grade: { ...base, temp: 0.5, lift: [0.03, 0, -0.03], gamma: [0.15, 0.05, -0.05], gain: [1.05, 1, 0.92], sat: 1.25 },
  },
  {
    key: 's-curve+sat',
    grade: { ...base, sat: 1.6, curves: { m: S_CURVE, r: null, g: null, b: null } },
  },
  {
    key: 'hue-skew',
    grade: { ...base, hueSat: [[0, 1], [0.17, 1.5], [0.5, 0.55], [0.83, 1.3]] },
  },
  {
    key: 'lut@0.7',
    grade: { ...base, lut: { file: 'synthetic', name: 'parity-teal-orange', intensity: 0.7 } },
    cube: SYNTH_CUBE,
  },
  {
    key: 'everything',
    grade: {
      ...base, temp: 0.3, tint: -0.1, lift: [0.02, 0, -0.02], gamma: [0.1, 0, -0.1],
      gain: [1.04, 1, 0.95], sat: 1.3,
      curves: { m: S_CURVE, r: [[0, 0.03], [1, 0.97]], g: null, b: null },
      hueSat: [[0, 1], [0.33, 1.4], [0.66, 0.7]],
      lut: { file: 'synthetic', name: 'parity-teal-orange', intensity: 0.5 },
    },
    cube: SYNTH_CUBE,
  },
];

// grade → { rgba8 (texImage3D upload), cube (text the export side reads) } —
// the same dequantize-from-rgba8 step gradePipeline uses, so both sides of
// every cell share one 8-bit lattice.
function compileEntry(grade, cubeText) {
  if (!grade) return null;
  const parsed = cubeText ? parseCube(cubeText) : null;
  const f32 = compileGrade(grade, parsed);
  const rgba8 = toRGBA8(f32);
  const f32q = new Float32Array(f32.length);
  for (let i = 0, j = 0; i < f32q.length; i += 3, j += 4) {
    f32q[i] = rgba8[j] / 255;
    f32q[i + 1] = rgba8[j + 1] / 255;
    f32q[i + 2] = rgba8[j + 2] / 255;
  }
  return { rgba8, cube: serializeCube(f32q) };
}

function decodePng(buf) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        res(ctx.getImageData(0, 0, c.width, c.height));
      } catch (e) {
        rej(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error('reference PNG decode failed'));
    };
    img.src = url;
  });
}

// glRGBA is bottom-up (readPixels), pngRGBA top-down — rows flipped here.
function diffMetrics(glRGBA, pngRGBA, w, h) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sum = [0, 0, 0];
  const max = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const gRow = (h - 1 - y) * w * 4;
    const pRow = y * w * 4;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(glRGBA[gRow + x * 4 + c] - pngRGBA[pRow + x * 4 + c]);
        sum[c] += d;
        hist[c][d]++;
        if (d > max[c]) max[c] = d;
      }
    }
  }
  const n = w * h;
  const p99 = hist.map((hh) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hh[v];
      if (acc >= n * 0.99) return v;
    }
    return 255;
  });
  const mean = sum.map((s) => s / n);
  const pass = mean.every((m) => m <= PARITY_MEAN_MAX) && p99.every((p) => p <= PARITY_P99_MAX);
  return { mean, p99, max, pass };
}

const loadVideo = (el, url) => new Promise((res, rej) => {
  const ok = () => { cleanup(); res(); };
  const err = () => { cleanup(); rej(new Error('fixture failed to load — run scripts/spike/make-parity-fixtures.sh')); };
  const cleanup = () => { el.removeEventListener('loadeddata', ok); el.removeEventListener('error', err); };
  el.addEventListener('loadeddata', ok);
  el.addEventListener('error', err);
  el.src = url;
  el.load();
});

const seekVideo = (el, t) => new Promise((res, rej) => {
  const ok = () => { cleanup(); requestAnimationFrame(() => res()); };
  const err = () => { cleanup(); rej(new Error('seek failed')); };
  const cleanup = () => { el.removeEventListener('seeked', ok); el.removeEventListener('error', err); };
  el.addEventListener('seeked', ok);
  el.addEventListener('error', err);
  el.currentTime = t;
});

const fmtCell = (r) => `m${Math.max(...r.mean).toFixed(2)} p${Math.max(...r.p99)}`;
const fmtLine = (key, r) =>
  `${key}: mean ${r.mean.map((m) => m.toFixed(2)).join('/')} p99 ${r.p99.join('/')} max ${r.max.join('/')} ${r.pass ? 'PASS' : 'FAIL'}`;

export default function ParityPanel({ onClose, api, accent }) {
  const [cells, setCells] = useState({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState('');
  const [detailKey, setDetailKey] = useState(null);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const dispRef = useRef(null);
  const cancelRef = useRef(false);
  const glCRef = useRef(null);
  const ffCRef = useRef(null);
  const heatCRef = useRef(null);

  useEffect(() => () => {
    cancelRef.current = true;
    if (dispRef.current) {
      dispRef.current.dispose(); // frees programs/textures, never loseContext
      dispRef.current = null;
    }
  }, []);

  const ensureDisplay = () => {
    if (!dispRef.current) {
      dispRef.current = createGlDisplay(canvasRef.current);
      if (!dispRef.current) throw new Error('WebGL2 unavailable — the battery requires the GL display path');
    }
    return dispRef.current;
  };

  // One cell: both pipelines on the already-seeked video element.
  const runCell = async (fx, gradeDef, ctx, misPinMatrix) => {
    const el = videoRef.current;
    const w = el.videoWidth;
    const h = el.videoHeight;
    const disp = ensureDisplay();
    disp.resize(w, h);
    const entry = compileEntry(gradeDef.grade, gradeDef.cube);
    if (entry) disp.setLut(entry.rgba8, LUT_N);
    else disp.clearLut();
    disp.render(el, !!entry);
    const glBuf = new Uint8Array(w * h * 4);
    disp.gl.readPixels(0, 0, w, h, disp.gl.RGBA, disp.gl.UNSIGNED_BYTE, glBuf);

    const ref = await api.invoke('vedit_parity_render', {
      src: fx.path,
      time: Math.max(0, (FRAME_IDX - 0.25) / ctx.fps) + (ctx.offset || 0),
      cubeText: entry ? entry.cube : null,
      colorMatrix: misPinMatrix || ctx.cm.matrix,
      colorRange: ctx.cm.range,
    }).then(decodePng);
    if (ref.width !== w || ref.height !== h) {
      throw new Error(`dimension mismatch: GL ${w}×${h} vs ffmpeg ${ref.width}×${ref.height}`);
    }
    const m = diffMetrics(glBuf, ref.data, w, h);
    // Buffers are kept only where someone will look at them (failures/demo).
    const buffers = !m.pass || misPinMatrix ? { glBuf, png: ref.data, w, h } : null;
    return { ...m, buffers };
  };

  const fixtureCtx = async (fx) => {
    const probe = await api.invoke('vedit_probe', { path: fx.path });
    const v0 = (probe.video || [])[0] || {};
    const remux = await api.invoke('vedit_remux_start', { path: fx.path, audioTrack: null });
    await loadVideo(videoRef.current, remux.url);
    await seekVideo(videoRef.current, (FRAME_IDX + 0.5) / (v0.fps || 30));
    return {
      fps: v0.fps || 30,
      offset: remux.startTimeOffset || 0,
      hash: remux.hash,
      cm: resolveColorimetry({ colorSpace: v0.color_space || null, colorRange: v0.color_range || null, height: v0.height || 0 }),
    };
  };

  const run = async () => {
    setRunning(true);
    setCells({});
    setSummary('');
    setDetailKey(null);
    cancelRef.current = false;
    const lines = [];
    const hashes = [];
    try {
      for (const fx of FIXTURES) {
        setStatus(`probing ${fx.key}…`);
        const ctx = await fixtureCtx(fx);
        hashes.push(ctx.hash);
        for (const g of GRADES) {
          if (cancelRef.current) return;
          const key = `${fx.key} × ${g.key}`;
          setStatus(`rendering ${key}…`);
          try {
            const r = await runCell(fx, g, ctx, null);
            lines.push(fmtLine(key, r));
            setCells((prev) => ({ ...prev, [key]: r }));
          } catch (e) {
            lines.push(`${key}: ERROR ${e?.message || e}`);
            setCells((prev) => ({ ...prev, [key]: { error: String(e?.message || e), pass: false } }));
          }
        }
      }
      const all = lines.every((l) => l.endsWith('PASS'));
      lines.push(`battery ${all ? 'PASS' : 'FAIL'} (mean ≤ ${PARITY_MEAN_MAX}, p99 ≤ ${PARITY_P99_MAX})`);
      setStatus(all ? 'battery PASS' : 'battery FAIL');
      setSummary(lines.join('\n'));
      console.info('[vedit-parity]\n' + lines.join('\n'));
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`);
    } finally {
      if (hashes.length) api.invoke('vedit_remux_release', { hashes }).catch(() => {});
      setRunning(false);
    }
  };

  // The deliberate failure: bt601-tagged SD decoded as bt601 by WebKit, but
  // the export side told bt709 — proves the battery detects matrix mistakes.
  const runBroken = async () => {
    setRunning(true);
    cancelRef.current = false;
    const key = 'DEMO bt601-sd × warm (mis-pinned bt709)';
    let hash = null;
    try {
      const fx = FIXTURES[1];
      setStatus('rendering broken demo cell…');
      const ctx = await fixtureCtx(fx);
      hash = ctx.hash;
      const r = await runCell(fx, GRADES[1], ctx, 'bt709');
      setCells((prev) => ({ ...prev, [key]: r }));
      setDetailKey(key);
      setStatus(`demo cell ${r.pass ? 'unexpectedly PASSED' : 'FAILED as intended'} — ${fmtCell(r)}`);
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`);
    } finally {
      if (hash) api.invoke('vedit_remux_release', { hashes: [hash] }).catch(() => {});
      setRunning(false);
    }
  };

  // Detail draw: GL frame | ffmpeg frame | ×8 heatmap.
  useEffect(() => {
    const cell = detailKey ? cells[detailKey] : null;
    const b = cell?.buffers;
    if (!b || !glCRef.current) return;
    const { glBuf, png, w, h } = b;
    const draw = (canvas, fill) => {
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      fill(img.data);
      ctx.putImageData(img, 0, 0);
    };
    draw(glCRef.current, (d) => {
      for (let y = 0; y < h; y++) {
        d.set(glBuf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      }
      for (let i = 3; i < d.length; i += 4) d[i] = 255;
    });
    draw(ffCRef.current, (d) => d.set(png));
    draw(heatCRef.current, (d) => {
      for (let y = 0; y < h; y++) {
        const gRow = (h - 1 - y) * w * 4;
        const pRow = y * w * 4;
        for (let x = 0; x < w; x++) {
          let dm = 0;
          for (let c = 0; c < 3; c++) {
            const dd = Math.abs(glBuf[gRow + x * 4 + c] - png[pRow + x * 4 + c]);
            if (dd > dm) dm = dd;
          }
          const o = pRow + x * 4;
          d[o] = Math.min(255, dm * 8);
          d[o + 3] = 255;
        }
      }
    });
  }, [detailKey, cells]);

  const detail = detailKey ? cells[detailKey] : null;
  const canvasStyle = { width: 290, border: '1px solid var(--border)', borderRadius: 6, background: '#000' };

  return (
    <AppWindow
      open
      onClose={onClose}
      title="Parity Battery"
      icon={<IconClapperboard />}
      accent={accent}
      width={1000}
      height="auto"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PrimaryBtn small accent={accent} onClick={run} disabled={running}>Run battery</PrimaryBtn>
          <OutlinedBtn small onClick={runBroken} disabled={running}>Demo failure</OutlinedBtn>
          <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>{status}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: `120px repeat(${GRADES.length}, 1fr)`, gap: 4 }}>
          <div />
          {GRADES.map((g) => (
            <div key={g.key} style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', textAlign: 'center' }}>{g.key}</div>
          ))}
          {FIXTURES.map((fx) => (
            <React.Fragment key={fx.key}>
              <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', alignSelf: 'center' }}>{fx.key}</div>
              {GRADES.map((g) => {
                const key = `${fx.key} × ${g.key}`;
                const r = cells[key];
                const clickable = !!r?.buffers;
                return (
                  <div
                    key={key}
                    onClick={clickable ? () => setDetailKey(key) : undefined}
                    title={r?.error || key}
                    style={{
                      ...mono,
                      fontSize: 10.5,
                      textAlign: 'center',
                      padding: '5px 2px',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      color: !r ? 'var(--text-faint)' : r.pass ? 'var(--text)' : 'var(--error)',
                      cursor: clickable ? 'pointer' : 'default',
                    }}
                  >
                    {!r ? '—' : r.error ? 'ERR' : `${r.pass ? '✓' : '✗'} ${fmtCell(r)}`}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        {summary && (
          <textarea
            readOnly
            value={summary}
            style={{ ...mono, fontSize: 10.5, width: '100%', height: 120, resize: 'vertical', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
          />
        )}

        {detail?.buffers && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ ...mono, fontSize: 11, color: detail.pass ? 'var(--text)' : 'var(--error)' }}>
              {detailKey} — mean {detail.mean.map((m) => m.toFixed(2)).join('/')} · p99 {detail.p99.join('/')} · max {detail.max.join('/')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div><canvas ref={glCRef} style={canvasStyle} /><div style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', textAlign: 'center' }}>WebGL preview</div></div>
              <div><canvas ref={ffCRef} style={canvasStyle} /><div style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', textAlign: 'center' }}>ffmpeg export</div></div>
              <div><canvas ref={heatCRef} style={canvasStyle} /><div style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', textAlign: 'center' }}>|Δ| × 8 heatmap</div></div>
            </div>
          </div>
        )}

        {/* Hidden battery surfaces. Platform rule: opacity 0.0001, never
            display:none — decode/upload must stay active. */}
        <div style={{ position: 'absolute', left: -9999, top: 0, width: 2, height: 2, overflow: 'hidden', opacity: 0.0001, pointerEvents: 'none' }}>
          <video ref={videoRef} crossOrigin="anonymous" muted playsInline preload="auto" />
          <canvas ref={canvasRef} />
        </div>
      </div>
    </AppWindow>
  );
}
