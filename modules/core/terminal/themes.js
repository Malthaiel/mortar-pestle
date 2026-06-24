// Terminal appearance — a single fixed look: Zed's terminal. The palette is
// Zed's built-in "Gruvbox Dark" theme (the medium-contrast variant), copied
// verbatim from zed-industries/zed assets/themes/gruvbox/gruvbox.json. These are
// the 16 ANSI slots Claude Code paints its diffs, syntax, and status text
// through, plus background/foreground/cursor/selection — so a TUI's authored
// colors land exactly as they do in Zed (xterm renders truecolor untouched).
//
// Verified hex values (every one confirmed against the source JSON):
//   terminal.background #282828   terminal.foreground #ebdbb2
//   cursor = players[0].cursor #83a598   selection = players[0].selection #83a5983d (~24% alpha — KEEP it)

export const GRUVBOX_THEME = {
  background: '#151411',            // deviation from Zed's #282828 — user wants the darker Claude-module bg
  foreground: '#ebdbb2',
  cursor: '#83a598',
  cursorAccent: '#151411',          // glyph drawn under the block cursor = bg
  selectionBackground: '#83a5983d', // 8-digit RGBA — the alpha is load-bearing

  // ANSI normal (terminal.ansi.*)
  black: '#282828',
  red: '#bf584d',                   // deviation from Zed's #cc241d — user wants a softer/muted red (affects all ANSI-red incl. "bypass permissions on")
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',

  // ANSI bright (terminal.ansi.bright_*)
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#fbf1c7',

  // Gruvbox-toned scrollbar slider (backs the .xterm-viewport scrollbar)
  scrollbarSliderBackground: '#50494566',
  scrollbarSliderHoverBackground: '#665c5499',
  scrollbarSliderActiveBackground: '#7c6f64cc',
};

// Curated monospace families — all installed Nerd Font Mono variants on this
// machine (so they carry the box-drawing / powerline / icon glyphs Claude Code
// uses). Lilex is Zed's default mono (.ZedMono → Lilex) and is the default here.
// The value is the exact fontconfig family name.
export const TERMINAL_FONTS = [
  { value: 'Lilex Nerd Font Mono', label: 'Lilex (Zed)' },
  { value: 'GeistMono Nerd Font Mono', label: 'Geist Mono' },
  { value: 'JetBrainsMono Nerd Font Mono', label: 'JetBrains Mono' },
  { value: 'CommitMono Nerd Font Mono', label: 'Commit Mono' },
  { value: 'CaskaydiaCove Nerd Font Mono', label: 'Cascadia Code' },
  { value: 'FiraCode Nerd Font Mono', label: 'Fira Code' },
  { value: 'Hack Nerd Font Mono', label: 'Hack' },
  { value: 'IosevkaTerm Nerd Font Mono', label: 'Iosevka Term' },
  { value: 'DM Mono', label: 'DM Mono' },
];
export const DEFAULT_TERMINAL_FONT = 'Lilex Nerd Font Mono';

// Full xterm fontFamily string for the chosen family, with safe fallbacks.
export function fontFamilyFor(font) {
  const chosen = (font || DEFAULT_TERMINAL_FONT).replace(/['"]/g, '');
  if (chosen === 'Lilex Nerd Font Mono') return '"Lilex Nerd Font Mono", ui-monospace, monospace';
  return `"${chosen}", "Lilex Nerd Font Mono", ui-monospace, monospace`;
}
