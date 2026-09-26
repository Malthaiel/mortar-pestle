// Framed image popup for hero artwork (anime poster, character / staff portrait).
// Reuses the shared AppWindow chrome (titled header + close, Esc + backdrop
// dismiss, fadeIn). The panel sizes to the artwork so the image dominates, with
// a small surface frame around it. MAL images are modest-res, so we render ~25%
// above native (measured on load), capped to the viewport. Pair with useLightbox():
//
//   const lb = useLightbox();
//   <button onClick={() => lb.show(src, caption)}>…</button>
//   <ImageLightbox {...lb} accent={accent} />
//
// `aside` = a column beside the picture, as tall as it and scrolling past that
// (the album sleeve's list of every scanned picture, AlbumDetail).

import { useState, useCallback, useRef } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';

const UPSCALE = 1.25;     // render ~25% larger than native …
const VW_CAP = 0.86;      // … but never wider than 86vw …
const VH_CAP = 0.80;      // … or taller than 80vh.
const GAP = 16;           // the surface frame, and the gap to the aside

export function useLightbox() {
  const [state, setState] = useState({ open: false, src: null, caption: '' });
  const show = useCallback((src, caption = '') => {
    if (src) setState({ open: true, src, caption });
  }, []);
  const close = useCallback(() => setState(s => ({ ...s, open: false })), []);
  return { ...state, show, close };
}

export default function ImageLightbox({ open, src, caption, close, accent, aside }) {
  // Kept across a source change (no reset): the old size holds until the new
  // picture loads, so picking one from the aside doesn't flash it at native size.
  const [dims, setDims] = useState(null);
  const asideRef = useRef(null);

  if (!open || !src) return null;

  const onLoad = (e) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    if (!nw || !nh) return;
    let w = nw * UPSCALE;
    let h = nh * UPSCALE;
    const side = asideRef.current ? asideRef.current.getBoundingClientRect().width + GAP : 0;
    const s = Math.min(1, (window.innerWidth * VW_CAP - side) / w, (window.innerHeight * VH_CAP) / h);
    setDims({ w: Math.round(w * s), h: Math.round(h * s) });
  };

  return (
    <AppWindow
      open={open}
      onClose={close}
      title={caption || 'Artwork'}
      accent={accent}
      width="auto"
      height="auto"
      bodyStyle={{
        flex: 'none', padding: GAP, overflow: 'hidden', overflowY: 'hidden',
        background: 'var(--surface-1)', lineHeight: 0,
        display: 'flex', gap: GAP, alignItems: 'flex-start',
      }}
    >
      {/* Panel hugs the artwork (+ a 16px surface frame); image renders ~25%
          above native, capped to the viewport. */}
      <img
        src={src}
        alt={caption || ''}
        onLoad={onLoad}
        style={{
          display: 'block', margin: '0 auto', borderRadius: 6, objectFit: 'contain',
          width: dims ? dims.w : 'auto', height: dims ? dims.h : 'auto',
          maxWidth: '86vw', maxHeight: '80vh',
        }}
      />
      {aside && (
        <div ref={asideRef} style={{ flexShrink: 0, maxHeight: dims ? dims.h : '80vh', overflowY: 'auto' }}>
          {aside}
        </div>
      )}
    </AppWindow>
  );
}
