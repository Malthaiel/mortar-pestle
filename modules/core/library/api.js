// Module-owned API helpers. Each call routes through the SDK's
// api.invoke so the module imports nothing from web/src/api.js.

import { rewriteAssetToHttp, awaitMediaBaseUrl } from '@host/api.js';

let _api = null;

export function bindVideoApi(api) { _api = api; }

export const videoApi = {
  listSeries:        () => _api.invoke('video_list_series', {}),
  readSeries:        (path) => _api.invoke('video_read_series', { path }),
  probeVideo:        (abs) => _api.invoke('video_probe', { path: abs }),
  markEpisodeWatched: (seriesPath, episode, season = null) =>
    _api.invoke('video_mark_episode_watched', { seriesPath, episode, season }),
  markSeriesRating:  (seriesPath, rating) =>
    _api.invoke('video_mark_series_rating', { seriesPath, rating }),
  markSeriesStatus:  (seriesPath, status, season = null) =>
    _api.invoke('video_mark_series_status', { seriesPath, status, season }),
  // Anime Browse — Jikan discovery (read-only; covers hot-linked from MAL).
  animeSearch:       (query) => _api.invoke('anime_search', { query }),
  animeTop:          (page) => _api.invoke('anime_top', { page: page || 1 }),
  animeSeasonNow:    (page) => _api.invoke('anime_season_now', { page: page || 1 }),
  animeDetail:       (malId) => _api.invoke('anime_detail', { malId }),
  // Native MAL discovery by taxon (genre/theme/demographic/studio) → AnimeHit[].
  animeDiscover:     (kind, name, page) => _api.invoke('anime_discover', { kind, name, page: page || 1 }),
  animeEpisodes:     (malId) => _api.invoke('anime_episodes', { malId }),
  // Max-detail credits — live Jikan fetch (characters+VA, staff, relations).
  animeCharacters:   (malId) => _api.invoke('anime_characters', { malId }),
  animeStaff:        (malId) => _api.invoke('anime_staff', { malId }),
  animeRelations:    (malId) => _api.invoke('anime_relations', { malId }),
  // Score histogram + status breakdown, and viewer recommendations — live Jikan fetch.
  animeStatistics:     (malId) => _api.invoke('anime_statistics', { malId }),
  animeRecommendations:(malId) => _api.invoke('anime_recommendations', { malId }),
  characterFull:     (malId) => _api.invoke('character_full', { malId }),
  personFull:        (malId) => _api.invoke('person_full', { malId }),
  // qBittorrent connection settings + daemon control (Anime download engine).
  qbitGetConfig:     () => _api.invoke('qbit_get_config', {}),
  qbitSetConfig:     (host, user, pass) => _api.invoke('qbit_set_config', { host, user, pass: pass || null }),
  qbitStatus:        () => _api.invoke('qbit_status', {}),
  qbitStartDaemon:   () => _api.invoke('qbit_start_daemon', {}),
  qbitStopDaemon:    () => _api.invoke('qbit_stop_daemon', {}),
  // Anime download engine (qBittorrent-backed, poll-driven). `type` → Rust `anime_type`.
  animeDownloadEnqueue: (malId, title, audio, image, airing, type, episodes, downloadSource, metadataOnly, initialStatus) =>
    _api.invoke('anime_download_enqueue', {
      malId, title, audio, image: image || null, airing: !!airing,
      animeType: type || 'TV', episodes: episodes ?? null,
      downloadSource: downloadSource || null,
      metadataOnly: !!metadataOnly, initialStatus: initialStatus || null,
    }),
  animeDownloadStatus: () => _api.invoke('anime_download_status', {}),
  animeDownloadCancel: (jobId) => _api.invoke('anime_download_cancel', { jobId }),
  // Torrent picker — read-only Nyaa search returning ranked candidates to choose from.
  animeTorrentSearch: (title, englishTitle, type, audio) =>
    _api.invoke('anime_torrent_search', {
      title, englishTitle: englishTitle || '', animeType: type || 'TV', audio: audio || 'sub',
    }),
  // Uninstall a library entry: card + cover + qBittorrent torrents [+ files] + RSS rule.
  animeUninstall: (seriesPath, deleteFiles) =>
    _api.invoke('anime_uninstall', { seriesPath, deleteFiles: !!deleteFiles }),
  revealInFiles:     (path) => _api.invoke('reveal_in_files', { path }),
  // SF12 (2026-05-24): video_start_transcode returns an `mortar-pestle-asset://`
  // URL but WebKitGTK rejects custom URI schemes for HTMLMediaElement. Wait
  // for the loopback media server's port, then rewrite the URL to
  // `http://127.0.0.1:<port>/transcode/<hash>.mp4` which WebKit accepts.
  videoStreamURL:    async (abs, audio = 0) => {
    await awaitMediaBaseUrl();
    const r = await _api.invoke('video_start_transcode', { abs, audio });
    return { ...r, url: rewriteAssetToHttp(r.url) };
  },
  videoSubsURL:      async (abs, stream = 0) => {
    await awaitMediaBaseUrl();
    const r = await _api.invoke('video_extract_subs', { abs, stream });
    return { ...r, url: rewriteAssetToHttp(r.url) };
  },
};

// Library import engine (background job; CSV/TXT music in SF5, MAL XML in SF6).
// Shares the `_api` instance bound by bindVideoApi above.
export const libraryImportApi = {
  enqueue: (kind, filePath, addAlbums, initialStatus) =>
    _api.invoke('library_import_enqueue', {
      kind, filePath, addAlbums: !!addAlbums, initialStatus: initialStatus || null,
    }),
  status: () => _api.invoke('library_import_status', {}),
  cancel: (jobId) => _api.invoke('library_import_cancel', { jobId }),
};

// Hover prefetch — warm the Rust response cache for a title's CORE data
// (detail + episodes) so opening it lands as a cache hit. Deduped: each malId
// fires at most once per session. Fire-and-forget; failures leave the cache cold.
const _prefetched = new Set();
export function prefetchTitle(malId) {
  const id = Number(malId) || 0;
  if (!id || !_api || _prefetched.has(id)) return;
  _prefetched.add(id);
  Promise.resolve(videoApi.animeDetail(id)).catch(() => {});
  Promise.resolve(videoApi.animeEpisodes(id)).catch(() => {});
}

// Owned-title (library card) hover prefetch. The owned detail page reads its
// core from the vault, so warming detail/episodes is wasted; what it fetches
// live is the credits. Warm the first credits section (characters) so the cast
// is instant on open; staff/relations still skeleton-in. Deduped per session.
const _prefetchedCredits = new Set();
export function prefetchCredits(malId) {
  const id = Number(malId) || 0;
  if (!id || !_api || _prefetchedCredits.has(id)) return;
  _prefetchedCredits.add(id);
  Promise.resolve(videoApi.animeCharacters(id)).catch(() => {});
}
