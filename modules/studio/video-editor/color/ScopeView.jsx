// ScopeView — tabbed Waveform | Vectorscope | Histogram (Color Grading SF9),
// fed by the GL loop's FBO tap through scopeBus at ≤ ~12 Hz. All three
// renderers are row-order independent, so the GL bottom-up readback needs no
// flip. Mounting sets the bus sink; unmounting (leaving Color mode) clears it,
// which provably stops the FBO pass + readPixels in the render loop.
//
// The tap hands over its REUSED buffer (single consumer, draw-on-receive) —
// each frame is drawn immediately and only the reference is kept for
// tab-switch redraws, which always show the newest data by construction.

import { useEffect, useRef, useState } from 'react';
import { Seg } from '@host/components/ui/Pill.jsx';
import { setScopeSink } from './scopeBus.js';

const BG = '#0a0a0c'; // Projection Booth stage tone — scopes read as picture chrome
const TRACE = [140, 220, 150]; // classic green scope trace

const SIZES = { wave: [256, 160], vector: [192, 192], histo: [256, 160] };

function drawWave(ctx, f, W, H) {
  const { data, w, h } = f;
  const den = new Float32Array(W * H);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const px = ((x / (w - 1)) * (W - 1)) | 0;
      const py = (H - 1) - (((lum / 255) * (H - 1)) | 0);
      den[py * W + px] += 1;
    }
  }
  const img = ctx.createImageData(W, H);
  const px = img.data;
  for (let i = 0; i < den.length; i++) {
    const d = den[i];
    if (!d) continue;
    const a = Math.min(1, 0.18 + d * 0.22);
    const j = i * 4;
    px[j] = TRACE[0];
    px[j + 1] = TRACE[1];
    px[j + 2] = TRACE[2];
    px[j + 3] = (a * 255) | 0;
  }
  ctx.putImageData(img, 0, 0);
  // quarter graticule on top
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  for (const q of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, q * H);
    ctx.lineTo(W, q * H);
    ctx.stroke();
  }
}

function drawVector(ctx, f, W, H) {
  const { data, w, h } = f;
  const den = new Float32Array(W * H);
  const n = w * h;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const cb = -0.114572 * r - 0.385428 * g + 0.5 * b; // bt709, ±127.5
    const cr = 0.5 * r - 0.454153 * g - 0.045847 * b;
    const px = ((cb / 255 + 0.5) * (W - 1)) | 0;
    const py = ((0.5 - cr / 255) * (H - 1)) | 0;
    den[py * W + px] += 1;
  }
  const img = ctx.createImageData(W, H);
  const px = img.data;
  for (let i = 0; i < den.length; i++) {
    const d = den[i];
    if (!d) continue;
    const a = Math.min(1, 0.2 + d * 0.05);
    const j = i * 4;
    px[j] = 225;
    px[j + 1] = 235;
    px[j + 2] = 225;
    px[j + 3] = (a * 255) | 0;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 0.46 * Math.min(W, H), 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
}

const HIST_COLORS = ['rgba(224,106,106,0.55)', 'rgba(106,191,106,0.55)', 'rgba(106,143,224,0.55)'];

function drawHisto(ctx, f, W, H) {
  const { data, w, h } = f;
  const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const n = w * h;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    bins[0][r]++;
    bins[1][g]++;
    bins[2][b]++;
    bins[3][(0.2126 * r + 0.7152 * g + 0.0722 * b) | 0]++;
  }
  let max = 1;
  for (const ch of bins) for (let v = 0; v < 256; v++) if (ch[v] > max) max = ch[v];
  const sx = W / 256;
  for (let c = 0; c < 3; c++) {
    ctx.fillStyle = HIST_COLORS[c];
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let v = 0; v < 256; v++) {
      ctx.lineTo(v * sx, H - (bins[c][v] / max) * (H - 4));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(235,235,235,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let v = 0; v < 256; v++) {
    const y = H - (bins[3][v] / max) * (H - 4);
    if (v === 0) ctx.moveTo(0, y);
    else ctx.lineTo(v * sx, y);
  }
  ctx.stroke();
}

const RENDER = { wave: drawWave, vector: drawVector, histo: drawHisto };

export default function ScopeView({ accent }) {
  const [tab, setTab] = useState('wave');
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const draw = useRef(() => {});
  draw.current = () => {
    const f = frameRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const t = tabRef.current;
    const [W, H] = SIZES[t];
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    if (f) RENDER[t](ctx, f, W, H);
  };

  useEffect(() => {
    setScopeSink((f) => {
      frameRef.current = f;
      draw.current();
    });
    return () => setScopeSink(null);
  }, []);

  useEffect(() => {
    draw.current();
  }, [tab]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', padding: '0 10px 10px' }}>
      <div style={{ flexShrink: 0 }}>
        <Seg
          options={[
            { value: 'wave', label: 'WAVE' },
            { value: 'vector', label: 'VEC' },
            { value: 'histo', label: 'HIST' },
          ]}
          value={tab}
          onChange={setTab}
          accent={accent}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', background: BG }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
        />
      </div>
    </div>
  );
}
