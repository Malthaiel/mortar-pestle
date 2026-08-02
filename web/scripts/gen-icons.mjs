// Generates web/src/components/icons.jsx. THIS is the source of truth for the
// icon pack — never hand-edit the generated file; edit the MAP/SIZES/OVERRIDES
// below and re-run. Every export name is preserved so no call site changes.
//
//   node web/scripts/gen-icons.mjs [path/to/boxicons/svg]
//
// Boxicons path data is read off disk, so the pack has to be present. It is NOT
// a dependency of this repo (the app ships zero npm deps and that stays true) —
// drop it somewhere throwaway and point the script at it:
//
//   mkdir /tmp/iconpacks && cd /tmp/iconpacks && npm i boxicons
//   node web/scripts/gen-icons.mjs /tmp/iconpacks/node_modules/boxicons/svg
//
// Default location if no argument is given: <repo>/.iconpacks/node_modules/
// boxicons/svg (gitignored). The ten Font Awesome marks need no download —
// their path data is inlined in OVERRIDES.
//
// Verify a run by diffing the result against the committed file; the generator
// reproduces it exactly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT = path.join(REPO, 'web', 'src', 'components', 'icons.jsx');
const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(REPO, '.iconpacks', 'node_modules', 'boxicons', 'svg');
const FILLED = path.join(ROOT, 'solid');
const BASIC = path.join(ROOT, 'regular');

if (!fs.existsSync(FILLED)) {
  console.error(`No Boxicons pack at ${ROOT}\nRun: npm i boxicons somewhere, then pass <that>/node_modules/boxicons/svg`);
  process.exit(1);
}

// Icon export -> Boxicons Regular name. Grouped exactly as the current file is.
const MAP = {
  // Sidebar / chrome
  IconTimer: 'bx-time-five', IconChart: 'bx-bar-chart-alt-2', IconNotes: 'bx-file',
  IconTerminal: 'bx-terminal', IconBrush: 'bx-brush', IconConsole: 'bx-window-alt',
  IconBookOpen: 'bx-book-open', IconLibrary: 'bx-collection', IconGraph: 'bx-network-chart',
  IconActivity: 'bx-chart', IconStar: 'bx-star', IconCalendar: 'bx-calendar',
  IconLayoutGrid: 'bx-grid-alt', IconHome: 'bx-home', IconRotateCw: 'bx-refresh',
  IconLayers: 'bx-layer', IconHardDrive: 'bx-hdd', IconSettings: 'bx-cog',
  IconBell: 'bx-bell', IconTrash: 'bx-trash', IconDownload: 'bx-download', IconSearch: 'bx-search',
  // Non-sidebar / inline
  IconReset: 'bx-reset', IconSkip: 'bx-skip-next', IconSkipBack: 'bx-skip-previous',
  IconRewind: 'bx-rewind', IconFastForward: 'bx-fast-forward', IconPause: 'bx-pause',
  IconMaximize: 'bx-fullscreen', IconX: 'bx-x', IconCheck: 'bx-check',
  IconChevronLeft: 'bx-chevron-left', IconChevronRight: 'bx-chevron-right',
  IconSort: 'bx-sort-a-z', IconChevronsDownUp: 'bx-collapse-vertical', IconChevronsUpDown: 'bx-expand-vertical',
  IconSend: 'bx-send',
  // Knowledge areas
  IconCrosshair: 'bx-bullseye', IconFilm: 'bx-film', IconHeartPulse: 'bx-heart-circle',
  IconCpu: 'bx-chip', IconDumbbell: 'bx-dumbbell', IconCrown: 'bx-crown',
  IconVideo: 'bx-video', IconBook: 'bx-book', IconClapperboard: 'bx-movie',
  IconMusic: 'bx-music', IconVolume: 'bx-volume-full', IconLeaf: 'bx-leaf',
  IconDroplet: 'bx-droplet', IconTv: 'bx-tv',
  IconGamepad: 'bx-joystick', IconBroadcast: 'bx-radio',
  // Knowledge subfolders
  IconFolder: 'bx-folder', IconDatabase: 'bx-data', IconLock: 'bx-lock-alt',
  IconMessageSquare: 'bx-message-square', IconUser: 'bx-user', IconUsers: 'bx-group',
  IconSparkles: 'bx-bot', IconPackage: 'bx-package',
  IconHeart: 'bx-heart', IconWrench: 'bx-wrench',
  IconRepeat: 'bx-repeat', IconMap: 'bx-map-alt', IconBuilding: 'bx-building',
  IconCalculator: 'bx-calculator', IconMove: 'bx-move', IconBrain: 'bx-brain',
  IconMousePointer: 'bx-pointer', IconClock: 'bx-time-five', IconPlay: 'bx-play',
  IconFileText: 'bx-detail', IconGlobe: 'bx-globe', IconMic: 'bx-microphone',
  IconLink: 'bx-link', IconLightbulb: 'bx-bulb', IconTag: 'bx-purchase-tag',
  IconArchive: 'bx-archive', IconImage: 'bx-image', IconCheckCircle: 'bx-check-circle',
  // View-mode + file
  IconCards: 'bx-grid-alt', IconTable: 'bx-spreadsheet', IconFile: 'bx-file-blank',
  IconExternal: 'bx-link-external', IconGrip: 'bx-grid', IconSpeaker: 'bx-speaker',
  // Broadcast source-type + tree
  IconEye: 'bx-show', IconEyeOff: 'bx-hide', IconMonitor: 'bx-devices',
  IconAppWindow: 'bx-window-alt', IconCamera: 'bx-camera', IconTypeText: 'bx-text',
  IconPalette: 'bx-palette', IconPlayCircle: 'bx-play-circle',
  // Dock chrome
  IconDock: 'bx-dock-bottom', IconPlus: 'bx-plus',
  IconKeyboard: 'bx-keyboard', IconCommand: 'bx-command',
  IconSunMoon: 'bx-circle-half',
  // Folded in from modules/core/browser/vaultIcons.jsx + BrowserPage ShieldGlyph
  IconKey: 'bx-key', IconLockOpen: 'bx-lock-open-alt', IconCopy: 'bx-copy',
  IconShield: 'bx-shield', IconShieldOff: 'bx-shield-x',
  // Replacements for typed characters previously standing in for icons
  IconDot: 'bx-circle', IconAlert: 'bx-error',
};

// Default render size per icon, carried over from the current file so call
// sites that omit `size` keep the size they have today.
const SIZES = {
  IconReset: 15, IconSkip: 15, IconSkipBack: 15, IconRewind: 15, IconFastForward: 15,
  IconPause: 15, IconMaximize: 15, IconX: 10, IconCheck: 14, IconChevronLeft: 14,
  IconChevronRight: 14, IconExternal: 14, IconGrip: 14, IconPlayCircle: 14,
  IconKey: 15, IconLockOpen: 15, IconCopy: 14, IconShield: 15, IconShieldOff: 15,
  IconDot: 14, IconSend: 14,
};

// Section banners, keyed by the icon that opens each block.
const SECTIONS = {
  IconTimer:    'Sidebar / chrome icons (sized via prop; default 18)',
  IconReset:    'Non-sidebar icons (fixed default sizes for inline UI)',
  IconCrosshair:'Knowledge area icons',
  IconFolder:   'Knowledge subfolder icons',
  IconCards:    'View-mode + file icons',
  IconEye:      'Broadcast source-type + tree glyphs',
  IconDock:     'Dock chrome icons',
  IconKey:      'Password-vault + browser-shield glyphs (folded in from vaultIcons.jsx)',
  IconDot:      'Menu / notification marks (replace typed characters)',
};

const HEADER = `// Icon pack. Every icon in the app comes from here — nothing is hand-drawn.
// Path data is copied inline from the source packages; there is no runtime
// dependency. Colour flows through currentColor; \`size\` is the only knob.
//
// Two sources, and which one you use is decided by the shape, not by taste:
//
//   1. Boxicons Regular (https://boxicons.com) — MIT. The default. Draws
//      filled shapes on a 24 grid. Use it for every NAMED THING: folder,
//      clock, key, chart, shield.
//   2. Font Awesome Free 7 solid (https://fontawesome.com) — icons are
//      CC BY 4.0, credited here as the licence requires. Used ONLY for BARE
//      MARKS: tick, cross, plus, pause, the collapse/expand chevrons, sort,
//      fullscreen and the two rotate arrows. Boxicons' free tier has no filled
//      form of any of them, so each fell back to its thin Basic set and read
//      visibly lighter than every solid icon beside them. Font Awesome draws
//      the same marks much larger inside their box, so at a given \`size\` they
//      land at the same stroke thickness but ~1.7x the mark — which is what
//      makes them read as heavy.
//
// Adding an icon: find it at boxicons.com (Regular weight), copy the <path>
// out of svg/regular/<name>.svg, add one line below. Do NOT hand-draw one.
// Reach for Font Awesome only for another bare mark (plus, minus, pause) and
// only after confirming Boxicons has no filled form.
//
// Non-24 viewBoxes: pass the third \`wrap\` argument. Font Awesome authors on a
// 512-tall box of varying width, so each mark is re-framed to a 512 square by
// shifting min-x — framing only, the path data is untouched.

function wrap(size, children, viewBox = '0 0 24 24') {
  return <svg width={size} height={size} viewBox={viewBox} fill="currentColor">{children}</svg>;
}

// Font Awesome's own square framings, kept next to each other so the offsets
// are obviously (512 - nativeWidth) / 2 and not a magic number.
const FA_BOX_384 = '-64 0 512 512';
const FA_BOX_448 = '-32 0 512 512';
const FA_BOX_512 = '0 0 512 512';
`;

// Bare marks Boxicons' free tier cannot supply: `bxs-check` and `bxs-x` do not
// exist at all, and the rest fall back to the thin Basic set, which reads
// visibly lighter than the solid icons they sit beside. These ten come from
// Font Awesome Free 7 solid (icons CC BY 4.0, credited in HEADER above). Path
// data is inlined rather than read off disk so the generator keeps its single
// npm dependency on `boxicons`. The other Basic fallbacks are shapes, not bare
// marks — leave them on Boxicons.
const OVERRIDES = {
  IconX: {
    d: '<path fill="currentColor" d="M55.1 73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L147.2 256 9.9 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192.5 301.3 329.9 438.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.8 256 375.1 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192.5 210.7 55.1 73.4z"/>',
    box: 'FA_BOX_384',
    pack: 'Font Awesome solid xmark (Boxicons has no bxs-x)',
  },
  IconCheck: {
    d: '<path fill="currentColor" d="M434.8 70.1c14.3 10.4 17.5 30.4 7.1 44.7l-256 352c-5.5 7.6-14 12.3-23.4 13.1s-18.5-2.7-25.1-9.3l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l101.5 101.5 234-321.7c10.4-14.3 30.4-17.5 44.7-7.1z"/>',
    box: 'FA_BOX_448',
    pack: 'Font Awesome solid check (Boxicons has no bxs-check)',
  },
  IconPlus: {
    d: '<path fill="currentColor" d="M256 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 160-160 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l160 0 0 160c0 17.7 14.3 32 32 32s32-14.3 32-32l0-160 160 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-160 0 0-160z"/>',
    box: 'FA_BOX_448',
    pack: 'Font Awesome solid plus (Boxicons has no bxs-plus)',
  },
  IconPause: {
    d: '<path fill="currentColor" d="M48 32C21.5 32 0 53.5 0 80L0 432c0 26.5 21.5 48 48 48l64 0c26.5 0 48-21.5 48-48l0-352c0-26.5-21.5-48-48-48L48 32zm224 0c-26.5 0-48 21.5-48 48l0 352c0 26.5 21.5 48 48 48l64 0c26.5 0 48-21.5 48-48l0-352c0-26.5-21.5-48-48-48l-64 0z"/>',
    box: 'FA_BOX_384',
    pack: 'Font Awesome solid pause (Boxicons has no bxs-pause)',
  },
  IconChevronsDownUp: {
    d: '<path fill="currentColor" d="M214.6 41.4c-12.5-12.5-32.8-12.5-45.3 0l-160 160c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 109.3 329.4 246.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3l-160-160zm160 352l-160-160c-12.5-12.5-32.8-12.5-45.3 0l-160 160c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 329.4 438.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3z"/>',
    box: 'FA_BOX_384',
    pack: 'Font Awesome solid angles-up (collapse-all; Boxicons pair is Basic-only)',
  },
  IconChevronsUpDown: {
    d: '<path fill="currentColor" d="M214.6 470.6c-12.5 12.5-32.8 12.5-45.3 0l-160-160c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L192 402.7 329.4 265.4c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3l-160 160zm160-352l-160 160c-12.5 12.5-32.8 12.5-45.3 0l-160-160c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L192 210.7 329.4 73.4c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3z"/>',
    box: 'FA_BOX_384',
    pack: 'Font Awesome solid angles-down (expand-all; Boxicons pair is Basic-only)',
  },
  IconSort: {
    d: '<path fill="currentColor" d="M230.6 390.6l-80 80c-12.5 12.5-32.8 12.5-45.3 0l-80-80c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L96 370.7 96 64c0-17.7 14.3-32 32-32s32 14.3 32 32l0 306.7 25.4-25.4c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3zm182-340.9c50.7 101.3 77.3 154.7 80 160 7.9 15.8 1.5 35-14.3 42.9s-35 1.5-42.9-14.3l-7.2-14.3-88.4 0-7.2 14.3c-7.9 15.8-27.1 22.2-42.9 14.3s-22.2-27.1-14.3-42.9c2.7-5.3 29.3-58.7 80-160 5.4-10.8 16.5-17.7 28.6-17.7s23.2 6.8 28.6 17.7zM384 135.6l-20.2 40.4 40.4 0-20.2-40.4zM288 320c0-17.7 14.3-32 32-32l128 0c12.9 0 24.6 7.8 29.6 19.8s2.2 25.7-6.9 34.9L397.3 416 448 416c17.7 0 32 14.3 32 32s-14.3 32-32 32l-128 0c-12.9 0-24.6-7.8-29.6-19.8s-2.2-25.7 6.9-34.9l73.4-73.4-50.7 0c-17.7 0-32-14.3-32-32z"/>',
    box: 'FA_BOX_512',
    pack: 'Font Awesome solid arrow-down-a-z (Boxicons bx-sort-a-z is Basic-only)',
  },
  IconMaximize: {
    d: '<path fill="currentColor" d="M32 32C14.3 32 0 46.3 0 64l0 96c0 17.7 14.3 32 32 32s32-14.3 32-32l0-64 64 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L32 32zM64 352c0-17.7-14.3-32-32-32S0 334.3 0 352l0 96c0 17.7 14.3 32 32 32l96 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-64 0 0-64zM320 32c-17.7 0-32 14.3-32 32s14.3 32 32 32l64 0 0 64c0 17.7 14.3 32 32 32s32-14.3 32-32l0-96c0-17.7-14.3-32-32-32l-96 0zM448 352c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 64-64 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l96 0c17.7 0 32-14.3 32-32l0-96z"/>',
    box: 'FA_BOX_448',
    pack: 'Font Awesome solid expand (Boxicons bx-fullscreen is Basic-only)',
  },
  IconReset: {
    d: '<path fill="currentColor" d="M256 64c-56.8 0-107.9 24.7-143.1 64l47.1 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 192c-17.7 0-32-14.3-32-32L0 32C0 14.3 14.3 0 32 0S64 14.3 64 32l0 54.7C110.9 33.6 179.5 0 256 0 397.4 0 512 114.6 512 256S397.4 512 256 512c-87 0-163.9-43.4-210.1-109.7-10.1-14.5-6.6-34.4 7.9-44.6s34.4-6.6 44.6 7.9c34.8 49.8 92.4 82.3 157.6 82.3 106 0 192-86 192-192S362 64 256 64z"/>',
    box: 'FA_BOX_512',
    pack: 'Font Awesome solid arrow-rotate-left (Boxicons bx-reset is Basic-only)',
  },
  IconRotateCw: {
    d: '<path fill="currentColor" d="M436.7 74.7L448 85.4 448 32c0-17.7 14.3-32 32-32s32 14.3 32 32l0 128c0 17.7-14.3 32-32 32l-128 0c-17.7 0-32-14.3-32-32s14.3-32 32-32l47.9 0-7.6-7.2c-.2-.2-.4-.4-.6-.6-75-75-196.5-75-271.5 0s-75 196.5 0 271.5 196.5 75 271.5 0c8.2-8.2 15.5-16.9 21.9-26.1 10.1-14.5 30.1-18 44.6-7.9s18 30.1 7.9 44.6c-8.5 12.2-18.2 23.8-29.1 34.7-100 100-262.1 100-362 0S-25 175 75 75c99.9-99.9 261.7-100 361.7-.3z"/>',
    box: 'FA_BOX_512',
    pack: 'Font Awesome solid arrow-rotate-right (Boxicons bx-refresh is Basic-only)',
  },
};

const read = (dir, file) => {
  const p = path.join(dir, file + '.svg');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8')
    .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '')
    .replace(/\s+/g, ' ').trim();
};

// Filled first (it prefixes the Basic name with `bxs-`); fall back to Basic for
// the plain marks — close, tick, plus, chevrons — which have no filled form
// because they are strokes, not shapes. Both packs are Boxicons' free tier.
const body = (name) => {
  const filled = read(FILLED, name.replace(/^bx-/, 'bxs-'));
  if (filled) return { d: filled, pack: name.replace(/^bx-/, 'bxs-') };
  const basic = read(BASIC, name);
  return basic ? { d: basic, pack: `${name} (Basic — no filled form)` } : null;
};

const rule = (title) => {
  const bar = '─'.repeat(Math.max(1, 74 - title.length));
  return `\n// ── ${title} ${bar}`;
};

const missing = [];
const fellBack = [];
const lines = [];
const names = Object.keys(MAP);
const pad = Math.max(...names.map((n) => n.length));
for (const [icon, bx] of Object.entries(MAP)) {
  const over = OVERRIDES[icon];
  if (over) {
    if (SECTIONS[icon]) lines.push(rule(SECTIONS[icon]));
    lines.push(`export function ${icon.padEnd(pad)}({ size = ${SIZES[icon] || 18} }) { return wrap(size, <>${over.d}</>, ${over.box}); } // ${over.pack}`);
    continue;
  }
  const hit = body(bx);
  if (!hit) { missing.push(`${icon} -> ${bx}`); continue; }
  if (hit.pack.includes('Basic')) fellBack.push(icon);
  if (SECTIONS[icon]) lines.push(rule(SECTIONS[icon]));
  const size = SIZES[icon] || 18;
  lines.push(`export function ${icon.padEnd(pad)}({ size = ${size} }) { return wrap(size, <>${hit.d}</>); } // ${hit.pack}`);
}

const out = HEADER + lines.join('\n') + '\n';
fs.writeFileSync(OUT, out);
console.log('MISSING:', missing.length ? '\n  ' + missing.join('\n  ') : 'none');
console.log(`\nBASIC fallback (${fellBack.length}):\n  ${fellBack.join(', ')}`);
console.log('\ngenerated:', names.length - missing.length, 'icons,', out.length, 'bytes ->', path.relative(REPO, OUT));
