// Persistent search strip pinned atop every Music browsing screen. The stat
// tiles (Tracks + Artists) were removed 2026-09-13 along with the anime and
// room stat strips — the counts already live in the Library sidebar tree. The
// search bar rides Topbar's existing `leading` slot.

import { Topbar } from '@host/components/ui';
import MusicSearchBar from './MusicSearchBar.jsx';

export default function MusicTopBar({ accent, query, setQuery, albums, ownedIds, onPlay, suppressPopup }) {
  return (
    <Topbar
      tiles={[]}
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
