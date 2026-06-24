// Module-level active vault name for Obsidian deep-links. VaultProvider keeps
// this in sync with the active vault (setActiveVaultName) so `obsidian://` links
// target whatever vault the user is in, not a hardcoded "Citadel". Callers that
// pass only a path inherit the active name via the default parameter.
let activeVaultName = 'Citadel';

export function setActiveVaultName(name) {
  if (name) activeVaultName = name;
}

export function obsidianHref(path, vaultName = activeVaultName) {
  return 'obsidian://open?vault=' + encodeURIComponent(vaultName) +
    '&file=' + encodeURIComponent(path.replace(/\.md$/, ''));
}

// Route a vault-relative path to its mounted vault for the Obsidian deep-link,
// mirroring api.js routeArgs: `Pulse/…` paths live in the always-mounted Pulse
// vault (an app-data singleton named for its folder), everything else in the
// active content vault. Use this wherever the path may be Pulse-rooted (e.g.
// daily-log source links) instead of obsidianHref(), which assumes the active vault.
export function obsidianHrefForPath(path) {
  if (typeof path === 'string' && path.startsWith('Pulse/')) {
    return obsidianHref(path, 'Pulse');
  }
  return obsidianHref(path);
}

export function timeAgo(value) {
  if (!value) return '';
  const then = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(then)) return '';
  const diff = (Date.now() - then) / 1000;
  if (diff < 60)       return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7)  return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}
