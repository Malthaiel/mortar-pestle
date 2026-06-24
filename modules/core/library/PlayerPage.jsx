// Standalone video player route. Opened via window.open() into its own OS
// window (so the Fullscreen API works outside of Obsidian's webview host).
//
// URL format: #/player/<encodedSeriesPath>?ep=<index>
//
// Renders ONLY the VideoPlayerProvider + its modal — no sidebar, no dock,
// no other chrome. The modal already covers the full viewport, so the popped
// window is effectively kiosk-mode for that one episode.

import { useEffect, useState } from 'react';
import { videoApi } from './api.js';
import { VideoPlayerProvider, useVideoPlayer } from './VideoPlayerProvider.jsx';

function parseHash(hash) {
  // hash looks like "#/player/<encodedPath>?ep=<n>"
  const after = hash.replace(/^#\/player\/?/, '');
  const [pathPart, query] = after.split('?');
  const seriesPath = pathPart ? decodeURIComponent(pathPart) : '';
  const params = new URLSearchParams(query || '');
  const ep = Number(params.get('ep') || '0');
  return { seriesPath, ep: Number.isFinite(ep) ? ep : 0 };
}

function AutoPlay() {
  const player = useVideoPlayer();
  const [error, setError] = useState(null);

  useEffect(() => {
    const { seriesPath, ep } = parseHash(window.location.hash);
    if (!seriesPath) { setError('No series path in URL'); return; }
    let cancelled = false;
    videoApi.readSeries(seriesPath)
      .then(series => {
        if (cancelled) return;
        const idx = series.episodes[ep] && series.episodes[ep].available
          ? ep
          : series.episodes.findIndex(e => e.available);
        if (idx < 0) { setError('No available episodes'); return; }
        player.playSeries(series, idx);
      })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div style={{
        position: 'fixed', inset: 0,
        background: '#000', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono, monospace)', fontSize: 13,
      }}>
        Player error: {error}
      </div>
    );
  }
  return null; // ModalHost renders itself from inside VideoPlayerProvider
}

export default function PlayerPage() {
  useEffect(() => {
    document.title = 'Video Player';
    document.body.style.background = '#000';
    return () => { document.body.style.background = ''; };
  }, []);
  return (
    <VideoPlayerProvider>
      <AutoPlay/>
    </VideoPlayerProvider>
  );
}
