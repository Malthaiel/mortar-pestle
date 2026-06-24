// SF9 of Design Mode — reverse-map a computed style value on an element to
// the nearest CSS-variable declared on :root. Returns the matched variable
// name when one is found, plus a `supportsCommit` flag indicating whether
// the v1 commit-to-source path supports patching this token.
//
// v1 commit-to-source policy:
//   - border-radius matched to --radius-sm/md/lg  → supportsCommit: true
//     (these tokens are theme-independent in this codebase)
//   - color matched to --text/--text-2/...        → supportsCommit: false
//     (theme-dependent; the dark block overrides; commit would silently
//      skip dark mode — bubble shows a disabled-with-tooltip state)
//   - padding / margin / font-size                → supportsCommit: false
//     (no var tokens for these in this codebase; raw px overrides only)

const RADIUS_TOKENS = ['--radius-sm', '--radius-md', '--radius-lg'];
const COLOR_TOKENS  = ['--text', '--text-2', '--text-muted', '--text-faint', '--accent'];

function rootStyle() {
  return getComputedStyle(document.documentElement);
}

function matchVar(value, candidates) {
  if (!value) return null;
  const target = value.trim();
  const root = rootStyle();
  for (const name of candidates) {
    const rv = root.getPropertyValue(name).trim();
    if (rv && rv === target) return name;
  }
  return null;
}

export function resolveToken(element, property) {
  if (!element) return { varName: null, currentValue: '', supportsCommit: false };
  const cs = getComputedStyle(element);
  if (property === 'border-radius') {
    const cur = cs.borderTopLeftRadius;
    const v = matchVar(cur, RADIUS_TOKENS);
    return { varName: v, currentValue: cur, supportsCommit: !!v };
  }
  if (property === 'color') {
    const cur = cs.color;
    const v = matchVar(cur, COLOR_TOKENS);
    return { varName: v, currentValue: cur, supportsCommit: false };
  }
  if (property === 'padding')    return { varName: null, currentValue: cs.padding,    supportsCommit: false };
  if (property === 'margin')     return { varName: null, currentValue: cs.margin,     supportsCommit: false };
  if (property === 'font-size')  return { varName: null, currentValue: cs.fontSize,   supportsCommit: false };
  return { varName: null, currentValue: '', supportsCommit: false };
}

export const ALL_PROPERTIES = ['border-radius', 'padding', 'margin', 'color', 'font-size'];
