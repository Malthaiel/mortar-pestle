import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DualRingRect, {
  // Ring 3's PAINT lives here on the dock (2026-09-08 Ribbon Pour, rebuilt as a
  // real tube 2026-09-09). The geometry did NOT get copied with it - the dial
  // still owns the width and the path, and the tube MEASURES itself against that
  // groove every frame rather than restating any of it.
  RING_INNER_EDGE, RING_EDGE_GAP, RIBBON_W, SESSION_OUTER_INSET,
} from './watchfaces/DualRingRect.jsx';
import { cornerAt, useWidgetCorner, useInsetFromWidget } from './watchfaces/corners.js';
import SegmentReadout, { readoutHeightForWidth } from './watchfaces/SegmentReadout.jsx';
import {
  IconReset, IconSkip, IconX, IconCheck, IconStop,
  IconPlay, IconPause, IconListPlus, IconPlus, IconNotes,
} from '@host/components/icons.jsx';

// Icon sizes are set PER CALL SITE because the `size` prop lies: it sets the SVG
// box, not the mark inside it. The two Boxicons glyphs here (IconSkip, IconPlay)
// are drawn on a 24 viewBox with paths spanning only 7..17, so they ink ~42% of
// their box; every Font Awesome one (IconReset, IconPause, IconStop, IconX,
// IconCheck) fills its box edge to edge. At a shared size the FA marks painted
// ~2.4x larger, which is what "the icons are way too large" looked like.
// So ONE ink target, two derived box sizes - nothing to keep in sync by hand.
// Pack defaults are shared app-wide and must NOT be changed for this.
// Ratios below are read off the path data, not guessed:
//   IconSkip     bx 24 box, path x 7..17       -> 0.42 of the box
//   IconPlay     bx 24 box, path y 6..18       -> 0.50 of the box (its TALL axis)
//   IconListPlus bx 24 box, inked 10 at size 14 -> 0.71 of the box
//   FA glyphs 512 box, paths fill it           -> 1.00
// A SOLID mark reads heavier than an outline at equal ink, so the two filled
// ones (play, pause) are shaved — the same correction the old row applied to
// IconStop, kept because it is a fact about the eye, not about the box.
//
// INK DROPPED 16 -> 12 with the port (2026-09-20): the marks used to sit in
// full-height panels covering the whole interior and now sit in a 24px fused
// run, so 16 overflowed it. 12 is what the Dev rig's four parts were tuned to
// on a photograph - its default size 14 painted the reset mark 12 across.
const RUN_INK_PX = 12;      // painted mark inside a control part, design px
const RUN_H_PX = 24;        // the fused run's height, design px (rig-tuned)
// The sideways run's WIDTH. In a column --cbtn-size stops being a height and
// becomes the across measurement, because the two parts split the face's height
// between them the way the bottom run's four split its width.
const COL_W_PX = 38;

// PLACEHOLDER DAY, ported from the rig as-is (user-directed 2026-09-20: copy it
// across first, wire the real day after). Shaped as the real one will be - a
// flat run of segments in MINUTES, with the gaps between blocks carried as
// segments of no kind so the bar's own track shows through. Nothing here is a
// clock time; the bar is proportional and the two end labels are the only
// times on the face. Replace with planBlocks + sessions off PlannerProvider.
const DEMO_DAY = [
  { mins: 45, kind: 'done' },
  { mins: 15, kind: null },
  { mins: 60, kind: 'done' },
  { mins: 30, kind: null },
  { mins: 45, kind: 'plan' },
  { mins: 45, kind: null },
];
const DEMO_NOW_PCT = 58;
const SOLID_TRIM = 0.85;    // filled marks read heavier than outlines

import { useModuleSettings } from '@host/hooks/useSettings.js';
import { usePlanner } from './PlannerProvider.jsx';
import { todayLocalStr } from '@host/util/time.js';

function pad(n) { return String(n).padStart(2, '0'); }

// Single source for the MM:SS string. While the dial is being dragged to set a
// new duration the readout previews the drag value (MM:00) instead of secsLeft.
// Lives at module scope because both the transport pill (built in PlannerDock)
// and TimerWidget's PAUSED line need the identical string.
function mmss(secsLeft, dragMins) {
  const s = dragMins != null ? dragMins * 60 : secsLeft;
  return `${pad(Math.floor(Math.max(0, s) / 60))}:${pad(Math.max(0, s) % 60)}`;
}

const DEFAULT_APP_ACCENT = '#c0392b';

// REMOVED WITH THE TUBE (2026-09-20, archived in _attic/tube). What stood
// here: SPOUT_GAP / SPOUT_JOIN (the circuit's mouth gap and its junction
// radius), SLING_CATCH, WATER_W, `parseBezier`, and the long record of how
// the pour's chase was tuned against his eye. The archive keeps all of it.

// The planner chrome accent for JS-coloured bits (calendar events, phase pill
// fallback). Accent is one global value app-wide now — the unified theme accent —
// so this is just settings.accentColor; the old Monastic-vs-community /
// per-module appAccent branching is retired. The ring ARC reads var(--accent)
// straight from :root instead, so it also tracks the live hover-preview.
function plannerAccent(settings) {
  return settings?.accentColor || DEFAULT_APP_ACCENT;
}

export default function PlannerDock() {
  const p = usePlanner();
  const todayDate = useMemo(() => new Date(), []);

  const {
    settings, setSetting,
    phase, secsLeft, running, sessionStart,
    dragMins, idle, pauseStartRef,
    activeTaskName,
    // THE DAY'S DATA, kept through the calendar's removal (2026-09-22). Nothing
    // draws it yet: the dial's TOP face still paints DEMO_DAY and is owed this
    // feed. Dropping it here would only mean re-adding it when that lands.
    // eslint-disable-next-line no-unused-vars
    sessions, planBlocks,
    toggleTimer, resetTimer, endSessionEarly, skipPhase,
    handleDragStart, handleDrag, handleDragEnd,
    blockRun, stopBlockRun, finishBlockEarly,
  } = p;

  const accent = plannerAccent(settings);
  const now = new Date();
  // All Planner accents (controls, dial stroke, tab pills, active-task) draw
  // from the global appAccent now — the focus/break green distinction was
  // dropped per user request. (The old `phaseColor` alias died with the
  // START/PAUSE label, its only consumer.)

  const { settings: moduleSettings } = useModuleSettings('planner');

  // Track dock width via ResizeObserver so the dial + digits + button row scale
  // proportionally as the sidebar is drag-resized. Baseline 300px = canonical
  // dock width. Scale clamps [0.55, 1.5] so the dial stays readable at extremes
  // and the buttons remain tappable.
  const dockRef = useRef(null);
  const [dockWidth, setDockWidth] = useState(300);
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    setDockWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => {
      setDockWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(1.5, Math.max(0.55, dockWidth / 300));






  // Controls (Reset / Play-Pause / Skip-or-EndEarly). Built once and placed
  // inside the rect ring-button via TimerWidget's innerControls prop, where they
  // are three flush full-height panels covering the dial's whole interior,
  // revealed on hover (user-directed 2026-09-03). Block runs swap the whole row
  // for cancel + finish-early: pause is disallowed during a block (it would
  // drift the finish past the block's calendar end), and Reset/Stop were three
  // spellings of the same cancel.
  // NOT scaled. The rig tuned these against the REAL block's painted size
  // (233x84, read live off this dial), so the number already carries whatever
  // scale the dock was at - multiplying again shrank the run to 22px. The whole
  // underside shell is absolute px for the same reason its 10px gap is.
  const ink = RUN_INK_PX;
  const faPx = Math.round(ink);                        // FA outlines fill their box
  const bxPx = Math.round(ink / 0.42);                 // IconSkip
  const playPx = Math.round((ink * SOLID_TRIM) / 0.50); // IconPlay, sized on its tall axis
  const pausePx = Math.round(ink * SOLID_TRIM);        // IconPause (FA, solid)
  const taskPx = Math.round(ink / 0.71);               // IconListPlus
  const ctrlThird = phase === 'focus' && sessionStart ? (() => {
    const elapsedMs = (pauseStartRef.current ?? now) - sessionStart;
    const elapsedMin = Math.max(1, Math.round(elapsedMs / 60000));
    return (
      <DialCtrl onClick={endSessionEarly}
        title={`End session early · logs ${elapsedMin}m`}><IconStop size={pausePx}/></DialCtrl>
    );
  })() : (
    <DialCtrl onClick={skipPhase}
      title={phase === 'focus' ? 'Skip to break' : 'Skip to focus'}><IconSkip size={bxPx}/></DialCtrl>
  );
  // The readout is no longer a line ABOVE this row - it fills the same interior
  // underneath the panels, and the panels are dim enough to read it through
  // (user-directed 2026-09-03). The middle panel is a play/pause glyph, not a
  // word, so nothing here carries text any more.
  const controlsJSX = blockRun ? (
    <>
      <DialCtrl onClick={stopBlockRun}
        title="Cancel block timer — nothing is logged"><IconX size={faPx}/></DialCtrl>
      <DialCtrl onClick={finishBlockEarly}
        title="Finish block early — trims the block to now"><IconCheck size={faPx}/></DialCtrl>
    </>
  ) : (
    <>
      <DialCtrl onClick={resetTimer} title="Reset"><IconReset size={faPx}/></DialCtrl>
      <DialCtrl onClick={toggleTimer}
        title={running ? 'Pause' : (idle ? 'Start' : 'Resume')}>
        {running ? <IconPause size={pausePx}/> : <IconPlay size={playPx}/>}
      </DialCtrl>
      {ctrlThird}
      {/* THE FOURTH PART IS INERT ON PURPOSE (user-directed 2026-09-20: "keep
          four, we'll wire that button in later"). The task a session logs
          against resolves itself today - block run, then plan block, then vault
          task, then the last session - so there is no hand-pick to call yet.
          The part is here because the run's shape was approved with four. */}
      <DialCtrl mark="task" title="Select a task for this session"><IconListPlus size={taskPx}/></DialCtrl>
    </>
  );

  return (
    <div ref={dockRef} style={{
      '--planner-widget-margin': `${WIDGET_MARGIN}px`,
      // REMOVED WITH THE CALENDAR (2026-09-22): --planner-slab-inset,
      // --planner-ribbon-w and --planner-pour-r, plus the `home` effect that
      // measured the first two off the clock's plate. Every one of them existed
      // to line the calendar's slab up with the dial's; nothing else read them.
      position: 'relative',
      width: '100%', minWidth: 0,
      display: 'flex', flexDirection: 'column',
      // Transparent so the enclosing .rail-tile candy chrome (surface-3
      // fill + hover-red) reads through as the button interior, faithful to the
      // music tile.
      background: 'transparent',
      // VISIBLE since 2026-09-22: the block's mid-roll growth has to reach the tile,
      // and this box was the first thing clipping it. Nothing here scrolls or
      // animates a height any more, so there is nothing left for a clip to do.
      overflow: 'visible',
      // flex-basis:auto so the dock sizes to its content when the shell stops
      // growing (calendar collapsed); grows to fill when the shell fills.
      flex: '1 1 auto',
      minHeight: 0,
    }}>
      {/* Planner body — always visible */}
      <div style={{
          flex: '1 1 auto', minHeight: 0,
          display: 'flex', flexDirection: 'column',
          // VISIBLE since 2026-09-24: its top edge IS the block's top, so a clip here
          // sliced the digits mid-roll (filmed). The calendar that scrolled in here
          // is gone. The tile face and the rail slot clipped too - see styles.css
          // .rail-tile.is-planner > .candy-face and AppShell's getItemStyle.
          overflow: 'visible',
        }}>
          {/* Timer widget — integrated into the dock (no card chrome): phase label + scaled dial + MM:SS. */}
          <TimerWidget
            phase={phase}
            running={running}
            idle={idle}
            sessionStart={sessionStart}
            secsLeft={secsLeft}
            dragMins={dragMins}
            handleDragStart={handleDragStart}
            handleDrag={handleDrag}
            handleDragEnd={handleDragEnd}
            moduleSettings={moduleSettings}
            settings={settings}
            scale={scale}
            innerControls={controlsJSX}
          />
      </div>

    </div>
  );
}

// ── Dock helper components ──────────────────────────────────────────────────

function TimerWidget({
  phase, running, idle, sessionStart, secsLeft,
  dragMins, handleDragStart, handleDrag, handleDragEnd,
  moduleSettings, settings,
  scale = 1,
  innerControls = null,
}) {
  // MM:SS renders here again as a plain line above the control row — the
  // transport button carries a word instead (user-directed 2026-08-27). The
  // "PAUSED — MM:SS LEFT" line below the ring stays gone.
  const glowOn    = settings.animations?.['clock-ambient'] !== false;

  // ONE button now (user-directed 2026-09-06): the dial, the strip and the
  // calendar all sit on the rail tile's single face, so a press on the dial is
  // the TILE's press. The class is toggled on the node instead of lifted through
  // state because the tile is rendered two components up (index.jsx), and it has
  // to be JS-held rather than :active - pointer capture during the time drag
  // drops :active the moment the pointer leaves the dial.
  const setDialPressed = (on) => {
    ringButtonRef.current?.closest('.rail-tile')?.classList.toggle('is-pressed', on);
  };

  // Ring-button is width: 100% to match TOOLKIT-style container-filling. The
  // SVG inside needs actual pixel dims for the rounded-rect path math, so we
  // measure the button's content box via ResizeObserver and pass it down. The
  // initial useLayoutEffect measure runs synchronously before paint, avoiding
  // the zero-width flash on first render.
  const ringButtonRef = useRef(null);
  const [ringSize, setRingSize] = useState({ w: 0, h: 0 });

  // The two numbers every corner in this widget is derived from, both MEASURED off
  // the live tile rather than recomputed: what the tile's own corner actually
  // paints, and how far the dial's box sits inside it. Declared below the ref they
  // read - a hook call above its ref is a TDZ crash, not a warning.
  const outerR = useWidgetCorner(ringButtonRef);
  const svgInset = useInsetFromWidget(ringButtonRef);

  // The readout FILLS the block's interior (user-directed 2026-09-03), so the box
  // is MEASURED and handed to the display, which lays itself out to fill it. The
  // old measured-text fit died with the typeface: SegmentReadout is drawn, so it
  // sizes off real px rather than chasing a font's painted extent.
  const innerBoxRef = useRef(null);
  const [readoutBox, setReadoutBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
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
  }, []);

  // THE TURNING BLOCK FILLS THE TILE (user-directed 2026-09-22: "the clock face
  // (3d object) to take up the entire tile rather than having a border around it"
  // — then "keep the same clock face aspect ratio, make the tile smaller to
  // accommodate"). So the block is no longer MEASURED off the groove and pulled in
  // by the ring band; it is the dial's own box, and the dial's HEIGHT is what
  // shrinks to keep the proportion the block already had.
  //
  // The aspect is derived, never typed. Every term below is a pure function of the
  // tile's inner width, so there is no feedback loop from the height it produces:
  //   nat  = the pre-2026-09-22 geometry, still computed
  //   band = the ring band the block used to sit inside, from the two exports
  //   k    = how much the block grows once that band stops costing it room
  // Retune RING_EDGE_GAP or RIBBON_W and the ratio follows on its own.

  // WHICH FACE IS UP: -1 top, 0 clock, +1 underside. Ported from the Dev-tab rig
  // 2026-09-20. Written INLINE on the flipper below, which is what lets it beat
  // the sheet's own :hover rule without that rule being edited out of the way.
  //
  // OWNING A WHEEL TAKES TWO THINGS, and stopPropagation is neither. smoothWheel
  // is registered CAPTURE-PHASE ON WINDOW, so nothing attached down here can be
  // heard before it - its own data-owns-wheel opt-out is the answer. And the
  // browser's default scroll needs preventDefault on a { passive: false }
  // listener, which React cannot give: it attaches wheel PASSIVELY at its root,
  // so preventDefault inside an onWheel prop is a silent no-op.
  const dialHostRef = useRef(null);
  // The front face, once mounted, is where DualRingRect paints its session ring.
  // A state-holding callback ref rather than a plain one: the portal only exists
  // once there is a real node to put it in, and that needs a render to notice.
  const [ringSlotNode, setRingSlotNode] = useState(null);
  const [face, setFace] = useState(0);
  // HOW FAR THE TURNING BLOCK IS PAINTING PAST ITS BOX, this frame. Mid-roll a
  // solid block projects TALLER than the box it turns in - its height peaks at the
  // diagonal of its own height and depth - and that growth is the whole illusion
  // (user-directed 2026-09-22). The tile has to make room for it or the block is
  // clipped back to a flat card.
  //
  // MEASURED, never modelled. The perspective, the depth and the easing curve all
  // live in CSS; a formula here would be a copy of three numbers this file does not
  // own, wrong the moment any of them is retuned. The rect of a rotated element is
  // its PROJECTION, so reading it every frame IS the answer.
  const flipInnerRef = useRef(null);
  const rollLockRef = useRef(0);
  useEffect(() => {
    const el = dialHostRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      if (now < rollLockRef.current) return;   // one notch per roll
      const dir = e.deltaY > 0 ? 1 : -1;
      setFace((f) => {
        const next = Math.max(-1, Math.min(1, f + dir));
        // The roll's duration is the Dev slider's, READ off the live element
        // rather than restated here, so the two cannot drift.
        if (next !== f) {
          const ms = parseFloat(getComputedStyle(el).getPropertyValue('--dial-roll')) || 500;
          rollLockRef.current = now + ms;
        }
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // HOW FULL THE CLOCK FACE'S WATER IS: the share of the dial's hour already
  // burned. The dial spans 60 minutes - the same span DualRingRect draws its arc
  // over and the same one its drag clamps to - so this reads off the remaining
  // minutes and restates nothing. Empty at a full hour left, drowned at zero.
  // IDLE READS THE PHASE'S SET DURATION, not the ticking counter - the same
  // swap MiniRadialDial makes (`isIdle ? focusSecs : secsLeft`). secsLeft is 0
  // on a restored-complete session, so reading it at idle drowned a dial that
  // was sitting at rest. Off the set duration the level simply freezes where a
  // session would start, and the run then continues from that exact level.
  const { focusSecs, breakSecs } = usePlanner();
  const phaseSecs = phase === 'focus' ? focusSecs : breakSecs;
  const remainingMins = dragMins != null
    ? dragMins
    : (idle ? phaseSecs : secsLeft) / 60;
  const waterPct = Math.max(0, Math.min(100, (1 - remainingMins / 60) * 100));

  // ONE height, two consumers: the button's own style and the SVG's pre-measure
  // fallback. They were separate literals (126 and a stale 113) — a restated
  // constant that had already gone wrong, painting one frame at the old size.
  // The dial's height is DERIVED from what the readout actually paints, not typed
  // (user-directed 2026-09-06: the gap above and below the clock has to match the
  // gap left and right of it). The display is width-limited here, so its painted
  // height follows from the interior's width alone - ask it, then add the same
  // READOUT_PAD_PX on top and bottom that the sides already get, plus the ring
  // stack. No feedback loop: nothing in that chain reads the height back.
  // The dial's BOX carries the ring's own edge gap inside itself, so to land the
  // PAINTED ring on WIDGET_MARGIN the box has to overflow its slot by the
  // difference. Signed: once the margin is tighter than the gap the box grows past
  // 100% instead of shrinking, and `calc(100% - -3.6px)` is a parse error, not a
  // negative subtraction.
  const dialOverflow = 2 * (RING_EDGE_GAP - WIDGET_MARGIN);
  const dialW = ringSize.w || Math.round(242 * scale);
  // The dial's box is the tile's inner width flat now — no sideways overflow to
  // put a painted ring on the widget's margin, because there is no painted ring.
  const dialWNat = dialW + dialOverflow;
  const ringHNat = Math.round(
    readoutHeightForWidth(dialWNat - 2 * RING_INNER_EDGE - 2 * READOUT_PAD_PX)
    + 2 * READOUT_PAD_PX + 2 * RING_INNER_EDGE,
  );
  // The band the block used to sit inside: the groove's own inset plus the half
  // stroke its rect carries, plus the full stroke blockBox pulled in by. Summed
  // from the two exported widths, so retuning either moves this with it.
  const blockBand = RING_EDGE_GAP + 1.5 * RIBBON_W;
  const blockWNat = dialWNat - 2 * blockBand;
  const blockHNat = ringHNat - 2 * blockBand;
  const blockK = blockWNat > 0 ? dialW / blockWNat : 1;
  const blockH = Math.round(blockHNat * blockK);
  const blockBox = { l: 0, t: 0, w: dialW, h: blockH };
  // The padding the digits had INSIDE the old block, grown by the same factor.
  const readoutPad = (RING_INSET - blockBand) * blockK;
  // THE SESSION RING, re-placed against the block's rim (user-directed
  // 2026-09-22, after it came off with the ring band and he asked where it went).
  // It was never in the band: portalled into the front face it painted 6.4px
  // INSIDE the block's edge, and that is the gap kept here - grown by blockK like
  // everything else the block carries. Derived from the dial's own export, so
  // retuning the ring stack still moves it.
  const ringOuterInset = (SESSION_OUTER_INSET - blockBand) * blockK;

  useEffect(() => {
    const inner = flipInnerRef.current;
    const host = dialHostRef.current;
    const block = inner?.parentElement;
    if (!inner || !host || !block) return undefined;
    // The roll's own clock, read off the live element like the wheel handler does.
    const ms = parseFloat(getComputedStyle(host).getPropertyValue('--dial-roll')) || 500;
    const until = performance.now() + ms + 60;   // a little past, so the settle lands on 0
    // THE TILE HUGS THE SILHOUETTE, both edges, every frame (user-directed
    // 2026-09-24: "the button ... grow/contract following the exact pixels of this
    // growth"). Written straight to the DOM in the same frame the rects are read:
    // routed through React state it painted a frame or more behind the roll.
    // THE TILE'S TOP NEVER MOVES (user-directed same day: "the top of the tile
    // never exceed its idle height" - letting it rise ran it over the Version
    // strip). So the dial drops by what the block pokes out above, which pins the
    // painted top at rest, and its bottom margin carries what pokes out below:
    // all of the growth goes down, and the tile's bottom lands on the paint. Each
    // side is measured on its own - the old code gave the bottom 2x the average,
    // which is not what the block paints.
    const write = (up, down) => {
      host.style.marginTop = up ? `${up}px` : '';
      host.style.marginBottom = down ? `${down}px` : '';
    };
    let raf = 0;
    const tick = () => {
      // THE SOLID'S SILHOUETTE, not the hinge's. `inner` is the rotating box itself
      // and carries NO depth - its own rect shrinks to 0 at 90deg, measured, which
      // is the opposite of what the eye sees. The depth lives on the FACES
      // (translateZ(+-dial-depth/2)), so the block's real extent is the union of
      // their projected rects: at 45deg the front face's top edge has swung well
      // above the box it turns in, and that is the growth.
      let top = Infinity, bot = -Infinity;
      for (const f of inner.children) {
        const r = f.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (r.top < top) top = r.top;
        if (r.bottom > bot) bot = r.bottom;
      }
      const b = block.getBoundingClientRect();
      if (bot > top && performance.now() < until) {
        write(Math.max(0, b.top - top), Math.max(0, bot - b.bottom));
        raf = requestAnimationFrame(tick);
      } else write(0, 0);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); write(0, 0); };
  }, [face, blockH]);

  useLayoutEffect(() => {
    const el = ringButtonRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setRingSize({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{
      width: '100%',
      background: 'transparent',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        // ZERO since 2026-09-22: the block fills the tile edge to edge, so there
        // is no band for this to be even WITH. The tile's own candy edge is the
        // only border left, and it is the button, not a margin.
        paddingTop: 0,
        gap: Math.round(10 * scale),
      }}>
        {/* Dial + digits group — concentric rect dial filling the dock width,
            with MM:SS + controls overlaid inside the ring. */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: Math.round(14 * scale),
            width: '100%',
          }}>
            <div
              // TWO owners, ONE ref prop. This element is both the dial's ruler
              // (ringButtonRef, which the block-box measure reads) and the surface
              // that owns the scroll wheel (dialHostRef). A second ref={} attribute
              // does not add an owner - JSX keeps the LAST one and drops the first,
              // which silently unhooked the ruler and collapsed the whole face to
              // 0x0 (2026-09-20, found by probe: the callback never fired while its
              // own children were in the DOM).
              ref={(nd) => { ringButtonRef.current = nd; dialHostRef.current = nd; }}
              // DIRECTION DECIDES (user-directed 2026-09-24): the clock fills the
              // tile, so it has to carry both gestures. The first move past the
              // sidebar list's MOVE_THRESHOLD picks one - up/down lifts the tile to
              // reorder, left/right sets the time (DualRingRect decides on the
              // same number). A still hold lifts nothing; it only presses.
              data-drag-axis="y"
              // THE TILE PRESSES WHEREVER THE CLOCK IS HELD (user-directed
              // 2026-09-24), running or idle, either face - except on a nested candy
              // button, which owns its own press. DualRingRect only presses while
              // idle and only from its svg; this covers the rest. Window listeners,
              // because the svg's pointer capture keeps the release off this node.
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const b = e.target.closest('.candy-btn');
                if (b && e.currentTarget.contains(b)) return;
                setDialPressed(true);
                const up = () => {
                  setDialPressed(false);
                  window.removeEventListener('pointerup', up);
                  window.removeEventListener('pointercancel', up);
                };
                window.addEventListener('pointerup', up);
                window.addEventListener('pointercancel', up);
              }}
              // A plain region on the tile's face - no shell, no frame, no depth
              // of its own. position:relative so the inner-controls overlay still
              // anchors here, and the SVG now spans this box exactly, which is why
              // RING_INSET below no longer subtracts a frame.
              className="planner-dial"
              data-owns-wheel
              style={{
                position: 'relative',
                // The dial's BOX overflows its slot by the ring's own edge gap on
                // all four sides, so the painted ring lands on the same 14px margin
                // as the strip and the calendar (user-directed 2026-09-06: "too much
                // space on the outside of the dual ring"). Matching the boxes left
                // the ring looking inset by an extra ~10px, because the svg holds
                // that gap inside itself. Negative margins cancel the overflow, so
                // the column's own spacing is unchanged.
                width: '100%',
                // NO margins here: the roll's growth writes marginTop/marginBottom
                // straight onto this node every frame (see the silhouette effect).
                // 126: the interior is what the ring's inner edge leaves —
                // height − 2×RING_INNER_EDGE. Grown from 121 on 2026-08-28
                // ("make the dual ring slightly larger to accommodate"); the
                // readout that lives in that interior now MEASURES itself to
                // fill it, so this height is what decides how big it gets.
                // NOT widened vertically the way the box is horizontally: the
                // sideways overflow is what lines the painted ring up with the
                // strip, and adding it on the height too made the ring 20px
                // taller and visibly squarer (user-directed 2026-09-06 - keep the
                // old proportion, take only the width).
                height: blockH,
              }}
            >
              <DualRingRect
                remainingMins={secsLeft / 60}
                phase={phase}
                running={running}
                // THE PLATE IS INVISIBLE (user-directed 2026-09-20: "remove the
                // tube and background that is around the clock"). NOT removed:
                // the calendar's whole alignment - calGap, slabInset, proud - is
                // measured off this rect's real box, and the selector that finds
                // it matches on the token being in the fill. A fully transparent
                // mix OF that token keeps both true: nothing paints, the rect is
                // still there, and the query still finds it.
                // THE RING BAND came off 2026-09-22 and the ring came back with it
                // re-placed: the svg IS the turning block now, so the session ring is
                // drawn against the block's rim (ringOuterInset) and portalled into
                // the front face so it turns with the clock. The plate paints nothing
                // and the groove's job as the block's ruler ended with the band.
                ringOuterInset={ringOuterInset}
                plate="color-mix(in oklch, var(--planner-face), transparent 100%)"
                outerR={outerR}
                svgInset={svgInset}
                width={dialW}
                height={blockH}
                interactive={idle}
                dragMins={dragMins}
                glow={glowOn}
                onDragStart={handleDragStart}
                onDrag={handleDrag}
                onDragEnd={handleDragEnd}
                onPressedChange={setDialPressed}
                ringSlot={ringSlotNode ? { node: ringSlotNode, dx: 0, dy: 0 } : null}
              />
              {innerControls && (
                /* The interior is ONE box with two layers stacked in a single
                   grid cell: the readout filling it, and the three control
                   panels covering it, revealed on hover. The four insets come
                   from DualRingRect's own exported ring geometry - they were
                   hardcoded 26/29 literals in styles.css, a copy of that
                   number that could drift the moment the ring was retuned. */
                <div className="planner-dial-block" style={{
                  top: blockBox.t, left: blockBox.l,
                  width: blockBox.w, height: blockBox.h,
                  // NESTED, not cornerAt's SAME (user-directed 2026-09-24): the block
                  // sits flush inside the tile's outline, whose inner edge curves at
                  // the outer radius MINUS the inset - the browser's own border rule.
                  // At SAME (12 in an 8px hole, probed) the tile showed through as a
                  // crescent at all four corners. The rings deeper in keep SAME.
                  '--block-radius': `${Math.max(0, outerR - (svgInset + blockBox.l))}px`,
                  '--dial-depth': `calc(var(--dial-depth-k, 1) * ${blockBox.h}px)`,
                }}>
                  <div className="planner-dial-flip-inner" ref={flipInnerRef}
                    // ponytail: 89.95, not 90. A hinge at exactly 90deg is edge-on - its
                    // matrix has no inverse - and Chromium then hit-tests NOTHING inside
                    // it, so the underside/top buttons were dead to clicks (probed
                    // 2026-09-24: at 90 the button is absent from elementsFromPoint, at
                    // 89.95 it is first). The 0.05deg shortfall paints under 0.1px.
                    style={{ transform: `rotateX(${face * 89.95}deg)` }}>
                    {/* The face turned toward you: the session ring, painted into
                        here by DualRingRect through its ringSlot, with the water and
                        the clock inside it. All of it turns as one piece. */}
                    <div className="planner-dial-flip-face front" ref={setRingSlotNode}>
                      {/* The water, behind everything on this face. Its clipper is
                          its own box rather than overflow on the face, because the
                          face is the block's own material and clipping it would
                          cut the block's depth off with the water. */}
                      <div className="planner-dial-wet" aria-hidden="true">
                        <div className="planner-dial-liquid" style={{ '--dial-fill': `${waterPct}%` }} />
                      </div>
                      <div className="planner-ring-inner-controls" ref={innerBoxRef} style={{
                        // SCALED with the block. RING_INSET is measured from the
                        // SVG's edge, so the padding the digits actually had INSIDE
                        // the block was always RING_INSET minus the band the block
                        // sat in - scaling the whole inset instead nearly tripled it
                        // and shrank the readout (photographed 2026-09-22).
                        top: readoutPad, bottom: readoutPad,
                        left: readoutPad, right: readoutPad,
                        '--ring-radius': `${cornerAt(outerR, svgInset + RING_INSET)}px`,
                      }}>
                        <div className="planner-timer-digits">
                          <SegmentReadout value={mmss(secsLeft, dragMins)}
                            w={readoutBox.w} h={readoutBox.h}/>
                        </div>
                      </div>
                    </div>
                    {/* The underside, ported from the Dev-tab rig 2026-09-20: the
                        controls fused into ONE candy run floating against the
                        bottom edge, on bare block with no ring - the ring belongs
                        to the clock face and turns away with it. --cbtn-size is
                        the run's height; the parts divide its width by count, so
                        a block run's two halves need no separate rule. */}
                    <div className="planner-dial-flip-face back">
                      <div className="planner-dial-under">
                        <div className="candy-split planner-dial-run"
                          style={{ '--cbtn-size': `${RUN_H_PX}px` }}>
                          {innerControls}
                        </div>
                      </div>
                    </div>
                    {/* THE THIRD FACE, ported from the Dev-tab rig 2026-09-20: the
                        day at a glance on the left, two fused adders hugging the
                        right edge the way the four controls hug the underside's
                        bottom. Reached by rolling the OPPOSITE way from the
                        underside, so the clock is one notch from either face.

                        IconPlus and IconNotes rather than reusing IconListPlus,
                        which is already the underside's fourth part meaning
                        'select a task for this session'. The same glyph on two
                        faces meaning two things is a bug you only notice months
                        later.

                        SIZE IS A VIEWBOX SCALE, not a size - the same trap the
                        bottom run's marks were tuned around. IconPlus draws 448 of
                        its 448 box so it paints at exactly `size`; IconNotes draws
                        20 of 24 and paints at size x 0.833. 14 and 17 therefore
                        both land ~14 rows, the bottom run's 12 opened up a little
                        for a cell that is 39px tall rather than 27.

                        The day is the rig's PLACEHOLDER and the adders are inert,
                        both by his call: copy it across first, wire the real day
                        and the real actions after. */}
                    <div className="planner-dial-flip-face top">
                      <div className="planner-dial-over">
                        <div className="planner-dial-strip">
                          <div className="planner-dial-head">
                            <span className="planner-dial-lab">TODAY</span>
                            <div className="planner-dial-stats">
                              <span>3 done</span><span>1h 12m</span>
                            </div>
                          </div>
                          <div className="planner-dial-bar">
                            {DEMO_DAY.map((seg, i) => (
                              <div key={i} style={{ flex: seg.mins }}
                                className={'planner-dial-seg' + (seg.kind ? ' is-' + seg.kind : '')} />
                            ))}
                            <div className="planner-dial-now" style={{ left: DEMO_NOW_PCT + '%' }} />
                          </div>
                          <div className="planner-dial-span"><span>14:00</span><span>18:00</span></div>
                        </div>
                        <div className="candy-split planner-dial-col"
                          style={{ '--cbtn-size': `${COL_W_PX}px` }}>
                          <DialCtrl title="Add a task"><IconPlus size={14}/></DialCtrl>
                          <DialCtrl title="Add a quick note"><IconNotes size={17}/></DialCtrl>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
      </div>
    </div>
  );
}

// The old useCornerKnob lived here: it parsed --corner off :root and re-derived
// every radius as `knob x 24`. Deleted 2026-09-06 - the dial now READS the tile's
// painted radius (corners.js/useWidgetCorner), so the knob, the shape's own
// --corner-max and any per-subtree override all arrive already resolved. It also
// took a real bug with it: `parseFloat(...) || 0.5` treated a fully-square knob
// (0) as "no answer" and snapped the dial back to half-round.

// Breathing room between the readout and the inner ring stroke. The display fills
// BOTH axes of what is left (height sets the glyph size, the gaps take up the
// width), so this one number is the gap on all four sides - even by construction,
// not by tuning.
const READOUT_PAD_PX = 10;

// The widget's border: the bare gap between the tile's inner edge and everything
// that paints inside it - the dial's outermost ring, the calendar's sides, the
// calendar's bottom. ONE number, because it was three (here, the dial's width
// calc, and the calendar's own margin, now gone) and a border is even or
// it is nothing. Narrowed 14 -> 11 (user-directed 2026-09-06: "larger horizontally
// to take up more room inside of the widget... make the widget itself shorter
// vertically to make the spacing even", then "got too large. half" at 8), then 11
// -> 8 when the plate's overhang grew to the ring gap, then both reverted together:
// the dial gains 6px of width and the widget loses 3px off the top and 3px off the
// bottom.
const WIDGET_MARGIN = 11;

// The interior's insets, in real px. RING_INNER_EDGE is where DualRingRect draws
// the inner ring's inner face measured from the svg edge, and since the merge
// (2026-09-06) the svg and this overlay share one box - the dial has no frame of
// its own any more, so nothing comes back off.
const RING_INSET = RING_INNER_EDGE;

// One part of the underside's fused control run. An ORDINARY .candy-btn - a
// .candy-split child is nothing else, and there is no React button component in
// this app - so the seams, the frame overlap and the hover z-order all arrive
// from the shipped rules. flex: 1 1 0 is what makes the parts share the run's
// width evenly whether there are two of them or four.
//
// NO data-shape. The shipped rule
//   .candy-split > .candy-btn:not(:first-child):is([data-shape="circle"], [data-shape="icon"])
// pins a part's WIDTH to --cbtn-size, which would fight flex: 1 1 0 and stop the
// run filling the face.
//
// The label lives in the tooltip. Measured 2026-09-20 on the rig: icon + word
// needs ~97px a part and text alone ~71, both past the ~57 a quarter of this run
// leaves - which is what sank the two runs before it.
function DialCtrl({ onClick, title, mark, children }) {
  return (
    <button
      type="button"
      data-own-press
      data-mark={mark}
      onClick={onClick}
      title={title}
      style={{ flex: '1 1 0', minWidth: 0 }}
      className="candy-btn"
    >
      <span className="candy-face">{children}</span>
    </button>
  );
}
