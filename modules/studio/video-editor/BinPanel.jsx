// Bin pane (Cuts NLE SF4): clip cards — name, duration, resolution, codec
// badge — with remuxing/offline/error states and ONE poster frame per card.
// Posters are one-shot canvas captures from an offscreen <video> over the
// loopback proxy URL (crossorigin anonymous; the media server sends ACAO *),
// session-cached by proxyHash, never persisted. This is NOT the deferred
// filmstrip system. Decided copy: panel title **Bin**; the empty state points
// at the one action (Import clips).

import { useEffect, useRef, useState } from 'react';
import { PrimaryBtn } from '@host/components/ui/Button.jsx';

const mono = { fontFamily: '"DM Mono", monospace' };

const posterCache = new Map(); // proxyHash → dataURL | null(claimed)

function capturePoster(url, atSec) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.preload = 'auto';
    let done = false;
    const cleanup = () => { v.removeAttribute('src'); try { v.load(); } catch {} };
    const fail = (e) => { if (!done) { done = true; cleanup(); reject(e); } };
    const timer = setTimeout(() => fail(new Error('poster timeout')), 8000);
    v.addEventListener('error', () => { clearTimeout(timer); fail(new Error('poster decode error')); });
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = Math.min(atSec, Math.max(0, (v.duration || 2) - 0.5));
    });
    v.addEventListener('seeked', () => {
      // One settle tick after `seeked` — rVFC is dead on WebKitGTK (SF1
      // finding), so there's no frame-presented callback to wait on.
      setTimeout(() => {
        try {
          const w = 320;
          const h = Math.max(1, Math.round(w * (v.videoHeight / Math.max(1, v.videoWidth))));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          const data = c.toDataURL('image/jpeg', 0.72);
          clearTimeout(timer);
          if (!done) { done = true; cleanup(); resolve(data); }
        } catch (e) {
          clearTimeout(timer);
          fail(e);
        }
      }, 120);
    });
    v.src = url;
  });
}

function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const STATE_BADGE = {
  remuxing: { text: 'remuxing…', color: 'var(--text-faint)' },
  offline: { text: 'offline', color: 'var(--error)' },
  error: { text: 'error', color: 'var(--error)' },
};

export default function BinPanel({
  media,
  status,        // Map media.id → 'ready' | 'remuxing' | 'offline' | 'error'
  urls,          // Map media.id → /editor-proxy/ URL
  selectedId,
  onSelect,
  onDragToTimeline, // (media, pointerEvent) — SF6 bin→timeline drag start
  onImport,
  importing,
  statusText,
  errors,        // [{ name, reason }]
  onDismissErrors,
  overBudget,
  accent,
}) {
  const [posters, setPosters] = useState(() => new Map(posterCache));
  const queueRef = useRef(Promise.resolve());

  useEffect(() => {
    for (const m of media) {
      const url = urls.get(m.id);
      if (!url || posterCache.has(m.proxyHash)) continue;
      posterCache.set(m.proxyHash, null); // claim — one capture per hash
      queueRef.current = queueRef.current.then(async () => {
        try {
          const data = await capturePoster(url, Math.min(1, (m.duration || 10) * 0.1));
          posterCache.set(m.proxyHash, data);
        } catch {
          posterCache.delete(m.proxyHash);
        }
        setPosters(new Map(posterCache));
      });
    }
  }, [media, urls]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', flex: 1 }}>
          Bin
        </div>
        <PrimaryBtn chip accent={accent} onClick={onImport} disabled={importing}>
          {importing ? 'Importing…' : 'Import'}
        </PrimaryBtn>
      </div>
      {statusText && (
        <div style={{ ...mono, fontSize: 11, color: 'var(--text-faint)', padding: '0 12px 6px' }}>{statusText}</div>
      )}
      {overBudget && (
        <div style={{ ...mono, fontSize: 11, color: '#d9a050', padding: '0 12px 6px' }}>
          proxy cache over the 20 GB budget
        </div>
      )}
      {errors?.length > 0 && (
        <div style={{ margin: '0 12px 8px', padding: '8px 10px', border: '1px solid color-mix(in oklch, var(--error) 33%, transparent)', borderRadius: 8 }}>
          {errors.map((e, i) => (
            <div key={i} style={{ ...mono, fontSize: 11, color: 'var(--error)', marginBottom: 2 }}>
              {e.name}: {e.reason}
            </div>
          ))}
          <button
            onClick={onDismissErrors}
            style={{ ...mono, fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            dismiss
          </button>
        </div>
      )}
      {media.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '4px 12px' }}>
          Import clips to start cutting.
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {media.map((m) => {
            const st = status.get(m.id) || 'remuxing';
            const badge = STATE_BADGE[st];
            const poster = posters.get(m.proxyHash);
            const name = m.src.split('/').pop();
            const selected = m.id === selectedId;
            return (
              <div
                key={m.id}
                onClick={() => onSelect?.(m.id)}
                onPointerDown={(e) => onDragToTimeline?.(m, e)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(m.id); }}
                style={{
                  border: `1px solid ${selected ? (accent || 'var(--accent)') : 'var(--border)'}`,
                  boxShadow: selected ? `0 0 0 1px ${accent || 'var(--accent)'}` : 'none',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: 'var(--surface)',
                  opacity: st === 'offline' ? 0.65 : 1,
                  cursor: 'pointer',
                  // Column-flex scroll container: without this the cards
                  // compress to fit the viewport and overflow:hidden clips
                  // the name/meta block below the poster.
                  flexShrink: 0,
                }}
              >
                <div style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', position: 'relative' }}>
                  {poster && (
                    <img src={poster} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  )}
                  <span style={{ ...mono, position: 'absolute', left: 6, bottom: 6, fontSize: 10.5, color: '#fff', background: 'rgba(0,0,0,0.55)', padding: '2px 6px', borderRadius: 6, maxWidth: '82%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name || '(unnamed)'}
                  </span>
                  {badge && (
                    <span style={{ ...mono, position: 'absolute', top: 6, right: 6, fontSize: 10.5, color: badge.color, background: 'rgba(0,0,0,0.55)', padding: '2px 6px', borderRadius: 6 }}>
                      {badge.text}
                    </span>
                  )}
                </div>
                <div style={{ padding: '7px 9px' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.src}>
                    {name || m.src || '(unnamed)'}
                  </div>
                  <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2, display: 'flex', gap: 8 }}>
                    <span>{fmtDur(m.duration)}</span>
                    {m.width && m.height ? <span>{m.width}×{m.height}</span> : null}
                    {m.fps ? <span>{Math.round(m.fps * 1000) / 1000} fps</span> : null}
                    {m.codec ? <span style={{ textTransform: 'uppercase' }}>{m.codec}</span> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
