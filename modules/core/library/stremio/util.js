// Shared bits for the two Stremio-backed Library rooms — TV Shows and Movies.
//
// Both rooms are the SAME components; `kind` is the only thing that differs, and
// it is Cinemeta's own word (`series` / `movie`), so it feeds `cinemetaCatalog`,
// `cinemetaSearch` and `cinemetaDetail` straight through with no translation.
// One table here holds everything else that varies, so a room is never described
// twice.

import { videoApi } from '../api.js';
import { useTvStats, useMovieStats } from '../useAnimeStats.js';

export const ROOMS = {
  series: {
    seg: 'tv',
    domain: 'TV Shows',
    badge: 'TV',
    useStats: useTvStats,
    // Continue Watching and Upcoming Episodes only mean something across many
    // episodes, so the Movies room hides both rather than drawing empty rows.
    hasEpisodes: true,
    addToLibrary: (imdbId) => videoApi.tvAddToLibrary(imdbId),
  },
  movie: {
    seg: 'movies',
    domain: 'Movies',
    badge: 'Movie',
    useStats: useMovieStats,
    hasEpisodes: false,
    addToLibrary: (imdbId) => videoApi.movieAddToLibrary(imdbId),
  },
};

export const room = (kind) => ROOMS[kind] || ROOMS.series;

export const roomHome = (kind) => `/tools/library/${room(kind).seg}`;

export const go = (hash) => { window.location.hash = hash; };

export const toTitle = (kind, imdbId) => go(`${roomHome(kind)}/title/${imdbId}`);

// Shape a Cinemeta hit into what AnimeResultCard already renders (cover, title,
// year, badge). Reusing that card rather than writing a per-room one keeps every
// discovery tile in the Library identical — it reads `result.{title,image,year,
// episodes,score,type,titleEnglish}` and ignores what it does not get.
//
// `malId` is deliberately absent: the card's hover prefetch is a MAL warm-up and
// its `Number(malId) || 0` guard makes it a no-op without one.
export function toResultCard(hit, kind) {
  return {
    title: hit.name,
    image: hit.poster || null,
    year: hit.year || null,
    type: room(kind).badge,
  };
}
