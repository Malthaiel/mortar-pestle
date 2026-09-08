// Module-owned API helpers. Each call routes through the SDK's
// api.invoke so the module imports nothing from web/src/api.js.


let _api = null;

export function bindVideoApi(api) { _api = api; }

export const videoApi = {
  // domain: 'Anime' (default) | 'TV Shows' — both share the Rust series reader.
  listSeries:        (domain) => _api.invoke('video_list_series', { domain: domain || null }),
  readSeries:        (path) => _api.invoke('video_read_series', { path }),
  probeVideo:        (abs) => _api.invoke('video_probe', { path: abs }),
  markEpisodeWatched: (seriesPath, episode, season = null) =>
    _api.invoke('video_mark_episode_watched', { seriesPath, episode, season }),
  markSeriesRating:  (seriesPath, rating) =>
    _api.invoke('video_mark_series_rating', { seriesPath, rating }),
  markSeriesStatus:  (seriesPath, status, season = null) =>
    _api.invoke('video_mark_series_status', { seriesPath, status, season }),
  // TV Shows — Cinemeta discovery (keyless, IMDb-keyed) + the card writer. One
  // command family serves films too: `kind` is 'series' or 'movie'.
  cinemetaSearch:   (kind, query) => _api.invoke('cinemeta_search', { kind, query }),
  cinemetaCatalog:  (kind, catalog, genre, skip) =>
    _api.invoke('cinemeta_catalog', { kind, catalog, genre: genre || null, skip: skip || null }),
  cinemetaDetail:   (kind, imdbId) => _api.invoke('cinemeta_detail', { kind, imdbId }),
  cinemetaCalendar: (imdbIds) => _api.invoke('cinemeta_calendar', { imdbIds }),
  tvAddToLibrary:   (imdbId) => _api.invoke('tv_add_to_library', { imdbId }),
  movieAddToLibrary: (imdbId) => _api.invoke('movie_add_to_library', { imdbId }),
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
  animeMoveVideos:   () => _api.invoke('anime_move_videos', {}),
  videoGetConfig:    () => _api.invoke('video_get_config', {}),
  videoSetConfig:    (videoRoot) => _api.invoke('video_set_config', { videoRoot }),
  // Anime download engine (built-in librqbit, poll-driven). `type` → Rust `anime_type`.
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
  // TV Shows lane: the card already exists (tv_add_to_library) and the magnet
  // already came from the picker, so this queues ONE episode and nothing else.
  // Shares the anime queue in Rust, so TV jobs surface in the same dock.
  tvDownloadEnqueue: (seriesPath, title, magnet, season, episode, fileIdx, image) =>
    _api.invoke('tv_download_enqueue', {
      seriesPath, title, magnet, season, episode,
      fileIdx: fileIdx ?? null, image: image || null,
    }),
  // Torrentio picker search. Keyed by IMDb id, not by a title string, so there
  // is no free-text query to edit — a series needs BOTH season and episode.
  torrentioSearch: (imdbId, season, episode) =>
    _api.invoke('torrentio_torrent_search', {
      imdbId, kind: 'series', season: season ?? null, episode: episode ?? null,
    }),
  // Uninstall a library entry: card + cover + its torrents [+ files].
  animeUninstall: (seriesPath, deleteFiles) =>
    _api.invoke('anime_uninstall', { seriesPath, deleteFiles: !!deleteFiles }),
  revealInFiles:     (path) => _api.invoke('reveal_in_files', { path }),
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
