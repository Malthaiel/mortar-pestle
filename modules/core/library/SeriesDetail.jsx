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
import { IconFolder, IconDownload, IconPlay } from '@host/components/icons.jsx';
import { coverSrc, STATUS_DOT_COLOR, DOWNLOAD_DOT_COLOR, resolveDot } from './util.js';
import StatusDropdown from '@host/components/ui/StatusDropdown.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import AnimeMainColumn from './AnimeMainColumn.jsx';
import LoadingScreen from './LoadingScreen.jsx';
import AnimeDetailHeader from './AnimeDetailHeader.jsx';
import { useAnimeDownloads } from './AnimeDownloadProvider.jsx';
import TorrentPickerModal from './TorrentPickerModal.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';

const PROGRESS_KEY = 'video:progress';

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

// Personal-rating dropdown options (0 = unrated).
const RATING_OPTIONS = [
  { value: 0, label: '— / 10' },
  ...Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: `${i + 1} / 10` })),
];

// Header backdrop: blurred poster behind the header. Flip to false to disable.
const SHOW_HEADER_BACKDROP = true;

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

export default function SeriesDetail({ accent, seriesPath }) {
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeSeasonIdx, setActiveSeasonIdx] = useState(0);
  const player = useVideoPlayer();
  const progressMap = useProgressMap();
  const { jobs, enqueue } = useAnimeDownloads();
  const { openContextMenu } = useContextMenu();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);
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

  if (loading) return <LoadingScreen accent={accent} />;
  if (error)   return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!series) return <Centered>Not found</Centered>;

  const img = coverSrc(series.image);
  const playable = visibleEpisodes.filter(e => e.available);
  const nextUnwatched = visibleEpisodes.findIndex(e => e.available && !watchedSet.has(e.n));
  const playStartIdxLocal = nextUnwatched >= 0 ? nextUnwatched : visibleEpisodes.findIndex(e => e.available);

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
  const dlJob = jobs.find(j => j.malId === Number(series.providerId)) || null;
  const dlActive = !!dlJob && (dlJob.state === 'queued' || dlJob.state === 'preparing' || dlJob.state === 'downloading');
  const dlLabel = (() => {
    if (!dlJob) return null;
    switch (dlJob.state) {
      case 'queued': return dlJob.queuePosition > 0 ? `Queued — #${dlJob.queuePosition}` : 'Queued…';
      case 'preparing': return 'Preparing…';
      case 'downloading': return `Downloading ${Math.round(dlJob.progressPct || 0)}%…`;
      default: return null;
    }
  })();
  // Pre-flight qBittorrent, then open the torrent picker (owned re-download path).
  const onDownload = async () => {
    if (!series.providerId) return;
    const qbit = await videoApi.qbitStatus().catch(() => null);
    if (!qbit || !qbit.connected) {
      const why = (qbit && qbit.error) || 'qBittorrent isn’t reachable.';
      notify({ type: 'anime-download', title: 'Download blocked', message: `${why} Start it in Settings → Anime, then retry.`, accent: 'var(--text)', iconKey: 'alert', duration: 7000 });
      return;
    }
    setPickerOpen(true);
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
  // torrents [+files], drops the RSS rule, deletes folder/cover/card). Blocks if
  // qBittorrent is down — surfaced as a thrown error here.
  const handleUninstall = async () => {
    if (uninstalling) return;
    setUninstalling(true);
    try {
      const rep = await videoApi.animeUninstall(series.path, deleteFiles);
      setConfirmOpen(false);
      window.dispatchEvent(new CustomEvent('video-library-changed', { detail: {} }));
      const warns = (rep && rep.warnings) || [];
      if (rep && rep.ok) {
        notify({ type: 'info', title: 'Moved to recycling bin', message: series.title, accent: accent || 'var(--accent)', duration: 4000 });
        if (warns.length) notify({ type: 'anime-download', title: 'Uninstall warnings', message: warns.join('  •  '), accent: '#d9a55a', iconKey: 'alert', duration: 9000 });
        window.location.hash = '/tools/library/anime';
      } else {
        notify({ type: 'anime-download', title: 'Uninstall incomplete', message: warns[0] || 'Could not remove the library card.', accent: 'var(--text)', iconKey: 'alert', duration: 9000 });
      }
    } catch (e) {
      setConfirmOpen(false);
      notify({ type: 'anime-download', title: 'Uninstall blocked', message: (e && e.message) || 'Uninstall failed.', accent: 'var(--text)', iconKey: 'alert', duration: 9000 });
    } finally {
      setUninstalling(false);
    }
  };

  const seasonName = activeSeason ? activeSeason.name : null;
  const statusValue = isFranchise ? (activeSeason ? activeSeason.status : '') : (series.status || '');
  const statusTitle = isFranchise
    ? `Set ${seasonName} status`
    : 'Set watch status';

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="detail-column">
      {/* MAL-style header — shared with the discovery view via AnimeDetailHeader. */}
      <AnimeDetailHeader
        title={series.title}
        subtitle={isFranchise ? `${series.seasons.length} ${series.seasons.length === 1 ? 'entry' : 'entries'}` : null}
        malId={series.providerId}
        image={img}
        score={series.onlineRating}
        scoredBy={series.scoredBy}
        rank={series.rank}
        popularity={series.popularity}
        members={series.members}
        genres={series.genres}
        themes={series.themes}
        demographics={series.demographics}
        studios={series.studio}
        producers={series.producers}
        premiered={series.premiered}
        format={series.format}
        episodes={series.episodesTotal}
        duration={prettyDuration(series.duration)}
        source={series.source || (detail && detail.source)}
        contentRating={series.rating || (detail && detail.rating)}
        broadcast={series.broadcast || (detail && detail.broadcast)}
        aired={series.aired || (detail && detail.aired)}
        synonyms={series.synonyms && series.synonyms.length ? series.synonyms : (detail && detail.synonyms)}
        titleJapanese={series.titleJapanese || (detail && detail.titleJapanese)}
        titleEnglish={series.titleEnglish || (detail && detail.titleEnglish)}
        trailer={series.trailer || (detail && detail.trailer)}
        accent={accent}
        rightColumn={(
          <AnimeMainColumn
            malId={series.providerId}
            accent={accent}
            synopsis={series.synopsis || (detail && detail.synopsis)}
            background={series.background || (detail && detail.background)}
            openings={series.openings && series.openings.length ? series.openings : (detail && detail.openings)}
            endings={series.endings && series.endings.length ? series.endings : (detail && detail.endings)}
          />
        )}
        rating={(
          <>
            <CandySelect
              value={series.personalRating || 0}
              options={RATING_OPTIONS}
              title="Set your rating"
              onChange={(v) => {
                const r = Number(v);
                videoApi.markSeriesRating(series.path, r)
                  .then(() => {
                    setSeries(s => ({ ...s, personalRating: r }));
                    window.dispatchEvent(new CustomEvent('series-updated', { detail: { path: series.path, personalRating: r } }));
                  })
                  .catch(err => alert('Rating failed: ' + err.message));
              }}
            />
            <StatusDropdown
              value={statusValue}
              accent={accent}
              title={statusTitle}
              placeholder={isFranchise ? `${seasonName} status…` : 'Status…'}
              statuses={STATUSES}
              dotFor={(s) => resolveDot(STATUS_DOT_COLOR, s, accent)}
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
            {flatStartIdx >= 0 ? (
              <button onClick={onPlayAll} className="candy-btn is-primary" style={{ cursor: 'pointer' }}>
                <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><IconPlay size={14}/> {nextUnwatched >= 0 ? 'Resume' : 'Play'}</span>
              </button>
            ) : dlActive ? (
              <button disabled className="candy-btn is-primary" style={{ cursor: 'default', opacity: 0.6 }}>
                <span className="candy-face">{dlLabel}</span>
              </button>
            ) : (
              <button onClick={onDownload} disabled={!series.providerId} className="candy-btn is-primary"
                style={{ cursor: series.providerId ? 'pointer' : 'not-allowed', opacity: series.providerId ? 1 : 0.4 }}>
                <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><IconDownload size={15}/> {dlJob && dlJob.state === 'error' ? 'Retry download' : 'Download'}</span>
              </button>
            )}
            {series.localPath && (
              <button onClick={() => videoApi.revealInFiles(series.localPath).catch(err => alert('Reveal failed: ' + err.message))}
                title={`Reveal ${series.localPath} in file manager`} data-own-press className="candy-btn" data-shape="icon">
                <span className="candy-face"><IconFolder size={16}/></span>
              </button>
            )}
            <button type="button" data-own-press title="More…" className="candy-btn" data-shape="icon"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openContextMenu({ x: r.left, y: r.bottom + 4 }, [
                  { label: 'Uninstall…', onClick: async () => {
                    const qbit = await videoApi.qbitStatus().catch(() => null);
                    if (!qbit || !qbit.connected) {
                      notify({ type: 'anime-download', title: 'Uninstall blocked', message: `${(qbit && qbit.error) || 'qBittorrent isn’t reachable.'} Start it in Settings → Anime, then retry.`, accent: 'var(--text)', iconKey: 'alert', duration: 7000 });
                      return;
                    }
                    setDeleteFiles(true);
                    setConfirmOpen(true);
                  } },
                ], { accent });
              }}>
              <span className="candy-face">⋯</span>
            </button>
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
          borderBottom: '1px solid var(--border)',
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

      {/* Episode list */}
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
          // Live fraction wins for the currently-playing episode in this
          // same window; otherwise fall back to the saved progress map.
          let frac = null;
          if (isPlaying && player.duration > 0) {
            frac = Math.min(1, player.effectiveTime / player.duration);
          } else if (ep.fileAbs && progressMap[ep.fileAbs]) {
            const p = progressMap[ep.fileAbs];
            if (p && p.duration > 0) frac = Math.min(1, p.time / p.duration);
          }
          if (isWatched && (frac == null || frac < 1)) frac = 1;
          return (
            <EpisodeRow
              key={(ep.seasonName || '') + ':' + ep.n + ':' + ep.title}
              ep={ep}
              idx={flatIdx}
              accent={accent}
              seriesPath={series.path}
              watched={isWatched}
              playing={isPlaying}
              progress={frac}
              onPlay={() => onPlayEpisode(idx)}
            />
          );
        })}
      </div>
      <TorrentPickerModal
        open={pickerOpen}
        title={series.title}
        englishTitle=""
        type="TV"
        accent={accent}
        onPick={onPickTorrent}
        onCancel={() => setPickerOpen(false)}
      />
      <ConfirmModal
        open={confirmOpen}
        danger
        title={`Uninstall ${series.title}?`}
        message={isFranchise
          ? `Removes the entire ${series.title} entry — all ${series.seasons.length} parts.`
          : `Removes ${series.title} from your library.`}
        confirmLabel={uninstalling ? 'Working…' : (deleteFiles ? 'Delete everything' : 'Remove from library')}
        cancelLabel="Cancel"
        onCancel={() => { if (!uninstalling) setConfirmOpen(false); }}
        onConfirm={handleUninstall}
      >
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.65 }}>
          <li>The library card &amp; cover → <b>recycling bin</b> (restorable)</li>
          {deleteFiles && series.localPath && (
            <li>The downloaded video → <b>recycling bin</b> (restorable)</li>
          )}
          <li style={{ color: '#d9a55a' }}>
            Its qBittorrent torrent{(series.relatedIds && series.relatedIds.length > 1) ? 's' : ''}{series.airing ? ' + RSS rule' : ''} — removed, <b>not</b> restorable
          </li>
        </ul>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)' }}>
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
          Also send the downloaded video to the recycling bin
        </label>
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Card, cover &amp; video go to the recycling bin; torrents &amp; RSS rules are removed from qBittorrent and can't be restored. qBittorrent must be running.</div>
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

function RatingStrip({ value, accent, onChange }) {
  const [hover, setHover] = useState(0);
  const display = hover || value || 0;
  return (
    <div
      onMouseLeave={() => setHover(0)}
      style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 }}
    >
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)',
      }}>Personal</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => {
          const filled = n <= display;
          return (
            <button
              key={n}
              type="button"
              data-own-press
              onMouseEnter={() => setHover(n)}
              onClick={() => onChange(n === value ? 0 : n)}
              aria-label={`Rate ${n} out of 10`}
              title={`${n}/10`}
              className={'candy-btn' + (filled ? ' is-filled' : '')}
              data-shape="dot"
              style={{ '--accent': accent || 'var(--accent)' }}
            ><span className="candy-face" /></button>
          );
        })}
      </div>
      <span style={{
        fontSize: 10, fontFamily: 'var(--font-mono)',
        color: value > 0 ? 'var(--text-muted)' : 'var(--text-faint)',
        fontVariantNumeric: 'tabular-nums',
        minWidth: 32,
      }}>
        {value > 0 ? `${value}/10` : '— /10'}
      </span>
    </div>
  );
}

// StatusPill replaced by the shared candy StatusDropdown
// (@host/components/ui/StatusDropdown.jsx), imported at the top of this file.
