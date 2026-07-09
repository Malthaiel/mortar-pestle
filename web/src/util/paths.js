// Absolute-path predicate for asset-URL marshalling. True when `p` must NOT be
// joined against a media root: POSIX (`/…`), Windows drive-rooted (`C:\…` /
// `C:/…`), or UNC (`\\server\…`). The drive-letter branch is the site of a past
// Windows bug (a `C:\…` clip path wrongly joined against the vault root). Pure +
// node-importable — the testable extraction of api.js's absFromInput guard.
export function isAbsolutePath(p) {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}
