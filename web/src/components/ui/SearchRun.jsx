// A fused candy run (.candy-split) that leads with a search field and behaves
// as ONE button (user-directed 2026-09-24). Focusing the field slides every
// part after it to the right, out through the run's own rounded end, and the
// field takes the whole row. The row never changes size: the run grows past a
// clipping window, not the window itself. Blur with an empty box, or Esc,
// slides the parts back.
//
// Props:
//   value, onChange   the search text (onChange receives the string)
//   placeholder       field placeholder (default 'Search')
//   size              REQUIRED --cbtn-size for the run: every part's height, the
//                     seam, and the window's rounded end all derive from it
//   children          the other fused parts -- bare .candy-btn elements
//                     (CandySelect needs `fuse`), exactly as inside .candy-split

import { useEffect, useRef, useState } from 'react';
import { IconSearch } from '../icons.jsx';
import { GLIDE } from '../../util/motion.js';

export default function SearchRun({ value, onChange, placeholder = 'Search', size, children }) {
  const winRef = useRef(null);
  const runRef = useRef(null);
  const partRef = useRef(null);
  const inputRef = useRef(null);
  const waitRef = useRef(0);
  const [open, setOpen] = useState(false);
  // Read off the live rects the moment it opens, held until the glide back ends:
  // `w` pins the window at its resting width (every part hugs its own label, so
  // the row is always the same size -- user-directed 2026-09-25), `push` is the
  // room the other parts take up, which the field grows by.
  const [geo, setGeo] = useState(null);
  // The field reached the end: its own right corners round off so its outline
  // follows the window's rounded end instead of being cut by it.
  const [arrived, setArrived] = useState(false);

  const openRun = () => {
    if (!geo) setGeo({
      w: winRef.current.getBoundingClientRect().width,
      push: runRef.current.getBoundingClientRect().right - partRef.current.getBoundingClientRect().right,
    });
    setOpen(true);
  };
  // The slide starts only once the pressed field is fully back up (user-directed
  // 2026-09-25): no press state left on it AND its face measured at rest.
  // Starting as the face began rising was tried the same day and read as too
  // early. A keyboard focus has no press, so it opens on the first check.
  const openWhenUp = () => {
    cancelAnimationFrame(waitRef.current);
    const part = partRef.current;
    const tick = () => {
      if (document.activeElement !== inputRef.current) return;
      const up = !part.matches(':active, .is-pressed, [data-candy-pressed]')
        && getComputedStyle(part.firstElementChild).transform === 'none';
      if (up) openRun(); else waitRef.current = requestAnimationFrame(tick);
    };
    tick();
  };
  const closeRun = () => { cancelAnimationFrame(waitRef.current); setOpen(false); setArrived(false); };
  useEffect(() => () => cancelAnimationFrame(waitRef.current), []);
  // geo normally clears when the glide back ends. With no glide running (open
  // and close landed in one frame, or the row was hidden mid-glide) no
  // transitionend ever comes, so clear it now -- a stuck geo pinned the window
  // at a stale width and squeezed the field to "S" (2026-09-25).
  const settle = () => { if (!open && !runRef.current.getAnimations().length) setGeo(null); };
  useEffect(settle, [open, geo]);

  // The parts pushed out of sight leave the Tab order and the accessibility tree.
  // Every render, so a part that remounts while open is caught too.
  useEffect(() => {
    [...runRef.current.children].slice(1).forEach(el => { el.inert = open; });
  });

  const endRadius = arrived ? 'calc(var(--corner) * var(--corner-max))' : undefined;

  return (
    <div ref={winRef} style={{
      '--cbtn-size': size,
      width: geo ? geo.w : 'max-content',
      // The window. Straight on the left (the field's own round end sits inside
      // it), rounded on the right exactly like the run's end, and open below by
      // the parts' small lip so their depth band still shows.
      clipPath: 'inset(0 0 calc(var(--candy-depth-small) * -1) 0 round 0 calc(var(--corner) * var(--cbtn-size) / 2) calc(var(--corner) * var(--cbtn-size) / 2) 0)',
    }}>
      <div
        ref={runRef}
        className="candy-split"
        style={{
          display: 'flex',
          width: open ? `calc(100% + ${geo.push}px)` : '100%',
          transition: `width ${GLIDE}`,
        }}
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget || e.propertyName !== 'width') return;
          if (open) setArrived(true); else setGeo(null);
        }}
        onTransitionCancel={(e) => { if (e.target === e.currentTarget) settle(); }}
      >
        {/* The text-field master (chip-field, as TaskChip / ChatInput), padded
            like the chips beside it so icon and word sit where theirs do. */}
        <span
          ref={partRef}
          className="candy-btn"
          data-shape="chip-field"
          style={{
            // At rest the field hugs its icon + word like every other part; only
            // while sliding or open does it take the row's growing width.
            // width auto beats chip-field's own `width: 100%`, which otherwise
            // takes the whole row the window sized from all four parts.
            flex: geo ? '1 1 0' : 'none', width: 'auto', minWidth: 0,
            // While open the field owns the seam, so the first hidden part's
            // left frame cannot show as a grey sliver at the row's end.
            zIndex: open ? 3 : undefined,
            borderStartEndRadius: endRadius,
            borderEndEndRadius: endRadius,
          }}
          onMouseDown={(e) => {
            if (e.target === inputRef.current) return;
            e.preventDefault();
            inputRef.current.focus();
          }}
        >
          <span className="candy-face" style={{ padding: '5px var(--chip-pad-x)', gap: 'var(--candy-face-gap)' }}>
            <IconSearch size={14} />
            <input
              ref={inputRef}
              className="chip-field-input"
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              onFocus={openWhenUp}
              onBlur={() => { if (!value.trim()) closeRun(); }}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                onChange('');
                closeRun();
                e.currentTarget.blur();
              }}
              // padding 0: the face already carries the chips' padding. line-height
              // normal: the field's shared 1.4 painted the word a pixel above the
              // chip labels beside it. field-sizing: the box is as wide as its
              // placeholder, measured by the browser, so the part hugs "Search".
              style={{ padding: 0, lineHeight: 'normal', fieldSizing: 'content' }}
            />
          </span>
        </span>
        {children}
      </div>
    </div>
  );
}
