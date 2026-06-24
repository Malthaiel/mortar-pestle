// Community Themes contrast gate — verifies every shipped preset clears WCAG AA
// for its text-on-surface pairs (and accent-vs-white) in BOTH light and dark,
// so contrast is checked at build time, not eyeballed. Dep-free: it parses the
// registry's OKLch token maps directly and converts OKLch → linear sRGB → WCAG
// relative luminance inline. Monastic (null maps) is read from styles.css so all
// three themes go through the same gate.
//
//   node scripts/check-theme-contrast.mjs      (or: npm run check-themes)
//
// Exits non-zero with a per-pair table if any FAIL pair is below threshold.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { THEMES } from '../src/themes/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, '..', 'src', 'styles.css');

// ── Colour math ──────────────────────────────────────────────────────────────
const clamp01 = x => Math.min(1, Math.max(0, x));

// OKLch "oklch(L C H)" → WCAG relative luminance (linear-light Y).
function oklchToY(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const R = clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const G = clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const B = clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B; // R/G/B already linear-light
}

// "#rrggbb" / "#rgb" → WCAG relative luminance.
function hexToY(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const lin = i => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

// Any supported colour string → Y, or null if unparseable (e.g. color-mix/var).
function colorToY(value) {
  if (!value) return null;
  const v = value.trim();
  const ok = v.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (ok) return oklchToY(parseFloat(ok[1]), parseFloat(ok[2]), parseFloat(ok[3]));
  if (v.startsWith('#')) return hexToY(v);
  return null;
}

function contrast(y1, y2) {
  const a = Math.max(y1, y2), b = Math.min(y1, y2);
  return (a + 0.05) / (b + 0.05);
}

// ── Monastic base palette, parsed from styles.css ────────────────────────────
function parseBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) return {};
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const map = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}
function monasticMaps() {
  const css = readFileSync(STYLES, 'utf8');
  return {
    light: parseBlock(css, ':root {'),
    dark: parseBlock(css, ":root[data-theme='dark']"),
    defaultAccent: null,
  };
}

// ── Pairs to check ───────────────────────────────────────────────────────────
// level 'fail' gates the build; 'warn' is advisory (faint/decorative text).
const TEXT_PAIRS = [
  { fg: '--text', bgs: ['--bg', '--surface', '--surface-2', '--surface-3', '--hover'], min: 4.5, level: 'fail' },
  { fg: '--text-2', bgs: ['--surface'], min: 4.5, level: 'fail' },
  { fg: '--text-muted', bgs: ['--surface'], min: 3.0, level: 'fail' },
  { fg: '--text-faint', bgs: ['--surface'], min: 3.0, level: 'warn' },
];
const ON_ACCENT = '#ffffff'; // --on-accent, theme-agnostic

function checkVariant(name, variant, map, defaultAccent) {
  const rows = [];
  // dark maps for Monastic inherit light tokens not overridden in the dark block.
  const resolve = key => map[key];
  for (const pair of TEXT_PAIRS) {
    const fgY = colorToY(resolve(pair.fg));
    if (fgY == null) continue;
    for (const bg of pair.bgs) {
      const bgY = colorToY(resolve(bg));
      if (bgY == null) continue;
      const ratio = contrast(fgY, bgY);
      const ok = ratio >= pair.min;
      rows.push({ label: `${pair.fg} on ${bg}`, ratio, min: pair.min, level: pair.level, ok });
    }
  }
  if (defaultAccent) {
    const ratio = contrast(colorToY(defaultAccent), hexToY(ON_ACCENT));
    rows.push({ label: `accent on ${ON_ACCENT}`, ratio, min: 4.5, level: 'fail', ok: ratio >= 4.5 });
  }
  return { name: `${name} · ${variant}`, rows };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const monastic = monasticMaps();
// Monastic dark inherits any token the dark block doesn't redeclare.
const monasticDark = { ...monastic.light, ...monastic.dark };

const groups = [];
for (const t of THEMES) {
  if (t.id === 'monastic') {
    groups.push(checkVariant(t.name, 'light', monastic.light, null));
    groups.push(checkVariant(t.name, 'dark', monasticDark, null));
  } else {
    groups.push(checkVariant(t.name, 'light', t.light, t.defaultAccent));
    groups.push(checkVariant(t.name, 'dark', t.dark, t.defaultAccent));
  }
}

let failed = 0, warned = 0;
for (const g of groups) {
  console.log(`\n${g.name}`);
  for (const r of g.rows) {
    const tag = r.ok ? 'PASS' : (r.level === 'warn' ? 'WARN' : 'FAIL');
    if (!r.ok && r.level === 'fail') failed++;
    if (!r.ok && r.level === 'warn') warned++;
    console.log(`  ${tag}  ${r.label.padEnd(28)} ${r.ratio.toFixed(2)} : 1  (min ${r.min})`);
  }
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${failed} fail, ${warned} warn across ${groups.length} theme/variant combos`);
process.exit(failed === 0 ? 0 : 1);
