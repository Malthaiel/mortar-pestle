// Every context-menu row carries a glyph — user-directed 2026-08-10, "i want
// every option to have a bxn icon and words". Most rows already pass their own
// `icon`; this resolves the rest.
//
// It is keyed on the LABEL rather than swept into the 28 call sites, and that is
// deliberate: half the labels are built at runtime (a playlist's name, "Save to
// Saved Tracks", "Add <block name>"), so a per-call-site sweep would still need
// a rule for those. One table, three passes:
//
//   1. exact label            — the fixed vocabulary the builders emit
//   2. first matching pattern — prefixes, which is what catches runtime labels
//   3. FALLBACK               — never a bare row
//
// A renamed label degrades to the fallback glyph, never to a crash or a gap.
// Add the new name here when that happens.
import {
  IconCut, IconCopy, IconPaste, IconSelectAll, IconTrash, IconX, IconDot,
  IconFileText, IconFolder, IconFile, IconExternal, IconLink, IconPlus,
  IconSearch, IconSparkles, IconCommand, IconSettings, IconRotateCw, IconWrench,
  IconMove, IconSend, IconCards, IconHeart, IconDownload,
  IconSort, IconLayers, IconLayoutGrid, IconVolume, IconMonitor, IconEyeOff,
  IconTerminal, IconTypeText,
} from '../components/icons.jsx';

// The row's glyph when nothing else matches — a bare mark, so an unmapped row
// reads as "no particular action" rather than as the wrong action.
export const FALLBACK = IconDot;

const EXACT = {
  // clipboard (buildEditableMenu / buildSelectionMenu)
  Cut: IconCut,
  Copy: IconCopy,
  Paste: IconPaste,
  'Paste as plain text': IconPaste,
  'Select All': IconSelectAll,
  // chrome (buildGenericMenu + the dev row)
  'Command Palette': IconCommand,
  'Settings': IconSettings,
  Reload: IconRotateCw,
  'Inspect Element': IconTerminal,
  'Search vault': IconSearch,
  'Ask Concierge': IconSparkles,
  'Quick actions': IconCommand,
  Window: IconMonitor,
  // links + files
  'Open in Obsidian': IconExternal,
  'Reveal in Files': IconFolder,
  'Copy link text': IconCopy,
  'New note': IconFileText,
  'New folder': IconFolder,
  'New domain': IconPlus,
  'Reconfigure': IconWrench,
  // library / music
  'Add to playlist': IconCards,
  Download: IconDownload,
  // planner / studio / editor
  'Edit': IconTypeText,
  Properties: IconSettings,
  Order: IconSort,
  'Send to': IconSend,
  Duplicate: IconCopy,
  'Set as program': IconMonitor,
  'Hide from dock': IconEyeOff,
  Gain: IconVolume,
  'Blade here': IconCut,
  'Trim start to playhead': IconCut,
  'Trim end to playhead': IconCut,
  'Add group': IconLayers,
  'Rename group': IconLayers,
  Ungroup: IconLayers,
  'Apply 3-zone layout': IconLayoutGrid,
  Left: IconMove,
  Center: IconMove,
  Right: IconMove,
};

// First match wins, so the specific rules sit above the loose ones.
const PATTERNS = [
  [/^Delete|^Remove \+ delete/i, IconTrash],
  [/^Remove/i, IconX],
  [/^(Save to|Remove from Saved)/i, IconHeart],
  [/^Rename/i, IconFile],
  [/^Copy (link|path|url)/i, IconLink],
  [/^Copy/i, IconCopy],
  [/^Open/i, IconFileText],
  [/^Move/i, IconMove],
  [/^New /i, IconPlus],
  [/^Add to/i, IconCards],
  [/^Add/i, IconPlus],
  [/^Download/i, IconDownload],
  [/^Search/i, IconSearch],
  [/^Edit/i, IconTypeText],
  // Dead rows that exist only so the right-click isn't swallowed ("No actions",
  // "Saved Tracks can't be deleted"). A bare mark is the honest glyph for them.
  [/^(No |.*can.t be)/i, IconDot],
];

/** The glyph for a row: its own `icon` if it brought one, else the table. */
export function iconFor(item) {
  if (item.icon) return item.icon;
  const label = typeof item.label === 'string' ? item.label : '';
  if (EXACT[label]) return EXACT[label];
  const hit = PATTERNS.find(([re]) => re.test(label));
  return hit ? hit[1] : FALLBACK;
}
