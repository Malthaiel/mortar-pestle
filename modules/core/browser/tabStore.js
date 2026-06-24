// Browser multi-tab store. A module-level external store (subscribe /
// getSnapshot, consumed via useTabStore) shared by BrowserPage, the sidebar
// TabSidebar/TabRail, the NewTabPage, and the keybind handlers. Plain JS so it
// can be mutated imperatively from the Rust→React event listener and from
// keyboard shortcuts without prop-drilling. Persisted to the module settings
// bag (localStorage `focus_settings.modules.browser.*`); the native webviews
// themselves live in Rust and are driven by the browser_* commands.
//
// A tab is the source of truth for { id, url, title, favicon, loading,
// canBack, canForward }; `url === null` means a New-Tab Page (no native view).

import { readModuleBag, writeModuleSetting } from '@host/module-sdk/index.js';
import { subscribeBrowserTabEvents } from '@host/api.js';

const PID = 'browser';
const RECENT_CAP = 12;
const HISTORY_CAP = 1000;
const HISTORY_MAX_AGE_MS = 90 * 864e5; // 90 days

function uid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url || ''; }
}

function freshTab(url = null, extra = {}) {
  return {
    id: uid(), url, title: '', favicon: null,
    loading: !!url, canBack: false, canForward: false,
    folderId: null,
    ...extra,
  };
}

// ── state ───────────────────────────────────────────────────────────────────
let _tabs = [];
let _activeId = null;
let _folders = [];           // in-memory tab groups: [{ id, name, collapsed }]
let _pinned = [];
let _recent = [];
let _history = [];
let _snapshot = { tabs: [], activeId: null, folders: [], pinned: [], recent: [] };
let _booted = false;
let _listening = false;
const subs = new Set();
// Per-tab last-activation sequence (in-memory) for the "Recently used" sort.
let _activeSeq = 0;
const _lastActive = {};
export function tabRecency(id) { return _lastActive[id] || 0; }

function recompute() {
  _snapshot = { tabs: _tabs, activeId: _activeId, folders: _folders, pinned: _pinned, recent: _recent };
}
function emit() {
  recompute();
  subs.forEach(fn => { try { fn(); } catch (e) { console.error('[browser/tabStore]', e); } });
}

function persistOpen() {
  writeModuleSetting(PID, 'openTabs', _tabs.map(t => ({
    id: t.id, url: t.url, title: t.title, favicon: t.favicon, folderId: t.folderId ?? null,
  })));
  writeModuleSetting(PID, 'activeId', _activeId);
}
function persistFolders() { writeModuleSetting(PID, 'tabFolders', _folders); }
function persistPinned() { writeModuleSetting(PID, 'pinned', _pinned); }
function persistRecent() { writeModuleSetting(PID, 'recent', _recent); }
function persistHistory() { writeModuleSetting(PID, 'history', _history); }

function boot() {
  if (_booted) return;
  _booted = true;
  const bag = readModuleBag(PID);
  _folders = Array.isArray(bag.tabFolders) ? bag.tabFolders : [];
  _pinned = Array.isArray(bag.pinned) ? bag.pinned : [];
  _recent = Array.isArray(bag.recent) ? bag.recent : [];
  _history = Array.isArray(bag.history) ? bag.history : [];
  const saved = Array.isArray(bag.openTabs) ? bag.openTabs : [];
  const folderIds = new Set(_folders.map(f => f.id));
  _tabs = saved.map(t => ({
    id: t.id || uid(),
    url: t.url ?? null,
    title: t.title || '',
    favicon: t.favicon || null,
    // Drop a stale group reference (folder removed out from under the tab).
    folderId: (t.folderId && folderIds.has(t.folderId)) ? t.folderId : null,
    loading: false, canBack: false, canForward: false,
  }));
  if (_tabs.length === 0) {
    _tabs = [freshTab(null)];
    _activeId = _tabs[0].id;
  } else {
    _activeId = (bag.activeId && _tabs.some(t => t.id === bag.activeId)) ? bag.activeId : _tabs[0].id;
  }
  recompute();
}

// ── store API for useSyncExternalStore ───────────────────────────────────────
export function subscribe(fn) {
  boot();
  if (!_listening) {
    _listening = true;
    // Rust → React per-tab metadata. Started once, lives for the app session.
    subscribeBrowserTabEvents((payload) => {
      if (payload && payload.tabId) setTabMeta(payload.tabId, payload);
    });
  }
  subs.add(fn);
  return () => subs.delete(fn);
}
export function getSnapshot() {
  boot();
  return _snapshot;
}

// ── recent / pinned ───────────────────────────────────────────────────────────
function pushRecent(tab) {
  if (!tab || !tab.url) return;
  const entry = { url: tab.url, title: tab.title || hostOf(tab.url), favicon: tab.favicon || null };
  _recent = [entry, ..._recent.filter(r => r.url !== tab.url)].slice(0, RECENT_CAP);
  persistRecent();
}

// Append a visit to the browsing-history log — a chronological ring buffer
// (NOT deduped like _recent), capped by count + age, persisted to the module
// bag. No favicon is stored (data URLs would blow the localStorage quota at
// 1000 entries); the view looks them up best-effort from _recent/_pinned. A
// no-op while recording is paused. Kept off the snapshot + emit() path so the
// navigation hot-path stays cheap; the History view reads getHistory() itself.
function pushHistory(tab) {
  if (!tab || !tab.url) return;
  if (readModuleBag(PID).historyPaused) return;
  const now = Date.now();
  const entry = { url: tab.url, title: tab.title || hostOf(tab.url), ts: now };
  _history = [entry, ..._history]
    .filter(h => h.ts > now - HISTORY_MAX_AGE_MS)
    .slice(0, HISTORY_CAP);
  persistHistory();
}
export function getHistory() { boot(); return _history; }
export function clearHistory() { boot(); _history = []; persistHistory(); }
export function deleteHistoryEntry(url, ts) {
  boot();
  _history = _history.filter(h => !(h.url === url && h.ts === ts));
  persistHistory();
}
export function addPinned(url, title, favicon) {
  boot();
  if (!url || _pinned.some(p => p.url === url)) return;
  _pinned = [..._pinned, { url, title: title || hostOf(url), favicon: favicon || null }];
  persistPinned();
  emit();
}
export function removePinned(url) {
  boot();
  _pinned = _pinned.filter(p => p.url !== url);
  persistPinned();
  emit();
}

// ── tab actions ───────────────────────────────────────────────────────────────
export function newTab(url = null) {
  boot();
  const tab = freshTab(url);
  _tabs = [..._tabs, tab];
  _activeId = tab.id;
  _lastActive[tab.id] = ++_activeSeq;
  persistOpen();
  emit();
  return tab.id;
}

export function closeTab(id) {
  boot();
  const idx = _tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const wasActive = _activeId === id;
  const next = _tabs.filter(t => t.id !== id);
  if (next.length === 0) {
    // Never zero tabs — replace with a fresh New-Tab Page.
    _tabs = [freshTab(null)];
    _activeId = _tabs[0].id;
  } else {
    _tabs = next;
    if (wasActive) {
      // Right neighbor (same index after removal), else the new last tab.
      _activeId = next[Math.min(idx, next.length - 1)].id;
    }
  }
  persistOpen();
  emit();
}

export function switchTab(id) {
  boot();
  if (id === _activeId || !_tabs.some(t => t.id === id)) return;
  _activeId = id;
  _lastActive[id] = ++_activeSeq;
  persistOpen();
  emit();
}

export function navigate(id, url) {
  boot();
  if (!url) return;
  _tabs = _tabs.map(t => (t.id === id ? { ...t, url, loading: true, committed: false, crashed: null } : t));
  persistOpen();
  emit();
}

export function reorder(from, to) {
  boot();
  if (from === to || from < 0 || from >= _tabs.length || to < 0 || to > _tabs.length) return;
  const next = _tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  _tabs = next;
  persistOpen();
  emit();
}

// ── tab folders (in-memory groups, Chrome/Firefox-style) ─────────────────────
export function createFolder(name = 'New folder') {
  boot();
  const folder = { id: 'f' + uid(), name, collapsed: false };
  _folders = [..._folders, folder];
  persistFolders();
  emit();
  return folder.id;
}
export function renameFolder(id, name) {
  boot();
  _folders = _folders.map(f => (f.id === id ? { ...f, name } : f));
  persistFolders();
  emit();
}
export function deleteFolder(id) {
  boot();
  // Ungroup the folder's tabs (never close them), then drop the folder.
  _tabs = _tabs.map(t => (t.folderId === id ? { ...t, folderId: null } : t));
  _folders = _folders.filter(f => f.id !== id);
  persistOpen();
  persistFolders();
  emit();
}
export function toggleFolder(id) {
  boot();
  _folders = _folders.map(f => (f.id === id ? { ...f, collapsed: !f.collapsed } : f));
  persistFolders();
  emit();
}
// Move a tab into folderId (null = top level), positioned before beforeId (or
// appended to that group / the top-level list when beforeId is null). One op so
// the flat _tabs order and the folder assignment stay consistent.
export function moveTab(tabId, folderId = null, beforeId = null) {
  boot();
  const tab = _tabs.find(t => t.id === tabId);
  if (!tab) return;
  const fid = folderId ?? null;
  const updated = { ...tab, folderId: fid };
  const rest = _tabs.filter(t => t.id !== tabId);
  let insertIdx;
  if (beforeId && beforeId !== tabId) {
    insertIdx = rest.findIndex(t => t.id === beforeId);
    if (insertIdx === -1) insertIdx = rest.length;
  } else {
    let last = -1;
    rest.forEach((t, i) => { if ((t.folderId ?? null) === fid) last = i; });
    insertIdx = last === -1 ? rest.length : last + 1;
  }
  rest.splice(insertIdx, 0, updated);
  _tabs = rest;
  persistOpen();
  emit();
}

export function cycleTab(dir = 1) {
  boot();
  if (_tabs.length < 2) return;
  const i = _tabs.findIndex(t => t.id === _activeId);
  const ni = (i + dir + _tabs.length) % _tabs.length;
  _activeId = _tabs[ni].id;
  persistOpen();
  emit();
}

export function jumpTo(index) {
  boot();
  if (index < 0 || index >= _tabs.length) return;
  _activeId = _tabs[index].id;
  persistOpen();
  emit();
}

// Merge a partial {title?, favicon?, url?, loading?, canBack?, canForward?,
// crashed?} (from the Rust `browser-tab-update` event) into a tab. `crashed` is
// a renderer-termination reason string, or null to clear. Track recent on url.
export function setTabMeta(id, partial) {
  boot();
  let touched = null;
  let urlChanged = false;
  _tabs = _tabs.map(t => {
    if (t.id !== id) return t;
    if (partial.url && partial.url !== t.url) urlChanged = true;
    const next = { ...t };
    if (partial.title != null) next.title = partial.title;
    if (partial.favicon) next.favicon = partial.favicon;
    if (partial.url) next.url = partial.url;
    // A (re)started load resets committed; a finished one implies committed.
    // The dedicated load-committed event (below) then flips it true mid-load so
    // the LoadingScreen can hand off to the painted page.
    if ('loading' in partial) { next.loading = !!partial.loading; next.committed = !partial.loading; }
    if (partial.committed) next.committed = true;
    if ('canBack' in partial) next.canBack = !!partial.canBack;
    if ('canForward' in partial) next.canForward = !!partial.canForward;
    if ('crashed' in partial) next.crashed = partial.crashed || null;
    touched = next;
    return next;
  });
  if (!touched) return;
  if (touched.url) pushRecent(touched);
  if (urlChanged) pushHistory(touched);
  persistOpen();
  emit();
}
