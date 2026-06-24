const STORAGE_KEY = 'aos_last_seen_version';
const CURRENT_VERSION = import.meta.env.PACKAGE_VERSION || '0.7.0';

export function getCurrentVersion() {
  return CURRENT_VERSION;
}

export function getLastSeenVersion() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setLastSeenVersion(version) {
  try {
    localStorage.setItem(STORAGE_KEY, version || CURRENT_VERSION);
  } catch {
    // ignore
  }
}

export function hasNewVersion() {
  const last = getLastSeenVersion();
  return last !== CURRENT_VERSION;
}

export function getNewFeatures(releases) {
  if (!releases || releases.length === 0) return [];
  const current = releases.find(r => r.version === CURRENT_VERSION);
  if (!current) return [];
  return current.features || [];
}
