// Chart — a minimal dependency-free inline-SVG multi-series line chart (Full Match Data
// Extraction, SF-D). series: [{ label, color, points: [{x, y}] }]. Shared x/y domain,
// y from 0, "nice" gridline ticks, a hover guide-line + dots, and a legend that shows
// each series' value at the hovered x. Themed via candy tokens; mirrors the icons.jsx
// inline-SVG idiom. A single-point series degrades to a dot.

import { useRef, useState } from 'react';

function niceTicks(min, max, count) {
  if (!(max > min)) return [min || 0];
  const step0 = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export default function Chart({ series, width = 760, height = 300, xFormat = (v) => v, yFormat = (v) => v }) {
  const [hoverX, setHoverX] = useState(null);
  const svgRef = useRef(null);
  const padL = 54, padR = 14, padT = 12, padB = 26;

  const all = (series || []).flatMap((s) => s.points || []);
  if (!all.length) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No series data.</div>;

  const xs = all.map((p) => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = 0, yMax = Math.max(1, ...all.map((p) => p.y));
  const W = width, H = height;
  const sx = (x) => padL + (xMax === xMin ? 0 : (x - xMin) / (xMax - xMin)) * (W - padL - padR);
  const sy = (y) => H - padB - (yMax === yMin ? 0 : (y - yMin) / (yMax - yMin)) * (H - padT - padB);

  const xUnion = [...new Set(xs)].sort((a, b) => a - b);
  const onMove = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const xv = xMin + frac * (xMax - xMin);
    setHoverX(xUnion.reduce((a, b) => (Math.abs(b - xv) < Math.abs(a - xv) ? b : a), xUnion[0]));
  };

  return (
    <div>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', maxWidth: '100%' }}
        onMouseMove={onMove} onMouseLeave={() => setHoverX(null)}>
        {niceTicks(yMin, yMax, 5).map((v, i) => (
          <g key={`y${i}`}>
            <line x1={padL} y1={sy(v)} x2={W - padR} y2={sy(v)} stroke="color-mix(in oklch, var(--text) 8%, transparent)" />
            <text x={padL - 6} y={sy(v) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">{yFormat(v)}</text>
          </g>
        ))}
        {niceTicks(xMin, xMax, 6).map((v, i) => (
          <text key={`x${i}`} x={sx(v)} y={H - padB + 15} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{xFormat(v)}</text>
        ))}
        {hoverX != null && <line x1={sx(hoverX)} y1={padT} x2={sx(hoverX)} y2={H - padB} stroke="color-mix(in oklch, var(--text) 22%, transparent)" />}
        {series.map((s, i) => {
          const pts = (s.points || []).slice().sort((a, b) => a.x - b.x);
          if (!pts.length) return null;
          if (pts.length === 1) return <circle key={i} cx={sx(pts[0].x)} cy={sy(pts[0].y)} r={3} fill={s.color} />;
          const d = pts.map((p, j) => `${j ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
          return <path key={i} d={d} fill="none" stroke={s.color} strokeWidth="1.75" strokeLinejoin="round" />;
        })}
        {hoverX != null && series.map((s, i) => {
          const p = (s.points || []).find((q) => q.x === hoverX);
          return p ? <circle key={`h${i}`} cx={sx(p.x)} cy={sy(p.y)} r={3} fill={s.color} stroke="var(--surface)" strokeWidth="1" /> : null;
        })}
      </svg>

      {/* legend (with hovered value) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8, fontSize: 11.5 }}>
        {series.map((s, i) => {
          const p = hoverX != null ? (s.points || []).find((q) => q.x === hoverX) : null;
          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-2)' }}>
              <span style={{ width: 10, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              {s.label}{p ? <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>&nbsp;{yFormat(p.y)}</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
