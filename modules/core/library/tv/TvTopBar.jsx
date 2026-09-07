// Persistent stat strip pinned atop every TV browsing screen — the TV twin of
// AnimeTopBar, reading the TV Shows store from the same shared factory so the
// sidebar tree and this strip can never disagree on counts.

import { Topbar } from '@host/components/ui';
import { useTvStats } from '../useAnimeStats.js';

export default function TvTopBar({ accent }) {
  const { loading, episodes, rewatched } = useTvStats();
  const n = (v) => (loading ? '—' : v);
  const tiles = [
    { id: 'rewatched', label: 'Rewatched', count: n(rewatched), static: true },
    { id: 'episodes',  label: 'Episodes',  count: n(episodes),  static: true },
  ];
  return <Topbar tiles={tiles} accent={accent} />;
}
