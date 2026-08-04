// Fold demo — dev toy built on Josh Comeau's "Folding the DOM":
// https://www.joshwcomeau.com/react/folding-the-dom/
// Three stacked rectangles folded like a letter into thirds, driven by a click.
// Open is flat, closed is folded shut; the two folds run in sequence so the
// motion traces the same path the old 0-360 slider swept by hand. Each
// rectangle is sized and skinned to match the titlebar account chip.
import { useEffect, useState } from 'react';

// Used until the real chip is measured. Height is TitleBar's BTN; the width is
// a stand-in only — the chip has no width of its own (see measure below).
const FALLBACK = { w: 160, h: 28 };
// Camera distance. The article's 500 was sized for a 300px-tall image; against
// 28px rectangles it sits far too close, and the taper (the near edge of a
// folding flap draws wider than its hinge) reads as the rectangles changing
// shape. Pulling the camera back flattens the taper without killing the fold —
// the flap still foreshortens, which is what sells the 3D.
const PERSPECTIVE = 2000;
// Neighbouring rectangles overlap by exactly one frame, so a crease reads as a
// single 2px stroke instead of two 2px frames stacked into 4px.
const OVERLAP = -2;

// The pivot sits at the MIDDLE of the overlap, not on the flap's top edge.
// Rotating about the top edge overshoots by exactly the overlap: the edge is
// already 2px inside the rectangle above, so 180deg lands the flap 2px past it.
// Halving it makes the fold symmetric about the seam and the flap lands flush.
const HINGE_Y = -OVERLAP / 2;

// One fold. The two run back to back, so a full open or close is 2x this.
const DUR = 300;
// Fallback for the candy face's ease-down; the live value is read from
// --cbtn-press-dur on mount, since Settings → Animations rewrites it. The
// unfold waits it out so the button is fully down before the paper moves.
const PRESS_FALLBACK = 70;
// Beat after the fold shuts before the button rises, so the swap reads as one
// object settling rather than two things happening at once.
const SETTLE = 120;

// A folded flap lands exactly coplanar with what it lands on, which z-fights.
// Lifting it toward the viewer settles the order. After rotateX(180) the local
// +Z points away, so the lift is negative to stay in front at both ends.
// The delay is what sequences the letter fold: whichever hinge is meant to move
// second waits out the first one. Closing folds bottom-up, opening unfolds
// top-down, so the two delays swap with direction.
const hinge = (deg, delay) => ({
  transform: `rotateX(${deg}deg) translateZ(-1px)`,
  transformOrigin: `center ${HINGE_Y}px`,
  transition: `transform ${DUR}ms ease-in-out ${delay}ms`,
  willChange: 'transform',
});

export default function FoldPanel() {
  const [open, setOpen] = useState(true);
  // The account chip shrink-wraps its display name, so its width is per-account
  // and there is no constant to copy. Measure the live one instead of guessing.
  const [box, setBox] = useState(FALLBACK);
  const [press, setPress] = useState(PRESS_FALLBACK);
  useEffect(() => {
    const r = document.querySelector('.titlebar-account')?.getBoundingClientRect();
    if (r?.width) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    const d = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--cbtn-press-dur'));
    if (d > 0) setPress(d);
  }, []);

  // The button stays down for the whole unfolded stretch, then rises once the
  // paper is shut again. This is a held state, NOT a transition-delay on the
  // face: a delay there applies to every transform change, including the
  // mouse's own :active press, which then sat frozen for the length of the
  // delay before it would start moving.
  const [pressed, setPressed] = useState(true);
  useEffect(() => {
    if (open) { setPressed(true); return; }
    const t = setTimeout(() => setPressed(false), 2 * DUR + SETTLE);
    return () => clearTimeout(t);
  }, [open]);

  // Lifted verbatim from styles.css .candy-face + .candy-btn (--cbtn-band is
  // --surface at rest, --cbtn-frame is 2px, radius is --radius-md).
  // ponytail: copied, not classed — these are plain divs, not buttons, and
  // wearing .candy-btn would drag in the press/hover/depth machinery too.
  const skin = {
    width: box.w,
    height: box.h,
    boxSizing: 'border-box',       // frame eats into the box — rectangles stay equal
    background: 'var(--surface-3)',
    border: '2px solid color-mix(in oklch, var(--surface), black 22%)',
    borderRadius: 'var(--radius-md)',
    // A single grid cell every label shares, so the middle rectangle can stack
    // its two labels without absolute positioning.
    display: 'grid',
    placeItems: 'center',
  };

  // The account chip's face text, resolved through all three rules that reach
  // it: base .candy-face (mono, --text-muted), [data-shape="chip"] (600, no
  // uppercase), then .titlebar-account (11.5px, no letter-spacing). Shared with
  // the shut button's face below so the swap changes no glyph.
  const CHIP_TEXT = {
    fontSize: 11.5,
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
    letterSpacing: 0,
    textTransform: 'none',
  };

  const label = {
    ...CHIP_TEXT,
    gridArea: '1 / 1',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
    transition: `opacity ${DUR}ms ease-in-out`,
  };

  const deg = open ? 0 : 180;                 // both hinges share the same travel

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold</div>

      {/* Two states share one grid cell and cross-fade. The shut state cannot
          BE the folded stack: the face left showing is the middle rectangle's
          underside, and candy's depth band is a downward box-shadow that a
          flipped element points the wrong way — plus the press choreography
          needs a real <button>, not a rotated div. So the real candy button
          swaps in once the fold finishes, and the underside carries the same
          word in the same place so only the depth band appears. */}
      <div style={{ display: 'grid', width: box.w }}>
        {/* Shut state. Real .candy-btn / .candy-face, so hover, press and depth
            all arrive for free; only the face metrics are overridden, to the
            account chip's, so the swap lands on the same rectangle.
            is-pressed is the existing JS-held press (same rule as :active): it
            holds the face down while the panel is open, which is what makes the
            handover work — a fully pressed face has slid over its own depth
            band, so it IS a plain rectangle, exactly what unfolds from it.
            data-own-press: candy defines its own :active, so it opts out of the
            global spring scale while keeping the press sound. */}
        <button
          type="button"
          className={`candy-btn${pressed ? ' is-pressed' : ''}`}
          data-own-press
          onClick={() => setOpen(true)}
          style={{
            gridArea: '1 / 1', alignSelf: 'start',
            width: box.w, height: box.h,
            opacity: open ? 0 : 1,
            pointerEvents: open ? 'none' : 'auto',
            // Stay neutral in every state. The cursor is ON the button when you
            // click it, so the base :hover accent flood would fire, hold through
            // the whole press, and then hand over to plain grey rectangles — a
            // colour jump on the one frame the swap is meant to hide. The band
            // and frame read this var (base rule .candy-btn:is(:hover,:active));
            // the face's own accent fill is overridden inline below.
            '--cbtn-band': 'var(--surface)',
            // The box-shadow leg is .candy-btn's own, restated verbatim: an
            // inline transition REPLACES the whole list, and dropping it left
            // the depth band snapping to the hover accent while the face above
            // it still eased over 150ms.
            transition: `opacity ${SETTLE}ms ease-in-out ${open ? press : 2 * DUR}ms,`
              + ' box-shadow 150ms cubic-bezier(0, 0, 0.58, 1)',
          }}
        >
          {/* background + color are the face's own RESTING values, restated so
              the base hover rule's accent fill / white text can't take. Same
              pair the rectangles use, so the swap changes no colour. */}
          <span className="candy-face" style={{
            ...CHIP_TEXT, height: '100%', padding: '0 8px',
            background: 'var(--surface-3)', color: 'var(--text-muted)',
          }}>Settings</span>
        </button>

        {/* Open state. A plain button, deliberately — see the note on skin.
            Width must match the rectangles: perspective-origin defaults to the
            centre of the element that DECLARES perspective, and a wider one
            puts the vanishing point off to the right, skewing the fold
            sideways. Holds its opacity until both folds have finished, so the
            whole animation plays before the candy button takes over.
            Offset by the depth band: a pressed face sits that far down, and the
            paper has to start from where the pressed face is, not where the
            resting one was. var() so it tracks the depth picker. */}
        <button
          type="button"
          aria-label="Fold"
          aria-expanded={open}
          // The only motion here is the fold. Opts out of the global :active
          // spring scale and the press sound that ride on every <button>.
          data-no-tactile=""
          onClick={() => setOpen(false)}
          style={{
            gridArea: '1 / 1', alignSelf: 'start',
            perspective: PERSPECTIVE, width: box.w,
            transform: 'translateY(var(--candy-depth))',
            display: 'block', padding: 0, border: 'none', background: 'none',
            cursor: 'pointer',
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: `opacity ${SETTLE}ms ease-in-out ${open ? press : 2 * DUR}ms`,
          }}
        >
          {/* top — never moves; everything folds onto it */}
          <div style={skin}><span style={label}>Appearance</span></div>

          {/* middle + bottom travel together on the second fold, so they share
              a wrapper that hinges on the top rectangle's bottom edge.
              preserve-3d keeps the inner fold in 3D, not flattened. */}
          <div style={{
            marginTop: OVERLAP,
            transformStyle: 'preserve-3d',
            ...hinge(deg, open ? press : DUR),
          }}>
            {/* Shut, this rectangle's UNDERSIDE is the one face left showing:
                the bottom flap folds behind it, then the pair flips it onto the
                top. So the closed-state label lives here, on the back — and it
                matches the candy button's, so the swap only adds the depth
                band. rotateX flips y only, so the counter-flip is scaleY. */}
            <div style={skin}>
              <span style={{ ...label, opacity: open ? 1 : 0 }}>Sounds</span>
              <span style={{ ...label, opacity: open ? 0 : 1, transform: 'scaleY(-1)' }}>
                Settings
              </span>
            </div>
            <div style={{ ...skin, marginTop: OVERLAP, ...hinge(deg, open ? press + DUR : 0) }}>
              <span style={label}>Navigation</span>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
