import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DualRingRect, {
  // Ring 3's PAINT lives here on the dock (2026-09-08 Ribbon Pour, rebuilt as a
  // real tube 2026-09-09). The geometry did NOT get copied with it - the dial
  // still owns the width and the path, and the tube MEASURES itself against that
  // groove every frame rather than restating any of it.
  RING_INNER_EDGE, RING_EDGE_GAP, RIBBON_W,
} from './watchfaces/DualRingRect.jsx';
import { cornerAt, strokedCornerAt, useWidgetCorner, useInsetFromWidget } from './watchfaces/corners.js';
import SegmentReadout, { readoutHeightForWidth } from './watchfaces/SegmentReadout.jsx';
import CalendarPanel from './CalendarPanel.jsx';
import { buildTube, tubeSpans } from '@host/util/tube.js';
import { bezierEase } from '@host/util/motion.js';
import {
  IconReset, IconSkip, IconX, IconCheck, IconStop,
  IconPlay, IconPause,
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
//   IconSkip  bx 24 box, path x 7..17          -> 0.42 of the box
//   IconPlay  bx 24 box, path y 6..18          -> 0.50 of the box (its TALL axis)
//   FA glyphs 512 box, paths fill it           -> 1.00
// A SOLID mark reads heavier than an outline at equal ink, so the two filled
// ones (play, pause) are shaved — the same correction the old row applied to
// IconStop, kept because it is a fact about the eye, not about the box.
const PANEL_INK_PX = 16;    // painted mark inside a control panel, design px
const SOLID_TRIM = 0.85;    // filled marks read heavier than outlines

import { useModuleSettings } from '@host/hooks/useSettings.js';
import { usePlanner } from './PlannerProvider.jsx';
import { useFrameEditing } from '@host/hooks/useFrameEditing.js';
import { todayLocalStr } from '@host/util/time.js';
import { BlockPopover, PullConfirmBar } from './BlockTimerUI.jsx';
import { descFromSession, descFromPlan, resolveDesc } from './blockPull.js';

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

// The gap between the tube's two spout mouths, and the radius of the four
// junction arcs where a spout meets a ring. Both are his, tuned by hand on the
// dev-tab toy (a 40px gap in a 250px box), and both ride the dock's own `scale`
// so they stay the same FRACTION of the widget at any sidebar width.
const SPOUT_GAP = 40;
const SPOUT_JOIN = 14;
// THE FRONT CHASES THE POINTER (user-directed 2026-09-09), and it REMEMBERS where
// it was left (user-directed 2026-09-09).
//
// There is deliberately NO idle timer and NO per-frame lerp rate here. A hand that
// stops, or leaves the widget, leaves the liquid exactly where it put it, and the
// travel to each new destination runs on the CALENDAR'S OWN transition, read off the
// stylesheet at the top of the loop rather than restated as a number.

// The stylesheet's timing function, as control points. A computed
// `transitionTimingFunction` is `cubic-bezier(a, b, c, d)` for every curve the app
// actually writes; the keyword forms (`ease`, `linear`) fall back to a straight
// line, which is also what a `transition: none` (reduced motion) run wants.
const parseBezier = (s) => {
  const m = /cubic-bezier\(([^)]+)\)/.exec(s || '');
  const v = m ? m[1].split(',').map(Number) : [];
  return v.length === 4 && v.every(Number.isFinite) ? v : [0, 0, 1, 1];
};
// NO SMOOTHING ON THE CHASE AT ALL (user-directed 2026-09-10, final: "remove the
// smoothing entirely"). A hand on the widget writes the liquid's position straight,
// frame for frame. Four clocks were tried against his eye and every one of them was
// wrong in one direction or the other: the calendar's 640ms and the dial's 260ms both
// read as restrictive, a third of the glide read as snapping, and a distance-scaled
// speed still had a tell. Motion Unification (2026-08-13) had already drawn this line
// anyway - precision value-drags stay 1:1, only the coarse ring dial takes the glide -
// and the liquid's middle is painted under the cursor, so it was always a precision
// drag. The tween survives for the TOGGLE alone, which is a journey with a start and an
// end, and that one still runs on the calendar's own transition.

// EVEN ALL THE WAY (user-directed 2026-09-10: "i want it to always move evenly").
// Two earlier mappings both had places where the same hand movement bought a different
// amount of pour, and he could feel every one of them. Asking which point of the tube
// was NEAREST the hand parked the liquid on the level stretches and, with only 48
// sample points on a 1965px tube, stepped in 41px stairs everywhere else. Asking for
// the deepest point AT the hand's height fixed the stairs and gave exact tracking on
// the long sides, but a level stretch then went by in one 4x sweep - "always movement"
// and "even movement" are not the same request, and this is the second one.
//
// So: how far down the widget the hand is, straight onto how far the pour has got.
// One rate, every pixel of the travel, no fast stretch and no slow one. The two ends
// still land exactly - hand at the spout mouths is the liquid home, hand at the foot
// of the tube is a full pour - because both are MEASURED off the live path rather
// than assumed, so any calendar height and any sidebar width keep them true.
//
// What this trades away is the exact centring of R4-SF4: the slug's middle can sit on
// the hand's own height, or the pour can move evenly, but not both, because the middle
// descends at a different rate along a level stretch than along a vertical one.
// The liquid IS the pipe's bore (user-directed 2026-09-09). Two earlier passes
// narrowed it and both still read as a gap: 8/13 of the casing left 1.07px of dry
// wall each side, and RIBBON_W - 1.6 left 0.8px, measured off the screen at
// x1334-1336 full red inside a 5.57px pipe. --clock-stroke-bg derives from
// --border, which in the dark theme sits within a few RGB units of the face, so a
// rim of casing does not read as a wall at all - it reads as the liquid failing to
// fill. Equal widths: the casing survives only where the pipe is DRY, laid ahead of
// the pour, which is the only place it has anything to say.
const WATER_W = RIBBON_W;

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
    sessions, planBlocks,
    customDays,
    activePlanKey, activeSessionId,
    selectPlanBlock, selectSession,
    taskDrag,
    toggleTimer, resetTimer, endSessionEarly, skipPhase,
    handleDragStart, handleDrag, handleDragEnd,
    handleSessionCreate, handleSessionResize, handleSessionMove, handleSessionDelete, handleSessionRename,
    handlePlanBlockMove, handleTaskDrop,
    blockRun, startBlockTimer, stopBlockRun, finishBlockEarly, pullAndStart, switchToBlock,
  } = p;

  const accent = plannerAccent(settings);
  const now = new Date();
  // All Planner accents (controls, dial stroke, tab pills, active-task) draw
  // from the global appAccent now — the focus/break green distinction was
  // dropped per user request. (The old `phaseColor` alias died with the
  // START/PAUSE label, its only consumer.)

  const { settings: moduleSettings, setSetting: setModuleSetting } = useModuleSettings('planner');
  const calendarCollapsed = moduleSettings.calendarCollapsed === true;

  // Daily frame blocks in the dock calendar — interactive (drag/retime/rename/
  // create/delete) like the planner, scoped to today (the dock is day-only).
  // No frameEditMode state here any more — the Edit Frame chip that owned it was
  // deleted from this widget 2026-08-10, so nothing could ever set it true.
  // CalendarPanel defaults the prop to false, so the frame blocks still render;
  // they are just not editable from the sidebar.
  const frameDateKeys = useMemo(() => [todayLocalStr()], []);
  const { mergeIntoSessions, handlers: frameHandlers } = useFrameEditing(frameDateKeys);
  const sessionsWithFrame = useMemo(() => mergeIntoSessions(sessions), [mergeIntoSessions, sessions]);

  // ── Block-timer popover + pull-selection state ──────────────────────────
  // Keyed by stable desc refs (NOT block components — their React keys encode
  // times, so any re-time remounts them). The stale-guard closes/exits when
  // the underlying block vanishes or re-times under an open surface.
  const [popover, setPopover] = useState(null); // { desc, rect }
  const [pullMode, setPullMode] = useState(null); // { source, selected: Map<key, desc> }
  const timerBusy = running || !!sessionStart;

  const dockDescs = useMemo(() => {
    const ds = todayLocalStr();
    const out = [];
    for (const s of sessionsWithFrame) if (s.dateKey === ds) out.push(descFromSession(s));
    for (const b of planBlocks) out.push(descFromPlan(b, ds));
    return out;
  }, [sessionsWithFrame, planBlocks]);

  useEffect(() => {
    if (popover) {
      const fresh = resolveDesc(popover.desc.ref, dockDescs);
      if (!fresh || fresh.startMins !== popover.desc.startMins || fresh.endMins !== popover.desc.endMins) {
        setPopover(null);
      }
    }
    if (pullMode && !resolveDesc(pullMode.source.ref, dockDescs)) setPullMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockDescs]);

  useEffect(() => {
    if (!pullMode) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPullMode(null); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pullMode]);

  // Scrolling the calendar under an open popover detaches it from its anchor —
  // close instead of drifting.
  useEffect(() => {
    if (!popover) return undefined;
    const el = calBodyRef.current;
    const onScroll = () => setPopover(null);
    el?.addEventListener('scroll', onScroll, { passive: true });
    return () => el?.removeEventListener('scroll', onScroll);
  }, [popover]);

  const onBlockTap = (desc, rect) => setPopover({ desc, rect });
  const enterPullMode = (desc) => { setPopover(null); setPullMode({ source: desc, selected: new Map() }); };
  const togglePullTarget = (desc) => {
    setPullMode(pm => {
      if (!pm) return pm;
      const next = new Map(pm.selected);
      if (next.has(desc.key)) next.delete(desc.key); else next.set(desc.key, desc);
      return { ...pm, selected: next };
    });
  };
  // Switch-aware dispatch: stop whatever runs (logging a dial run's partial
  // session), then run the block action. Entering selection mode does NOT
  // switch — the running timer is only replaced when the pull confirms.
  const runAction = (fn) => { if (timerBusy) switchToBlock(fn); else fn(); };
  const confirmPull = () => {
    if (!pullMode) return;
    const { source, selected } = pullMode;
    setPullMode(null);
    runAction(() => pullAndStart(source, [...selected.values()]));
  };

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

  // Measured fill height for the calendar body. Expanded, the calendar animates
  // open to exactly this many px so it fills the sidebar's remaining space down to
  // the next module (the music tile) and scrolls internally; collapsed, it
  // animates to 0. The planner slot is flexWeight:0 (hug) so it no longer
  // reserves space — avail is read from the sidebar list, not the slot:
  //   avail = listHeight − container padding − row-gaps − Σ(slot heights) + thisCalendarBodyHeight
  // The body term cancels this slot's own calendar contribution, so avail equals
  // the leftover sidebar space and is STABLE across collapse state AND during the
  // open/close animation (no feedback loop). Measured pre-paint (useLayoutEffect)
  // and kept fresh on sidebar resize via a ResizeObserver on the list container.
  const calBodyRef = useRef(null);
  // The inner panel. The poured frame paints on THIS box, not the outer clip:
  // the clip's edge is pulled up onto the clock's plate by the dial's own
  // -RING_EDGE_GAP margin, so a frame there lands touching the clock with no
  // band between them (photographed 2026-09-09). The panel sits INSIDE the
  // sliding clip, so the gap it carries collapses with the calendar instead of
  // snapping to zero on the click the way an outer margin did.
  const calPanelRef = useRef(null);
  const [avail, setAvail] = useState(0);

  // Click only (user-directed 2026-09-06). The pull-down drag that used to open
  // the calendar lived on the flat strip; the strip is now the dial's outermost
  // RING, where a downward pull has no bar to follow, so the gesture went with it.
  // The close RETRACES, and there is nothing here to decide (user-directed
  // 2026-09-09, confirmed 2026-09-09 after the behaviours were found to conflict).
  // An earlier revision carried the liquid on round the rest of the lap on a close
  // from fully open, so two clicks were one circuit; the both-mouths pour that
  // replaced it leaves the whole circuit wet at full pour, so there is no rest of
  // the lap left to travel. The flag that chose between them (`wrapRef`) survived
  // the rewrite as dead weight - `tubeSpans` folds `2 - lead` straight back to
  // `lead`, so it painted the retrace either way - and is gone with it.
  const toggleCalendar = () => setModuleSetting('calendarCollapsed', !calendarCollapsed);

  // ── The tube (Ribbon Pour revision, 2026-09-09) ────────────────────
  // The strip is a TUBE. One closed circuit drawn as a single stroke: a ring
  // round the dial, down the right spout, round the open calendar, back up the
  // left spout to where it started. Clicking pours it open; clicking again
  // carries the liquid the rest of the way round. No day blocks and no now-mark
  // any more - the rows below ARE the day, and the tube is just the lid opening.
  //
  // ONE number drives it: `m`, how far the pour has got (0 shut, 1 poured). The
  // shared `tubeSpans` still accepts 0..2 for the dev toy, which runs the circuit
  // continuously; this surface only ever sends 0..1. And `m` is not a clock of
  // its own - it is the calendar body's MEASURED openness, so the only timing in
  // this animation is the max-height transition already on
  // `.planner-calendar-body`. Retime that in CSS and the tube follows for free,
  // and it can never disagree with the thing it is wrapping.
  // The LIQUID's own progress, 0..1, which is not the calendar's while a hand is
  // moving. Lives in a ref so it survives the effect being torn down and rebuilt on
  // every toggle - the water is mid-air at that moment and must not snap.
  const waterRef = useRef(0);
  // Where the liquid is HEADED, and the run it is making to get there: the value it
  // set out from and when. Only a pointer move re-aims it, so a hand that stops or
  // leaves the widget leaves `to` standing and the front holds that spot instead of
  // falling back to the calendar's own number (user-directed 2026-09-09). Also a ref
  // for the same reason `waterRef` is: a toggle tears the loop down mid-flight.
  const tweenRef = useRef({ from: 0, to: 0, t0: 0, ms: 0, ease: (x) => x });
  const grooveRef = useRef(null);   // ring 3 on the dial: the top ring's ruler
  const tubeRef = useRef([]);       // [top ring, laid wall, liquid, hit target]
  // An ARRAY ref, and the callbacks below re-seed it: Fast Refresh keeps the ref
  // object across an edit, so when this changed shape from a single element to a
  // list the preserved `.current` was still the old detached null and the first
  // callback threw "Cannot set properties of null" straight into the crash screen.
  const mouthRef = useRef([]);      // the slab that hugs the tube, one per laid span
  const outerR = useWidgetCorner(dockRef);

  // The static half of the overlay's geometry, MEASURED off the groove rather
  // than summed from insets: x, width, the home top/bottom, and the perimeter the
  // two dash floors are honest pixels against. Re-read whenever the tile resizes.
  const [home, setHome] = useState(null);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const groove = grooveRef.current;
    if (!dock || !groove) return undefined;
    const measure = () => {
      const d = dock.getBoundingClientRect();
      const g = groove.getBoundingClientRect();
      if (!g.width || !g.height) return;
      // The groove's box IS its path centre - no stroke correction, and NOT
      // because SVG works that way in general. It stopped painting on 2026-09-09
      // (the tube's wall replaced it) and a stroke at `transparent` is dropped from
      // getBoundingClientRect, so the box shrank by half a stroke on every side the
      // moment the colour went. The old `+ RIBBON_W / 2` was correct while the ring
      // was visible and silently wrong afterwards: it drew the tube's top ring 5.57
      // px narrower than the ring it replaced, and handed the same error on to the
      // calendar's margin. Proven, not reasoned: the path's own `d` starts at
      // 12.585 = RING_EDGE_GAP + RIBBON_W / 2, and getBBox().x and
      // getBoundingClientRect() BOTH read 12.6.
      const next = {
        x: g.left - d.left,
        w: g.width,
        top: g.top - d.top,
        bottom: g.bottom - d.top,
      };
      // NB the planned shortcut - "the dial's ring and the calendar are already on
      // the same x, so the pour needs no sideways travel" - is FALSE, and the live
      // rects said so on the first probe: the groove paints 1168.8..1412.6 while
      // the calendar body spans 1166..1415, about 2.6px out on each side. The two
      // 11px margins are taken from different references. So x and width are
      // interpolated between two MEASURED ends like everything else, and the
      // discrepancy costs one lerp instead of a misalignment nobody would spot.
      // The band the clock's plate carries ABOVE it, handed to the calendar BELOW
      // it so both ends of the dial read the same. MEASURED off the painted plate
      // and the calendar's own clip, never summed from the dial's constants: those
      // do not know about the pixel between the widget's edge and the dial's box,
      // and building it from them came out 1.2px short (photographed 2026-09-09).
      // Three real distances - the plate's own top band, the half stroke the frame
      // is centred by, and however far the clip's edge was pulled up onto the
      // plate by the dial's -RING_EDGE_GAP margin.
      const plate = dock.querySelector('rect[fill*="planner-face"]');
      const clip = calBodyRef.current;
      if (plate && clip) {
        const pr = plate.getBoundingClientRect();
        const cr = clip.getBoundingClientRect();
        // Two real distances, not three. The half stroke that used to be added here
        // paid for a frame CENTRED on the panel's top edge, which poked RIBBON_W / 2
        // above it. Since the frame became inset from the slab by its proud edge
        // (2026-09-09) nothing pokes, and the term was pure excess: the face showed
        // 7.1px between the two slabs against 4.3px everywhere round the outside -
        // read off the pixels, not the DOM, because the outer band is part tile
        // frame and the rects alone call it even when the eye does not.
        next.calGap = (pr.top - d.top) + (pr.bottom - cr.top);
        // WHERE THE WIDGET'S EDGE ACTUALLY IS, read off the clock's slab. The
        // calendar's slab is given the same inset (see the CSS var below), which
        // does two things at once: the two slabs finally line up on one straight
        // edge, and the grey shows round the calendar's frame by the same 5.8px it
        // shows round the dial's ring - WITHOUT moving the frame, which is the wrong
        // half of the problem to solve (user-directed 2026-09-09: insetting the
        // frame instead just made the calendar smaller).
        // Measured against the body's own containing block, because that is what a
        // margin on it is relative to. Nothing here reads the calendar's width, so
        // widening it cannot feed back into this.
        const host = clip.parentElement;
        if (host) next.slabInset = pr.left - host.getBoundingClientRect().left;
        // ...and how far that slab stands PROUD of the ring drawn on it. The
        // calendar's frame is inset from its own slab by the same amount, so the
        // grey shows round the frame exactly as it shows round the ring. The two
        // together are what leave the calendar's outline where it always was: the
        // slab grew outward by 3px and the frame moved inward by 3px, so the frame
        // lands back on its original line with a real margin outside it.
        next.proud = next.x - (pr.left - d.left);
      }
      setHome((prev) => (prev && Object.keys(next).every(k => prev[k] === next[k]) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    ro.observe(groove);
    return () => ro.disconnect();
  }, []);

  // The corner. `cornerAt` returns the tile's own painted radius FLAT (the SAME
  // rule, corners.js) - the depth argument is carried but ignored, which is why
  // the strip is exactly as round wrapping the calendar as it was wrapping the
  // dial, and why the pour has no radius to interpolate. Passing 0 here rather
  // than restating the dial's depth keeps this honest: if corners.js ever swaps to
  // NESTED, the two ends of the pour must be re-derived deliberately, not silently
  // inherit a depth that stopped being true the moment the strip left the dial.
  const pourR = strokedCornerAt(outerR, 0, RIBBON_W);

  // The liquid glows exactly as the dial's session arc does (user-directed
  // 2026-09-09), off the SAME switch - the one animation setting that turns the
  // clock's ambient light off turns the tube's off with it. Its own filter id
  // rather than the dial's `dualRectGlow`: that one only exists while DualRingRect
  // is the mounted watchface, and a filter reference to a missing id paints nothing.
  const tubeGlowOn = settings.animations?.['clock-ambient'] !== false;

  useEffect(() => {
    const dock = dockRef.current;
    const body = calBodyRef.current;
    const panel = calPanelRef.current;
    if (!dock || !body || !panel || !home || !avail) return undefined;

    let raf = 0;
    let seeded = false;
    // The liquid travels on THE CALENDAR'S OWN transition (user-directed 2026-09-09:
    // "the app's default smooth animation"). Read off the panel rather than typed in,
    // so retiming that one CSS line retimes the pipe and the liquid together - the
    // pipe already follows it, being the panel's measured height. Reduced motion sets
    // `transition: none`, which lands here as a 0ms run: the front simply arrives.
    const clock = getComputedStyle(body);
    const tweenMs = (parseFloat(clock.transitionDuration) || 0) * 1000;
    const tweenBez = parseBezier(clock.transitionTimingFunction);
    // The live pointer, in CLIENT coordinates because that is what the event carries
    // and what the dock's own rect is measured in. `fresh` says a move has arrived
    // that the loop has not yet turned into a destination; it is cleared on use, so a
    // hand that stops steering stops moving the liquid without needing a timer.
    const pointer = { x: 0, y: 0, fresh: false };
    const frame = () => {
      const d = dock.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      // Measured openness. The CSS transition has already eased it - nothing here
      // re-eases, or the curve would be applied twice.
      // Shut is 0, poured is 1, and the same measured number runs it both ways -
      // the close is the open played backwards. That is the whole driver.
      const m = Math.min(1, Math.max(0, b.height / avail));

      // BOTH RINGS ARE MEASURED every frame. The top one off the dial's groove,
      // the bottom one off the calendar's inner PANEL - the panel, not the outer
      // clip, because the clip's edge is pulled up onto the clock's plate by the
      // dial's own -RING_EDGE_GAP margin. Half a stroke comes off each side of
      // both: getBoundingClientRect spans the PAINTED outer edge, and these rects
      // are the path's centre line.
      const pb = panel.getBoundingClientRect();
      const top = { x: home.x, y: home.top, w: home.w, h: home.bottom - home.top };
      // Inset by the slab's own proud edge (measured, see the home effect), not by
      // half a stroke - that left a 2.8px margin, which read as none at all.
      const proud = home.proud ?? RIBBON_W / 2;
      const bot = {
        x: pb.left + proud - d.left,
        y: pb.top + proud - d.top,
        w: Math.max(0, pb.width - 2 * proud),
        h: Math.max(0, pb.height - 2 * proud),
      };
      const geom = buildTube({
        top, bot, rad: pourR, spout: SPOUT_GAP * scale, join: SPOUT_JOIN * scale,
      });
      // THE BACKING, and it HUGS THE TUBE (user-directed 2026-09-09). Earlier
      // passes filled the band between the clock and the calendar with a rect -
      // first spout-wide, which left the slabs' rounded corners unbacked, then
      // slab-wide, which backed them by filling the whole band solid. Neither is
      // what the shape wants: the slab follows the pipe, it does not box it in.
      //
      // So it is the tube's OWN path, stroked at twice the slab's proud edge. A
      // stroke straddles its path, so an outer edge exactly `proud` out from the
      // pipe's centre line falls out for free - the same edge the plate already
      // has round the clock, now carried round every bend. Round caps and joins
      // give the pipe's own rounded ends that margin too.
      //
      // Dashed in step with the two strokes it backs, never drawn whole: the
      // circuit exists as a shape before the tube is laid along it (collapsed, it
      // is a squashed loop under the clock), and an undashed backing would paint
      // that as a dark blob with no pipe on it.
      for (const el of mouthRef.current) el?.setAttribute('stroke-width', String(2 * proud));

      // THE FRONT CHASES THE POINTER (user-directed 2026-09-09). The pipe above
      // follows the calendar's own eased height; the liquid gets a second number.
      // Where the pointer is on the tube is PROJECTED onto the path that is about to
      // be painted - the `d` is written here first, before it is read - rather than
      // inferred from the panel's height or from where the click landed. Turning that
      // into progress uses the same reach the pour itself measures, so the pointer's
      // place and the liquid's place can never be computed against different tubes.
      const hitPath = tubeRef.current[3];
      hitPath?.setAttribute('d', geom.d);
      const mouthRun = geom.fDown + geom.fBot / 2;
      const tw = tweenRef.current;
      const now = performance.now();
      if (!seeded) {
        seeded = true;
        // Every toggle rebuilds this loop, and a toggle is a destination of its own:
        // a click aims the liquid at the end of the pipe (open) or back home (shut),
        // and a hand that never moves after the click gets the plain pour it always
        // got. A pointer move inside the widget overrides this a frame later.
        tw.from = waterRef.current;
        tw.to = calendarCollapsed ? 0 : 1;
        tw.t0 = now;
        tw.ms = tweenMs;      // a toggle is a journey: the calendar's own clock
        tw.ease = (x) => bezierEase(tweenBez, x);
        // A widget that was already at rest when this effect mounted starts with the
        // water where the pipe is; without it the first frame would haul the front
        // home from nothing. Mid-pour (a toggle) it deliberately does NOT snap.
        if (Math.abs(m - (calendarCollapsed ? 0 : 1)) < 0.001) {
          waterRef.current = m;
          tw.from = m;
        }
      }
      if (!calendarCollapsed && mouthRun > 0 && pointer.fresh) {
        pointer.fresh = false;
        // ONE number serves both slugs because they move together: `fTop` is the right
        // mouth and runs forward, 0 is the left mouth and runs backward toward 1, and
        // the two branches are mirrors, so the right one is asked and the left follows.
        //
        // The hand's travel is THE WHOLE TUBE'S HEIGHT, measured off the live path's
        // own box. Anchoring the top at the spout mouths instead left the hundred-odd
        // pixels above them - the hand out over the clock - buying nothing at all,
        // which is a dead spot like any other. Top of the tube is the liquid home, foot
        // of the tube is a full pour, one rate between, and both ends move with the
        // calendar because the box is re-read every time a hand moves.
        // CENTRED ON THE HAND (user-directed 2026-09-10, twice). The hand's two ends are
        // the SLUG'S OWN MIDDLE, read off the painted path at each end of its travel:
        // where the middle sits with the pour home, and where it sits with the pour
        // full. A slug spans `[half + front, fTop + front]`, so its middle is always
        // `0.75 * fTop + front` along the circuit - measured, not assumed, at both ends.
        //
        // An earlier pass added half a slug as a flat OFFSET to a top-to-bottom mapping
        // instead. That put the middle right only in the middle of the travel: the top
        // fifth of the widget started already poured and the bottom fifth was pinned at
        // full, which is exactly the two ends he was looking at when he said it still
        // was not centred. Anchoring to the middle itself makes both ends exact and
        // leaves the rate constant between them, so the even travel survives.
        // Anchoring the two ENDS to the middle and running an even rate between them was
        // tried first, and measured 110px out at mid-travel: the tube spends length in
        // the spout and along the calendar's top edge without descending at all, so an
        // even rate along the PIPE cannot hold a constant height against a hand. Only a
        // height search can, so that is what this is - the front whose slug MIDDLE is
        // painted at the hand's own height. The middle's y never decreases as the pour
        // advances, so 16 halvings land it inside a fifteen-thousandth of the run.
        const len = hitPath.getTotalLength() || 1;
        const midHome = 0.75 * geom.fTop;
        const py = pointer.y - d.top;
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 16; i++) {
          const mid = (lo + hi) / 2;
          if (hitPath.getPointAtLength((midHome + mid * mouthRun) * len).y <= py) lo = mid;
          else hi = mid;
        }
        const next = lo;
        // Written straight through: a zero-length run is the tween arriving on the frame
        // it starts, so there is one code path for both this and the toggle.
        tw.from = next;
        tw.to = next;
        tw.t0 = now;
        tw.ms = 0;
      }
      // The run itself, on the calendar's curve. Clamped to the pipe every frame: a
      // destination further down the tube than the pipe has been laid is simply the
      // pipe's own front until the pipe gets there, which is also what makes a pour
      // with no hand on it look exactly as it did before any of this existed.
      const p = tw.ms > 0 ? Math.min(1, (now - tw.t0) / tw.ms) : 1;
      waterRef.current = Math.min(m, tw.from + (tw.to - tw.from) * tw.ease(p));

      const { wallFrom, wallTo, tail, head, tailL, headL } = tubeSpans(m, geom, waterRef.current);
      const run = Math.max(0, head - tail);
      for (const el of tubeRef.current) el?.setAttribute('d', geom.d);
      const [ring, wall, water, , waterL, glow, glowL] = tubeRef.current;
      // pathLength=1, so every number above is already a fraction of the whole
      // circuit. The top ring's pattern deliberately does NOT sum to 1 - it reads
      // "draw the first fTop, then a gap too long to repeat". The other two DO,
      // so a run of liquid crossing the end of the path reappears at the start
      // instead of being clipped there, which is what the second half of the lap
      // rides on.
      const [ringBack, wallBack] = mouthRef.current;
      for (const el of mouthRef.current) el?.setAttribute('d', geom.d);
      ringBack?.setAttribute('stroke-dasharray', `${geom.fTop} 1`);
      wallBack?.setAttribute('stroke-dasharray', `${wallTo - wallFrom} ${1 - (wallTo - wallFrom)}`);
      wallBack?.setAttribute('stroke-dashoffset', String(-wallFrom));
      ring?.setAttribute('stroke-dasharray', `${geom.fTop} 1`);
      wall?.setAttribute('stroke-dasharray', `${wallTo - wallFrom} ${1 - (wallTo - wallFrom)}`);
      wall?.setAttribute('stroke-dashoffset', String(-wallFrom));
      water?.setAttribute('stroke-dasharray', `${run} ${1 - run}`);
      water?.setAttribute('stroke-dashoffset', String(-tail));
      // The halo under it carries the SAME span - it is the same slug, blurred and
      // widened, exactly as the dial haloes its session arc (user-directed 2026-09-09).
      glow?.setAttribute('stroke-dasharray', `${run} ${1 - run}`);
      glow?.setAttribute('stroke-dashoffset', String(-tail));
      // The left branch's slug. Same stroke, same pattern, mirrored span - see
      // tubeSpans for why its positions are negative.
      const runL = Math.max(0, headL - tailL);
      waterL?.setAttribute('stroke-dasharray', `${runL} ${1 - runL}`);
      waterL?.setAttribute('stroke-dashoffset', String(-tailL));
      glowL?.setAttribute('stroke-dasharray', `${runL} ${1 - runL}`);
      glowL?.setAttribute('stroke-dashoffset', String(-tailL));

      // Reduced motion lands here on the first frame - `m` jumps straight to its end.
      const rest = Math.abs(m - (calendarCollapsed ? 0 : 1)) < 0.001;
      // The liquid is DONE when its own run has finished, NOT when it agrees with the
      // pipe: a front left partway down the tube by a hand that walked away is a
      // legitimate resting place now, and testing against `m` here would spin the loop
      // forever waiting for a catch-up that is never coming.
      const done = rest && p >= 1;
      raf = done ? 0 : requestAnimationFrame(frame);
    };

    // A move RESTARTS the loop. It stops itself once everything has settled, so
    // without this the front would follow the pointer only while the calendar
    // happened to still be easing. Listening only while the calendar is open keeps
    // every other pointer move in the app from waking a dead animation.
    //
    // ONLY A HAND ON THE WIDGET STEERS IT (user-directed 2026-09-09). The listener is
    // on the window because a pointer that leaves has to be seen leaving, but a move
    // outside the dock's own box is DROPPED rather than projected: the nearest point
    // on a path exists for every point on the screen, so without this gate a mouse
    // crossing the top of the app would project onto the ring and haul the liquid
    // home. Dropped, the last destination stands and the front stays where it was left.
    const onMove = (e) => {
      const r = dock.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right
        || e.clientY < r.top || e.clientY > r.bottom) return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.fresh = true;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    if (!calendarCollapsed) window.addEventListener('pointermove', onMove, { passive: true });

    raf = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [calendarCollapsed, home, avail, pourR, scale]);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    const body = calBodyRef.current;
    if (!dock || !body) return;
    const list = dock.closest('.sidebar-widget-list');
    if (!list) return;
    const recompute = () => {
      const cs = getComputedStyle(list);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const rowGap = parseFloat(cs.rowGap) || 0;
      const n = list.children.length;
      let sum = 0;
      for (const child of list.children) sum += child.offsetHeight;
      // clientHeight includes the container's top/bottom padding, and flex
      // row-gaps sit between tiles — both are space the calendar can't claim.
      // Subtract them or avail over-counts and the calendar grows past its slot.
      const chrome = padTop + padBottom + rowGap * Math.max(0, n - 1);
      const next = Math.max(120, Math.round(list.clientHeight - chrome - sum + body.offsetHeight - 1));
      setAvail(prev => (prev === next ? prev : next));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(list);
    return () => ro.disconnect();
  }, [running, sessionStart, calendarCollapsed]);

  // Controls (Reset / Play-Pause / Skip-or-EndEarly). Built once and placed
  // inside the rect ring-button via TimerWidget's innerControls prop, where they
  // are three flush full-height panels covering the dial's whole interior,
  // revealed on hover (user-directed 2026-09-03). Block runs swap the whole row
  // for cancel + finish-early: pause is disallowed during a block (it would
  // drift the finish past the block's calendar end), and Reset/Stop were three
  // spellings of the same cancel.
  const ink = PANEL_INK_PX * scale;
  const faPx = Math.round(ink);                        // FA outlines fill their box
  const bxPx = Math.round(ink / 0.42);                 // IconSkip
  const playPx = Math.round((ink * SOLID_TRIM) / 0.50); // IconPlay, sized on its tall axis
  const pausePx = Math.round(ink * SOLID_TRIM);        // IconPause (FA, solid)
  const ctrlThird = phase === 'focus' && sessionStart ? (() => {
    const elapsedMs = (pauseStartRef.current ?? now) - sessionStart;
    const elapsedMin = Math.max(1, Math.round(elapsedMs / 60000));
    return (
      <RingPanel onClick={endSessionEarly}
        title={`End session early · logs ${elapsedMin}m`}><IconStop size={pausePx}/></RingPanel>
    );
  })() : (
    <RingPanel onClick={skipPhase}
      title={phase === 'focus' ? 'Skip to break' : 'Skip to focus'}><IconSkip size={bxPx}/></RingPanel>
  );
  // The readout is no longer a line ABOVE this row - it fills the same interior
  // underneath the panels, and the panels are dim enough to read it through
  // (user-directed 2026-09-03). The middle panel is a play/pause glyph, not a
  // word, so nothing here carries text any more.
  const controlsJSX = blockRun ? (
    <>
      <RingPanel onClick={stopBlockRun}
        title="Cancel block timer — nothing is logged"><IconX size={faPx}/></RingPanel>
      <RingPanel onClick={finishBlockEarly}
        title="Finish block early — trims the block to now"><IconCheck size={faPx}/></RingPanel>
    </>
  ) : (
    <>
      <RingPanel onClick={resetTimer} title="Reset"><IconReset size={faPx}/></RingPanel>
      <RingPanel onClick={toggleTimer}
        title={running ? 'Pause' : (idle ? 'Start' : 'Resume')}>
        {running ? <IconPause size={pausePx}/> : <IconPlay size={playPx}/>}
      </RingPanel>
      {ctrlThird}
    </>
  );

  return (
    <div ref={dockRef} style={{
      '--planner-widget-margin': `${WIDGET_MARGIN}px`,
      // The calendar's slab rides the clock slab's own edge (see the home effect).
      // WIDGET_MARGIN is the fallback for the first frame, before anything is
      // measured - it was the typed value, and it was 3px out.
      '--planner-slab-inset': `${home?.slabInset ?? WIDGET_MARGIN}px`,
      // The poured strip's stroke, published so the calendar's row clearance is
      // the SAME number as the paint it has to clear - typing 5.57 into styles.css
      // would be a copy that goes wrong the moment RIBBON_W is retuned.
      '--planner-ribbon-w': `${RIBBON_W}px`,
      // Where the poured frame's INNER painted edge lands, as a distance from the
      // calendar panel's own box - which is what the rows have to clear. The frame
      // is inset from the panel by the slab's proud edge (see `bot` in the pour
      // loop) and then straddles that line with half its stroke, so the rows start
      // at proud + RIBBON_W / 2. It used to be RIBBON_W alone, which was right only
      // while the slab stood barely proud of the ring: at PLATE_OVERHANG 6.7 the
      // rows ran 6.7px out past the frame on every side, which is what "the
      // calendar is poking outside the tube" was (photographed 2026-09-09).
      '--planner-pour-clear': `${(home?.proud ?? RIBBON_W / 2) + RIBBON_W / 2}px`,
      // The poured frame's corner, so the calendar's own fill rounds on the SAME
      // radius the stroke is drawn with rather than the app's generic --radius-md.
      '--planner-pour-r': `${pourR}px`,
      // The pour overlay is absolute against this box, and its viewBox is this
      // box, so every rect it measures only needs the dock's own origin off it.
      position: 'relative',
      width: '100%', minWidth: 0,
      display: 'flex', flexDirection: 'column',
      // Transparent so the enclosing .rail-tile candy chrome (surface-3
      // fill + hover-red) reads through as the button interior, faithful to the
      // music tile. The inner calendar keeps its own var(--surface) bg below.
      background: 'transparent',
      overflow: 'hidden',
      // flex-basis:auto so the dock sizes to its content when the shell stops
      // growing (calendar collapsed); grows to fill when the shell fills.
      flex: '1 1 auto',
      minHeight: 0,
    }}>
      {/* Planner body — always visible */}
      <div style={{
          flex: '1 1 auto', minHeight: 0,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
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
            grooveRef={grooveRef}
            onGrooveClick={toggleCalendar}
          />

          {/* Day calendar — rows sit straight on the same face now (user-directed
              2026-09-06: no recessed well of its own). Slides open/closed on the
              measured max-height (`avail`), so the tile grows/shrinks with it.
              data-no-drag: blocks the sidebar list's hold-to-reorder and exempts
              presses in here from the tile's face slide. */}
          <div
              data-no-drag
              ref={calBodyRef}
              className="planner-calendar-body"
              style={{ maxHeight: calendarCollapsed ? 0 : avail }}
            >
              {/* Inner panel. The 12px gap between the button and the calendar lives
                  on THIS element's margin-top, INSIDE the outer clip, so it shrinks
                  away with the height instead of being a second animated property —
                  a margin on the outer changed the layout by 12px in a single frame
                  and read as a snap at the end of the close. The outer is a flex
                  column and this is flex:1/min-height:0, which is what gives this
                  element a bounded height to scroll inside while the outer's
                  max-height is what animates. */}
              <div
                ref={calPanelRef}
                className="planner-calendar-panel"
                style={{
                  // The band between the clock's plate and the calendar's frame,
                  // measured to equal the one the plate has above it (see the home
                  // effect). The constants-only sum is the fallback for the first
                  // frame, before anything has been measured.
                  marginTop: home?.calGap ?? (RING_EDGE_GAP + RIBBON_W / 2),
                  overflowY: calendarCollapsed ? 'hidden' : 'auto',
                  // Collapsed, the strip is home on the dial and there is nothing
                  // crossing the rows - so the clearance goes away with it.
                  padding: calendarCollapsed ? 0 : undefined,
                }}
              >
              {/* NB the Edit Frame chip that used to sit here was deleted 2026-08-10
                  (user-directed) — the sidebar widget has no frame-editing entry
                  point now. The PlannerModal keeps its own; this is widget-only. */}
              <CalendarPanel
                hideHeader
                sessions={sessionsWithFrame}
                pivotDate={todayDate}
                onPivotChange={() => {}}
                viewMode="day"
                onViewModeChange={() => {}}
                customDays={customDays}
                onCustomDaysChange={() => {}}
                accent={accent}
                hourHeight={settings.calendarHourHeight}
                timeFormat24h={settings.timeFormat24h}
                showHourGutter={settings.showCalendarHourGutter !== false}
                planBlocks={planBlocks}
                activePlanKey={activePlanKey}
                activeSessionId={activeSessionId}
                onSelectPlanBlock={selectPlanBlock}
                onSelectSession={selectSession}
                activeTaskName={activeTaskName}
                onSessionCreate={handleSessionCreate}
                onPlanBlockMove={handlePlanBlockMove}
                onSessionResize={handleSessionResize}
                onSessionMove={handleSessionMove}
                onSessionDelete={handleSessionDelete}
                onSessionRename={handleSessionRename}
                taskDrag={taskDrag}
                onTaskDrop={handleTaskDrop}
                {...frameHandlers}
                onBlockTap={onBlockTap}
                pullSelect={pullMode ? {
                  source: pullMode.source,
                  sourceKey: pullMode.source.key,
                  selectedKeys: new Set(pullMode.selected.keys()),
                  onToggle: togglePullTarget,
                } : null}
                runningBlockKey={blockRun?.key || null}
              />
              {pullMode && (
                <PullConfirmBar
                  count={1 + pullMode.selected.size}
                  onConfirm={confirmPull}
                  onCancel={() => setPullMode(null)}
                />
              )}
              {popover && (
                <BlockPopover
                  desc={popover.desc}
                  anchorRect={popover.rect}
                  accent={accent}
                  timeFormat24h={settings.timeFormat24h}
                  switchMode={timerBusy && blockRun?.key !== popover.desc.key}
                  runningLabel={activeTaskName}
                  runningSecsLeft={secsLeft}
                  isRunningBlock={blockRun?.key === popover.desc.key}
                  onClose={() => setPopover(null)}
                  onStart={(desc) => runAction(() => startBlockTimer({
                    key: desc.key, label: desc.label, endMins: desc.endMins, dateKey: desc.ref.ds,
                  }))}
                  onPullStart={(desc) => runAction(() => pullAndStart(desc, []))}
                  onEnterPullMode={enterPullMode}
                  onStopRun={stopBlockRun}
                />
              )}
              </div>
          </div>
        </div>

      {/* ── The tube ───────────────────────────────────────
          Ring 3's PAINT, moved out of the dial's svg on 2026-09-08 and rebuilt as
          a real tube 2026-09-09. It has to be here, last, because it wraps the
          calendar rows and the dial's svg is earlier in DOM order - anything drawn
          there paints behind them.

          Four strokes sharing ONE `d`, all of it written per frame by the loop
          above through `setAttribute` - the same 60fps escape hatch the dial's own
          arc uses. Nothing here carries geometry: this JSX only says what each
          stroke is MADE of. */}
      <svg
        aria-hidden={false}
        width="100%" height="100%"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}
      >
        {tubeGlowOn && (
          <defs>
            {/* The dial's recipe, unchanged: DualRingRect.jsx blurs its halo at
                stdDeviation 1.9 inside a box grown 50% every way so the bloom is not
                clipped at the edges of it. */}
            <filter id="tubeGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.9"/>
            </filter>
          </defs>
        )}
        {/* The slab the tube rides on - drawn FIRST, so every stroke paints over
            it. Two of them, carrying the same dash patterns as the ring and the
            wall below, so the slab exists exactly where the pipe does. The width
            is set per frame from the measured proud edge; see the loop. */}
        <path ref={(el) => { (mouthRef.current ||= [])[0] = el; }} fill="none" pathLength={1}
          stroke="var(--planner-face)" strokeLinecap="round" strokeLinejoin="round"/>
        <path ref={(el) => { (mouthRef.current ||= [])[1] = el; }} fill="none" pathLength={1}
          stroke="var(--planner-face)" strokeLinecap="round" strokeLinejoin="round"/>
        {/* The top ring is always drawn - it IS the band the dial wore before any
            of this, wearing the stroke it wore inside DualRingRect. */}
        <path ref={(el) => { tubeRef.current[0] = el; }} pathLength={1} fill="none"
          stroke="var(--clock-stroke-bg)" strokeWidth={RIBBON_W} strokeLinecap="round"/>
        {/* The wall LAID AHEAD of the liquid on the way out and retracted behind it
            on the way back. Same stroke, because it is the same tube - just the
            part of it that did not exist a moment ago. */}
        <path ref={(el) => { tubeRef.current[1] = el; }} pathLength={1} fill="none"
          stroke="var(--clock-stroke-bg)" strokeWidth={RIBBON_W} strokeLinecap="round"/>
        {/* THE HALO, one per slug, drawn UNDER the liquid it belongs to - the dial's
            treatment for its session arc, copied 1-1 (user-directed 2026-09-09): the
            same span, 2.2x the width, a third of the opacity, blurred. `.tube-water`
            again, so the halo is whatever colour the liquid currently is, hover flip
            included. Off entirely when the clock's ambient light is off. */}
        {tubeGlowOn && (
          // ONE group, not two glowing paths (user-reported 2026-09-10: "when two
          // points of the liquid touch the glow amplifies and creates a noticeable
          // point in the middle"). Two separately-faded strokes ADD where they meet -
          // at the mouths, where the two slugs are end to end, that doubled the halo
          // into a bright knot. Grouped, both strokes render opaque into one buffer,
          // where the overlap is the union of two identical colours rather than a sum,
          // and the blur and the fade are applied ONCE to the result.
          <g opacity="0.32" filter="url(#tubeGlow)">
            <path ref={(el) => { tubeRef.current[5] = el; }} pathLength={1} fill="none"
              className="tube-water" strokeWidth={WATER_W * 2.2} strokeLinecap="round"/>
            <path ref={(el) => { tubeRef.current[6] = el; }} pathLength={1} fill="none"
              className="tube-water" strokeWidth={WATER_W * 2.2} strokeLinecap="round"/>
          </g>
        )}
        {/* The liquid. Accent, so the widget gains a permanently coloured ring it
            did not have before (user-directed). `.tube-water` is the dev toy's own
            class reused unchanged: it also flips the liquid white while the tile is
            hovered, which is what stops it vanishing into the accent flood. */}
        <path ref={(el) => { tubeRef.current[2] = el; }} pathLength={1} fill="none"
          className="tube-water" strokeWidth={WATER_W} strokeLinecap="round"/>
        {/* The left branch's liquid. Two elements because the two slugs are two
            separate spans of the same path, and one stroke can carry one. */}
        <path ref={(el) => { tubeRef.current[4] = el; }} pathLength={1} fill="none"
          className="tube-water" strokeWidth={WATER_W} strokeLinecap="round"/>
        {/* The click target follows the whole PIPE rather than the liquid, so the
            control is live along the entire run whether that stretch is wet or dry.
            The dial keeps its own button regardless (DualRingRect) - a hand goes
            back to where it clicked, not where the paint went. */}
        <path
          ref={(el) => { tubeRef.current[3] = el; }}
          fill="none" stroke="transparent"
          strokeWidth={RIBBON_W + 6} strokeLinecap="round"
          role="button" tabIndex={0}
          aria-label="Toggle day calendar"
          style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
          onClick={toggleCalendar}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggleCalendar(e);
          }}/>
      </svg>
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
  grooveRef,
  onGrooveClick,
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

  // The readout FILLS the ring's interior (user-directed 2026-09-03), so the box
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
  const dialBoxWidth =
    `calc(100% ${dialOverflow < 0 ? '-' : '+'} ${Math.abs(dialOverflow)}px)`;
  const dialW = ringSize.w || Math.round(242 * scale);
  const ringH = Math.round(
    readoutHeightForWidth(dialW - 2 * RING_INNER_EDGE - 2 * READOUT_PAD_PX)
    + 2 * READOUT_PAD_PX + 2 * RING_INNER_EDGE,
  );
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
        // 14px, matching the 14px side margins the dial, the strip and the
        // calendar all share - so the widget carries ONE even border on every
        // side. It was 12 to match the stacking gaps, which left the top 2px
        // tighter than the sides once the inner shells went away.
        paddingTop: WIDGET_MARGIN,
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
              ref={ringButtonRef}
              // data-no-drag: the ring is a drag-to-SET-time surface (DualRingRect
              // pointer-captures). Without this the sidebar list's hold-to-reorder
              // (onItemDown) also fires on the bubbled pointerdown and picks up the
              // whole tile (.is-dragging → pressed-down look) mid-time-set. Same
              // guard the music scrub bar uses; reorder still works from the tile
              // chrome around the ring.
              data-no-drag
              // A plain region on the tile's face - no shell, no frame, no depth
              // of its own. position:relative so the inner-controls overlay still
              // anchors here, and the SVG now spans this box exactly, which is why
              // RING_INSET below no longer subtracts a frame.
              className="planner-dial"
              style={{
                position: 'relative',
                // The dial's BOX overflows its slot by the ring's own edge gap on
                // all four sides, so the painted ring lands on the same 14px margin
                // as the strip and the calendar (user-directed 2026-09-06: "too much
                // space on the outside of the dual ring"). Matching the boxes left
                // the ring looking inset by an extra ~10px, because the svg holds
                // that gap inside itself. Negative margins cancel the overflow, so
                // the column's own spacing is unchanged.
                width: dialBoxWidth,
                margin: `${-RING_EDGE_GAP}px 0`,
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
                height: ringH,
              }}
            >
              <DualRingRect
                remainingMins={secsLeft / 60}
                phase={phase}
                running={running}
                accent="var(--accent)"
                plate="var(--planner-face)"
                outerR={outerR}
                svgInset={svgInset}
                grooveRef={grooveRef}
                onGrooveClick={onGrooveClick}
                width={ringSize.w || Math.round(242 * scale)}
                height={ringSize.h || ringH}
                interactive={idle}
                dragMins={dragMins}
                glow={glowOn}
                onDragStart={handleDragStart}
                onDrag={handleDrag}
                onDragEnd={handleDragEnd}
                onPressedChange={setDialPressed}
              />
              {innerControls && (
                /* The interior is ONE box with two layers stacked in a single
                   grid cell: the readout filling it, and the three control
                   panels covering it, revealed on hover. The four insets come
                   from DualRingRect's own exported ring geometry - they were
                   hardcoded 26/29 literals in styles.css, a copy of that
                   number that could drift the moment the ring was retuned. */
                <div className="planner-ring-inner-controls" ref={innerBoxRef} style={{
                  top: RING_INSET, bottom: RING_INSET,
                  left: RING_INSET, right: RING_INSET,
                  '--ring-radius': `${cornerAt(outerR, svgInset + RING_INSET)}px`,
                }}>
                  <div className="planner-timer-digits">
                    <SegmentReadout value={mmss(secsLeft, dragMins)}
                      w={readoutBox.w} h={readoutBox.h}/>
                  </div>
                  <div className="planner-ring-controls">{innerControls}</div>
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
// calc, and .planner-calendar-body's margin in styles.css) and a border is even or
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

// One of the three flush full-height panels covering the dial's interior. Flat by
// design (no depth band, no frame - see styles.css), icon-only, and invisible
// until the dial is hovered.
function RingPanel({ onClick, title, children }) {
  return (
    <button
      type="button"
      data-own-press
      onClick={onClick}
      title={title}
      className="candy-btn planner-ring-panel"
    >
      <span className="candy-face">{children}</span>
    </button>
  );
}
