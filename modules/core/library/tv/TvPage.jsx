// Route host for the TV Shows section of the Library. Branches on `rest` (the
// segment after /tools/library/tv) BEFORE interpreting it as a vault series
// path, so reserved first-segments can never be decoded as a path:
//   ""                  → TvHome        (the homepage)
//   library[/<status>]  → TvLibrary     (card grid, optionally status-filtered)
//   browse/<mode>       → TvBrowse      (see-all grid: top / imdbRating / year / search/<q>)
//   title/<ttId>        → TvTitle       (Cinemeta detail + Add to Library)
//   <series-path>       → SeriesDetail  (owned card — the same page the Anime room uses)
//
// Vault series paths start with `TV Shows/`, so they never collide with the
// reserved prefixes above — the same reservation discipline AnimePage uses.

import { useEffect } from 'react';
import SeriesDetail from '../SeriesDetail.jsx';
import { decodePath } from '../paths.js';
import TvHome from './TvHome.jsx';
import TvLibrary from './TvLibrary.jsx';
import TvBrowse from './TvBrowse.jsx';
import TvTitle from './TvTitle.jsx';
import TvTopBar from './TvTopBar.jsx';

function replaceHash(newHash) {
  const base = window.location.href.split('#')[0];
  window.history.replaceState(null, '', base + '#' + newHash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function Redirect({ to }) {
  useEffect(() => { replaceHash(to); }, [to]);
  return null;
}

const HOME = '/tools/library/tv';

function routeContent({ accent, rest, parts }) {
  if (!rest) return <TvHome accent={accent} />;

  if (parts[0] === 'library') return <TvLibrary accent={accent} status={parts[1] || null} />;

  if (parts[0] === 'browse') {
    const sub = parts[1];
    if (sub === 'search') {
      // `parts` splits the router's already-decoded `rest` — decoding again
      // would turn a literal %41 in a query into an A and search for the wrong
      // thing (the same trap AnimePage documents).
      const q = parts.slice(2).join('/');
      if (!q.trim()) return <Redirect to={HOME} />;
      return <TvBrowse accent={accent} mode="search" query={q} />;
    }
    if (sub === 'top' || sub === 'imdbRating' || sub === 'year') {
      return <TvBrowse accent={accent} mode={sub} />;
    }
    return <Redirect to={HOME} />;
  }

  if (parts[0] === 'title') return <TvTitle accent={accent} imdbId={parts[1]} />;

  return <SeriesDetail accent={accent} seriesPath={decodePath(rest)} domain="TV Shows" />;
}

export default function TvPage({ accent, rest }) {
  const parts = (rest || '').split('/');
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TvTopBar accent={accent} />
      {routeContent({ accent, rest, parts })}
    </div>
  );
}
