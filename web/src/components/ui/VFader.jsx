// VFader — vertical fader (0..1, top = max). Custom pointer-drag because
// rotated range inputs are unreliable in the webview. Draft via onDraft during
// the gesture; onCommit fires on release with the final value (read from a ref,
// never the stale closure).
//
// Promoted from the video editor's MixSuite (Broadcast SP6 SF1) — callers are
// MixSuite's channel strips and Broadcast's mixer strip.

import { useRef } from 'react';
import { GLIDE } from '../../util/motion.js';

export default function VFader({ value, onDraft, onCommit, accent }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const lastRef = useRef(value);
  const valFrom = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
  };
  const down = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const v = valFrom(e); lastRef.current = v; onDraft(v);
  };
  const move = (e) => { if (!draggingRef.current) return; const v = valFrom(e); lastRef.current = v; onDraft(v); };
  const up = () => { if (!draggingRef.current) return; draggingRef.current = false; onCommit(lastRef.current); };
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      ref={trackRef}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{ position: 'relative', width: 24, height: '100%', cursor: 'ns-resize', display: 'flex', justifyContent: 'center' }}
    >
      <div style={{ width: 4, height: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }} />
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 0, width: 4, height: `${pct}%`, background: accent, borderRadius: 3, pointerEvents: 'none', transition: `height ${GLIDE}` }} />
      <div style={{ position: 'absolute', left: '50%', transform: 'translate(-50%, 50%)', bottom: `${pct}%`, width: 18, height: 10, background: 'var(--text)', borderRadius: 3, boxShadow: '0 1px 3px rgba(0,0,0,0.45)', pointerEvents: 'none', transition: `bottom ${GLIDE}` }} />
    </div>
  );
}
