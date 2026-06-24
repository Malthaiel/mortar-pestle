// Single source of truth for music playback. One <audio> element is owned by
// this provider and never unmounts on route change, so playback survives
// navigation. Everything visual (the bar, queue panel, album detail) reads
// from this context.

import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { mediaUrl, mediaHttpUrl, awaitMediaBaseUrl, invoke } from '@host/api.js';
import { musicApi } from './api.js';

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
// (iskariel-asset://) in HTMLMediaElement. The Rust side runs a loopback
// axum server on a kernel-assigned 127.0.0.1 port; mediaHttpUrl returns the
// http:// URL that WebKit accepts.
function audioSrcFor(audioPath) {
  // Catalog audio lives in the Library vault, resolved against its root.
  return audioPath ? mediaHttpUrl(audioPath, { library: true }) : null;
}

// Surface play() rejections so a future audio bug isn't invisible. Console line
// names the track + resolved src (which differs between browser-tab dev and the
// Tauri shell — `iskariel-asset://` vs `/api/file/`); the dispatched event is
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
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.72;
      sourceNodeRef.current.connect(analyser);
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
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
  // port was ready.
  const [, _setMediaReadyTick] = useState(0);
  useEffect(() => {
    const onReady = () => _setMediaReadyTick((n) => n + 1);
    window.addEventListener('agentic:media-server-ready', onReady);
    awaitMediaBaseUrl().then(onReady).catch(() => {});
    return () => window.removeEventListener('agentic:media-server-ready', onReady);
  }, []);

  const currentTrack = index >= 0 && index < queue.length ? queue[index] : null;

  // Wire <audio> element to React state. Human hearing is logarithmic, so we
  // apply a perceptual curve (cubic) — the slider stays linear 0-1 visually
  // but the actual gain ramps up gently at the bottom and aggressively at the
  // top, matching how loudness is perceived.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = Math.pow(volume, 3);
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
      const err = a.error;
      const codeMap = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src not supported' };
      const cls = codeMap[err?.code] || `code ${err?.code}`;
      const msg = err?.message ? `${cls}: ${err.message}` : cls;
      emitPlayError(currentTrack, { message: msg });
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

  // Persist last-played track + position periodically.
  useEffect(() => {
    if (!currentTrack) return;
    const interval = setInterval(() => {
      const a = audioRef.current;
      if (!a) return;
      saveJSON(LS.last, {
        albumPath: currentTrack.albumPath,
        trackIndex: index,
        position: a.currentTime,
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [currentTrack, index]);

  // On mount, restore the last-played track into the queue (paused) so the
  // sidebar music slot shows it instead of an empty placeholder.
  useEffect(() => {
    const last = loadJSON(LS.last, null);
    if (!last || !last.albumPath) return;
    let cancelled = false;
    musicApi.readAlbum(last.albumPath)
      .catch(() => null)
      .then(album => {
        if (cancelled || !album || !album.tracks) return;
        const items = album.tracks.map(t => ({
          albumPath:  album.albumPagePath || last.albumPath,
          albumTitle: album.title,
          albumImage: album.image,
          artist:     album.artist,
          n:          t.n,
          title:      t.title,
          audioPath:  t.audioPath,
          available:  t.available,
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
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    if (!currentTrack?.audioPath) {
      if (!a.paused) a.pause();
      a.removeAttribute('src');
      a.load();
      return;
    }

    const want = audioSrcFor(currentTrack.audioPath);
    if (a.src !== want) {
      a.src = want;
      a.load();
    }

    if (isPlaying && a.paused) {
      a.play().catch(err => emitPlayError(currentTrack, err));
    } else if (!isPlaying && !a.paused) {
      a.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.audioPath, isPlaying]);

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
    // Walk in given direction until we hit an available track or loop back.
    let i = start;
    const seen = new Set();
    while (i >= 0 && !seen.has(i)) {
      seen.add(i);
      if (queue[i] && queue[i].available) return i;
      i = dir > 0 ? nextIndexFrom(i) : prevIndexFrom(i);
      if (i < 0) return -1;
    }
    return -1;
  }

  const handleEnded = useCallback(() => {
    // Record the completed listen before queue advancement. Skip when the
    // track has no usable duration (some MusicBrainz entries omit it).
    const ended = queue[index];
    if (ended?.audioPath && typeof ended.duration === 'number' && ended.duration >= 1) {
      const secs = Math.round(ended.duration);
      invoke('music_record_listen', { trackPath: ended.audioPath, durationSec: secs })
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
      wikilink:   t.wikilink,
      duration:   t.duration,
    }));
    let start = startIndex;
    if (!items[start] || !items[start].available) {
      // skip forward to first available
      for (let i = start; i < items.length; i++) {
        if (items[i].available) { start = i; break; }
      }
    }
    // Same-track restart: if the target audio is already loaded, the sync
    // effect won't re-fire (audioPath identity unchanged after setQueue), so
    // seek to 0 imperatively before flipping state.
    const target = items[start];
    const a = audioRef.current;
    if (a && target && a.src === audioSrcFor(target.audioPath)) {
      try { a.currentTime = 0; } catch {}
    }
    setQueue(items);
    setIndex(start);
    setIsPlaying(true);
  }, []);

  const playSingleTrack = useCallback((track) => {
    const a = audioRef.current;
    if (a && track && a.src === audioSrcFor(track.audioPath)) {
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
    if (!items[start] || !items[start].available) {
      for (let i = start; i < items.length; i++) {
        if (items[i].available) { start = i; break; }
      }
    }
    const target = items[start];
    if (!target || !target.available) return;
    const a = audioRef.current;
    if (a && a.src === audioSrcFor(target.audioPath)) {
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
    if (!a?.src) return;
    setIsPlaying(p => !p);
  }, []);

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
    if (!queue[i].available) return;
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
    // actions
    playAlbumTracks, playSingleTrack, playTracks, enqueue, playNext,
    toggle, next, prev, seek, setVolume, cycleRepeat, toggleShuffle,
    jumpToQueueIndex, reorderQueue, removeFromQueue,
    // web-audio analyser accessor (LiveWaveform consumer)
    getAnalyser,
  }), [currentTrack, queue, index, isPlaying, position, duration, volume, shuffle, repeat,
        listenMinutesThisMonth,
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
