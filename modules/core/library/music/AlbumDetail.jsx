// RIGHT pane of the Music page. The film page's header, wearing an album: the
// sleeve full-bleed behind a sleeve tile, the title at the film's derived
// scale, one fact line, and every action fused into one .candy-split run.
// Then the disc-grouped tracklist and credits.

import { Fragment, useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { IconPlay, IconStar, IconLayers, IconPlus, IconDownload } from '@host/components/icons.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { statusLabel, STATUS_ICON } from '@host/util/media-status.js';
import { libraryAbs } from '@host/api.js';
import { coverSrc, STATUS_DOT_COLOR, resolveDot, toBrowse } from './util.js';
import AddToPlaylistButton from './AddToPlaylistButton.jsx';
import { refFromQueueItem } from './PlaylistProvider.jsx';
import MusicCredits from './MusicCredits.jsx';
import { useDownloads } from './DownloadProvider.jsx';
import { consumeTrackHighlight, fmtDuration } from './searchShared.jsx';
import { useSongMenu } from './contextMenus.js';
import { navigate } from '@host/router.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { FILM_POSTER_W, FILM_DOT, POSTER_COL_GAP, PosterTile, SourceRun } from '../AnimeDetailHeader.jsx';
import { BODY_COLOR } from '../AnimeMainColumn.jsx';
import { artistImage } from './artistImage.js';

const LISTEN_STATUSES = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

// The photo rides the fact line, so it is sized to that line: an even number of
// pixels, so the circle has no half-pixel edge.
const ARTIST_PFP = 22;

// The rows and the action run above them are the SAME size knob, so a row can
// never drift from the run it sits under (.candy-split derives the seam, the
// corners and every part's height from it). Change this and both change.
const ROW_H = '26px';

// The track's own page: an md sibling of the audio file, falling back to the
// pipeline's Tracks folder for a card with no audio on disk. `wikilink` is the
// base filename with no extension.
function openTrackPage(track) {
  if (!track.wikilink) return;
  const albumFolder = track.audioPath ? track.audioPath.split('/').slice(0, -1).join('/') : '';
  const target = albumFolder
    ? albumFolder + '/' + track.wikilink + '.md'
    : 'Knowledge/Music/MusicBrainz Pipeline/Tracks/' + track.wikilink + '.md';
  window.location.hash = '/page/' + target.split('/').map(encodeURIComponent).join('/');
}

// The artist, leading the fact line: a round press photo and the name, which
// opens the only artist surface the app has (a Browse search). The photo comes
// from TheAudioDB (artistImage.js) and is often absent, so the initials circle
// is the normal case, not an error state.
function ArtistLink({ name, accent }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    setSrc('');
    artistImage(name).then(url => { if (live) setSrc(url); });
    return () => { live = false; };
  }, [name]);
  const a = accent || 'var(--accent)';
  const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (
    <span
      onClick={() => toBrowse(name)}
      title={`Find ${name}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}
      onMouseEnter={e => { e.currentTarget.style.color = a; }}
      onMouseLeave={e => { e.currentTarget.style.color = ''; }}
    >
      {src
        ? <img src={src} alt="" onError={() => setSrc('')}
            style={{ width: ARTIST_PFP, height: ARTIST_PFP, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0 }}/>
        : <span style={{
            width: ARTIST_PFP, height: ARTIST_PFP, borderRadius: '50%', flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: `color-mix(in oklch, ${a} 16%, var(--surface-2))`,
            fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600,
            color: 'var(--text-muted)', letterSpacing: '0.02em', userSelect: 'none',
          }}>{initials}</span>}
      {name}
    </span>
  );
}

// The recessed tray and its averaged-pixel cover tint were replaced 2026-09-19
// by the film page's full-bleed backdrop (.film-detail / .film-backdrop in
// library.css), which shows the sleeve itself instead of one colour taken off it.

export default function AlbumDetail({ accent, albumPath }) {
  const [album, setAlbum] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { playAlbumTracks, enqueue, currentTrack, isPlaying, toggle } = useMusicPlayer();
  const { jobs: dlJobs, enqueue: enqueueDownload } = useDownloads();
  const songMenu = useSongMenu(accent);
  const { openContextMenu } = useContextMenu();
  const [dlJobId, setDlJobId] = useState(null);
  const [dlError, setDlError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => musicApi.readAlbum(albumPath)
      .then(d => { if (!cancelled) { setAlbum(d); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });
    setLoading(true); setError(null); setAlbum(null);
    load();
    // A finished download (full or repair) re-broadcasts music-library-changed;
    // re-read so track availability flips without leaving the page.
    const onChanged = () => load();
    window.addEventListener('music-library-changed', onChanged);
    return () => { cancelled = true; window.removeEventListener('music-library-changed', onChanged); };
  }, [albumPath]);

  // A song picked from the browser's Songs tab parks its track number for us;
  // we claim it on mount. Re-runs per album, so the highlight can't survive
  // navigating elsewhere.
  const [highlight, setHighlight] = useState(null);
  useEffect(() => { setHighlight(consumeTrackHighlight(albumPath)); }, [albumPath]);

  // The tracklist is exactly as wide as the action run above it. That width is
  // whatever the run's labels add up to -- a status word, a rating, whether the
  // Download half is there at all -- so it is READ off the live run and re-read
  // whenever the run changes size, never written down here.
  const runRef = useRef(null);
  const [runW, setRunW] = useState(null);
  useEffect(() => {
    const el = runRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setRunW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [album]);

  const coverImgSrc = album ? coverSrc(album.image, 400, { library: true }) : null;

  if (loading) return <Centered>Loading</Centered>;
  if (error)   return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!album)  return <Centered>Not found</Centered>;

  const img = coverImgSrc;
  const playable = album.tracks.filter(t => t.available);

  // Download / repair — the owned-page path into the same Rust job the Browse
  // preview uses. Visible only when the card knows its release-group id and
  // tracks are missing (metadata-only cards: all of them).
  const dlJob = dlJobId ? dlJobs.find(j => j.id === dlJobId) : null;
  const dlBusy = !!(dlJob && (dlJob.state === 'queued' || dlJob.state === 'downloading'));
  const missing = album.tracks.length - playable.length;
  const dlLabel = (() => {
    if (dlJob) {
      switch (dlJob.state) {
        case 'queued': return 'Queued';
        case 'downloading': return `Downloading ${dlJob.trackIndex || 0}/${dlJob.trackTotal || '?'}`;
        case 'done': return 'Downloaded ✓';
        case 'error': return 'Failed — Retry';
        case 'cancelled': return 'Cancelled — Retry';
        default: return 'Download';
      }
    }
    return playable.length > 0 ? `Repair · ${missing} Missing` : 'Download';
  })();
  const startDownload = async () => {
    if (dlBusy || !album.providerId) return;
    setDlError(null);
    try {
      const id = await enqueueDownload({
        rgMbid: album.providerId, title: album.title, artist: album.artist,
        cover: (album.image && album.image.startsWith('http')) ? album.image : null,
        onlyMissing: playable.length > 0,
      });
      setDlJobId(id);
    } catch (err) { setDlError(err.message || 'Failed to start download.'); }
  };

  const playAll = () => playAlbumTracks(album, 0);

  // The fact line, in the film's order and shape. Length is SUMMED off the real
  // tracks rather than trusting the frontmatter "Length" string, which is often
  // absent; that string is only the fallback when no track carries a duration.
  const secs = album.tracks.reduce((t, x) => t + (x.duration || 0), 0);
  const lengthLabel = secs ? `${Math.round(secs / 60)}m` : (album.length || null);
  const nTracks = album.tracks.length;
  const facts = [
    album.artist ? <ArtistLink name={album.artist} accent={accent}/> : null,
    (album.genres && album.genres.length) ? album.genres.slice(0, 2).join(', ') : null,
    album.year || null,
    nTracks ? `${nTracks} track${nTracks === 1 ? '' : 's'}` : null,
    lengthLabel,
  ].filter(Boolean);
  const playFrom = (idx) => playAlbumTracks(album, idx);

  // The film's IMDb / Letterboxd / TMDb run, for a record. MusicBrainz opens
  // the release group itself when the card knows its id; Last.fm's album URL
  // is built from the names (spaces as +); Rate Your Music has no id here, so
  // it opens a release search. "RYM", not the full name: user-picked
  // 2026-09-25 because it is the label that keeps the run inside the sleeve's
  // width (measured 220.5 of 221; "Discogs" overhung it by 28).
  const plus = (s) => encodeURIComponent(s).replace(/%20/g, '+');
  const named = [album.artist, album.title].filter(Boolean).join(' ');
  const sources = [
    album.artist && album.title
      ? { label: 'Last.fm', url: `https://www.last.fm/music/${plus(album.artist)}/${plus(album.title)}` } : null,
    { label: 'RYM', url: `https://rateyourmusic.com/search?searchtype=l&searchterm=${encodeURIComponent(named)}` },
    { label: 'MBrainz', name: 'MusicBrainz', url: album.providerId
      ? `https://musicbrainz.org/release-group/${album.providerId}`
      : `https://musicbrainz.org/search?type=release_group&query=${encodeURIComponent(named)}` },
  ].filter(Boolean);

  const enqueueAlbum = () => {
    const items = album.tracks.map(t => ({
      albumPath: album.path, albumTitle: album.title, albumImage: album.image,
      artist: album.artist,
      n: t.n, title: t.title, audioPath: t.audioPath,
      available: t.available, streamable: !t.available,
      wikilink: t.wikilink, duration: t.duration,
    }));
    enqueue(items);
  };

  const setStatus = async (status) => {
    setBusy(true);
    try {
      await musicApi.markAlbumStatus(album.path, status);
      setAlbum(a => ({ ...a, status }));
      window.dispatchEvent(new CustomEvent('album-updated', { detail: { path: album.path, status } }));
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const onDelete = async () => {
    const n = playable.length;
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `Delete album “${album.title}”? Its card${n ? ` and ${n} audio track${n === 1 ? '' : 's'}` : ''} ` +
      `go to the recycling bin — restorable until it's purged. Playlist entries for these tracks show unavailable until you restore.`
    )) return;
    setBusy(true);
    try {
      await musicApi.deleteAlbum(album.path);
      window.dispatchEvent(new CustomEvent('music-library-changed'));
      navigate('/tools/library/music/downloaded');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {/* Header: cover + meta, over the sleeve painted full-bleed behind them.
          .film-detail is the film page's own header shell (library.css) -- it
          owns the deep top padding derived from the still's aspect, the reading
          measure, and the layering that keeps the content clickable. Used here
          verbatim, exactly as AnimeDetailHeader uses it for a film. */}
      {/* No sleeve, no shell: .film-detail's top padding is reserved FOR the
          picture, so applying it without one leaves 266px of empty page. */}
      <div className={img ? 'film-detail' : undefined}
           style={img ? undefined : { padding: '32px 28px 26px', borderBottom: '1px solid var(--border)' }}>
        {img && (
          <div className="film-backdrop is-square" aria-hidden>
            {/* A real <img>, like the film still: the box takes its height from
                the file rather than restating an aspect here. is-square adds
                the one crop a square sleeve needs. */}
            <img src={img} alt=""/>
          </div>
        )}
        {/* One wrapper for both columns: .film-detail centres its children at
            the reading measure, so the flex row has to BE a single child. */}
        <div style={{ display: 'flex', gap: 28 }}>
        {/* LEFT column: the film poster's column 1-1 -- the same candy tile
            (opens the full sleeve) and the same source run under it. */}
        <div style={{ width: FILM_POSTER_W, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: POSTER_COL_GAP }}>
          <PosterTile image={img} title={album.title} accent={accent || 'var(--accent)'} aspect="1 / 1"/>
          <SourceRun sources={sources}/>
        </div>

        <div style={{
          flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {/* Type tag. The film has none, but nothing else on the page tells an
              EP from an album. */}
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', color: BODY_COLOR,
            letterSpacing: '0.08em',           }}>{album.releaseType || 'Album'}</div>

          {/* Title and fact line both multiply by --film-head, the film's one
              head knob -- never type a size here that ignores it. */}
          <h2 style={{
            margin: 0, fontSize: 'calc(28px * var(--film-head))', fontWeight: 700,
            color: 'var(--text)', lineHeight: 1.12, letterSpacing: '-0.015em',
          }}>
            {album.title}
          </h2>

          {facts.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              fontSize: 'calc(12px * var(--film-head))', color: BODY_COLOR,
            }}>
              {facts.map((f, i) => <Fragment key={i}>{i > 0 && FILM_DOT}{f}</Fragment>)}
            </div>
          )}

          {/* Every action as ONE control, the same fused shell the film page
              uses for status / rating / Download / More. A disabled half keeps
              its paint and simply does nothing -- fading it punches a hole in
              the run. */}
          {/* The film page's action-row shell, 1-1 (AnimeMainColumn.jsx): the run,
              14px of air, one hairline, then 10px down to the body under it --
              which on a film is the Cast/Crew panel and here is the tracklist. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
          <div ref={runRef} className="candy-split" style={{
            position: 'relative', '--cbtn-size': ROW_H,
          }}>
            <CandySelect
              value={album.status || ''}
              accent={accent}
              fuse shape="chip"
              title="Mark status"
              placeholder="Status"
              options={LISTEN_STATUSES.map(s => ({ value: s, label: statusLabel(s), icon: STATUS_ICON[s], dot: resolveDot(STATUS_DOT_COLOR, s, accent) }))}
              clearable
              disabled={busy}
              onChange={setStatus}
            />

            {/* The film's rating control, 1-1: re-picking the current value
                clears it, exactly as the dot strip did. */}
            <CandySelect icon={IconStar}
              value={album.personalRating ? String(album.personalRating) : ''}
              accent={accent}
              fuse shape="chip"
              title="Your rating out of 10"
              placeholder="Rate"
              options={Array.from({ length: 10 }, (_, n) => ({ value: String(10 - n), label: String(10 - n), dot: accent }))}
              clearable
              disabled={busy}
              onChange={(v) => {
                const r = Number(v) || 0;
                musicApi.markAlbumRating(album.path, r)
                  .then(() => {
                    setAlbum(a => ({ ...a, personalRating: r }));
                    window.dispatchEvent(new CustomEvent('album-updated', {
                      detail: { path: album.path, personalRating: r },
                    }));
                  })
                  .catch(err => alert('Rating failed: ' + err.message));
              }}
            />

            <button
              className="candy-btn"
              data-shape="chip"
              data-own-press
              onClick={playAll}
              disabled={playable.length === 0}
            ><span className="candy-face"><IconPlay size={14}/>Play</span></button>

            <button
              className="candy-btn"
              data-shape="chip"
              data-own-press
              onClick={enqueueAlbum}
              disabled={playable.length === 0}
            ><span className="candy-face"><IconLayers size={14}/>Queue</span></button>

            <AddToPlaylistButton
              variant="form"
              fuse
              icon={IconPlus}
              label="Playlist"
              accent={accent}
              title="Add all tracks to a playlist"
              refs={playable.map(t => refFromQueueItem({
                albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                artist: album.artist, wikilink: t.wikilink, audioPath: t.audioPath,
                title: t.title, duration: t.duration,
              }))}
            />

            {album.providerId && (missing > 0 || dlJob) && (
              <button
                className="candy-btn"
                data-shape="chip"
                data-own-press
                onClick={startDownload}
                disabled={dlBusy}
                title={playable.length > 0 ? `Download the ${missing} missing track${missing === 1 ? '' : 's'}` : 'Download this album'}
              ><span className="candy-face"><IconDownload size={14}/>{dlLabel}</span></button>
            )}

            {/* Reveal and Delete live in here, as Uninstall does on a film --
                the run stays short enough to fit the reading measure. */}
            <button
              type="button"
              className="candy-btn"
              data-shape="chip"
              data-own-press
              title="More"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const items = [];
                if (album.trackFolder) items.push({
                  label: 'Reveal in files',
                  onClick: () => musicApi.revealInFiles(libraryAbs(album.trackFolder))
                    .catch(err => alert('Reveal failed: ' + err.message)),
                });
                items.push({ label: 'Delete album', onClick: onDelete });
                openContextMenu({ x: r.left, y: r.bottom + 4 }, items, { accent });
              }}
            ><span className="candy-face">⋯</span></button>
          </div>
          </div>

          {dlError && (
            <div style={{ fontSize: 11, color: 'var(--error)' }}>{dlError}</div>
          )}

          {/* Track list — grouped by disc when the album has more than one.
              It rides IN the right column, under the hairline, exactly where a
              film's Cast panel sits: same reading width as the title above it. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: runW ? runW + 'px' : undefined }}>
        {(() => {
          const groups = new Map();
          album.tracks.forEach((t, idx) => {
            const d = t.disc || 1;
            if (!groups.has(d)) groups.set(d, []);
            groups.get(d).push({ t, idx });
          });
          const discNumbers = [...groups.keys()].sort((a, b) => a - b);
          const multiDisc = discNumbers.length > 1;
          return discNumbers.map((d, di) => (
            // Row gap = the film Cast list's (library.css --credit-gap) plus the
            // chip lip, which paints outside layout -- same formula, same gap.
            // Off the 4px grid on purpose (6px, user-picked 2026-09-24).
            <div key={d} data-spacing-intent="credit-gap" style={{ display: 'flex', flexDirection: 'column', gap: 'calc(var(--credit-gap) + var(--candy-depth-small))' }}>
              {multiDisc && (
                <div style={{
                  padding: di === 0 ? '4px 14px 6px' : '14px 14px 6px',
                  fontSize: 10, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.12em',                   color: 'var(--text-faint)',
                  borderBottom: '1px solid var(--border)',
                }}>Disc {d}</div>
              )}
              {groups.get(d).map(({ t, idx }) => {
                const playingThis = currentTrack &&
                  currentTrack.albumPath === album.path &&
                  currentTrack.n === t.n;
                const playlistRef = refFromQueueItem({
                  albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                  artist: album.artist, wikilink: t.wikilink, audioPath: t.audioPath,
                  title: t.title, duration: t.duration,
                });
                return (
                  <TrackRow
                    key={t.n + ':' + t.title}
                    track={t}
                    accent={accent}
                    highlighted={!!highlight && highlight.n === t.n && (highlight.disc ?? 1) === (t.disc || 1)}
                    playlistRef={playlistRef}
                    playing={playingThis && isPlaying}
                    onMenu={(e) => songMenu.openMenu(e, {
                      albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                      artist: album.artist, n: t.n, title: t.title,
                      audioPath: t.audioPath, wikilink: t.wikilink, duration: t.duration,
                      available: t.available, rgMbid: album.providerId || null,
                    }, t.wikilink ? [{ label: 'Open track page', onClick: () => openTrackPage(t) }] : [])}
                    onPlay={() => (playingThis ? toggle() : playFrom(idx))}
                    onEnqueue={() => {
                      enqueue([{
                        albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                        artist: album.artist,
                        n: t.n, title: t.title, audioPath: t.audioPath,
                        available: t.available, streamable: !t.available,
                        wikilink: t.wikilink, duration: t.duration,
                      }]);
                    }}
                  />
                );
              })}
            </div>
          ));
        })()}
          </div>
          </div>
        </div>
        </div>
      </div>

      <MusicCredits album={album} accent={accent} />

      {songMenu.modalEl}
    </div>
  );
}

// One row = ONE fused run (.candy-split, Component Map § Default Components):
// the name half plays and pauses, then Playlist, then Queue. The two marks are
// the same ones the album's own Playlist / Queue buttons wear at the top of the
// page, so a row reads as a smaller copy of them. Every part is ROW_H tall
// because the run declares --cbtn-size; nothing here restates a height.
function TrackRow({ track, accent, playing, highlighted, onPlay, onEnqueue, onMenu, playlistRef }) {
  const rowRef = useRef(null);
  // Scroll a song arrived-at from search into view; long tracklists otherwise
  // highlight a row sitting below the fold.
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlighted]);

  // Same parts the run above is built from -- plain chips, not a shape of their
  // own -- so a row IS the action run, carrying a track instead of an action.
  // `.is-active` is the split's own lit-half state; the loaded track wears it.
  const lit = playing || highlighted;

  return (
    <div
      ref={rowRef}
      className="candy-split"
      style={{ display: 'flex', '--cbtn-size': ROW_H, '--accent': accent || 'var(--accent)' }}
    >
      <button
        type="button"
        className={'candy-btn' + (lit ? ' is-active' : '')}
        data-shape="chip"
        data-own-press
        onClick={onPlay}
        onContextMenu={onMenu}
        title={playing ? 'Pause' : 'Play'}
        style={{ flex: 1, minWidth: 0 }}
      >
        <span className="candy-face" style={{ width: '100%', justifyContent: 'flex-start' }}>
          <span style={{
            flexShrink: 0, fontVariantNumeric: 'tabular-nums', opacity: 0.7,
          }}>{playing ? '▶' : String(track.n).padStart(2, '0')}</span>

          <span style={{
            flex: 1, minWidth: 0, textAlign: 'left',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{track.title}</span>

          {/* Duration, at the far end of the half that carries the name. */}
          <span style={{
            flexShrink: 0, fontVariantNumeric: 'tabular-nums', opacity: 0.7,
          }}>{fmtDuration(track.duration)}</span>
        </span>
      </button>

      {/* Its own half now, not a child of the row -- so it needs no
          stopPropagation to keep the row from playing under it. */}
      <AddToPlaylistButton
        variant="form"
        fuse
        icon={IconPlus}
        label=""
        accent={accent}
        title="Add to playlist"
        refs={playlistRef ? [playlistRef] : []}
      />

      <button
        type="button"
        className="candy-btn"
        data-shape="chip"
        data-own-press
        onClick={onEnqueue}
        title="Add to queue"
      ><span className="candy-face"><IconLayers size={14}/></span></button>
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

// RatingStrip moved to ../RatingStrip.jsx — shared with the film / series detail
// page, which used to carry a separate dropdown for the same value.

// The status picker is the shared CandySelect (clearable, with status dots).
