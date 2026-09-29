// A fused candy run (.candy-split) that leads with a search field and behaves
// as ONE button (user-directed 2026-09-24). Once the typed text is about to
// outgrow the field (user-directed 2026-09-25; focusing alone no longer does
// it), every part after it slides to the right, out through the run's own
// rounded end, and the field takes the whole row. Delete back until it fits
// and the parts slide home. The row never changes size: the run grows past a
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
//   leading           optional parts fused BEFORE the field; they never slide
//                     (the Music bar's Home button, user-directed 2026-09-25)
//   compact           the field rests as a square magnifier, one --cbtn-size
//                     wide, and the parts slide as soon as it is clicked or
//                     focused (the tree sidebars, user-directed 2026-09-25)
//   inputRef          optional ref the caller gets the <input> through (focus it
//                     from a hotkey -- the Settings tree's `/`)
//   onKeyDown         optional key handler run before the field's own Esc

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconSearch } from '../icons.jsx';
import { GLIDE } from '../../util/motion.js';

// Width of `text` in the input's own live font, read off a canvas.
let ctx;
function textWidth(el, text) {
  ctx ??= document.createElement('canvas').getContext('2d');
  ctx.font = getComputedStyle(el).font;
  return ctx.measureText(text).width;
}

// Search icon size; compact centres it in a square part.
const ICON = 14;

export default function SearchRun({ value, onChange, placeholder = 'Search', size, leading, compact, inputRef: outerInputRef, onKeyDown, children }) {
  const winRef = useRef(null);
  const runRef = useRef(null);
  const partRef = useRef(null);
  const inputRef = useRef(null);
  const restRef = useRef(null);
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
  // early. Typed without a press (keyboard focus), it opens on the first check.
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
    const parts = [...runRef.current.children];
    parts.slice(parts.indexOf(partRef.current) + 1).forEach(el => { el.inert = open; });
  });

  // The window opens below by the DEEPEST lip among the parts, read off them
  // live -- a written-in depth cut the bottom off any part deeper than it (the
  // tree toolbar's nav-depth buttons, 2026-09-25). Computed custom properties
  // come back with their var()s resolved, so max() takes them as they are.
  const [lip, setLip] = useState('var(--candy-depth-small)');
  useLayoutEffect(() => {
    // The field itself is skipped: it wears this same value (below), so reading it
    // back would feed the max() into itself on every render.
    const d = [...runRef.current.children].filter((el) => el !== partRef.current)
      .map((el) => getComputedStyle(el).getPropertyValue('--cbtn-depth').trim()).filter(Boolean);
    const next = d.length ? `max(${d.join(', ')})` : 'var(--candy-depth-small)';
    if (next !== lip) setLip(next);
  });

  const endRadius = arrived ? 'calc(var(--corner) * var(--corner-max))' : undefined;
  // compact at rest: the icon's side padding that makes the part a square.
  // Only the right side changes on open, so the magnifier never moves.
  const squarePad = `calc((var(--cbtn-size) - 2 * var(--cbtn-frame) - ${ICON}px) / 2)`;

  return (
    <div ref={winRef} style={{
      '--cbtn-size': size,
      width: geo ? geo.w : 'max-content',
      // The window. Straight on the left (the first part's own round end sits
      // inside it), rounded on the right exactly like the run's end, and open below by
      // the parts' small lip so their depth band still shows.
      clipPath: `inset(0 0 calc(${lip} * -1) 0 round 0 calc(var(--corner) * var(--cbtn-size) / 2) calc(var(--corner) * var(--cbtn-size) / 2) 0)`,
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
        {leading}
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
            flex: geo ? '1 1 0' : 'none', width: compact && !geo ? 'var(--cbtn-size)' : 'auto', minWidth: 0,
            // While open the field owns the seam, so the first hidden part's
            // left frame cannot show as a grey sliver at the row's end.
            zIndex: open ? 3 : undefined,
            // As deep as its deepest neighbour: chip-field's own small lip ended
            // the magnifier 1px above the tree toolbar's nav-depth buttons
            // (photographed 2026-09-29). With no neighbours, lip is its own depth.
            '--cbtn-depth': lip,
            borderStartEndRadius: endRadius,
            borderEndEndRadius: endRadius,
          }}
          onMouseDown={(e) => {
            if (e.target === inputRef.current) return;
            e.preventDefault();
            inputRef.current.focus();
          }}
        >
          {/* Grid, not the face's flex: a hidden copy of the placeholder and
              the input share one cell, so at rest the field hugs the
              placeholder whatever is typed, and a short word cannot shrink the
              row (user-directed 2026-09-25). Open, the cell takes the rest. */}
          <span className="candy-face" style={{
            padding: compact ? `5px ${geo ? 'var(--chip-pad-x)' : squarePad} 5px ${squarePad}` : '5px var(--chip-pad-x)',
            gap: compact && !geo ? 0 : 'var(--candy-face-gap)',
            display: 'grid', gridTemplateColumns: 'auto 1fr', alignItems: 'center',
          }}>
            <IconSearch size={ICON} />
            {/* justifySelf start: the copy keeps its own width while the open
                row stretches the cell, so it always reads the RESTING width. */}
            <span ref={restRef} aria-hidden className="chip-field-input" style={{
              gridArea: '1 / 2', justifySelf: 'start', visibility: 'hidden', whiteSpace: 'pre', padding: 0, lineHeight: 'normal',
            }}>{compact ? '' : placeholder}</span>
            <input
              ref={(el) => { inputRef.current = el; if (outerInputRef) outerInputRef.current = el; }}
              className="chip-field-input"
              type="text"
              value={value}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v);
                if (compact) return; // compact slides on focus, not on overflow
                // Opens a letter early: once one more of the last-typed letter
                // would not fit the RESTING field (as wide as the hidden
                // placeholder copy), so the text never runs under the edge.
                // Back under that line, it slides home, even mid-wait.
                if (textWidth(e.target, v + v.slice(-1)) > restRef.current.offsetWidth) {
                  if (!open) openWhenUp();
                } else closeRun();
              }}
              placeholder={compact && !open ? '' : placeholder}
              onFocus={compact ? openWhenUp : undefined}
              onBlur={() => { if (!value.trim()) closeRun(); }}
              onKeyDown={(e) => {
                onKeyDown?.(e);
                if (e.key !== 'Escape') return;
                onChange('');
                closeRun();
                e.currentTarget.blur();
              }}
              // padding 0: the face already carries the chips' padding. line-height
              // normal: the field's shared 1.4 painted the word a pixel above the
              // chip labels beside it. width 0 + minWidth 100%: the input adds
              // nothing to the cell's size, then fills whatever the placeholder
              // copy (or the open row) made it.
              style={{ gridArea: '1 / 2', padding: 0, lineHeight: 'normal', width: 0, minWidth: '100%' }}
            />
          </span>
        </span>
        {children}
      </div>
    </div>
  );
}
