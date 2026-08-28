import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DualRingRect from './watchfaces/DualRingRect.jsx';
import CalendarPanel from './CalendarPanel.jsx';
import { CircleChip } from '@host/components/ui/index.js';
import {
  IconReset, IconSkip, IconChevronRight, IconX, IconCheck, IconStop,
} from '@host/components/icons.jsx';

// Icon sizes in the control row are set PER CALL SITE, not left at the pack
// default, because the default lies: `size` sets the SVG box, not the mark in
// it. IconSkip is a Boxicons glyph on a 24 viewBox whose path only spans 7..17,
// so it inks ~42% of its box; IconReset and IconStop are Font Awesome paths on
// a 384/448 viewBox that fill it edge to edge. At a shared size=15 the two FA
// marks painted ~2.4x larger than the skip arrow — which is exactly what
// "the icons are way too large" looked like. Sizes below are tuned so all
// three paint at matching visual weight (a solid square reads heavier than an
// outline at equal ink, so IconStop sits smallest). Pack defaults are shared
// app-wide and must NOT be changed for this.
// The TimerPrimary pill is text-only (no play/pause icon per user request), so
// IconPlay/IconPause are not needed here.
// Measured in the live row: IconSkip at the pack default inks 6.3px. Reset is
// matched to it; Stop sits a touch under because a solid square reads heavier
// than an outline at equal ink.
const ICON_RESET_PX = 7;
const ICON_STOP_PX = 6;

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

  // Controls (Reset / START·PAUSE / Skip-or-EndEarly). Built once and placed
  // inside the rect ring-button via TimerWidget's innerControls prop.
  // Block runs swap the whole row for cancel + finish-early circles: pause is
  // disallowed during a block (it would drift the finish past the block's
  // calendar end), and Reset/Stop were three spellings of the same cancel.
  const ctrlCircleSize = Math.round(26 * scale);
  const ctrlThird = phase === 'focus' && sessionStart ? (() => {
    const elapsedMs = (pauseStartRef.current ?? now) - sessionStart;
    const elapsedMin = Math.max(1, Math.round(elapsedMs / 60000));
    return (
      <CircleChip size={ctrlCircleSize} onClick={endSessionEarly}
        title={`End session early · logs ${elapsedMin}m`}><IconStop size={ICON_STOP_PX}/></CircleChip>
    );
  })() : (
    <CircleChip size={ctrlCircleSize} onClick={skipPhase}
      title={phase === 'focus' ? 'Skip to break' : 'Skip to focus'}><IconSkip/></CircleChip>
  );
  // MM:SS is a plain line ABOVE this row again (TimerWidget renders it) — the
  // transport button carries a WORD, not the digits (user-directed 2026-08-27).
  // A block run has no pause (it would drift the finish past the block's
  // calendar end), so its row is cancel + finish only; the readout above covers
  // the digits that used to sit between them.
  const controlsJSX = blockRun ? (
    <>
      <CircleChip size={ctrlCircleSize} onClick={stopBlockRun}
        title="Cancel block timer — nothing is logged"><IconX/></CircleChip>
      <CircleChip size={ctrlCircleSize} onClick={finishBlockEarly}
        title="Finish block early — trims the block to now"><IconCheck/></CircleChip>
    </>
  ) : (
    <>
      <CircleChip size={ctrlCircleSize} onClick={resetTimer} title="Reset"><IconReset size={ICON_RESET_PX}/></CircleChip>
      <TimerPrimary onClick={toggleTimer} running={running}
        label={running ? 'Pause' : (idle ? 'Start' : 'Resume')}
        size={ctrlCircleSize} scale={scale}/>
      {ctrlThird}
    </>
  );

  return (
    <div ref={dockRef} style={{
      width: '100%', minWidth: 0,
      display: 'flex', flexDirection: 'column',
      // Transparent so the enclosing .music-tile candy chrome (surface-3
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
                height: Math.round(121 * scale),
              }}
            >
              <div className="candy-face">
              <DualRingRect
                remainingMins={secsLeft / 60}
                phase={phase}
                running={running}
                accent="var(--accent)"
                width={ringSize.w || Math.round(242 * scale)}
                height={ringSize.h || Math.round(113 * scale)}
                interactive={idle}
                dragMins={dragMins}
                glow={glowOn}
                onDragStart={handleDragStart}
                onDrag={handleDrag}
                onDragEnd={handleDragEnd}
                onPressedChange={setPressed}
              />
              {innerControls && (
                <div className="planner-ring-inner-controls">
                  {/* MM:SS is plain text ABOVE the control row (user-directed
                      2026-08-27) — not inside a button. dragMins flows through
                      mmss() so it previews the new duration while the dial is
                      dragged to set time. */}
                  <div className="planner-timer-digits" style={{
                    
                    lineHeight: 1,
                  }}>{mmss(secsLeft, dragMins)}</div>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    gap: Math.round(6 * scale),
                  }}>
                    {innerControls}
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>
      </div>
    </div>
  );
}

// The transport button carries a WORD (Start / Pause / Resume), not the digits —
// MM:SS is a plain line above the row (user-directed 2026-08-27). Its HEIGHT is
// handed in from the caller as the same value the sibling CircleChips get, so
// all three controls in the row share one height by construction rather than by
// two constants kept in sync. Width still hugs the label.
const READOUT_FONT_PX = 15;   // the standalone MM:SS above the row, design px
// The pill takes .candy-face's body-text size like every other label — no local
// font-size at all, so it can never drift from the rest again.
const LABEL_PAD_X_PX = 10;     // design px, left/right only — height comes from `size`

function TimerPrimary({ onClick, label, running = false, size, scale = 1 }) {
  // Accent ONLY while the timer is actually ticking; paused and idle read the
  // same neutral face as the Reset/Skip circles beside it, so the accent is a
  // running indicator rather than permanent chrome.
  return (
    <button
      onClick={onClick}
      className={`candy-btn${running ? ' is-primary' : ''}`}
      data-shape="block"
      style={{
        minWidth: 0,
        height: size,
        // The block shape declares --corner-max: 18px because it assumes a 33px
        // tall button. This one is `size` tall (26), so it inherited a rounder
        // corner than the circles beside it at the same global --corner. Half the
        // real height is the shape system's own definition of fully-round, which
        // is exactly what the circle shape computes — same formula, same source.
        '--corner-max': `${size / 2}px`,
        // No transform here: the parent overlay is promoted to its own layer for
        // grey-edged text (styles.css § .planner-ring-inner-controls), and a
        // transform on this button would hand it a separate OPAQUE layer that
        // switches sub-pixel fringing back on for its label alone.
        // Same lip as the circles beside it, and it tracks the user's depth setting.
        '--cbtn-depth': 'var(--candy-depth-small)',
      }}
    >
      <span
        className="candy-face"
        style={{
          height: '100%',
          padding: `0 ${Math.round(LABEL_PAD_X_PX * scale)}px`,
          lineHeight: 1,
        }}
      >{label}</span>
    </button>
  );
}


