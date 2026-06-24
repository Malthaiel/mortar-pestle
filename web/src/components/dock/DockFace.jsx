// The candy-face shared by every dock button. A centred glyph at rest; on the
// button's hover/focus the .dock-btn-label is revealed and the button's WIDTH
// animates to fit it (geometry + transition in styles.css). To keep that grow
// smooth AND tight to each label, we measure the label box here and publish it
// as --dock-expanded-w on the button (= 36px glyph square + label width).
// Used by DockButton, which ModuleDockButton and NotificationBell delegate to.

import { useLayoutEffect, useRef } from 'react';

// The collapsed dock-button width (px). Expanded width = this + the label box,
// which leaves room for the label beside the centred 36px glyph square.
const REST_W = 36;

export default function DockFace({ label, children }) {
  const labelRef = useRef(null);

  useLayoutEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    const btn = el.closest('.candy-btn');
    if (!btn) return;
    // offsetWidth = label text + padding-right, reported even while the label is
    // clipped/faded, so the expanded width is exact. Re-measured on font load /
    // label change via the observer.
    const measure = () => btn.style.setProperty('--dock-expanded-w', `${REST_W + el.offsetWidth}px`);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [label]);

  return (
    <span className="candy-face">
      <span className="dock-btn-glyph">{children}</span>
      <span className="dock-btn-label" ref={labelRef}>{label}</span>
    </span>
  );
}
