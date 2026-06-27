// RIGHT pane of the Music page. Big cover, metadata, Play All, Mark-as-
// Listened, tracklist with per-row play / open-page / add-to-queue actions.

import { useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { IconFolder } from '@host/components/icons.jsx';
import StatusDropdown from '@host/components/ui/StatusDropdown.jsx';
import { libraryAbs } from '@host/api.js';
import { coverSrc, STATUS_DOT_COLOR, resolveDot } from './util.js';
import AddToPlaylistButton from './AddToPlaylistButton.jsx';
import { refFromQueueItem } from './PlaylistProvider.jsx';
import MusicCredits from './MusicCredits.jsx';
import MusicNotes from './MusicNotes.jsx';
import { useDownloads } from './DownloadProvider.jsx';

const LISTEN_STATUSES = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

// Recessed candy tray: the header reads as a pressed-in surface (inset shadow)
// whose floor carries a faint wash of the cover's dominant color. useCoverTint
// downsamples the cover to a single averaged pixel for that clean tint; returns
// null on any canvas/CORS failure, in which case the tray leans on an accent wash.
function useCoverTint(src) {
  const [tint, setTint] = useState(null);
  useEffect(() => {
    if (!src) { setTint(null); return; }
    let cancelled = false;
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(im, 0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        if (!cancelled) setTint(`rgb(${r}, ${g}, ${b})`);
      } catch { if (!cancelled) setTint(null); }
    };
    im.onerror = () => { if (!cancelled) setTint(null); };
    im.src = src;
    return () => { cancelled = true; };
  }, [src]);
  return tint;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function navigate(p) {
  window.location.hash = p;
}

export default function AlbumDetail({ accent, albumPath }) {
  const [album, setAlbum] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { playAlbumTracks, enqueue, currentTrack, isPlaying } = useMusicPlayer();
  const { jobs: dlJobs, enqueue: enqueueDownload } = useDownloads();
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

  const coverImgSrc = album ? coverSrc(album.image, 400) : null;
  const tint = useCoverTint(coverImgSrc);

  if (loading) return <Centered>Loading…</Centered>;
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
        case 'queued': return 'Queued…';
        case 'downloading': return `Downloading ${dlJob.trackIndex || 0}/${dlJob.trackTotal || '?'}…`;
        case 'done': return 'Downloaded ✓';
        case 'error': return 'Failed — retry';
        case 'cancelled': return 'Cancelled — retry';
        default: return 'Download';
      }
    }
    return playable.length > 0 ? `Repair · ${missing} missing` : 'Download';
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
  const playFrom = (idx) => playAlbumTracks(album, idx);

  const enqueueAlbum = () => {
    const items = album.tracks.filter(t => t.available).map(t => ({
      albumPath: album.path, albumTitle: album.title, albumImage: album.image,
      artist: album.artist,
      n: t.n, title: t.title, audioPath: t.audioPath,
      available: true, wikilink: t.wikilink, duration: t.duration,
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
      {/* Header: cover + meta */}
      <div style={{
        position: 'relative',
        display: 'flex', gap: 28,
        padding: '32px 28px 26px',
        borderBottom: '1px solid var(--border)',
        background: 'color-mix(in oklch, var(--surface), black 8%)',
        boxShadow: 'inset 0 3px 7px rgba(0,0,0,0.30), inset 0 -1px 0 rgba(255,255,255,0.03)',
      }}>
        {/* Recessed-tray floor: a clean wash of the cover's averaged color
            (falls back to a faint accent wash when extraction is unavailable). */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0,
          background: tint || (accent ? `color-mix(in oklch, ${accent} 60%, transparent)` : 'transparent'),
          opacity: tint ? 0.16 : 0.06,
          pointerEvents: 'none',
          zIndex: 0,
        }}/>
        {/* LEFT column: cover + metadata stacked beneath it */}
        <div style={{
          position: 'relative', zIndex: 1,
          width: 240, flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div style={{
            width: 180, aspectRatio: '1 / 1', flexShrink: 0,
            alignSelf: 'flex-start',
            background: 'var(--surface-2)',
            borderRadius: 8, overflow: 'hidden',
            boxShadow: '0 10px 32px rgba(0,0,0,0.34)',
          }}>
            {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>}
          </div>

          {/* Stat tiles */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { label: 'Year', value: album.year },
              { label: 'Tracks', value: album.tracks.length || null },
              { label: 'Length', value: album.length },
            ].filter(s => s.value).map(s => (
              <div key={s.label} style={{
                padding: '7px 14px', borderRadius: 8,
                background: 'var(--surface-2)',
                display: 'flex', flexDirection: 'column',
                gap: 2, minWidth: 64,
              }}>
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'var(--text-faint)',
                }}>{s.label}</span>
                <span style={{
                  fontSize: 15, fontWeight: 600, color: 'var(--text)',
                  fontVariantNumeric: 'tabular-nums',
                }}>{s.value}</span>
              </div>
            ))}
          </div>

          {/* Genre chips */}
          {(album.genres && album.genres.length > 0) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {album.genres.slice(0, 6).map(g => (
                <span key={g} style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
                  textTransform: 'uppercase', color: 'var(--text-muted)',
                  padding: '2px 8px', borderRadius: 999,
                  border: '1px solid var(--border)',
                }}>{g}</span>
              ))}
            </div>
          )}

          {/* Personal rating */}
          <RatingStrip
            stacked
            value={album.personalRating || 0}
            accent={accent}
            disabled={busy}
            onChange={(r) => {
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
        </div>
        <div style={{
          position: 'relative', zIndex: 1,
          flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          {/* Type tag */}
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>{album.releaseType || 'Album'}</div>

          {/* Title */}
          <h2 style={{
            margin: 0, fontSize: 30, fontWeight: 700,
            color: 'var(--text)', lineHeight: 1.12,
            letterSpacing: '-0.015em',
          }}>
            {album.title}
          </h2>

          {/* Artist caption */}
          {album.artist && (
            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: -6 }}>
              {album.artist}
            </div>
          )}

          {/* Action row */}
          <div style={{
            display: 'flex', gap: 10, marginTop: 6,
            alignItems: 'center', flexWrap: 'wrap',
          }}>
            <button
              className="candy-btn is-primary"
              data-own-press
              onClick={playAll}
              disabled={playable.length === 0}
              style={{
                height: 36,
                opacity: playable.length === 0 ? 0.4 : 1,
                cursor: playable.length === 0 ? 'not-allowed' : 'pointer',
                ...(playable.length === 0 ? { pointerEvents: 'none', boxShadow: 'none' } : {}),
              }}
            ><span className="candy-face" style={{ padding: '0 18px' }}>Play All</span></button>

            <button
              className="candy-btn"
              data-own-press
              onClick={enqueueAlbum}
              disabled={playable.length === 0}
              style={{
                height: 36,
                opacity: playable.length === 0 ? 0.4 : 1,
                cursor: playable.length === 0 ? 'not-allowed' : 'pointer',
                ...(playable.length === 0 ? { pointerEvents: 'none', boxShadow: 'none' } : {}),
              }}
            ><span className="candy-face" style={{ padding: '0 18px' }}>+ Queue</span></button>

            <AddToPlaylistButton
              variant="form"
              accent={accent}
              title="Add all tracks to a playlist"
              refs={playable.map(t => refFromQueueItem({
                albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                artist: album.artist, wikilink: t.wikilink, audioPath: t.audioPath,
                title: t.title, duration: t.duration,
              }))}
            />

            <StatusDropdown
              value={album.status || ''}
              accent={accent}
              title="Mark status"
              placeholder="Status…"
              statuses={LISTEN_STATUSES}
              disabled={busy}
              dotFor={(s) => resolveDot(STATUS_DOT_COLOR, s, accent)}
              onChange={setStatus}
            />

            {album.providerId && (missing > 0 || dlJob) && (
              <button
                className={'candy-btn' + (playable.length === 0 ? ' is-primary' : '')}
                data-own-press
                onClick={startDownload}
                disabled={dlBusy}
                title={playable.length > 0 ? `Download the ${missing} missing track${missing === 1 ? '' : 's'}` : 'Download this album'}
                style={{ height: 36, opacity: dlBusy ? 0.6 : 1 }}
              ><span className="candy-face" style={{ padding: '0 18px' }}>{dlLabel}</span></button>
            )}

            {album.trackFolder && (
              <button
                className="candy-btn"
                data-own-press
                onClick={() => musicApi.revealInFiles(libraryAbs(album.trackFolder)).catch(err => alert('Reveal failed: ' + err.message))}
                title={`Reveal "${album.trackFolder}" in file manager`}
                style={{ width: 36, height: 36, borderRadius: 8 }}
              ><span className="candy-face" style={{ padding: 0 }}><IconFolder size={16}/></span></button>
            )}

            <button
              className="candy-btn is-danger"
              data-own-press
              onClick={onDelete}
              disabled={busy}
              title="Delete album → recycling bin"
              style={{ height: 36, opacity: busy ? 0.5 : 1 }}
            ><span className="candy-face" style={{ padding: '0 16px' }}>Delete</span></button>
          </div>

          {dlError && (
            <div style={{ fontSize: 11, color: 'var(--error)' }}>{dlError}</div>
          )}
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
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-faint)',
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
                    playlistRef={playlistRef}
                    playing={playingThis && isPlaying}
                    onPlay={() => playFrom(idx)}
                    onEnqueue={() => {
                      if (!t.available) return;
                      enqueue([{
                        albumPath: album.path, albumTitle: album.title, albumImage: album.image,
                        artist: album.artist,
                        n: t.n, title: t.title, audioPath: t.audioPath,
                        available: true, wikilink: t.wikilink, duration: t.duration,
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
    </div>
  );
}

function TrackRow({ track, idx, accent, playing, onPlay, onEnqueue, playlistRef }) {
  const [hover, setHover] = useState(false);
  const unavailable = !track.available;
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
      className={'candy-btn' + (playing ? ' is-playing' : '') + (unavailable ? ' is-unavailable' : '')}
      data-shape="track"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => !unavailable && onPlay()}
      title={unavailable ? 'audio not downloaded' : ''}
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
      {!unavailable && (
        <HoverBtn hover={hover} playing={playing} title="Add to queue" onClick={(e) => { e.stopPropagation(); onEnqueue(); }}>+</HoverBtn>
      )}

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
  const base = playing ? 'rgba(255,255,255,0.7)' : 'var(--text-faint)';
  const lit = playing ? 'white' : 'var(--text)';
  const litBg = playing ? 'rgba(255,255,255,0.18)' : 'var(--surface-2)';
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

function RatingStrip({ value, accent, disabled, stacked, onChange }) {
  const [hover, setHover] = useState(0);
  const display = hover || value || 0;
  const fill = accent || 'var(--accent)';
  const starsRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => {
          const filled = n <= display;
          return (
            <button
              key={n}
              type="button"
              data-own-press
              disabled={disabled}
              onMouseEnter={() => setHover(n)}
              onClick={() => onChange(n === value ? 0 : n)}
              aria-label={`Rate ${n} out of 10`}
              title={`${n}/10`}
              className={'candy-btn' + (filled ? ' is-filled' : '')}
              data-shape="dot"
              style={{ '--accent': fill }}
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
  return (
    <div
      onMouseLeave={() => setHover(0)}
      style={stacked
        ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }
        : { display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 }}
    >
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)',
      }}>Personal</span>
      {starsRow}
    </div>
  );
}

// StatusDropdown moved to @host/components/ui/StatusDropdown.jsx (shared with the
// video module). Imported at the top of this file.
