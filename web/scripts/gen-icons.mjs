// Generates web/src/components/icons.jsx. THIS is the source of truth for the
// icon pack — never hand-edit the generated file; edit MAP/SIZES below and
// re-run. Every export name is preserved so no call site changes.
//
//   node web/scripts/gen-icons.mjs
//
// One source: the Boxicons v3 Filled free set, all 1,884 files, copied into
// web/src/assets/icons/filled/ (2026-09-28). The whole folder lives in the repo
// so any icon can be added by name; icons.jsx carries only the ones MAP names.
// The right-click icon pickers read the full folder lazily (iconLibrary.js).
// No npm package, no other pack, no hand-drawn marks.
//
// Verify a run by diffing the result against the committed file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT = path.join(REPO, 'web', 'src', 'components', 'icons.jsx');
const DIR = path.join(REPO, 'web', 'src', 'assets', 'icons', 'filled');

// Icon export -> file stem in DIR (bx-<stem>.svg). Grouped as the file is.
const MAP = {
  // Sidebar / chrome
  IconTimer: 'timer', IconChart: 'bar-chart', IconNotes: 'file-detail',
  IconTerminal: 'terminal', IconBrush: 'brush', IconConsole: 'window',
  IconBookOpen: 'book-open', IconLibrary: 'book-library',
  IconActivity: 'line-chart-square', IconStar: 'star', IconCalendar: 'calendar',
  IconLayoutGrid: 'grid', IconHome: 'home', IconPin: 'pin', IconRotateCw: 'rotate-cw',
  IconLayers: 'layers', IconHardDrive: 'hard-drive', IconSettings: 'cog',
  IconBell: 'bell', IconTrash: 'trash', IconDownload: 'arrow-to-bottom', IconSearch: 'search',
  // Non-sidebar / inline
  IconReset: 'rotate-ccw', IconSkip: 'skip-next',
  IconRepeatSolid: 'repeat', IconPlayMark: 'play', IconSkipMark: 'skip-next',
  IconBookmarkPlus: 'bookmark-plus-alt', IconSwatch: 'swatch', IconDiscussion: 'discussion', IconCamcorder: 'camcoder',
  IconEarAlt: 'ear-alt', IconAnnouncement: 'announcement',
  IconGroup: 'group', IconCopyPlus: 'copy-plus',
  IconPaperPlane: 'paper-plane', IconFire: 'fire', IconFingerUp: 'finger-up',
  IconTrophyStar: 'trophy-star', IconMedalStar: 'medal-star', IconRocket: 'rocket',
  IconHandRock: 'hand-rock', IconBookmarkAlt: 'bookmark-alt', IconFireAlt: 'fire-alt', IconStarMark: 'star',
  IconHot: 'hot', IconArrowBigDown: 'arrow-big-down', IconPlusBig: 'plus-big',
  IconRadio: 'radio', IconListPlus: 'list-plus',
  IconSkipBack: 'skip-previous',
  IconRewind: 'rewind', IconFastForward: 'fast-forward', IconPause: 'pause',
  IconStop: 'stop',
  IconMaximize: 'fullscreen', IconX: 'x',
  IconMinus: 'minus', IconSquare: 'square', IconRestore: 'copy',
  IconCheck: 'check',
  IconChevronLeft: 'chevron-left', IconChevronRight: 'chevron-right',
  IconCaretDown: 'caret-big-down', IconCaretRight: 'caret-big-right', IconCaretUp: 'caret-big-up', IconCaretLeft: 'caret-big-left',
  IconArrowUp: 'arrow-up', IconArrowDown: 'arrow-down',
  IconSort: 'arrow-down-a-z', IconChevronsDownUp: 'chevrons-up', IconChevronsUpDown: 'chevrons-down',
  IconSend: 'send',
  // Knowledge areas
  IconCrosshair: 'bullseye', IconFilm: 'film', IconHeartPulse: 'heart-circle',
  IconCpu: 'chip', IconDumbbell: 'dumbbell', IconCrown: 'crown',
  IconVideo: 'video', IconBook: 'book', IconClapperboard: 'movie',
  IconMusic: 'music', IconVolume: 'volume-full', IconLeaf: 'leaf',
  IconDroplet: 'water-drop', IconTv: 'tv',
  IconGamepad: 'joystick', IconBroadcast: 'broadcast',
  // Knowledge subfolders
  IconFolder: 'folder', IconDatabase: 'database', IconLock: 'lock',
  IconUser: 'user', IconUsers: 'group',
  IconBot: 'robot', IconPackage: 'package',
  IconHeart: 'heart', IconWrench: 'spanner',
  IconRepeat: 'repeat', IconMap: 'map', IconBuilding: 'building',
  IconCalculator: 'calculator', IconMove: 'move', IconBrain: 'brain',
  IconMousePointer: 'cursor', IconClock: 'clock', IconPlay: 'play',
  IconFileText: 'file-detail', IconGlobe: 'globe', IconMic: 'microphone',
  IconLink: 'link', IconLightbulb: 'light-bulb', IconTag: 'tag',
  IconArchive: 'archive', IconImage: 'image', IconCheckCircle: 'check-circle',
  // View-mode + file
  IconCards: 'grid', IconTable: 'table', IconFile: 'file',
  IconExternal: 'arrow-out-up-right-square', IconGrip: 'grid-9', IconSpeaker: 'speaker',
  // Broadcast source-type + tree
  IconEye: 'eye', IconEyeOff: 'eye-slash', IconMonitor: 'devices',
  IconAppWindow: 'window', IconCamera: 'camera', IconTypeText: 'font-family',
  IconPalette: 'palette', IconPlayCircle: 'play-circle',
  // Dock chrome
  IconDock: 'dock-bottom', IconPlus: 'plus-big', IconHelp: 'help-circle',
  IconKeyboard: 'keyboard', IconCommand: 'command',
  IconSunMoon: 'circle-half',
  // Password vault + browser shield
  IconKey: 'key', IconLockOpen: 'lock-open-alt', IconCopy: 'copy',
  // Context-menu clipboard rows
  IconCut: 'cut', IconPaste: 'paste', IconSelectAll: 'select-all',
  IconShield: 'shield', IconShieldOff: 'x-shield',
  // Replacements for typed characters previously standing in for icons
  IconDot: 'circle', IconAlert: 'alert-triangle',
  IconArrowLeft: 'arrow-left-stroke', IconArrowRight: 'arrow-right-stroke',
  IconPencil: 'pencil', IconSparkle: 'sparkle', IconSwap: 'swap-horizontal',
  IconKeyframe: 'keyframe', IconRadioOn: 'radio-circle', IconRadioOff: 'radio-circle-marked',
  IconShuffle: 'shuffle', IconBlock: 'block',
  // Left-sidebar rows (every sidebar button carries an icon)
  IconDashboard: 'dashboard', IconChecklist: 'checklist', IconForkKnife: 'fork-knife',
  IconPauseCircle: 'pause-circle', IconXCircle: 'x-circle', IconList: 'list-ul', IconCloud: 'cloud',
  IconEqualizer: 'equalizer', IconDockLeft: 'dock-left', IconDockRight: 'dock-right',
  IconSliders: 'slider-alt', IconDesktop: 'desktop', IconRecycle: 'recycle',
  IconCube: 'cube', IconBlocks: 'blocks', IconMagicWand: 'magic-wand', IconExtension: 'extension',
  IconBriefcase: 'briefcase', IconCommunity: 'community', IconChat: 'message-bubble-dots',
  IconHeadset: 'headphone-mic', IconHistory: 'history', IconSidebar: 'sidebar',
  IconServer: 'server', IconShare: 'share', IconNotebook: 'note-book', IconLayout: 'layout',
};

// Default render size per icon, carried over so call sites that omit `size`
// keep the box they have today. `size` is a viewBox scale, not a painted size:
// thin marks (x, check, minus) paint small, so tune them from a photograph.
const SIZES = {
  IconReset: 15, IconSkip: 15, IconSkipBack: 15, IconRewind: 15, IconFastForward: 15,
  IconPause: 15, IconStop: 15, IconMaximize: 15, IconX: 10, IconCheck: 14, IconChevronLeft: 14,
  IconChevronRight: 14, IconExternal: 14, IconGrip: 14, IconPlayCircle: 14,
  IconCaretDown: 14, IconCaretRight: 14, IconCaretUp: 14, IconArrowUp: 14, IconArrowDown: 14,
  IconKey: 15, IconLockOpen: 15, IconCopy: 14, IconShield: 15, IconShieldOff: 15,
  IconDot: 14, IconSend: 14,
  IconRepeatSolid: 14, IconPlayMark: 14, IconSkipMark: 14, IconListPlus: 14,
  IconBookmarkPlus: 14, IconSwatch: 14, IconDiscussion: 14, IconCamcorder: 14, IconEarAlt: 14, IconAnnouncement: 14,
  IconRocket: 14, IconFire: 14, IconPaperPlane: 14, IconFingerUp: 14,
  IconHandRock: 14, IconBookmarkAlt: 14, IconFireAlt: 14, IconStarMark: 14,
  IconHot: 14, IconArrowBigDown: 14, IconPlusBig: 14,
  IconGroup: 14, IconCopyPlus: 14, IconTrophyStar: 14, IconMedalStar: 14, IconRadio: 14,
  IconMinus: 10, IconSquare: 10, IconRestore: 10,
  IconCut: 14, IconPaste: 14, IconSelectAll: 14,
};

// Painted-size match for bare marks. The old pack drew these (Font Awesome,
// v2 Basic) at a different share of their box than these files, and ~90% of
// call sites pass their own `size`, so SIZES can't carry it. Each factor is
// measured, not guessed: old ink box / new ink box at the same size, rendered
// headless (2026-09-28). The box is cropped (>1, mark grows) or padded (<1)
// around its centre, so every call site keeps today's painted size.
const ZOOM = {
  IconX: 1.25, IconCheck: 1.2, IconChevronLeft: 1.22, IconChevronRight: 1.22,
  IconChevronsDownUp: 1.63, IconChevronsUpDown: 1.63, IconPause: 1.77, IconStop: 1.77,
  IconMaximize: 1.18, IconSquare: 1.13, IconReset: 1.2, IconRotateCw: 1.2,
  IconSkip: 0.83, IconSkipBack: 0.83, IconRewind: 0.88, IconFastForward: 0.88, IconPlay: 0.86,
};
const box = (z) => { const w = +(24 / z).toFixed(2), o = +(12 - w / 2).toFixed(2); return `${o} ${o} ${w} ${w}`; };

// Section banners, keyed by the icon that opens each block.
const SECTIONS = {
  IconTimer:    'Sidebar / chrome icons (sized via prop; default 18)',
  IconReset:    'Non-sidebar icons (fixed default sizes for inline UI)',
  IconCrosshair:'Knowledge area icons',
  IconFolder:   'Knowledge subfolder icons',
  IconCards:    'View-mode + file icons',
  IconEye:      'Broadcast source-type + tree glyphs',
  IconDock:     'Dock chrome icons',
  IconKey:      'Password-vault + browser-shield glyphs',
  IconCut:      'Clipboard glyphs (context-menu rows: Cut / Paste / Select All)',
  IconDot:      'Menu / notification marks (replace typed characters)',
};

const HEADER = `// Icon pack. Every icon in the app comes from here — nothing is hand-drawn.
// GENERATED by web/scripts/gen-icons.mjs — edit its MAP, never this file.
//
// One source: Boxicons v3 Filled (https://boxicons.com, free tier), read from
// web/src/assets/icons/filled/. Each export's trailing comment names its file.
// Colour flows through currentColor; \`size\` is the only knob, and it scales
// the 24 box, not the mark — thin marks paint smaller at the same size. A few
// bare marks carry a cropped/padded viewBox (ZOOM) to keep today's painted size.

// A string size ('0.9em') sizes the mark to the text around it — how typed
// glyphs (× ✓ ▶) were swapped for icons — and sets it on the text's middle.
const INLINE = { verticalAlign: '-0.15em' };
function wrap(size, children, viewBox = '0 0 24 24') {
  return <svg width={size} height={size} viewBox={viewBox} fill="currentColor" style={typeof size === 'string' ? INLINE : undefined}>{children}</svg>;
}
`;

// Inner markup of one file: drop the <svg> shell, the licence comment and the
// meaningless class="b" some paths carry (JSX would reject `class`).
const read = (stem) => {
  const p = path.join(DIR, `bx-${stem}.svg`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8')
    .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\sclass="[^"]*"/g, '')
    .replace(/\s+/g, ' ').trim();
};

const rule = (title) => `\n// ── ${title} ${'─'.repeat(Math.max(1, 74 - title.length))}`;

const missing = [];
const lines = [];
const names = Object.keys(MAP);
const pad = Math.max(...names.map((n) => n.length));
for (const [icon, stem] of Object.entries(MAP)) {
  const d = read(stem);
  if (!d) { missing.push(`${icon} -> bx-${stem}.svg`); continue; }
  if (SECTIONS[icon]) lines.push(rule(SECTIONS[icon]));
  lines.push(`export function ${icon.padEnd(pad)}({ size = ${SIZES[icon] || 18} }) { return wrap(size, <>${d}</>${ZOOM[icon] ? `, '${box(ZOOM[icon])}'` : ''}); } // bx-${stem}`);
}

if (missing.length) {
  console.error('MISSING (nothing written):\n  ' + missing.join('\n  '));
  process.exit(1);
}
const out = HEADER + lines.join('\n') + '\n';
fs.writeFileSync(OUT, out);
console.log('generated:', names.length, 'icons,', out.length, 'bytes ->', path.relative(REPO, OUT));
