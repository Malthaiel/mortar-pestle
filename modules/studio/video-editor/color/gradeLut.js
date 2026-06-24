// gradeLut — the LUT compiler (Color Grading SF3): the single source of truth
// for ALL grade math. One grade compiles to ONE 33³ lattice applied twice
// from the same numbers — WebGL2 sampler3D on the preview (glDisplay FS_LUT,
// trilinear via LINEAR filtering) and ffmpeg `lut3d=interp=trilinear` in the
// export graph — so preview and export can only disagree where decode/YUV
// conversion differs (measured by the SF5 parity battery, never by grade
// math).
//
// Stage order is FIXED (locked decision 7): temp/tint → CDL lift/gamma/gain →
// saturation → RGB curves (master, then per-channel) → hue-vs-sat → creative
// LUT mixed by intensity. CurveEditor (SF8) renders its paths by sampling
// evalCurve from THIS file, so the editor and the compiler can never drift.
//
// Lattice layout: red fastest, then green, then blue — the .cube convention
// ffmpeg reads AND the layout the spike's FS_LUT shader samples (its 3D
// texture upload uses the same order).

export const LUT_N = 33;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── curves ──────────────────────────────────────────────────────────────
// points: [[x, y], …], x ∈ 0..1. identity: 'diag' (tone curves, y=x) or
// 'one' (multiplier curves, y=1). wrap=true treats x as periodic (hue axis).
// Non-wrap interpolation is Fritsch–Carlson monotone cubic — no overshoot,
// the right behavior for tone curves. Wrap uses uniform Catmull-Rom over the
// point set extended one period each side.
export function evalCurve(points, size = 256, { wrap = false, identity = 'diag' } = {}) {
  const out = new Float32Array(size);
  const pts = (points || [])
    .map((p) => [clamp01(Number(p[0]) || 0), Number(p[1]) || 0])
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) {
    if (identity === 'one') out.fill(1);
    else for (let i = 0; i < size; i++) out[i] = i / (size - 1);
    return out;
  }
  if (pts.length === 1) {
    out.fill(pts[0][1]);
    return out;
  }
  if (!wrap) {
    const n = pts.length;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const dx = [];
    const m = [];
    for (let i = 0; i < n - 1; i++) {
      const h = xs[i + 1] - xs[i] || 1e-6;
      dx.push(h);
      m.push((ys[i + 1] - ys[i]) / h);
    }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) {
        t.push(0);
      } else {
        const w1 = 2 * dx[i] + dx[i - 1];
        const w2 = dx[i] + 2 * dx[i - 1];
        t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
      }
    }
    t.push(m[n - 2]);
    for (let i = 0; i < size; i++) {
      const x = i / (size - 1);
      if (x <= xs[0]) { out[i] = ys[0]; continue; }
      if (x >= xs[n - 1]) { out[i] = ys[n - 1]; continue; }
      let k = 0;
      while (k < n - 2 && x > xs[k + 1]) k++;
      const h = dx[k];
      const s = (x - xs[k]) / h;
      const h00 = (1 + 2 * s) * (1 - s) * (1 - s);
      const h10 = s * (1 - s) * (1 - s);
      const h01 = s * s * (3 - 2 * s);
      const h11 = s * s * (s - 1);
      out[i] = h00 * ys[k] + h10 * h * t[k] + h01 * ys[k + 1] + h11 * h * t[k + 1];
    }
    return out;
  }
  // Periodic: extend two points each side, plain Catmull-Rom between knots.
  const ext = [
    ...pts.slice(-2).map(([x, y]) => [x - 1, y]),
    ...pts,
    ...pts.slice(0, 2).map(([x, y]) => [x + 1, y]),
  ];
  const cr = (a, b, c, d, s) =>
    b + 0.5 * s * (c - a + s * (2 * a - 5 * b + 4 * c - d + s * (3 * (b - c) + d - a)));
  for (let i = 0; i < size; i++) {
    const x = i / size; // periodic domain [0, 1)
    let j = 0;
    for (let k = 0; k < ext.length - 1; k++) if (ext[k][0] <= x) j = k;
    const p0 = ext[Math.max(0, j - 1)];
    const p1 = ext[j];
    const p2 = ext[Math.min(ext.length - 1, j + 1)];
    const p3 = ext[Math.min(ext.length - 1, j + 2)];
    const span = p2[0] - p1[0] || 1e-6;
    const s = clamp01((x - p1[0]) / span);
    out[i] = cr(p0[1], p1[1], p2[1], p3[1], s);
  }
  return out;
}

const sampleTable = (tab, v) => {
  const x = clamp01(v) * (tab.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < tab.length ? tab[i] * (1 - f) + tab[i + 1] * f : tab[i];
};

// Wrapping variant for the hue axis (table built over [0,1) periodic).
const sampleWrapTable = (tab, v) => {
  const x = (v - Math.floor(v)) * tab.length;
  const i = Math.floor(x) % tab.length;
  const f = x - Math.floor(x);
  const j = (i + 1) % tab.length;
  return tab[i] * (1 - f) + tab[j] * f;
};

// ── .cube parse / serialize ─────────────────────────────────────────────
export function parseCube(text) {
  let n = 0;
  let title = '';
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) {
      title = (line.slice(5).trim().replace(/^"|"$/g, '')) || '';
      continue;
    }
    if (line.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported — use a 3D .cube');
    if (line.startsWith('LUT_3D_SIZE')) {
      n = parseInt(line.slice(11).trim(), 10);
      if (!Number.isFinite(n) || n < 2 || n > 129) throw new Error(`unsupported LUT_3D_SIZE ${n}`);
      continue;
    }
    if (line.startsWith('DOMAIN_MIN')) {
      domainMin = line.slice(10).trim().split(/\s+/).map(Number);
      continue;
    }
    if (line.startsWith('DOMAIN_MAX')) {
      domainMax = line.slice(10).trim().split(/\s+/).map(Number);
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length === 3) {
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) values.push(r, g, b);
    }
  }
  if (!n) throw new Error('missing LUT_3D_SIZE');
  if (values.length !== n * n * n * 3) {
    throw new Error(`expected ${n ** 3} entries, found ${values.length / 3}`);
  }
  return { n, data: Float32Array.from(values), title, domainMin, domainMax };
}

export function serializeCube(f32, title = 'Iskariel grade') {
  const n = Math.round(Math.cbrt(f32.length / 3));
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`];
  for (let i = 0; i < f32.length; i += 3) {
    lines.push(`${f32[i].toFixed(6)} ${f32[i + 1].toFixed(6)} ${f32[i + 2].toFixed(6)}`);
  }
  return lines.join('\n') + '\n';
}

// Trilinear sample of a parsed cube at rgb ∈ 0..1 (honors DOMAIN_MIN/MAX).
export function sampleCube(cube, r, g, b) {
  const { n, data, domainMin = [0, 0, 0], domainMax = [1, 1, 1] } = cube;
  const coord = (v, a) => clamp01((v - domainMin[a]) / ((domainMax[a] - domainMin[a]) || 1)) * (n - 1);
  const x = coord(r, 0);
  const y = coord(g, 1);
  const z = coord(b, 2);
  const x0 = Math.floor(x); const x1 = Math.min(n - 1, x0 + 1); const fx = x - x0;
  const y0 = Math.floor(y); const y1 = Math.min(n - 1, y0 + 1); const fy = y - y0;
  const z0 = Math.floor(z); const z1 = Math.min(n - 1, z0 + 1); const fz = z - z0;
  const at = (xi, yi, zi, c) => data[((zi * n + yi) * n + xi) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - fx) + at(x1, y0, z0, c) * fx;
    const c10 = at(x0, y1, z0, c) * (1 - fx) + at(x1, y1, z0, c) * fx;
    const c01 = at(x0, y0, z1, c) * (1 - fx) + at(x1, y0, z1, c) * fx;
    const c11 = at(x0, y1, z1, c) * (1 - fx) + at(x1, y1, z1, c) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return out;
}

// ── HSV round-trip for hue-vs-sat ───────────────────────────────────────
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// ── the compiler ────────────────────────────────────────────────────────
const identityPts = (pts) =>
  !pts
  || pts.length < 2
  || (pts.length === 2
    && pts[0][0] === 0 && pts[0][1] === 0
    && pts[1][0] === 1 && pts[1][1] === 1);

// grade (gradeOps schema) + optional parsed creative cube → Float32Array
// lattice (LUT_N³ × rgb, red fastest). Pure; ~2–6 ms at 33³.
export function compileGrade(grade, parsedLut = null) {
  const g = grade || {};
  const N = LUT_N;
  const out = new Float32Array(N * N * N * 3);
  const temp = g.temp || 0;
  const tint = g.tint || 0;
  const lift = g.lift || [0, 0, 0];
  const gamma = g.gamma || [0, 0, 0];
  const gain = g.gain || [1, 1, 1];
  const sat = g.sat ?? 1;
  const tempOn = temp !== 0 || tint !== 0;
  const cdlOn = lift.some((v) => v !== 0) || gamma.some((v) => v !== 0) || gain.some((v) => v !== 1);
  const power = [2 ** -(gamma[0] || 0), 2 ** -(gamma[1] || 0), 2 ** -(gamma[2] || 0)];
  const satOn = sat !== 1;
  const curves = g.curves || {};
  const tabM = identityPts(curves.m) ? null : evalCurve(curves.m, 256);
  const tabR = identityPts(curves.r) ? null : evalCurve(curves.r, 256);
  const tabG = identityPts(curves.g) ? null : evalCurve(curves.g, 256);
  const tabB = identityPts(curves.b) ? null : evalCurve(curves.b, 256);
  const curvesOn = tabM || tabR || tabG || tabB;
  const hueTab = g.hueSat && g.hueSat.length && g.hueSat.some(([, m]) => m !== 1)
    ? evalCurve(g.hueSat, 256, { wrap: true, identity: 'one' })
    : null;
  const intensity = g.lut ? (g.lut.intensity ?? 1) : 0;
  const lutOn = parsedLut && intensity > 0;

  let i = 0;
  for (let zb = 0; zb < N; zb++) {
    for (let yg = 0; yg < N; yg++) {
      for (let xr = 0; xr < N; xr++) {
        let r = xr / (N - 1);
        let gg = yg / (N - 1);
        let b = zb / (N - 1);
        if (tempOn) {
          r *= 1 + 0.25 * temp;
          b *= 1 - 0.25 * temp;
          gg *= 1 + 0.25 * tint;
        }
        if (cdlOn) {
          r = clamp01(r * gain[0] + lift[0]) ** power[0];
          gg = clamp01(gg * gain[1] + lift[1]) ** power[1];
          b = clamp01(b * gain[2] + lift[2]) ** power[2];
        } else if (tempOn) {
          r = clamp01(r); gg = clamp01(gg); b = clamp01(b);
        }
        if (satOn) {
          const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          r = clamp01(y + (r - y) * sat);
          gg = clamp01(y + (gg - y) * sat);
          b = clamp01(y + (b - y) * sat);
        }
        if (curvesOn) {
          if (tabM) { r = sampleTable(tabM, r); gg = sampleTable(tabM, gg); b = sampleTable(tabM, b); }
          if (tabR) r = sampleTable(tabR, r);
          if (tabG) gg = sampleTable(tabG, gg);
          if (tabB) b = sampleTable(tabB, b);
          r = clamp01(r); gg = clamp01(gg); b = clamp01(b);
        }
        if (hueTab) {
          const [h, s, v] = rgbToHsv(r, gg, b);
          const ns = Math.min(1, Math.max(0, s * sampleWrapTable(hueTab, h)));
          [r, gg, b] = hsvToRgb(h, ns, v);
        }
        if (lutOn) {
          const [lr, lg, lb] = sampleCube(parsedLut, r, gg, b);
          r += (clamp01(lr) - r) * intensity;
          gg += (clamp01(lg) - gg) * intensity;
          b += (clamp01(lb) - b) * intensity;
        }
        out[i++] = r;
        out[i++] = gg;
        out[i++] = b;
      }
    }
  }
  return out;
}

// Lattice → RGBA8 for texImage3D (the byte quantization both paths share:
// 8-bit here, 8-bit in the serialized cube ffmpeg reads at %.6f precision —
// RGBA16F is the recorded parity tuning knob if 8-bit shows up in p99).
export function toRGBA8(f32) {
  const n3 = f32.length / 3;
  const out = new Uint8Array(n3 * 4);
  for (let i = 0, j = 0; i < f32.length; i += 3, j += 4) {
    out[j] = Math.round(clamp01(f32[i]) * 255);
    out[j + 1] = Math.round(clamp01(f32[i + 1]) * 255);
    out[j + 2] = Math.round(clamp01(f32[i + 2]) * 255);
    out[j + 3] = 255;
  }
  return out;
}
