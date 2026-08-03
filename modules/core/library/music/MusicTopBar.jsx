// Persistent stat strip pinned atop every Music browsing screen — the AnimeTopBar
// analog. The status / download tiles + Home button moved into the Library sidebar
// tree, so the topbar carries the search bar plus the read-only aggregates —
// Tracks + Artists. Counts come from the shared useMusicStats store (one fetch,
// shared with the sidebar). The search bar rides Topbar's existing `leading`
// slot, so it sits ahead of the tiles with no change to the shared Topbar.

import { Topbar } from '@host/components/ui';
import { useMusicStats } from './useMusicStats.js';
import MusicSearchBar from './MusicSearchBar.jsx';

export default function MusicTopBar({ accent, query, setQuery, albums, ownedIds, onPlay, suppressPopup }) {
  const { loading, tracks, artists } = useMusicStats();
  const n = (v) => (loading ? '—' : v);
  const tiles = [
    { id: 'tracks',  label: 'Tracks',  count: n(tracks),  static: true },
    { id: 'artists', label: 'Artists', count: n(artists), static: true },
  ];
  return (
    <Topbar
      tiles={tiles}
      accent={accent}
      leading={
        <MusicSearchBar
          accent={accent}
          query={query} setQuery={setQuery}
          albums={albums} ownedIds={ownedIds} onPlay={onPlay}
          suppress={suppressPopup}
        />
      }
    />
  );
}
