// Community Themes registry — the named preset palettes selectable in
// Settings → Appearance. A theme is a pair of OKLch token maps (light + dark)
// that override the neutral colour ramp from styles.css `:root`, plus a single
// signature accent and a small swatch set for the picker's mini-mock. Themes
// override COLOURS ONLY — fonts, radii, density and candy depth stay
// independent user settings and are never listed in THEME_TOKEN_KEYS.
//
// Monastic is the built-in default and carries `null` maps: applying it is a
// no-op, so the styles.css base palette stands. This is plain data (no React),
// so web/scripts/check-theme-contrast.mjs imports it directly under Node.

// The exact subset of `:root` tokens a theme may override. The apply/preview
// paint loop iterates THIS ordered list (not Object.keys of a map) so a token
// set by theme A is reliably cleared when switching to theme B even if B omits
// it. --shadow-* are box-shadow strings, not colours (the contrast gate skips
// them); everything else is an OKLch colour.
export const THEME_TOKEN_KEYS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--hover',
  '--border',
  '--border-2',
  '--border-soft',
  '--divider',
  '--text',
  '--text-2',
  '--text-muted',
  '--text-faint',
  '--shadow-card',
  '--shadow-fab',
];

export const DEFAULT_THEME_ID = 'monastic';

// ── Monastic (default) ───────────────────────────────────────────────────────
// Null maps = identity: apply nothing, the styles.css `:root` base shows. Its
// swatches mirror the base values so the picker card still renders a mini-mock.
const monastic = {
  id: 'monastic',
  name: 'Monastic',
  defaultAccent: '#7c2d2d', // the app's canonical red (DESIGN.md default accent)
  light: null,
  dark: null,
  swatches: {
    light: {
      bg: 'oklch(0.985 0.004 30)', surface: '#ffffff', border: 'oklch(0.92 0.005 30)',
      text: 'oklch(0.18 0.01 30)', textMuted: 'oklch(0.55 0.01 30)', accent: '#7c2d2d',
    },
    dark: {
      bg: 'oklch(0.160 0.005 78)', surface: 'oklch(0.190 0.005 78)', border: 'oklch(0.255 0.005 78)',
      text: 'oklch(0.920 0.005 85)', textMuted: 'oklch(0.560 0.008 82)', accent: '#7c2d2d',
    },
  },
};

// ── Gruvbox ──────────────────────────────────────────────────────────────────
// Warm retro palette. Dark = hard bg (#1d2021) + bg1/bg2 surfaces, cream fg
// (#ebdbb2). Light = cream bg (#fbf1c7), dark-gray fg (#3c3836). Accent = the
// faded orange (#af3a03) — works with white --on-accent text in both modes,
// matching the app's dark-accent language (per-page accents are all deep).
const gruvbox = {
  id: 'gruvbox',
  name: 'Gruvbox',
  defaultAccent: '#af3a03',
  dark: {
    '--bg':          'oklch(0.225 0.006 125)',
    '--surface':     'oklch(0.278 0.007 110)',
    '--surface-2':   'oklch(0.330 0.009 95)',
    '--surface-3':   'oklch(0.395 0.011 90)',
    '--hover':       'oklch(0.340 0.009 95)',
    '--border':      'oklch(0.405 0.012 90)',
    '--border-2':    'oklch(0.470 0.015 85)',
    '--border-soft': 'oklch(0.355 0.009 95)',
    '--divider':     'oklch(0.305 0.007 100)',
    '--text':        'oklch(0.895 0.034 95)',
    '--text-2':      'oklch(0.810 0.034 95)',
    '--text-muted':  'oklch(0.700 0.030 92)',
    '--text-faint':  'oklch(0.585 0.024 90)',
    '--shadow-card': '0 12px 48px rgba(0,0,0,0.62)',
    '--shadow-fab':  '0 2px 10px rgba(0,0,0,0.45)',
  },
  light: {
    '--bg':          'oklch(0.948 0.034 95)',
    '--surface':     'oklch(0.972 0.024 100)',
    '--surface-2':   'oklch(0.920 0.040 95)',
    '--surface-3':   'oklch(0.885 0.045 92)',
    '--hover':       'oklch(0.932 0.036 95)',
    '--border':      'oklch(0.808 0.040 90)',
    '--border-2':    'oklch(0.728 0.036 88)',
    '--border-soft': 'oklch(0.875 0.042 92)',
    '--divider':     'oklch(0.892 0.040 92)',
    '--text':        'oklch(0.330 0.012 75)',
    '--text-2':      'oklch(0.400 0.014 72)',
    '--text-muted':  'oklch(0.475 0.014 70)',
    '--text-faint':  'oklch(0.560 0.015 70)',
    '--shadow-card': '0 8px 40px rgba(60,40,10,0.16)',
    '--shadow-fab':  '0 2px 8px rgba(60,40,10,0.07)',
  },
  swatches: {
    light: {
      bg: 'oklch(0.948 0.034 95)', surface: 'oklch(0.972 0.024 100)', border: 'oklch(0.808 0.040 90)',
      text: 'oklch(0.330 0.012 75)', textMuted: 'oklch(0.475 0.014 70)', accent: '#af3a03',
    },
    dark: {
      bg: 'oklch(0.225 0.006 125)', surface: 'oklch(0.278 0.007 110)', border: 'oklch(0.405 0.012 90)',
      text: 'oklch(0.895 0.034 95)', textMuted: 'oklch(0.700 0.030 92)', accent: '#af3a03',
    },
  },
};

// ── Catppuccin ───────────────────────────────────────────────────────────────
// Dark = Mocha (base #1e1e2e, text #cdd6f4); light = Latte (base #eff1f5, text
// #4c4f69). Both carry the signature blue-violet hue (~280). Accent = Latte
// mauve (#8839ef) — the recognisable Catppuccin mauve that still clears white
// text contrast (the pastel Mocha mauve #cba6f7 would not).
const catppuccin = {
  id: 'catppuccin',
  name: 'Catppuccin',
  defaultAccent: '#8839ef',
  dark: {
    '--bg':          'oklch(0.225 0.028 282)',
    '--surface':     'oklch(0.255 0.028 280)',
    '--surface-2':   'oklch(0.350 0.030 280)',
    '--surface-3':   'oklch(0.435 0.030 279)',
    '--hover':       'oklch(0.345 0.030 280)',
    '--border':      'oklch(0.440 0.030 279)',
    '--border-2':    'oklch(0.515 0.030 278)',
    '--border-soft': 'oklch(0.360 0.030 280)',
    '--divider':     'oklch(0.300 0.028 281)',
    '--text':        'oklch(0.870 0.035 270)',
    '--text-2':      'oklch(0.810 0.035 270)',
    '--text-muted':  'oklch(0.700 0.032 270)',
    '--text-faint':  'oklch(0.585 0.030 272)',
    '--shadow-card': '0 12px 48px rgba(0,0,0,0.55)',
    '--shadow-fab':  '0 2px 10px rgba(0,0,0,0.40)',
  },
  light: {
    '--bg':          'oklch(0.925 0.010 268)',
    '--surface':     'oklch(0.962 0.008 270)',
    '--surface-2':   'oklch(0.918 0.012 268)',
    '--surface-3':   'oklch(0.888 0.014 268)',
    '--hover':       'oklch(0.930 0.010 268)',
    '--border':      'oklch(0.848 0.016 268)',
    '--border-2':    'oklch(0.792 0.018 266)',
    '--border-soft': 'oklch(0.888 0.014 268)',
    '--divider':     'oklch(0.918 0.012 268)',
    '--text':        'oklch(0.430 0.045 285)',
    '--text-2':      'oklch(0.485 0.042 285)',
    '--text-muted':  'oklch(0.545 0.038 283)',
    '--text-faint':  'oklch(0.615 0.030 280)',
    '--shadow-card': '0 8px 40px rgba(30,30,60,0.14)',
    '--shadow-fab':  '0 2px 8px rgba(30,30,60,0.06)',
  },
  swatches: {
    light: {
      bg: 'oklch(0.925 0.010 268)', surface: 'oklch(0.962 0.008 270)', border: 'oklch(0.848 0.016 268)',
      text: 'oklch(0.430 0.045 285)', textMuted: 'oklch(0.545 0.038 283)', accent: '#8839ef',
    },
    dark: {
      bg: 'oklch(0.225 0.028 282)', surface: 'oklch(0.255 0.028 280)', border: 'oklch(0.440 0.030 279)',
      text: 'oklch(0.870 0.035 270)', textMuted: 'oklch(0.700 0.032 270)', accent: '#8839ef',
    },
  },
};

export const THEMES = [monastic, gruvbox, catppuccin];

export const THEME_BY_ID = Object.fromEntries(THEMES.map(t => [t.id, t]));

// A community theme is any non-Monastic preset — the ones that collapse accent
// to a single global colour and suspend the per-page accent system.
export function isCommunityTheme(id) {
  return !!id && id !== DEFAULT_THEME_ID;
}
