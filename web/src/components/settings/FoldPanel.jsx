// Fold demo — dev toy built on Josh Comeau's "Folding the DOM":
// https://www.joshwcomeau.com/react/folding-the-dom/
// Three stacked rectangles folded like a letter into thirds, driven by a click.
// Open is flat, closed is folded shut; the two folds run in sequence so the
// motion traces the same path the old 0-360 slider swept by hand. Each
// rectangle is sized and skinned to match the titlebar account chip.
import { useEffect, useRef, useState } from 'react';

// Used until the real chip is measured. Height is TitleBar's BTN; the width is
// a stand-in only — the chip has no width of its own (see measure below).
const FALLBACK = { w: 160, h: 28 };
// Camera distance. The article's 500 was sized for a 300px-tall image; against
// 28px rectangles it sits far too close, and the taper (the near edge of a
// folding flap draws wider than its hinge) reads as the rectangles changing
// shape. Pulling the camera back flattens the taper without killing the fold —
// the flap still foreshortens, which is what sells the 3D.
const PERSPECTIVE = 2000;
// Gap between neighbouring rectangles, as marginTop: the depth lip plus air.
// The lip part is not optional — the rectangles are the Settings button
// exactly, lip included, and a lip is a DOWNWARD box-shadow living outside
// layout, so any gap shorter than it leaves it overhanging the neighbour below.
// Built from the same var rather than a number so it tracks Settings →
// Appearance → Depth; hardcoding 7 would let them overlap the moment the
// picker moved. The +4px on top is the visible air, on the app's 4px grid.
const GAP_V = 'var(--candy-depth) + 4px';
const GAP = `calc(${GAP_V})`;

// The pivot sits at the MIDDLE of the space between neighbours, not on the
// flap's own top edge — rotating about the edge lands the flap a whole GAP off
// its target. Half of it makes the fold symmetric about the boundary, so a
// folded flap lands exactly on the rectangle above (at the 7px default: flap
// 35-63, pivot 31.5, lands 0-28 against a 0-28 target). calc so it follows the
// depth picker with the gap. Leave the expression.
const HINGE_Y = `calc((${GAP_V}) / -2)`;

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

// .candy-btn's OWN transition, restated verbatim. An inline `transition`
// replaces the class's whole list, so a hinge that only declares its transform
// leg strips the band's ease and the depth colour snaps while the face eases.
const BAND_T = 'box-shadow 150ms cubic-bezier(0, 0, 0.58, 1)';

// `live` = being scrubbed by hand: the transform must track the slider frame
// for frame, so the timed leg comes off and only the band's own ease is left.
const hinge = (deg, delay, live) => ({
  transform: `rotateX(${deg}deg) translateZ(-1px)`,
  transformOrigin: `center ${HINGE_Y}`,
  transition: live ? BAND_T : `transform ${DUR}ms ease-in-out ${delay}ms, ${BAND_T}`,
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

  // Closing is now squash, fold, squash, fold — so every leg after the first
  // squash is pushed back by one press, and the whole close runs two presses
  // longer than the two folds alone. One expression, so the shut button's
  // hand-back and both hinges can never drift apart.
  const SHUT = 2 * press + 2 * DUR;

  // The button stays down for the whole unfolded stretch, then rises once the
  // paper is shut again. This is a held state, NOT a transition-delay on the
  // face: a delay there applies to every transform change, including the
  // mouse's own :active press, which then sat frozen for the length of the
  // delay before it would start moving.
  const [pressed, setPressed] = useState(true);
  useEffect(() => {
    if (open) { setPressed(true); return; }
    const t = setTimeout(() => setPressed(false), SHUT + SETTLE);
    return () => clearTimeout(t);
  }, [open]);

  // Which flaps are pressed: [pair, flap]. Each squashes, releases, and only
  // THEN folds, so the compaction runs down the stack a beat ahead of the fold.
  //
  // Squash-before-fold rather than squash-during is load-bearing, not taste. A
  // pressed face is slid DOWN --cbtn-depth inside its own button, and the fold
  // rotates that button 180deg, which flips the slide upward — so a flap still
  // held at the moment it lands puts its face a full depth above its target,
  // and only eases back afterwards while the stack is already fading out. That
  // is the "folds too high" bug, and it is invisible to a box measurement: the
  // BOXES land dead flush (measured 617/645 on all three), it is only the faces
  // inside them that sit high. Released before its own fold starts, a flap is
  // always at rest when it lands. Appearance is never in the list — it is the
  // target, it never folds.
  //
  // `lip` runs alongside on the same clock and is the OTHER half of landing
  // flush. A candy lip is a DOWNWARD box-shadow, so a flap rotated 180deg
  // points its lip UP and stacks a whole depth of shadow above whatever it
  // lands on — the real "folds too high", and the same reason the shut state
  // cannot BE the folded stack. Each flap drops its lip exactly when its own
  // fold begins and gets it back only once fully unfolded, so the lip is still
  // there for the squash that precedes the fold (a zero lip has nothing to
  // slide, and the squash would vanish with it).
  const [manual, setManual] = useState(null);
  const [down, setDown] = useState([false, false]);
  const [lip, setLip] = useState([true, true]);
  useEffect(() => {
    const t = [];
    if (open) {
      setDown([false, false]);
      // Lips return per flap, each as its own unfold finishes.
      t.push(setTimeout(() => setLip(([, f]) => [true, f]), press + DUR));
      t.push(setTimeout(() => setLip([true, true]), press + 2 * DUR));
    } else {
      setDown([false, true]);                                      // Navigation squashes
      t.push(setTimeout(() => {                                    // released, then folds
        setDown([false, false]); setLip([true, false]);
      }, press));
      t.push(setTimeout(() => setDown([true, false]), press + DUR));  // pair squashes
      t.push(setTimeout(() => {                                    // released, then folds
        setDown([false, false]); setLip([false, false]);
      }, 2 * press + DUR));
    }
    return () => t.forEach(clearTimeout);
  }, [open, press]);
  const cls = (d) => `candy-btn${d ? ' is-pressed' : ''}`;

  // TEMP measurement scaffold — reads the three buttons' painted top edges once
  // the fold has finished, so the landing can be checked in numbers.
  const refs = [useRef(null), useRef(null), useRef(null)];
  const [edges, setEdges] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      const y = refs.map((r) => {
        const el = r.current;
        if (!el) return '?';
        const b = el.getBoundingClientRect();
        return `${Math.round(b.top)}/${Math.round(b.bottom)}`;
      });
      setEdges(`A ${y[0]} S ${y[1]} N ${y[2]}`);
    }, SHUT + SETTLE + 120);
    return () => clearTimeout(t);
  }, [open]);

  // The rectangles wear the REAL .candy-btn now, not a hand-copied skin. They
  // are interactive (they light on hover and close the fold), so the class's
  // press machinery, hover flip and depth lip are all wanted — and the class
  // gives them for free, which deleted the hand-rolled hover state, the copied
  // frame values, and the ghost-border trap that came with them.
  // Always writes --cbtn-depth rather than adding and removing the key: React
  // only touches style keys that changed, and a key that disappears takes its
  // value with it while the untouched rest of the rule stays put.
  const btn = (lipOn) => ({
    width: box.w,
    height: box.h,
    display: 'block',              // the class is inline-flex; these stack
    '--cbtn-depth': lipOn ? 'var(--candy-depth)' : '0px',
    // Re-armed against the wrapper's pointerEvents: 'none' below.
    pointerEvents: 'auto',
  });

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

  // Grid, not the class's inline-flex, so the middle rectangle can stack its
  // two labels in one cell without absolute positioning.
  const FACE = {
    ...CHIP_TEXT,
    height: '100%',
    padding: '0 8px',
    display: 'grid',
    placeItems: 'center',
  };

  const label = {
    gridArea: '1 / 1',
    whiteSpace: 'nowrap',        // type + colour inherit from the face
    transition: `opacity ${DUR}ms ease-in-out`,
  };

  // Manual scrub. null = click-driven. One 0-360 sweep replays the letter fold
  // in order: 0-180 folds Navigation onto Sounds, 180-360 folds the pair onto
  // Appearance — the same two hinges the click sequences with delays, driven by
  // hand instead so a landing can be parked mid-fold and inspected.
  const auto = manual === null;
  const flapDeg = auto ? (open ? 0 : 180) : Math.min(180, manual);
  const pairDeg = auto ? (open ? 0 : 180) : Math.max(0, manual - 180);
  // Scrubbing has no squash and no timed lip schedule — a flap keeps its lip
  // only while it is flat, which is the rule the animation follows too.
  const flapLip = auto ? lip[1] : flapDeg === 0;
  const pairLip = auto ? lip[0] : pairDeg === 0;

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold — {edges}</div>

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
            // Neutral only while HELD, not always: hover still floods accent
            // like every other candy button, but the moment the press starts the
            // button eases back to resting colour, so it hands over to plain grey
            // rectangles without a colour jump on the frame the swap exists to
            // hide. The band and frame read this var (base rule
            // .candy-btn:is(:hover, :active)); the face's own accent fill is a
            // SEPARATE rule, overridden inline below.
            ...(pressed ? { '--cbtn-band': 'var(--surface)' } : {}),
            // The box-shadow leg is .candy-btn's own, restated verbatim: an
            // inline transition REPLACES the whole list, and dropping it left
            // the depth band snapping to the hover accent while the face above
            // it still eased over 150ms.
            transition: `opacity ${SETTLE}ms ease-in-out ${open ? press : SHUT}ms,`
              + ' box-shadow 150ms cubic-bezier(0, 0, 0.58, 1)',
          }}
        >
          {/* While held, the face's own RESTING values are restated so the base
              hover rule's accent fill / white text can't take — same pair the
              rectangles use, so the handover changes no colour. Unheld, nothing
              is set and hover behaves normally. */}
          <span className="candy-face" style={{
            ...CHIP_TEXT, height: '100%', padding: '0 8px',
            ...(pressed ? { background: 'var(--surface-3)', color: 'var(--text-muted)' } : {}),
          }}>Settings</span>
        </button>

        {/* Open state. A DIV, not a button — the three rectangles are real
            candy buttons now and a button cannot nest inside a button. Each
            rectangle closes the fold itself, so nothing is lost.
            Width must match the rectangles: perspective-origin defaults to the
            centre of the element that DECLARES perspective, and a wider one
            puts the vanishing point off to the right, skewing the fold
            sideways. Holds its opacity until both folds have finished, so the
            whole animation plays before the candy button takes over.
            Offset by the depth band: a pressed face sits that far down, and the
            paper has to start from where the pressed face is, not where the
            resting one was. var() so it tracks the depth picker. */}
        <div
          role="group"
          aria-label="Fold"
          style={{
            gridArea: '1 / 1', alignSelf: 'start',
            perspective: PERSPECTIVE, width: box.w,
            transform: 'translateY(var(--candy-depth))',
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: `opacity ${SETTLE}ms ease-in-out ${open ? press : SHUT}ms`,
          }}
        >
          {/* top — never moves; everything folds onto it */}
          <button type="button" ref={refs[0]} className="candy-btn" data-own-press style={btn(true)}
            onClick={() => setOpen(false)}>
            <span className="candy-face" style={FACE}>
              <span style={label}>Appearance</span>
            </span>
          </button>

          {/* middle + bottom travel together on the second fold, so they share
              a wrapper that hinges on the top rectangle's bottom edge.
              preserve-3d keeps the inner fold in 3D, not flattened. */}
          <div style={{
            marginTop: GAP,
            transformStyle: 'preserve-3d',
            // The bottom flap's translateZ(-1px) puts it BEHIND this wrapper's
            // own plane, so the wrapper won every hit test over it and the flap
            // never saw a mouseenter (the middle rectangle is untransformed, so
            // it sits level with the wrapper and child-beats-parent applies —
            // which is why only the bottom one was dead). Nothing listens here,
            // so make it transparent to the pointer; the rectangles re-arm
            // themselves via pointerEvents: 'auto' in BTN.
            pointerEvents: 'none',
            ...hinge(pairDeg, open ? press : 2 * press + DUR, !auto),
          }}>
            {/* Shut, this rectangle's UNDERSIDE is the one face left showing:
                the bottom flap folds behind it, then the pair flips it onto the
                top. So the closed-state label lives here, on the back — and it
                matches the candy button's, so the swap only adds the depth
                band. rotateX flips y only, so the counter-flip is scaleY. */}
            <button type="button" ref={refs[1]} className={cls(down[0])} data-own-press style={btn(pairLip)}
              onClick={() => setOpen(false)}>
              <span className="candy-face" style={FACE}>
                <span style={{ ...label, opacity: open ? 1 : 0 }}>Sounds</span>
                <span style={{ ...label, opacity: open ? 0 : 1, transform: 'scaleY(-1)' }}>
                  Settings
                </span>
              </span>
            </button>
            <button
              type="button"
              ref={refs[2]}
              className={cls(down[1])}
              data-own-press
              onClick={() => setOpen(false)}
              style={{ ...btn(flapLip), marginTop: GAP, ...hinge(flapDeg, open ? press + DUR : press, !auto) }}
            >
              <span className="candy-face" style={FACE}>
                <span style={label}>Navigation</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* TEMP diagnostic scrub. Drives both hinges by hand so a landing can be
          parked and inspected; forces the stack open so the shut button can't
          cross-fade over what is being looked at. Reset returns to click. */}
      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="range" min={0} max={360} step={1}
          value={manual ?? 0}
          onChange={(e) => { setManual(Number(e.target.value)); setOpen(true); }}
          style={{ width: box.w }}
        />
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
          whiteSpace: 'nowrap',
        }}>
          {auto ? 'auto' : `${manual}  flap ${flapDeg}  pair ${pairDeg}`}
        </span>
        {!auto && (
          <button type="button" className="candy-btn" data-shape="chip" data-own-press
            onClick={() => setManual(null)}>
            <span className="candy-face">Reset</span>
          </button>
        )}
      </div>
    </div>
  );
}
