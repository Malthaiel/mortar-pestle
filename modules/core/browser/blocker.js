// Shield (ad-blocker) controls for the in-app browser — a thin layer over the
// Rust `blocker_*` commands plus the persisted state in the browser module
// settings bag (`focus_settings.modules.browser.blocker`). The backend keeps
// blocker state in-memory and resets to ON with an empty allow-list each launch,
// so `replayBlockerToBackend` re-pushes the persisted choice on start.

import { invoke } from '@tauri-apps/api/core';
import { readModuleBag } from '@host/module-sdk/index.js';
import { getSnapshot } from './tabStore.js';

const PID = 'browser';

// Persisted bag shape: { enabled: bool (default true), allowlist: string[] }.
// Hosts are stored www-stripped (matching `hostOf`); the backend suffix-matches,
// so an entry also covers subdomains.
export function readBlocker() {
  const b = readModuleBag(PID).blocker || {};
  return {
    enabled: b.enabled !== false,
    allowlist: Array.isArray(b.allowlist) ? b.allowlist : [],
  };
}

export function isHostAllowed(allowlist, host) {
  return !!host && allowlist.includes(host);
}

export function applyEnabled(enabled) {
  return invoke('blocker_set_enabled', { enabled }).catch(() => {});
}

export function applySiteAllowed(host, allowed) {
  if (!host) return Promise.resolve();
  return invoke('blocker_set_site_allowed', { host, allowed }).catch(() => {});
}

// Reload every open native tab so a Shield change takes effect: content-filters
// and scriptlets only apply at load time (the proxy already honors the live
// flag per request). Tabs without a native view no-op in the backend.
export function reloadShieldTabs() {
  try {
    for (const t of getSnapshot().tabs) {
      if (t.url) invoke('browser_reload', { id: t.id }).catch(() => {});
    }
  } catch { /* no tabs yet */ }
}

// One-shot on app start: re-push persisted enabled + allow-list into the
// in-memory backend (which resets to defaults each launch).
let _replayed = false;
export function replayBlockerToBackend() {
  if (_replayed) return;
  _replayed = true;
  const { enabled, allowlist } = readBlocker();
  applyEnabled(enabled);
  for (const h of allowlist) applySiteAllowed(h, true);
}
