// Dev-tab proof rig for the Planner Clock Flip Face — THROWAWAY.
//
// Delete this file (and its mount in DevTab.jsx) once the dial ships.
//
// This is a LITERAL 1-1 COPY of the "3-D Flip" button from
// codepen.io/kevinfan23/details/BKbWxP (source: github.com/kevinfan23/button.css,
// css/style.css + index.html, fetched 2026-09-20). The CSS below is the pen's own
// COMPILED output pasted unchanged — same selectors, same values, same order,
// including the things I would not have written:
//
//   * `perspective: 1000` has no unit, so it is invalid and the browser drops it.
//     The pen therefore renders with NO perspective at all. Left exactly as-is:
//     changing it would stop this being a copy, and the pen looks how it looks
//     BECAUSE of it.
//   * the Lato @import and the Font Awesome stylesheet are the pen's own two
//     external dependencies, loaded here the same way the pen loads them, so the
//     icon and the type match the original.
//   * `.button`, `.flipper`, `.button-container` are generic names. Verified
//     2026-09-20: the app defines and uses none of the three, so the paste
//     collides with nothing and needs no renaming.
//
// WHAT THIS ACTUALLY IS, and why the two earlier attempts were wrong.
// It is not a card flip. The front face is pushed forward by translateZ(22.5px)
// — half the button's 45px height — and the back face is placed on the block's
// TOP plane. The hinge sits at the block's middle (transform-origin: 100% 22.5px)
// and the whole thing turns only NINETY degrees. So it is a solid block rolling
// over onto its next side, with real depth equal to its own height. A 180deg
// two-face flip is a sheet of paper; this is a brick. That is the difference
// Malthaiel was pointing at both times.
import { useEffect, useRef, useState } from 'react';
import { eyebrowStyle } from '../ui/Eyebrow.jsx';
import DualRingRect from '@modules/core/planner/watchfaces/DualRingRect.jsx';
import SegmentReadout from '@modules/core/planner/watchfaces/SegmentReadout.jsx';
import { IconRepeatSolid, IconPlayMark, IconSkipMark, IconListPlus, IconPlus, IconNotes } from '../icons.jsx';

// The pen's two external stylesheets, loaded once. Same URLs the pen uses.
const LINKS = [
  'https://maxcdn.bootstrapcdn.com/font-awesome/4.5.0/css/font-awesome.min.css',
  'https://fonts.googleapis.com/css?family=Lato:400,300',
];

// Pasted verbatim from css/style.css. The only thing NOT copied is the pen's
// page furniture (html/body font, section.page-container, .section-container),
// which styles its demo page rather than the button and would restyle the whole
// settings drawer.
const PEN_CSS = `
/*** Horizontal Flip ***/
.button-container {
  display: inline-block;
  margin: 0 10px;
  cursor: pointer;
  font-weight: 400;
  letter-spacing: 2px;
  height: 45px;
  width: 200px;
  perspective: 1000; }
  .button-container .flipper {
    transition: all 0.5s ease-in-out;
    transform-style: preserve-3d;
    position: relative; }
  .button-container .button {
    height: 45px;
    width: 200px;
    border-radius: 0;
    backface-visibility: hidden;
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    box-shadow: none; }
    .button-container .button i.fa {
      color: white;
      font-size: 20px;
      margin: auto;
      text-shadow: 0.5px 1px 2px #3c3c3c; }
    .button-container .button.front {
      z-index: 10;
      background-image: linear-gradient(90deg, #53a0fd, #01c2f3); }
    .button-container .button.back {
      transform: rotateY(-180deg);
      color: white;
      font-size: 15px;
      text-transform: uppercase;
      background-image: linear-gradient(90deg, #01c2f3, #53a0fd); }

.button-container:hover .flipper {
  transform: rotateY(180deg); }

.button-container-3d {
  perspective: 1000;
  /* The faces' frame width, hoisted to a var so the underside can MEASURE it
     rather than restate it. The two face rules below drew a hardcoded 2px each;
     the run on the underside has to overhang by exactly this much to share the
     line instead of drawing a second one inside it. */
  --block-frame: 2px; }
  .button-container-3d .flipper-3d {
    transition: all 0.5s ease-in-out;
    transform-style: preserve-3d;
    transform-origin: 100% 22.5px; }
  .button-container-3d .button-3d {
    height: 45px;
    width: 200px; }
  .button-container-3d .button-3d.front {
    transform: translateZ(22.5px);
    background: var(--cbtn-face);
    border: var(--block-frame) solid color-mix(in oklch, var(--cbtn-rest), black 22%); }
  .button-container-3d .button-3d.back {
    transform: rotateX(90deg) rotateZ(180deg) rotateY(180deg) translateZ(22.5px);
    background: var(--cbtn-face);
    border: var(--block-frame) solid color-mix(in oklch, var(--cbtn-rest), black 22%); }

.button-container-3d:hover .flipper-3d {
  transform: rotateX(90deg); }
`;

// The COPY, sitting to the right of the original. Its own sheet, loaded AFTER
// PEN_CSS, so every rule here is an equal-specificity override that wins on
// order alone — the original's rules above are never edited. Malthaiel's
// standing instruction 2026-09-20: the left block is frozen, all further shaping
// happens on this copy.
//
// Everything geometric derives from --h / --w. The 3D math is not free to
// disagree with the box: the hinge sits at half the height and each face is
// pushed out by half the height, so a size change is ONE number, not four.
const COPY_CSS = `
.flip-copy {
  /* Fallbacks only. usePlannerBlockSize overwrites all three from the live
     .planner-dial-block every time this panel mounts. */
  --h: 84px;
  --w: 233px;
  --d: var(--h);
  height: var(--h);
  width: var(--w); }
  /* THE FLIPPER NEEDS A REAL BOX. The pen's .flipper-3d is a zero-height
     position:relative shell — fine for the pen, which places its faces with
     hardcoded px and never uses a percentage. The moment the back face is placed
     the way the real dial places it (top: 50% + margin-top: -d/2), that 50%
     resolves against a ZERO-height containing block and collapses to 0px, so the
     arriving face sits half a block too high. .planner-dial-flip-inner is
     width/height 100% for exactly this reason; the copy needs the same box. */
  .flip-copy .flipper-3d {
    height: var(--h);
    width: var(--w);
    /* KEEP THE LAYER PROMOTED AT REST. The block lands on a fractional page y
       (531.703 measured 2026-09-20) because the Dev tab's sections above it sum
       to a fraction. Uncomposited it rasterizes at that fraction; the moment the
       rotateX transition starts Chromium promotes it and the layer origin snaps
       to a whole device pixel, so everything inside jumps exactly 1px and drops
       back on demote. Holding the layer open rounds it the same way throughout.
       Costs one resting paint row (it sits at the rounded position). */
    will-change: transform;
    /* The pen hardcodes 0.5s and the real dial reads --dial-roll, which the Dev
       panel's slider writes on :root. The scroll cooldown below reads the same
       var, so if the copy kept the pen's fixed number the two would disagree the
       moment the slider moved - a 1400ms cooldown gating a 500ms roll. Duration
       only; the pen's curve is untouched. */
    transition-duration: var(--dial-roll, 500ms);
    transform-origin: 50% 50%; }
  .flip-copy .button-3d {
    height: var(--h);
    width: var(--w); }
  .flip-copy .button-3d.front {
    transform: translateZ(calc(var(--d) / 2)); }
  /* Mirrors .planner-dial-flip-face.back: the underside's own height IS the
     block's depth, and depth is a separate number from height on the real dial
     (--dial-depth-k can pull it below 1), so --d is its own var here too. */
  .flip-copy .button-3d.back {
    top: 50%;
    height: var(--d);
    margin-top: calc(var(--d) / -2);
    transform: rotateX(90deg) rotateZ(180deg) rotateY(180deg) translateZ(calc(var(--d) / 2));
    font-size: 11px;
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.08em; }
  .flip-copy .button-3d i.fa {
    font-size: 13px; }
  /* THE UNDERSIDE IS A GRID, exactly as .planner-dial-flip-face is, so its one
     child fills it. The pen's .button is a centred flex column, under which the
     control row collapses to the height of a glyph - the same collapse the real
     face's comment in styles.css records (34px inside a 67px face). Safe here in
     a way it is NOT on the front face: the back face's child is an ordinary grid
     of panels, while the front's two children are absolutely positioned and would
     resolve against a content-sized grid area instead (probe CLOCK-1). */
  /* THE THIRD FACE, on the block's TOP plane (user-directed 2026-09-20).
     Its transform is the underside's mirror and needs no new arithmetic: the
     back face's rotateX(90) rotateZ(180) rotateY(180) IS rotateX(-90) written
     the long way, because two 180s about perpendicular axes compose to one 180
     about the third. So the top plane is the plain inverse, rotateX(90), and
     rolling the flipper to rotateX(-90deg) brings it up the right way round.
     It carries its own paint because the pen's sheet declares background and
     border per class, on .front and .back only - there is nothing for a third
     class to inherit. */
  .flip-copy .button-3d.top {
    top: 50%;
    height: var(--d);
    margin-top: calc(var(--d) / -2);
    transform: rotateX(90deg) translateZ(calc(var(--d) / 2));
    background: var(--cbtn-face);
    border: var(--block-frame) solid color-mix(in oklch, var(--cbtn-rest), black 22%);
    font-size: 11px;
    font-family: var(--font-mono);
    /* Same two reasons as .back: a grid so its one child fills it, and
       justify-content back to stretch because the pen's centred flex column
       packs the implicit track at content width instead. */
    display: grid;
    justify-content: normal; }
  .flip-copy .button-3d.back {
    display: grid;
    /* The pen's .button is a CENTRED flex column, and justify-content survives the
       switch to grid: it packs the implicit track at its content width instead of
       stretching it, so the control row came out 102px inside a 232.7px face
       (measured). The real face never sets it. Back to the initial value, which
       for a grid container means stretch. */
    justify-content: normal; }
`;

// The copy is SIZED OFF THE REAL PLANNER BLOCK, never off typed numbers: the dial
// derives its own box from the tube's measured ruler, so any constant copied in
// here would drift the moment the dock is resized or the sidebar moves. Reads
// .planner-dial-block's rect plus its inline --dial-depth and writes --h/--w/--d
// onto the copy. The dock is always mounted, so the node is always there; if it
// ever isn't, the CSS fallbacks above hold.
function usePlannerBlockSize(ref) {
  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      const block = document.querySelector('.planner-dial-block');
      if (!el || !block) return;
      const r = block.getBoundingClientRect();
      const depth = getComputedStyle(block).getPropertyValue('--dial-depth').trim();
      el.style.setProperty('--h', `${r.height}px`);
      el.style.setProperty('--w', `${r.width}px`);
      el.style.setProperty('--d', depth || `${r.height}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
}

// -- BLOCK 3 -- the copy WITH THE DIAL REAL FACE ON IT -----------------------
//
// Same block, same roll; the front face carries the planner own session ring and
// its own clock instead of the pen icon. Both are the REAL components:
// DualRingRect paints the ring and SegmentReadout paints the digits, so a retune of
// either lands here without an edit.
//
// HOW THE RING GETS IN. DualRingRect already knows how to paint its session ring
// somewhere other than its own svg - the ringSlot prop the dock uses to put the
// ring inside the turning block. Handed { node, dx, dy } it portals the ring into
// node, shifted back by the host own offset. The rest of the component - tube,
// groove, plate - renders into a display:none wrapper and is never seen: a portal
// destination is a real node in the visible tree, so the ring still paints while
// its own component is hidden. That trick is why this needs no fork of the dial.
//
// EVERY NUMBER IS MEASURED OFF THE LIVE DIAL. The first pass computed them from the
// module exported insets (RIBBON_W for the block offset, RING_INNER_EDGE for the
// clock) and both were wrong: probe PARITY-1, 2026-09-20, read the real offsets as
// 18.1 and 8.6 against the predicted 5.6 and 21.2. The block box is the tube
// PAINTED groove pulled in, and a groove is itself inset from the svg edge - a sum
// no exported constant carries. So this asks the dial.
//
// NO display:grid ON THE FACE, and that is a fix, not an omission. The dial own
// face is a grid, so the first pass copied that here - and both children are
// absolutely positioned, which makes their containing block the GRID AREA rather
// than the face padding box. The area is sized by content and abspos children
// contribute none, so it collapsed: the clock box measured 72px wide inside a
// 232.7px face and the ring landed 110.8px to the right. Probe CLOCK-1.
const CLOCK_CSS = '';

// The three underside panels are real buttons, so they take a real handler; this
// rig has no timer behind them. Named rather than inlined so it is obvious the
// dead click is deliberate.
const noop = () => {};

// The run's height. It STARTED at 27px, the app's standard text-split height read
// off the live AlbumBrowser runs (the only ones that declare --cbtn-size), which
// was the right reference while this run sat fused into the block's frame like a
// toolbar. It is not a text run and no longer fused - it floats on the liquid as
// four marks - so it is tuned by eye instead (user-directed 2026-09-20: a bit
// smaller). Kept as one constant; the four parts still divide the width evenly.
const SPLIT_H = '24px';

// The sideways run's WIDTH. In a column --cbtn-size stops being a height and
// becomes the across measurement, because the two parts split the face's height
// between them the same way the bottom run's four parts split its width. Starting
// number, tuned on a photograph like every other size on this block.
const COL_W = '38px';

// PLACEHOLDER DAY, on the same footing as the plate's placeholder text: the real
// strip reads planBlocks and sessions off PlannerProvider when this ports to the
// dial. Shaped as the real one will be - a flat run of segments in MINUTES, with
// the gaps between blocks carried as segments of no kind so the bar's own track
// shows through. Nothing here is a clock time; the bar is proportional and the
// two end labels are the only times on the face.
const DEMO_DAY = [
  { mins: 45, kind: 'done' },
  { mins: 15, kind: null },
  { mins: 60, kind: 'done' },
  { mins: 30, kind: null },
  { mins: 45, kind: 'plan' },
  { mins: 45, kind: null },
];
const DEMO_NOW_PCT = 58;

// One part of the fused run. A .candy-split child is an ORDINARY .candy-btn - there
// is no React button component in this app and there should not be - so this is just
// the two-layer markup with the flex-fill that makes the four parts share the run's
// width evenly, 57.25px each across the 229 the frame leaves.
//
// NO data-shape. The shipped rule
//   .candy-split > .candy-btn:not(:first-child):is([data-shape="circle"], [data-shape="icon"])
// pins a part's WIDTH to --cbtn-size, which would fight flex: 1 1 0 and stop the run
// filling the face. Shapeless parts are flex-sized and keep the default 16px face
// padding, which a 14px mark clears comfortably in 57px.
//
// The label lives in the tooltip. Measured 2026-09-20: icon + word needs ~97px a
// part, text alone ~71 - both overflow 57, which is what sank the previous two runs.
//
// SIZE IS PER ICON, not one number for the run. Boxicons draws each mark at its
// own fraction of the 24 box, so a single size lands them at different widths -
// measured at size 14: reset 12 across, play 7, skip 8, task 10. Each part asks
// for the size that makes its PAINTED mark match, read off a photograph.
function SplitBtn({ title, Icon, size = 14 }) {
  return (
    <button type="button" data-own-press className="candy-btn"
      style={{ flex: '1 1 0', minWidth: 0 }} onClick={noop} title={title}>
      <span className="candy-face"><Icon size={size}/></span>
    </button>
  );
}

// The dial own geometry, read off the real widget: how big the ring svg is, where
// the block sits inside it, and how far the clock box sits inside the block.
// Re-read on resize, written only on a real change.
function useDialRingGeometry() {
  const [g, setG] = useState(null);
  useEffect(() => {
    const measure = () => {
      const block = document.querySelector('.planner-dial-block');
      const ring = block && block.querySelector('.planner-ring-art');
      const box = block && block.querySelector('.planner-ring-inner-controls');
      if (!block || !ring || !box) return;
      const b = block.getBoundingClientRect();
      const r = ring.getBoundingClientRect();
      const i = box.getBoundingClientRect();
      const next = {
        w: b.width, h: b.height,
        svgW: r.width, svgH: r.height,
        dx: b.left - r.left, dy: b.top - r.top,
        inset: i.left - b.left,
      };
      setG((prev) => (prev && Object.keys(next).every((k) => prev[k] === next[k]) ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return g;
}

// The roll's duration, ASKED OF THE LIVE STYLESHEET rather than restated. The Dev
// panel's slider writes --dial-roll on :root and both the real dial's transition
// and the copy's read it, so the cooldown between scroll notches has to come from
// the same place - a typed 500 here would gate a 1400ms roll the moment he moved
// the slider. Handles both units; an unset var computes to '' and falls back.
function rollMs() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--dial-roll').trim();
  const n = parseFloat(v);
  return n ? (v.endsWith('ms') ? n : n * 1000) : 500;
}

function FlipClockBlock() {
  const hostRef = useRef(null);
  usePlannerBlockSize(hostRef);
  const g = useDialRingGeometry();

  // The front face, once mounted, is where the ring is portalled - a state-holding
  // callback ref, because the portal only exists once there is a real node to put
  // it in, and that needs a render to notice. Same reason the dock uses one.
  const [frontNode, setFrontNode] = useState(null);

  // SCROLL DRIVES THE ROLL, NOT HOVER (user-directed 2026-09-20). face is which
  // plane is up: -1 the day strip on top, 0 the clock at rest, +1 the controls
  // underneath. Direction-mapped and CLAMPED, so each direction owns one face, the
  // clock is always exactly one notch from either, and a trackpad's momentum
  // cannot spin the block past the end.
  //
  // Written as an inline transform on the flipper, which beats the pen's
  // `:hover .flipper-3d` rule without editing the frozen sheet - so hover dies on
  // THIS block only and the two demo blocks beside it keep working.
  const [face, setFace] = useState(0);
  const lockRef = useRef(0);

  // A NATIVE NON-PASSIVE LISTENER, not React's onWheel, and that is a measured
  // correction rather than a preference. The first build used onWheel with
  // stopPropagation - the move MusicPlayerWidget makes to own the wheel for its
  // volume fader - and MEASURED the Settings drawer scrolling 998 -> 878 under the
  // block anyway, the full deltaY.
  //
  // OWNING A WHEEL TAKES TWO THINGS, and stopPropagation is neither of them.
  //   1. smoothWheel.js has to bow out. It is registered CAPTURE-PHASE ON WINDOW,
  //      so it runs before any listener this block could add and nothing said down
  //      here can reach it. Its own opt-out is the answer: the host carries
  //      data-owns-wheel, which is in that module's EXCLUDE list.
  //   2. The browser's own default scroll has to be cancelled, which needs
  //      preventDefault on a listener registered { passive: false }. React attaches
  //      wheel PASSIVELY at its root container, so the same call inside an onWheel
  //      handler is a silent no-op. Only addEventListener can register this.
  // stopPropagation stays as cheap insurance against a third listener, but it is
  // carrying none of the weight.
  //
  // Empty deps are safe: setFace is stable and every read of the current face goes
  // through the functional updater, so nothing here can go stale.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      if (now < lockRef.current) return;   // one notch per roll
      const dir = e.deltaY > 0 ? 1 : -1;
      setFace((f) => {
        const next = Math.max(-1, Math.min(1, f + dir));
        if (next !== f) lockRef.current = now + rollMs();
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // THE FACE HAS A BORDER AND THE DIAL DOES NOT. An absolutely positioned child
  // resolves against the PADDING box, so every offset measured off the real block
  // (a border-box number) lands one frame-width in. Read the frame rather than
  // typing 2 - it is the candy frame width and the candy recipe owns it.
  // The two corrections go OPPOSITE ways and that is not a typo: the clock inset is
  // measured inward, so the frame comes off it; the ring dx is a shift BACK out, so
  // the frame goes onto it.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!frontNode) return;
    setFrame(parseFloat(getComputedStyle(frontNode).borderTopWidth) || 0);
  }, [frontNode]);

  // The clock FILLS what the ring inner edge leaves, so the box is measured and
  // handed to the readout rather than the readout being sized by a typed number.
  const innerBoxRef = useRef(null);
  const [readoutBox, setReadoutBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const box = innerBoxRef.current;
    if (!box) return undefined;
    const measure = () => setReadoutBox({
      w: box.clientWidth - 2 * READOUT_PAD_PX,
      h: box.clientHeight - 2 * READOUT_PAD_PX,
    });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
    // DEPENDS ON g, and that is the whole bug it fixes. The clock box only renders
    // once the dial has been measured, so on a cold load this effect ran first,
    // found no node, and never attached - the readout was handed 0 x 0 and drew
    // nothing. It only ever looked fine because HMR re-ran the effects in the other
    // order.
  }, [g]);

  const inset = g ? g.inset - frame : 0;

  // DRAG THE FACE LEFT AND RIGHT TO SET THE TIMER (user-directed 2026-09-20). One
  // value drives three things - the digits, the ring arc and how far the water has
  // come - so there is nothing to keep in sync.
  //
  // THIS GESTURE IS A DUPLICATE AND IT SHOULD NOT BE. DualRingRect already owns
  // exactly it (interactive + onDrag, same clamp, same PX_PER_MIN), but it hangs
  // its handlers on its OWN svg, and in this rig that svg sits in a display:none
  // wrapper while only the ring portals out - so there is nothing there to grab.
  // The real fix is a dragSurface prop on that component, the pointer twin of the
  // ringSlot prop it already has. Not done here: DualRingRect.jsx is dirty from
  // another session and must not be touched. Delete this block and pass
  // dragSurface={frontNode} the moment that lands.
  const PX_PER_MIN = 6;   // MUST match DualRingRect's. That is the duplication above.
  const [mins, setMins] = useState(30);
  const dragRef = useRef(null);
  const [grabbing, setGrabbing] = useState(false);
  const onDragDown = (e) => {
    e.preventDefault();
    dragRef.current = { x: e.clientX, mins };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setGrabbing(true);
  };
  const onDragMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setMins(Math.max(1, Math.min(60, Math.round(d.mins + (e.clientX - d.x) / PX_PER_MIN))));
  };
  const onDragUp = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setGrabbing(false);
  };

  return (
    <div ref={hostRef} data-owns-wheel
      className="button-container button-container-3d flip-copy flip-clock">
      <div className="flipper-3d" style={{ transform: `rotateX(${face * 90}deg)` }}>
        <div className="button button-3d front" ref={setFrontNode}
          onPointerDown={onDragDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
          onPointerCancel={onDragUp}
          style={{ touchAction: 'none', cursor: grabbing ? 'grabbing' : 'grab' }}>
          {/* THE LIQUID, moved here off the underside and turned a quarter turn
              (user-directed 2026-09-20). It pools against the RIGHT edge and its
              surface is a vertical line travelling left as the block fills, sitting
              behind the ring and the digits. aria-hidden: pure decoration.

              The clipper is its own div rather than overflow:hidden on the face,
              because the face is the candy block itself and clipping it would cut
              the block's own depth band off with the water. */}
          <div className="fc-wet" aria-hidden="true">
            {/* The ONE place the timer becomes a water level: minutes over the
                hour the dial spans, straight into the sheet's only knob. */}
            <div className="fc-liquid" style={{ '--fc-fill': `${(mins / 60) * 100}%` }} />
          </div>
          {g && (
            <div
              className="planner-ring-inner-controls"
              ref={innerBoxRef}
              style={{ top: inset, bottom: inset, left: inset, right: inset, '--ring-radius': '0px' }}
            >
              <div className="planner-timer-digits">
                <SegmentReadout value={`${String(mins).padStart(2, '0')}:00`} w={readoutBox.w} h={readoutBox.h} />
              </div>
            </div>
          )}
        </div>
        {/* THE UNDERSIDE, second design 2026-09-20 (user-directed): a bare face
            with the four controls floating over its bottom edge, lifted off the
            left, right and bottom by an even gap. No text on this face at all -
            the task name and the next-block time both came off in this pass, and
            the liquid moved to the CLOCK face later the same day.

            THE RUN IS A REAL .candy-split, not a lookalike - ordinary .candy-btn
            children in a .candy-split wrapper, so the seams, the 2px frame overlap
            and the hover z-order all arrive from the shipped rules.

            The handlers are no-ops on purpose: this is a shape-and-paint rig with
            no timer behind it, and wiring it to the live timer would let a stray
            click in the Dev tab reset Malthaiel's actual session. */}
        <div className="button button-3d back">
          <div className="fc-under">
            <div className="candy-split fc-run" style={{ '--cbtn-size': SPLIT_H }}>
              <SplitBtn title="Reset" Icon={IconRepeatSolid} />
              <SplitBtn title="Start" Icon={IconPlayMark} size={20} />
              <SplitBtn title="Skip to break" Icon={IconSkipMark} size={22} />
              <SplitBtn title="Select a task for this session" Icon={IconListPlus} size={18} />
            </div>
          </div>
        </div>
        {/* THE NEW FACE, on the block's TOP plane (user-directed 2026-09-20):
            the day at a glance on the left, two fused adders hugging the right
            edge the way the four controls hug the underside's bottom. Scroll UP
            to reach it - the opposite roll - so the clock is one notch from
            either face.

            IconPlus and IconNotes rather than reusing IconListPlus, which is
            already the underside's fourth button meaning 'select a task for this
            session'. The same glyph on two faces meaning two things is a bug you
            only notice months later.

            No-ops for the same reason the four below are: this is a shape rig in
            Settings, and a stray click must not write to his real day. */}
        <div className="button button-3d top">
          <div className="fc-over">
            <div className="fc-strip">
              <div className="fc-head">
                <span className="fc-lab">TODAY</span>
                <div className="fc-stats">
                  <span>3 done</span><span>1h 12m</span>
                </div>
              </div>
              <div className="fc-bar">
                {DEMO_DAY.map((seg, i) => (
                  <div key={i} style={{ flex: seg.mins }}
                    className={'fc-seg' + (seg.kind ? ' is-' + seg.kind : '')} />
                ))}
                <div className="fc-now" style={{ left: DEMO_NOW_PCT + '%' }} />
              </div>
              <div className="fc-span"><span>14:00</span><span>18:00</span></div>
            </div>
            <div className="candy-split fc-col" style={{ '--cbtn-size': COL_W }}>
              {/* SIZE IS A VIEWBOX SCALE, not a size - the same trap the bottom
                  run's four marks were tuned around. Measured off the live svgs:
                  IconPlus draws 448 of its 448 box (it is a Font Awesome path on a
                  512 grid) so it paints at exactly `size`, while IconNotes draws
                  20 of 24 and paints at size x 0.833. 14 and 17 therefore both
                  land ~14 rows, which is the bottom run's 12 opened up a little
                  for a cell that is 39px tall rather than 27. Checked on a
                  photograph, not on these numbers. */}
              <SplitBtn title="Add a task" Icon={IconPlus} size={14} />
              <SplitBtn title="Add a quick note" Icon={IconNotes} size={17} />
            </div>
          </div>
        </div>
      </div>

      {/* Hidden: only its portalled ring is ever seen. */}
      <div style={{ display: 'none' }}>
        {frontNode && g && (
          <DualRingRect
            remainingMins={mins}
            dragMins={mins}
            phase="idle"
            running={false}
            width={g.svgW}
            height={g.svgH}
            outerR={0}
            svgInset={0}
            ringSlot={{ node: frontNode, dx: g.dx + frame, dy: g.dy + frame }}
          />
        )}
      </div>
    </div>
  );
}

// -- THE UNDERSIDE -----------------------------------------------------------
//
// REDESIGNED 2026-09-20 (second pass, user-directed). The first version was his
// own layout - a task plate over a four-part run fused flush into the block's
// frame on three sides. All three of those ideas are gone in this pass:
//
//   1. THE RUN LIFTS OFF THE EDGES. It used to overhang the content box by one
//      frame on left, right and bottom so its border merged with the block's.
//      Now it sits inside an even gap on all three sides.
//   2. THE TEXT IS GONE. No task name, no next-block time. The face carries the
//      controls and nothing else for now.
//   3. A LIQUID SURFACE RUNS BEHIND IT, adapted from
//      codepen.io/fliseno1k/pen/WNboLBy ("Liquid Button", fliseno1k), which is
//      the pen he pointed at via freefrontend.com/css-liquid-effects.
//
// HOW THE LIQUID ACTUALLY WORKS, because it is not what it looks like. There is
// no fluid simulation and no canvas. It is ONE coloured square with TWO big
// near-circles rotating on top of it - pseudo-elements at 200% of the square,
// border-radius 45% and 40% so they are deliberately NOT round, spinning at 5s
// and 10s. The blobs are painted in the block's own face colour, so they read as
// air; the colour beneath them reads as liquid; and the wobbling edge where they
// cross is the wave. Two different periods mean the two edges drift against each
// other and the surface never repeats on a count you can see.
//
// The blobs are sized off the face's own HEIGHT (aspect-ratio 1), so they rescale
// with the block and no number here restates the block's size. Only the FILL is a
// typed knob - see --fc-fill below - and it is a percentage of the face, so it is
// the one value a timer would drive.
//
// DROPPED FROM THE PEN: its hover rise (the square slides up 40px so the button
// fills). Hover no longer means anything on this block - the scroll drives the
// roll now - and rebinding the rise to something else would be inventing a
// gesture rather than copying one. The fill sits still.
//
// EVEN GAPS ARE MEASURED TO THE PAINT, not to the boxes. A candy button's depth
// band is a box-shadow cast BELOW its border box, so a run whose box sat one gap
// off the bottom would PAINT a gap one band shorter than the two beside it. The
// container's bottom padding therefore carries the gap PLUS the band's reach,
// which is the same --candy-depth minus --block-frame expression the flush
// version used to drop the band onto the frame. One --fc-gap drives all three.
//
// SHARP CORNERS KEPT. .candy-btn re-declares --corner-max on itself precisely so
// a wrapper cannot set it, and .candy-split overrides it again with half the run's
// height; zeroing it needs a rule of its own after both, which an inline <style>
// in the body is by document order. The reason for zeroing them (a run fused into
// a square frame) is gone now that the run floats - deleting that one line hands
// the ends back their normal roundness, if that reads better.
const UNDERSIDE_CSS = `
.fc-under {
  position: relative;
  /* The liquid square is far bigger than the face and has to be cut to it. */
  overflow: hidden;
  display: flex; flex-direction: column; justify-content: flex-end;
  height: 100%; box-sizing: border-box;
  /* ONE number for all three gaps. The bottom carries the depth band's reach on
     top of it so the PAINTED gap matches the two sides rather than the boxes
     matching and the paint disagreeing.
     THE BAND REACHES A FULL --candy-depth, not depth minus a frame. A candy
     button casts TWO shadows, and the second, darker one sits below the first:
     scanned 2026-09-20 at x=640, the face ends at row 481, the border takes
     482-483, the lit band 484-488 and the dark layer 489-490 - a full 7 below the
     border box. Reserving depth-minus-frame painted an 8px gap under a 10px pair
     at the sides. Measured on the photograph, not computed from the shadow. */
  --fc-gap: 10px;
  padding: var(--fc-gap);
  padding-bottom: calc(var(--fc-gap) + var(--candy-depth));
  font-family: var(--font-mono);
  /* The pen's own .button.back rule forces uppercase and that is inherited
     lettering, not this face's. Off once here, for every descendant. */
  text-transform: none;
  /* One hairline, one rule. Still read by the top face's stat dividers. */
  --us-line: color-mix(in oklch, var(--cbtn-rest), black 34%); }

/* THE LIQUID, adapted from the pen and TURNED A QUARTER TURN (user-directed
   2026-09-20). It lives on the CLOCK face now, not the underside: it pools
   against the right edge and its surface is a VERTICAL line that travels left as
   the block fills, behind the ring and the digits.

   Two of the pen's knobs are GONE with the rotation, and that is the point of
   doing it this way. The pen anchors its blobs at the edge OPPOSITE the water, so
   every change to the blob size walked the waterline and needed --fc-shift to
   compensate, and the crossing point then needed --fc-level on top. Anchoring
   each blob at the waterline ITSELF - right: --fc-fill - deletes both. One knob,
   nothing derived, nothing to keep in sync. */
.fc-wet {
  position: absolute; inset: 0;
  overflow: hidden;
  pointer-events: none; }
.fc-liquid {
  position: absolute; inset: 0;
  background: color-mix(in oklch, var(--accent, oklch(0.55 0.16 25)), black 25%);
  /* THE ONE KNOB, and it is the one a timer drives: how far in from the right
     edge the surface has reached. 0% empty, 100% the whole face drowned. A
     percentage resolves against the FACE's width, which is what makes "full"
     mean the full block. Static here - this rig has no timer behind it. */
  --fc-fill: 55%;
  /* HOW FLAT THE WAVE IS. The surface is the edge of a rotating near-square, so
     a bigger blob draws a straighter line down the same face height. Both waves
     share it - they move alike, they just sit apart (see --fc-lead). */
  --fc-blob: 3.2;
  /* HOW FAR RIGHT THE BRIGHT WATER STARTS (user-directed 2026-09-20). --fc-fill
     stays the waterline itself - where air meets water, and the timer's value.
     The TRANSPARENT blob is what moves: pushed this far right of it, the strip it
     still covers reads as darker water and the bright water begins beyond it.
     Moving the OPAQUE blob instead was the first attempt and it only dragged the
     one boundary along, because a transparent blob sitting entirely left of the
     opaque one is painted over and shows nothing. Clamped at the right edge so a
     nearly-empty block reads dark rather than hanging an edge off the block. */
  --fc-lead: 4%;
  /* ONE SPEED KNOB. The second blob runs at exactly twice this, which is what
     makes the two wave edges drift apart instead of locking together. */
  --fc-spin: 5s; }

/* The two blobs, anchored by the RIGHT edge that IS the waterline. Square and
   sized off the face's HEIGHT, not its width, so a blob stays round on a face
   that is far wider than it is tall. border-radius under 50% is what makes the
   edge wobble as it turns rather than sweep as a clean arc. Same size, same
   swing - only where they SIT differs, and only the bright one overrides it. */
.fc-liquid::before,
.fc-liquid::after {
  content: "";
  position: absolute;
  height: calc(var(--fc-blob) * 100%);
  aspect-ratio: 1;
  top: 50%;
  right: var(--fc-fill);
  transform: translateY(-50%); }
/* The opaque blob is the face's OWN colour, so the air left of the water is the
   same material as the rest of the block and the surface reads as cut out of it
   rather than painted over it. */
.fc-liquid::before {
  border-radius: 45%;
  background: var(--cbtn-face);
  animation: fc-liquid-spin var(--fc-spin) linear infinite; }
/* Half-transparent, so where it overlaps the liquid you get a third mid tone -
   the depth under the surface. Slower, so the two edges drift apart. */
.fc-liquid::after {
  right: max(0%, calc(var(--fc-fill) - var(--fc-lead)));
  border-radius: 40%;
  background: color-mix(in oklch, var(--cbtn-face), transparent 50%);
  animation: fc-liquid-spin calc(var(--fc-spin) * 2) linear infinite; }

@keyframes fc-liquid-spin {
  0%   { transform: translateY(-50%) rotate(0deg); }
  100% { transform: translateY(-50%) rotate(360deg); }
}
}

/* The run rides ABOVE the liquid. .candy-btn is already position: relative, but
   the run's own wrapper is not, and without a stacking position of its own it
   would sit under an absolutely positioned sibling that comes first in source. */
.fc-run { display: flex; position: relative; z-index: 1; }
.fc-run > .candy-btn { --corner-max: 0px; }
/* list-plus is drawn BOTTOM-HEAVY in its 24 box (ink y 6..21, centre 13.5 against
   the box's 12), so at a matched height it still paints one row lower than the
   other three - measured rows 9-20 against their 8-19. The mark is nudged, not
   the button, and not the FACE either: the face carries the frame, so moving it
   lifted the whole fourth cell a row out of line with its neighbours
   (photographed). Only the glyph moves. */
.fc-run > .candy-btn:last-child > .candy-face > svg { transform: translateY(-1px); }
`;

// -- THE NEW FACE, on the block's TOP plane -----------------------------------
//
// His own call 2026-09-20: the day at a glance on the left, two fused adders
// hugging the right edge the way the four controls hug the underside's bottom.
// Reached by scrolling UP - the opposite roll from the underside - so the clock
// sits exactly one notch from either face and nothing wraps.
//
// EVERYTHING SHARED WITH THE UNDERSIDE IS SHARED, NOT COPIED. .fc-lab and
// .fc-stats are declared once in UNDERSIDE_CSS and worn by both faces; the frame
// overhang, the depth reservation and the zeroed corners are the same three moves
// the bottom run already proved, turned ninety degrees.
const TOPSIDE_CSS = `
.fc-over {
  display: flex;
  height: 100%; box-sizing: border-box;
  font-family: var(--font-mono);
  /* The pen's own .button.back rule forces uppercase, and .top sits beside it in
     the same block. Off once here, for every descendant. */
  text-transform: none;
  /* Same one hairline the underside declares, so both faces divide the same way. */
  --us-line: color-mix(in oklch, var(--cbtn-rest), black 34%); }

/* .fc-col - the fused run TURNED SIDEWAYS. The shipped .candy-split sheet is
   row-only in three ways: inline-flex, a margin-LEFT overlap, and four rules that
   square a part's end or start corners. Only the first two matter here, because
   the parts carry --corner-max: 0px like the bottom run's do, so every radius in
   this run is already zero and the corner rules are no-ops on it.
   ponytail: three facts, not seven. A ROUNDED column run would need those corner
   rules written the other way round - promote this to .candy-split.is-column in
   styles.css on the day one is actually wanted, not before.

   ONE FRAME, NOT TWO, exactly as .fc-run does it: the run overhangs the content
   box by one --block-frame on top and right so its border lands on the block's
   rather than beside it. The bottom is the depth reservation instead - a candy
   button's band is cast BELOW its border box, so the run's box stops one depth
   short and the band falls into the reserved strip, landing on the frame's outer
   edge. Both numbers are read, never typed. */
.fc-col {
  display: flex; flex-direction: column; align-items: stretch;
  width: var(--cbtn-size);
  margin: calc(var(--block-frame) * -1) calc(var(--block-frame) * -1)
          calc(var(--candy-depth) - var(--block-frame)) 0; }
.fc-col > .candy-btn {
  --corner-max: 0px;
  /* height: auto beats .candy-split's height: var(--cbtn-size) on source order -
     this sheet is in the body, that one is in the head. min-height: 0 is what lets
     flex: 1 1 0 (set inline by SplitBtn) actually divide the height; a flex item's
     automatic minimum along the main axis is its content otherwise. */
  width: var(--cbtn-size); height: auto; min-height: 0; }
/* The overlap swaps axis: the trailing part climbs onto its neighbour's BOTTOM
   border so the two lines fuse into one seam, which is what margin-left does
   sideways in a row. */
.fc-col > .candy-btn:not(:first-child) {
  margin-left: 0; margin-top: calc(var(--split-lap) * -1); }
/* .candy-face carries padding: 8px 16px, which is 32px of SIDE padding - and a
   column part is only as wide as --cbtn-size. At 38px that leaves 6px for the
   mark and BOTH icons painted 2px wide (measured 2026-09-20, svg.w = 2 for a
   requested 14 and 16). It never showed on the bottom run because its parts are
   57.25px across and clear it comfortably. A column part is sized to its mark
   rather than to a label, so the side padding has no work to do: drop it and let
   the face's own centring place the glyph.
   The VERTICAL padding stays - it is doing the same job it does everywhere. */
.fc-col > .candy-btn > .candy-face { padding-left: 0; padding-right: 0; }

.fc-strip {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; justify-content: center;
  gap: 6px; padding: 0 11px; }
.fc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
/* .fc-stats gives every span 9px on BOTH sides, and on the underside that trailing
   9px falls off the end of a left-aligned row where nothing lines up against it.
   Pushed to the right by the header, it becomes a visible 9px of air between the
   last tally and the bar's right edge directly below it (photographed). The boxes
   already agree - .fc-head, .fc-bar and .fc-span all end at the same x - so this
   is the PAINT disagreeing with the layout, and only the paint needs moving. */
.fc-over .fc-stats > span:last-child { padding-right: 0; }

/* THE BAR IS PROPORTIONAL, never a fixed grid. Each planned block is a flex child
   sized by its own minutes and each gap between blocks is a spacer sized the same
   way, so the day's shape on screen IS the data's shape - no segment count, no
   typed 09:00-18:00 window that would lie on a short day. The span is the first
   block's start to the last block's end, read off the list.
   Sharp ends and no clip: the marker overhangs the bar by 2px top and bottom to
   read at this height, and square corners are the block's own language (every
   part of both runs declares --corner-max: 0px). */
.fc-bar {
  position: relative; height: 8px; display: flex;
  background: var(--us-line); }
.fc-seg { min-width: 0; }
/* Planned and worked solid, planned and not yet hollow, the gaps left to the
   track. Three tones, one bar, plan against reality. */
.fc-seg.is-done { background: var(--accent, oklch(0.55 0.16 25)); }
.fc-seg.is-plan { background: color-mix(in oklch, var(--cbtn-rest), white 6%); }
.fc-now {
  position: absolute; top: -2px; bottom: -2px; width: 2px;
  background: var(--text); }
.fc-span {
  display: flex; justify-content: space-between;
  font-size: 8px; letter-spacing: 0.12em; color: var(--text-faint); }
`;

// The dial own padding between the clock and the ring inner stroke. Same value
// PlannerDock uses; the readout fills both axes of what is left.
const READOUT_PAD_PX = 10;

export default function FlipTestPanel() {
  const copyRef = useRef(null);
  usePlannerBlockSize(copyRef);

  useEffect(() => {
    const added = LINKS.filter((href) => !document.querySelector(`link[href="${href}"]`))
      .map((href) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        document.head.appendChild(l);
        return l;
      });
    return () => added.forEach((l) => l.remove());
  }, []);

  return (
    <div>
      <div style={{ ...eyebrowStyle, margin: '20px 0 10px' }}>Flip test — pen 1-1</div>
      <div style={{
        fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
        marginBottom: 16, maxWidth: 440, lineHeight: '16px',
      }}>
        codepen.io/kevinfan23/details/BKbWxP, 3-D Flip, copied unchanged. Hover it.
      </div>

      <style>{PEN_CSS}</style>

      <style>{COPY_CSS}</style>
      <style>{CLOCK_CSS}</style>
      <style>{UNDERSIDE_CSS}</style>
      {/* AFTER the underside sheet on purpose: .fc-col beats .candy-split's
          row-only rules on source order alone, at equal specificity, and it
          reuses .fc-lab and .fc-stats declared above it. */}
      <style>{TOPSIDE_CSS}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        {/* ORIGINAL — index.html lines 55-64, verbatim. FROZEN, do not edit. */}
        <div className="button-container button-container-3d">
          <div className="flipper-3d">
            <div className="button button-3d front">
              <i className="fa fa-codepen" />
            </div>
            <div className="button button-3d back">
              Instagram
            </div>
          </div>
        </div>

        {/* COPY — same markup, sized off the live planner block. All further
            shaping lands here; the original on the left is frozen. */}
        <div ref={copyRef} className="button-container button-container-3d flip-copy">
          <div className="flipper-3d">
            <div className="button button-3d front">
              <i className="fa fa-codepen" />
            </div>
            <div className="button button-3d back">
              Instagram
            </div>
          </div>
        </div>

        <FlipClockBlock />
      </div>

      <div style={{
        fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
        marginTop: 26, maxWidth: 440, lineHeight: '16px',
      }}>
        Turns 90deg, not 180. The back sits on the block&apos;s underside, the hinge
        runs through its middle, so it rolls like a brick instead of folding like
        paper.
      </div>

      <DialKnobs />
    </div>
  );
}

// The two live knobs for the REAL Planner dial, which wears the same roll.
// They write CSS variables on :root and nothing else - no state is persisted, no
// prop is threaded, and the dial simply reads them. Tune against the real dial,
// then bake the chosen numbers into styles.css and delete this whole file.
//
// --dial-depth-k is a MULTIPLIER, not a px depth: the dial derives its real depth
// from the interior's measured height, so a px value typed here would drift the
// moment the dock is resized. 1 is the pen's own proportion (depth == height),
// which also makes the control face stand up at the interior's full height.
const KNOBS = [
  { v: '--dial-depth-k', label: 'depth x height', min: 0.1, max: 2, step: 0.05, init: 1, unit: '' },
  { v: '--dial-roll', label: 'roll', min: 100, max: 1400, step: 20, init: 500, unit: 'ms' },
  { v: '--dial-lift', label: 'lighter', min: 0, max: 25, step: 1, init: 5, unit: '%' },
];

function DialKnobs() {
  const [vals, setVals] = useState(() => Object.fromEntries(KNOBS.map((k) => [k.v, k.init])));

  const set = (k, n) => {
    setVals((p) => ({ ...p, [k.v]: n }));
    document.documentElement.style.setProperty(k.v, `${n}${k.unit}`);
  };

  return (
    <div style={{ marginTop: 30, maxWidth: 440 }}>
      <div style={{ ...eyebrowStyle, margin: '0 0 10px' }}>Planner dial roll</div>
      {KNOBS.map((k) => (
        <label key={k.v} style={{
          display: 'grid', gridTemplateColumns: '120px 1fr 74px', alignItems: 'center',
          gap: 10, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
          marginBottom: 8,
        }}>
          <span>{k.label}</span>
          <input type="range" min={k.min} max={k.max} step={k.step} value={vals[k.v]}
            onChange={(e) => set(k, Number(e.target.value))} />
          <span style={{ textAlign: 'right' }}>{vals[k.v]}{k.unit}</span>
        </label>
      ))}
      <button type="button" onClick={() => KNOBS.forEach((k) => set(k, k.init))}
        style={{
          marginTop: 6, fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-faint)', background: 'none', border: 0,
          padding: 0, cursor: 'pointer', textDecoration: 'underline',
        }}>
        reset both
      </button>
    </div>
  );
}
