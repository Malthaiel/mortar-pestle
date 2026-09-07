// Shape a Cinemeta hit into what AnimeResultCard already renders (cover, title,
// year, badge). Reusing that card rather than writing a TV one keeps every
// discovery tile in the Library identical — it reads `result.{title,image,year,
// episodes,score,type,titleEnglish}` and ignores what it does not get.
//
// `malId` is deliberately absent: the card's hover prefetch is a MAL warm-up and
// its `Number(malId) || 0` guard makes it a no-op without one.

export function toResultCard(hit) {
  return {
    title: hit.name,
    image: hit.poster || null,
    year: hit.year || null,
    type: 'TV',
  };
}

export const go = (hash) => { window.location.hash = hash; };
export const TV_HOME = '/tools/library/tv';
export const toTitle = (imdbId) => go(`${TV_HOME}/title/${imdbId}`);
