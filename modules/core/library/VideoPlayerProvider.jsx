// Single source of truth for video playback — the PLAYLIST and the window, not
// the picture. `MpvHost` owns the picture (an OS window drawn by mpv into a
// child HWND) and the only live clock; `PlayerControlsView` owns the control
// bar and talks to mpv over JSON IPC. This provider holds what neither of them
// can: which series and episode are open, the resume target, the subtitle
// settings shared by both windows, and the error/preparing surface.
//
// Native Video Player Phase 6 (2026-08-29) deleted the old <video> lane from
// this file: the element, its host components, the whole-episode ffmpeg remux,
// the WebVTT extraction and overlay, the position clock, and the `USE_MPV`
// constant that gated them. Anything here that needs a POSITION must ask mpv
// for `time-pos` — `MpvHost`'s prev handler is the worked example.

import {
  createContext, useContext, useEffect, useMemo, useRef, useState, useCallback,
} from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Exported so a NON-<video> backend can supply the same shape: the mpv
// controls layer is its own webview with no player element in it, and it
// renders VideoControls verbatim by providing this context itself rather than
// forking a parallel control bar.
export const VideoPlayerContext = createContext(null);
const Ctx = VideoPlayerContext;

// Exported so every surface persists to the SAME keys — volume, speed and
// resume position must survive a switch of window.
export const LS = {
  volume:   'video:volume',
  speed:    'video:speed',
  subPref:  'video:subPref',   // language code, or 'off'
  audPref:  'video:audPref',   // language code
  progress: 'video:progress',  // { [fileAbs]: { time, duration, savedAt } }
  subSettings: 'video:subSettings',  // global subtitle rendering config
  subSync:  'video:subSync',   // { [fileAbs]: offsetSeconds }
};

// Every key here drives a real mpv property — see `subProps` in
// PlayerControlsView.jsx, which is the only translation point. `fontFamily` and
// `lineHeight` were dropped in Phase 5: mpv has no line-height property at all,
// and the app's DM Sans / DM Mono are bundled web fonts that mpv (DirectWrite)
// cannot resolve, so both rows were controls wired to nothing.
export const DEFAULT_SUB_SETTINGS = {
  // false → mpv's own ASS rendering, signs and karaoke intact, and only size /
  // position / sync apply. true → sub-ass-override=force, every row below
  // applies, at the cost of flattening typeset signs.
  assOverride: false,
  size: 28,            // px at the default; drives sub-scale = size / 28
  bgStyle: 'box',      // 'box' | 'shadow' | 'outline' | 'none'
  bgOpacity: 0.7,      // 0..1, only when bgStyle === 'box'
  shadowSize: 4,       // px offset, only when bgStyle === 'shadow'
  outlineSize: 2,      // px stroke width, only when bgStyle === 'outline'
  position: 0.9,       // 0..1 from top
  fontWeight: 700,     // 400 | 700 — mpv's sub-bold is a flag, not a scale
  letterSpacing: 0,    // px → sub-spacing
};

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
export function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function inferModeFromHash() {
  const h = window.location.hash || '';
  if (h.startsWith('#/tools/library/anime') || h.startsWith('#/player')) return 'modal';
  return 'pip';
}

export function VideoPlayerProvider({ children }) {
  // Series + episode playlist context
  const [series, setSeries] = useState(null);          // full series object
  const [episodeIdx, setEpisodeIdx] = useState(-1);
  // Open/error surface — MpvHost sets both while it brings a window up.
  const [preparing, setPreparing] = useState(false);
  const [streamError, setStreamError] = useState(null);
  const [reloadNonce, setReloadNonce] = useState(0);   // bump → MpvHost reopens the same episode
  // Subtitle rendering settings — shared by both windows, applied by mpv.
  const [subSettings, _setSubSettingsState] = useState(() => ({
    ...DEFAULT_SUB_SETTINGS,
    ...(loadJSON(LS.subSettings, {}) || {}),
  }));
  const [subSyncMap, _setSubSyncMapState] = useState(() => loadJSON(LS.subSync, {}) || {});
  // UI mode — derived from URL hash; switches modal↔pip on nav.
  const [mode, setMode] = useState(() => typeof window !== 'undefined' ? inferModeFromHash() : 'modal');

  const fullscreenHostRef = useRef(null);
  const watchedFiredRef = useRef(new Set()); // fileAbs values we've already marked
  const resumePosRef = useRef(0); // start position (seconds) MpvHost opens mpv at

  const currentEpisode = series && episodeIdx >= 0 && episodeIdx < series.episodes.length
    ? series.episodes[episodeIdx]
    : null;
  const playerOpen = !!currentEpisode;

  // Track hash → mode
  useEffect(() => {
    const onHash = () => setMode(inferModeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
    // Bumped even when the episode is unchanged: pressing play on the episode
    // already loaded must restart it. That is also the only recovery from a
    // player that died or was closed from outside the app — the file has not
    // changed, so nothing else would ever reopen it.
    setReloadNonce(n => n + 1);
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
  }, []);

  const next = useCallback(() => {
    if (!series) return;
    for (let i = episodeIdx + 1; i < series.episodes.length; i++) {
      if (series.episodes[i].available) { playEpisodeAt(i, 0); return; }
    }
  }, [series, episodeIdx, playEpisodeAt]);

  // Plain step-back. The "restart the current episode past 3 s" decision lives
  // in MpvHost's player-control handler, which is the only caller and the only
  // place that owns the live clock — it reads time-pos off mpv and seeks to 0
  // itself, falling through to this only when it means the previous episode.
  const prev = useCallback(() => {
    if (!series) return;
    for (let i = episodeIdx - 1; i >= 0; i--) {
      if (series.episodes[i].available) { playEpisodeAt(i, 0); return; }
    }
  }, [series, episodeIdx, playEpisodeAt]);

  // Drop WS_MAXIMIZE before going fullscreen, put it back on the way out.
  //
  // Windows clamps a MAXIMIZED window's client area to the monitor WORK AREA no
  // matter how large the frame is, and wry's fullscreen handler stretches the
  // frame without clearing the flag. Measured 2026-08-31 on a 1920x1080 monitor
  // with a 48px taskbar: window rect 1920x1080, client rect 1920x1032,
  // IsZoomed() true — the webview, MPPlayerHost and mpv all stopped at 1032 and
  // the leftover 48px of frame painted as the window class background, i.e. a
  // white bar under a picture that never actually reached fullscreen.
  //
  // The restore rides `fullscreenchange` rather than the exit branch below, so
  // Esc leaves the window maximised too — not only the controls-bar button.
  const wasMaximizedRef = useRef(false);

  const requestFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(e => console.error('exitFullscreen failed:', e));
      return;
    }
    const target = fullscreenHostRef.current;
    if (!target) return;
    const win = getCurrentWindow();
    try {
      wasMaximizedRef.current = await win.isMaximized();
      if (wasMaximizedRef.current) await win.unmaximize();
    } catch { wasMaximizedRef.current = false; }
    target.requestFullscreen().catch(e => console.error('requestFullscreen failed:', e));
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      if (document.fullscreenElement || !wasMaximizedRef.current) return;
      wasMaximizedRef.current = false;
      getCurrentWindow().maximize().catch(() => {});
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const closePlayer = useCallback(() => {
    setSeries(null);
    setEpisodeIdx(-1);
  }, []);

  const value = useMemo(() => ({
    // state
    series, currentEpisode, episodeIdx, mode, playerOpen,
    // subtitles
    subSettings, subSync,
    // error + loading surface (set by MpvHost)
    streamError, preparing,
    // actions
    playSeries, playEpisodeAt, next, prev,
    requestFullscreen, closePlayer,
    updateSubSetting, resetSubSettings, nudgeSubSync, resetSubSync,
    // the host owns the picture, so it owns the two flags it sets for itself,
    // and reads the resume target straight off the ref (a memoised copy would
    // be a frame behind the episode that set it).
    fullscreenHostRef, setPreparing, setStreamError, resumePosRef, reloadNonce,
  }), [
    series, currentEpisode, episodeIdx, mode, playerOpen,
    subSettings, subSync, streamError, preparing, reloadNonce,
    playSeries, playEpisodeAt, next, prev,
    requestFullscreen, closePlayer,
    updateSubSetting, resetSubSettings, nudgeSubSync, resetSubSync,
  ]);

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  );
}

export function useVideoPlayer() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVideoPlayer must be used inside <VideoPlayerProvider>');
  return v;
}

// Exported for the controls layer: under mpv the window buttons move into the
// overlay, and they must be the SAME button, not a lookalike rebuilt there.
export function HeaderBtn({ children, onClick, title }) {
  return (
    <button
      onClick={onClick} title={title}
      data-own-press
      className="candy-btn"
      data-shape="icon"
    ><span className="candy-face" style={{ fontSize: 19 }}>{children}</span></button>
  );
}

// Exported alongside HeaderBtn: the mpv controls layer renders the PiP chrome
// too, and it must be this button, not a copy of it.
export function PiPBtn({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      data-own-press
      className="candy-btn"
      data-shape="circle"
    ><span className="candy-face">{children}</span></button>
  );
}
