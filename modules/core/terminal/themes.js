// Terminal appearance. The 16 ANSI slots are Zed's built-in "Gruvbox Dark"
// (medium-contrast) and "Gruvbox Light" palettes, copied verbatim from
// zed-industries/zed assets/themes/gruvbox/gruvbox.json — these are the slots a
// TUI paints its diffs, syntax and status text through, so a program's authored
// colors land exactly as they do in Zed (xterm renders truecolor untouched).
//
// Background and foreground are NOT fixed: they track the app's own --bg /
// --text tokens, measured live off the terminal's real container (see
// terminalTheme below). Which ANSI set is used follows from the MEASURED
// background luminance, never from a theme name — a new theme gets the correct
// palette for free. Gruvbox Dark's brightWhite is #fbf1c7, which would be
// invisible on a pale background, which is why the light set exists at all.
//
// Two deliberate deviations from Zed, both user-chosen and both dark-only:
//   red #bf584d (Zed: #cc241d) — softer; affects all ANSI-red incl. "bypass permissions on"
//   selection alpha 3d (~24%) — load-bearing, keep the 8-digit form

const DARK_ANSI = {
  black: '#282828',
  red: '#bf584d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#fbf1c7',
  cursor: '#83a598',
  selectionBackground: '#83a5983d',
  scrollbarSliderBackground: '#50494566',
  scrollbarSliderHoverBackground: '#665c5499',
  scrollbarSliderActiveBackground: '#7c6f64cc',
};

// Zed "Gruvbox Light", fetched + verified 2026-08-27 against the source JSON.
const LIGHT_ANSI = {
  black: '#fbf1c7',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#7c6f64',
  brightBlack: '#928374',
  brightRed: '#9d0006',
  brightGreen: '#79740e',
  brightYellow: '#b57614',
  brightBlue: '#076678',
  brightMagenta: '#8f3f71',
  brightCyan: '#427b58',
  brightWhite: '#282828',
  cursor: '#0b6678',
  selectionBackground: '#0b66783d',
  scrollbarSliderBackground: '#7c6f6433',
  scrollbarSliderHoverBackground: '#7c6f6455',
  scrollbarSliderActiveBackground: '#7c6f6477',
};

// The app's colour tokens are oklch(), which xterm cannot parse. Rather than
// carry an oklch→sRGB converter (and have it drift from the browser's own
// rounding), MEASURE: paint the computed value onto a 1x1 canvas and read the
// pixel back. Correct for any CSS colour the browser understands, today or
// later. Returns '#rrggbb', or null if the value didn't paint.
let probeCtx = null;
export function toHex(cssColor) {
  if (!cssColor) return null;
  try {
    if (!probeCtx) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      probeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    // A value the canvas can't parse leaves fillStyle at whatever it held last,
    // so reset to a known sentinel first — an unparseable token then reads
    // black rather than the previous caller's colour.
    probeCtx.fillStyle = '#000000';
    probeCtx.fillStyle = cssColor;
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  // Rec. 601 luma — enough to answer "is this surface light or dark".
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Full xterm theme for the surface `el` actually sits on. Re-run it whenever the
// app theme changes; the values are read fresh every call, never cached.
export function terminalTheme(el) {
  const cs = el ? getComputedStyle(el) : null;
  const background = toHex(cs?.getPropertyValue('--bg').trim()) || '#151411';
  const foreground = toHex(cs?.getPropertyValue('--text').trim()) || '#ebdbb2';
  const ansi = luminance(background) > 0.5 ? LIGHT_ANSI : DARK_ANSI;
  return {
    ...ansi,
    background,
    foreground,
    cursorAccent: background,   // glyph drawn under the block cursor = bg
  };
}

// The terminal's font. DM Mono is one of the app's two fonts (see
// web/src/fonts.css). It has no box-drawing or powerline glyphs, so Cascadia
// Mono sits behind it purely as a per-glyph fallback for those — every
// character DM Mono owns is still painted by DM Mono. Do not reorder these.
//
// The fallback used to name Lilex and eight other "* Nerd Font Mono" families,
// carried over from the Linux machine. MEASURED 2026-08-27 on this Windows box:
// not one of them is installed (142 families; zero Nerd Fonts), so the terminal
// had been falling through to an unnamed system mono for months. Cascadia Mono
// and Consolas ship with Windows and both carry the box-drawing block.
export const TERMINAL_FONT_FAMILY = '"DM Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';
