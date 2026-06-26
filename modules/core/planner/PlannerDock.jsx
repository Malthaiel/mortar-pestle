import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DualRingRect from './watchfaces/DualRingRect.jsx';
import CalendarPanel from './CalendarPanel.jsx';
import { CircleChip, Dot } from '@host/components/ui/index.js';
import {
  IconReset, IconSkip, IconChevronRight, IconX, IconCheck,
} from '@host/components/icons.jsx';

// Local stop icon. Sized to match IconReset/IconSkip (15px) for the
// 44px circle buttons. The TimerPrimary pill is text-only (no play/pause icon
// per user request), so IconPlay/IconPause are no longer needed.
function IconStop({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/>
    </svg>
  );
}

import { useModuleSettings } from '@host/hooks/useSettings.js';
import { usePlanner } from './PlannerProvider.jsx';
import { useFrameEditing } from '@host/hooks/useFrameEditing.js';
import { todayLocalStr } from '@host/util/time.js';
import { BlockPopover, PullConfirmBar } from './BlockTimerUI.jsx';
import { descFromSession, descFromPlan, resolveDesc } from './blockPull.js';

function pad(n) { return String(n).padStart(2, '0'); }

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
  // dropped per user request.
  const phaseColor = accent;

  const { settings: moduleSettings, setSetting: setModuleSetting } = useModuleSettings('planner');
  const calendarCollapsed = moduleSettings.calendarCollapsed === true;

  // Daily frame blocks in the dock calendar — interactive (drag/retime/rename/
  // create/delete) like the planner, scoped to today (the dock is day-only).
  const [frameEditMode, setFrameEditMode] = useState(false);
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
        title={`End session early · logs ${elapsedMin}m`}><IconStop/></CircleChip>
    );
  })() : (
    <CircleChip size={ctrlCircleSize} onClick={skipPhase}
      title={phase === 'focus' ? 'Skip to break' : 'Skip to focus'}><IconSkip/></CircleChip>
  );
  const controlsJSX = blockRun ? (
    <>
      <CircleChip size={ctrlCircleSize} onClick={stopBlockRun}
        title="Cancel block timer — nothing is logged"><IconX/></CircleChip>
      <CircleChip size={ctrlCircleSize} onClick={finishBlockEarly}
        title="Finish block early — trims the block to now"><IconCheck/></CircleChip>
    </>
  ) : (
    <>
      <CircleChip size={ctrlCircleSize} onClick={resetTimer} title="Reset"><IconReset/></CircleChip>
      <TimerPrimary
        onClick={toggleTimer}
        phaseColor={phaseColor}
        running={running}
        sessionStart={sessionStart}
        scale={scale}
      />
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

          {/* Calendar frame — the candy button that ENCLOSES the day calendar.
              The header strip toggles collapse (chevron right→down); the body
              slides open/closed via the measured max-height (`avail` above), so
              the whole tile grows/shrinks with it. Collapsed, the frame behaves
              like a candy button (hover lift, press depress — see CSS :has);
              expanded, it's a static frame. State persists via module settings. */}
          <div
            className="button-planner-calendar"
            data-collapsed={calendarCollapsed ? 'true' : 'false'}
            // Even spacing: all three compact gaps render a VISIBLE 12px, each
            // slab-compensated because the slabs differ:
            //   ② ring → calendar : marginTop = (ring slab 18·tile-px) + 12
            //   ③ calendar → bottom: marginBottom = (this frame's slab) + 12
            // NB on THIS frame var(--candy-depth) = --candy-depth-small (~5px),
            // so ② must spell out 18·tile-px (the RING's slab) literally — using
            // var(--candy-depth) here would compensate the wrong (5px) slab.
            style={{ margin: 'calc(18 * var(--tile-px) + 12px) 14px calc(var(--candy-depth) + 12px)', flexShrink: 0 }}
          >
            <button
              type="button"
              data-own-press
              className="button-planner-calendar-header"
              aria-expanded={!calendarCollapsed}
              aria-label={calendarCollapsed ? 'Expand day calendar' : 'Collapse day calendar'}
              onClick={() => setModuleSetting('calendarCollapsed', !calendarCollapsed)}
            >
              <span>CALENDAR</span>
              <span
                className="planner-calendar-toggle-chevron"
                style={{ transform: `rotate(${calendarCollapsed ? 0 : 90}deg)` }}
              >
                <IconChevronRight/>
              </span>
            </button>
            <div
              ref={calBodyRef}
              className="button-planner-calendar-body"
              style={{
                maxHeight: calendarCollapsed ? 0 : avail,
                overflowY: calendarCollapsed ? 'hidden' : 'auto',
              }}
            >
              <div data-no-drag style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 8px 0' }}>
                <button
                  type="button"
                  className={`candy-btn${frameEditMode ? ' is-active' : ''}`}
                  data-shape="chip"
                  data-own-press
                  onClick={() => setFrameEditMode(v => !v)}
                  aria-pressed={frameEditMode}
                  aria-label="Edit Daily Frame"
                ><span className="candy-face">{frameEditMode ? 'Done' : 'Edit Frame'}</span></button>
              </div>
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
                frameEditMode={frameEditMode}
                onFrameEditExit={() => setFrameEditMode(false)}
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
  const paused = !running && !!sessionStart;

  // While dragging the dial to set a new duration, the readout previews the
  // drag value (MM:00) instead of the live secsLeft. Replaces the in-dial
  // "X MIN" overlay that AnalogClock used to render.
  const displaySecs = dragMins != null ? dragMins * 60 : secsLeft;
  const mm = pad(Math.floor(Math.max(0, displaySecs) / 60));
  const ss = pad(Math.max(0, displaySecs) % 60);

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

  // Flat MM:SS readout — no card chrome, no 3D text-shadow, no flip animation.
  // Just mono digits at hero scale. Per user request to "remove the flip clock
  // entirely and just keep the 30:00. remove the 3d effect from the 30:00."
  const TimeReadout = ({ size }) => (
    <div style={{
      fontFamily: 'var(--font-mono)',
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      fontSize: size,
      lineHeight: 1,
      letterSpacing: '0.05em',
      color: 'var(--text)',
    }}>{mm}:{ss}</div>
  );

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
              className={`planner-ring-button${pressed ? ' is-pressed' : ''}`}
              style={{
                // Match the calendar button's footprint: it's full-width with a
                // 14px margin per side (see line ~195), so inset the ring the same
                // 28px total. The inner SVG auto-tracks via the ResizeObserver above.
                width: 'calc(100% - 28px)',
                height: Math.round(121 * scale),
              }}
            >
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
                <div className="planner-ring-inner-controls"
                  style={{ gap: Math.round(4 * scale) }}>
                  {/* 30:00 now lives INSIDE the dial, above the 3 buttons.
                      pointer-events:none so it doesn't block drag-to-set on the
                      ring surface beneath it. */}
                  <div style={{ pointerEvents: 'none' }}>
                    <TimeReadout size={Math.round(34 * scale * 0.42)}/>
                  </div>
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

        {/* Paused indicator (no wall-clock pill — removed globally per user
            request to drop the session time range). */}
        {paused && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 9, color: 'rgba(245,244,241,0.45)',
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            <Dot color="rgba(245,244,241,0.45)" size={5}/>
            PAUSED — {mm}:{ss} LEFT
          </span>
        )}
      </div>
    </div>
  );
}

function TimerPrimary({ onClick, phaseColor, running, sessionStart, scale = 1 }) {
  // START / PAUSE / RESUME share the same filled candy pill — text-only, no
  // play/pause icon (per user request). The pill inherits the global
  // `var(--accent)` from :root so the accent picker drives it directly.
  // Shrinks to match the inner-ring height of the rect ring-button (height
  // matches sibling CircleChips at 26px).
  const label = running ? 'PAUSE' : (sessionStart ? 'RESUME' : 'START');
  return (
    <button
      onClick={onClick}
      className="candy-btn is-primary"
      data-shape="block"
      style={{
        minWidth: Math.round(80 * scale),
        height: Math.round(23 * scale),
        // #2: nudged +1px (was -1px) so START sits a hair lower than its sibling chips.
        transform: 'translateY(0px)',
        '--cbtn-depth': '5px',
      }}
    >
      <span className="candy-face" style={{ padding: `0 ${Math.round(12 * scale)}px`, fontSize: 11 }}>{label}</span>
    </button>
  );
}


