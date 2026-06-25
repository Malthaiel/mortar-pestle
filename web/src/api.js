// Tauri-only API surface. The browser-tab path is dead — after SF12, every
// former Fastify route is a Rust #[tauri::command]; `invoke` throws outside
// the Tauri shell rather than silently falling back to a host that no longer
// exists.

import { listen as tauriListen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { formatEventBullet } from './util/events.js';
import { parseNutritionLog } from './util/nutritionTotals.js';
import { parseWorkoutLog, parseCardioLog } from './util/fitnessLog.js';

const __tauriInvoke = () =>
  typeof window !== 'undefined' && window.__TAURI_INTERNALS__
    ? window.__TAURI_INTERNALS__.invoke
    : null;

export async function invoke(cmd, args) {
  const fn = __tauriInvoke();
  if (!fn) throw new Error(`Tauri IPC not available (cmd: ${cmd}) — running outside Tauri shell?`);
  return fn(cmd, args);
}

// WebKitGTK rejects custom URI schemes (`iskariel-asset://...`) in
// HTMLMediaElement, so audio/video can't use convertFileSrc. The Rust side
// runs a loopback HTTP server on a kernel-assigned 127.0.0.1 port; the port
// is fetched once at startup via `media_server_port` and cached. Plain
// `<img>` tags happily accept iskariel-asset:// so they still use it.
let VAULT_ROOT_FOR_MEDIA = '/home/malthaiel/Documents/Citadel';
// VaultProvider calls this on switch so media (img/audio/video) paths resolve
// against the active vault's root instead of the Citadel default.
export function setMediaVaultRoot(p) {
  if (p) VAULT_ROOT_FOR_MEDIA = p;
}
// The Library vault (writable media catalogs) is a fixed mount independent of
// the active vault. Catalog audio + playlist covers are Library-relative and
// must resolve against it, not VAULT_ROOT_FOR_MEDIA. Set once from the registry
// (useVaults), used by passing { library: true } to mediaUrl/mediaHttpUrl.
// (Library Migration Phase 2)
let LIBRARY_ROOT_FOR_MEDIA = null;
export function setMediaLibraryRoot(p) {
  if (p) LIBRARY_ROOT_FOR_MEDIA = p;
}
// Absolute filesystem path for a Library-relative path. reveal-in-files needs a
// real FS path, and Library catalog fields (e.g. an album's trackFolder) are
// Library-relative — joining them against the content vault root would 404.
// Passes absolutes through; returns the input unchanged if the root isn't set yet.
export function libraryAbs(rel) {
  if (!rel || rel.startsWith('/')) return rel;
  return LIBRARY_ROOT_FOR_MEDIA ? `${LIBRARY_ROOT_FOR_MEDIA}/${rel}` : rel;
}
let _mediaBaseUrl = null;
let _mediaBaseUrlPromise = null;
async function mediaBaseUrl() {
  if (_mediaBaseUrl) return _mediaBaseUrl;
  if (!_mediaBaseUrlPromise) {
    _mediaBaseUrlPromise = invoke('media_server_port')
      .then((port) => {
        if (typeof port === 'number' && port > 0) {
          _mediaBaseUrl = `http://127.0.0.1:${port}`;
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('agentic:media-server-ready', { detail: { baseUrl: _mediaBaseUrl } }));
          }
        }
        return _mediaBaseUrl;
      })
      .catch(() => null);
  }
  return _mediaBaseUrlPromise;
}
// Prime the cache on module load so consumers can call mediaUrlSync.
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  mediaBaseUrl();
}
function absFromInput(p, base) {
  // Already-absolute paths pass through unchanged: POSIX (`/…`), Windows
  // drive-rooted (`C:\…` / `C:/…`), and UNC (`\\server\…`). Only a relative path
  // is joined against the media root. (Game Capture clips are the one consumer
  // that passes an absolute path — and on Windows it has a drive letter, not `/`.)
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) return p;
  return `${base || VAULT_ROOT_FOR_MEDIA}/${p}`;
}
export function mediaUrl(p, opts) {
  if (!p) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  const abs = absFromInput(p, opts && opts.library ? LIBRARY_ROOT_FOR_MEDIA : undefined);
  // <img> path — still works via custom scheme.
  return convertFileSrc(abs, 'iskariel-asset');
}
// Rewrite dead `<img src="/api/file/{path}">` (emitted by the Rust Reading-mode
// renderer for `![[image]]` embeds — the Fastify route was deleted) to a live
// iskariel-asset:// URL. Run on any container after injecting reference-render
// HTML (Reading mode, transclusion bodies).
export function hydrateVaultImages(root) {
  if (!root || !root.querySelectorAll) return;
  for (const img of root.querySelectorAll('img[src^="/api/file/"]')) {
    const rest = img.getAttribute('src').slice('/api/file/'.length);
    let path;
    try { path = rest.split('/').map(decodeURIComponent).join('/'); }
    catch { path = rest; }
    const url = mediaUrl(path);
    if (url) img.setAttribute('src', url);
  }
}
// Plain-HTTP variant for <audio>/<video> src. Returns null until the port is
// known; callers should re-render once the cache primes (typically within
// one tick of app start).
export function mediaHttpUrl(p, opts) {
  if (!p) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  if (!_mediaBaseUrl) {
    mediaBaseUrl();
    return null;
  }
  const abs = absFromInput(p, opts && opts.library ? LIBRARY_ROOT_FOR_MEDIA : undefined);
  return `${_mediaBaseUrl}/media?path=${encodeURIComponent(abs)}`;
}
// Rewrite an `iskariel-asset://localhost/<rest>` URL (as returned by Rust
// video_start_transcode / video_extract_subs) into the equivalent loopback
// HTTP URL for WebKit-compatible media playback.
export function rewriteAssetToHttp(assetUrl) {
  if (!assetUrl || !_mediaBaseUrl) return null;
  const prefix = 'iskariel-asset://localhost';
  if (!assetUrl.startsWith(prefix)) return assetUrl;
  return _mediaBaseUrl + assetUrl.slice(prefix.length);
}
export async function awaitMediaBaseUrl() {
  return mediaBaseUrl();
}

// Translate a Tauri-serialized VaultError back into an Error with `.code` and
// optional `.currentMtime` — preserves the shape callsites expect.
function wrapVaultError(e) {
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    const err = new Error(e.message || e.code);
    err.code = e.code;
    if (e.currentMtime != null) err.currentMtime = e.currentMtime;
    return err;
  }
  return e instanceof Error ? e : new Error(String(e));
}

// SF3.5 writer mtime contract. Cached from every read of today's daily note +
// every writer response. Writers pass this as `baseMtime` to Tauri commands;
// Rust side stat-compares and returns Conflict on drift.
let lastDailyMtime = null;
function rememberMtime(res) {
  if (res && typeof res.mtime === 'number' && res.mtime > 0) {
    lastDailyMtime = res.mtime;
  }
  return res;
}

function emitConflictToast(err) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(
    new CustomEvent('agentic:conflict', {
      detail: { currentMtime: err?.currentMtime, message: err?.message },
    }),
  );
}

// Multi-mount routing: a path under `Pulse/` lives in the Pulse Vault, so the
// vault file ops resolve there. Unambiguous post-migration (the content vault
// has no `Pulse/` tree). An explicit `root` (e.g. 'app' for Docs/Releases) wins.
const VAULT_FILE_CMDS = new Set([
  'vault_read_file', 'vault_write_file', 'vault_delete_file',
  'vault_toggle_task', 'vault_render_reference',
]);
function routeArgs(command, args) {
  if (
    args && args.root == null &&
    VAULT_FILE_CMDS.has(command) &&
    typeof args.path === 'string' && args.path.startsWith('Pulse/')
  ) {
    return { ...args, root: 'pulse' };
  }
  return args;
}

async function writerCall({ command, args }) {
  try {
    const r = await invoke(command, routeArgs(command, { ...args, baseMtime: lastDailyMtime }));
    rememberMtime(r);
    return r;
  } catch (e) {
    const err = wrapVaultError(e);
    if (err.code === 'CONFLICT') {
      if (err.currentMtime != null) lastDailyMtime = err.currentMtime;
      emitConflictToast(err);
    }
    throw err;
  }
}

async function readCall(command, args) {
  try { return await invoke(command, routeArgs(command, args)); }
  catch (e) { throw wrapVaultError(e); }
}

// === Planner: Block Library + daily-log section helpers ===
// Hand-rolled YAML parse/serialize for our controlled schema in
// `Iskariel/Block Library.md`. Avoids adding a JS YAML dep; the
// Rust side has `serde_yml` if we ever need robust round-trip.

const BLOCK_LIBRARY_PATH = 'Iskariel/Block Library.md';
const RELEASES_PATH = 'Iskariel/Releases.md';
const RELEASE_QUEUE_PATH = 'Iskariel/Release Queue.md';
const BLOCK_FIELD_ORDER = [
  'id', 'name', 'color', 'kind',
  'cadence', 'fixed_time', 'fixed_days',
  'preferred_window', 'default_duration',
];
const EVENT_TYPES_PATH = 'Iskariel/Event Types.md';
const EVENT_TYPE_FIELD_ORDER = ['id', 'name', 'color'];
const EVENT_TYPES_BODY_TAIL = '\n\nUser-defined event types for the Planner’s New Event popup. Edit the YAML above or add types in-app (New Event → + New type).\n';
const PULSE_INDEX_PATH = 'Infrastructure/Indexes/Pulse Index.md';

function parseYamlScalar(raw) {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  const dq = t.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (dq) return dq[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const sq = t.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (sq) return sq[1];
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => parseYamlScalar(s));
  }
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

export function parseBlockLibrary(content) {
  if (!content) return { blocks: [], lastModified: null };
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { blocks: [], lastModified: null };
  const body = fm[1];
  const blocks = [];
  let cur = null;
  let inBlocks = false;
  let lastModified = null;
  for (const raw of body.split('\n')) {
    if (!inBlocks) {
      const m = raw.match(/^(\w+):\s*(.*)$/);
      if (m) {
        if (m[1] === 'blocks') inBlocks = true;
        else if (m[1] === 'last_modified') lastModified = parseYamlScalar(m[2]);
      }
      continue;
    }
    const itemStart = raw.match(/^\s{2}-\s+(\w+):\s*(.*)$/);
    const itemCont  = raw.match(/^\s{4,}(\w+):\s*(.*)$/);
    if (itemStart) {
      if (cur) blocks.push(cur);
      cur = {};
      cur[itemStart[1]] = parseYamlScalar(itemStart[2]);
    } else if (itemCont && cur) {
      cur[itemCont[1]] = parseYamlScalar(itemCont[2]);
    }
  }
  if (cur) blocks.push(cur);
  return { blocks, lastModified };
}

function serializeYamlScalar(v) {
  if (v === null || v === undefined) return '~';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return `[${v.map(item => serializeYamlScalar(item)).join(', ')}]`;
  }
  const s = String(v);
  if (s === '' || /^[~\-:#?&*!|>'"%@`]/.test(s) || /[:#\n]/.test(s) || /^\d/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

export function serializeBlockLibrary(blocks) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = ['type: block-library', `last_modified: ${today}`, 'blocks:'];
  for (const b of blocks) {
    let first = true;
    for (const key of BLOCK_FIELD_ORDER) {
      if (!(key in b) || b[key] === undefined || b[key] === null) continue;
      const value = serializeYamlScalar(b[key]);
      lines.push(first ? `  - ${key}: ${value}` : `    ${key}: ${value}`);
      first = false;
    }
  }
  return lines.join('\n');
}

function extractH2Section(content, sectionName) {
  if (!content) return '';
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const re = new RegExp(`^## ${sectionName}\\s*\\n([\\s\\S]*?)(?=^## |\\s*$)`, 'm');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

export function parseEventTypes(content) {
  if (!content) return { types: [], lastModified: null };
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { types: [], lastModified: null };
  const body = fm[1];
  const types = [];
  let cur = null;
  let inTypes = false;
  let lastModified = null;
  for (const raw of body.split('\n')) {
    if (!inTypes) {
      const m = raw.match(/^(\w+):\s*(.*)$/);
      if (m) {
        if (m[1] === 'types') inTypes = true;
        else if (m[1] === 'last_modified') lastModified = parseYamlScalar(m[2]);
      }
      continue;
    }
    const itemStart = raw.match(/^\s{2}-\s+(\w+):\s*(.*)$/);
    const itemCont  = raw.match(/^\s{4,}(\w+):\s*(.*)$/);
    if (itemStart) {
      if (cur) types.push(cur);
      cur = {};
      cur[itemStart[1]] = parseYamlScalar(itemStart[2]);
    } else if (itemCont && cur) {
      cur[itemCont[1]] = parseYamlScalar(itemCont[2]);
    }
  }
  if (cur) types.push(cur);
  return { types, lastModified };
}

export function serializeEventTypes(types) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = ['type: event-types', `last_modified: ${today}`, 'types:'];
  for (const t of types) {
    let first = true;
    for (const key of EVENT_TYPE_FIELD_ORDER) {
      if (!(key in t) || t[key] === undefined || t[key] === null) continue;
      const value = serializeYamlScalar(t[key]);
      lines.push(first ? `  - ${key}: ${value}` : `    ${key}: ${value}`);
      first = false;
    }
  }
  return lines.join('\n');
}

// Full canonical daily-log skeleton (frontmatter + 7 H2 sections + empty plan
// fence), matching Infrastructure/Template/New Today Page.md, with the first
// event bullet placed under ## Upcoming. Used when scheduling onto a day that
// has no daily log yet.
function buildDailyLogSkeleton(ds, upcomingBullet) {
  return [
    '---',
    'Type: Daily-Log',
    `Date: ${ds}`,
    `Month: ${ds.slice(0, 7)}`,
    '---',
    '',
    '## Focus Block',
    '',
    '## Quick Notes',
    '',
    '## Tasks',
    '',
    '## Upcoming',
    '',
    ...(upcomingBullet ? [upcomingBullet, ''] : []),
    '## Sessions',
    '',
    '## Plan Fence',
    '',
    '```plan',
    '```',
    '',
    '## Vault Activity',
    '',
  ].join('\n');
}

// Append an event bullet to an existing daily log's ## Upcoming section,
// creating the section (after ## Quick Notes / before ## Sessions) if absent.
function insertIntoUpcoming(content, bullet) {
  const lines = content.split('\n');
  let h = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Upcoming\s*$/.test(lines[i])) { h = i; break; }
  }
  if (h === -1) {
    let insertAt = lines.length;
    const sessIdx = lines.findIndex(l => /^##\s+Sessions\s*$/.test(l));
    if (sessIdx !== -1) {
      insertAt = sessIdx;
    } else {
      const qnIdx = lines.findIndex(l => /^##\s+Quick Notes\s*$/.test(l));
      if (qnIdx !== -1) {
        let j = qnIdx + 1;
        while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
        // ## Tasks sits between Quick Notes and Upcoming in the canonical
        // order — a recreated Upcoming must land after it, not inside the gap.
        if (j < lines.length && /^##\s+Tasks\s*$/.test(lines[j])) {
          j++;
          while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
        }
        insertAt = j;
      }
    }
    lines.splice(insertAt, 0, '## Upcoming', '', bullet, '');
    return lines.join('\n');
  }
  let end = h + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  let last = end - 1;
  while (last > h && lines[last].trim() === '') last--;
  lines.splice(last + 1, 0, ...bullet.split('\n'));
  return lines.join('\n');
}

// Register a newly created daily log in the Pulse Index under ## Daily Logs at
// its reverse-chronological position (deduped). Missing index/section is a
// no-op — /update reconciles. Best-effort; never blocks the daily-log write.
async function ensurePulseIndexEntry(ds) {
  let content;
  let mtime;
  try {
    const r = await readCall('vault_read_file', { path: PULSE_INDEX_PATH, root: 'pulse' });
    content = r.content; mtime = r.mtime ?? null;
  } catch (e) {
    if (e?.code === 'NOT_FOUND') return;
    throw e;
  }
  if (content.includes(`Pulse/Daily Logs/${ds}]]`)) return;
  const lines = content.split('\n');
  const h = lines.findIndex(l => /^##\s+Daily Logs\s*$/.test(l));
  if (h === -1) return;
  let end = h + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  const dateRe = /Pulse\/Daily Logs\/(\d{4}-\d{2}-\d{2})\]\]/;
  const entry = `- [[Pulse/Daily Logs/${ds}]] — daily journal`;
  let insertAt = -1;
  for (let i = h + 1; i < end; i++) {
    const m = lines[i].match(dateRe);
    if (m && m[1] < ds) { insertAt = i; break; }
  }
  if (insertAt === -1) {
    let lastEntry = -1;
    for (let i = h + 1; i < end; i++) if (dateRe.test(lines[i])) lastEntry = i;
    if (lastEntry !== -1) {
      insertAt = lastEntry + 1;
    } else {
      let j = h + 1;
      if (lines[j] !== undefined && lines[j].trim() === '') j++;
      insertAt = j;
    }
  }
  lines.splice(insertAt, 0, entry);
  await readCall('vault_write_file', { path: PULSE_INDEX_PATH, content: lines.join('\n'), mtime, root: 'pulse' });
}

const BLOCK_LIBRARY_BODY_TAIL = '\n\nReusable session blocks for the Planner. Edit the YAML above or use the in-app editor (right-click a chip → Edit).\n';

// === Daily Frame (Pulse/Schedule.md) helpers ===
// Same hand-rolled YAML approach as Block Library, but preserves user-typed
// frontmatter extras (Type, Created) since Schedule.md predates the schema.
const SCHEDULE_PATH = 'Pulse/Schedule.md';
const FRAME_FIELD_ORDER = ['id', 'name', 'start', 'end', 'planned'];
// Per-weekday frame: canonical + tab order is Monday-first.
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// A fresh 7-key map with every weekday an empty block list.
export function emptyFramesMap() {
  return Object.fromEntries(DAY_ORDER.map(d => [d, []]));
}

// Returns { frames, extras } where `frames` is ALWAYS a 7-key map (mon..sun),
// each an array of block objects. A legacy singular `frame:` list is fanned out
// (deep-copied) into all 7 days so old files migrate lazily — the next write()
// persists the new `frames:` shape. If both keys are present, `frames:` wins.
// Indent contract: under `frames:`, day headers are 2-space (`  mon:`) and
// items are 4-space dash / 6-space continuation; legacy `frame:` items stay
// 2-space dash / 4-space continuation.
export function parseDailyFrame(content) {
  if (!content) return { frames: emptyFramesMap(), extras: {} };
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { frames: emptyFramesMap(), extras: {} };
  const body = fm[1];
  const hasFramesMap = /^frames:\s*$/m.test(body);
  const frames = emptyFramesMap();
  const extras = {};
  const legacy = [];
  let mode = 'top';      // 'top' | 'legacy' | 'frames'
  let curDay = null;
  let cur = null;
  const flush = (target) => { if (cur) { target.push(cur); cur = null; } };

  for (const raw of body.split('\n')) {
    if (mode === 'top') {
      const m = raw.match(/^(\w+):\s*(.*)$/);
      if (m) {
        if (m[1] === 'frames') mode = 'frames';
        else if (m[1] === 'frame' && !hasFramesMap) mode = 'legacy';
        else if (m[1] !== 'last_modified' && m[1] !== 'frame') extras[m[1]] = parseYamlScalar(m[2]);
      }
      continue;
    }
    if (mode === 'legacy') {
      const itemStart = raw.match(/^ {2}-\s+(\w+):\s*(.*)$/);
      const itemCont  = raw.match(/^ {4,}(\w+):\s*(.*)$/);
      if (itemStart) { flush(legacy); cur = {}; cur[itemStart[1]] = parseYamlScalar(itemStart[2]); }
      else if (itemCont && cur) cur[itemCont[1]] = parseYamlScalar(itemCont[2]);
      continue;
    }
    // mode === 'frames'
    const dayHdr = raw.match(/^ {2}(mon|tue|wed|thu|fri|sat|sun):\s*$/);
    if (dayHdr) { flush(curDay ? frames[curDay] : legacy); curDay = dayHdr[1]; continue; }
    const itemStart = raw.match(/^ {4}-\s+(\w+):\s*(.*)$/);
    const itemCont  = raw.match(/^ {6,}(\w+):\s*(.*)$/);
    if (itemStart && curDay) { flush(frames[curDay]); cur = {}; cur[itemStart[1]] = parseYamlScalar(itemStart[2]); }
    else if (itemCont && cur && curDay) cur[itemCont[1]] = parseYamlScalar(itemCont[2]);
  }
  flush(mode === 'frames' && curDay ? frames[curDay] : legacy);

  if (legacy.length) {
    for (const d of DAY_ORDER) frames[d] = legacy.map(b => ({ ...b }));
  }
  return { frames, extras };
}

// Serializes the 7-key `frames` map. Days emit in DAY_ORDER (Mon→Sun); an empty
// day is a bare `  <day>:` header (round-trips back to []). Block formatting is
// identical to the legacy single frame, just indented one level under the day.
export function buildScheduleFrontmatter(frames, extras = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  // Preserve Type/Created in original raw form (unquoted ISO date is valid YAML;
  // serializeYamlScalar would over-quote it).
  lines.push(`Type: ${extras.Type || 'Schedule'}`);
  if (extras.Created) lines.push(`Created: ${extras.Created}`);
  for (const k of Object.keys(extras)) {
    if (k === 'Type' || k === 'Created') continue;
    lines.push(`${k}: ${serializeYamlScalar(extras[k])}`);
  }
  lines.push(`last_modified: ${today}`);
  lines.push('frames:');
  for (const day of DAY_ORDER) {
    lines.push(`  ${day}:`);
    for (const b of (frames?.[day] || [])) {
      let first = true;
      for (const key of FRAME_FIELD_ORDER) {
        if (!(key in b) || b[key] === undefined || b[key] === null) continue;
        if (key === 'planned' && b[key] === false) continue; // omit planned:false (parser treats missing as falsy)
        const value = serializeYamlScalar(b[key]);
        lines.push(first ? `    - ${key}: ${value}` : `      ${key}: ${value}`);
        first = false;
      }
    }
  }
  return lines.join('\n');
}

// Strip the existing `frame_override:` block (header + indented entries) from
// a daily-log file's frontmatter. Other frontmatter keys are preserved
// verbatim. Body content (everything after the closing `---`) is untouched.
export function stripFrameOverride(content) {
  if (!content) return content;
  const lines = content.split('\n');
  const out = [];
  let inFm = false;
  let fmDelimCount = 0;
  let inOverride = false;
  for (const line of lines) {
    if (line === '---') {
      fmDelimCount++;
      if (fmDelimCount === 1) inFm = true;
      else if (fmDelimCount === 2) { inFm = false; inOverride = false; }
      out.push(line);
      continue;
    }
    if (!inFm) { out.push(line); continue; }
    if (inOverride) {
      if (/^\s{2}\S/.test(line)) continue; // skip indented entry lines
      inOverride = false;
      out.push(line);
    } else {
      if (/^frame_override:\s*$/.test(line)) { inOverride = true; continue; }
      out.push(line);
    }
  }
  return out.join('\n');
}

// Splice a new `frame_override:` block into a daily-log file's frontmatter
// (replacing any existing block). Empty overrideMap removes the block entirely.
// Keys are emitted in sorted order for deterministic output.
export function setFrameOverrideInContent(content, overrideMap) {
  const stripped = stripFrameOverride(content);
  const keys = Object.keys(overrideMap || {}).sort();
  if (keys.length === 0) return stripped;
  const block = 'frame_override:\n' + keys.map(k => {
    const o = overrideMap[k];
    // Deleted-for-today form (#10): the frame is hidden on this date only.
    return o.deleted
      ? `  ${k}: { deleted: true }`
      : `  ${k}: { start: "${o.start}", end: "${o.end}" }`;
  }).join('\n');
  const lines = stripped.split('\n');
  let firstDelim = -1;
  let secondDelim = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      if (firstDelim === -1) firstDelim = i;
      else { secondDelim = i; break; }
    }
  }
  if (firstDelim === -1) {
    return `---\n${block}\n---\n${stripped}`;
  }
  if (secondDelim === -1) {
    return stripped + `\n${block}`;
  }
  lines.splice(secondDelim, 0, ...block.split('\n'));
  return lines.join('\n');
}

// Inline-object frame_override parser. Expected shape:
//   frame_override:
//     end-of-day: { start: "23:00", end: "00:00" }
//     wind-down:  { start: "00:00", end: "01:30" }
export function parseFrameOverride(content) {
  if (!content) return {};
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const body = fm[1];
  let inOverride = false;
  const out = {};
  for (const raw of body.split('\n')) {
    if (!inOverride) {
      if (/^frame_override:\s*$/.test(raw)) inOverride = true;
      continue;
    }
    const m = raw.match(/^\s{2}([a-z0-9-]+):\s*\{\s*start:\s*"([^"]+)"\s*,\s*end:\s*"([^"]+)"\s*\}\s*$/);
    if (m) {
      out[m[1]] = { start: m[2], end: m[3] };
      continue;
    }
    const md = raw.match(/^\s{2}([a-z0-9-]+):\s*\{\s*deleted:\s*true\s*\}\s*$/);
    if (md) {
      out[md[1]] = { deleted: true };
      continue;
    }
    if (/^\S/.test(raw)) break;
  }
  return out;
}

// === Planner: Unorganized Notes actions (delete / move / carry / toggle + undo) ===
// Pure section editors operate on RAW file lines so the parsed-note `index`
// from `daily_get_unorganized` lines up with the file. The bullet predicate
// mirrors quickNotesBulletLines exactly (trimmed `- ` prefix, non-empty body;
// checkbox bullets are still counted), so indices stay aligned. Each note
// action targets the note's OWN source log (`ds = sourceDate`). Writes go
// through readCall('vault_write_file', …) with the freshly-read mtime as the
// conflict gate — NOT writerCall, whose baseMtime tracks today's note.

function emitNoteToast(detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('agentic:notify', { detail }));
}
function emitNotesChanged() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('agentic:yesterday-notes-changed'));
}
function emitNoteError(title, message) {
  emitNoteToast({ type: 'note-error', title, message: message || '', accent: 'var(--error)', iconKey: 'alert', duration: 4500 });
}

// Generic H2 section range — header line + body span up to the next H2. The
// Quick Notes wrapper keeps its original name/behavior for the note actions.
function findH2Range(lines, name) {
  const re = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const header = lines.findIndex(l => re.test(l));
  if (header === -1) return null;
  let end = header + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  return { header, bodyStart: header + 1, bodyEnd: end };
}
function findQuickNotesRange(lines) {
  return findH2Range(lines, 'Quick Notes');
}
function quickNotesBulletLines(lines, start, end) {
  const out = [];
  for (let k = start; k < end; k++) {
    const t = lines[k].trim();
    if (/^-\s+/.test(t) && t.replace(/^-\s+/, '').trim() !== '') out.push(k);
  }
  return out;
}
// Map parsed-bullet `index` → raw line, verifying text (stale-projection guard).
function locateQuickNotesBullet(content, index, expectedText) {
  const lines = content.split('\n');
  const range = findQuickNotesRange(lines);
  if (!range) return { error: 'NO_SECTION' };
  const idxs = quickNotesBulletLines(lines, range.bodyStart, range.bodyEnd);
  if (index < 0 || index >= idxs.length) return { error: 'INDEX_OOB' };
  const lineIdx = idxs[index];
  const got = lines[lineIdx].trim().replace(/^-\s+/, '').trim();
  if (got !== expectedText) return { error: 'TEXT_MISMATCH' };
  return { lines, lineIdx };
}
// Re-insert a bullet at parsed `index` (undo of delete).
function insertQuickNotesBullet(content, index, text) {
  const lines = content.split('\n');
  const range = findQuickNotesRange(lines);
  const bullet = `- ${text}`;
  if (!range) return `${content.replace(/\s+$/, '')}\n\n## Quick Notes\n\n${bullet}\n`;
  const idxs = quickNotesBulletLines(lines, range.bodyStart, range.bodyEnd);
  const insertAt = index < idxs.length
    ? idxs[index]
    : (idxs.length ? idxs[idxs.length - 1] + 1 : range.bodyEnd);
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}

// Write a daily log with an explicit mtime conflict gate. Returns the (truthy)
// write result on success — callers needing the fresh mtime read it there —
// or false; on conflict raises the standard conflict toast + a pane refresh.
async function writeDailyLog(path, content, mtime) {
  try {
    const r = await readCall('vault_write_file', { path, content, mtime });
    return r || { mtime: null };
  } catch (e) {
    if (e?.code === 'CONFLICT') { emitConflictToast(e); emitNotesChanged(); }
    else emitNoteError('Couldn’t save the change', e?.message);
    return false;
  }
}

// Soft-delete a quick note → it moves to the recycling bin (the sole recovery
// surface; no Undo toast). The Rust command captures the raw bullet, then
// removes it; a stale `index`/`text` returns ok:false so we refresh instead of
// deleting the wrong line.
async function deleteYesterdayNote({ ds, index, text }) {
  let r;
  try { r = await invoke('pulse_note_delete', { ds, index, text }); }
  catch (e) { emitNoteError('Couldn’t delete the note', wrapVaultError(e)?.message); return { ok: false }; }
  if (!r?.ok) {
    emitNoteError('Note changed — refreshed',
      r?.reason === 'TEXT_MISMATCH' ? 'It was edited elsewhere.' : 'It’s no longer there.');
    emitNotesChanged();
    return { ok: false, reason: r?.reason };
  }
  emitNotesChanged();
  return { ok: true };
}

// — phase 2: move a note into an Idea page —
function appendBulletToBody(content, bullet) {
  return `${content.replace(/\s+$/, '')}\n${bullet}\n`;
}
// Best-effort remove the last occurrence of an exact line from a file (move
// compensation + move-undo). Swallows errors — the caller treats it as advisory.
async function tryRemoveLineFromFile(path, exactLine) {
  try {
    const r = await readCall('vault_read_file', { path });
    const lines = r.content.split('\n');
    const idx = lines.lastIndexOf(exactLine);
    if (idx === -1) return;
    lines.splice(idx, 1);
    await readCall('vault_write_file', { path, content: lines.join('\n'), mtime: r.mtime });
  } catch { /* advisory */ }
}

async function moveNoteToIdea({ ds, index, text, ideaPath }) {
  let idea;
  try { idea = await readCall('vault_read_file', { path: ideaPath }); }
  catch (e) { emitNoteError('Couldn’t open that Idea', e?.message); return { ok: false }; }
  const appendedLine = `- ${text} — from [[Pulse/Daily Logs/${ds}]]`;
  // 1. Write the destination FIRST so the note is never in limbo.
  try {
    await readCall('vault_write_file', { path: ideaPath, content: appendBulletToBody(idea.content, appendedLine), mtime: idea.mtime });
  } catch (e) {
    emitNoteError(e?.code === 'CONFLICT' ? 'That Idea changed — try again' : 'Couldn’t update the Idea', e?.message);
    return { ok: false };
  }
  // 2. Remove from yesterday's log; compensate the Idea append on failure.
  const logPath = `Pulse/Daily Logs/${ds}.md`;
  let log;
  try { log = await readCall('vault_read_file', { path: logPath }); }
  catch (e) { await tryRemoveLineFromFile(ideaPath, appendedLine); emitNoteError('Move failed — undone', e?.message); return { ok: false }; }
  const loc = locateQuickNotesBullet(log.content, index, text);
  if (loc.error) {
    // The Idea copy is saved but the original is already gone/changed. Refresh
    // and confirm without an undo (state is ambiguous).
    emitNotesChanged();
    emitNoteToast({ type: 'note-info', title: 'Saved to Idea', message: text, accent: 'var(--accent)', iconKey: 'bell', duration: 4500 });
    return { ok: true };
  }
  const logNext = loc.lines.filter((_, i) => i !== loc.lineIdx).join('\n');
  if (!(await writeDailyLog(logPath, logNext, log.mtime))) {
    await tryRemoveLineFromFile(ideaPath, appendedLine);
    return { ok: false };
  }
  emitNotesChanged();
  emitNoteToast({
    type: 'note-undo', title: 'Moved to Idea', message: text,
    accent: 'var(--accent)', iconKey: 'bell', duration: 5000,
    action: { label: 'Undo', kind: 'undo-note', payload: { op: 'restore-move', ds, index, text, ideaPath, appendedLine } },
  });
  return { ok: true };
}

async function restoreMovedNote({ ds, index, text, ideaPath, appendedLine }) {
  await tryRemoveLineFromFile(ideaPath, appendedLine);
  const logPath = `Pulse/Daily Logs/${ds}.md`;
  const r = await readCall('vault_read_file', { path: logPath });
  const next = insertQuickNotesBullet(r.content, index, text);
  if (await writeDailyLog(logPath, next, r.mtime)) emitNotesChanged();
}

// — phase 3: send to today (carry-forward / convert-to-task) + new stub Idea —
function todayDs() {
  return new Date().toISOString().slice(0, 10);
}
function appendQuickNotesLine(content, line) {
  const lines = content.split('\n');
  const range = findQuickNotesRange(lines);
  if (!range) return `${content.replace(/\s+$/, '')}\n\n## Quick Notes\n\n${line}\n`;
  const idxs = quickNotesBulletLines(lines, range.bodyStart, range.bodyEnd);
  const at = idxs.length ? idxs[idxs.length - 1] + 1 : range.bodyEnd;
  lines.splice(at, 0, line);
  return lines.join('\n');
}
async function tryDeleteFile(path) { try { await readCall('vault_delete_file', { path }); } catch { /* advisory */ } }

// Carry-forward (plain bullet) and convert-to-task (checkbox) both append to
// today's Quick Notes and remove from yesterday — same shape, one helper.
async function sendNoteToToday({ ds, index, text, asTask }) {
  const today = todayDs();
  const todayPath = `Pulse/Daily Logs/${today}.md`;
  const line = asTask ? `- [ ] ${text}` : `- ${text}`;
  let td;
  try { td = await readCall('vault_read_file', { path: todayPath }); }
  catch (e) { emitNoteError('Couldn’t open today’s log', e?.message); return { ok: false }; }
  try {
    // Converted tasks land in ## Tasks (their canonical home); carried notes
    // keep the original Quick Notes append. Today-writes bypass writerCall, so
    // refresh its mtime cache or the next session/plan write false-CONFLICTs.
    const wr = await readCall('vault_write_file', {
      path: todayPath,
      content: asTask ? appendSectionLine(td.content, 'Tasks', line) : appendQuickNotesLine(td.content, line),
      mtime: td.mtime,
    });
    rememberMtime(wr);
  } catch (e) {
    emitNoteError(e?.code === 'CONFLICT' ? 'Today’s log changed — try again' : 'Couldn’t update today’s log', e?.message);
    return { ok: false };
  }
  const logPath = `Pulse/Daily Logs/${ds}.md`;
  let log;
  try { log = await readCall('vault_read_file', { path: logPath }); }
  catch (e) { await tryRemoveLineFromFile(todayPath, line); emitNoteError('Move failed — undone', e?.message); return { ok: false }; }
  const loc = locateQuickNotesBullet(log.content, index, text);
  const title = asTask ? 'Converted to a task' : 'Carried forward to today';
  if (loc.error) {
    emitNotesChanged();
    emitNoteToast({ type: 'note-info', title, message: text, accent: 'var(--accent)', iconKey: 'bell', duration: 4500 });
    return { ok: true };
  }
  const logNext = loc.lines.filter((_, i) => i !== loc.lineIdx).join('\n');
  if (!(await writeDailyLog(logPath, logNext, log.mtime))) { await tryRemoveLineFromFile(todayPath, line); return { ok: false }; }
  emitNotesChanged();
  emitNoteToast({
    type: 'note-undo', title, message: text, accent: 'var(--accent)', iconKey: 'bell', duration: 5000,
    action: { label: 'Undo', kind: 'undo-note', payload: { op: asTask ? 'restore-task' : 'restore-carry', ds, index, text, today, line } },
  });
  return { ok: true };
}
async function restoreFromToday({ ds, index, text, today, line }) {
  await tryRemoveLineFromFile(`Pulse/Daily Logs/${today}.md`, line);
  const logPath = `Pulse/Daily Logs/${ds}.md`;
  const r = await readCall('vault_read_file', { path: logPath });
  if (await writeDailyLog(logPath, insertQuickNotesBullet(r.content, index, text), r.mtime)) emitNotesChanged();
}

function sanitizeIdeaTitle(title) {
  return (title || '').replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
}
async function createStubIdea({ ds, index, text, title, domain }) {
  const clean = sanitizeIdeaTitle(title);
  if (!clean) { emitNoteError('Idea needs a title', ''); return { ok: false }; }
  const ideaPath = `Pulse/Ideas/${clean}.md`;
  try {
    await readCall('vault_read_file', { path: ideaPath });
    emitNoteError('That Idea already exists', clean);
    return { ok: false };
  } catch (e) { if (e?.code !== 'NOT_FOUND') { emitNoteError('Couldn’t create the Idea', e?.message); return { ok: false }; } }
  const content = [
    '---', 'Type: Idea', 'Status: Active', `Domain: ${domain || 'Uncategorized'}`,
    `Created: ${todayDs()}`, 'Tier: Standard', `Source: "[[Pulse/Daily Logs/${ds}]]"`, '---', '', `- ${text}`, '',
  ].join('\n');
  try { await readCall('vault_write_file', { path: ideaPath, content }); }
  catch (e) { emitNoteError('Couldn’t create the Idea', e?.message); return { ok: false }; }
  const logPath = `Pulse/Daily Logs/${ds}.md`;
  let log;
  try { log = await readCall('vault_read_file', { path: logPath }); }
  catch (e) { await tryDeleteFile(ideaPath); emitNoteError('Create failed — undone', e?.message); return { ok: false }; }
  const loc = locateQuickNotesBullet(log.content, index, text);
  if (loc.error) {
    emitNotesChanged();
    emitNoteToast({ type: 'note-info', title: 'New Idea created', message: clean, accent: 'var(--accent)', iconKey: 'bell', duration: 4500 });
    return { ok: true };
  }
  const logNext = loc.lines.filter((_, i) => i !== loc.lineIdx).join('\n');
  if (!(await writeDailyLog(logPath, logNext, log.mtime))) { await tryDeleteFile(ideaPath); return { ok: false }; }
  emitNotesChanged();
  emitNoteToast({
    type: 'note-undo', title: 'New Idea created', message: clean, accent: 'var(--accent)', iconKey: 'bell', duration: 5000,
    action: { label: 'Undo', kind: 'undo-note', payload: { op: 'restore-new-stub', ds, index, text, ideaPath } },
  });
  return { ok: true };
}
async function restoreNewStub({ ds, index, text, ideaPath }) {
  await tryDeleteFile(ideaPath);
  const logPath = `Pulse/Daily Logs/${ds}.md`;
  const r = await readCall('vault_read_file', { path: logPath });
  if (await writeDailyLog(logPath, insertQuickNotesBullet(r.content, index, text), r.mtime)) emitNotesChanged();
}

// — phase 4: check off a task in its own source log (toggle + undo) —
// Tasks are line-addressed (not index/text like notes), so toggling is just
// vault_toggle_task on (path, line); the inverse is the same call again.
// Today's file is also writerCall territory (sessions / plan blocks), so a
// today toggle pipes the returned mtime into the writer cache.
function rememberIfToday(path, res) {
  if (path === `Pulse/Daily Logs/${todayDs()}.md`) rememberMtime(res);
  return res;
}
async function toggleUnorgTask({ path, line, text }) {
  let r;
  try {
    r = rememberIfToday(path, await readCall('vault_toggle_task', { path, line }));
  } catch (e) {
    emitNoteError('Couldn’t update the task', e?.message);
    return { ok: false };
  }
  emitNotesChanged();
  emitNoteToast({
    type: 'note-undo', title: r?.checked === false ? 'Task reopened' : 'Task checked off', message: text,
    accent: 'var(--accent)', iconKey: 'bell', duration: 5000,
    action: { label: 'Undo', kind: 'undo-note', payload: { op: 'restore-toggle', path, line } },
  });
  return { ok: true, checked: r?.checked };
}
async function restoreToggleTask({ path, line }) {
  try {
    rememberIfToday(path, await readCall('vault_toggle_task', { path, line }));
    emitNotesChanged();
  } catch { /* advisory */ }
}

// — Unified Day Pane: per-day section read + append (Tasks / Quick Notes) —
// parseDaySections mirrors the Rust read_unorganized_items scan rules exactly
// (frontmatter / ``` fences / ## Vault Activity skipped; tasks are [-*+] "[ ]"
// bullets anywhere, wikilinks resolved; notes are non-checkbox `- ` bullets
// under the first ## Quick Notes, checkbox bullets consuming ordinals) so the
// viewed day's own items and the carryover inbox describe files identically.
// Tasks carry their absolute file line for vault_toggle_task; both checked
// states return (the pane renders checked tasks muted).
const DAY_TASK_RE = /^[-*+]\s+\[([ xX])\]\s?(.*)$/;
function resolveWikilinksJs(text) {
  // Parity with Rust resolve_wikilinks (parsers/daily.rs:87): [[a/b/c]] → "c";
  // the |alias form is deliberately not special-cased there either.
  return text.replace(/\[\[([^\]]+)\]\]/g, (_, link) => {
    const seg = link.split('/');
    return seg[seg.length - 1];
  });
}
function parseDaySections(content) {
  const lines = content.split('\n');
  const tasks = [];
  let inFrontmatter = false;
  let inFence = false;
  let inVaultActivity = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (i === 0 && trimmed === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (trimmed === '---') inFrontmatter = false; continue; }
    if (trimmed.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (trimmed.startsWith('## ')) {
      inVaultActivity = trimmed.toLowerCase() === '## vault activity';
      continue;
    }
    if (inVaultActivity) continue;
    const m = DAY_TASK_RE.exec(trimmed);
    if (m) {
      const text = resolveWikilinksJs(m[2].trim());
      if (text) tasks.push({ line: i, text, checked: m[1] !== ' ' });
    }
  }
  const notes = [];
  const range = findQuickNotesRange(lines);
  if (range) {
    const idxs = quickNotesBulletLines(lines, range.bodyStart, range.bodyEnd);
    idxs.forEach((lineIdx, ord) => {
      const rem = lines[lineIdx].trim().replace(/^-\s+/, '').trim();
      if (!/^\[[ xX]\]/.test(rem)) notes.push({ index: ord, text: rem });
    });
  }
  return { tasks, notes };
}

// Pure section append — bullet after the section's last bullet (else at body
// end, matching appendQuickNotesLine). A missing section header is created at
// its canonical slot (Tasks: before Upcoming/Sessions; Quick Notes: before
// Tasks/Upcoming/Sessions), else at EOF. Keeps template spacing: a blank line
// before a created header when the prior line has content, and a blank line
// between an appended bullet and a following H2.
function appendSectionLine(content, section, line) {
  const lines = content.split('\n');
  let range = findH2Range(lines, section);
  if (!range) {
    let at = lines.length;
    const anchors = section === 'Tasks' ? ['Upcoming', 'Sessions'] : ['Tasks', 'Upcoming', 'Sessions'];
    for (const a of anchors) {
      const r2 = findH2Range(lines, a);
      if (r2) { at = r2.header; break; }
    }
    const lead = at > 0 && lines[at - 1].trim() !== '' ? [''] : [];
    lines.splice(at, 0, ...lead, `## ${section}`, '');
    range = findH2Range(lines, section);
  }
  const idxs = quickNotesBulletLines(lines, range.bodyStart, range.bodyEnd);
  const at = idxs.length ? idxs[idxs.length - 1] + 1 : range.bodyEnd;
  const gap = at < lines.length && /^## /.test(lines[at]) ? [''] : [];
  lines.splice(at, 0, line, ...gap);
  return lines.join('\n');
}

// Append a bullet to a day's ## Tasks / ## Quick Notes, creating the log from
// the canonical skeleton (+ Pulse Index registration) when the day has none —
// mirrors events.add. Today-writes refresh the writerCall mtime cache.
async function appendToDaySection(ds, section, line) {
  const path = `Pulse/Daily Logs/${ds}.md`;
  let content = null;
  let mtime = null;
  let created = false;
  try {
    const r = await readCall('vault_read_file', { path });
    content = r.content; mtime = r.mtime ?? null;
  } catch (e) {
    if (e?.code === 'NOT_FOUND') created = true;
    else { emitNoteError('Couldn’t open the daily log', e?.message); return { ok: false }; }
  }
  if (created) content = buildDailyLogSkeleton(ds, '');
  const w = await writeDailyLog(path, appendSectionLine(content, section, line), mtime);
  if (!w) return { ok: false };
  if (created) {
    try { await ensurePulseIndexEntry(ds); } catch (e) { console.error('Pulse Index update failed', e); }
  }
  if (ds === todayDs()) rememberMtime(w);
  emitNotesChanged();
  return { ok: true, created, mtime: w?.mtime ?? null };
}

// ── Planner day-pane inline edit + delete-on-empty ─────────────────────────
// Single-click edit writes RAW text back to the source log (no autocaps).
// Clearing the text deletes the item with a 5s undo toast — the moveNoteToIdea
// pattern (JS read-modify-write + note-undo toast), NOT pulse_note_delete (the
// recycling-bin path, which has no Undo). Tasks are line-addressed; notes by
// quick-notes ordinal. Both verify identity before writing so a stale projection
// refreshes instead of clobbering the wrong line.
const DAY_TASK_LINE_RE = /^(\s*[-*+]\s+\[[ xX]\]\s?)(.*)$/;

async function editTaskLine({ path, line, text, newText }) {
  let r;
  try { r = await readCall('vault_read_file', { path }); }
  catch (e) { emitNoteError('Couldn’t open the log', e?.message); return { ok: false }; }
  const lines = r.content.split('\n');
  const m = DAY_TASK_LINE_RE.exec(lines[line] ?? '');
  if (!m || resolveWikilinksJs(m[2].trim()) !== text) {
    emitNoteError('Task changed — refreshed', 'It was edited elsewhere.'); emitNotesChanged(); return { ok: false };
  }
  // The chip shows wikilink-resolved text; editing would flatten [[links]] to
  // their display form. Refuse rather than lose the link silently.
  if (/\[\[/.test(m[2])) {
    emitNoteError('Can’t inline-edit a linked task', 'Open the log to edit tasks that contain [[links]].'); return { ok: false };
  }
  lines[line] = m[1] + newText;
  const w = await writeDailyLog(path, lines.join('\n'), r.mtime);
  if (!w) return { ok: false };
  if (path === `Pulse/Daily Logs/${todayDs()}.md`) rememberMtime(w);
  emitNotesChanged();
  return { ok: true };
}

async function editNoteBullet({ ds, index, text, newText }) {
  const path = `Pulse/Daily Logs/${ds}.md`;
  let r;
  try { r = await readCall('vault_read_file', { path }); }
  catch (e) { emitNoteError('Couldn’t open the log', e?.message); return { ok: false }; }
  const loc = locateQuickNotesBullet(r.content, index, text);
  if (loc.error) { emitNoteError('Note changed — refreshed', 'It was edited elsewhere.'); emitNotesChanged(); return { ok: false }; }
  const pm = /^(\s*-\s+)/.exec(loc.lines[loc.lineIdx]);
  loc.lines[loc.lineIdx] = (pm ? pm[1] : '- ') + newText;
  const w = await writeDailyLog(path, loc.lines.join('\n'), r.mtime);
  if (!w) return { ok: false };
  if (ds === todayDs()) rememberMtime(w);
  emitNotesChanged();
  return { ok: true };
}

async function deleteNoteInline({ ds, index, text }) {
  const path = `Pulse/Daily Logs/${ds}.md`;
  let r;
  try { r = await readCall('vault_read_file', { path }); }
  catch (e) { emitNoteError('Couldn’t open the log', e?.message); return { ok: false }; }
  const loc = locateQuickNotesBullet(r.content, index, text);
  if (loc.error) { emitNoteError('Note changed — refreshed', 'It was edited elsewhere.'); emitNotesChanged(); return { ok: false }; }
  const next = loc.lines.filter((_, i) => i !== loc.lineIdx).join('\n');
  const w = await writeDailyLog(path, next, r.mtime);
  if (!w) return { ok: false };
  if (ds === todayDs()) rememberMtime(w);
  emitNotesChanged();
  emitNoteToast({
    type: 'note-undo', title: 'Note deleted', message: text,
    accent: 'var(--accent)', iconKey: 'bell', duration: 5000,
    action: { label: 'Undo', kind: 'undo-note', payload: { op: 'restore-deleted-note', ds, index, text } },
  });
  return { ok: true };
}

async function restoreDeletedNote({ ds, index, text }) {
  const path = `Pulse/Daily Logs/${ds}.md`;
  try {
    const r = await readCall('vault_read_file', { path });
    const w = await writeDailyLog(path, insertQuickNotesBullet(r.content, index, text), r.mtime);
    if (w) { if (ds === todayDs()) rememberMtime(w); emitNotesChanged(); }
  } catch { /* advisory */ }
}

async function deleteTaskInline({ path, line, text }) {
  let r;
  try { r = await readCall('vault_read_file', { path }); }
  catch (e) { emitNoteError('Couldn’t open the log', e?.message); return { ok: false }; }
  const lines = r.content.split('\n');
  const raw = lines[line];
  const m = raw != null ? DAY_TASK_LINE_RE.exec(raw) : null;
  if (!m || resolveWikilinksJs(m[2].trim()) !== text) {
    emitNoteError('Task changed — refreshed', 'It was edited elsewhere.'); emitNotesChanged(); return { ok: false };
  }
  lines.splice(line, 1);
  const w = await writeDailyLog(path, lines.join('\n'), r.mtime);
  if (!w) return { ok: false };
  if (path === `Pulse/Daily Logs/${todayDs()}.md`) rememberMtime(w);
  emitNotesChanged();
  emitNoteToast({
    type: 'note-undo', title: 'Task deleted', message: text,
    accent: 'var(--accent)', iconKey: 'bell', duration: 5000,
    action: { label: 'Undo', kind: 'undo-note', payload: { op: 'restore-deleted-task', path, line, raw } },
  });
  return { ok: true };
}

async function restoreDeletedTask({ path, line, raw }) {
  try {
    const r = await readCall('vault_read_file', { path });
    const lines = r.content.split('\n');
    const at = Math.min(Math.max(0, line), lines.length);
    lines.splice(at, 0, raw);
    const w = await writeDailyLog(path, lines.join('\n'), r.mtime);
    if (w) { if (path === `Pulse/Daily Logs/${todayDs()}.md`) rememberMtime(w); emitNotesChanged(); }
  } catch { /* advisory */ }
}

// === Health Column: Library page (de)serialize ===
// The Nutrition-Log grammar parse lives in util/nutritionTotals.js (pure,
// imported above). Library pages are flat one-entity-per-file frontmatter,
// off-graph; nested lists/objects ride as a single JSON-string scalar through
// serializeYamlScalar (it double-quotes any string containing ':', and
// parseYamlScalar's quote branch returns it verbatim before the [list] branch —
// so it round-trips as a string we JSON.parse; zero writer change).

const HEALTH_MEALS_DIR = 'Health/Meals';
const HEALTH_SUPPLEMENTS_DIR = 'Health/Supplements';
const HEALTH_GOALS_PATH = 'Health/Goals.md';
const HEALTH_SPLITS_DIR = 'Health/Splits';
const HEALTH_CARDIO_DIR = 'Health/Cardio';

const jsonField = (v) => JSON.stringify(v ?? null);
function parseJsonField(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
function healthFileName(name) {
  return `${String(name).replace(/[\/\\:*?"<>|]/g, '-').trim() || 'Untitled'}.md`;
}
function serializeHealthPage(fields, order, bodyTail) {
  const lines = [];
  for (const key of order) {
    if (fields[key] === undefined || fields[key] === null) continue;
    lines.push(`${key}: ${serializeYamlScalar(fields[key])}`);
  }
  return `---\n${lines.join('\n')}\n---\n${bodyTail || ''}`;
}
function parseHealthPage(content) {
  const out = {};
  if (!content) return out;
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return out;
  for (const raw of fm[1].split('\n')) {
    const m = raw.match(/^(\w+):\s*(.*)$/);
    if (m) out[m[1]] = parseYamlScalar(m[2]);
  }
  return out;
}

const MEAL_FIELD_ORDER = ['type', 'id', 'name', 'ingredients', 'totals', 'micros', 'sugar', 'supplement_ids', 'last_modified'];
function serializeHealthMeal(meal) {
  return serializeHealthPage({
    type: 'Health-Meal',
    id: meal.id,
    name: meal.name,
    ingredients: jsonField(meal.ingredients || []),
    totals: jsonField(meal.totals || {}),
    micros: jsonField(meal.micros || []),
    sugar: jsonField(meal.sugar || { total: null, added: null }),
    supplement_ids: jsonField(meal.supplementIds || []),
    last_modified: new Date().toISOString().slice(0, 10),
  }, MEAL_FIELD_ORDER, '\nHealth Library meal (off-graph). Edit in-app: Health → meal → Edit.\n');
}
function parseHealthMeal(content) {
  const f = parseHealthPage(content);
  return {
    id: f.id, name: f.name,
    ingredients: parseJsonField(f.ingredients, []),
    totals: parseJsonField(f.totals, {}),
    micros: parseJsonField(f.micros, []),
    sugar: parseJsonField(f.sugar, { total: null, added: null }),
    supplementIds: parseJsonField(f.supplement_ids, []),
  };
}

const SUPPLEMENT_FIELD_ORDER = ['type', 'id', 'name', 'dose', 'micros', 'last_modified'];
function serializeHealthSupplement(s) {
  return serializeHealthPage({
    type: 'Health-Supplement',
    id: s.id,
    name: s.name,
    dose: s.dose ?? '',
    micros: jsonField(s.micros || []),
    last_modified: new Date().toISOString().slice(0, 10),
  }, SUPPLEMENT_FIELD_ORDER, '\nHealth Library supplement (off-graph).\n');
}
function parseHealthSupplement(content) {
  const f = parseHealthPage(content);
  return { id: f.id, name: f.name, dose: f.dose || null, micros: parseJsonField(f.micros, []) };
}

const GOALS_FIELD_ORDER = ['type', 'calories', 'protein_pct', 'carb_pct', 'fat_pct', 'micro_targets', 'last_modified'];
function serializeHealthGoals(g) {
  return serializeHealthPage({
    type: 'Health-Goals',
    calories: g.calories,
    protein_pct: g.protein_pct,
    carb_pct: g.carb_pct,
    fat_pct: g.fat_pct,
    micro_targets: jsonField(g.micro_targets || []),
    last_modified: new Date().toISOString().slice(0, 10),
  }, GOALS_FIELD_ORDER, '\nHealth goals (off-graph). Edit in-app: Health → Goals.\n');
}
function parseHealthGoals(content) {
  const f = parseHealthPage(content);
  if (f.calories == null) return null;
  return {
    calories: f.calories,
    protein_pct: f.protein_pct,
    carb_pct: f.carb_pct,
    fat_pct: f.fat_pct,
    micro_targets: parseJsonField(f.micro_targets, []),
  };
}

// --- Health-Split + Cardio-Preset Library pages (sub-plans 4–5) ---
// `cycle` is a NATIVE array field: serializeYamlScalar emits a YAML inline list
// and parseYamlScalar reads it straight back. It is NOT a jsonField — a colon-
// free JSON array wouldn't get quoted and would mis-parse. Per-day target
// exercises live in `## <label>` body sections (Obsidian-editable, no checkbox —
// these are targets; logging snapshots them into the day's `## Workout` block).
const SPLIT_TARGET_RE = /^- (.+?) — (\d+)×([^\s@]+)(?: @(.+))?$/;
function parseSplitDays(content) {
  const days = {};
  let cur = null;
  let dashes = 0;
  let pastFm = false;
  for (const line of (content || '').split('\n')) {
    const trim = line.trim();
    if (!pastFm) { if (trim === '---') { dashes++; if (dashes >= 2) pastFm = true; } continue; }
    const h = trim.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1]; if (!days[cur]) days[cur] = []; continue; }
    const m = line.match(SPLIT_TARGET_RE);
    if (m && cur) days[cur].push({ name: m[1].trim(), sets: parseInt(m[2], 10) || 0, reps: String(m[3]), weight: m[4] ? m[4].trim() : null });
  }
  return days;
}
const SPLIT_FIELD_ORDER = ['type', 'id', 'name', 'cycle', 'active', 'anchor_date', 'anchor_index', 'last_modified'];
function serializeHealthSplit(s) {
  const cycle = Array.isArray(s.cycle) ? s.cycle : [];
  const days = s.days || {};
  const sections = cycle.map((label) => {
    const rows = (days[label] || []).map((e) => {
      const w = e.weight != null && String(e.weight).trim() ? ` @${String(e.weight).trim()}` : '';
      return `- ${e.name} — ${e.sets}×${e.reps}${w}`;
    });
    return `\n## ${label}\n${rows.length ? rows.join('\n') + '\n' : ''}`;
  }).join('');
  const tail = '\nHealth Library workout split (off-graph). Edit in-app: Fitness → split → Edit.\n' + sections;
  return serializeHealthPage({
    type: 'Health-Split',
    id: s.id,
    name: s.name,
    cycle,
    active: !!s.active,
    anchor_date: s.anchorDate || null,
    anchor_index: s.anchorIndex ?? 0,
    last_modified: new Date().toISOString().slice(0, 10),
  }, SPLIT_FIELD_ORDER, tail);
}
function parseHealthSplit(content) {
  const f = parseHealthPage(content);
  const cycle = Array.isArray(f.cycle) ? f.cycle.map(String) : [];
  return {
    id: f.id,
    name: f.name,
    cycle,
    active: f.active === true,
    anchorDate: f.anchor_date || null,
    anchorIndex: f.anchor_index ?? 0,
    days: parseSplitDays(content),
  };
}

const CARDIO_FIELD_ORDER = ['type', 'id', 'name', 'sequence', 'last_modified'];
function serializeHealthCardio(p) {
  return serializeHealthPage({
    type: 'Health-Cardio-Preset',
    id: p.id,
    name: p.name,
    sequence: jsonField(p.sequence || []),
    last_modified: new Date().toISOString().slice(0, 10),
  }, CARDIO_FIELD_ORDER, '\nHealth Library cardio preset (off-graph). Edit in-app: Fitness → Cardio → Edit.\n');
}
function parseHealthCardio(content) {
  const f = parseHealthPage(content);
  return { id: f.id, name: f.name, sequence: parseJsonField(f.sequence, []) };
}

export const api = {
  today: async () => rememberMtime(await readCall('daily_get_today')),
  toggleTask: (rawLine) => writerCall({ command: 'daily_toggle_task', args: { rawLine } }),
  appendSession: (ds, session) =>
    writerCall({ command: 'daily_append_session', args: { ds, session } }),
  updateSession: (ds, oldSessionId, newSession) =>
    writerCall({ command: 'daily_update_session', args: { ds, oldSessionId, newSession } }),
  updatePlanBlock: (ds, oldBlock, newBlock) =>
    writerCall({ command: 'daily_update_plan_block', args: { ds, oldBlock, newBlock } }),
  deleteSession: (ds, sessionId) =>
    writerCall({ command: 'daily_delete_session', args: { ds, sessionId } }),
  updateSessionNote: (ds, sessionId, note) =>
    writerCall({ command: 'daily_update_session_note', args: { ds, sessionId, note } }),
  recentNotes: (limit = 30) => readCall('daily_get_recent_notes', { limit }),
  freeformNote: (text) => writerCall({ command: 'daily_append_freeform_note', args: { text } }),
  routine: () => readCall('daily_get_routine'),
  toggleRoutine: (task) => writerCall({ command: 'daily_toggle_routine', args: { task } }),

  getVaultLog: (page = 1, size = 50) => readCall('reference_get_vault_log', { page, size }),
  getUpdateQueue: () => readCall('reference_render_update_queue'),

  getProjects: () => readCall('daily_list_projects'),

  getKnowledgeDomains: () => readCall('knowledge_list_domains'),
  searchKnowledge: (q, limit = 50) => readCall('knowledge_search', { q, limit }),
  searchAllPages: (q, limit = 20) => readCall('search_pages', { q, limit }),
  getRootCounts: () => readCall('manifest_counts'),

  getPulseFolder: (path = '') => readCall('pulse_get_folder', { path }),

  // Vault File Tree — raw one-level disk listing of any top section folder
  // (Knowledge / Infrastructure / a foreign top folder) by name. Routes to
  // vault_get_folder: lists every real subfolder + page, no manifest dependency.
  getVaultFolder: (slug, path = '', root) => readCall('vault_get_folder', { slug, path, root }),

  getSidebarOrder: (key) => readCall('sidebar_get_order', { key }),
  setSidebarOrder: (key, order) => readCall('sidebar_set_order', { key, order }),

  // Optional `root` ('app' | 'pulse') routes the read/write at a mounted
  // vault (multi-mount). Omitted → undefined → content vault (back-compat).
  getPage: (vaultRelativePath, root) => readCall('vault_render_reference', { path: vaultRelativePath, root }),
  getRawFile: async (vaultRelativePath, root) => {
    const r = await readCall('vault_read_file', { path: vaultRelativePath, root });
    return r.content;
  },
  // Like getRawFile but keeps { content, mime, mtime } — for editors that need the
  // mtime for a write conflict guard (e.g. the GameWiki ScrimViewer).
  getRawFileMeta: (vaultRelativePath, root) => readCall('vault_read_file', { path: vaultRelativePath, root }),
  savePage: (vaultRelativePath, content, mtime, root) =>
    readCall('vault_write_file', { path: vaultRelativePath, content, mtime, root }),
  deleteFile: (vaultRelativePath, root) => readCall('vault_delete_file', { path: vaultRelativePath, root }),
  // Vault File Tree — folder ops (file create/delete reuse savePage / deleteFile).
  createFolder: (path, root) => readCall('vault_create_folder', { path, root }),
  renamePath: (from, to, root) => readCall('vault_rename_path', { from, to, root }),
  deleteFolder: (path, root) => readCall('vault_delete_folder', { path, root }),
  toggleTaskAtLine: (path, line, root) => readCall('vault_toggle_task', { path, line, root }),
  resolveLink: (target, embed = false) => readCall('vault_resolve_link', { target, embed }),

  // Official Docs page (v1.0.0+). The manifest drives the left TOC; bodies
  // render via the existing vault_render_reference pipeline.
  docs: {
    getManifest: () => readCall('docs_get_manifest'),
    getVersion: async () => {
      try {
        const r = await readCall('vault_read_file', { path: 'Iskariel/Releases.md', root: 'app' });
        const m = r.content.match(/^Version:\s*([\d.]+)/m);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    },
  },

  build: {
    start: (mode) => invoke('build_app_start', { mode }),
    status: () => invoke('build_app_status'),
    cancel: () => invoke('build_app_cancel'),
  },

  // Multi-vault registry (commands::vaults). Maps 1:1 to the Rust IPC
  // commands; readCall surfaces the structured VaultError (.code 'INVALID' /
  // 'NOT_FOUND') the Vaults UI shows inline.
  vaults: {
    list: () => readCall('vaults_list'),
    validate: (path) => readCall('validate_vault', { path }),
    add: (name, path, manifestEnabled = true) =>
      readCall('vaults_add', { name, path, manifestEnabled }),
    remove: (id) => readCall('vaults_remove', { id }),
    setActive: (id) => readCall('set_active_vault', { id }),
    generateManifest: (id) => readCall('generate_manifest', { id }),
    scaffold: (name, path, manifestEnabled = true) =>
      readCall('scaffold_vault', { name, path, manifestEnabled }),
    shape: (id = null) => readCall('vault_list_top_folders', { id }),
    setMapping: (id, mapping) => readCall('set_vault_mapping', { id, mapping }),
  },

  // Domain Builder (commands::domain::scaffold_domain). Dry-run returns the
  // ScaffoldPlan for preview; commit writes it atomically (rollback on error).
  domains: {
    scaffold: (config, dryRun = false, reopen = false) =>
      readCall('scaffold_domain', { config, dryRun, reopen }),
    readConfig: (vaultId, domainName) =>
      readCall('read_domain_config', { vaultId, domainName }),
  },

  // Release Queue — staging file the Ship Release button compiles. Read-only
  // from the app; entries are authored by Close the Loop.
  releaseQueue: {
    read: async () => {
      try {
        const r = await readCall('vault_read_file', { path: RELEASE_QUEUE_PATH, root: 'app' });
        return { content: r.content, mtime: r.mtime ?? null, exists: true };
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { content: '', mtime: null, exists: false };
        throw e;
      }
    },
  },

  releases: {
    // Raw Releases.md + mtime (getRawFile drops mtime; the ship flow needs it
    // for the conflict gate).
    readRaw: async () => {
      const r = await readCall('vault_read_file', { path: RELEASES_PATH, root: 'app' });
      return { content: r.content, mtime: r.mtime ?? null };
    },
  },

  // Compile + publish: writes the composed Releases.md, clears the queue, and
  // bumps the four code version files. Content is composed in JS; this is the
  // transactional writer. Throws an Error with .code === 'CONFLICT' on drift.
  releasePublish: ({ releasesContent, queueContent, version, releasesBaseMtime, queueBaseMtime }) =>
    readCall('release_publish', { releasesContent, queueContent, version, releasesBaseMtime, queueBaseMtime }),

  // Offline USDA food search (Health Column). Read-only; no mtime gate.
  usda: {
    search: (query, limit) => readCall('usda_food_search', { query, limit }),
    food: (fdcId) => readCall('usda_food', { fdcId }),
  },
  blockLibrary: {
    read: async () => {
      try {
        const r = await readCall('vault_read_file', { path: BLOCK_LIBRARY_PATH, root: 'pulse' });
        const { blocks, lastModified } = parseBlockLibrary(r.content);
        return { blocks, mtime: r.mtime ?? null, lastModified, exists: true };
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { blocks: [], mtime: null, lastModified: null, exists: false };
        throw e;
      }
    },
    write: async (blocks, baseMtime) => {
      const fmBody = serializeBlockLibrary(blocks);
      const content = `---\n${fmBody}\n---${BLOCK_LIBRARY_BODY_TAIL}`;
      const r = await readCall('vault_write_file', { path: BLOCK_LIBRARY_PATH, content, mtime: baseMtime, root: 'pulse' });
      return { mtime: r?.mtime ?? null, blocks };
    },
  },

  // Health Column. Day ops go through writerCall (they write today's daily log,
  // so they share lastDailyMtime with the session/plan writers — same optimistic-
  // concurrency scheme). Library CRUD uses readCall('vault_*', root:'library')
  // with each page's own mtime, like blockLibrary. Day reads parse JS-side.
  health: {
    readDay: async (ds) => {
      const path = `Pulse/Daily Logs/${ds}.md`;
      try {
        const r = await readCall('vault_read_file', { path, root: 'pulse' });
        if (ds === todayDs()) rememberMtime(r);
        return {
          meals: parseNutritionLog(r.content),
          workout: parseWorkoutLog(r.content),
          cardio: parseCardioLog(r.content),
          mtime: r.mtime ?? null,
          exists: true,
        };
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { meals: [], workout: null, cardio: [], mtime: null, exists: false };
        throw e;
      }
    },
    logMeal: (ds, entry) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'log_meal', payload: entry } }),
    editMealLog: (ds, target, entry) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'edit_meal_log', payload: { target, entry } } }),
    deleteMealLog: (ds, target) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'delete_meal_log', payload: target } }),

    listMeals: () => readCall('health_list_dir', { sub: 'Meals' }),
    listSupplements: () => readCall('health_list_dir', { sub: 'Supplements' }),
    readMealDef: async (file) => {
      const r = await readCall('vault_read_file', { path: `${HEALTH_MEALS_DIR}/${file}`, root: 'library' });
      return { ...parseHealthMeal(r.content), file, mtime: r.mtime ?? null };
    },
    saveMealDef: async (meal, baseMtime) => {
      const file = meal.file || healthFileName(meal.name);
      const r = await readCall('vault_write_file', { path: `${HEALTH_MEALS_DIR}/${file}`, content: serializeHealthMeal(meal), mtime: baseMtime, root: 'library' });
      return { file, mtime: r?.mtime ?? null };
    },
    deleteMealDef: (file) => readCall('vault_delete_file', { path: `${HEALTH_MEALS_DIR}/${file}`, root: 'library' }),
    readSupplementDef: async (file) => {
      const r = await readCall('vault_read_file', { path: `${HEALTH_SUPPLEMENTS_DIR}/${file}`, root: 'library' });
      return { ...parseHealthSupplement(r.content), file, mtime: r.mtime ?? null };
    },
    saveSupplementDef: async (s, baseMtime) => {
      const file = s.file || healthFileName(s.name);
      const r = await readCall('vault_write_file', { path: `${HEALTH_SUPPLEMENTS_DIR}/${file}`, content: serializeHealthSupplement(s), mtime: baseMtime, root: 'library' });
      return { file, mtime: r?.mtime ?? null };
    },
    deleteSupplementDef: (file) => readCall('vault_delete_file', { path: `${HEALTH_SUPPLEMENTS_DIR}/${file}`, root: 'library' }),
    readGoals: async () => {
      try {
        const r = await readCall('vault_read_file', { path: HEALTH_GOALS_PATH, root: 'library' });
        return { goals: parseHealthGoals(r.content), mtime: r.mtime ?? null, exists: true };
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { goals: null, mtime: null, exists: false };
        throw e;
      }
    },
    saveGoals: async (goals, baseMtime) => {
      const r = await readCall('vault_write_file', { path: HEALTH_GOALS_PATH, content: serializeHealthGoals(goals), mtime: baseMtime, root: 'library' });
      return { mtime: r?.mtime ?? null };
    },

    // --- Fitness day ops (workout = whole-block seed/replace + per-exercise
    // edit; cardio = per-segment, mirrors meals). All ride daily_health_op. ---
    logWorkout: (ds, entry) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'log_workout', payload: entry } }),
    editWorkout: (ds, index, exercise) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'edit_workout', payload: { index, exercise } } }),
    deleteWorkout: (ds) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'delete_workout', payload: {} } }),
    logCardio: (ds, entry) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'log_cardio', payload: entry } }),
    editCardio: (ds, index, entry) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'edit_cardio', payload: { index, entry } } }),
    deleteCardio: (ds, index, target) =>
      writerCall({ command: 'daily_health_op', args: { ds, op: 'delete_cardio', payload: { index, target } } }),

    // --- Splits Library CRUD (Health/Splits, root:'library') ---
    listSplits: () => readCall('health_list_dir', { sub: 'Splits' }),
    readSplitDef: async (file) => {
      const r = await readCall('vault_read_file', { path: `${HEALTH_SPLITS_DIR}/${file}`, root: 'library' });
      return { ...parseHealthSplit(r.content), file, mtime: r.mtime ?? null };
    },
    saveSplitDef: async (split, baseMtime) => {
      const file = split.file || healthFileName(split.name);
      const r = await readCall('vault_write_file', { path: `${HEALTH_SPLITS_DIR}/${file}`, content: serializeHealthSplit(split), mtime: baseMtime, root: 'library' });
      return { file, mtime: r?.mtime ?? null };
    },
    deleteSplitDef: (file) => readCall('vault_delete_file', { path: `${HEALTH_SPLITS_DIR}/${file}`, root: 'library' }),

    // --- Cardio-preset Library CRUD (Health/Cardio, root:'library') ---
    listCardioPresets: () => readCall('health_list_dir', { sub: 'Cardio' }),
    readCardioDef: async (file) => {
      const r = await readCall('vault_read_file', { path: `${HEALTH_CARDIO_DIR}/${file}`, root: 'library' });
      return { ...parseHealthCardio(r.content), file, mtime: r.mtime ?? null };
    },
    saveCardioDef: async (preset, baseMtime) => {
      const file = preset.file || healthFileName(preset.name);
      const r = await readCall('vault_write_file', { path: `${HEALTH_CARDIO_DIR}/${file}`, content: serializeHealthCardio(preset), mtime: baseMtime, root: 'library' });
      return { file, mtime: r?.mtime ?? null };
    },
    deleteCardioDef: (file) => readCall('vault_delete_file', { path: `${HEALTH_CARDIO_DIR}/${file}`, root: 'library' }),
  },

  eventTypes: {
    read: async () => {
      try {
        const r = await readCall('vault_read_file', { path: EVENT_TYPES_PATH, root: 'pulse' });
        const { types, lastModified } = parseEventTypes(r.content);
        return { types, mtime: r.mtime ?? null, lastModified, exists: true };
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { types: [], mtime: null, lastModified: null, exists: false };
        throw e;
      }
    },
    write: async (types, baseMtime) => {
      const fmBody = serializeEventTypes(types);
      const content = `---\n${fmBody}\n---${EVENT_TYPES_BODY_TAIL}`;
      const r = await readCall('vault_write_file', { path: EVENT_TYPES_PATH, content, mtime: baseMtime, root: 'pulse' });
      return { mtime: r?.mtime ?? null, types };
    },
  },

  events: {
    // Schedule an event onto a day's daily log. Creates the full canonical
    // daily log (and registers it in the Pulse Index) when the day has none.
    add: async (ds, fields) => {
      const path = `Pulse/Daily Logs/${ds}.md`;
      const bullet = formatEventBullet({ ds, ...fields });
      let content = null;
      let mtime = null;
      let created = false;
      try {
        const r = await readCall('vault_read_file', { path });
        content = r.content; mtime = r.mtime ?? null;
      } catch (e) {
        if (e?.code === 'NOT_FOUND') created = true;
        else throw e;
      }
      const newContent = created
        ? buildDailyLogSkeleton(ds, bullet)
        : insertIntoUpcoming(content, bullet);
      const w = await readCall('vault_write_file', { path, content: newContent, mtime });
      if (created) {
        try { await ensurePulseIndexEntry(ds); } catch (e) { console.error('Pulse Index update failed', e); }
      }
      return { mtime: w?.mtime ?? null, created };
    },
  },

  dailyFrame: {
    read: async () => {
      try {
        const r = await readCall('vault_read_file', { path: SCHEDULE_PATH });
        const { frames, extras } = parseDailyFrame(r.content);
        return { frames, extras, mtime: r.mtime ?? null, exists: true };
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { frames: emptyFramesMap(), extras: {}, mtime: null, exists: false };
        throw e;
      }
    },
    write: async (frames, baseMtime) => {
      // Read fresh to preserve the user-authored prose body/extras AND to
      // capture the current mtime for the write's conflict guard. We use this
      // freshly-read mtime, NOT the caller's cached `baseMtime`: useDailyFrame
      // only re-reads on 'manifest' events, so its cached mtime drifts from disk
      // after a 'schedule'-only change and would falsely reject the write —
      // silently dropping a frame retime (the edit-mode drag "snap-back" bug).
      // Last-write-wins, matching the per-day override path (setOverride).
      let oldBody = '';
      let extras = {};
      let freshMtime = null;
      try {
        const existing = await readCall('vault_read_file', { path: SCHEDULE_PATH });
        const parsed = parseDailyFrame(existing.content);
        extras = parsed.extras;
        freshMtime = existing.mtime ?? null;
        const m = existing.content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
        if (m) oldBody = m[1];
      } catch (e) {
        if (e?.code !== 'NOT_FOUND') throw e;
      }
      const fmBody = buildScheduleFrontmatter(frames, extras);
      const content = `---\n${fmBody}\n---\n${oldBody}`;
      const r = await readCall('vault_write_file', { path: SCHEDULE_PATH, content, mtime: freshMtime });
      return { mtime: r?.mtime ?? null, frames };
    },
    getOverride: async (ds) => {
      const path = `Pulse/Daily Logs/${ds}.md`;
      try {
        const r = await readCall('vault_read_file', { path });
        return parseFrameOverride(r.content);
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return {};
        throw e;
      }
    },
    setOverride: async (ds, frameId, override) => {
      // Create the day's daily log (and register it in the Pulse Index) when the
      // day has none — otherwise the override has nowhere to live and the read
      // would throw NOT_FOUND, stranding the dragged/resized frame. Mirrors
      // events.add.
      const path = `Pulse/Daily Logs/${ds}.md`;
      let content = null;
      let mtime = null;
      let created = false;
      try {
        const r = await readCall('vault_read_file', { path });
        content = r.content; mtime = r.mtime ?? null;
      } catch (e) {
        if (e?.code === 'NOT_FOUND') created = true;
        else throw e;
      }
      if (created) content = buildDailyLogSkeleton(ds, '');
      const current = parseFrameOverride(content) || {};
      const updated = {
        ...current,
        [frameId]: override.deleted
          ? { deleted: true }
          : { start: override.start, end: override.end },
      };
      const newContent = setFrameOverrideInContent(content, updated);
      const r = await readCall('vault_write_file', { path, content: newContent, mtime });
      if (created) {
        try { await ensurePulseIndexEntry(ds); } catch (e) { console.error('Pulse Index update failed', e); }
      }
      return { mtime: r?.mtime ?? null, override: updated[frameId] };
    },
    clearOverride: async (ds, frameId) => {
      const path = `Pulse/Daily Logs/${ds}.md`;
      let existing;
      try {
        existing = await readCall('vault_read_file', { path });
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { mtime: null }; // no log → nothing to clear
        throw e;
      }
      const current = parseFrameOverride(existing.content) || {};
      if (!(frameId in current)) return { mtime: existing.mtime ?? null };
      const updated = { ...current };
      delete updated[frameId];
      const newContent = setFrameOverrideInContent(existing.content, updated);
      const r = await readCall('vault_write_file', { path, content: newContent, mtime: existing.mtime });
      return { mtime: r?.mtime ?? null };
    },
  },

  upcoming: {
    // Raw ## Upcoming section text for a day (for the multi-day agenda +
    // reminder scheduler, which parse events with util/events).
    readSection: async (ds) => {
      const path = `Pulse/Daily Logs/${ds}.md`;
      try {
        const r = await readCall('vault_read_file', { path });
        return extractH2Section(r.content, 'Upcoming');
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return '';
        throw e;
      }
    },
  },

  unorganized: {
    // All unorganized quick-note bullets + unchecked tasks across every daily
    // log except today (server-side scan — see Rust `read_unorganized_items`).
    // Shape: { tasks: [{path,line,text,sourceDate}], notes: [{sourceDate,index,text}] }.
    read: () => readCall('daily_get_unorganized'),
  },

  // Per-day section data for the Planner day pane: the viewed day's Tasks +
  // Quick Notes (parseDaySections shapes — tasks carry absolute file lines for
  // vault_toggle_task). The adds append to any day's sections, creating the
  // log / section on demand; consumers refresh via notes-changed + watcher
  // events, so no toasts fire here.
  daySections: {
    read: async (ds) => {
      const path = `Pulse/Daily Logs/${ds}.md`;
      try {
        const r = await readCall('vault_read_file', { path });
        return { exists: true, mtime: r.mtime ?? null, ...parseDaySections(r.content) };
      } catch (e) {
        if (e?.code === 'NOT_FOUND') return { exists: false, mtime: null, tasks: [], notes: [] };
        throw e;
      }
    },
    addTask: (ds, text) => appendToDaySection(ds, 'Tasks', `- [ ] ${text}`),
    addNote: (ds, text) => appendToDaySection(ds, 'Quick Notes', `- ${text}`),
  },

  // Per-item actions for the Planner's Unorganized Notes pane. Note actions
  // each target the note's OWN source log (`ds = sourceDate`); deleteNote and
  // the others raise a 5s undo toast whose inverse is invoked by the
  // notification's undo-note action (see NotificationProvider). toggleTask
  // checks off a task in its source log; restoreToggle is its undo.
  noteActions: {
    deleteNote: deleteYesterdayNote,
    moveNoteToIdea,
    restoreMovedNote,
    carryForward: (a) => sendNoteToToday({ ...a, asTask: false }),
    convertToTask: (a) => sendNoteToToday({ ...a, asTask: true }),
    restoreFromToday,
    createStubIdea,
    restoreNewStub,
    toggleTask: toggleUnorgTask,
    restoreToggle: restoreToggleTask,
    editTask: editTaskLine,
    editNote: editNoteBullet,
    deleteNoteInline,
    deleteTask: deleteTaskInline,
    restoreDeletedNote,
    restoreDeletedTask,
  },
};

const BUILD_EVENT_NAMES = ['build-stdout', 'build-stderr', 'build-phase', 'build-done'];

export function subscribeBuildEvents(handler) {
  const unlisteners = BUILD_EVENT_NAMES.map(name =>
    tauriListen(name, evt => handler(name, evt.payload)),
  );
  return () => {
    for (const p of unlisteners) {
      p.then(fn => fn()).catch(() => {});
    }
  };
}

// In-app browser per-tab metadata stream. The Rust browser_* commands emit
// `browser-tab-update` with a {tabId, ...partial} payload (title / url + nav
// state / loading / favicon) as each tab's WebKit view changes. The browser
// module's tab store merges the partial into that tab.
export function subscribeBrowserTabEvents(handler) {
  const p = tauriListen('browser-tab-update', evt => handler(evt.payload));
  return () => { p.then(fn => fn()).catch(() => {}); };
}

// SF5 vault-sync pulse: ≥3 events within 1.5s → broadcast for brand pill.
let _recentEventTimes = [];
function _maybePulse() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  const now = Date.now();
  _recentEventTimes.push(now);
  _recentEventTimes = _recentEventTimes.filter(t => t >= now - 1500);
  if (_recentEventTimes.length >= 3) {
    _recentEventTimes = [];
    window.dispatchEvent(new CustomEvent('agentic:vault-sync-pulse'));
  }
}

// Vault invalidation stream. Sync return — unsub closes over the
// Promise<UnlistenFn> returned by each listen() call.
const VAULT_EVENT_NAMES = ['today', 'day', 'schedule', 'routine', 'skills', 'log', 'queue', 'manifest', 'file'];

export function subscribeEvents(handler) {
  function route(name, payload) {
    _maybePulse();
    handler(name, payload ?? '');
  }
  const unlisteners = VAULT_EVENT_NAMES.map(name =>
    tauriListen(name, evt => route(name, evt.payload)),
  );
  return () => {
    for (const p of unlisteners) {
      p.then(fn => fn()).catch(() => {});
    }
  };
}
