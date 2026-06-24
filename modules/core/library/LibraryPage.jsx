// Top-level route dispatcher for the Library hub. Splits the first path segment
// after /tools/library: `music/*` → the Music section, `anime/*` (or bare) →
// the Anime section. Each section page receives `rest` already stripped of its
// section segment, so AnimePage/MusicPage parse exactly the rests they always
// did — the merge is transparent to them.

import AnimePage from './AnimePage.jsx';
import MusicPage from './music/MusicPage.jsx';

export default function LibraryPage({ accent, rest }) {
  const full = rest || '';
  const seg = full.split('/')[0];
  if (seg === 'music') {
    return <MusicPage accent={accent} rest={full.slice('music'.length).replace(/^\//, '')} />;
  }
  // 'anime/...' or bare → Anime (the default tab).
  const animeRest = seg === 'anime' ? full.slice('anime'.length).replace(/^\//, '') : full;
  return <AnimePage accent={accent} rest={animeRest} />;
}
