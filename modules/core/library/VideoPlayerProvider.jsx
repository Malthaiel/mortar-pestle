// Single source of truth for video playback. One <video> element survives
// route changes — when the user leaves /tools/library/anime it collapses to a small
// PiP in the corner; when they come back, the modal re-expands. The element
// itself is rendered by <VideoPlayerHost/> which is mounted once inside
// AppShell.
//
// Playback flow: the source is an .mkv outside the vault. videoApi.videoStreamURL
// kicks off an ffmpeg remux of the WHOLE episode to a complete, seekable MP4
// (+faststart, real container duration) and resolves only once it's ready — a
// brief "Preparing…" spinner covers the wait. Seeking is then native
// (video.currentTime); switching audio track re-remuxes that track and restores
// the position once the new file's metadata loads (resumePosRef).

import {
  createContext, useContext, useEffect, useMemo, useRef, useState, useCallback,
} from 'react';
import { videoApi } from './api.js';
import VideoControls from './VideoControls.jsx';
import SubtitleOverlay from './SubtitleOverlay.jsx';
import { candyGap } from '@host/util/candy.js';

const Ctx = createContext(null);

const LS = {
  volume:   'video:volume',
  speed:    'video:speed',
  subPref:  'video:subPref',   // language code, or 'off'
  audPref:  'video:audPref',   // language code
  progress: 'video:progress',  // { [fileAbs]: { time, duration, savedAt } }
  subSettings: 'video:subSettings',  // global subtitle rendering config
  subSync:  'video:subSync',   // { [fileAbs]: offsetSeconds }
};

export const DEFAULT_SUB_SETTINGS = {
  size: 28,            // px
  bgStyle: 'box',      // 'box' | 'shadow' | 'outline' | 'none'
  bgOpacity: 0.7,      // 0..1, only when bgStyle === 'box'
  shadowSize: 4,       // px blur radius, only when bgStyle === 'shadow'
  outlineSize: 2,      // px stroke width, only when bgStyle === 'outline'
  position: 0.9,       // 0..1 from top
  fontFamily: 'sans',  // 'sans' | 'serif' | 'mono'
  fontWeight: 700,     // 400 | 500 | 700
  letterSpacing: 0,    // px
  lineHeight: 1.3,
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

// `HH:MM:SS.mmm` / `MM:SS.mmm` (`,` decimal tolerated) → seconds. Trailing cue
// settings after the timestamp are ignored by the anchored match.
function parseVttTimestamp(ts) {
  const m = String(ts).match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
}

// Minimal WebVTT parser → [{ startTime, endTime, text }]. Handles the cue shape
// ffmpeg emits: optional id line, a `start --> end` timing line, then text lines.
// We parse the VTT ourselves because WebKitGTK populates textTrack.cues
// unreliably; SubtitleOverlay owns the actual rendering + tag sanitizing.
function parseVtt(text) {
  const out = [];
  if (!text) return out;
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const lines = block.split('\n').filter(l => l.length > 0);
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    let i = 0;
    if (!lines[i].includes('-->') && lines[i + 1] && lines[i + 1].includes('-->')) i += 1;
    if (!lines[i] || !lines[i].includes('-->')) continue;
    const [rawStart, rawEnd] = lines[i].split('-->');
    const startTime = parseVttTimestamp(rawStart);
    const endTime = parseVttTimestamp(rawEnd);
    if (startTime == null || endTime == null) continue;
    const cueText = lines.slice(i + 1).join('\n');
    if (cueText) out.push({ startTime, endTime, text: cueText });
  }
  return out;
}

function inferModeFromHash() {
  const h = window.location.hash || '';
  if (h.startsWith('#/tools/library/anime') || h.startsWith('#/player')) return 'modal';
  return 'pip';
}

function isPoppedWindow() {
  try { return typeof window !== 'undefined' && !!window.opener && !window.opener.closed; }
  catch { return false; }
}

// VaultError from src-tauri serializes as { code, message }. Tauri's invoke
// rejection sometimes hands that shape directly, sometimes a string, sometimes
// an Error. Surface the most readable form for the player overlay.
function formatStreamError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    if (typeof err.message === 'string') {
      return err.code ? `${err.code}: ${err.message}` : err.message;
    }
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err);
}

export function VideoPlayerProvider({ children }) {
  // Series + episode playlist context
  const [series, setSeries] = useState(null);          // full series object
  const [episodeIdx, setEpisodeIdx] = useState(-1);
  const [probe, setProbe] = useState(null);            // { audio[], subtitles[], chapters[], duration }
  // Stream + position
  const [videoTime, setVideoTime] = useState(0);       // = video.currentTime (absolute)
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);         // from probe (full episode duration)
  const [preparing, setPreparing] = useState(false);   // remux in progress → show spinner
  const [streamError, setStreamError] = useState(null);
  const [refreshing, setRefreshing] = useState(false); // stream-refresh in flight (vs first-load)
  const [reloadNonce, setReloadNonce] = useState(0);   // bump → src effect reloads the same episode
  // Track selections
  const [audioIdx, setAudioIdx] = useState(0);
  const [subIdx, setSubIdx] = useState(-1);            // -1 = off
  // Subtitle rendering settings (custom overlay)
  const [subSettings, _setSubSettingsState] = useState(() => ({
    ...DEFAULT_SUB_SETTINGS,
    ...(loadJSON(LS.subSettings, {}) || {}),
  }));
  const [subSyncMap, _setSubSyncMapState] = useState(() => loadJSON(LS.subSync, {}) || {});
  const [cues, setCues] = useState([]);                // [{startTime, endTime, text}]
  // User prefs (persisted)
  const [volume, setVolumeState] = useState(() => {
    const v = loadJSON(LS.volume, 0.8);
    return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 0.8;
  });
  const [speed, setSpeedState] = useState(() => {
    const v = loadJSON(LS.speed, 1);
    return typeof v === 'number' && v > 0 ? v : 1;
  });
  // UI mode — derived from URL hash; switches modal↔pip on nav.
  const [mode, setMode] = useState(() => typeof window !== 'undefined' ? inferModeFromHash() : 'modal');

  const videoRef = useRef(null);
  const fullscreenHostRef = useRef(null);
  const watchedFiredRef = useRef(new Set()); // fileAbs values we've already marked
  const progressIntervalRef = useRef(null);
  const resumePosRef = useRef(0); // restore target (seconds) applied on loadedmetadata
  const refreshPlayRef = useRef(null); // refresh: forced post-reload play state (null → use isPlaying)
  const speedRef = useRef(speed);      // latest speed/volume, re-applied defensively after a reload
  const volumeRef = useRef(volume);

  const currentEpisode = series && episodeIdx >= 0 && episodeIdx < series.episodes.length
    ? series.episodes[episodeIdx]
    : null;
  const effectiveTime = videoTime;
  const playerOpen = !!currentEpisode;

  // Track hash → mode
  useEffect(() => {
    const onHash = () => setMode(inferModeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Wire volume + speed to the <video> element
  useEffect(() => {
    const v = videoRef.current;
    volumeRef.current = volume;
    if (!v) return;
    v.volume = Math.pow(volume, 3); // perceptual
  }, [volume]);
  useEffect(() => {
    const v = videoRef.current;
    speedRef.current = speed;
    if (!v) return;
    v.playbackRate = speed;
  }, [speed]);

  // Stream refresh always leaves `preparing` true while reloading; clear the
  // refreshing flag the moment preparing resolves (metadata loaded or errored).
  useEffect(() => { if (!preparing) setRefreshing(false); }, [preparing]);

  // Periodically persist position (every 5s) and mark-watched at 90 %.
  useEffect(() => {
    if (!currentEpisode || !currentEpisode.fileAbs) return;
    progressIntervalRef.current = setInterval(() => {
      // Don't persist (or clobber the saved resume pos) until metadata has
      // loaded and the restore seek has applied.
      if (preparing) return;
      const fileAbs = currentEpisode.fileAbs;
      const map = loadJSON(LS.progress, {}) || {};
      map[fileAbs] = { time: effectiveTime, duration, savedAt: Date.now() };
      saveJSON(LS.progress, map);
      // mark-watched at 90 %
      if (duration > 0 && effectiveTime / duration >= 0.9 && !watchedFiredRef.current.has(fileAbs)) {
        watchedFiredRef.current.add(fileAbs);
        videoApi.markEpisodeWatched(series.path, currentEpisode.n, currentEpisode.seasonName || null).catch(() => {});
      }
    }, 5000);
    return () => clearInterval(progressIntervalRef.current);
  }, [currentEpisode, duration, effectiveTime, series, preparing]);

  // <video> event wiring
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime  = () => setVideoTime(v.currentTime);
    const onPlay  = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => handleEnded();
    const onError = () => {
      if (!v.error) return; // ignore the empty-error fired on src clear
      setStreamError('Playback error (code ' + v.error.code + ')');
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, episodeIdx, audioIdx, duration]);

  function handleEnded() {
    if (!series) return;
    const v = videoRef.current;
    const pos = v ? v.currentTime : effectiveTime;
    const dur = Math.max(duration || 0, v && Number.isFinite(v.duration) ? v.duration : 0);
    // Only a genuine end advances: require a plausible full-length duration AND
    // being within 15 s of it. Otherwise treat 'ended' as spurious → stop, never
    // skip through the series.
    if (!(dur > 60 && pos >= dur - 15)) {
      setIsPlaying(false);
      return;
    }
    // Genuine end → auto-advance to the next available episode.
    for (let i = episodeIdx + 1; i < series.episodes.length; i++) {
      if (series.episodes[i].available) {
        playEpisodeAt(i, 0);
        return;
      }
    }
    setIsPlaying(false);
  }

  // (Re)load the <video> src whenever the episode or audio track changes. The
  // whole-file remux runs first — videoApi.videoStreamURL resolves only once the
  // complete +faststart MP4 is ready — so we show a "Preparing…" spinner until
  // then. The cancelled flag drops a stale resolve when the user switches fast;
  // the Rust side also SIGTERMs the prior ffmpeg on every new request.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!currentEpisode || !currentEpisode.fileAbs) {
      v.removeAttribute('src');
      v.load();
      setStreamError(null);
      setPreparing(false);
      return;
    }
    let cancelled = false;
    let metaHandler = null;
    let timeoutId = null;
    setStreamError(null);
    setPreparing(true);
    videoApi.videoStreamURL(currentEpisode.fileAbs, audioIdx).then(
      r => {
        if (cancelled) return;
        const v2 = videoRef.current;
        if (!v2) return;
        v2.src = r.url;
        v2.load();
        // Restore the resume position once the container metadata (real
        // duration) is known, then start playback and clear the spinner.
        metaHandler = () => {
          if (cancelled) return;
          const pos = Math.min(resumePosRef.current || 0, v2.duration || Infinity);
          if (pos > 0 && Number.isFinite(pos)) v2.currentTime = pos;
          // WebKitGTK can drop rate/volume across a reload — re-apply from refs.
          v2.playbackRate = speedRef.current;
          v2.volume = Math.pow(volumeRef.current, 3);
          setVideoTime(v2.currentTime || 0);
          setPreparing(false);
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
          // On a refresh, restore the exact pre-refresh play state; otherwise
          // honor the episode-load intent (isPlaying).
          const shouldPlay = refreshPlayRef.current != null ? refreshPlayRef.current : isPlaying;
          refreshPlayRef.current = null;
          if (shouldPlay) v2.play().catch(() => setIsPlaying(false));
        };
        v2.addEventListener('loadedmetadata', metaHandler, { once: true });
        // Safety net: if metadata never arrives, clear the spinner + surface it.
        timeoutId = setTimeout(() => {
          if (cancelled) return;
          setPreparing(false);
          setStreamError('Timed out preparing video');
        }, 15000);
      },
      err => {
        if (cancelled) return;
        console.error('[video] stream start failed:', err);
        setPreparing(false);
        setStreamError(formatStreamError(err));
      },
    );
    return () => {
      cancelled = true;
      const v2 = videoRef.current;
      if (v2 && metaHandler) v2.removeEventListener('loadedmetadata', metaHandler);
      if (timeoutId) clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpisode?.fileAbs, audioIdx, reloadNonce]);

  // Sub-feature 7.5 — subtitle URL is now async (Tauri command extracts VTT
  // to a hash-keyed file under `~/.cache/mortar-pestle/subs/`). Resolve at the
  // provider level so the <track> below renders only when the URL is ready.
  const [subsUrl, setSubsUrl] = useState(null);
  useEffect(() => {
    if (!probe || subIdx < 0 || !currentEpisode?.fileAbs) {
      setSubsUrl(null);
      return;
    }
    let cancelled = false;
    videoApi.videoSubsURL(currentEpisode.fileAbs, subIdx).then(
      r => { if (!cancelled) setSubsUrl(r.url); },
      err => { if (!cancelled) { console.error('[video] subs extract failed:', err); setSubsUrl(null); } },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpisode?.fileAbs, subIdx, probe]);

  // Subtitle cues: fetch the extracted WebVTT and parse it ourselves rather than
  // leaning on a <track> + textTrack.cues — WebKitGTK populates those unreliably
  // and the <track> mounts after this effect runs. `subsUrl` already re-resolves
  // on episode/track/probe change, so it's the only dependency we need.
  useEffect(() => {
    if (subIdx < 0 || !subsUrl) {
      setCues([]);
      return;
    }
    let cancelled = false;
    fetch(subsUrl)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(`subs HTTP ${r.status}`))))
      .then(text => { if (!cancelled) setCues(parseVtt(text)); })
      .catch(err => { if (!cancelled) { console.error('[video] subs load failed:', err); setCues([]); } });
    return () => { cancelled = true; };
  }, [subsUrl, subIdx]);

  const updateSubSetting = useCallback((key, val) => {
    _setSubSettingsState(prev => {
      const next = { ...prev, [key]: val };
      saveJSON(LS.subSettings, next);
      return next;
    });
  }, []);
  const resetSubSettings = useCallback(() => {
    _setSubSettingsState(DEFAULT_SUB_SETTINGS);
    saveJSON(LS.subSettings, DEFAULT_SUB_SETTINGS);
  }, []);
  const nudgeSubSync = useCallback((delta) => {
    if (!currentEpisode || !currentEpisode.fileAbs) return;
    _setSubSyncMapState(prev => {
      const cur = Number(prev[currentEpisode.fileAbs] || 0);
      const nextVal = Math.round((cur + delta) * 100) / 100;
      const next = { ...prev, [currentEpisode.fileAbs]: nextVal };
      saveJSON(LS.subSync, next);
      return next;
    });
  }, [currentEpisode]);
  const resetSubSync = useCallback(() => {
    if (!currentEpisode || !currentEpisode.fileAbs) return;
    _setSubSyncMapState(prev => {
      const next = { ...prev };
      delete next[currentEpisode.fileAbs];
      saveJSON(LS.subSync, next);
      return next;
    });
  }, [currentEpisode]);
  const subSync = currentEpisode && subSyncMap[currentEpisode.fileAbs]
    ? Number(subSyncMap[currentEpisode.fileAbs]) || 0
    : 0;

  // ── Actions ────────────────────────────────────────────────────────────
  const playEpisodeAt = useCallback((idx, opts = null) => {
    if (!series) return;
    if (idx < 0 || idx >= series.episodes.length) return;
    const ep = series.episodes[idx];
    if (!ep || !ep.available) return;
    setEpisodeIdx(idx);
    watchedFiredRef.current.delete(ep.fileAbs); // re-arm for replay
    // Resume from saved position unless the caller forced a start (opts != null).
    let start = 0;
    if (opts && typeof opts === 'object' && typeof opts.start === 'number') {
      start = opts.start;
    } else if (opts == null) {
      const map = loadJSON(LS.progress, {}) || {};
      const saved = map[ep.fileAbs];
      if (saved && saved.duration && saved.time / saved.duration < 0.9) {
        start = Math.max(0, saved.time - 2); // tiny rewind for comfort
      }
    } else if (typeof opts === 'number') {
      start = opts;
    }
    resumePosRef.current = start;
    setIsPlaying(true);
    setVideoTime(0);
    // Re-probe so audio/sub track lists are accurate.
    videoApi.probeVideo(ep.fileAbs).then(p => {
      setProbe(p);
      setDuration(p && p.duration ? p.duration : 0);
      // Pick default audio track honoring user pref
      const audPref = loadJSON(LS.audPref, null);
      let aIdx = 0;
      if (p && p.audio && p.audio.length) {
        if (audPref) {
          const m = p.audio.findIndex(t => t.language === audPref);
          if (m >= 0) aIdx = m;
        } else {
          const def = p.audio.findIndex(t => t.default);
          if (def >= 0) aIdx = def;
        }
      }
      setAudioIdx(aIdx);
      // Pick default subtitle track honoring user pref
      const subPref = loadJSON(LS.subPref, 'eng');
      let sIdx = -1;
      if (subPref !== 'off' && p && p.subtitles && p.subtitles.length) {
        const m = p.subtitles.findIndex(t => t.language === subPref);
        sIdx = m >= 0 ? m : 0;
      }
      setSubIdx(sIdx);
    }).catch(() => { setProbe(null); setDuration(0); });
  }, [series]);

  const playSeries = useCallback((seriesObj, startIdx = 0) => {
    setSeries(seriesObj);
    // playEpisodeAt isn't fresh yet (series state hasn't propagated). Inline:
    if (startIdx < 0 || startIdx >= seriesObj.episodes.length) return;
    const ep = seriesObj.episodes[startIdx];
    if (!ep || !ep.available) {
      // skip forward to first available
      for (let i = startIdx; i < seriesObj.episodes.length; i++) {
        if (seriesObj.episodes[i].available) { startIdx = i; break; }
      }
    }
    setEpisodeIdx(startIdx);
    watchedFiredRef.current.delete(seriesObj.episodes[startIdx].fileAbs);
    const fileAbs = seriesObj.episodes[startIdx].fileAbs;
    const map = loadJSON(LS.progress, {}) || {};
    const saved = map[fileAbs];
    const start = (saved && saved.duration && saved.time / saved.duration < 0.9)
      ? Math.max(0, saved.time - 2) : 0;
    resumePosRef.current = start;
    setIsPlaying(true);
    setVideoTime(0);
    videoApi.probeVideo(fileAbs).then(p => {
      setProbe(p);
      setDuration(p && p.duration ? p.duration : 0);
      const audPref = loadJSON(LS.audPref, null);
      let aIdx = 0;
      if (p && p.audio && p.audio.length) {
        if (audPref) {
          const m = p.audio.findIndex(t => t.language === audPref);
          if (m >= 0) aIdx = m;
        } else {
          const def = p.audio.findIndex(t => t.default);
          if (def >= 0) aIdx = def;
        }
      }
      setAudioIdx(aIdx);
      const subPref = loadJSON(LS.subPref, 'eng');
      let sIdx = -1;
      if (subPref !== 'off' && p && p.subtitles && p.subtitles.length) {
        const m = p.subtitles.findIndex(t => t.language === subPref);
        sIdx = m >= 0 ? m : 0;
      }
      setSubIdx(sIdx);
    }).catch(() => { setProbe(null); setDuration(0); });
  }, []);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const seek = useCallback((effectiveTimeSec) => {
    // Native seek within the complete file — no re-transcode.
    const v = videoRef.current;
    if (!v || preparing) return;
    const t = Math.max(0, Math.min(duration || effectiveTimeSec, effectiveTimeSec));
    v.currentTime = t;
    setVideoTime(t);
  }, [duration, preparing]);

  const skip = useCallback((delta) => {
    seek(effectiveTime + delta);
  }, [effectiveTime, seek]);

  const next = useCallback(() => {
    if (!series) return;
    for (let i = episodeIdx + 1; i < series.episodes.length; i++) {
      if (series.episodes[i].available) { playEpisodeAt(i, 0); return; }
    }
  }, [series, episodeIdx, playEpisodeAt]);

  const prev = useCallback(() => {
    if (!series) return;
    // If we're more than 3s in, just restart current.
    if (effectiveTime > 3) { seek(0); return; }
    for (let i = episodeIdx - 1; i >= 0; i--) {
      if (series.episodes[i].available) { playEpisodeAt(i, 0); return; }
    }
  }, [series, episodeIdx, effectiveTime, seek, playEpisodeAt]);

  const setVolume = useCallback((v) => {
    const c = Math.min(1, Math.max(0, v));
    setVolumeState(c);
    saveJSON(LS.volume, c);
  }, []);

  const setSpeed = useCallback((v) => {
    setSpeedState(v);
    saveJSON(LS.speed, v);
  }, []);

  const setAudioTrack = useCallback((idx) => {
    if (!probe || !probe.audio || idx < 0 || idx >= probe.audio.length) return;
    resumePosRef.current = effectiveTime; // restore position after the re-transcode
    setAudioIdx(idx);
    saveJSON(LS.audPref, probe.audio[idx].language);
  }, [probe, effectiveTime]);

  // Reload the current episode's stream from the same position, preserving play
  // state (and audio/sub track + speed/volume, which the reload effect restores).
  // Recovers a stalled / errored stream without losing the user's place.
  const refresh = useCallback(() => {
    const v = videoRef.current;
    if (!currentEpisode?.fileAbs) return;
    resumePosRef.current = v ? (v.currentTime || effectiveTime || 0) : effectiveTime;
    refreshPlayRef.current = v ? !v.paused : isPlaying;
    setRefreshing(true);
    setReloadNonce(n => n + 1);
  }, [currentEpisode, effectiveTime, isPlaying]);

  const setSubtitleTrack = useCallback((idx) => {
    setSubIdx(idx);
    if (idx < 0) saveJSON(LS.subPref, 'off');
    else if (probe && probe.subtitles && probe.subtitles[idx]) {
      saveJSON(LS.subPref, probe.subtitles[idx].language);
    }
  }, [probe]);

  const requestFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(e => console.error('exitFullscreen failed:', e));
      return;
    }
    const target = fullscreenHostRef.current || videoRef.current;
    if (target) target.requestFullscreen().catch(e => console.error('requestFullscreen failed:', e));
  }, []);

  const closePlayer = useCallback(() => {
    const v = videoRef.current;
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
    setIsPlaying(false);
    setSeries(null);
    setEpisodeIdx(-1);
    setProbe(null);
    setVideoTime(0);
    setDuration(0);
  }, []);

  const value = useMemo(() => ({
    // state
    series, currentEpisode, episodeIdx, probe,
    videoTime, effectiveTime, duration,
    isPlaying, volume, speed, audioIdx, subIdx, mode, playerOpen,
    // subtitles
    subSettings, subSync, cues, subsUrl,
    // error + loading surface (set by the stream-start effect)
    streamError, preparing, refreshing,
    // actions
    playSeries, playEpisodeAt, toggle, seek, skip, next, prev,
    setVolume, setSpeed, setAudioTrack, setSubtitleTrack, refresh,
    requestFullscreen, closePlayer,
    updateSubSetting, resetSubSettings, nudgeSubSync, resetSubSync,
    // refs (consumed by host)
    videoRef, fullscreenHostRef,
  }), [
    series, currentEpisode, episodeIdx, probe,
    videoTime, effectiveTime, duration,
    isPlaying, volume, speed, audioIdx, subIdx, mode, playerOpen,
    subSettings, subSync, cues, subsUrl, streamError, preparing, refreshing,
    playSeries, playEpisodeAt, toggle, seek, skip, next, prev,
    setVolume, setSpeed, setAudioTrack, setSubtitleTrack, refresh,
    requestFullscreen, closePlayer,
    updateSubSetting, resetSubSettings, nudgeSubSync, resetSubSync,
  ]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <VideoPlayerHost/>
    </Ctx.Provider>
  );
}

export function useVideoPlayer() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVideoPlayer must be used inside <VideoPlayerProvider>');
  return v;
}

// The host is the actual DOM home of the <video> element. It survives across
// route changes because the provider always renders it. CSS positioning
// changes based on mode (modal vs pip).
function VideoPlayerHost() {
  const v = useVideoPlayer();
  if (!v.playerOpen) return null;

  const onExpand = () => {
    // Navigate back to /tools/library/anime/<seriesPath>
    const target = '#/tools/library/anime/' + (v.series ? v.series.path.split('/').map(encodeURIComponent).join('/') : '');
    if (window.location.hash !== target) window.location.hash = target.slice(1);
  };

  return v.mode === 'pip' ? (
    <PiPHost expand={onExpand}/>
  ) : (
    <ModalHost/>
  );
}

function ModalHost() {
  const v = useVideoPlayer();
  const [isFs, setIsFs] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimerRef = useRef(null);
  const clickTimerRef = useRef(null);

  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Single click → toggle play/pause; double click → toggle fullscreen.
  // Delay the single-click action so a second click within ~260ms cancels it.
  const onVideoClick = () => {
    if (clickTimerRef.current) return; // dblclick handler will pick this up
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      v.toggle();
    }, 260);
  };
  const onVideoDblClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    v.requestFullscreen();
  };

  const wake = () => {
    setIdle(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIdle(true), 2500);
  };

  useEffect(() => {
    wake();
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show chrome whenever video is paused (regardless of idle timer).
  const chromeHidden = idle && v.isPlaying;
  const fadeStyle = {
    opacity: chromeHidden ? 0 : 1,
    pointerEvents: chromeHidden ? 'none' : 'auto',
    transition: 'opacity 0.25s ease',
  };

  return (
    <div
      ref={v.fullscreenHostRef}
      className="video-cinema"
      onMouseMove={wake}
      onMouseDown={wake}
      style={{
        position: 'fixed', inset: 0,
        background: '#000',
        zIndex: 1500,
        cursor: chromeHidden ? 'none' : 'auto',
      }}
      onKeyDown={(e) => {
        if (e.key === ' ') { e.preventDefault(); v.toggle(); }
        if (e.key === 'ArrowRight') v.skip(+10);
        if (e.key === 'ArrowLeft')  v.skip(-10);
        if (e.key === 'Escape')     v.closePlayer();
      }}
      tabIndex={-1}
    >
      {/* Video fills the entire host. */}
      <video
        ref={v.videoRef}
        onClick={onVideoClick}
        onDoubleClick={onVideoDblClick}
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          objectFit: 'contain',
          background: '#000',
          outline: 'none',
        }}
        crossOrigin="anonymous"
        playsInline
      />
      {/* Subtitles are fetched + parsed in the provider (parseVtt) and drawn by
          SubtitleOverlay — no <track> element (WebKitGTK's textTrack.cues are
          unreliable). */}

      <SubtitleOverlay/>

      {v.streamError && (
        <div className="candy-panel" style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          maxWidth: 520,
          padding: '20px 24px',
          color: 'var(--text)',
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          lineHeight: 1.5,
          zIndex: 1700,
          pointerEvents: 'auto',
        }}>
          <div style={{
            color: 'rgba(255,120,120,0.95)',
            fontSize: 11, letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}>Playback failed</div>
          <div style={{ wordBreak: 'break-word' }}>{v.streamError}</div>
        </div>
      )}

      {v.preparing && !v.streamError && (
        <div className="candy-panel" style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          padding: '18px 26px',
          color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          letterSpacing: '0.06em',
          zIndex: 1700,
          pointerEvents: 'none',
        }}>{v.refreshing ? 'Refreshing…' : 'Preparing episode…'}</div>
      )}

      {/* Top gradient + title + window buttons (overlay, fades on idle). */}
      <div style={{
        ...fadeStyle,
        position: 'absolute', top: 0, left: 0, right: 0,
        padding: '14px 24px 32px',
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0))',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 16,
      }}>
        <div style={{
          color: 'var(--text-faint)', fontSize: 14, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em', minWidth: 0,
        }}>
          {v.series && v.currentEpisode && (
            <span>
              <span style={{ color: 'rgba(255,255,255,0.65)' }}>
                {v.series.title}
                {v.currentEpisode.seasonName && (
                  <span style={{ opacity: 0.7 }}> — {v.currentEpisode.seasonName}</span>
                )}
              </span>
              <span style={{ margin: '0 8px', opacity: 0.5 }}>·</span>
              <span style={{ color: '#fff' }}>
                Ep {String(v.currentEpisode.n).padStart(2, '0')} — {v.currentEpisode.title}
              </span>
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!isPoppedWindow() && (
            <HeaderBtn
              onClick={() => {
                if (!v.series || !v.currentEpisode) return;
                const encoded = v.series.path.split('/').map(encodeURIComponent).join('/');
                const ep = v.episodeIdx ?? 0;
                const url = window.location.origin + '/#/player/' + encoded + '?ep=' + ep;
                window.open(url, 'video-popout', 'popup,width=1280,height=720');
                v.closePlayer();
              }}
              title="Pop out to its own window"
            >↗</HeaderBtn>
          )}
          {!isPoppedWindow() && (
            <HeaderBtn onClick={() => {
              window.location.hash = '/pulse/today';
            }} title="Minimize to mini player">▾</HeaderBtn>
          )}
          <HeaderBtn onClick={() => {
            v.closePlayer();
            if (isPoppedWindow()) { try { window.close(); } catch {} }
          }} title="Close player">×</HeaderBtn>
        </div>
      </div>

      {/* Bottom controls — opaque candy deck (overlay, fades on idle). */}
      <div className="candy-deck" style={{
        ...fadeStyle,
        position: 'absolute', left: 16, right: 16, bottom: 16,
        // Bottom pad = top column gap (10) + --candy-depth-small so the controls'
        // downward candy shadow clears and they read vertically centered between
        // the seek bar and the dock's bottom edge. All dock controls use the small
        // depth (buttons via the shared override ~styles.css:686, dropdowns via
        // the select shape's --candy-depth-small), so clear for that, not 7px.
        padding: `12px 16px ${candyGap(10, true)} 16px`,
      }}>
        <VideoControls/>
      </div>
    </div>
  );
}

function PiPHost({ expand }) {
  const v = useVideoPlayer();
  return (
    <div
      className="video-cinema candy-panel"
      style={{
        position: 'fixed',
        right: 312, bottom: 16,        // sit just left of the dock
        width: 280, height: 158,
        overflow: 'hidden',
        zIndex: 1400,
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
      }}
      onClick={expand}
      title="Click to expand"
    >
      <video
        ref={v.videoRef}
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
        playsInline
        muted={false}
      />
      <div style={{
        position: 'absolute', top: 6, right: 6,
        display: 'flex', gap: 4,
      }}>
        <PiPBtn onClick={(e) => { e.stopPropagation(); v.toggle(); }}>
          {v.isPlaying ? '❚❚' : '▶'}
        </PiPBtn>
        <PiPBtn onClick={(e) => { e.stopPropagation(); v.closePlayer(); }}>×</PiPBtn>
      </div>
    </div>
  );
}

function HeaderBtn({ children, onClick, title }) {
  return (
    <button
      onClick={onClick} title={title}
      data-own-press
      className="candy-btn"
      data-shape="icon"
    ><span className="candy-face" style={{ fontSize: 19 }}>{children}</span></button>
  );
}

function PiPBtn({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      data-own-press
      className="candy-btn"
      data-shape="circle"
    ><span className="candy-face">{children}</span></button>
  );
}
