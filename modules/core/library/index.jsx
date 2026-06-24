// Library — the unified media hub. Merges the former Anime (video) and Music
// modules into one left-sidebar pill with two tabs (Anime · Music). Music lives
// in the ./music/ subfolder; its providers, right-sidebar tile, and route
// host are registered from here. IPC command prefixes (anime_*/music_*/video_*)
// are unchanged — they name the domain, not the module.

import { VideoPlayerProvider } from './VideoPlayerProvider.jsx';
import { AnimeDownloadProvider } from './AnimeDownloadProvider.jsx';
import { ImportProvider } from './ImportProvider.jsx';
import AnimePage from './AnimePage.jsx';
import PlayerPage from './PlayerPage.jsx';
import { bindVideoApi } from './api.js';
import LibrarySettingsTab from './LibrarySettingsTab.jsx';

import { MusicPlayerProvider, useMusicPlayer } from './music/MusicPlayerProvider.jsx';
import { DownloadProvider } from './music/DownloadProvider.jsx';
import { PlaylistProvider } from './music/PlaylistProvider.jsx';
import MusicPlayerWidget from '@host/components/MusicPlayerWidget.jsx';
import { bindMusicApi } from './music/api.js';
import { MUSIC_RAIL_VARIANTS, MusicMiniRail } from './music/rails/index.jsx';

import LibraryPage from './LibraryPage.jsx';
import LibraryNav from './LibraryNav.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import RailStat from '@host/components/sidebar/RailStat.jsx';
import { useManifestData } from '@host/lib/manifestReader.js';
import { useHashRoute } from '@host/router.js';

const ANIME_DOMAINS = new Set(['Anime']);

// Anime rail stats (WATCHED / PLAN / WATCHING) — scoped to the Anime domain.
function AnimeRail({ accent }) {
  const manifest = useManifestData();
  const counts = (() => {
    if (!manifest?.entries) return { watched: '—', plan: '—', watching: '—' };
    const videos = manifest.entries.filter(
      e => e.type === 'Media-Entry' && ANIME_DOMAINS.has(e.domain)
    );
    return {
      watched:  videos.filter(v => v.status === 'Completed').length,
      plan:     videos.filter(v => v.status === 'Plan-to-Watch').length,
      watching: videos.filter(v => /watching/i.test(v.status || '')).length,
    };
  })();
  return (
    <>
      <RailStat label="WATCHED"  value={counts.watched}  accent={accent}/>
      <RailStat label="PLAN"     value={counts.plan}     accent={accent}/>
      <RailStat label="WATCHING" value={counts.watching} accent={accent}/>
    </>
  );
}

// Music rail stats (ALBUMS / TRACKS / HOURS).
function MusicRail({ accent }) {
  const manifest = useManifestData();
  const { listenMinutesThisMonth } = useMusicPlayer();
  const counts = (() => {
    if (!manifest?.entries) return { albums: '—', tracks: '—' };
    return {
      albums: manifest.entries.filter(e => e.type === 'Media-Entry' && e.domain === 'Music').length,
      tracks: manifest.entries.filter(e => e.type === 'Music-Track').length,
    };
  })();
  const hours = (() => {
    if (listenMinutesThisMonth == null) return '—';
    const h = listenMinutesThisMonth / 60;
    if (h === 0) return 0;
    if (h < 10) return Number(h.toFixed(1));
    return Math.round(h);
  })();
  return (
    <>
      <RailStat label="ALBUMS" value={counts.albums} accent={accent}/>
      <RailStat label="TRACKS" value={counts.tracks} accent={accent}/>
      <RailStat label="HOURS"  value={hours}         accent={accent}/>
    </>
  );
}

// Collapsed-sidebar rail follows the active tab: Music stats on the Music tab,
// Anime stats everywhere else.
function LibraryRail({ accent }) {
  const route = useHashRoute();
  const seg = (route?.rest || '').split('/')[0];
  return seg === 'music' ? <MusicRail accent={accent}/> : <AnimeRail accent={accent}/>;
}

// One composed provider: anime playback + download, then music playback +
// download + playlists. Registered providers persist across navigation, so
// playback and downloads keep running wherever the user goes. (The music
// download toast stack was retired in favor of the global Downloads popup; its
// completion notification now lives in DownloadProvider.)
function LibraryRoot({ children }) {
  return (
    <VideoPlayerProvider>
      <AnimeDownloadProvider>
        <MusicPlayerProvider>
          <DownloadProvider>
            <ImportProvider>
              <PlaylistProvider>
                {children}
              </PlaylistProvider>
            </ImportProvider>
          </DownloadProvider>
        </MusicPlayerProvider>
      </AnimeDownloadProvider>
    </VideoPlayerProvider>
  );
}

export default {
  register(api) {
    bindVideoApi(api);
    bindMusicApi(api);
    const { IconLibrary } = api.ui.icons;
    api.slots.registerProvider(LibraryRoot);
    api.slots.registerLeftSidebar({
      id: 'library',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconLibrary}
          label="Library"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/library')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'library',
      renderSecondary: ({ route, accent }) => <LibraryNav route={route} accent={accent}/>,
      renderRail: ({ accent }) => <LibraryRail accent={accent}/>,
      order: 40,
    });
    api.slots.registerWidget({
      id: 'library',
      render: () => (
        <div style={{ padding: '6px 10px', background: 'transparent' }}>
          <MusicPlayerWidget/>
        </div>
      ),
      weight: 100,
      flexWeight: 0,
      renderRail: ({ accent }) => <MusicMiniRail accent={accent}/>,
      railVariants: MUSIC_RAIL_VARIANTS,
    });
    api.slots.registerRoute({
      match: r => r === '/tools/library' || r.startsWith('/tools/library/')
        ? { rest: r.slice('/tools/library'.length).replace(/^\//, '') }
        : false,
      render: ({ params, accent }) => <LibraryPage accent={accent} rest={params.rest || ''}/>,
    });
    // Standalone popout (window.open kiosk mode). PlayerPage mounts its OWN
    // VideoPlayerProvider tree because the popout has no main-app provider stack.
    api.slots.registerRoute({
      match: r => r.startsWith('/player')
        ? { rest: r.slice('/player'.length).replace(/^\//, '') }
        : false,
      render: ({ params }) => <PlayerPage rest={params.rest || ''}/>,
    });
    // ONE settings tab per module — pagesByModuleId keeps only the first.
    // Anime/Music sub-tabs live inside LibrarySettingsTab (PAGE_SECTIONS.library).
    api.slots.registerSettingsTab({
      id: 'video-settings',
      label: 'Library',
      render: LibrarySettingsTab,
    });
  },
};
