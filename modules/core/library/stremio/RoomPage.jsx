// Route host for a Stremio-backed Library room — TV Shows (`kind="series"`) or
// Movies (`kind="movie"`). One set of components serves both; see `util.js`.
//
// Branches on `rest` (the segment after /tools/library/<seg>) BEFORE interpreting
// it as a vault card path, so reserved first-segments can never be decoded as a
// path:
//   ""                  → RoomHome      (the homepage)
//   library[/<status>]  → RoomLibrary   (card grid, optionally status-filtered)
//   browse/<mode>       → RoomBrowse    (see-all grid: top / imdbRating / year / search/<q>)
//   title/<ttId>        → RoomTitle     (Cinemeta detail + Add to Library)
//   <card-path>         → SeriesDetail  (owned card — the same page the Anime room uses)
//
// Vault card paths start with `TV Shows/` or `Movies/`, so they never collide
// with the reserved prefixes above — the same reservation discipline AnimePage
// uses.

import { useEffect } from 'react';
import SeriesDetail from '../SeriesDetail.jsx';
import { decodePath } from '../paths.js';
import RoomHome from './RoomHome.jsx';
import RoomLibrary from './RoomLibrary.jsx';
import RoomBrowse from './RoomBrowse.jsx';
import RoomTitle from './RoomTitle.jsx';
import { room, roomHome } from './util.js';

function replaceHash(newHash) {
  const base = window.location.href.split('#')[0];
  window.history.replaceState(null, '', base + '#' + newHash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function Redirect({ to }) {
  useEffect(() => { replaceHash(to); }, [to]);
  return null;
}

function routeContent({ accent, kind, rest, parts }) {
  const HOME = roomHome(kind);
  if (!rest) return <RoomHome accent={accent} kind={kind} />;

  if (parts[0] === 'library') return <RoomLibrary accent={accent} kind={kind} status={parts[1] || null} />;

  if (parts[0] === 'browse') {
    const sub = parts[1];
    if (sub === 'search') {
      // `parts` splits the router's already-decoded `rest` — decoding again
      // would turn a literal %41 in a query into an A and search for the wrong
      // thing (the same trap AnimePage documents).
      const q = parts.slice(2).join('/');
      if (!q.trim()) return <Redirect to={HOME} />;
      return <RoomBrowse accent={accent} kind={kind} mode="search" query={q} />;
    }
    if (sub === 'top' || sub === 'imdbRating' || sub === 'year') {
      return <RoomBrowse accent={accent} kind={kind} mode={sub} />;
    }
    return <Redirect to={HOME} />;
  }

  if (parts[0] === 'title') return <RoomTitle accent={accent} kind={kind} imdbId={parts[1]} />;

  return <SeriesDetail accent={accent} seriesPath={decodePath(rest)} domain={room(kind).domain} />;
}

export default function RoomPage({ accent, rest, kind = 'series' }) {
  const parts = (rest || '').split('/');
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {routeContent({ accent, kind, rest, parts })}
    </div>
  );
}
