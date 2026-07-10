// Media / asset-URL helpers, extracted from api.js (plan 026 Half A). Depends only
// on `invoke` (from ./core.js — a leaf module, so no cycle back through api.js),
// `convertFileSrc`, and `isAbsolutePath`.
import { convertFileSrc } from '@tauri-apps/api/core';
import { isAbsolutePath } from '../util/paths.js';
import { invoke } from './core.js';

// WebKitGTK rejects custom URI schemes (`mortar-pestle-asset://...`) in
// HTMLMediaElement, so audio/video can't use convertFileSrc. The Rust side
// runs a loopback HTTP server on a kernel-assigned 127.0.0.1 port; the port
// is fetched once at startup via `media_server_port` and cached. Plain
// `<img>` tags happily accept mortar-pestle-asset:// so they still use it.
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
let _mediaToken = null;
let _mediaBaseUrlPromise = null;
async function mediaBaseUrl() {
  if (_mediaBaseUrl) return _mediaBaseUrl;
  if (!_mediaBaseUrlPromise) {
    _mediaBaseUrlPromise = invoke('media_server_port')
      .then((info) => {
        if (info && typeof info.port === 'number' && info.port > 0) {
          _mediaBaseUrl = `http://127.0.0.1:${info.port}`;
          _mediaToken = info.token;
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
  if (isAbsolutePath(p)) return p;
  return `${base || VAULT_ROOT_FOR_MEDIA}/${p}`;
}
export function mediaUrl(p, opts) {
  if (!p) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  const abs = absFromInput(p, opts && opts.library ? LIBRARY_ROOT_FOR_MEDIA : undefined);
  // <img> path — still works via custom scheme.
  return convertFileSrc(abs, 'mortar-pestle-asset');
}
// Rewrite dead `<img src="/api/file/{path}">` (emitted by the Rust Reading-mode
// renderer for `![[image]]` embeds — the Fastify route was deleted) to a live
// mortar-pestle-asset:// URL. Run on any container after injecting reference-render
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
  return `${_mediaBaseUrl}/media?path=${encodeURIComponent(abs)}&t=${_mediaToken}`;
}
// Rewrite an `mortar-pestle-asset://localhost/<rest>` URL (as returned by Rust
// video_start_transcode / video_extract_subs) into the equivalent loopback
// HTTP URL for WebKit-compatible media playback.
export function rewriteAssetToHttp(assetUrl) {
  if (!assetUrl || !_mediaBaseUrl) return null;
  const prefix = 'mortar-pestle-asset://localhost';
  if (!assetUrl.startsWith(prefix)) return assetUrl;
  return _mediaBaseUrl + assetUrl.slice(prefix.length);
}
export async function awaitMediaBaseUrl() {
  return mediaBaseUrl();
}
