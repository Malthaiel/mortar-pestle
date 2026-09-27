// Module-owned API helpers. Each call routes through the SDK's
// api.vault.endpoint so the module imports nothing from web/src/api.js
// (the host's request layer); only the module's own register() touches the
// SDK instance via bindMusicApi.

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

let _api = null;

export function bindMusicApi(api) { _api = api; }

export const musicApi = {
  listAlbums:       () => _api.invoke('music_list_albums', {}),
  readAlbum:        (path) => _api.invoke('music_read_album', { path }),
  markAlbumStatus:  (path, status) => _api.invoke('music_mark_status', { path, status }),
  markAlbumRating:  (path, rating) => _api.invoke('music_mark_rating', { path, rating }),
  setNotes:         (path, notes, baseMtime) => _api.invoke('music_set_notes', { path, notes, baseMtime: baseMtime ?? null }),
  deleteAlbum:      (path) => _api.invoke('music_delete_album', { path }),
  // Browse — MusicBrainz discovery (read-only; covers saved to disk via music_cover).
  searchReleaseGroups: (query, limit, offset) => _api.invoke('music_search_releasegroups', { query, limit, offset }),
  searchArtists:       (query) => _api.invoke('music_search_artists', { query }),
  searchRecordings:    (query) => _api.invoke('music_search_recordings', { query }),
  // YouTube search (yt-dlp `ytsearch`, shelled out through the download script).
  searchYoutube:       (query, limit) => _api.invoke('music_search_youtube', { query, limit: limit ?? null }),
  // Local track-title search across every album page's tracklist.
  searchTracks:        (query, limit) => _api.invoke('music_search_tracks', { query, limit: limit ?? null }),
  artistReleaseGroups: (artistMbid, singles) => _api.invoke('music_artist_releasegroups', { artistMbid, singles: singles ?? null }),
  artistPopularity:    (artistMbid) => _api.invoke('music_artist_popularity', { artistMbid }),
  releaseGroupDetail:  (rgMbid) => _api.invoke('music_releasegroup_detail', { rgMbid }),
  releasePersonnel:    (rgMbid) => _api.invoke('music_release_personnel', { rgMbid }),
  // Cover Art Archive thumbnail saved to disk once → local path, or null (none).
  // `image` = one CAA picture id of a release (the sleeve viewer); absent = the front.
  cover:               (kind, mbid, size, image) => _api.invoke('music_cover', { kind, mbid, size, image: image ?? null }),
  // Finished listens per logged key, the whole listen log: { trackPath: count }.
  listenCounts:        () => _api.invoke('music_listen_counts'),
  // Last.fm is the user's own key, kept in the OS keychain (no getter, like TMDb's).
  // trackPlays → { playcount, url }, or null (no key / song unknown to Last.fm).
  lastfmSetApiKey:     (key) => _api.invoke('lastfm_set_api_key', { key }),
  lastfmHasApiKey:     () => _api.invoke('lastfm_has_api_key', {}),
  lastfmTrackPlays:    (artist, title) => _api.invoke('lastfm_track_plays', { artist, title }),
  // The most-scanned edition's pictures: { releaseMbid, images: [{ id, kind, full }] }.
  releaseArtwork:      (rgMbid) => _api.invoke('music_release_artwork', { rgMbid }),
  // Browse — download engine (script-backed, sequential, background).
  // One job shape covers three runs: a whole album (rgMbid), one album track
  // (rgMbid + trackN), and a loose single (no rgMbid — watchUrl, or artist + title).
  downloadEnqueue: ({ rgMbid, title, artist, cover, onlyMissing, metadataOnly, initialStatus, trackN, watchUrl }) =>
    _api.invoke('music_download_enqueue', {
      rgMbid: rgMbid || '', title: title || '', artist: artist || '',
      cover: cover || null, onlyMissing: !!onlyMissing,
      metadataOnly: !!metadataOnly, initialStatus: initialStatus || null,
      trackN: trackN ?? null, watchUrl: watchUrl || null,
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

// Bumps when a background MusicBrainz re-check changed an artist's album list
// (`music-mb-refreshed`). Album-list screens put it in their fetch effect's deps
// and re-read in place; the re-read is a saved answer, so it's instant.
export function useMbRefreshTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const un = listen('music-mb-refreshed', () => setTick(t => t + 1));
    return () => { un.then(f => f()).catch(() => {}); };
  }, []);
  return tick;
}

// A saved Cover Art Archive thumbnail's local path (music_cover): undefined
// while loading, null when there's no cover (or no mbid), else the path.
export function useCaaCover(kind, mbid, size, image) {
  const key = mbid ? `${kind}/${mbid}/${size}/${image || 'front'}` : null;
  const [res, setRes] = useState({ key: null, path: undefined });
  useEffect(() => {
    if (!key) return;
    let live = true;
    musicApi.cover(kind, mbid, size, image)
      .then(p => { if (live) setRes({ key, path: p || null }); })
      .catch(() => { if (live) setRes({ key, path: null }); });
    return () => { live = false; };
  }, [key]);
  if (!key) return null;
  return res.key === key ? res.path : undefined;
}
