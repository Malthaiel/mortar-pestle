// Generates web/src/components/icons.jsx. THIS is the source of truth for the
// icon pack — never hand-edit the generated file; edit the MAP/SIZES/OVERRIDES
// below and re-run. Every export name is preserved so no call site changes.
//
//   node web/scripts/gen-icons.mjs [path/to/boxicons/svg]
//
// Boxicons path data is read off disk, so the pack has to be present. It is NOT
// a dependency of this repo (the app ships zero npm deps and that stays true) —
// install it OUTSIDE the repo and point the script at it. npm run in a folder
// with no package.json walks UP to the nearest one, so `npm i` anywhere inside
// this repo (the gitignored .iconpacks/ included) writes boxicons, and an old
// React it drags in, into the app's own package.json and lock (2026-09-25):
//
//   mkdir <dir outside the repo> && echo {} > <dir>/package.json
//   npm i boxicons --prefix <dir>
//   node web/scripts/gen-icons.mjs <dir>/node_modules/boxicons/svg
//
// Then `git status package.json package-lock.json` must be clean. Default
// location if no argument is given: <repo>/.iconpacks/node_modules/boxicons/svg
// (gitignored), only safe to fill if that folder has its own package.json. The
// Font Awesome marks need no download — their path data is inlined in OVERRIDES.
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
  IconBookOpen: 'bx-book-open', IconLibrary: 'bx-collection',
  IconActivity: 'bx-chart', IconStar: 'bx-star', IconCalendar: 'bx-calendar',
  IconLayoutGrid: 'bx-grid-alt', IconHome: 'bx-home', IconPin: 'bx-pin', IconRotateCw: 'bx-refresh',
  IconLayers: 'bx-layer', IconHardDrive: 'bx-hdd', IconSettings: 'bx-cog',
  IconBell: 'bx-bell', IconTrash: 'bx-trash', IconDownload: 'bx-download', IconSearch: 'bx-search',
  // Non-sidebar / inline
  IconReset: 'bx-reset', IconSkip: 'bx-skip-next',
  // Boxicons v3 icons, all carried in OVERRIDES — the pack read off
  // disk is v2 and has none of them. The names here are their v3 names and are
  // never looked up; an override short-circuits the disk read.
  IconRepeatSolid: 'repeat', IconPlayMark: 'play', IconSkipMark: 'skip-next',
  IconBookmarkPlus: 'bookmark-plus-alt', IconSwatch: 'swatch', IconCamcorder: 'camcoder',
  IconEarAlt: 'ear-alt', IconAnnouncement: 'announcement',
  IconListPlus: 'list-plus',
  IconSkipBack: 'bx-skip-previous',
  IconRewind: 'bx-rewind', IconFastForward: 'bx-fast-forward', IconPause: 'bx-pause',
  IconStop: 'bx-stop',
  IconMaximize: 'bx-fullscreen', IconX: 'bx-x',
  IconMinus: 'minus', IconSquare: 'bx-square', IconRestore: 'bx-copy',
  IconCheck: 'bx-check',
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
  IconMessageSquare: 'bx-message-square-dots', IconUser: 'bx-user', IconUsers: 'bx-group',
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
  IconDock: 'bx-dock-bottom', IconPlus: 'bx-plus', IconHelp: 'bx-help-circle',
  IconKeyboard: 'bx-keyboard', IconCommand: 'bx-command',
  IconSunMoon: 'bx-circle-half',
  // Folded in from modules/core/browser/vaultIcons.jsx + BrowserPage ShieldGlyph
  IconKey: 'bx-key', IconLockOpen: 'bx-lock-open-alt', IconCopy: 'bx-copy',
  // Context-menu clipboard rows
  IconCut: 'bx-cut', IconPaste: 'bx-paste', IconSelectAll: 'bx-select-multiple',
  IconShield: 'bx-shield', IconShieldOff: 'bx-shield-x',
  // Replacements for typed characters previously standing in for icons
  IconDot: 'bx-circle', IconAlert: 'bx-error',
};

// Default render size per icon, carried over from the current file so call
// sites that omit `size` keep the size they have today.
const SIZES = {
  IconReset: 15, IconSkip: 15, IconSkipBack: 15, IconRewind: 15, IconFastForward: 15,
  IconPause: 15, IconStop: 15, IconMaximize: 15, IconX: 10, IconCheck: 14, IconChevronLeft: 14,
  IconChevronRight: 14, IconExternal: 14, IconGrip: 14, IconPlayCircle: 14,
  IconKey: 15, IconLockOpen: 15, IconCopy: 14, IconShield: 15, IconShieldOff: 15,
  IconDot: 14, IconSend: 14,
  IconRepeatSolid: 14, IconPlayMark: 14, IconSkipMark: 14, IconListPlus: 14,
  IconBookmarkPlus: 14, IconSwatch: 14, IconCamcorder: 14, IconEarAlt: 14, IconAnnouncement: 14,
  IconMinus: 10, IconSquare: 10, IconRestore: 10,
  IconCut: 14, IconPaste: 14, IconSelectAll: 14,
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
  IconCut:      'Clipboard glyphs (context-menu rows: Cut / Paste / Select All)',
  IconDot:      'Menu / notification marks (replace typed characters)',
};

// Comment blocks printed right above an icon (after its section banner), for
// icons whose source or fill rule needs explaining where the icon lives.
const NOTES = {
  IconMessageSquare: `// bxs-message-square-DOTS, not the bare bxs-message-square it was until
// 2026-09-15: the plain one has no tail and no cut-outs, so at the 16px the
// titlebar's Feedback button draws it, it read as a blank rounded blob rather
// than a message. fillRule evenodd knocks the three dots out — the sub-paths
// wind the same way as the shell, so the default nonzero fill would swallow
// them and put the blob straight back.`,
  IconHelp: `// The titlebar's Help button. bxs-help-circle is a filled disc with the query
// mark CUT OUT of it, so it needs fillRule evenodd for the same reason
// IconMessageSquare does — nonzero fill swallows the knock-out and leaves a
// plain dot. Path copied from boxicons 2.1.4 solid.`,
  IconCut: `// Cut is the ONE exception to the solid rule: Boxicons ships no bxs-cut, so the
// Regular scissors is the only form of the mark that exists.`,
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
//      MARKS: tick, cross, plus, pause, stop, the collapse/expand chevrons,
//      sort, fullscreen, the two rotate arrows. Boxicons' free tier has no filled
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
  // ── Boxicons v3 bare marks ──────────────────────────────────────────────────
  // Chosen 2026-09-20 for the Planner clock underside run. The generator reads
  // Boxicons v2 off disk and v2 has no filled play or skip at all, which is why
  // the v2 IconPlay/IconSkip fall back to the thin Basic set and paint a mark
  // roughly a third the size of a solid one beside them. These four are v3, so
  // their path data is inlined here the same way the Font Awesome marks are.
  //
  // DO NOT retune the v2 IconPlay/IconSkip to match: PlannerDock hand-compensates
  // for how small they draw ("bx 24 box, path y 6..18 -> 0.50 of the box"), and
  // changing the glyph would double those icons.
  //
  // `size` is a viewBox scale, not a painted size — each of these fills its 24 box
  // differently, so one size across a row paints four different marks. Measured at
  // size 14: repeat 12 across, play 7, skip-next 8, list-plus 10. A row that wants
  // them even passes a size per icon and checks the result on a photograph; the
  // clock underside uses 14 / 20 / 22 / 18 for a painted height of 12 rows.
  IconRepeatSolid: {
    d: '<path d="M17 5H6c-1.1 0-2 .9-2 2v5h2V7h11v3l5-4-5-4zm1 12H7v-3l-5 4 5 4v-3h11c1.1 0 2-.9 2-2v-5h-2z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 repeat',
  },
  IconPlayMark: {
    d: '<path d="M6.51 18.87c.15.09.32.13.49.13s.36-.05.51-.14l10-6c.3-.18.49-.51.49-.86s-.18-.68-.49-.86l-10-6a.99.99 0 0 0-1.01-.01c-.31.18-.51.51-.51.87v12c0 .36.19.69.51.87Z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 play',
  },
  IconSkipMark: {
    d: '<path d="m14.58 11.19-7-5c-.31-.22-.71-.25-1.04-.08S6 6.62 6 7v10c0 .37.21.72.54.89.14.07.3.11.46.11.21 0 .41-.06.58-.19l7-5c.26-.19.42-.49.42-.81s-.16-.63-.42-.81M16 6h2v12h-2z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 skip-next',
  },
  IconListPlus: {
    d: '<path d="M4 11h11v2H4zm0-5h16v2H4zm0 10h8v2H4zm15-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 list-plus',
  },
  // Album song-row parts (2026-09-26), picked live from Boxicons v3 SVGs in
  // Downloads: playlist, queue, video, own listens, world plays.
  IconBookmarkPlus: {
    d: '<path d="M18.5 2h-12C4.57 2 3 3.57 3 5.5V21c0 .35.18.67.47.85s.66.2.97.04l5.55-2.78 5.55 2.78a.997.997 0 0 0 1.45-.89v-8h4c.55 0 1-.45 1-1V5.5c0-1.93-1.57-3.5-3.5-3.5ZM13 11h-2v2H9v-2H7V9h2V7h2v2h2zm7 0h-3V5.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 bookmark-plus-alt',
  },
  IconSwatch: {
    d: '<path d="M10 5.51V4c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v9.51l1.85-1.85zM18.16 3c-.78-.78-2.05-.78-2.83 0l-8.99 9h11.33l3.34-3.34c.78-.78.78-2.05 0-2.83l-2.84-2.84ZM6 22h14c1.1 0 2-.9 2-2v-4c0-1.1-.9-2-2-2H6c-2.21 0-4 1.79-4 4s1.79 4 4 4m0-5.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5-1.5-.67-1.5-1.5.67-1.5 1.5-1.5"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 swatch',
  },
  IconCamcorder: {
    d: '<path d="M18 10c0-1.1-.9-2-2-2h-1.43l-2.71-4.51c-.18-.3-.51-.49-.86-.49H5v2h5.43l1.8 3H4c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3l4 2v-7l-4 2zm-6 7H6v-2h6z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 camcoder',
  },
  IconEarAlt: {
    d: '<path d="M12 2c-4.41 0-8 3.59-8 8v7c0 2.76 2.24 5 5 5 1.91 0 2.99-1.25 4.25-2.69.45-.51.91-1.04 1.46-1.6.47-.47 1.04-.83 1.63-1.21C18.06 15.41 20 14.17 20 10c0-4.41-3.59-8-8-8m3 8c0-1.65-1.35-3-3-3s-3 1.35-3 3c2.76 0 5 2.24 5 5h-2c0-1.65-1.35-3-3-3v3H7v-5c0-2.76 2.24-5 5-5s5 2.24 5 5z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 ear-alt',
  },
  IconAnnouncement: {
    d: '<path d="M18.5 10H22v2h-3.5zm.05-1.17 1.5-1 1.5-1L21 6l-.55-.83-1.5 1-1.5 1L18 8zm0 4.34L18 14l-.55.83 1.5 1 1.5 1L21 16l.55-.83-1.5-1zM15 8.18V4c0-.37-.2-.71-.53-.88-.32-.17-.72-.16-1.03.05L7.69 7h-1.7c-2.21 0-4 1.79-4 4 0 1.52.86 2.82 2.1 3.5l1.94 6.77 1.92-.55-1.64-5.73h1.37l5.75 3.83c.17.11.36.17.55.17.16 0 .32-.04.47-.12.33-.17.53-.51.53-.88v-4.18c1.16-.41 2-1.51 2-2.82s-.84-2.4-2-2.82Z"/>',
    box: "'0 0 24 24'",
    pack: 'Boxicons v3 announcement',
  },
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
  IconStop: {
    d: '<path fill="currentColor" d="M64 32l320 0c35.3 0 64 28.7 64 64l0 320c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32z"/>',
    box: 'FA_BOX_448',
    pack: 'Font Awesome solid stop (Boxicons has no bxs-stop)',
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
  // ── Hand-picked forms (titlebar marks, clipboard rows, knock-out fills) ──
  // These were first hand-added to icons.jsx and folded back in here
  // 2026-09-25, so a regeneration keeps them. Each carries its exact path.
  IconMinus: {
    d: '<path fill="currentColor" d="M432 256c0 17.7-14.3 32-32 32L48 288c-17.7 0-32-14.3-32-32s14.3-32 32-32l352 0c17.7 0 32 14.3 32 32z"/>',
    box: 'FA_BOX_448',
    pack: 'Font Awesome solid minus (bare mark — Boxicons has no bxs-minus)',
  },
  IconSquare: {
    d: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2zM4 4h16v16H4V4z"/>',
    pack: 'bx-square (outlined by design — the titlebar maximize mark)',
  },
  IconRestore: {
    d: '<path d="M20 2H10a2 2 0 0 0-2 2v4H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4h4a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM4 20V10h10l.002 10H4zm16-6h-4v-4a2 2 0 0 0-2-2h-4V4h10v10z"/>',
    pack: 'bx-copy (two offset frames — the titlebar restore mark)',
  },
  IconMessageSquare: {
    d: '<path fillRule="evenodd" d="M16 2H8C4.691 2 2 4.691 2 8v13a1 1 0 0 0 1 1h13c3.309 0 6-2.691 6-6V8c0-3.309-2.691-6-6-6zM8 13a1.5 1.5 0 1 1 .001-3.001A1.5 1.5 0 0 1 8 13zm4 0a1.5 1.5 0 1 1 .001-3.001A1.5 1.5 0 0 1 12 13zm4 0a1.5 1.5 0 1 1 .001-3.001A1.5 1.5 0 0 1 16 13z"/>',
    pack: 'bxs-message-square-dots',
  },
  IconHelp: {
    d: '<path fillRule="evenodd" d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm1 16h-2v-2h2v2zm.976-4.885c-.196.158-.385.309-.535.459-.408.407-.44.777-.441.793v.133h-2v-.167c0-.118.029-1.177 1.026-2.174.195-.195.437-.393.691-.599.734-.595 1.216-1.029 1.216-1.627a1.934 1.934 0 0 0-3.867.001h-2C8.066 7.765 9.831 6 12 6s3.934 1.765 3.934 3.934c0 1.597-1.179 2.55-1.958 3.181z"/>',
    pack: 'bxs-help-circle',
  },
  IconCut: {
    d: '<path d="M10 6.5C10 4.57 8.43 3 6.5 3S3 4.57 3 6.5 4.57 10 6.5 10a3.45 3.45 0 0 0 1.613-.413l2.357 2.528-2.318 2.318A3.46 3.46 0 0 0 6.5 14C4.57 14 3 15.57 3 17.5S4.57 21 6.5 21s3.5-1.57 3.5-3.5c0-.601-.166-1.158-.434-1.652l2.269-2.268L17 19.121a3 3 0 0 0 2.121.879H22L9.35 8.518c.406-.572.65-1.265.65-2.018zM6.5 8C5.673 8 5 7.327 5 6.5S5.673 5 6.5 5 8 5.673 8 6.5 7.327 8 6.5 8zm0 11c-.827 0-1.5-.673-1.5-1.5S5.673 16 6.5 16s1.5.673 1.5 1.5S7.327 19 6.5 19z"/><path d="m17 4.879-3.707 4.414 1.414 1.414L22 4h-2.879A3 3 0 0 0 17 4.879z"/>',
    pack: 'bx-cut (no solid form exists)',
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
  const hit = over || body(bx);
  if (!hit) { missing.push(`${icon} -> ${bx}`); continue; }
  if (!over && hit.pack.includes('Basic')) fellBack.push(icon);
  if (SECTIONS[icon]) lines.push(rule(SECTIONS[icon]));
  if (NOTES[icon]) lines.push(NOTES[icon]);
  // An override on the plain 24 box leaves `box` out, so no third argument.
  const box = hit.box ? `, ${hit.box}` : '';
  lines.push(`export function ${icon.padEnd(pad)}({ size = ${SIZES[icon] || 18} }) { return wrap(size, <>${hit.d}</>${box}); } // ${hit.pack}`);
}

const out = HEADER + lines.join('\n') + '\n';
fs.writeFileSync(OUT, out);
console.log('MISSING:', missing.length ? '\n  ' + missing.join('\n  ') : 'none');
console.log(`\nBASIC fallback (${fellBack.length}):\n  ${fellBack.join(', ')}`);
console.log('\ngenerated:', names.length - missing.length, 'icons,', out.length, 'bytes ->', path.relative(REPO, OUT));
