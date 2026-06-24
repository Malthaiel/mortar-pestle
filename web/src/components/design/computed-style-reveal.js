// SF8 of Design Mode — read computed styles off the selected element and
// best-effort reverse-map values to CSS-variable names declared on :root.
// Used by the reveal chip ("radius md · pad 12px · color var(--text)").
//
// Reverse-lookup approach: pull the :root computed style once per call,
// scan our small token catalog (radius-sm/md/lg, plus any --space-*),
// match by exact computed value (`'8px' === '8px'`). For colors, we don't
// attempt to reverse-map (too many semantic colors with overlapping oklch
// outputs); we return the raw computed value instead. Padding/margin are
// returned as the literal computed string (already in px).

import { resolveLabel, buildCrumbs } from './mark-resolve.js';

const RADIUS_TOKENS = ['--radius-sm', '--radius-md', '--radius-lg'];

function rootStyle() {
  return getComputedStyle(document.documentElement);
}

function shortRadiusName(varName) {
  if (varName === '--radius-sm') return 'sm';
  if (varName === '--radius-md') return 'md';
  if (varName === '--radius-lg') return 'lg';
  return varName;
}

function reverseRadius(computedValue) {
  if (!computedValue || computedValue === '0px') return computedValue || 'none';
  const root = rootStyle();
  for (const v of RADIUS_TOKENS) {
    if (root.getPropertyValue(v).trim() === computedValue.trim()) {
      return shortRadiusName(v);
    }
  }
  return computedValue;
}

function shortPadding(computedValue) {
  if (!computedValue) return '0';
  // Collapse "8px 8px 8px 8px" → "8px"; "8px 12px 8px 12px" → "8px 12px"; etc.
  const parts = computedValue.split(/\s+/).filter(Boolean);
  if (parts.length === 4 && parts[0] === parts[2] && parts[1] === parts[3]) {
    return parts[0] === parts[1] ? parts[0] : `${parts[0]} ${parts[1]}`;
  }
  return computedValue;
}

export function readReveal(el) {
  if (!el) return null;
  const cs = getComputedStyle(el);
  const crumbs = buildCrumbs(el);
  return {
    name: el.dataset.aosComponent || 'Unknown',
    label: resolveLabel(el),
    crumbs,
    path: crumbs.map((c) => c.label).join(' › '),
    source: el.dataset.aosSource || '',
    radius: reverseRadius(cs.borderTopLeftRadius),
    padding: shortPadding(cs.padding),
    margin: shortPadding(cs.margin),
    color: cs.color,
    fontSize: cs.fontSize,
  };
}

export function readSourcePath(el) {
  const src = el?.dataset?.aosSource;
  if (!src) return '';
  // Strip line:col suffix for chip display; keep full string in metadata.
  return src.replace(/:\d+:\d+$/, '');
}
