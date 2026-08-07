// Module-owned API helpers. Each call routes through the SDK's
// api.vault.endpoint so the module imports nothing from web/src/api.js
// (the host's request layer); only the module's own register() touches the
// SDK instance via bindMusicApi.

let _api = null;

export function bindMusicApi(api) { _api = api; }

export const musicApi = {
  listAlbums:       () => _api.invoke('music_list_albums', {}),
  readAlbum:        (path) => _api.invoke('music_read_album', { path }),
  markAlbumStatus:  (path, status) => _api.invoke('music_mark_status', { path, status }),
  markAlbumRating:  (path, rating) => _api.invoke('music_mark_rating', { path, rating }),
  setNotes:         (path, notes, baseMtime) => _api.invoke('music_set_notes', { path, notes, baseMtime: baseMtime ?? null }),
  deleteAlbum:      (path) => _api.invoke('music_delete_album', { path }),
  // Browse — MusicBrainz discovery (read-only; covers hot-linked from CAA).
  searchReleaseGroups: (query, limit, offset) => _api.invoke('music_search_releasegroups', { query, limit, offset }),
  searchArtists:       (query) => _api.invoke('music_search_artists', { query }),
  searchRecordings:    (query) => _api.invoke('music_search_recordings', { query }),
  // YouTube search (yt-dlp `ytsearch`, shelled out through the download script).
  searchYoutube:       (query, limit) => _api.invoke('music_search_youtube', { query, limit: limit ?? null }),
  // Local track-title search across every album page's tracklist.
  searchTracks:        (query, limit) => _api.invoke('music_search_tracks', { query, limit: limit ?? null }),
  artistReleaseGroups: (artistMbid) => _api.invoke('music_artist_releasegroups', { artistMbid }),
  releaseGroupDetail:  (rgMbid) => _api.invoke('music_releasegroup_detail', { rgMbid }),
  releasePersonnel:    (rgMbid) => _api.invoke('music_release_personnel', { rgMbid }),
  // Browse — download engine (script-backed, sequential, background).
  downloadEnqueue: (rgMbid, title, artist, cover, onlyMissing, metadataOnly, initialStatus) =>
    _api.invoke('music_download_enqueue', {
      rgMbid, title, artist, cover, onlyMissing,
      metadataOnly: !!metadataOnly, initialStatus: initialStatus || null,
    }),
  downloadStatus:  () => _api.invoke('music_download_status', {}),
  downloadCancel:  (jobId) => _api.invoke('music_download_cancel', { jobId }),
  // Spotify export → deferred. See Plans/Spotify Token Proxy.md: the Web API now
  // requires a Premium-backed token, so export waits on a project token proxy.
  // No music_spotify_* commands exist yet — the Export UI is a stub.
  // Playlists — user-curated, vault-backed (one hub page per playlist).
  listPlaylists:     () => _api.invoke('music_list_playlists', {}),
  readPlaylist:      (path) => _api.invoke('music_read_playlist', { path }),
  writePlaylist:     (title, tracks, originalPath, coverPath) =>
    _api.invoke('music_write_playlist', { title, tracks, originalPath: originalPath || null, coverPath: coverPath || null }),
  savePlaylistCover: (title, bytes, ext) => _api.invoke('music_save_playlist_cover', { title, bytes, ext }),
  deletePlaylist:    (path) => _api.invoke('music_delete_playlist', { path }),
  revealInFiles:    (path) => _api.invoke('reveal_in_files', { path }),
};

export function subscribeManifest(handler) {
  return _api.vault.subscribe('manifest', handler);
}
