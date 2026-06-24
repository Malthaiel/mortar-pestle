// Framed image popup for hero artwork (anime poster, character / staff portrait).
// Reuses the shared AppWindow chrome (titled header + close, Esc + backdrop
// dismiss, fadeIn). The panel sizes to the artwork so the image dominates, with
// a small surface frame around it. MAL images are modest-res, so we render ~25%
// above native (measured on load), capped to the viewport. Pair with useLightbox():
//
//   const lb = useLightbox();
//   <button onClick={() => lb.show(src, caption)}>…</button>
//   <ImageLightbox {...lb} accent={accent} />

import { useState, useCallback, useEffect } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';

const UPSCALE = 1.25;     // render ~25% larger than native …
const VW_CAP = 0.86;      // … but never wider than 86vw …
const VH_CAP = 0.80;      // … or taller than 80vh.

export function useLightbox() {
  const [state, setState] = useState({ open: false, src: null, caption: '' });
  const show = useCallback((src, caption = '') => {
    if (src) setState({ open: true, src, caption });
  }, []);
  const close = useCallback(() => setState(s => ({ ...s, open: false })), []);
  return { ...state, show, close };
}

export default function ImageLightbox({ open, src, caption, close, accent }) {
  const [dims, setDims] = useState(null);
  useEffect(() => { setDims(null); }, [src]);   // re-measure on source change

  if (!open || !src) return null;

  const onLoad = (e) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    if (!nw || !nh) return;
    let w = nw * UPSCALE;
    let h = nh * UPSCALE;
    const s = Math.min(1, (window.innerWidth * VW_CAP) / w, (window.innerHeight * VH_CAP) / h);
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
        flex: 'none', padding: 16, overflow: 'hidden', overflowY: 'hidden',
        background: 'var(--surface-1)', lineHeight: 0,
      }}
    >
      {/* Panel hugs the artwork (+ a 16px surface frame); image renders ~25%
          above native, capped to the viewport. */}
      <img
        src={src}
        alt={caption || ''}
        onLoad={onLoad}
        style={{
          display: 'block', margin: '0 auto', borderRadius: 6,
          width: dims ? dims.w : 'auto', height: dims ? dims.h : 'auto',
          maxWidth: '86vw', maxHeight: '80vh',
        }}
      />
    </AppWindow>
  );
}
