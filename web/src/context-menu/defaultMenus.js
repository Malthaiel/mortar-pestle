// Pure builders + the target classifier for the app-wide context menu's DEFAULT
// menus — what shows when no surface claimed the right-click. No React here.
//
//   classifyTarget(target) -> 'editable' | 'link' | 'generic'
//   buildEditableMenu(target)   clipboard ops for the focused text field
//   buildLinkMenu(anchorEl)     wikilink/link actions (open / copy / reveal / obsidian)
//   buildGenericMenu(ctx)       app-chrome actions (palette / settings / reload)
//
// Richer file actions (sidebar files/folders) arrive in SF9; SF1 added icons +
// danger, SF7 fleshed out the link menu.

import { IconCommand, IconSettings, IconRotateCw, IconExternal, IconFolder, IconLink, IconFileText, IconFile, IconPlus, IconX, IconSearch, IconSparkles } from '../components/icons.jsx';
import { invoke, api } from '../api.js';
import { navigate } from '../router.js';
import { obsidianHref } from '../util/obsidian.js';
import { openConcierge } from '../agents/concierge/ConciergeProvider.jsx';

export function isEditable(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
}

export function classifyTarget(target) {
  if (isEditable(target)) return 'editable';
  if (target && target.closest && target.closest('a[href], a[data-target]')) return 'link';
  return 'generic';
}

// Resolve the editable host (input/textarea/contenteditable root) from the event
// target, which may be a descendant span (e.g. inside CodeMirror).
function editableHost(el) {
  if (!el) return null;
  if (el.closest) {
    const host = el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
    if (host) return host;
  }
  return el;
}

function hasTextSelection(host) {
  if (host && typeof host.selectionStart === 'number') {
    return host.selectionStart !== host.selectionEnd;
  }
  const s = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
  return !!(s && String(s).length > 0);
}

// execCommand is deprecated but is the only insertion path that plays nicely
// with React-controlled inputs AND CodeMirror's contentEditable (it fires the
// beforeinput/input events both rely on). Setting .value directly would desync
// React state, so we deliberately use it here. Native paste is tried first
// (works in some WebKit builds); the clipboard-read fallback covers the rest.
async function pasteInto(host, plain) {
  try { host && host.focus(); } catch (e) {}
  if (!plain) {
    try { if (document.execCommand('paste')) return; } catch (e) {}
  }
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (e) {}
  if (!text) return;
  try { document.execCommand('insertText', false, text); } catch (e) {}
}

function copyText(s) {
  try { navigator.clipboard.writeText(s); } catch (e) {}
}

// SF5 — frame a selection as a markdown blockquote for the Concierge prefill, so
// the quoted source travels as clearly-marked context above the user's question.
function toBlockquote(text) {
  const t = (text || '').trim();
  if (!t) return '';
  return t.split('\n').map((l) => '> ' + l).join('\n');
}

export function buildEditableMenu(target, ctx) {
  const host = editableHost(target);
  const sel = hasTextSelection(host);
  // Capture the selection now (before the menu grabs focus) so input/textarea
  // clipboard ops still act on it after focus moves to the menu.
  const range = (host && typeof host.selectionStart === 'number')
    ? { start: host.selectionStart, end: host.selectionEnd }
    : null;
  // SF8: the selected text, for "Search vault". Input/textarea expose it via
  // value+range; contentEditable via the window selection.
  const selText = sel
    ? (range && host && typeof host.value === 'string'
        ? host.value.slice(range.start, range.end)
        : (typeof window !== 'undefined' && window.getSelection ? String(window.getSelection()) : ''))
    : '';
  const focusRun = (fn) => {
    try {
      if (host) {
        host.focus();
        if (range && host.setSelectionRange) host.setSelectionRange(range.start, range.end);
      }
    } catch (e) {}
    fn();
  };
  const items = [
    { label: 'Cut', disabled: !sel, onClick: () => focusRun(() => { try { document.execCommand('cut'); } catch (e) {} }) },
    { label: 'Copy', disabled: !sel, onClick: () => focusRun(() => { try { document.execCommand('copy'); } catch (e) {} }) },
    { label: 'Paste', onClick: () => pasteInto(host, false) },
    { label: 'Paste as plain text', onClick: () => pasteInto(host, true) },
    { label: 'Delete', danger: true, disabled: !sel, onClick: () => focusRun(() => { try { document.execCommand('delete'); } catch (e) {} }) },
    { label: 'Select All', onClick: () => focusRun(() => { try { document.execCommand('selectAll'); } catch (e) {} }) },
  ];
  // SF5 + SF8: smart actions for a field selection — Ask Concierge (prefills the
  // helper with the quoted selection) and Search vault (Command Palette seed).
  if (sel && selText.trim()) {
    items.push({ divider: true });
    items.push({ label: 'Ask Concierge', icon: IconSparkles, onClick: () => openConcierge({ prefill: toBlockquote(selText) }) });
    if (ctx && ctx.openCommandPalette) {
      items.push({ label: 'Search vault', icon: IconSearch, onClick: () => ctx.openCommandPalette(selText.trim()) });
    }
  }
  return items;
}

// SF8 — non-editable text selection (e.g. a rendered note / any static text).
// SF5 added "Ask Concierge": the menu is Copy, then a smart-actions group —
// Ask Concierge (prefills the helper with the quoted selection) + Search vault
// (Command Palette seed). No app-chrome actions.
export function buildSelectionMenu(text, ctx) {
  const t = (text || '').trim();
  const items = [{ label: 'Copy', onClick: () => copyText(t) }];
  items.push({ divider: true });
  items.push({ label: 'Ask Concierge', icon: IconSparkles, onClick: () => openConcierge({ prefill: toBlockquote(t) }) });
  if (ctx && ctx.openCommandPalette) {
    items.push({ label: 'Search vault', icon: IconSearch, onClick: () => ctx.openCommandPalette(t) });
  }
  return items;
}

// SF7 — links & wikilinks. Both the read-mode classifier (a real <a data-target>
// / <a href>) and the live-preview editor's CM wikilink/link widgets funnel into
// the same two builders below, so a link's menu is identical in both modes.
//   • Wikilink — read mode hands a resolved vault path + in-app hash route; live
//     mode hands the raw target (resolved lazily on click). Reveal/Copy resolve
//     to the real file path; Obsidian resolves the name itself.
//   • External — Open uses the app convention (https → in-app /tools/browser,
//     else OS browser); see openExternalUrl.
// Broken wikilinks render as <span class="wikilink--broken"> (no anchor) and
// fall through to the generic menu.

// Open an external URL the way the rest of the app does (mirrors
// editor/livePreview.js): https in the in-app sandboxed browser (https-only by
// design), everything else in the OS browser.
export function openExternalUrl(url) {
  if (!url) return;
  try {
    if (/^https:\/\//i.test(url)) navigate('/tools/browser/' + encodeURIComponent(url));
    else window.open(url, '_blank');
  } catch (e) {}
}

// Resolve a raw wikilink target and navigate the in-app router to it (mirrors
// PageView.handleWikilinkNav) — used when no precomputed hash route exists, i.e.
// the live-preview widgets.
async function navigateWikilink(target) {
  try {
    const r = await api.resolveLink(target, false);
    if (!r || !r.resolved || !r.path) return;
    const anchor = r.anchor ? '#' + encodeURIComponent(r.anchor).replace(/%20/g, '+') : '';
    navigate((r.scope === 'internal' ? '/infrastructure/reference?path=' : '/page/') + encodeURIComponent(r.path) + anchor);
  } catch (e) {}
}

// target: raw wikilink target. path/hashHref: known in read mode (skip the
// resolve round-trip); absent in live mode (resolve lazily). display: link text.
export function buildWikilinkMenu({ target, display, path, hashHref }) {
  const resolvePath = async () => {
    if (path) return path;
    try { const r = await api.resolveLink(target, false); if (r && r.path) return r.path; } catch (e) {}
    return target;
  };
  const items = [
    { label: 'Open', icon: IconFileText, onClick: () => { if (hashHref) { try { navigate(hashHref.replace(/^#/, '')); } catch (e) {} } else navigateWikilink(target); } },
    { label: 'Open in Obsidian', icon: IconExternal, onClick: () => { try { window.location.href = obsidianHref(path || target); } catch (e) {} } },
    { label: 'Reveal in Files', icon: IconFolder, onClick: async () => { const p = await resolvePath(); try { invoke('reveal_in_files', { path: p }); } catch (e) {} } },
    { label: 'Copy link', icon: IconLink, onClick: async () => copyText(await resolvePath()) },
  ];
  if (display) items.push({ label: 'Copy link text', onClick: () => copyText(display) });
  return items;
}

export function buildExternalLinkMenu({ url, text }) {
  const items = [];
  if (url) {
    items.push({ label: 'Open', icon: IconExternal, onClick: () => openExternalUrl(url) });
    items.push({ label: 'Copy link', icon: IconLink, onClick: () => copyText(url) });
  }
  const t = (text || '').trim();
  if (t) items.push({ label: 'Copy link text', onClick: () => copyText(t) });
  if (!items.length) items.push({ label: 'No link actions', disabled: true });
  return items;
}

// Read-mode entry: the global classifier passes the live <a>. Extract its shape
// and delegate to the shared builders above.
export function buildLinkMenu(a) {
  if (!a) return buildGenericMenu({});
  const href = a.getAttribute ? a.getAttribute('href') : null;
  const text = (a.textContent || '').trim();
  const isWiki = !!(a.classList && a.classList.contains('wikilink')) ||
    !!(a.getAttribute && a.getAttribute('data-target'));
  if (isWiki) {
    const path = (a.getAttribute && a.getAttribute('data-target')) || '';
    return buildWikilinkMenu({ target: path, display: text, path, hashHref: href });
  }
  return buildExternalLinkMenu({ url: href, text });
}

// File & folder rows. Each surface normalizes its item to { vaultPath, isFolder,
// href } and calls this. Open navigates the in-app route; Reveal/Copy act on the
// vault path; Obsidian is file-only (it opens files, not folders).
//
// `ops` (Vault File Tree, SF3) appends create/rename/delete actions below a
// divider — the tree binds each callback to the node (and omits the ones that
// don't apply: create only on folders, nothing on section roots), so a callback
// is present iff the action is allowed. Surfaces without `ops` (e.g. links) get
// the read-only menu unchanged.
export function buildFileItemMenu({ vaultPath, isFolder, href, ops }) {
  const items = [];
  if (href) items.push({ label: 'Open', icon: isFolder ? IconFolder : IconFileText, onClick: () => { try { navigate(href); } catch (e) {} } });
  if (!isFolder && vaultPath) items.push({ label: 'Open in Obsidian', icon: IconExternal, onClick: () => { try { window.location.href = obsidianHref(vaultPath); } catch (e) {} } });
  if (vaultPath) items.push({ label: 'Reveal in Files', icon: IconFolder, onClick: () => { try { invoke('reveal_in_files', { path: vaultPath }); } catch (e) {} } });
  if (vaultPath) items.push({ label: 'Copy path', icon: IconLink, onClick: () => copyText(vaultPath) });
  if (ops) {
    const fileOps = [];
    if (ops.onNewNote)     fileOps.push({ label: 'New note',     icon: IconFileText, onClick: ops.onNewNote });
    if (ops.onNewFolder)   fileOps.push({ label: 'New folder',   icon: IconFolder,   onClick: ops.onNewFolder });
    if (ops.onNewDomain)   fileOps.push({ label: 'New domain',   icon: IconPlus,     onClick: ops.onNewDomain });
    if (ops.onReconfigure) fileOps.push({ label: 'Reconfigure…', icon: IconSettings, onClick: ops.onReconfigure });
    if (ops.onRename)      fileOps.push({ label: 'Rename…',      icon: IconFile,     onClick: ops.onRename });
    if (ops.onDelete)      fileOps.push({ label: 'Delete',       icon: IconX, danger: true, onClick: ops.onDelete });
    if (fileOps.length) { items.push({ divider: true }); items.push(...fileOps); }
  }
  if (!items.length) items.push({ label: 'No actions', disabled: true });
  return items;
}

export function buildGenericMenu(ctx) {
  return [
    { header: 'Navigate' },
    { label: 'Command Palette', icon: IconCommand, shortcut: '⌘K', onClick: () => ctx && ctx.openCommandPalette && ctx.openCommandPalette() },
    { label: 'Settings…', icon: IconSettings, onClick: () => ctx && ctx.openSettings && ctx.openSettings() },
    { header: 'Window' },
    { label: 'Reload', icon: IconRotateCw, onClick: () => { try { window.location.reload(); } catch (e) {} } },
    // SF4 demo: a nested submenu (3 levels deep) so the fly-out / hover-intent /
    // keyboard Right-Left / edge-flip is testable before the real submenu surface
    // (calendar colour picker, SF10) lands. Mirrors existing chrome actions; safe
    // to drop once a genuine submenu ships.
    { header: 'Submenu demo' },
    { label: 'Quick actions', icon: IconCommand, children: [
      { label: 'Command Palette', icon: IconCommand, shortcut: '⌘K', onClick: () => ctx && ctx.openCommandPalette && ctx.openCommandPalette() },
      { label: 'Settings…', icon: IconSettings, onClick: () => ctx && ctx.openSettings && ctx.openSettings() },
      { label: 'Window', children: [
        { label: 'Reload', icon: IconRotateCw, onClick: () => { try { window.location.reload(); } catch (e) {} } },
      ] },
    ] },
  ];
}
