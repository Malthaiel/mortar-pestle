// CompositeParityPanel — the Compositing & Titles tech-bet STOP gate (SF12),
// DEV-only. For each cell it composites the SAME still-image layers through BOTH
// pipelines and scores per-channel |Δ| (8-bit):
//   JS side    glDisplay.renderComposite([{el:canvas,transform,isTitle}], …) →
//              readPixels at sequence res (the live preview compositor).
//   Rust side  vedit_composite_parity: the REAL shipping build_filter_script_
//              regions + input_args → ffmpeg overlay stack → one PNG frame.
// Both pipelines composite byte-identical SOURCE pixels (a structured pattern
// PNG, reused as the GL `el` and the Rust `title_png`), so any diff is geometry/
// blend codegen drift, not source-decode noise. Every cell's BOTTOM layer is the
// full-frame pattern, so neither side's background-clear colour is ever exposed
// (GL clears to the stage tone, ffmpeg to black — they only agree where covered).
// The video-decode fit scalar (min(seqW/srcW,seqH/srcH)) is covered by the SF7
// Rust unit tests; this battery exercises overlay/rotate/opacity/crop/multi-layer
// + the title overlay (the SF10/SF11 parity hinge — one drawTitle → both paths).

import React, { useEffect, useRef, useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { PrimaryBtn } from '@host/components/ui/Button.jsx';
import { IconClapperboard } from '@host/components/icons.jsx';
import { createGlDisplay } from './color/glDisplay.js';
import { drawTitle } from './drawTitle.js';

const mono = { fontFamily: 'var(--font-mono), monospace' };
const W = 1280;
const H = 720;
const ID = Object.freeze({ x: 0, y: 0, scale: 1, rot: 0, opacity: 1, crop: { l: 0, t: 0, r: 0, b: 0 } });

// A structured, asymmetric full-frame pattern → any misalignment/rotation/flip
// shows as pixel diffs. Sized to the sequence so an identity layer fills it.
function makePattern() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#16335f'; x.fillRect(0, 0, W / 2, H / 2);
  x.fillStyle = '#5f2516'; x.fillRect(W / 2, 0, W / 2, H / 2);
  x.fillStyle = '#165f33'; x.fillRect(0, H / 2, W / 2, H / 2);
  x.fillStyle = '#5f5016'; x.fillRect(W / 2, H / 2, W / 2, H / 2);
  x.strokeStyle = '#e8e8e8'; x.lineWidth = 10;
  x.beginPath(); x.moveTo(0, 0); x.lineTo(W, H); x.stroke();
  x.fillStyle = '#ffffff'; x.fillRect(40, 40, 160, 90); // TL marker (breaks symmetry)
  x.fillStyle = '#000000'; x.font = 'bold 160px "Segoe UI"';
  x.fillText('Pq', 90, 520);
  return c;
}

const toB64 = (canvas) => canvas.toDataURL('image/png').split(',')[1];

function buildCells() {
  const pat = makePattern();
  const src = { canvas: pat, b64: toB64(pat), w: pat.width, h: pat.height };
  const title = drawTitle({
    text: 'TITLE', font: 'Segoe UI', size: 120, color: '#ffffff', align: 'center',
    bold: true, italic: false, stroke: { color: '#000000', width: 6 },
    shadow: { color: '#000000', blur: 0, dx: 0, dy: 0 }, background: null,
  }, 1);
  const titleSrc = { canvas: title, b64: toB64(title), w: title.width, h: title.height };
  const base = (extra) => [{ src, transform: null }, ...extra];
  return [
    { key: 'identity', layers: [{ src, transform: null }], mean: 2.5, p99: 8 },
    { key: 'translate', layers: base([{ src, transform: { ...ID, x: 0.2, y: -0.1 } }]), mean: 2.5, p99: 8 },
    { key: 'scale 0.4', layers: base([{ src, transform: { ...ID, scale: 0.4 } }]), mean: 2.5, p99: 8 },
    { key: 'rotate 30', layers: base([{ src, transform: { ...ID, rot: 30 } }]), mean: 3.5, p99: 12 },
    { key: 'crop', layers: base([{ src, transform: { ...ID, scale: 0.6, crop: { l: 0.15, t: 0.15, r: 0.15, b: 0.15 } } }]), mean: 2.5, p99: 8 },
    { key: 'opacity 0.5', layers: base([{ src, transform: { ...ID, x: 0.18, scale: 0.7, opacity: 0.5 } }]), mean: 2.5, p99: 8 },
    { key: 'multi-3', layers: base([{ src, transform: { ...ID, scale: 0.6, x: -0.22 } }, { src, transform: { ...ID, scale: 0.4, x: 0.25, rot: 15 } }]), mean: 3, p99: 10 },
    { key: 'title overlay', layers: base([{ src: titleSrc, transform: { ...ID, y: -0.3 } }]), mean: 2, p99: 8 },
  ];
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
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('reference PNG decode failed')); };
    img.src = url;
  });
}

// glRGBA is bottom-up (readPixels), pngRGBA top-down — rows flipped here.
function diffMetrics(glRGBA, pngRGBA, w, h, maxMean, maxP99) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const sum = [0, 0, 0];
  const max = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const gRow = (h - 1 - y) * w * 4;
    const pRow = y * w * 4;
    for (let xx = 0; xx < w; xx++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(glRGBA[gRow + xx * 4 + c] - pngRGBA[pRow + xx * 4 + c]);
        sum[c] += d;
        hist[c][d]++;
        if (d > max[c]) max[c] = d;
      }
    }
  }
  const n = w * h;
  const p99 = hist.map((hh) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hh[v]; if (acc >= n * 0.99) return v; }
    return 255;
  });
  const mean = sum.map((s) => s / n);
  const pass = mean.every((m) => m <= maxMean) && p99.every((p) => p <= maxP99);
  return { mean, p99, max, pass };
}

const fmtCell = (r) => `m${Math.max(...r.mean).toFixed(2)} p${Math.max(...r.p99)}`;
const fmtLine = (key, r) => `${key}: mean ${r.mean.map((m) => m.toFixed(2)).join('/')} p99 ${r.p99.join('/')} max ${r.max.join('/')} ${r.pass ? 'PASS' : 'FAIL'}`;

export default function CompositeParityPanel({ onClose, api, accent }) {
  const [cells, setCells] = useState({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState('');
  const [detailKey, setDetailKey] = useState(null);

  const canvasRef = useRef(null);
  const dispRef = useRef(null);
  const cancelRef = useRef(false);
  const glCRef = useRef(null);
  const ffCRef = useRef(null);
  const heatCRef = useRef(null);

  useEffect(() => () => {
    cancelRef.current = true;
    if (dispRef.current) { dispRef.current.dispose(); dispRef.current = null; }
  }, []);

  const ensureDisplay = () => {
    if (!dispRef.current) {
      dispRef.current = createGlDisplay(canvasRef.current);
      if (!dispRef.current) throw new Error('WebGL2 unavailable — the battery requires the GL display path');
    }
    return dispRef.current;
  };

  const runCell = async (cell, mis) => {
    const disp = ensureDisplay();
    disp.resize(W, H);
    const glLayers = cell.layers.map((l) => ({ el: l.src.canvas, transform: l.transform, lut: null, isTitle: true }));
    disp.renderComposite(glLayers, W, H);
    const glBuf = new Uint8Array(W * H * 4);
    disp.gl.readPixels(0, 0, W, H, disp.gl.RGBA, disp.gl.UNSIGNED_BYTE, glBuf);

    const specLayers = cell.layers.map((l, i) => ({
      src: null,
      dur: 1,
      hasAudio: false,
      srcW: l.src.w,
      srcH: l.src.h,
      // "Demo failure" mis-pins the top layer's offset so the battery can FAIL.
      transform: mis && i === cell.layers.length - 1 && l.transform
        ? { ...l.transform, x: (l.transform.x || 0) + 0.05 }
        : l.transform,
      titlePng: l.src.b64,
    }));
    const ref = await api.invoke('vedit_composite_parity', { spec: { width: W, height: H, fps: 30, layers: specLayers } }).then(decodePng);
    if (ref.width !== W || ref.height !== H) {
      throw new Error(`dimension mismatch: GL ${W}×${H} vs ffmpeg ${ref.width}×${ref.height}`);
    }
    const m = diffMetrics(glBuf, ref.data, W, H, cell.mean, cell.p99);
    const buffers = !m.pass || mis ? { glBuf, png: ref.data, w: W, h: H } : null;
    return { ...m, buffers };
  };

  const run = async (mis) => {
    setRunning(true);
    setCells({});
    setSummary('');
    setDetailKey(null);
    cancelRef.current = false;
    const lines = [];
    try {
      const battery = buildCells();
      for (const cell of battery) {
        if (cancelRef.current) return;
        const key = mis ? `DEMO ${cell.key} (mis-pinned)` : cell.key;
        setStatus(`rendering ${key}…`);
        try {
          const r = await runCell(cell, mis);
          lines.push(fmtLine(key, r));
          setCells((prev) => ({ ...prev, [key]: r }));
          if (mis) { setDetailKey(key); break; } // demo: one cell, show the diff
        } catch (e) {
          lines.push(`${key}: ERROR ${e?.message || e}`);
          setCells((prev) => ({ ...prev, [key]: { error: String(e?.message || e), pass: false } }));
        }
      }
      if (!mis) {
        const all = lines.every((l) => l.endsWith('PASS'));
        lines.push(`battery ${all ? 'PASS' : 'FAIL'}`);
        setStatus(all ? 'battery PASS' : 'battery FAIL');
        setSummary(lines.join('\n'));
        console.info('[vedit-composite-parity]\n' + lines.join('\n'));
      } else {
        setStatus('demo cell rendered (mis-pinned → expect FAIL)');
      }
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`);
    } finally {
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
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      fill(img.data);
      ctx.putImageData(img, 0, 0);
    };
    draw(glCRef.current, (d) => {
      for (let y = 0; y < h; y++) d.set(glBuf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      for (let i = 3; i < d.length; i += 4) d[i] = 255;
    });
    draw(ffCRef.current, (d) => d.set(png));
    draw(heatCRef.current, (d) => {
      for (let y = 0; y < h; y++) {
        const gRow = (h - 1 - y) * w * 4;
        const pRow = y * w * 4;
        for (let xx = 0; xx < w; xx++) {
          let dm = 0;
          for (let c = 0; c < 3; c++) { const dd = Math.abs(glBuf[gRow + xx * 4 + c] - png[pRow + xx * 4 + c]); if (dd > dm) dm = dd; }
          const o = pRow + xx * 4;
          d[o] = Math.min(255, dm * 8);
          d[o + 3] = 255;
        }
      }
    });
  }, [detailKey, cells]);

  const detail = detailKey ? cells[detailKey] : null;
  const canvasStyle = { width: 300, border: '1px solid var(--border)', borderRadius: 6, background: '#000' };
  const keys = buildCells().map((c) => c.key);

  return (
    <AppWindow open onClose={onClose} title="Compositing Parity Battery" icon={<IconClapperboard />} accent={accent} width={760} height="auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PrimaryBtn small accent={accent} onClick={() => run(false)} disabled={running}>Run battery</PrimaryBtn>
          <PrimaryBtn small onClick={() => run(true)} disabled={running}>Demo failure</PrimaryBtn>
          <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>{status}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          {keys.map((key) => {
            const r = cells[key];
            const clickable = !!r?.buffers;
            return (
              <div key={key} onClick={clickable ? () => setDetailKey(key) : undefined} title={r?.error || key}
                style={{ ...mono, fontSize: 10.5, textAlign: 'center', padding: '6px 2px', border: '1px solid var(--border)', borderRadius: 6,
                  color: !r ? 'var(--text-faint)' : r.pass ? 'var(--text)' : 'var(--error)', cursor: clickable ? 'pointer' : 'default' }}>
                <div style={{ color: 'var(--text-faint)', marginBottom: 2 }}>{key}</div>
                {!r ? '—' : r.error ? 'ERR' : `${r.pass ? '✓' : '✗'} ${fmtCell(r)}`}
              </div>
            );
          })}
        </div>

        {summary && (
          <textarea readOnly value={summary}
            style={{ ...mono, fontSize: 10.5, width: '100%', height: 110, resize: 'vertical', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }} />
        )}

        {detail?.buffers && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ ...mono, fontSize: 11, color: detail.pass ? 'var(--text)' : 'var(--error)' }}>
              {detailKey} — mean {detail.mean.map((m) => m.toFixed(2)).join('/')} · p99 {detail.p99.join('/')} · max {detail.max.join('/')}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div><canvas ref={glCRef} style={canvasStyle} /><div style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', textAlign: 'center' }}>WebGL preview</div></div>
              <div><canvas ref={ffCRef} style={canvasStyle} /><div style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', textAlign: 'center' }}>ffmpeg export</div></div>
              <div><canvas ref={heatCRef} style={canvasStyle} /><div style={{ ...mono, fontSize: 10, color: 'var(--text-faint)', textAlign: 'center' }}>|Δ| × 8 heatmap</div></div>
            </div>
          </div>
        )}

        {/* Hidden GL surface. Platform rule: opacity 0.0001, never display:none. */}
        <div style={{ position: 'absolute', left: -9999, top: 0, width: 2, height: 2, overflow: 'hidden', opacity: 0.0001, pointerEvents: 'none' }}>
          <canvas ref={canvasRef} />
        </div>
      </div>
    </AppWindow>
  );
}
