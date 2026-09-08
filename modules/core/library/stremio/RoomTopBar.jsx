// Persistent stat strip pinned atop every browsing screen in a Stremio-backed
// room, reading that room's store from the same shared factory so the sidebar
// tree and this strip can never disagree on counts.
//
// A film has no episodes and is not rewatched the way a show is, so the Movies
// room swaps those two tiles for the counts that do mean something for films.

import { Topbar } from '@host/components/ui';
import { room } from './util.js';

export default function RoomTopBar({ accent, kind = 'series' }) {
  const { loading, episodes, rewatched, total, downloaded } = room(kind).useStats();
  const n = (v) => (loading ? '—' : v);
  const tiles = room(kind).hasEpisodes
    ? [
      { id: 'rewatched', label: 'Rewatched', count: n(rewatched), static: true },
      { id: 'episodes',  label: 'Episodes',  count: n(episodes),  static: true },
    ]
    : [
      { id: 'films',      label: 'Films',      count: n(total),      static: true },
      { id: 'downloaded', label: 'Downloaded', count: n(downloaded), static: true },
    ];
  return <Topbar tiles={tiles} accent={accent} />;
}
