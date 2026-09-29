// RIGHT pane of /tools/library/anime. Poster, metadata, Play All / next-unwatched,
// status dropdown, full episode list. Click an episode → modal opens via
// playSeries().
//
// Franchise series (Related IDs in frontmatter, `series.seasons` populated):
// renders a horizontal tab strip above the episode list, one tab per
// `## SECTION` H2. The active tab drives the episode list, status dropdown,
// and Play / Resume button. Personal Rating stays franchise-level.

import { useEffect, useMemo, useState } from 'react';
import { videoApi } from './api.js';
import { useVideoPlayer } from './VideoPlayerProvider.jsx';
import EpisodeRow from './EpisodeRow.jsx';
import { IconFolder, IconDownload, IconPlay, IconStarMark, IconSwatch } from '@host/components/icons.jsx';
import { coverSrc, STATUS_DOT_COLOR, DOWNLOAD_DOT_COLOR, resolveDot } from './util.js';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { statusLabel, STATUS_ICON } from '@host/util/media-status.js';
import RatingStrip from './RatingStrip.jsx';
import AnimeMainColumn from './AnimeMainColumn.jsx';
import LoadingScreen from './LoadingScreen.jsx';
import AnimeDetailHeader from './AnimeDetailHeader.jsx';
import { useAnimeDownloads } from './AnimeDownloadProvider.jsx';
import TorrentPickerModal from './TorrentPickerModal.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';

const PROGRESS_KEY = 'video:progress';

// Films whose portraits we already tried to fetch this session. A film TMDb has
// no photos for would otherwise re-fetch on every single visit, since "no
// photos" and "not tried yet" look identical on the card.
const backfilled = new Set();

function readProgressMap() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') || {}; }
  catch { return {}; }
}

function useProgressMap() {
  const [map, setMap] = useState(readProgressMap);
  useEffect(() => {
    // Cross-window updates (popped-out player → main window).
    const onStorage = (e) => {
      if (e.key !== PROGRESS_KEY) return;
      try { setMap(JSON.parse(e.newValue || '{}') || {}); } catch {}
    };
    // Same-window updates: localStorage's 'storage' event doesn't fire for
    // the writer, so poll on a slow cadence (5 s matches the provider's
    // save interval).
    const tick = setInterval(() => setMap(readProgressMap()), 5000);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(tick);
    };
  }, []);
  return map;
}

const STATUSES = ['Plan-to-Watch', 'Currently-Watching', 'Completed', 'On-Hold', 'Dropped'];


function prettyDuration(d) {
  if (!d) return null;
  const m = String(d).match(/(\d+)/);
  return m ? `${m[1]}m` : d;
}

// Fire an app-wide toast via the central notification bus.
function notify(detail) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('agentic:notify', { detail }));
  }
}

// `domain` is 'Anime' (default) or 'TV Shows'. Everything the two rooms share —
// season tabs, episode list, ticking, status, rating, Play — is domain-blind and
// runs off the card. The anime-only affordances are the ones wired to
// `anime_download` / `anime_uninstall`, which are MAL-keyed and would be a guess
// pointed at a TV card; they hide until the TV pipeline exists (SF7b).
export default function SeriesDetail({ accent, seriesPath, domain = 'Anime' }) {
  const isAnime = domain === 'Anime';
  // A film has no episodes. Its one video file still becomes a synthetic
  // episode 1 in Rust — that is what Play targets — but nothing about it is
  // shown, so the page reads as a film rather than a one-episode series.
  const isMovie = domain === 'Movies';
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeSeasonIdx, setActiveSeasonIdx] = useState(0);
  const player = useVideoPlayer();
  const progressMap = useProgressMap();
  const { jobs, enqueue } = useAnimeDownloads();
  const { openContextMenu } = useContextMenu();
  const [pickerOpen, setPickerOpen] = useState(false);
  // Which season/episode the picker is open for (TV Shows lane only).
  const [tvPick, setTvPick] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setSeries(null); setActiveSeasonIdx(0);
    videoApi.readSeries(seriesPath)
      .then(d => { if (!cancelled) { setSeries(d); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [seriesPath]);

  // A download that lands while this page is open has to show up on it. The
  // engine runs in Rust and the provider re-broadcasts its done event as
  // `video-library-changed`; without this the episode you just downloaded stays
  // greyed out until you navigate away and back. Re-read quietly — no loading
  // screen, the page is already showing real content.
  useEffect(() => {
    let cancelled = false;
    const reread = () => {
      videoApi.readSeries(seriesPath)
        .then(d => { if (!cancelled) setSeries(d); })
        .catch(() => {});
    };
    window.addEventListener('video-library-changed', reread);
    return () => { cancelled = true; window.removeEventListener('video-library-changed', reread); };
  }, [seriesPath]);

  // Determine view mode + the visible-episode slice early so the hooks below
  // can depend on it. View `series` defensively because it's null during load.
  const isFranchise = !!(series && series.seasons && series.seasons.length > 0);
  const activeSeason = isFranchise ? series.seasons[activeSeasonIdx] : null;
  const visibleEpisodes = isFranchise ? (activeSeason ? activeSeason.episodes : []) : (series ? series.episodes : []);
  const watchedSet = useMemo(() => {
    if (!series) return new Set();
    if (isFranchise) return new Set((activeSeason && activeSeason.watched) || []);
    return new Set(series.watchedEpisodes || []);
  }, [series, isFranchise, activeSeason]);

  // Owned cards downloaded before the MAL-detail fields existed lack background/
  // source/rating/broadcast/themes/trailer/etc.; fetch the live Jikan detail
  // (disk-cached) and fall back to it for any field the card doesn't carry.
  useEffect(() => {
    const pid = series && series.providerId;
    if (!pid) { setDetail(null); return; }
    let cancelled = false;
    Promise.resolve(videoApi.animeDetail(Number(pid)))
      .then(d => { if (!cancelled) setDetail(d || null); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [series && series.providerId]);

  // A film added before the TMDb pass existed has Cinemeta's bare cast and no
  // crew, studios or money. Fetch the TMDb block once, quietly, the first time
  // such a film is opened -- the same command the More menu runs, unattended.
  //
  // The "already done" marker is the TMDb id, which only that command writes.
  // It used to be `castImages`, and when credit portraits were dropped
  // (2026-09-12) that field went with them -- leaving the guard permanently
  // false and re-fetching every film on every open.
  //
  // MUST stay above the early returns below: a hook that only runs on the
  // render where `series` is loaded changes the hook count between renders,
  // which React rejects outright ("Rendered more hooks than during the
  // previous render"). The guards belong INSIDE the effect, not around it.
  useEffect(() => {
    if (!isMovie || !series || !series.path) return;
    if (series.tmdbId) return;
    if (backfilled.has(series.path)) return;
    backfilled.add(series.path);
    videoApi.refreshCredits(series.path)
      .then(changed => {
        if (changed) window.dispatchEvent(new CustomEvent('video-library-changed', { detail: {} }));
      })
      .catch(() => {});
  }, [isMovie, series]);

  if (loading) return <LoadingScreen accent={accent} />;
  if (error)   return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!series) return <Centered>Not found</Centered>;

  const img = coverSrc(series.image);
  const playable = visibleEpisodes.filter(e => e.available);
  const nextUnwatched = visibleEpisodes.findIndex(e => e.available && !watchedSet.has(e.n));
  const playStartIdxLocal = nextUnwatched >= 0 ? nextUnwatched : visibleEpisodes.findIndex(e => e.available);
  // "Resume" only once something has actually been watched. `nextUnwatched >= 0`
  // alone is true for a title nobody has started, so a brand-new series — and
  // every film — offered to resume a thing that had never been played.
  const canResume = nextUnwatched >= 0 && visibleEpisodes.some(e => watchedSet.has(e.n));

  // playSeries() expects an index into series.episodes (the flat list across
  // all seasons). Translate the per-season local index into the flat one.
  const flatStartIdx = playStartIdxLocal < 0 ? -1 : (() => {
    if (!isFranchise) return playStartIdxLocal;
    const ep = visibleEpisodes[playStartIdxLocal];
    return series.episodes.findIndex(e => e.seasonName === ep.seasonName && e.n === ep.n);
  })();

  const onPlayAll = () => {
    if (flatStartIdx < 0) return;
    player.playSeries(series, flatStartIdx);
  };

  const onPlayEpisode = (localIdx) => {
    if (!isFranchise) {
      player.playSeries(series, localIdx);
      return;
    }
    const ep = visibleEpisodes[localIdx];
    const flatIdx = series.episodes.findIndex(e => e.seasonName === ep.seasonName && e.n === ep.n);
    if (flatIdx >= 0) player.playSeries(series, flatIdx);
  };

  // Download state for this title (the engine runs in Rust; surface its job
  // here so a not-yet-downloaded title shows live progress + a retry path
  // instead of a dead greyed-out Play button with no explanation).
  // A TV job carries no MAL id, and every TV card's `providerId` is only the
  // numeric half of an IMDb id — so matching on it would tie unrelated shows
  // together. The card path is the TV lane's identity.
  const dlJob = jobs.find(j => (isAnime
    ? j.malId === Number(series.providerId)
    : j.seriesPath === series.path)) || null;
  const dlActive = !!dlJob && (dlJob.state === 'queued' || dlJob.state === 'preparing' || dlJob.state === 'downloading');
  const dlLabel = (() => {
    if (!dlJob) return null;
    switch (dlJob.state) {
      case 'queued': return dlJob.queuePosition > 0 ? `Queued — #${dlJob.queuePosition}` : 'Queued';
      case 'preparing': return 'Preparing';
      case 'downloading': return `Downloading ${Math.round(dlJob.progressPct || 0)}%`;
      default: return null;
    }
  })();
  // Owned but still missing episodes (or an airing show that'll get more) → surface
  // a secondary Download button next to Play. Without this the Download path vanished
  // the moment ONE episode landed, since flatStartIdx>=0 swaps the primary to Play.
  const canGrabMore = !dlActive && (series.airing || visibleEpisodes.some(e => !e.available));
  // Fully-downloaded, idle, non-airing title: the visible download button hides
  // (nothing to grab), so offer a re-download path in the ⋯ menu for re-grabbing a
  // corrupt or better rip.
  const canRedownload = flatStartIdx >= 0 && !dlActive && !canGrabMore && !!series.providerId;
  // Uninstall only has something to do while a video is on disk.
  const onDisk = [series, ...(series.seasons || [])].some((x) => (x.episodes || []).some((ep) => ep.fileAbs));
  // The engine is in-process, so the picker opens straight away (no pre-flight).
  // Anime searches Nyaa by title and needs a MAL id; a film searches Torrentio
  // by IMDb id and needs that instead.
  const canDownload = isMovie ? !!series.imdbId : !!series.providerId;
  const onDownload = () => {
    if (!canDownload) return;
    setPickerOpen(true);
  };
  // TV Shows: the download entry point is the episode row, because Torrentio
  // needs a season AND an episode. `tvPick` holds which one the picker is for.
  // From `activeSeason`, not `seasonName` — that const is declared further down,
  // and reading it here would be a temporal-dead-zone crash on every render.
  const seasonNum = Number(String((activeSeason && activeSeason.name) || '').match(/\d+/)?.[0]) || null;
  const tvEpJob = (n) => jobs.find(j => j.seriesPath === series.path && j.tv
    && j.tv.season === seasonNum && j.tv.episode === n) || null;
  const onDownloadEpisode = (n) => {
    if (!series.imdbId || !seasonNum) return;
    setTvPick({ season: seasonNum, episode: n });
    setPickerOpen(true);
  };
  // Movies: one film, one download, so there is no per-row entry point and no
  // pick to remember — the primary button opens the picker and this takes it.
  const onPickMovieTorrent = async (magnet, _audio, cand) => {
    setPickerOpen(false);
    try {
      await videoApi.movieDownloadEnqueue(
        series.path, series.title, magnet, cand ? cand.file_idx : null, series.image || null,
      );
      notify({ type: 'info', title: 'Download started', message: series.title, iconKey: 'download', accent: accent || 'var(--accent)', duration: 4000 });
    } catch (e) {
      notify({ type: 'error', title: 'Download failed to start', message: (e && e.message) || String(e), iconKey: 'alert', accent: accent || 'var(--accent)' });
    }
  };
  const onPickTvTorrent = async (magnet, _audio, cand) => {
    setPickerOpen(false);
    const pick = tvPick;
    setTvPick(null);
    if (!pick) return;
    try {
      await videoApi.tvDownloadEnqueue(
        series.path, series.title, magnet, pick.season, pick.episode,
        cand ? cand.file_idx : null, series.image || null,
      );
      notify({ type: 'info', title: 'Download started', message: `${series.title} S${String(pick.season).padStart(2, '0')}E${String(pick.episode).padStart(2, '0')}`, iconKey: 'download', accent: accent || 'var(--accent)', duration: 4000 });
    } catch (e) {
      notify({ type: 'error', title: 'Download failed to start', message: (e && e.message) || String(e), iconKey: 'alert', accent: accent || 'var(--accent)' });
    }
  };
  const onPickTorrent = async (magnet, audioUsed) => {
    setPickerOpen(false);
    try {
      await enqueue({
        malId: Number(series.providerId), title: series.title, audio: audioUsed,
        image: series.image || null, airing: !!series.airing, type: 'TV',
        episodes: series.episodesTotal || null, downloadSource: magnet,
      });
      notify({ type: 'info', title: 'Download started', message: series.title, iconKey: 'download', accent: accent || 'var(--accent)', duration: 4000 });
    } catch { /* blocking toast already fired by the provider */ }
  };

  // Uninstall: hand the card path to the Rust command (it cancels the job, clears
  // torrents [+files], deletes folder/cover/card). Removing the card also drops
  // the series from the airing poll set, so new episodes stop arriving.
  const handleUninstall = async () => {
    if (uninstalling) return;
    setUninstalling(true);
    try {
      // keepCard: only the videos go; the show stays in the library (2026-09-29).
      const rep = await videoApi.seriesUninstall(series.path, true, true);
      setConfirmOpen(false);
      window.dispatchEvent(new CustomEvent('video-library-changed', { detail: {} }));
      const warns = (rep && rep.warnings) || [];
      if (rep && rep.ok) {
        notify({ type: 'info', title: 'Videos moved to recycling bin', message: series.title, accent: accent || 'var(--accent)', duration: 4000 });
        if (warns.length) notify({ type: 'anime-download', title: 'Uninstall warnings', message: warns.join('  •  '), accent: '#d9a55a', iconKey: 'alert', duration: 9000 });
      } else {
        notify({ type: 'anime-download', title: 'Uninstall incomplete', message: warns[0] || 'Could not remove the videos.', accent: 'var(--text)', iconKey: 'alert', duration: 9000 });
      }
    } catch (e) {
      setConfirmOpen(false);
      notify({ type: 'anime-download', title: 'Uninstall blocked', message: (e && e.message) || 'Uninstall failed.', accent: 'var(--text)', iconKey: 'alert', duration: 9000 });
    } finally {
      setUninstalling(false);
    }
  };

  // Re-fetch this card's credits from Cinemeta (and TMDb, for a film with a
  // key) and write them back. The command rewrites only the credit keys, so
  // status/rating/watch state are safe -- but it does not know the page is
  // open, so the re-read has to be announced here or the page keeps the copy
  // it loaded before the write.
  const onRefreshDetails = async () => {
    try {
      const changed = await videoApi.refreshCredits(series.path);
      if (changed) window.dispatchEvent(new CustomEvent('video-library-changed', { detail: {} }));
      notify({
        type: 'info',
        title: changed ? 'Details updated' : 'Already up to date',
        message: changed ? `${series.title} now shows the latest cast and crew.` : `${series.title} already had the latest details.`,
        iconKey: 'download', accent: accent || 'var(--accent)', duration: 4000,
      });
    } catch (e) {
      notify({
        type: 'error', title: 'Refresh failed',
        message: (e && e.message) || 'Could not fetch the details.',
        iconKey: 'alert', accent: accent || 'var(--accent)',
      });
    }
  };

  const seasonName = activeSeason ? activeSeason.name : null;
  const statusValue = isFranchise ? (activeSeason ? activeSeason.status : '') : (series.status || '');
  const statusTitle = isFranchise
    ? `Set ${seasonName} status`
    : 'Set watch status';

  // Play (or Download, when there is no file yet). A film leads its fused run
  // with it (user-directed 2026-09-26); every other room keeps it after status.
  const primaryAction = (
    flatStartIdx >= 0 ? (
      <>
        <button onClick={onPlayAll} className="candy-btn is-primary" style={{ cursor: 'pointer' }}>
          <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><IconPlay size={14}/> {canResume ? 'Resume' : 'Play'}</span>
        </button>
        {canGrabMore && isAnime && (
          <button onClick={onDownload} title="Download more episodes" data-own-press className="candy-btn" data-shape="icon" style={{ cursor: 'pointer' }}>
            <span className="candy-face"><IconDownload size={16}/></span>
          </button>
        )}
      </>
    ) : (!isAnime && !isMovie) ? null : dlActive ? (
      <button disabled
        className={isMovie ? 'candy-btn' : 'candy-btn is-primary'}
        data-shape={isMovie ? 'chip' : undefined}
        style={{ cursor: 'default', opacity: 0.6 }}>
        <span className="candy-face">{dlLabel}</span>
      </button>
    ) : (
      // A film draws Download neutral and lights it on hover, matching
      // the source buttons beside it; every other domain keeps the
      // standing accent that marks it the primary action.
      <button onClick={onDownload} disabled={!canDownload}
        className={isMovie ? 'candy-btn' : 'candy-btn is-primary'}
        data-shape={isMovie ? 'chip' : undefined}
        style={{ cursor: canDownload ? 'pointer' : 'not-allowed', opacity: canDownload ? 1 : 0.4 }}>
        <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><IconDownload size={15}/> {dlJob && dlJob.state === 'error' ? 'Retry Download' : 'Download'}</span>
      </button>
    )
  );

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="detail-column">
      {/* MAL-style header — shared with the discovery view via AnimeDetailHeader. */}
      <AnimeDetailHeader
        title={series.title}
        subtitle={isFranchise ? `${series.seasons.length} ${series.seasons.length === 1 ? 'entry' : 'entries'}` : null}
        malId={isAnime ? series.providerId : null}
        sourceUrl={!isAnime && series.imdbId ? `https://www.imdb.com/title/${series.imdbId}/` : null}
        sourceLabel={isAnime ? null : 'IMDb'}
        extraSources={isMovie ? [
          series.imdbId ? { label: 'Letterboxd', url: `https://letterboxd.com/imdb/${series.imdbId}/` } : null,
          series.tmdbId ? { label: 'TMDb', url: `https://www.themoviedb.org/movie/${series.tmdbId}` } : null,
        ].filter(Boolean) : null}
        image={img}
        score={series.onlineRating}
        scoredBy={series.scoredBy}
        rank={series.rank}
        popularity={series.popularity}
        members={series.members}
        genres={series.genres}
        themes={series.themes}
        demographics={series.demographics}
        // A film's studios come from TMDb (series.studios); an anime's from the
        // MAL card (series.studio). One prop, whichever the card actually has.
        studios={series.studio && series.studio.length ? series.studio : series.studios}
        producers={series.producers}
        premiered={series.premiered}
        format={series.format}
        episodes={isMovie ? null : series.episodesTotal}
        duration={prettyDuration(series.duration)}
        source={series.source || (detail && detail.source)}
        contentRating={series.rating || (detail && detail.rating)}
        broadcast={series.broadcast || (detail && detail.broadcast)}
        aired={series.aired || (detail && detail.aired)}
        // Card-only, no `detail` fallback: `detail` is the live Jikan/AniList
        // anime record, whose staff and characters are not film credits.
        filmLayout={isMovie}
        released={series.released}
        backdrop={series.backdrop}
        director={series.director}
        cast={series.cast}
        writer={series.writer}
        country={series.country}
        crew={series.crew}
        budget={series.budget}
        boxOffice={series.boxOffice}
        synonyms={series.synonyms && series.synonyms.length ? series.synonyms : (detail && detail.synonyms)}
        titleJapanese={series.titleJapanese || (detail && detail.titleJapanese)}
        titleEnglish={series.titleEnglish || (detail && detail.titleEnglish)}
        trailer={series.trailer || (detail && detail.trailer)}
        accent={accent}
        rightColumn={(
          <AnimeMainColumn
            malId={isAnime ? series.providerId : null}
            accent={accent}
            filmLayout={isMovie}
            cast={isMovie ? series.cast : null}
            crew={isMovie ? series.crew : null}
            castImages={isMovie ? series.castImages : null}
            crewImages={isMovie ? series.crewImages : null}
            filmTitle={isMovie ? series.title : null}
            genres={isMovie ? series.genres : null}
            writer={isMovie ? series.writer : null}
            studios={isMovie ? (series.studio && series.studio.length ? series.studio : series.studios) : null}
            country={isMovie ? series.country : null}
            releases={isMovie ? series.releases : null}
            budget={isMovie ? series.budget : null}
            boxOffice={isMovie ? series.boxOffice : null}
            trailer={isMovie ? series.trailer : null}
            synopsis={series.synopsis || (detail && detail.synopsis)}
            background={series.background || (detail && detail.background)}
            openings={series.openings && series.openings.length ? series.openings : (detail && detail.openings)}
            endings={series.endings && series.endings.length ? series.endings : (detail && detail.endings)}
          />
        )}
        rating={(
          <>
            {/* Status, Download and More read as ONE unit on a film — the same
                fused .candy-split shell the tab strip above them uses. */}
            <div className={isMovie ? 'candy-split' : undefined}
              style={isMovie ? { position: 'relative', '--cbtn-size': '26px' } : undefined}>
            {isMovie && primaryAction}
            <CandySelect
              value={statusValue}
              accent={accent}
              fuse={isMovie}
              shape={isMovie ? 'chip' : 'select'}
              title={statusTitle}
              placeholder={isFranchise ? `${seasonName} status` : 'Status'}
              options={STATUSES.map(s => ({ value: s, label: statusLabel(s), icon: STATUS_ICON[s], dot: resolveDot(STATUS_DOT_COLOR, s, accent) }))}
              clearable
              onChange={(s) => {
                if (!s) return;
                videoApi.markSeriesStatus(series.path, s, isFranchise ? seasonName : null)
                  .then(() => {
                    setSeries(prev => {
                      if (!prev) return prev;
                      if (isFranchise) {
                        const newSeasons = prev.seasons.map((sec, i) =>
                          i === activeSeasonIdx ? { ...sec, status: s } : sec);
                        return { ...prev, seasons: newSeasons };
                      }
                      return { ...prev, status: s };
                    });
                    window.dispatchEvent(new CustomEvent('series-updated', { detail: { path: series.path } }));
                  })
                  .catch(err => alert('Status failed: ' + err.message));
              }}
            />
            {/* Rating as a peer of the status chip. The values are the schema
                numbers; re-picking the current one clears it, as the dot strip did.
                Every rating wears the star (user-directed 2026-09-27; the
                album's copy matches). */}
            {isMovie && (
              <CandySelect icon={IconStarMark}
                value={series.personalRating ? String(series.personalRating) : ''}
                accent={accent}
                fuse shape="chip"
                title="Your rating out of 10"
                placeholder="Rate"
                options={Array.from({ length: 10 }, (_, n) => ({ value: String(10 - n), label: String(10 - n) }))}
                clearable
                onChange={(v) => {
                  const r = Number(v) || 0;
                  videoApi.markSeriesRating(series.path, r)
                    .then(() => {
                      setSeries(s => ({ ...s, personalRating: r }));
                      window.dispatchEvent(new CustomEvent('series-updated', { detail: { path: series.path, personalRating: r } }));
                    })
                    .catch(err => alert('Rating failed: ' + err.message));
                }}
              />
            )}
            {!isMovie && primaryAction}
            {series.localPath && (
              <button onClick={() => videoApi.revealInFiles(series.localPath).catch(err => alert('Reveal failed: ' + err.message))}
                title={`Reveal ${series.localPath} in file manager`} data-own-press className="candy-btn" data-shape="icon">
                <span className="candy-face"><IconFolder size={16}/></span>
              </button>
            )}
            {/* A film sizes it like the buttons beside it (the icon shape is a
                26x26 square, which read as a smaller control); every other
                domain keeps the compact icon. */}
            <button type="button" data-own-press title="More" className="candy-btn"
              data-shape={isMovie ? 'chip' : 'icon'}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const items = [];
                if (canRedownload && isAnime) items.push({ label: 'Re-download', onClick: onDownload });
                // Films and shows only: the command reads Cinemeta, which has no
                // anime lane (those cards come from MAL via download_anime.py).
                if (!isAnime) items.push({ label: 'Refresh details', onClick: onRefreshDetails });
                // Every room: series_uninstall works out which one from the
                // card path, so a film and a show uninstall like an anime does.
                if (onDisk) items.push({ label: 'Uninstall', onClick: () => setConfirmOpen(true) });
                if (items.length === 0) return;
                openContextMenu({ x: r.left, y: r.bottom + 4 }, items, { accent });
              }}>
              {/* The swatch, not a ⋯ (user-directed 2026-09-26; the album's copy matches). */}
              <span className="candy-face"><IconSwatch size={14}/></span>
            </button>
            </div>
            {!isMovie && (
              <RatingStrip
                value={series.personalRating || 0}
                accent={accent}
                onChange={(v) => {
                  const r = Number(v) || 0;
                  videoApi.markSeriesRating(series.path, r)
                    .then(() => {
                      setSeries(s => ({ ...s, personalRating: r }));
                      window.dispatchEvent(new CustomEvent('series-updated', { detail: { path: series.path, personalRating: r } }));
                    })
                    .catch(err => alert('Rating failed: ' + err.message));
                }}
              />
            )}
          </>
        )}
        actions={flatStartIdx < 0 && dlJob && dlJob.state === 'error' ? (
          <span style={{ fontSize: 11, color: 'var(--text)' }}>{dlJob.error || 'Download failed — press Retry.'}</span>
        ) : null}
      />

      {/* Season tab strip (franchise only) */}
      {isFranchise && (
        <div style={{
          display: 'flex', padding: '14px 18px 10px',
          borderBottom: 'var(--candy-frame) solid var(--border)',
          overflowX: 'auto',
        }}>
          <div className="candy-seg">
            {series.seasons.map((sec, i) => {
              const active = i === activeSeasonIdx;
              const watchedCount = (sec.watched || []).length;
              const total = sec.episodes.length;
              return (
                <button
                  key={sec.name}
                  type="button"
                  data-own-press
                  onClick={() => setActiveSeasonIdx(i)}
                  className={'candy-btn' + (active ? ' is-active' : '')}
                  data-shape="seg-option"
                >
                  <span className="candy-face" style={{
                    whiteSpace: 'nowrap',
                    gap: 8, alignItems: 'baseline',
                  }}>
                    <span>{sec.name}</span>
                    <span style={{
                      fontSize: 9,
                      opacity: active ? 0.7 : 0.55,
                      fontVariantNumeric: 'tabular-nums',
                    }}>{watchedCount}/{total}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Episode list — a film's single synthetic episode is Play's target, not
          something to list, so the whole section (empty state included) is off. */}
      {!isMovie && (
      <div style={{
        padding: '10px 14px 32px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {visibleEpisodes.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: 16, textAlign: 'center' }}>
            No episodes listed. Re-download the title to populate its <code>## Episodes</code> table.
          </div>
        )}
        {visibleEpisodes.map((ep, idx) => {
          const isWatched = watchedSet.has(ep.n);
          const flatIdx = isFranchise
            ? series.episodes.findIndex(e => e.seasonName === ep.seasonName && e.n === ep.n)
            : idx;
          const isPlaying = !!(
            player.currentEpisode && player.series &&
            player.series.path === series.path &&
            player.currentEpisode.n === ep.n &&
            (!isFranchise || player.currentEpisode.seasonName === ep.seasonName)
          );
          // The saved map is the ONLY source, including for the episode playing
          // right now. There used to be a live branch here reading the
          // provider's `effectiveTime` — dead under mpv (permanently 0) while
          // `duration` stayed live, so `duration > 0` passed, frac came out 0,
          // and the row you were watching was the one row with no sliver.
          // MpvHost writes real time+duration into this same map every 5 s and
          // useProgressMap re-reads it every 5 s, so the cost is ~5 s of lag —
          // already every other row's behaviour.
          let frac = null;
          if (ep.fileAbs && progressMap[ep.fileAbs]) {
            const p = progressMap[ep.fileAbs];
            if (p && p.duration > 0) frac = Math.min(1, p.time / p.duration);
          }
          if (isWatched && (frac == null || frac < 1)) frac = 1;
          const epJob = isAnime ? null : tvEpJob(ep.n);
          const epActive = !!epJob && (epJob.state === 'queued' || epJob.state === 'downloading');
          return (
            <EpisodeRow
              key={(ep.seasonName || '') + ':' + ep.n + ':' + ep.title}
              ep={ep}
              idx={flatIdx}
              accent={accent}
              watched={isWatched}
              playing={isPlaying}
              progress={frac}
              onPlay={() => onPlayEpisode(idx)}
              onDownload={!isAnime && series.imdbId && seasonNum ? () => onDownloadEpisode(ep.n) : null}
              dlPct={epActive ? (epJob.progressPct || 0) : null}
            />
          );
        })}
      </div>
      )}
      <TorrentPickerModal
        open={pickerOpen}
        title={series.title}
        englishTitle=""
        type="TV"
        accent={accent}
        imdbId={(isMovie || tvPick) ? series.imdbId : null}
        season={tvPick ? tvPick.season : null}
        episode={tvPick ? tvPick.episode : null}
        onPick={isMovie ? onPickMovieTorrent : (tvPick ? onPickTvTorrent : onPickTorrent)}
        onCancel={() => { setPickerOpen(false); setTvPick(null); }}
      />
      <ConfirmModal
        open={confirmOpen}
        danger
        title={`Uninstall ${series.title}?`}
        message={isFranchise
          ? `Removes the downloaded videos for all ${series.seasons.length} parts. ${series.title} stays in your library.`
          : `Removes the downloaded videos. ${series.title} stays in your library.`}
        confirmLabel={uninstalling ? 'Working' : 'Uninstall'}
        cancelLabel="Cancel"
        onCancel={() => { if (!uninstalling) setConfirmOpen(false); }}
        onConfirm={handleUninstall}
      >
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.65 }}>
          <li>The downloaded videos → <b>recycling bin</b> (restorable)</li>
          <li style={{ color: '#d9a55a' }}>
            Its torrent{(series.relatedIds && series.relatedIds.length > 1) ? 's' : ''} — removed, <b>not</b> restorable{series.airing ? '. New episodes stop arriving until you download again.' : ''}
          </li>
        </ul>
      </ConfirmModal>
      </div>
    </div>
  );
}

function Centered({ children, tone }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: tone === 'error' ? 'var(--text)' : 'var(--text-faint)',
      fontSize: 13,
    }}>{children}</div>
  );
}

// StatusPill replaced by the shared CandySelect (clearable, with status dots).
