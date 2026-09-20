// RIGHT pane of the Music page. The film page's header, wearing an album: the
// sleeve full-bleed behind a sleeve tile, the title at the film's derived
// scale, one fact line, and every action fused into one .candy-split run.
// Then the disc-grouped tracklist, notes and credits.

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
import MusicNotes from './MusicNotes.jsx';
import { useDownloads } from './DownloadProvider.jsx';
import { consumeTrackHighlight, fmtDuration } from './searchShared.jsx';
import { useSongMenu } from './contextMenus.js';
import { navigate } from '@host/router.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { FILM_POSTER_W, FILM_DOT } from '../AnimeDetailHeader.jsx';
import { BODY_COLOR } from '../AnimeMainColumn.jsx';
import { artistImage } from './artistImage.js';

const LISTEN_STATUSES = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

// The photo rides the fact line, so it is sized to that line: an even number of
// pixels, so the circle has no half-pixel edge.
const ARTIST_PFP = 22;

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
  const { playAlbumTracks, enqueue, currentTrack, isPlaying } = useMusicPlayer();
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
    (album.genres && album.genres.length) ? album.genres.slice(0, 4).join(', ') : null,
    album.year || null,
    nTracks ? `${nTracks} track${nTracks === 1 ? '' : 's'}` : null,
    lengthLabel,
  ].filter(Boolean);
  const playFrom = (idx) => playAlbumTracks(album, idx);

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
        {/* LEFT column: the sleeve alone, in the film poster's column. */}
        <div style={{ width: FILM_POSTER_W, flexShrink: 0 }}>
          <div style={{
            width: '100%', aspectRatio: '1 / 1',
            background: 'var(--surface-2)',
            borderRadius: 8, overflow: 'hidden',
            boxShadow: '0 10px 32px rgba(0,0,0,0.34)',
          }}>
            {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>}
          </div>
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
          <div className="candy-split is-plain-label" style={{
            position: 'relative', '--cbtn-size': '26px',
            marginTop: 4, alignSelf: 'flex-start',
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

          {dlError && (
            <div style={{ fontSize: 11, color: 'var(--error)' }}>{dlError}</div>
          )}
        </div>
        </div>
      </div>

      {/* Track list — grouped by disc when the album has more than one */}
      <div style={{
        padding: '10px 14px 32px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
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
            <div key={d} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                    track={t} idx={idx}
                    accent={accent}
                    highlighted={!!highlight && highlight.n === t.n && (highlight.disc ?? 1) === (t.disc || 1)}
                    playlistRef={playlistRef}
                    playing={playingThis && isPlaying}
                    onMenu={(e) => songMenu.openMenu(e, {
                      albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                      artist: album.artist, n: t.n, title: t.title,
                      audioPath: t.audioPath, wikilink: t.wikilink, duration: t.duration,
                      available: t.available, rgMbid: album.providerId || null,
                    })}
                    onPlay={() => playFrom(idx)}
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

      <MusicNotes album={album} accent={accent} />

      <MusicCredits album={album} accent={accent} />

      {songMenu.modalEl}
    </div>
  );
}

function TrackRow({ track, idx, accent, playing, highlighted, onPlay, onEnqueue, onMenu, playlistRef }) {
  const [hover, setHover] = useState(false);
  const rowRef = useRef(null);
  // Scroll a song arrived-at from search into view; long tracklists otherwise
  // highlight a row sitting below the fold.
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlighted]);
  const openPage = (e) => {
    e.stopPropagation();
    if (!track.wikilink) return;
    // Track pages live under Knowledge/Music/MusicBrainz Pipeline/Tracks (md sibling).
    // wikilink is the base filename without extension. Navigate to /page/<encoded>.
    const albumFolder = track.audioPath ? track.audioPath.split('/').slice(0, -1).join('/') : '';
    const target = albumFolder
      ? albumFolder + '/' + track.wikilink + '.md'
      : 'Knowledge/Music/MusicBrainz Pipeline/Tracks/' + track.wikilink + '.md';
    window.location.hash = '/page/' + target.split('/').map(encodeURIComponent).join('/');
  };

  return (
    <div
      ref={rowRef}
      className={'candy-btn' + (playing ? ' is-playing' : '') + (highlighted ? ' is-active' : '')}
      data-shape="track"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onPlay()}
      onContextMenu={onMenu}
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face">
      {/* Number / playing indicator */}
      <div style={{
        width: 26, height: 26, flexShrink: 0,
        borderRadius: 7,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: playing ? 'rgba(255,255,255,0.22)' : 'var(--surface-2)',
        border: playing ? 'none' : '1px solid var(--border)',
        color: playing ? 'white' : 'var(--text-muted)',
        fontSize: 11, fontFamily: 'var(--font-mono)',
        fontWeight: playing ? 700 : 500,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
      }}>
        {playing ? '▶' : String(track.n).padStart(2, '0')}
      </div>

      {/* Title */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, lineHeight: 1.25,
          fontWeight: playing ? 700 : 500,
          color: playing ? 'white' : 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{track.title}</div>
      </div>

      {/* Hover-reveal: open page + add to queue */}
      {track.wikilink && (
        <HoverBtn hover={hover} playing={playing} title="Open track page" onClick={openPage}>↗</HoverBtn>
      )}
      <HoverBtn hover={hover} playing={playing} title="Add to queue" onClick={(e) => { e.stopPropagation(); onEnqueue(); }}>+</HoverBtn>

      {/* Always-visible add-to-playlist (decision #6) */}
      {playlistRef && (
        <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, pointerEvents: 'auto' }}>
          <AddToPlaylistButton refs={[playlistRef]} accent={accent} />
        </span>
      )}

      {/* Duration */}
      <span style={{
        width: 42, textAlign: 'right', flexShrink: 0,
        fontSize: 11, fontFamily: 'var(--font-mono)',
        color: playing ? 'rgba(255,255,255,0.85)' : 'var(--text-muted)',
        fontVariantNumeric: 'tabular-nums',
      }}>{fmtDuration(track.duration)}</span>
      </div>
    </div>
  );
}

function HoverBtn({ children, hover, title, onClick, playing }) {
  // The row face is accent whenever these are visible (hovered or playing), so
  // one white set reads in both states -- --text-faint vanished on the red face.
  const base = 'rgba(255,255,255,0.7)';
  const lit = 'white';
  const litBg = 'rgba(255,255,255,0.18)';
  return (
    <button
      title={title} onClick={onClick}
      style={{
        background: 'transparent', border: 'none',
        color: base,
        padding: '4px 8px',
        cursor: 'pointer', fontSize: 13, lineHeight: 1,
        borderRadius: 4,
        opacity: hover ? 1 : 0,
        pointerEvents: hover ? 'auto' : 'none',
        transition: 'opacity 120ms ease, background 80ms ease, color 80ms ease',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = litBg;
        e.currentTarget.style.color = lit;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = base;
      }}
    >{children}</button>
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
