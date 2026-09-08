// Top-level route dispatcher for the Library hub. Splits the first path segment
// after /tools/library: `music/*` → the Music section, `tv/*` and `movies/*` →
// the two Stremio-backed rooms (one RoomPage, told apart by `kind`), `anime/*`
// (or bare) → the Anime section. Each section page receives `rest` already
// stripped of its section segment, so AnimePage/MusicPage parse exactly the rests
// they always did — the merge is transparent to them.

import AnimePage from './AnimePage.jsx';
import MusicPage from './music/MusicPage.jsx';
import RoomPage from './stremio/RoomPage.jsx';

export default function LibraryPage({ accent, rest }) {
  const full = rest || '';
  const seg = full.split('/')[0];
  if (seg === 'music') {
    return <MusicPage accent={accent} rest={full.slice('music'.length).replace(/^\//, '')} />;
  }
  if (seg === 'tv') {
    return <RoomPage accent={accent} kind="series" rest={full.slice('tv'.length).replace(/^\//, '')} />;
  }
  if (seg === 'movies') {
    return <RoomPage accent={accent} kind="movie" rest={full.slice('movies'.length).replace(/^\//, '')} />;
  }
  // 'anime/...' or bare → Anime (the default tab).
  const animeRest = seg === 'anime' ? full.slice('anime'.length).replace(/^\//, '') : full;
  return <AnimePage accent={accent} rest={animeRest} />;
}
