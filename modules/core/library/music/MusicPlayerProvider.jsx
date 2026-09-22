// Single source of truth for music playback. One <audio> element is owned by
// this provider and never unmounts on route change, so playback survives
// navigation. Everything visual (the bar, queue panel, album detail) reads
// from this context.

import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { mediaUrl, mediaHttpUrl, streamHttpUrl, awaitMediaBaseUrl, invoke } from '@host/api.js';
import { musicApi } from './api.js';
import { trackToQueueItem } from './util.js';

const Ctx = createContext(null);

// localStorage keys
const LS = {
  volume:  'music:volume',
  shuffle: 'music:shuffle',
  repeat:  'music:repeat', // 'off' | 'all' | 'one'
  last:    'music:last',    // { albumPath, trackIndex, position }
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// SF12 (2026-05-24): WebKitGTK rejects custom URI schemes
// (mortar-pestle-asset://) in HTMLMediaElement. The Rust side runs a loopback
// axum server on a kernel-assigned 127.0.0.1 port; mediaHttpUrl returns the
// http:// URL that WebKit accepts.
function audioSrcFor(audioPath) {
  // Catalog audio lives in the Library vault, resolved against its root.
  return audioPath ? mediaHttpUrl(audioPath, { library: true }) : null;
}

// Surface play() rejections so a future audio bug isn't invisible. Console line
// names the track + resolved src (which differs between browser-tab dev and the
// Tauri shell — `mortar-pestle-asset://` vs `/api/file/`); the dispatched event is
// what MusicErrorToast renders.
function emitPlayError(track, err) {
  const msg = err?.message || String(err);
  console.warn('[music] play() rejected:', track?.title, '—', msg, '\nsrc:', audioSrcFor(track?.audioPath));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('agentic:music-play-error', {
      detail: { title: track?.title || 'track', message: msg },
    }));
  }
}

export function MusicPlayerProvider({ children }) {
  const audioRef = useRef(null);
  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    // crossOrigin is set in the sync effect below, never here — it only takes
    // effect if set immediately before .src. Both source kinds now go through
    // the loopback media server, so both load 'anonymous'.
    audioRef.current.preload = 'metadata';
  }

  // Web Audio analyser. Lazily created on first `getAnalyser()` call so we
  // don't break headless tests / iframe contexts that have no AudioContext.
  // Single MediaElementAudioSourceNode per <audio> (browsers reject a second
  // createMediaElementSource on the same element), so callers share the same
  // analyser instance.
  const audioContextRef = useRef(null);
  const sourceNodeRef   = useRef(null);
  const analyserRef     = useRef(null);
  // Loudness moves onto a GainNode placed AFTER the analyser the moment the
  // graph exists. `<audio>.volume` is applied inside the element, i.e. upstream
  // of the source node, so leaving it there scaled the meter with the knob —
  // the tile's bars showed speaker loudness, not the track's.
  const gainNodeRef     = useRef(null);
  const getAnalyser = useCallback(() => {
    if (analyserRef.current) return analyserRef.current;
    const a = audioRef.current;
    if (!a) return null;
    const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) return null;
    try {
      if (!audioContextRef.current) audioContextRef.current = new AC();
      const ctx = audioContextRef.current;
      // Browser autoplay policy creates AudioContexts in `suspended` state.
      // Once `createMediaElementSource` reroutes the <audio> element through
      // the graph, a suspended context = silent output. Resume is idempotent
      // on a running context.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (!sourceNodeRef.current) sourceNodeRef.current = ctx.createMediaElementSource(a);
      const analyser = ctx.createAnalyser();
      // 256 → 128 bins. The sidebar tile paints 36 bars and 64 (= 32 bins)
      // couldn't feed them; the 9-bar rails reduce across all 128 the same way
      // they did across 32.
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      // Seed the gain from the element's own current value rather than
      // restating the curve — whatever the knob last applied is already there.
      const gain = ctx.createGain();
      gain.gain.value = a.volume;
      sourceNodeRef.current.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      analyserRef.current = analyser;
      gainNodeRef.current = gain;
      a.volume = 1; // last — a throw above must leave the element's own volume intact
      return analyser;
    } catch (e) {
      console.warn('[music] getAnalyser failed', e);
      return null;
    }
  }, []);
  // Resume suspended AudioContext when playback starts (autoplay policy
  // requires a user gesture to start audio in WebKitGTK).
  useEffect(() => {
    const ctx = audioContextRef.current;
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
  }, []);

  // Queue is an array of { albumPath, albumTitle, albumImage, artist, n, title, audioPath, available, wikilink, duration }.
  const [queue, setQueue] = useState([]);
  // Index into the queue (the currently selected / loaded track).
  const [index, setIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(() => {
    const v = loadJSON(LS.volume, 0.8);
    return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 0.8;
  });
  const [shuffle, setShuffle] = useState(() => !!loadJSON(LS.shuffle, false));
  const [repeat, setRepeat] = useState(() => {
    const r = loadJSON(LS.repeat, 'off');
    return ['off', 'all', 'one'].includes(r) ? r : 'off';
  });
  // Aggregated minutes listened in the current calendar month. Seeded from
  // disk on mount via `music_listen_minutes_for_month`; bumped locally on
  // every 'ended' event so the rail stat updates without a re-fetch.
  const [listenMinutesThisMonth, setListenMinutesThisMonth] = useState(null);
  useEffect(() => {
    const month = new Date().toISOString().slice(0, 7);
    invoke('music_listen_minutes_for_month', { month })
      .then(m => setListenMinutesThisMonth(typeof m === 'number' ? m : 0))
      .catch(() => setListenMinutesThisMonth(0));
  }, []);

  // Shuffle order is a permutation of indices into `queue`. Computed lazily.
  const shuffleOrderRef = useRef(null);
  const shufflePosRef = useRef(0);

  // Force a re-render once the loopback media server port is known so
  // audioSrcFor() can produce a non-null URL for tracks selected before the
  // port was ready. The tick is also a dep of the src-sync effect below: a
  // re-render alone left `a.src` empty for the restored track, so toggle()'s
  // `!a?.src` guard swallowed the first press of play after every app start.
  const [mediaReadyTick, _setMediaReadyTick] = useState(0);
  useEffect(() => {
    const onReady = () => _setMediaReadyTick((n) => n + 1);
    window.addEventListener('agentic:media-server-ready', onReady);
    awaitMediaBaseUrl().then(onReady).catch(() => {});
    return () => window.removeEventListener('agentic:media-server-ready', onReady);
  }, []);

  const currentTrack = index >= 0 && index < queue.length ? queue[index] : null;

  // ── Streaming (not-downloaded tracks) ────────────────────────────────────
  // A queue item with no audio on disk but album metadata (`streamable`) plays
  // via a fresh googlevideo URL from `music_stream_resolve` — resolved per
  // play, never persisted (the URLs are IP + time-bound). Resolve failures are
  // remembered for the session so skip logic walks past them.
  const failedStreamsRef = useRef(new Set());
  const [resolvingStream, setResolvingStream] = useState(false);
  const resolveSeqRef = useRef(0);
  const streamSrcKeyRef = useRef(null); // stream key currently loaded in <audio>
  // Loose YouTube hits carry no album card, so albumPath|n would be "null|null"
  // for every one of them — key those by their watch URL instead.
  // A Browse-preview track has no album card either, so albumPath|n would be
  // "null|3" for every one of them too — those carry their own streamKey.
  const streamKeyOf = (t) => (t ? (t.watchUrl || t.streamKey || `${t.albumPath}|${t.n}`) : '');

  // Which shape `music_stream_resolve` gets: an exact YouTube upload, a library
  // album card (cached watch URL + writeback), or bare MusicBrainz metadata.
  const streamResolveArgs = (t) =>
    t.watchUrl ? { watchUrl: t.watchUrl }
      : t.albumPath ? { albumPath: t.albumPath, n: t.n }
        : { artist: t.artist, albumTitle: t.albumTitle, trackTitle: t.title,
            durationSec: t.duration || 0 };
  const isPlayable = (t) =>
    !!t && (t.available || (t.streamable && !failedStreamsRef.current.has(streamKeyOf(t))));

  // Wire <audio> element to React state. Human hearing is logarithmic, so we
  // apply a perceptual curve (cubic) — the slider stays linear 0-1 visually
  // but the actual gain ramps up gently at the bottom and aggressively at the
  // top, matching how loudness is perceived.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const gain = Math.pow(volume, 3);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = gain;
      a.volume = 1;
    } else {
      a.volume = gain; // no WebAudio graph yet — the element is the only knob
    }
  }, [volume]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setPosition(a.currentTime);
    const onDur  = () => setDuration(a.duration || 0);
    const onPlay = () => {
      setIsPlaying(true);
      const ctx = audioContextRef.current;
      if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => handleEnded();
    // MediaError on the element fires for codec / decode / network / src
    // failures separately from play() rejection — surface both so the toast
    // names the precise failure class instead of generic "operation not
    // supported".
    const onError = () => {
      // Tearing a stream down is `removeAttribute('src') + load()` (pausing a
      // stream, or selecting nothing) — and a media element with no source ALWAYS
      // errors, code 4, message "MEDIA_ELEMENT_ERROR: Format error". That is our
      // own teardown talking, not a failed track, and toasting it named a song
      // that had just played fine (user-reported 2026-09-16).
      if (!a.getAttribute('src') && !a.currentSrc) return;
      const err = a.error;
      const codeMap = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src not supported' };
      const cls = codeMap[err?.code] || `code ${err?.code}`;
      const msg = err?.message ? `${cls}: ${err.message}` : cls;
      // EVIDENCE, NOT A FIX (2026-09-20). Two failures were reported on a track
      // whose file AND the loopback media server both tested clean afterwards
      // (ffprobe: valid Ogg/Opus; a live range request: 206, audio/ogg, full
      // length), so the error string alone cannot name the cause. Ask the server
      // what it says about THIS url at the moment of the failure: a 403/404 means
      // the port or token the element is still holding went stale under it, and a
      // 206 means delivery was fine and the fault is above it in the decoder.
      // The answer rides the toast so it survives without DevTools open.
      const src = a.currentSrc || a.getAttribute('src');
      fetch(src, { headers: { Range: 'bytes=0-0' } })
        .then(r => `server ${r.status}`)
        .catch(e => `server unreachable: ${e}`)
        .then(probe => emitPlayError(currentTrack, { message: `${msg} — ${probe}` }));
      setIsPlaying(false);
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('durationchange', onDur);
    a.addEventListener('loadedmetadata', onDur);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('durationchange', onDur);
      a.removeEventListener('loadedmetadata', onDur);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, index, repeat, shuffle]);

  // Persist last-played track + position periodically. Loose YouTube hits have
  // no album card to restore from, so they're skipped rather than blanking the
  // last real album (the restore below keys entirely on albumPath).
  useEffect(() => {
    if (!currentTrack || !currentTrack.albumPath) return;
    const persist = () => {
      const a = audioRef.current;
      // readyState 0 = nothing loaded, so currentTime is a meaningless 0. On a
      // fresh start this effect runs before the restore below has seeked, and
      // persisting that 0 wiped the very position we were about to restore.
      if (!a || a.readyState === 0) return;
      saveJSON(LS.last, {
        albumPath: currentTrack.albumPath,
        trackIndex: index,
        position: a.currentTime,
      });
    };
    // `isPlaying` is a dep purely so pausing re-runs this effect and persists
    // immediately — on the 3s interval alone, pausing then closing the app
    // inside that window lost up to 3 seconds of position.
    persist();
    const interval = setInterval(persist, 3000);
    return () => clearInterval(interval);
  }, [currentTrack, index, isPlaying]);

  // On mount, restore the last-played track into the queue (paused) so the
  // sidebar music slot shows it instead of an empty placeholder.
  useEffect(() => {
    const last = loadJSON(LS.last, null);
    if (!last || !last.albumPath) return;
    let cancelled = false;
    // A playlist row persists the PLAYLIST's path (trackToQueueItem falls back
    // to pl.path when the row has no album card), and music_read_album answers
    // a playlist path with a real card carrying ZERO tracks — so reading every
    // last-played source as an album silently emptied the queue and blanked the
    // player. Route on the path, and never let a trackless card clear the queue.
    const isPlaylist = last.albumPath.startsWith('Music/Playlists/');
    const read = isPlaylist
      ? musicApi.readPlaylist(last.albumPath)
      : musicApi.readAlbum(last.albumPath);
    read
      .catch(() => null)
      .then(card => {
        if (cancelled || !card || !card.tracks || !card.tracks.length) return;
        const items = isPlaylist
          ? card.tracks.map(t => trackToQueueItem(t, { ...card, path: card.path || last.albumPath }))
          : card.tracks.map(t => ({
              albumPath:  card.albumPagePath || last.albumPath,
              albumTitle: card.title,
              albumImage: card.image,
              artist:     card.artist,
              n:          t.n,
              title:      t.title,
              audioPath:  t.audioPath,
              available:  t.available,
              streamable: !t.available,
              wikilink:   t.wikilink,
              duration:   t.duration,
            }));
        const start = Math.min(Math.max(0, last.trackIndex || 0), items.length - 1);
        setQueue(items);
        setIndex(start);
        // Seek to last position once metadata loads (kept paused).
        const a = audioRef.current;
        if (a && last.position) {
          const onMeta = () => {
            try { a.currentTime = last.position; } catch {}
            a.removeEventListener('loadedmetadata', onMeta);
          };
          a.addEventListener('loadedmetadata', onMeta);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync <audio> element to (currentTrack, isPlaying). This is the only place
  // src / load / play / pause are touched from the React side — actions just
  // set state and the effect reconciles. Avoids the prior race where a
  // setTimeout(0) play() ran outside the user gesture and was silently
  // rejected by the autoplay policy.
  // Local files keep the original synchronous path; streamable tracks resolve
  // a fresh stream URL first, so their branch is async with a stale-guard.
  const currentTrackKey = currentTrack
    ? `${currentTrack.albumPath}|${currentTrack.n}|${currentTrack.audioPath || ''}` +
      `|${currentTrack.watchUrl || currentTrack.streamKey || ''}`
    : '';
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    // Local file on disk — synchronous, unchanged.
    if (currentTrack?.audioPath) {
      streamSrcKeyRef.current = null;
      setResolvingStream(false);
      const want = audioSrcFor(currentTrack.audioPath);
      // Null = the loopback port or the Library root isn't known yet. Assigning it
      // makes the element load the literal string "null" against the page origin,
      // which 404s and surfaces as MEDIA_ERR_SRC_NOT_SUPPORTED on a healthy file.
      // Both roots fire 'agentic:media-server-ready' when they land, and that bumps
      // mediaReadyTick (a dep of this effect), so this re-runs with a real URL.
      if (!want) return;
      // Without a CORS fetch the media is never "CORS-approved", so
      // createMediaElementSource legally feeds the graph digital silence — the
      // analyser reads zeros AND the user hears nothing, since the graph is the
      // output path once the source node exists. The loopback media server
      // answers with Access-Control-Allow-Origin: * (media_server.rs), so
      // asking costs nothing here. Must be set before .src.
      if (a.src !== want || a.crossOrigin !== 'anonymous') {
        a.crossOrigin = 'anonymous';
        a.src = want;
        a.load();
      }
      if (isPlaying && a.paused) {
        a.play().catch(err => emitPlayError(currentTrack, err));
      } else if (!isPlaying && !a.paused) {
        a.pause();
      }
      return;
    }

    // Streamable, no file — resolve, then feed the element.
    if (currentTrack?.streamable) {
      const key = streamKeyOf(currentTrack);
      if (streamSrcKeyRef.current === key && a.src) {
        // Already resolved + loaded (pause/resume of the same stream track).
        if (isPlaying && a.paused) a.play().catch(err => emitPlayError(currentTrack, err));
        else if (!isPlaying && !a.paused) a.pause();
        return;
      }
      if (!isPlaying) {
        // Selected but paused — don't resolve yet; drop any stale audio.
        if (streamSrcKeyRef.current !== null || a.src) {
          streamSrcKeyRef.current = null;
          if (!a.paused) a.pause();
          a.removeAttribute('src');
          a.load();
        }
        return;
      }
      const seq = ++resolveSeqRef.current;
      setResolvingStream(true);
      invoke('music_stream_resolve', streamResolveArgs(currentTrack))
        .then(async res => {
          if (seq !== resolveSeqRef.current) return; // track changed mid-resolve
          // googlevideo sends no Access-Control-Allow-Origin, so the URL can't be
          // loaded CORS-approved directly — and loading it un-approved makes
          // createMediaElementSource feed the graph silence, which is the only
          // output path once the graph exists (track advances, nothing audible).
          // Relay it through the loopback media server, which does send ACAO.
          await awaitMediaBaseUrl();
          if (seq !== resolveSeqRef.current) return; // and again after the await
          const want = streamHttpUrl(res.streamUrl) || res.streamUrl;
          setResolvingStream(false);
          streamSrcKeyRef.current = key;
          a.crossOrigin = 'anonymous';
          a.src = want;
          a.load();
          a.play().catch(err => emitPlayError(currentTrack, err));
        })
        .catch(err => {
          if (seq !== resolveSeqRef.current) return;
          setResolvingStream(false);
          emitPlayError(currentTrack, { message: String(err) });
          failedStreamsRef.current.add(key);
          // Decision: toast + skip to the next playable song.
          const nxt = nextIndexFrom(index);
          const playable = nxt < 0 ? -1 : skipUnavailable(nxt, +1);
          if (playable < 0 || playable === index) { setIsPlaying(false); return; }
          setIndex(playable);
        });
      return;
    }

    // Nothing playable selected.
    if (!a.paused) a.pause();
    a.removeAttribute('src');
    a.load();
    streamSrcKeyRef.current = null;
    setResolvingStream(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey, isPlaying, index, mediaReadyTick]);

  // Build a shuffle order whenever the queue changes (or shuffle is toggled
  // on). Only the available tracks participate; missing-audio tracks are
  // skipped naturally because their next() ignores them.
  useEffect(() => {
    if (!shuffle) { shuffleOrderRef.current = null; return; }
    const order = queue.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Put the current track first in the shuffle order so we don't jump away.
    if (index >= 0) {
      const cur = order.indexOf(index);
      if (cur > 0) [order[0], order[cur]] = [order[cur], order[0]];
    }
    shuffleOrderRef.current = order;
    shufflePosRef.current = 0;
  }, [shuffle, queue.length]); // intentional: don't reshuffle on every index change

  function nextIndexFrom(curIdx) {
    if (queue.length === 0) return -1;
    if (repeat === 'one' && curIdx >= 0) return curIdx;
    if (shuffle && shuffleOrderRef.current) {
      const order = shuffleOrderRef.current;
      const pos = order.indexOf(curIdx);
      let next = pos + 1;
      if (next >= order.length) {
        if (repeat === 'all') next = 0;
        else return -1;
      }
      return order[next];
    }
    let next = curIdx + 1;
    if (next >= queue.length) {
      if (repeat === 'all') next = 0;
      else return -1;
    }
    return next;
  }

  function prevIndexFrom(curIdx) {
    if (queue.length === 0) return -1;
    if (shuffle && shuffleOrderRef.current) {
      const order = shuffleOrderRef.current;
      const pos = order.indexOf(curIdx);
      const prev = pos - 1;
      if (prev < 0) return curIdx; // can't go back from first shuffled
      return order[prev];
    }
    return curIdx > 0 ? curIdx - 1 : 0;
  }

  function skipUnavailable(start, dir) {
    // Walk in given direction until we hit a playable track (on disk or
    // streamable) or loop back.
    let i = start;
    const seen = new Set();
    while (i >= 0 && !seen.has(i)) {
      seen.add(i);
      if (isPlayable(queue[i])) return i;
      i = dir > 0 ? nextIndexFrom(i) : prevIndexFrom(i);
      if (i < 0) return -1;
    }
    return -1;
  }

  const handleEnded = useCallback(() => {
    // Record the completed listen before queue advancement. Skip when the
    // track has no usable duration (some MusicBrainz entries omit it).
    // Streamed listens count too (decision 6) — logged under a stable
    // `albumPath#n` key since there's no file on disk.
    const ended = queue[index];
    if ((ended?.audioPath || ended?.streamable)
        && typeof ended.duration === 'number' && ended.duration >= 1) {
      const secs = Math.round(ended.duration);
      const trackPath = ended.audioPath || ended.streamKey || `${ended.albumPath}#${ended.n}`;
      invoke('music_record_listen', { trackPath, durationSec: secs })
        .catch(err => console.warn('[music] record_listen failed', err));
      setListenMinutesThisMonth(prev => (prev ?? 0) + secs / 60);
    }
    const nxt = nextIndexFrom(index);
    if (nxt < 0) { setIsPlaying(false); return; }
    const playable = skipUnavailable(nxt, +1);
    if (playable < 0) { setIsPlaying(false); return; }
    setIndex(playable);
    setIsPlaying(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue, repeat, shuffle]);

  // ── Actions ────────────────────────────────────────────────────────────
  const playAlbumTracks = useCallback((album, startIndex = 0) => {
    const items = album.tracks.map(t => ({
      albumPath:  album.path,
      albumTitle: album.title,
      albumImage: album.image,
      artist:     album.artist,
      n:          t.n,
      title:      t.title,
      audioPath:  t.audioPath,
      available:  t.available,
      streamable: !t.available,
      wikilink:   t.wikilink,
      duration:   t.duration,
    }));
    let start = startIndex;
    if (!isPlayable(items[start])) {
      // skip forward to first playable
      for (let i = start; i < items.length; i++) {
        if (isPlayable(items[i])) { start = i; break; }
      }
    }
    // Same-track restart: if the target audio is already loaded, the sync
    // effect won't re-fire (track identity unchanged after setQueue), so
    // seek to 0 imperatively before flipping state.
    const target = items[start];
    const a = audioRef.current;
    if (a && target && (a.src === audioSrcFor(target.audioPath) ||
        (target.streamable && streamSrcKeyRef.current === streamKeyOf(target)))) {
      try { a.currentTime = 0; } catch {}
    }
    setQueue(items);
    setIndex(start);
    setIsPlaying(true);
  }, []);

  const playSingleTrack = useCallback((track) => {
    const a = audioRef.current;
    if (a && track && (a.src === audioSrcFor(track.audioPath) ||
        (track.streamable && streamSrcKeyRef.current === streamKeyOf(track)))) {
      try { a.currentTime = 0; } catch {}
    }
    setQueue([track]);
    setIndex(0);
    setIsPlaying(true);
  }, []);

  // Like playAlbumTracks but loads pre-shaped queue items verbatim — for
  // playlists, whose tracks span albums, so each item keeps its own cover and
  // artist instead of inheriting one album's. Skips unavailable from the start.
  const playTracks = useCallback((items, startIndex = 0) => {
    if (!items || items.length === 0) return;
    let start = startIndex;
    if (!isPlayable(items[start])) {
      for (let i = start; i < items.length; i++) {
        if (isPlayable(items[i])) { start = i; break; }
      }
    }
    const target = items[start];
    if (!isPlayable(target)) return;
    const a = audioRef.current;
    if (a && (a.src === audioSrcFor(target.audioPath) ||
        (target.streamable && streamSrcKeyRef.current === streamKeyOf(target)))) {
      try { a.currentTime = 0; } catch {}
    }
    setQueue(items);
    setIndex(start);
    setIsPlaying(true);
  }, []);

  const enqueue = useCallback((tracks) => {
    setQueue(prev => [...prev, ...tracks]);
  }, []);

  const playNext = useCallback((tracks) => {
    setQueue(prev => {
      if (prev.length === 0) return tracks;
      const before = prev.slice(0, index + 1);
      const after = prev.slice(index + 1);
      return [...before, ...tracks, ...after];
    });
  }, [index]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    // A streamable track may not have loaded a src yet (resolve happens on
    // play) — let the toggle through so the sync effect starts the resolve.
    if (!a?.src && !currentTrack?.streamable) return;
    setIsPlaying(p => !p);
  }, [currentTrack]);

  const next = useCallback(() => {
    const nxt = nextIndexFrom(index);
    const playable = nxt < 0 ? -1 : skipUnavailable(nxt, +1);
    if (playable < 0) return;
    setIndex(playable);
    setIsPlaying(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue, repeat, shuffle]);

  const prev = useCallback(() => {
    const a = audioRef.current;
    if (a && a.currentTime > 3) { a.currentTime = 0; return; }
    const pv = prevIndexFrom(index);
    const playable = pv < 0 ? -1 : skipUnavailable(pv, -1);
    if (playable < 0) return;
    setIndex(playable);
    setIsPlaying(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue, repeat, shuffle]);

  const seek = useCallback((t) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.duration || 0, t));
  }, []);

  const setVolume = useCallback((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolumeState(clamped);
    saveJSON(LS.volume, clamped);
  }, []);

  const cycleRepeat = useCallback(() => {
    setRepeat(r => {
      const next = r === 'off' ? 'all' : r === 'all' ? 'one' : 'off';
      saveJSON(LS.repeat, next);
      return next;
    });
  }, []);

  const toggleShuffle = useCallback(() => {
    setShuffle(s => {
      const next = !s;
      saveJSON(LS.shuffle, next);
      return next;
    });
  }, []);

  const jumpToQueueIndex = useCallback((i) => {
    if (i < 0 || i >= queue.length) return;
    if (!isPlayable(queue[i])) return;
    // Same-track restart when jumping to the already-selected queue row.
    if (i === index) {
      const a = audioRef.current;
      if (a) { try { a.currentTime = 0; } catch {} }
    }
    setIndex(i);
    setIsPlaying(true);
  }, [queue, index]);

  const reorderQueue = useCallback((from, to) => {
    setQueue(prev => {
      if (from === to || from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      // Track current track's new index
      setIndex(curIdx => {
        if (curIdx === from) return to;
        if (from < curIdx && to >= curIdx) return curIdx - 1;
        if (from > curIdx && to <= curIdx) return curIdx + 1;
        return curIdx;
      });
      return next;
    });
  }, []);

  const removeFromQueue = useCallback((i) => {
    setQueue(prev => {
      if (i < 0 || i >= prev.length) return prev;
      const next = prev.slice();
      next.splice(i, 1);
      setIndex(curIdx => {
        if (curIdx === i) return curIdx; // playing track removed — let onEnded handle, or just stay at same index (now next track)
        if (i < curIdx) return curIdx - 1;
        return curIdx;
      });
      return next;
    });
  }, []);

  const value = useMemo(() => ({
    // state
    currentTrack, queue, index, isPlaying, position, duration,
    volume, shuffle, repeat,
    listenMinutesThisMonth,
    // "Finding track" — a streamable track's URL is being resolved right now
    resolvingStream,
    // actions
    playAlbumTracks, playSingleTrack, playTracks, enqueue, playNext,
    toggle, next, prev, seek, setVolume, cycleRepeat, toggleShuffle,
    jumpToQueueIndex, reorderQueue, removeFromQueue,
    // web-audio analyser accessor (LiveWaveform consumer)
    getAnalyser,
  }), [currentTrack, queue, index, isPlaying, position, duration, volume, shuffle, repeat,
        listenMinutesThisMonth, resolvingStream,
        playAlbumTracks, playSingleTrack, playTracks, enqueue, playNext, toggle, next, prev, seek,
        setVolume, cycleRepeat, toggleShuffle, jumpToQueueIndex, reorderQueue, removeFromQueue,
        getAnalyser]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMusicPlayer() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMusicPlayer must be used inside <MusicPlayerProvider>');
  return v;
}
