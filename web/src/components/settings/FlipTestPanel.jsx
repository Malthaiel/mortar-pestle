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
import { IconRepeatSolid, IconPlayMark, IconSkipMark, IconListPlus } from '../icons.jsx';

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

// 27px is the app's standard TEXT split height, read off the live AlbumBrowser runs
// (the only ones that declare --cbtn-size) rather than typed from memory.
const SPLIT_H = '27px';

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

function FlipClockBlock() {
  const hostRef = useRef(null);
  usePlannerBlockSize(hostRef);
  const g = useDialRingGeometry();

  // The front face, once mounted, is where the ring is portalled - a state-holding
  // callback ref, because the portal only exists once there is a real node to put
  // it in, and that needs a render to notice. Same reason the dock uses one.
  const [frontNode, setFrontNode] = useState(null);

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

  return (
    <div ref={hostRef} className="button-container button-container-3d flip-copy flip-clock">
      <div className="flipper-3d">
        <div className="button button-3d front" ref={setFrontNode}>
          {g && (
            <div
              className="planner-ring-inner-controls"
              ref={innerBoxRef}
              style={{ top: inset, bottom: inset, left: inset, right: inset, '--ring-radius': '0px' }}
            >
              <div className="planner-timer-digits">
                <SegmentReadout value="30:00" w={readoutBox.w} h={readoutBox.h} />
              </div>
            </div>
          )}
        </div>
        {/* THE UNDERSIDE, user-designed 2026-09-20 (his own layout, after the six
            studies were all rejected): the plate readout from study 3 on top, one
            fused four-part candy-split run filling the bottom 42%, flush to the
            left, right and bottom frame.

            THE RUN IS A REAL .candy-split, not a lookalike - ordinary .candy-btn
            children in a .candy-split wrapper, so the seams, the 2px frame overlap
            and the hover z-order all arrive from the shipped rules.

            The handlers are no-ops on purpose: this is a shape-and-paint rig with
            no timer behind it, and wiring it to the live timer would let a stray
            click in the Dev tab reset Malthaiel's actual session. */}
        <div className="button button-3d back">
          <div className="fc-under">
            <div className="fc-plate">
              <div className="fc-task">
                <span className="fc-lab">TASK</span>
                <span className="fc-val">Rewrite the dial</span>
              </div>
              <div className="fc-stats">
                <span>3 done</span><span>1h 12m</span><span>next 14:00</span>
              </div>
            </div>
            <div className="candy-split fc-run" style={{ '--cbtn-size': SPLIT_H }}>
              <SplitBtn title="Reset" Icon={IconRepeatSolid} />
              <SplitBtn title="Start" Icon={IconPlayMark} size={20} />
              <SplitBtn title="Skip to break" Icon={IconSkipMark} size={22} />
              <SplitBtn title="Select a task for this session" Icon={IconListPlus} size={18} />
            </div>
          </div>
        </div>
      </div>

      {/* Hidden: only its portalled ring is ever seen. */}
      <div style={{ display: 'none' }}>
        {frontNode && g && (
          <DualRingRect
            remainingMins={30}
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
// His own layout, 2026-09-20, after all six of the earlier studies were rejected.
// The six flat study rectangles and their .us-* sheet were deleted in the same
// pass; nothing else consumed them.
//
// THE GEOMETRY, all of it measured rather than typed. The underside is 233 x 84
// and its 2px frame leaves 229 x 80 to work in. The run is 27px of face - the
// app's standard text-split height, read off the live AlbumBrowser runs - plus its
// own lip, for 34px of paint, 42% of the 80. The plate takes the 46 above it.
//
// FLUSH TO THE BOTTOM WITHOUT LOSING THE LIP. A candy button's depth is a
// box-shadow cast BELOW its border box, so a run whose box touched the frame would
// paint its band straight through it. Instead the container reserves exactly one
// depth of bottom padding: the run's box stops that far up and its band falls into
// the reserved strip, landing ON the frame. The reservation reads --candy-depth,
// the same token .candy-btn derives --cbtn-depth from, so the two can never drift -
// including under the depth presets in Settings, which rewrite that token on body.
//
// SHARP CORNERS. .candy-btn re-declares --corner-max on itself precisely so a
// wrapper cannot set it, and .candy-split then overrides it again with half the
// run's height. Zeroing it needs a rule of its own at equal specificity, placed
// after both - which an inline <style> in the body is, by document order.
const UNDERSIDE_CSS = `
.fc-under {
  display: flex; flex-direction: column;
  height: 100%; box-sizing: border-box;
  /* ONE FRAME, NOT TWO. The block's 2px frame is the candy frame width on
     purpose, and it is the run's outline too - so the run OVERHANGS the content
     box by exactly one frame on three sides and its own border lands on top of
     the block's, the same way two fused .candy-split halves share a seam. Both
     lines are color-mix(--cbtn-rest, black 22%), so the overlap is invisible.
     The bottom reservation shrinks by the same frame: the band still fills what
     is left and now reaches the frame's OUTER edge. Without this the underside
     carried 4px of doubled border down three sides and the run read inset. */
  padding-bottom: calc(var(--candy-depth) - var(--block-frame));
  font-family: var(--font-mono);
  /* The pen's own .button.back rule forces uppercase and that is inherited
     lettering, not this plate's. Off once here, for every descendant. */
  text-transform: none;
  /* One hairline, one rule - the stat dividers and nothing else. */
  --us-line: color-mix(in oklch, var(--cbtn-rest), black 34%); }

/* Lifted from study 3 unchanged: the one arrangement that added what the front
   face lacks. Its 34px tool column is gone - the run below replaces it - so the
   right gutter goes back to matching the left. */
.fc-plate { flex: 1; min-height: 0;
  display: flex; flex-direction: column; justify-content: center;
  gap: 7px; padding: 0 11px; }
.fc-task { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.fc-lab { font-size: 8px; letter-spacing: 0.16em; color: var(--text-faint); }
.fc-val { font-size: 12px; font-weight: 700; color: var(--text); letter-spacing: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-stats { display: flex; align-items: center; font-size: 9px; color: var(--text-muted); }
.fc-stats > span { padding: 0 9px; border-left: 1px solid var(--us-line); }
.fc-stats > span:first-child { padding-left: 0; border-left: 0; }

/* .candy-split is inline-flex by default; the run has to span the face - and
   then one frame past it on each side, so the outer parts' borders sit on the
   block's own frame rather than beside it. */
.fc-run { display: flex; margin: 0 calc(var(--block-frame) * -1); }
.fc-run > .candy-btn { --corner-max: 0px; }
/* list-plus is drawn BOTTOM-HEAVY in its 24 box (ink y 6..21, centre 13.5 against
   the box's 12), so at a matched height it still paints one row lower than the
   other three - measured rows 9-20 against their 8-19. The mark is nudged, not
   the button, and not the FACE either: the face carries the frame, so moving it
   lifted the whole fourth cell a row out of line with its neighbours
   (photographed). Only the glyph moves. */
.fc-run > .candy-btn:last-child > .candy-face > svg { transform: translateY(-1px); }
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
