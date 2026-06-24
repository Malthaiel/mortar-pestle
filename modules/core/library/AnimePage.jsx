// Route host for the Anime section of the Video Player. Branches on `rest`
// (the segment after /tools/library/anime) BEFORE interpreting it as a vault series
// path, so reserved first-segments can never be decoded as a path:
//   ""                  → AnimeHome           (the homepage)
//   library             → AnimeLibrary        (card grid)
//   browse/<mode>       → see-all grids        (SF4; redirect home until then)
//   title/<malId>       → AnimeDetail by malId (SF3 adaptive; placeholder until then)
//   character/<malId>   → AnimeCharacterPage by character MAL id
//   voiceactor/<malId>  → AnimeVoiceActorPage by person MAL id
//   anime/downloaded    → redirect → library   (legacy tab)
//   anime/browse        → redirect → ""         (legacy tab)
//   <series-path>       → AnimeDetail by seriesPath (owned)
//
// Vault series paths start with a Knowledge/ root, so they never collide with
// the reserved prefixes above — the same reservation discipline the old
// `anime/` prefix used.

import { useEffect } from 'react';
import AnimeHome from './AnimeHome.jsx';
import AnimeLibrary from './AnimeLibrary.jsx';
import AnimeDetail from './AnimeDetail.jsx';
import AnimeCharacterPage from './AnimeCharacterPage.jsx';
import AnimeVoiceActorPage from './AnimeVoiceActorPage.jsx';
import BrowseGrid from './BrowseGrid.jsx';
import AnimeTopBar from './AnimeTopBar.jsx';
import { decodePath } from './paths.js';

function replaceHash(newHash) {
  const base = window.location.href.split('#')[0];
  window.history.replaceState(null, '', base + '#' + newHash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function Redirect({ to }) {
  useEffect(() => { replaceHash(to); }, [to]);
  return null;
}

// Resolves `rest` to the page component. The persistent AnimeTopBar is added by
// VideoPage around whatever this returns.
function routeContent({ accent, rest, parts }) {
  // Legacy redirects from the old Downloaded / Browse tabs.
  if (parts[0] === 'anime') {
    return <Redirect to={parts[1] === 'browse' ? '/tools/library/anime' : '/tools/library/anime/library'} />;
  }

  if (!rest) return <AnimeHome accent={accent} />;

  // /library → full grid; /library/<status> → status-filtered grid.
  if (parts[0] === 'library') return <AnimeLibrary accent={accent} status={parts[1] || null} />;

  // See-all browse grids: /browse/top, /browse/season, /browse/search/<q>.
  if (parts[0] === 'browse') {
    const sub = parts[1];
    if (sub === 'top' || sub === 'season') return <BrowseGrid accent={accent} mode={sub} />;
    if (sub === 'search') {
      let q = '';
      try { q = decodeURIComponent(parts.slice(2).join('/')); } catch { q = parts.slice(2).join('/'); }
      if (!q.trim()) return <Redirect to="/tools/library/anime" />;
      return <BrowseGrid accent={accent} mode="search" query={q} />;
    }
    // Native MAL discovery by clickable taxon (genre/theme/demographic/studio).
    if (sub === 'genre' || sub === 'theme' || sub === 'demographic' || sub === 'studio' || sub === 'type' || sub === 'season') {
      let name = '';
      try { name = decodeURIComponent(parts.slice(2).join('/')); } catch { name = parts.slice(2).join('/'); }
      if (!name.trim()) return <Redirect to="/tools/library/anime" />;
      return <BrowseGrid accent={accent} mode="discover" kind={sub} name={name} />;
    }
    return <Redirect to="/tools/library/anime" />;
  }

  // In-app character detail (the voice actors moved here from the anime page).
  if (parts[0] === 'character') return <AnimeCharacterPage accent={accent} malId={parts[1]} />;

  // In-app voice-actor detail — their full anime filmography, sortable.
  if (parts[0] === 'voiceactor') return <AnimeVoiceActorPage accent={accent} malId={parts[1]} />;

  // Adaptive detail by MAL id (discovery). SF1 renders a placeholder for the
  // not-owned case; SF3 resolves ownership.
  if (parts[0] === 'title') return <AnimeDetail accent={accent} malId={parts[1]} />;

  // Otherwise `rest` is a vault series path → the owned detail page.
  return <AnimeDetail accent={accent} seriesPath={decodePath(rest)} />;
}

export default function AnimePage({ accent, rest }) {
  const parts = (rest || '').split('/');
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <AnimeTopBar accent={accent} rest={rest} />
      {routeContent({ accent, rest, parts })}
    </div>
  );
}
