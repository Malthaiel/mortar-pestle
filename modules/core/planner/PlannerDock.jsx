import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DualRingRect, { RING_INNER_EDGE, RING_INNER_CORNER } from './watchfaces/DualRingRect.jsx';
import SegmentReadout from './watchfaces/SegmentReadout.jsx';
import CalendarPanel from './CalendarPanel.jsx';
import {
  IconReset, IconSkip, IconChevronRight, IconX, IconCheck, IconStop,
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
  const [avail, setAvail] = useState(0);
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
          />

          {/* CALENDAR toggle — a plain candy button STRIP, the app-default two-layer
              shape (<button class="candy-btn"><span class="candy-face">). It used to
              be a frame that ENCLOSED the whole day calendar, so opening the calendar
              grew the button into one giant pressable slab; the calendar is now a
              sibling panel below (user-directed 2026-08-10). The button keeps its
              own footprint in both states and presses either way. */}
          <button
            type="button"
            className="candy-btn button-planner-calendar"
            data-collapsed={calendarCollapsed ? 'true' : 'false'}
            aria-expanded={!calendarCollapsed}
            aria-label={calendarCollapsed ? 'Expand day calendar' : 'Collapse day calendar'}
            onClick={() => setModuleSetting('calendarCollapsed', !calendarCollapsed)}
            // Even spacing: all three compact gaps render a VISIBLE 12px, each
            // slab-compensated because the slabs differ:
            //   ② ring → calendar : marginTop = (ring slab 18·tile-px) + 12
            //   ③ button → panel  : marginBottom = this button's slab ONLY. The
            //      12px belongs to the panel below (a constant margin-bottom there),
            //      so the gap is identical open or shut and nothing has to animate
            //      a margin — see .button-planner-calendar-body.
            // NB on THIS button var(--candy-depth) = --candy-depth-small (~5px),
            // so ② must spell out 18·tile-px (the RING's slab) literally — using
            // var(--candy-depth) here would compensate the wrong (5px) slab.
            style={{ margin: 'calc(18 * var(--tile-px) + 12px) 14px var(--candy-depth)', flexShrink: 0 }}
          >
            <span className="candy-face button-planner-calendar-header">
              <span>Calendar</span>
              <span
                className="planner-calendar-toggle-chevron"
                style={{ transform: `rotate(${calendarCollapsed ? 0 : 90}deg)` }}
              >
                <IconChevronRight/>
              </span>
            </span>
          </button>
          {/* Day calendar — its own recessed frame, a SIBLING of the button above.
              Slides open/closed on the measured max-height (`avail`), so the tile
              grows/shrinks with it. data-no-drag: blocks the sidebar list's
              hold-to-reorder and exempts presses in here from the tile's face slide. */}
          <div
              data-no-drag
              ref={calBodyRef}
              className="button-planner-calendar-body"
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
                className="button-planner-calendar-panel"
                style={{ overflowY: calendarCollapsed ? 'hidden' : 'auto' }}
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

  // Candy-shell depression for the compact rect ring-button stays synced with
  // the actual drag (not just CSS :active) so the button stays depressed when
  // the pointer leaves the surface mid-drag via pointer capture.
  const [pressed, setPressed] = useState(false);

  // Ring-button is width: 100% to match TOOLKIT-style container-filling. The
  // SVG inside needs actual pixel dims for the rounded-rect path math, so we
  // measure the button's content box via ResizeObserver and pass it down. The
  // initial useLayoutEffect measure runs synchronously before paint, avoiding
  // the zero-width flash on first render.
  const ringButtonRef = useRef(null);
  const [ringSize, setRingSize] = useState({ w: 0, h: 0 });

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
  const ringH = Math.round(126 * scale);
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
        // Fixed 12px so gap ① (module-top → ring) equals the other two even
        // gaps (no slab above the ring, so no compensation needed here).
        paddingTop: 12,
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
              // Two-layer candy default (.candy-btn base + .candy-face): the base
              // holds the band and NEVER moves; only the face slides on press.
              // Was legacy single-layer (whole element translated, shadow collapsed
              // to 0) — which read as the depth slab rising instead of the button
              // sinking. .is-pressed rides the shared state rule (styles.css § States)
              // so the JS drag-press stays in sync through pointer capture.
              className={`candy-btn planner-ring-button${pressed ? ' is-pressed' : ''}`}
              style={{
                // Match the calendar button's footprint: it's full-width with a
                // 14px margin per side (see line ~195), so inset the ring the same
                // 28px total. The inner SVG auto-tracks via the ResizeObserver above.
                width: 'calc(100% - 28px)',
                // 126: the interior is what the ring's inner edge leaves —
                // height − 2×RING_INNER_EDGE. Grown from 121 on 2026-08-28
                // ("make the dual ring slightly larger to accommodate"); the
                // readout that lives in that interior now MEASURES itself to
                // fill it, so this height is what decides how big it gets.
                height: ringH,
              }}
            >
              <div className="candy-face">
              <DualRingRect
                remainingMins={secsLeft / 60}
                phase={phase}
                running={running}
                accent="var(--accent)"
                width={ringSize.w || Math.round(242 * scale)}
                height={ringSize.h || ringH}
                interactive={idle}
                dragMins={dragMins}
                glow={glowOn}
                onDragStart={handleDragStart}
                onDrag={handleDrag}
                onDragEnd={handleDragEnd}
                onPressedChange={setPressed}
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
                  '--ring-radius': `${RING_RADIUS}px`,
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
    </div>
  );
}

// Breathing room between the readout and the inner ring stroke. The display fills
// BOTH axes of what is left (height sets the glyph size, the gaps take up the
// width), so this one number is the gap on all four sides - even by construction,
// not by tuning.
const READOUT_PAD_PX = 10;

// The interior's insets, in real px. RING_INNER_EDGE is where DualRingRect draws
// the inner ring's inner face measured from the svg edge; the svg spans the
// button's border box while this overlay is positioned against the face's
// padding box, so the button's own frame comes back off.
const CBTN_FRAME_PX = 3;   // --cbtn-frame on .planner-ring-button
const RING_INSET = RING_INNER_EDGE - CBTN_FRAME_PX;
const RING_RADIUS = RING_INNER_CORNER;

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
