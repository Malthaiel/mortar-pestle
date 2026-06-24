// Module SDK endpoint adapter — translates legacy (method, path) calls from
// api.vault.endpoint into Tauri command invocations during the SF10 deprecation
// window. New module code should use api.invoke(commandName, args) directly.
//
// 14 distinct command mappings encoded as 13 ROUTES entries (the
// GET /api/video/series entry branches list vs read on the ?path= query).
// Routes outside this set return null; the SDK seam throws "Endpoint not
// migrated" since no HTTP surface exists post-SF12.

const ROUTES = [
  // Music
  { method: 'GET',    pattern: /^\/api\/music\/albums$/,
    resolve: () => ({ command: 'music_list_albums', args: {} }) },
  { method: 'GET',    pattern: /^\/api\/music\/album$/,
    resolve: (m, q) => ({ command: 'music_read_album', args: { path: q.get('path') } }) },
  { method: 'POST',   pattern: /^\/api\/music\/mark-status$/,
    resolve: (m, q, b) => ({ command: 'music_mark_status', args: { path: b.path, status: b.status } }) },
  { method: 'POST',   pattern: /^\/api\/music\/mark-rating$/,
    resolve: (m, q, b) => ({ command: 'music_mark_rating', args: { path: b.path, rating: b.rating } }) },

  // Video — /api/video/series resolves to LIST when no ?path=, READ when ?path=…
  { method: 'GET',    pattern: /^\/api\/video\/series$/,
    resolve: (m, q) => q.has('path')
      ? { command: 'video_read_series', args: { path: q.get('path') } }
      : { command: 'video_list_series', args: {} } },
  { method: 'GET',    pattern: /^\/api\/video\/probe$/,
    resolve: (m, q) => ({ command: 'video_probe', args: { path: q.get('path') } }) },
  { method: 'POST',   pattern: /^\/api\/video\/watched$/,
    resolve: (m, q, b) => ({ command: 'video_mark_episode_watched',
      args: { seriesPath: b.seriesPath, episode: b.episode, season: b.season } }) },
  { method: 'POST',   pattern: /^\/api\/video\/mark-rating$/,
    resolve: (m, q, b) => ({ command: 'video_mark_series_rating',
      args: { seriesPath: b.seriesPath, rating: b.rating } }) },
  { method: 'POST',   pattern: /^\/api\/video\/mark-status$/,
    resolve: (m, q, b) => ({ command: 'video_mark_series_status',
      args: { seriesPath: b.seriesPath, status: b.status, season: b.season } }) },

  // Reveal in OS file manager (SF11)
  { method: 'POST',   pattern: /^\/api\/reveal$/,
    resolve: (m, q, b) => ({ command: 'reveal_in_files', args: { path: b.path } }) },

  // Vault file routes
  { method: 'GET',    pattern: /^\/api\/file\/(.+)$/,
    resolve: (m) => ({ command: 'vault_read_file', args: { path: decodeURIComponent(m[1]) } }) },
  { method: 'PUT',    pattern: /^\/api\/file\/(.+)$/,
    resolve: (m, q, b) => ({ command: 'vault_write_file',
      args: { path: decodeURIComponent(m[1]), content: b.content, mtime: b.mtime } }) },
  { method: 'DELETE', pattern: /^\/api\/file\/(.+)$/,
    resolve: (m) => ({ command: 'vault_delete_file', args: { path: decodeURIComponent(m[1]) } }) },
];

export function mapEndpoint(method, path, body) {
  const pathStr = String(path);
  const queryIdx = pathStr.indexOf('?');
  const pathOnly = queryIdx === -1 ? pathStr : pathStr.slice(0, queryIdx);
  const queryStr = queryIdx === -1 ? '' : pathStr.slice(queryIdx + 1);
  const query = new URLSearchParams(queryStr);
  const bodyObj = body ?? {};
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathOnly);
    if (match) return route.resolve(match, query, bodyObj);
  }
  return null;
}
