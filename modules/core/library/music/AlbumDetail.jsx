// RIGHT pane of the Music page. The film page's header, wearing an album: the
// sleeve full-bleed behind a sleeve tile, the title at the film's derived
// scale, one fact line, and every action fused into one .candy-split run.
// Then the disc-grouped tracklist and credits.

import { Fragment, useEffect, useRef, useState } from 'react';
import { musicApi, useMbRefreshTick, useCaaCover } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { IconPlay, IconStar, IconTrophyStar, IconMedalStar, IconRadio, IconSwatch, IconBookmarkPlus, IconDownload, IconMusic, IconGroup, IconCopyPlus, IconCamcorder, IconEarAlt, IconAnnouncement } from '@host/components/icons.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { statusLabel, STATUS_ICON } from '@host/util/media-status.js';
import { libraryAbs } from '@host/api.js';
import { coverSrc, STATUS_DOT_COLOR, resolveDot, toBrowse, TILE_MIN, albumToQueueItems } from './util.js';
import { usePrefetchStreams } from './streamCache.js';
import AddToPlaylistButton from './AddToPlaylistButton.jsx';
import { useAddToPlaylistMenu } from './useAddToPlaylistMenu.jsx';
import { refFromQueueItem } from './PlaylistProvider.jsx';
import { AlbumPerformers, ArtistAlbums } from './MusicCredits.jsx';
import { usePersistedState } from '@host/components/vault-tree/useTreeExpansion.js';
import { useDownloads } from './DownloadProvider.jsx';
import { consumeTrackHighlight, fmtDuration } from './searchShared.jsx';
import { useSongMenu } from './contextMenus.js';
import { navigate } from '@host/router.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { FILM_POSTER_W, FILM_DOT, POSTER_COL_GAP, POSTER_DEPTH, PosterTile, SourceRun } from '../AnimeDetailHeader.jsx';
import ImageLightbox, { useLightbox } from '../ImageLightbox.jsx';
import { artistImage } from './artistImage.js';

// The header's text: type tag, title and fact line all in the title's colour,
// the tag at the fact line's size (user-directed 2026-09-26). The size rides
// --film-head, the film's one head knob.
const HEAD_COLOR = 'var(--text)';
const FACT_SIZE = 'calc(12px * var(--film-head))';

const LISTEN_STATUSES = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

// The film's tab strip (AnimeMainColumn FILM_TABS), for a record: one section
// under the hairline at a time (user-directed 2026-09-26).
// Icon + word, like Play; "Credits" because "Performers" ran too long
// (user-directed 2026-09-26). Details was removed the same day (user-directed);
// a persisted 'Details' falls back to Tracks through the includes() guard.
// Releases and Artwork tabs were built and removed the same day (user-directed);
// the artwork moved into the sleeve's own viewer.
// A Plays tab went the same way: each song's count is a part of its own row.
// Discography is the artist's other records, moved up from the "More from"
// rail under the header (user-directed 2026-09-26, named over "Albums"),
// last in the strip (user-directed 2026-09-27; second before). Names must not
// shrink left to right: opening a tab shuts the open one's name, so a long name
// left of a shorter one slides the shorter tab wholly out from under a pointer on
// it (its hover shrinks the run off the pointer, the picked tab reopens under it,
// and the pair twitches: filmed 2026-09-27).
const ALBUM_TABS = ['Tracks', 'Credits', 'Discography'];
const TAB_ICON = { Tracks: IconMusic, Credits: IconGroup, Discography: IconRadio };
// Which tab a gliding pointer opens (now at `x`, last at `px`), starting from the one
// open now (`cur`): the open tab hands over when the pointer crosses the line half an
// icon inside its edge, the same lead at every edge whatever the tab's width
// (user-directed 2026-09-27), or when it is past the edge. Crossed, not inside: a
// pointer that lands in that band has not glided there, and keeps the tab it landed
// on. Rejected the same day: a swap at the midpoint of the two open centres
// ("switches too early"), then a lead only where a slide forced one (small tabs
// waited for the edge). It holds while every name is wider than two leads (else the
// walk would step back); the walk goes one way, so it always ends. Layouts are
// rebuilt from the live parts (shut width = width minus what its name adds right
// now), because live rects lie mid-glide.
function tabUnder(run, x, px, cur) {
  const parts = [...run.children], shut = [], name = [], lap = [];
  for (const p of parts) {
    const lbl = p.querySelector('.split-label'), cs = getComputedStyle(lbl);
    const gap = parseFloat(getComputedStyle(lbl.parentElement).columnGap) || 0;
    shut.push(p.getBoundingClientRect().width - (lbl.getBoundingClientRect().width + parseFloat(cs.marginLeft) + gap));
    name.push(lbl.firstElementChild.getBoundingClientRect().width + gap);
    lap.push(parseFloat(getComputedStyle(p).marginLeft) || 0);
  }
  const l0 = parts[0].getBoundingClientRect().left - lap[0];
  // Part j's [left, right] in the layout where part k is open.
  const at = (k, j) => {
    let l = l0;
    for (let i = 0; i < j; i++) l += lap[i] + shut[i] + (i === k ? name[i] : 0);
    l += lap[j];
    return [l, l + shut[j] + (j === k ? name[j] : 0)];
  };
  const lead = shut[0] / 2;
  let k = cur;
  while (k + 1 < parts.length && (x >= at(k, k)[1] || (px < at(k, k)[1] - lead && x >= at(k, k)[1] - lead))) k++;
  if (k === cur) while (k > 0 && (x < at(k, k)[0] || (px >= at(k, k)[0] + lead && x < at(k, k)[0] + lead))) k--;
  return k;
}

// The photo rides the fact line, so it is sized to that line: an even number of
// pixels, so the circle has no half-pixel edge.
const ARTIST_PFP = 22;

// The rows and the action run above them are the SAME size knob, so a row can
// never drift from the run it sits under (.candy-split derives the seam, the
// corners and every part's height from it). Change this and both change.
const ROW_H = '26px';

// The header column's line gap (type tag, title, fact line), and the air above and
// below the action runs: the fact line down to them and them down to the body are
// the SAME air (user-directed 2026-09-27; measured 12px from the artist photo's
// bottom to the run's top). The runs' lip paints outside layout, so the gap under
// them adds it back.
const HEAD_GAP = 8;
const RUN_AIR = 12;

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
  // The album's Add to Playlist rides the More menu (user-directed 2026-09-26),
  // the same sub-menu a song's right-click menu carries.
  const playlistMenu = useAddToPlaylistMenu(accent);
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
  const [tab, setTab] = usePersistedState('library:albumTab', 'Tracks');
  const active = ALBUM_TABS.includes(tab) ? tab : 'Tracks';
  // The tab showing its name: the hovered one, else the picked one.
  const [hoverTab, setHoverTab] = useState(null);
  const openTab = hoverTab ?? active;
  const lastX = useRef(null);   // the pointer's last x on the run; null = not on it
  const [highlight, setHighlight] = useState(null);
  const videos = useTrackVideos(album);
  const world = useWorldPlays(album);
  useEffect(() => { setHighlight(consumeTrackHighlight(albumPath)); }, [albumPath]);
  // The sleeve's viewer: the big picture, and beside it every scanned picture.
  const lb = useLightbox();
  const art = useAlbumArtwork(lb.open ? album?.providerId : null);
  const plays = usePlayCounts();
  // Not-downloaded tracks get their links ahead (first 30), so Play is instant.
  // ponytail: no scroll watch here, an album past 30 tracks is rare.
  usePrefetchStreams(album ? albumToQueueItems(album) : []);

  const coverImgSrc = album ? coverSrc(album.image, 400, { library: true }) : null;
  // The backdrop (drawn ~900px wide) and the sleeve's viewer take the file itself,
  // not the 400px thumbnail (measured 2026-09-27: a 1500px cover shown as a 400px
  // copy at 904px).
  const fullImg = album ? coverSrc(album.image, 0, { library: true }) : null;

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

  // Each song's finished-listen count. The count part is as wide as the
  // album's biggest count (in digits), so every row's parts line up.
  const trackPlays = plays ? album.tracks.map(t => playCount(plays, album, t)) : null;
  const playsDigits = trackPlays ? String(Math.max(0, ...trackPlays)).length : 1;
  // Worldwide plays: every distinct number this album shows rides hidden in
  // each row's slot, so the browser sizes all the slots to the widest one and
  // the parts line up (12.4M and 812 are not the same width in any font).
  const worldText = (t) => {
    const w = world[squash(t.title)];
    return w ? compactPlays.format(w.playcount) : '–';
  };
  const worldSizers = [...new Set(album.tracks.map(worldText))];
  const trackRow = (t, idx) => {
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
        plays={trackPlays?.[idx]}
        playsDigits={playsDigits}
        accent={accent}
        highlighted={!!highlight && highlight.n === t.n && (highlight.disc ?? 1) === (t.disc || 1)}
        playlistRef={playlistRef}
        videoUrl={videos[squash(t.title)]}
        world={world[squash(t.title)]}
        worldText={worldText(t)}
        worldSizers={worldSizers}
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
  };

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

  // scrollbar-gutter keeps the scrollbar's lane even when nothing scrolls, so
  // the right edge (lane + gutter) always matches the left (the ResizeSeam
  // grab strip + gutter): 34px both sides, measured 2026-09-26.
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' }}>
      {/* Header: cover + meta, over the sleeve painted full-bleed behind them.
          .film-detail is the film page's own header shell (library.css) -- it
          owns the deep top padding derived from the still's aspect, the reading
          measure, and the layering that keeps the content clickable. Used here
          verbatim, exactly as AnimeDetailHeader uses it for a film. */}
      {/* No sleeve, no shell: .film-detail's top padding is reserved FOR the
          picture, so applying it without one leaves 266px of empty page.
          .film-below keeps the same column (gutter + measure) without it. */}
      <div className={img ? 'film-detail' : 'film-below'}
           style={img ? undefined : { paddingTop: 32, paddingBottom: 26, borderBottom: 'var(--candy-frame) solid var(--border)' }}>
        {img && (
          <div className="film-backdrop is-square" aria-hidden>
            {/* A real <img>, like the film still: the box takes its height from
                the file rather than restating an aspect here. is-square adds
                the one crop a square sleeve needs. */}
            <img src={fullImg} alt=""/>
          </div>
        )}
        {/* One wrapper for both columns: .film-detail centres its children at
            the reading measure, so the flex row has to BE a single child. */}
        <div style={{ display: 'flex', gap: 28 }}>
        {/* LEFT column: the film poster's column 1-1 -- the same candy tile
            (opens the full sleeve) and the same source run under it. */}
        <div style={{ width: FILM_POSTER_W, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: POSTER_COL_GAP }}>
          <PosterTile image={img} title={album.title} accent={accent || 'var(--accent)'} aspect="1 / 1"
            onClick={() => lb.show(fullImg, album.title)}/>
          <SourceRun sources={sources}/>
        </div>

        <div style={{
          flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: HEAD_GAP,
        }}>
          {/* Type tag. The film has none, but nothing else on the page tells an
              EP from an album. The title's colour at the fact line's size
              (user-directed 2026-09-26). */}
          <div style={{
            fontSize: FACT_SIZE, fontFamily: 'var(--font-mono)', color: HEAD_COLOR,
            letterSpacing: '0.08em',           }}>{album.releaseType || 'Album'}</div>

          {/* Title and fact line both multiply by --film-head, the film's one
              head knob -- never type a size here that ignores it. */}
          <h2 style={{
            margin: 0, fontSize: 'calc(28px * var(--film-head))', fontWeight: 700,
            color: HEAD_COLOR, lineHeight: 1.12, letterSpacing: '-0.015em',
          }}>
            {album.title}
          </h2>

          {/* White like the title (user-directed 2026-09-26); ArtistLink
              inherits it and only tints on hover. */}
          {facts.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              fontSize: FACT_SIZE, color: HEAD_COLOR,
            }}>
              {facts.map((f, i) => <Fragment key={i}>{i > 0 && FILM_DOT}{f}</Fragment>)}
            </div>
          )}

          {/* Every action as ONE control, the same fused shell the film page
              uses for status / rating / Download / More. A disabled half keeps
              its paint and simply does nothing -- fading it punches a hole in
              the run. */}
          {/* The film page's action-row shell (AnimeMainColumn.jsx), minus its
              hairline (user-directed 2026-09-26). RUN_AIR above and below the
              runs (user-directed 2026-09-27; the film's 14px of air plus 10px
              painted 19px under them). */}
          <div data-spacing-intent="run-air" style={{ display: 'flex', flexDirection: 'column', gap: `calc(${RUN_AIR}px + var(--candy-depth-small))`, marginTop: RUN_AIR - HEAD_GAP }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* The action run leads, the tabs follow it (user-directed 2026-09-26). */}
          <div className="candy-split" style={{
            position: 'relative', '--cbtn-size': ROW_H,
          }}>
            {/* Play leads the run (user-directed 2026-09-26; the film's too).
                Never disabled: a track not on disk streams (playAlbumTracks
                marks it streamable), so an undownloaded album plays too. */}
            <button
              className="candy-btn"
              data-shape="chip"
              data-own-press
              onClick={playAll}
            ><span className="candy-face"><IconPlay size={14}/>Play</span></button>

            {/* Icon only, right after Play (user-directed 2026-09-26); the
                job's state (Queued, Downloading 3/11, Failed) is its tooltip,
                plus a bare 3/11 count on the face while it downloads. */}
            {album.providerId && (missing > 0 || dlJob) && (
              <button
                className="candy-btn"
                data-shape="chip"
                data-own-press
                onClick={startDownload}
                disabled={dlBusy}
                title={dlJob ? dlLabel : playable.length > 0 ? `Download the ${missing} missing track${missing === 1 ? '' : 's'}` : 'Download this album'}
              ><span className="candy-face"><IconDownload size={14}/>{dlJob?.state === 'downloading' && `${dlJob.trackIndex || 0}/${dlJob.trackTotal || '?'}`}</span></button>
            )}

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
                clears it, exactly as the dot strip did. 10 and 9 wear a
                trophy and a medal, the rest the star (user-directed 2026-09-26). */}
            <CandySelect icon={IconStar}
              value={album.personalRating ? String(album.personalRating) : ''}
              accent={accent}
              fuse shape="chip"
              title="Your rating out of 10"
              placeholder="Rate"
              options={Array.from({ length: 10 }, (_, n) => ({ value: String(10 - n), label: String(10 - n), dot: accent, icon: [IconTrophyStar, IconMedalStar][n] }))}
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

            {/* Add to Queue / Playlist, Reveal and Delete live in here, as Uninstall does on a film --
                the run stays short enough to fit the reading measure. */}
            <button
              type="button"
              className="candy-btn"
              data-shape="chip"
              data-own-press
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const items = [];
                // Always offered: off-disk tracks stream from the queue too.
                items.push({ label: 'Add to Queue', onClick: enqueueAlbum });
                const refs = album.tracks.map(t => refFromQueueItem({
                  albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                  artist: album.artist, wikilink: t.wikilink, audioPath: t.audioPath,
                  title: t.title, duration: t.duration,
                }));
                if (playlistMenu.canAdd(refs)) items.push({ label: 'Add to Playlist', children: playlistMenu.buildItems(refs) });
                if (album.trackFolder) items.push({
                  label: 'Reveal in files',
                  onClick: () => musicApi.revealInFiles(libraryAbs(album.trackFolder))
                    .catch(err => alert('Reveal failed: ' + err.message)),
                });
                items.push({ label: 'Delete album', onClick: onDelete });
                openContextMenu({ x: r.left, y: r.bottom + 4 }, items, { accent });
              }}
            >{/* The swatch, not a ⋯ (user-directed 2026-09-26), and its name,
                like Play (user-directed 2026-09-27). No tooltip: the name shows itself. */}
              <span className="candy-face"><IconSwatch size={14}/>More</span></button>
          </div>
          {/* The open tab follows the pointer by tabUnder, not by hit-test; the
              liquid follows [data-open] while the run is hovered (liquidHover.js).
              The updater form, so a swap not yet rendered is still `cur`. A pointer
              arriving (no hover yet) opens the tab under it: the names never shrink
              left to right, so that tab, opened, is still under it. */}
          <div className="candy-split"
            onPointerMove={(e) => {
              const run = e.currentTarget, x = e.clientX, px = lastX.current;
              const under = [...run.children].indexOf(e.target.closest('.candy-btn'));
              lastX.current = x;
              setHoverTab(h => h ? ALBUM_TABS[tabUnder(run, x, px ?? x, ALBUM_TABS.indexOf(h))] : ALBUM_TABS[under] ?? active);
            }}
            onPointerLeave={() => { setHoverTab(null); lastX.current = null; }}
            style={{ '--accent': accent || 'var(--accent)', '--cbtn-size': ROW_H }}>
            {ALBUM_TABS.map(t => {
              const Icon = TAB_ICON[t];
              return (
                <button
                  key={t}
                  type="button"
                  data-own-press
                  data-shape="chip"
                  className={'candy-btn' + (t === active ? ' is-active' : '')}
                  data-open={t === openTab ? '' : undefined}
                  onClick={() => setTab(t)}
                  aria-label={t}
                >{/* Icons, and ONE name: the picked tab's, or the hovered one's,
                    opening like a dock button (.split-label, user-directed
                    2026-09-27). No tooltip: the name shows itself. */}
                  <span className="candy-face"><Icon size={14}/><span className="split-label"><span>{t}</span></span></span></button>
              );
            })}
          </div>
          </div>

          {dlError && (
            <div style={{ fontSize: 11, color: 'var(--error)' }}>{dlError}</div>
          )}

          {/* Track list — grouped by disc when the album has more than one.
              It rides IN the right column, under the hairline, exactly where a
              film's Cast panel sits: same reading width as the title above it.
              Each row fills the column's width (uncapped, user-directed 2026-09-26). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {active === 'Credits' && <AlbumPerformers album={album} accent={accent} />}
        {/* Mounted with the page and only hidden, so switching tabs shows the
            last answer at once instead of re-asking and re-painting the covers
            (filmed 2026-09-26: a remount flashed "Loading albums" and blank
            tiles on every visit). */}
        <div hidden={active !== 'Discography'}><ArtistAlbums album={album} accent={accent} /></div>
        {active === 'Tracks' && (() => {
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
                  borderBottom: 'var(--candy-frame) solid var(--border)',
                }}>Disc {d}</div>
              )}
              {groups.get(d).map(({ t, idx }) => trackRow(t, idx))}
            </div>
          ));
        })()}
          </div>
          </div>
        </div>
        </div>
      </div>

      <ArtworkViewer lb={lb} art={art} accent={accent || 'var(--accent)'} />
      {songMenu.modalEl}
      {playlistMenu.modalEl}
    </div>
  );
}

// One row = ONE fused run (.candy-split, Component Map § Default Components)
// as wide as the column: the name half (number, name, length) plays and pauses,
// then World plays, Plays, Playlist, Queue, Video (user-directed 2026-09-26).
// Every part is ROW_H tall because the run declares --cbtn-size; nothing here
// restates a height.
function TrackRow({ track, plays, playsDigits, accent, playing, highlighted, onPlay, onEnqueue, onMenu, playlistRef, videoUrl, world, worldText, worldSizers }) {
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
      style={{
        display: 'flex', width: '100%',
        '--cbtn-size': ROW_H, '--accent': accent || 'var(--accent)',
      }}
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
          {/* The number turns into ▶ only where the hover's red has reached:
              the lit copy liquidHover.js clones wears [data-dock-hover], and
              library.css swaps the two there (user-directed 2026-09-26). Both
              share one grid cell, so the swap never shifts the name. */}
          <span className="track-n" style={{
            flexShrink: 0, fontVariantNumeric: 'tabular-nums', opacity: 0.7,
            display: 'inline-grid', justifyItems: 'center',
          }}>{playing ? '▶' : <>
            <span className="track-n-num" style={{ gridArea: '1 / 1' }}>{String(track.n).padStart(2, '0')}</span>
            <span className="track-n-play" style={{ gridArea: '1 / 1' }}>▶</span>
          </>}</span>

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

      {/* Worldwide plays on Last.fm (Last.fm World Plays plan, user-picked
          2026-09-26), right after the name (user-directed 2026-09-26). On
          every song so the parts line up: a grey dash while loading, with no
          key, or when Last.fm doesn't know the song -- the video part's
          disabled treatment. Opens the song's Last.fm page in the in-app
          browser. */}
      <button
        type="button"
        className="candy-btn"
        data-shape="chip"
        data-own-press
        aria-disabled={!world}
        onClick={() => { if (world?.url) window.location.hash = '/tools/browser/' + encodeURIComponent(world.url); }}
        title={world ? `${world.playcount.toLocaleString('en')} plays on Last.fm` : 'No Last.fm play count'}
        style={world ? undefined : { opacity: 1, cursor: 'default' }}
      ><span className="candy-face" style={world ? undefined : { color: 'var(--text-faint)' }}><IconAnnouncement size={14}/>
        <span style={{ display: 'inline-grid', justifyItems: 'end', fontVariantNumeric: 'tabular-nums' }}>
          {worldSizers.map(s => <span key={s} aria-hidden style={{ gridArea: '1 / 1', visibility: 'hidden' }}>{s}</span>)}
          <span style={{ gridArea: '1 / 1' }}>{worldText}</span>
        </span>
      </span></button>

      {/* Finished listens, its own part of the run (user-directed 2026-09-26,
          replacing a Plays tab), beside the world count. Shows only once the
          listen log is read, so the run never jumps from a guess. */}
      {plays != null && (
        <button
          type="button"
          className="candy-btn"
          data-shape="chip"
          data-own-press
          title={`Played ${plays} time${plays === 1 ? '' : 's'}`}
        ><span className="candy-face"><IconEarAlt size={14}/>
          <span style={{ minWidth: `${playsDigits}ch`, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{plays}</span>
        </span></button>
      )}

      {/* Its own half now, not a child of the row -- so it needs no
          stopPropagation to keep the row from playing under it. */}
      <AddToPlaylistButton
        variant="form"
        fuse
        icon={IconBookmarkPlus}
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
      ><span className="candy-face"><IconCopyPlus size={14}/></span></button>

      {/* On every song, so the parts line up down the list;
          greyed and inert when the song has no music video (user-directed
          2026-09-26). styles.css fades a disabled / aria-disabled candy button
          to 0.55, which paints a dark hole in the run (photographed
          2026-09-26), so only the icon greys: opacity is held at 1 here.
          Opens in the in-app browser, as a film trailer does (AnimeTrailer). */}
      <button
        type="button"
        className="candy-btn"
        data-shape="chip"
        data-own-press
        aria-disabled={!videoUrl}
        onClick={() => { if (videoUrl) window.location.hash = '/tools/browser/' + encodeURIComponent(videoUrl); }}
        title={videoUrl ? 'Watch the music video' : 'No music video found'}
        style={videoUrl ? undefined : { opacity: 1, cursor: 'default' }}
      ><span className="candy-face" style={videoUrl ? undefined : { color: 'var(--text-faint)' }}><IconCamcorder size={14}/></span></button>
    </div>
  );
}

// Every finished listen, counted per logged key. Read once per page, and again
// each time a song finishes (music-listen-recorded).
function usePlayCounts() {
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => musicApi.listenCounts()
      .then(c => { if (live) setCounts(c || {}); })
      .catch(() => { if (live) setCounts(c => c || {}); });
    load();
    window.addEventListener('music-listen-recorded', load);
    return () => { live = false; window.removeEventListener('music-listen-recorded', load); };
  }, []);
  return counts;
}

// Every key one album song's listens can be logged under (MusicPlayerProvider
// handleEnded): its file, the album page's `albumPath#n`, a playlist row's
// `albumPath|title` (that path has no .md), Browse's `rgMbid|disc|position`.
// Old playlist rows logged as `albumPath#<row>` without the .md are left out:
// the row number is not this song's.
// ponytail: assumes a card's n is the disc position Browse logs; if n counts
// across discs, Browse plays of disc 2+ miss. Map by position if that shows up.
export function playCount(counts, album, t) {
  const keys = new Set([
    t.audioPath,
    `${album.path}#${t.n}`,
    `${album.path.replace(/\.md$/, '')}|${t.title}`,
    album.providerId && `${album.providerId}|${t.disc || 1}|${t.n}`,
  ]);
  let n = 0;
  for (const k of keys) if (k) n += counts[k] || 0;
  return n;
}

// Every scanned picture of the record (front, back, booklet pages, disc...),
// from the edition with the most of them. Asked for only while the sleeve's
// viewer is open, so a page visit costs MusicBrainz nothing. The saved answer
// shows at once; a changed one repaints live (mbTick). Keyed to the album, so
// the viewer never lists the previous album's pictures.
function useAlbumArtwork(rgMbid) {
  const [art, setArt] = useState(null);
  const mbTick = useMbRefreshTick();
  useEffect(() => {
    if (!rgMbid) return;
    let live = true;
    musicApi.releaseArtwork(rgMbid)
      .then(r => { if (live && r) setArt({ ...r, rgMbid }); })
      .catch(() => {});
    return () => { live = false; };
  }, [rgMbid, mbTick]);
  return art && art.rgMbid === rgMbid ? art : null;
}

// The sleeve's lightbox, with every picture as a column of cover tiles on its
// right (user-picked 2026-09-26, replacing the Artwork tab). Only a front, or
// no MusicBrainz link: the plain big picture, no list. The lit tile is the one
// on show; the sleeve itself counts as the Front.
function ArtworkViewer({ lb, art, accent }) {
  const pics = art?.images || [];
  const shown = pics.findIndex(p => p.full === lb.src);
  const lit = shown >= 0 ? shown : pics.findIndex(p => p.kind === 'Front');
  const aside = pics.length > 1 && (
    // The music grid tile's width; the bottom pad keeps the last tile's ledge
    // inside the scroller.
    <div style={{ width: TILE_MIN, display: 'flex', flexDirection: 'column', gap: POSTER_COL_GAP, paddingBottom: POSTER_DEPTH }}>
      {pics.map((p, i) => (
        <ArtThumb key={p.id} releaseMbid={art.releaseMbid} pic={p} accent={accent}
          active={i === lit} onPick={() => lb.show(p.full, p.kind)} />
      ))}
    </div>
  );
  return <ImageLightbox {...lb} accent={accent} aside={aside} />;
}

function ArtThumb({ releaseMbid, pic, accent, active, onPick }) {
  const path = useCaaCover('release', releaseMbid, 250, pic.id);
  return (
    <PosterTile image={path ? coverSrc(path) : null} title={pic.kind.toLowerCase()}
      accent={accent} aspect="1 / 1" onClick={onPick} active={active} />
  );
}

// Letters and digits only, lowercased: "Tyler, The Creator" matches the
// uploader "TylerTheCreatorVEVO" and "Paranoid Android" the title
// "Radiohead - Paranoid Android (Official Video)".
const squash = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// A search for the record turns up fan uploads and other albums' songs. Keep a
// hit only when the artist's own channel posted it (not the "- Topic" channel,
// which is sound over the cover) and its title names one of THIS album's songs.
// Longest song name wins, so a "Karma Police" video is never handed to a song
// called "Police"; first video per song. Returns { squash(song title): watchUrl }.
export function trackVideos(hits, album) {
  const artist = squash(album.artist);
  const names = album.tracks.map(t => squash(t.title))
    .filter(n => n.length >= 3 && n !== artist)
    .sort((a, b) => b.length - a.length);
  const out = {};
  if (!artist) return out;
  for (const h of hits || []) {
    const up = String(h.uploader || '');
    if (/ - topic$/i.test(up) || !squash(up).includes(artist)) continue;
    const name = names.find(n => squash(h.title).includes(n));
    if (name && !out[name]) out[name] = h.watchUrl;
  }
  return out;
}

// Which songs have a music video: one YouTube search per album visit (~2 s).
// The last answer is kept in localStorage, so the buttons show at once and
// the rows repaint if the new search differs.
// ponytail: one search, so a long album can miss some songs' videos; search
// per track if that turns out to matter.
function useTrackVideos(album) {
  const key = album ? 'music:trackVideos:' + album.path : null;
  const [videos, setVideos] = useState({});
  useEffect(() => {
    if (!key || !album.artist || !album.title) { setVideos({}); return; }
    try { setVideos(JSON.parse(localStorage.getItem(key)) || {}); } catch { setVideos({}); }
    let live = true;
    musicApi.searchYoutube(`${album.artist} ${album.title} official video`, 20)
      .then(r => {
        const found = trackVideos(r, album);
        try { localStorage.setItem(key, JSON.stringify(found)); } catch {}
        if (live) setVideos(found);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [key, album?.artist, album?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  return videos;
}

// 12.4M, 34K, 812 (user-picked 2026-09-26); the exact number is the hover.
const compactPlays = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

// Each song's worldwide play count on Last.fm (the user's own key, Settings >
// Library > Music), kept the video part's way: the last answer per album sits
// in localStorage so the numbers show at once, then every song is asked again,
// one at a time, and repaints as its answer lands. Returns
// { squash(song title): { playcount, url } }; a song Last.fm doesn't know, or
// no key, stays absent (a grey dash).
function useWorldPlays(album) {
  const key = album ? 'music:worldPlays:' + album.path : null;
  const [world, setWorld] = useState({});
  useEffect(() => {
    let next = {};
    if (key) try { next = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
    setWorld(next);
    if (!key || !album.artist) return;
    let live = true;
    (async () => {
      if (!(await musicApi.lastfmHasApiKey().catch(() => false))) return;
      for (const t of album.tracks) {
        const r = await musicApi.lastfmTrackPlays(album.artist, t.title).catch(() => undefined);
        if (!live) return;
        if (r === undefined) continue; // no answer this time: keep the saved number
        next = { ...next };
        if (r) next[squash(t.title)] = r; else delete next[squash(t.title)];
        setWorld(next);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
        // ponytail: a fixed gap keeps one album under Last.fm's ~5 calls/s; move
        // it to a shared gate in lastfm.rs if two pages ever ask at once.
        await new Promise(res => setTimeout(res, 200));
      }
    })();
    return () => { live = false; };
  }, [key, album?.artist]); // eslint-disable-line react-hooks/exhaustive-deps
  return world;
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
