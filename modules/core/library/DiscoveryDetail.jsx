// Full-page discovery detail for a not-yet-owned MAL title, reached by route
// (/tools/library/anime/title/<malId>). Fetches Jikan detail (synopsis + studios + meta)
// and the episode list, shows cover + meta + a Sub/Dub toggle + Download button
// + episode list. Self-sources its download job (useAnimeDownloads) and
// in-library state (useLibraryMap); when a download lands, the parent
// AnimeDetail re-resolves ownership and swaps in the owned (playable) view.
//
// Refactored from the retired AnimeBrowsePreview overlay: the "← Back" bar is
// gone — the Anime breadcrumb owns back-navigation — and the title/meta now
// come from the fetched detail rather than a passed-in search result.

import { useEffect, useRef, useState } from 'react';
import { videoApi } from './api.js';
import TorrentPickerModal from './TorrentPickerModal.jsx';
import { useAnimeDownloads } from './AnimeDownloadProvider.jsx';
import useLibraryMap from './useLibraryMap.js';
import AnimeMainColumn from './AnimeMainColumn.jsx';
import AnimeDetailHeader from './AnimeDetailHeader.jsx';
import LoadingScreen from './LoadingScreen.jsx';
import { AddToLibraryButton } from './QuickAdd.jsx';
import { IconDownload } from '@host/components/icons.jsx';

const ANIME_STATUSES = ['Plan-to-Watch', 'Currently-Watching', 'Completed', 'On-Hold', 'Dropped'];

function initials(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

// Fire an app-wide toast via the central notification bus.
function notify(detail) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('agentic:notify', { detail }));
  }
}

function PreviewCover({ srcs, accent, alt }) {
  const [step, setStep] = useState(0);
  const src = srcs[step];
  if (src) {
    return (
      <img
        src={src} alt={alt} loading="lazy"
        onError={() => setStep(s => s + 1)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `color-mix(in oklch, ${accent || 'var(--text-muted)'} 16%, var(--surface-2))`,
      color: 'var(--text-muted)',
      fontFamily: 'var(--font-mono)', fontSize: 44, fontWeight: 600,
      letterSpacing: '0.04em', userSelect: 'none',
    }}>{initials(alt)}</div>
  );
}

export default function DiscoveryDetail({ malId, accent, onResolveTitle }) {
  const id = Number(malId);
  const [detail, setDetail] = useState(null);
  const [episodes, setEpisodes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dlError, setDlError] = useState(null);
  const reqId = useRef(0);
  const { jobs, enqueue } = useAnimeDownloads();
  const libMap = useLibraryMap();
  const libraryEntry = libMap.get(id) || null;
  const job = jobs.find(j => j.malId === id && !j.metadataOnly) || null;
  const addJob = jobs.find(j => j.malId === id && j.metadataOnly) || null;
  const addBusy = !!(addJob && (addJob.state === 'queued' || addJob.state === 'preparing'));

  useEffect(() => {
    const myId = ++reqId.current;
    setLoading(true); setError(null); setDetail(null); setEpisodes(null);
    Promise.all([
      videoApi.animeDetail(id),
      videoApi.animeEpisodes(id).catch(() => []),
    ])
      .then(([d, eps]) => {
        if (myId !== reqId.current) return;
        setDetail(d);
        setEpisodes(eps || []);
        if (onResolveTitle && d && d.title) onResolveTitle(d.title);
      })
      .catch(e => { if (myId === reqId.current) setError(errText(e, 'Failed to load title.')); })
      .finally(() => { if (myId === reqId.current) setLoading(false); });
  }, [id]);

  const title = (detail && detail.title) || '…';
  const sub = detail && detail.titleEnglish && detail.titleEnglish !== title ? detail.titleEnglish : null;
  const year = detail && detail.year;
  const type = detail && detail.type;
  const epCount = detail && detail.episodes;
  const score = detail && detail.score;
  const status = detail && detail.status;
  const airing = detail && detail.airing;
  const premiered = detail && detail.season
    ? `${detail.season.charAt(0).toUpperCase()}${detail.season.slice(1)}${detail.year ? ` ${detail.year}` : ''}`
    : null;

  const metaBits = [
    year,
    type,
    epCount && `${epCount} ep`,
    score && `★ ${score}`,
    status,
  ].filter(Boolean);

  const coverSrcs = [detail && detail.image].filter(Boolean);

  const dlBusy = job && (job.state === 'queued' || job.state === 'preparing' || job.state === 'downloading');
  // Pre-flight qBittorrent, then open the torrent picker so a down daemon is
  // caught before the user bothers choosing a release.
  const startDownload = async () => {
    if (!detail || dlBusy) return;
    setDlError(null);
    const qbit = await videoApi.qbitStatus().catch(() => null);
    if (!qbit || !qbit.connected) {
      const why = (qbit && qbit.error) || 'qBittorrent isn’t reachable.';
      const msg = `${why} Start it in Settings → Anime, then retry.`;
      setDlError(msg);
      notify({ type: 'anime-download', title: 'Download blocked', message: msg, accent: 'var(--text)', iconKey: 'alert', duration: 7000 });
      return;
    }
    setPickerOpen(true);
  };
  // The picker hands back the chosen magnet + audio; enqueue with that explicit
  // source so download_anime.py skips its own (wrong-anime-prone) Nyaa search.
  const onPickTorrent = async (magnet, audioUsed) => {
    setPickerOpen(false);
    try {
      await enqueue({
        malId: id, title, audio: audioUsed, image: (detail && detail.image) || null,
        airing: !!airing, type: type || 'TV', episodes: epCount || null, downloadSource: magnet,
      });
      notify({ type: 'info', title: 'Download started', message: title, iconKey: 'download', accent: accent || 'var(--accent)', duration: 4000 });
    } catch (e) {
      setDlError(errText(e, 'Failed to start download.'));
    }
  };

  // Metadata-only add — writes the card via the same job queue, no torrent.
  const addToLibrary = async (status) => {
    if (addBusy || libraryEntry) return;
    setDlError(null);
    try {
      await enqueue({
        malId: id, title, image: (detail && detail.image) || null,
        airing: !!airing, type: type || 'TV', episodes: epCount || null,
        metadataOnly: true, initialStatus: status,
      });
      notify({ type: 'info', title: 'Adding to library', message: `${title} — ${status.replace(/-/g, ' ')}`, iconKey: 'download', accent: accent || 'var(--accent)', duration: 3500 });
    } catch (e) {
      setDlError(errText(e, 'Failed to add to library.'));
    }
  };

  const btn = (() => {
    if (job) {
      switch (job.state) {
        case 'queued': return { label: job.queuePosition > 0 ? `Queued — #${job.queuePosition}` : 'Queued…', busy: true };
        case 'preparing': return { label: 'Preparing…', busy: true };
        case 'downloading': return { label: `Downloading ${Math.round(job.progressPct || 0)}%…`, busy: true };
        case 'done': return { label: 'Downloaded ✓', done: true };
        case 'error': return { label: 'Failed — retry' };
        case 'cancelled': return { label: 'Cancelled — retry' };
        default: return { label: 'Download' };
      }
    }
    if (libraryEntry) return { label: '✓ In library', done: true };
    return { label: 'Download' };
  })();

  const ready = !loading;
  return (
    <>
      {!ready && <LoadingScreen accent={accent} />}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: ready ? 'block' : 'none' }}>
      <div className="detail-column">
      {/* MAL-style header — shared with the owned view via AnimeDetailHeader. */}
      <AnimeDetailHeader
        title={title}
        malId={id > 0 ? id : null}
        image={(detail && detail.image) || null}
        score={detail && detail.score}
        scoredBy={detail && detail.scoredBy}
        rank={detail && detail.rank}
        popularity={detail && detail.popularity}
        members={detail && detail.members}
        genres={detail && detail.genres}
        themes={detail && detail.themes}
        demographics={detail && detail.demographics}
        studios={detail && detail.studios}
        producers={detail && detail.producers}
        premiered={premiered}
        format={detail && detail.type}
        episodes={detail && detail.episodes}
        duration={detail && detail.duration}
        source={detail && detail.source}
        contentRating={detail && detail.rating}
        broadcast={detail && detail.broadcast}
        aired={detail && detail.aired}
        synonyms={detail && detail.synonyms}
        titleJapanese={detail && detail.titleJapanese}
        titleEnglish={detail && detail.titleEnglish}
        trailer={detail && detail.trailer}
        accent={accent}
        rightColumn={(
          <AnimeMainColumn
            malId={id}
            accent={accent}
            synopsis={detail && detail.synopsis}
            background={detail && detail.background}
            openings={detail && detail.openings}
            endings={detail && detail.endings}
          />
        )}
        actions={(
          <>
            <button
              onClick={startDownload}
              disabled={!!btn.busy || (!detail && !libraryEntry)}
              className="candy-btn is-primary"
              style={{ '--accent': accent, cursor: (!!btn.busy || (!detail && !libraryEntry)) ? 'default' : 'pointer', opacity: (!!btn.busy || (!detail && !libraryEntry)) ? 0.55 : 1 }}
            >
              <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                {btn.done ? '✓' : <IconDownload size={15}/>} {btn.label}
              </span>
            </button>
            {(!libraryEntry || addBusy) && (
              <div className="anime-rail-add">
                <AddToLibraryButton
                  accent={accent}
                  statuses={ANIME_STATUSES}
                  defaultStatus="Plan-to-Watch"
                  busy={addBusy}
                  added={false}
                  disabled={!detail}
                  onAdd={addToLibrary}
                />
              </div>
            )}
            {(dlError || (job && job.state === 'error' && job.error)) && (
              <div style={{ fontSize: 11, color: 'var(--text)' }}>{dlError || job.error}</div>
            )}
          </>
        )}
      />

      {/* Episodes */}
      <div style={{ marginTop: 26, padding: '0 24px 24px' }}>
        {loading && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading episodes…</div>}
        {!loading && error && <div style={{ color: 'var(--text)', fontSize: 12, padding: '12px 0' }}>{error}</div>}
        {!loading && !error && episodes && episodes.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{
              fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
              padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 2,
            }}>Episodes ({episodes.length})</div>
            {episodes.map(ep => <MalEpisodeRow key={ep.malId} ep={ep} />)}
          </div>
        )}
        {!loading && !error && episodes && episodes.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>No episode list available yet.</div>
        )}
      </div>
      </div>
      </div>
      <TorrentPickerModal
        open={pickerOpen}
        title={title}
        englishTitle={(detail && detail.titleEnglish) || ''}
        type={type}
        accent={accent}
        onPick={onPickTorrent}
        onCancel={() => setPickerOpen(false)}
      />
    </>
  );
}

function MalEpisodeRow({ ep }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 8px', borderRadius: 6,
        background: hover ? 'var(--surface-2)' : 'transparent',
        transition: 'background 100ms ease',
      }}
    >
      <span style={{
        width: 30, flexShrink: 0, textAlign: 'right',
        fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
      }}>{ep.malId}</span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} title={ep.title}>{ep.title || '—'}</span>
      {ep.aired && (
        <span style={{
          flexShrink: 0, fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}>{ep.aired}</span>
      )}
    </div>
  );
}

// DownloadButton retired — the rail now renders a full-width candy primary
// button inline (uniform height with Add to Library via .anime-rail-controls).
