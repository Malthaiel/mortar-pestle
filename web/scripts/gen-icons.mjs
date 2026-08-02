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
// boxicons/svg (gitignored). The two Font Awesome marks need no download —
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
//      MARKS — the tick and the cross. Boxicons' free tier has no filled
//      form of either (\`bxs-check\` and \`bxs-x\` do not exist), so those fell
//      back to its thin Basic set and read visibly lighter than every solid
//      icon beside them. Font Awesome draws the same marks much larger inside
//      their box, so at a given \`size\` they land at the same stroke thickness
//      but ~1.7x the mark — which is what makes them read as heavy.
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
const FA_CHECK_BOX = '-32 0 512 512';  // native 448 wide
const FA_XMARK_BOX = '-64 0 512 512';  // native 384 wide
`;

// Bare marks Boxicons' free tier cannot supply: `bxs-check` and `bxs-x` do not
// exist, and the Basic fallbacks read visibly lighter than the solid icons they
// sit beside. These two come from Font Awesome Free 7 solid (icons CC BY 4.0,
// credited in HEADER above). Path data is inlined rather than read off disk so
// the generator keeps its single npm dependency on `boxicons`.
const OVERRIDES = {
  IconX: {
    d: '<path d="M55.1 73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L147.2 256 9.9 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192.5 301.3 329.9 438.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.8 256 375.1 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192.5 210.7 55.1 73.4z"/>',
    box: 'FA_XMARK_BOX',
    pack: 'Font Awesome solid xmark (Boxicons has no bxs-x)',
  },
  IconCheck: {
    d: '<path d="M434.8 70.1c14.3 10.4 17.5 30.4 7.1 44.7l-256 352c-5.5 7.6-14 12.3-23.4 13.1s-18.5-2.7-25.1-9.3l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l101.5 101.5 234-321.7c10.4-14.3 30.4-17.5 44.7-7.1z"/>',
    box: 'FA_CHECK_BOX',
    pack: 'Font Awesome solid check (Boxicons has no bxs-check)',
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
