// Timeline core (SF6/SF7) — two video lanes (tracks array is bottom→top, so
// v2 renders above v1) + a linked-audio strip, adaptive ruler, pxPerSecond
// zoom (the CalendarPanel hourHeight pattern rotated horizontal), and ONE
// absolutely-positioned playhead needle moved by direct style writes — never
// React state fanned out to clips. Chrome is functional-only from existing
// tokens (creative checkpoint waived 2026-06-10: core functionality first).
//
// Frame math: ppf = pps / sequence.fps. Snapping is ALWAYS the frame grid;
// magnetic priority points (clip edges, playhead, t=0) layer on top inside an
// 8 px window, and neighbor-gap clamping guarantees clips never overlap —
// resolveTarget below is the single authority for drags AND bin drops.
// SF7 adds: blade tool mode (header toggle + frame-snapped hover hairline +
// click-to-split routed to editList), trim clamping via editList.trimBounds,
// and click-select with lane-background deselect.
//
// Perf contract (200-clip HUD gate): scroll renders must NEVER touch clips —
// LaneArea is memoized and keyed off a 384 px-quantized window (winA/winB),
// so per-scroll-frame work is ruler ticks only; zoom renders re-lay only the
// clips inside that window. First HUD run without this re-rendered all 200
// clips per scrolled/zoomed frame: 17.6% of frames > 16.7 ms (FAIL).

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Slider } from '@host/components/ui/Slider.jsx';
import TimeRuler from './TimeRuler.jsx';
import TimelineClip from './TimelineClip.jsx';
import { newId } from './project.js';
import { trimBounds } from './editList.js';

const mono = { fontFamily: 'var(--font-mono), monospace' };
const MAGNET_PX = 8;
const LANE_H = 54;
const AUDIO_H = 22;
const PPS_MIN = 8;
const PPS_MAX = 480;
const WIN_PAD = 512;   // px rendered beyond each viewport edge
const WIN_STEP = 384;  // window quantization — memo breaks only on crossings

// Nearest start that keeps [start, start+dur) inside a free gap of `clips`.
// The trailing gap is infinite, so a valid start always exists (≥ 0).
// EditorPage reuses this for bin→timeline drops.
export function clampStartToGap(clips, start, dur, selfId) {
  const sorted = clips.filter(c => c.id !== selfId).sort((a, b) => a.start - b.start);
  const gaps = [];
  let lo = 0;
  for (const c of sorted) {
    if (c.start > lo) gaps.push([lo, c.start]);
    lo = Math.max(lo, c.start + c.dur);
  }
  gaps.push([lo, Infinity]);
  let best = null;
  let bestDist = Infinity;
  for (const [g0, g1] of gaps) {
    if (g1 - g0 < dur) continue;
    const clamped = Math.max(g0, Math.min(start, g1 - dur));
    const dist = Math.abs(clamped - start);
    if (dist < bestDist) { bestDist = dist; best = clamped; }
  }
  return best ?? Math.max(0, start);
}

const chip = {
  ...mono,
  fontSize: 10.5,
  color: 'var(--text-faint)',
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '2px 6px',
  cursor: 'pointer',
};

const laneLabel = {
  ...mono,
  position: 'sticky',
  left: 8,
  float: 'left',
  fontSize: 10,
  color: 'var(--text-faint)',
  textTransform: 'uppercase',
  userSelect: 'none',
  zIndex: 1,
  pointerEvents: 'none',
};

const inWindow = (c, ppf, winA, winB) =>
  (c.start + c.dur) * ppf >= winA && c.start * ppf <= winB;

// Memoized lane subtree: every prop is identity-stable across scroll frames
// (tracks/nameOf/handlers stable, winA/winB quantized), so scrolling bails
// out here and only the ruler re-renders.
const LaneArea = memo(function LaneArea({
  tracks, ppf, nameOf, accent, winA, winB,
  selectedClipIds, bladeMode,
  resolveTarget, onMoveClip, onSelectClip, onSplitClip, resolveTrim, onTrimClip, onClipMenu,
}) {
  const laneOrder = tracks.map((_, i) => i).reverse(); // v2 above v1
  return (
    <div data-tl-lanes>
      {laneOrder.map((idx) => {
        const track = tracks[idx];
        return (
          <div
            key={track.id}
            data-track-lane={idx}
            onClick={(e) => { if (e.target === e.currentTarget) onSelectClip(null, null); }}
            style={{ position: 'relative', height: LANE_H, borderBottom: '1px solid var(--border)', contain: 'layout' }}
          >
            <span style={{ ...laneLabel, top: 4 }}>{track.id}</span>
            {track.clips.filter(c => inWindow(c, ppf, winA, winB)).map((c) => (
              <TimelineClip
                key={`${c.id}:${idx}:${c.start}:${c.dur}`}
                clip={c}
                name={c.kind === 'title' ? (c.title?.text || 'Title') : (nameOf.get(c.mediaId) || c.mediaId)}
                ppf={ppf}
                laneIdx={idx}
                laneH={LANE_H}
                accent={accent}
                selected={!!selectedClipIds?.has(c.id)}
                bladeMode={bladeMode}
                resolveTarget={resolveTarget}
                onCommitMove={onMoveClip}
                onSelect={onSelectClip}
                onBladeClick={onSplitClip}
                resolveTrim={resolveTrim}
                onTrimCommit={onTrimClip}
                onMenu={onClipMenu}
              />
            ))}
          </div>
        );
      })}
      {/* Linked-audio strip: each clip's audio mirrored at the same x/width,
          drawn in track order (v2 over v1). Visual only until SF9 wires
          gain/mute. */}
      <div style={{ position: 'relative', height: AUDIO_H, borderBottom: '1px solid var(--border)', contain: 'layout' }}>
        <span style={{ ...laneLabel, top: 3, textTransform: 'none' }}>A</span>
        {tracks.map((track) =>
          track.clips.filter(c => inWindow(c, ppf, winA, winB)).map((c) => (
            <div
              key={`a:${c.id}`}
              style={{
                position: 'absolute',
                left: c.start * ppf,
                width: Math.max(2, c.dur * ppf),
                top: 3,
                height: AUDIO_H - 7,
                borderRadius: 4,
                background: accent || 'var(--accent)',
                opacity: c.mute ? 0.1 : 0.3,
              }}
            />
          )))}
      </div>
    </div>
  );
});

export default function Timeline({
  project, accent,
  onMoveClip, updateProject, markDirty,
  selectedClipIds, onSelectClip,
  bladeMode, onToggleBlade,
  onSplitClip, onTrimClip,
  onClipMenu, playheadFrameRef,
  timelineRef, onScrub,
}) {
  const [pps, setPps] = useState(60);
  const [scrollX, setScrollX] = useState(0);
  const [viewW, setViewW] = useState(0);
  const [hudText, setHudText] = useState('');
  const ppsRef = useRef(60);
  const scrollRef = useRef(null);
  const needleRef = useRef(null);
  const bladeLineRef = useRef(null);
  const internalPlayhead = useRef(0);
  // frames — zoom anchor + magnets + the menu's trim-to-playhead (EditorPage
  // passes its own ref so it can read the playhead without re-renders)
  const playheadRef = playheadFrameRef || internalPlayhead;
  const rulerScrub = useRef(false);
  const pendingAnchor = useRef(null);

  const fps = project.sequence.fps || 30;
  const ppf = pps / fps;

  const maxEnd = useMemo(() => {
    let m = 0;
    for (const t of project.tracks) for (const c of t.clips) m = Math.max(m, c.start + c.dur);
    return m;
  }, [project.tracks]);
  const totalFrames = Math.max(maxEnd, fps * 60) + fps * 10;
  const contentW = Math.ceil(totalFrames * ppf);

  const mediaById = useMemo(() => new Map(project.media.map(m => [m.id, m])), [project.media]);

  // Native handlers (wheel, ruler scrub, blade hairline) and the stable
  // resolveTarget/resolveTrim read geometry/data through refs so they never
  // see stale closures.
  const geom = useRef({});
  geom.current = { ppf, fps, totalFrames, tracks: project.tracks, ctx: { seqFps: fps, mediaById } };

  useEffect(() => { ppsRef.current = pps; }, [pps]);

  // Imperative surface for the module keybinds (SF11) — plain ref prop,
  // matching playheadFrameRef's idiom.
  useEffect(() => {
    if (timelineRef) timelineRef.current = { zoomBy: (f) => zoomTo(ppsRef.current * f) };
  });

  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const ro = new ResizeObserver(() => setViewW(sc.clientWidth));
    ro.observe(sc);
    setViewW(sc.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Zoom anchored about the playhead: keep its viewport X constant across the
  // pps change (scrollLeft is re-derived AFTER the resized content commits).
  const zoomTo = useCallback((next) => {
    const sc = scrollRef.current;
    const clamped = Math.max(PPS_MIN, Math.min(PPS_MAX, Math.round(next)));
    if (!sc || clamped === ppsRef.current) return;
    pendingAnchor.current = {
      frame: playheadRef.current,
      vx: playheadRef.current * geom.current.ppf - sc.scrollLeft,
    };
    setPps(clamped);
  }, []);

  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const pa = pendingAnchor.current;
    if (sc && pa) {
      sc.scrollLeft = Math.max(0, pa.frame * ppf - pa.vx);
      pendingAnchor.current = null;
      setScrollX(sc.scrollLeft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pps]);

  // React 17+ registers synthetic wheel listeners passive — preventDefault
  // needs a native non-passive listener. Plain wheel = zoom; shift+wheel
  // falls through to native horizontal pan.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const onWheel = (e) => {
      if (e.shiftKey) return;
      e.preventDefault();
      zoomTo(ppsRef.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // SF9: the playback engine writes playheadRef per tick — follow it with
  // direct transform writes (no re-render). Also covers ruler scrubs and
  // zoom-driven ppf changes.
  useEffect(() => {
    let raf;
    let lastX = -1;
    const loop = () => {
      const x = playheadRef.current * geom.current.ppf;
      if (Math.abs(x - lastX) > 0.01 && needleRef.current) {
        lastX = x;
        needleRef.current.style.transform = `translateX(${x}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single snap+clamp authority for clip drags: frame grid always, then
  // magnets (clip edges on every track, playhead, t=0 — aligning either the
  // dragged clip's start OR end) inside an 8 px window, then gap clamping.
  // Identity-stable (reads through geom/playheadRef) so LaneArea's memo holds.
  const resolveTarget = useCallback((laneIdx, desired, dur, selfId) => {
    const { tracks, ppf: pf } = geom.current;
    const magnets = [0, Math.round(playheadRef.current)];
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.id === selfId) continue;
        magnets.push(c.start, c.start + c.dur);
      }
    }
    const thresh = Math.max(1, MAGNET_PX / pf);
    let snapped = desired;
    let best = thresh + 1e-6;
    for (const m of magnets) {
      for (const cand of [m, m - dur]) {
        const d = Math.abs(cand - desired);
        if (d < best) { best = d; snapped = cand; }
      }
    }
    snapped = Math.max(0, Math.round(snapped));
    return clampStartToGap(tracks[laneIdx]?.clips || [], snapped, dur, selfId);
  }, []);

  // Live trim clamping for TimelineClip handles — same bounds the committed
  // editList op re-derives (frame grid + neighbors + source material).
  const resolveTrim = useCallback((laneIdx, clipId, edge, desired) => {
    const { tracks, ctx } = geom.current;
    const b = trimBounds(ctx, tracks, laneIdx, clipId);
    const v = Math.round(desired);
    if (!b) return v;
    return edge === 'in'
      ? Math.max(b.minStart, Math.min(v, b.maxStart))
      : Math.max(b.minEnd, Math.min(v, b.maxEnd));
  }, []);

  // Ruler scrub: playhead via direct style writes (frame-snapped); React
  // state is never touched per move. onScrub feeds the playback engine so the
  // picture follows (SF11 — its freshest-wins seek queue absorbs the move rate).
  const scrubTo = (clientX, rulerEl) => {
    const rect = rulerEl.getBoundingClientRect(); // ruler spans content width → rect.left already includes scroll
    const g = geom.current;
    const f = Math.max(0, Math.min(Math.floor(g.totalFrames), Math.round((clientX - rect.left) / g.ppf)));
    playheadRef.current = f;
    if (needleRef.current) needleRef.current.style.transform = `translateX(${f * g.ppf}px)`;
    onScrub?.(f);
  };
  const onRulerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    rulerScrub.current = true;
    scrubTo(e.clientX, e.currentTarget);
  };
  const onRulerMove = (e) => { if (rulerScrub.current) scrubTo(e.clientX, e.currentTarget); };
  const onRulerUp = () => { rulerScrub.current = false; };

  // Blade hover hairline — frame-snapped, moved by direct style writes on a
  // wrapper around LaneArea (so the memo never sees these handlers).
  const onLanesPointerMove = bladeMode ? (e) => {
    const sc = scrollRef.current;
    const g = geom.current;
    if (!sc) return;
    const f = Math.max(0, Math.round((e.clientX - sc.getBoundingClientRect().left + sc.scrollLeft) / g.ppf));
    const el = bladeLineRef.current;
    if (el) {
      el.style.display = 'block';
      el.style.transform = `translateX(${f * g.ppf}px)`;
    }
  } : undefined;
  const onLanesPointerLeave = bladeMode ? () => {
    if (bladeLineRef.current) bladeLineRef.current.style.display = 'none';
  } : undefined;

  // ── Dev-only stress fixture + frame-time HUD ─────────────────────────────
  const stress = import.meta.env.DEV ? () => {
    if (!project.media.length) { setHudText('import a clip first'); return; }
    updateProject(p => {
      const f = p.sequence.fps || 30;
      const tracks = p.tracks.map(t => ({ ...t, clips: [...t.clips] }));
      const cursors = tracks.map(t => t.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0));
      for (let i = 0; i < 200; i++) {
        const ti = i % 2;
        const m = p.media[i % p.media.length];
        const dur = Math.max(1, Math.round((1 + Math.random() * 2) * f));
        const start = cursors[ti] + Math.round(Math.random() * 12);
        tracks[ti].clips.push({ id: newId(), mediaId: m.id, start, dur, in: 0, gain: 1, mute: false });
        cursors[ti] = start + dur;
      }
      return { ...p, tracks };
    });
    markDirty();
  } : null;

  const clearClips = import.meta.env.DEV ? () => {
    updateProject(p => ({ ...p, tracks: p.tracks.map(t => ({ ...t, clips: [] })) }));
    markDirty();
    setHudText('');
  } : null;

  // Scripted 10 s pass: 5 s scroll sweep (scroll-render path) + 5 s zoom
  // oscillation (full re-render path), sampling rAF deltas throughout.
  // Pass threshold: < 5% of frames over the 16.7 ms WORK budget. On
  // high-refresh displays the raw delta over-counts: at ~104 Hz (9.6 ms
  // vsync) a frame doing 10–16.6 ms of work — inside the 60 Hz budget the
  // spec number means — still records a ~19.2 ms delta. So alongside the raw
  // count, report a 60 Hz-equivalent count: deltas that imply work actually
  // exceeded 16.7 ms (≥ 2 missed vsyncs when base < 14 ms). Both numbers are
  // recorded; the per-phase split (A=scroll, B=zoom) says where the cost is.
  const runHud = import.meta.env.DEV ? () => {
    const sc = scrollRef.current;
    if (!sc) return;
    const basePps = ppsRef.current;
    const samples = [];
    const t0 = performance.now();
    let last = t0;
    setHudText('measuring…');
    const tick = (now) => {
      const t = (now - t0) / 1000;
      samples.push({ dt: now - last, phase: t < 5 ? 'A' : 'B' });
      last = now;
      if (t < 5) {
        const max = Math.max(0, sc.scrollWidth - sc.clientWidth);
        sc.scrollLeft = max * (0.5 - 0.5 * Math.cos(t * 1.6));
      } else if (t < 10) {
        setPps(Math.round(135 + 105 * Math.sin((t - 5) * 2.4)));
      }
      if (t < 10) {
        requestAnimationFrame(tick);
      } else {
        setPps(basePps);
        const n = samples.length;
        const mean = samples.reduce((a, b) => a + b.dt, 0) / n;
        const base = samples.map(s => s.dt).sort((a, b) => a - b)[Math.floor(n / 2)];
        const specThresh = base > 14 ? 16.7 : 2 * base + 2;
        const raw = samples.filter(s => s.dt > 16.7);
        const eq = samples.filter(s => s.dt > specThresh);
        const inPhase = (arr, p) => arr.filter(s => s.phase === p).length;
        const pctEq = (eq.length / n) * 100;
        const txt = `${pctEq < 5 ? 'PASS' : 'FAIL'} 60Hz-eq>${specThresh.toFixed(1)}: ${eq.length}/${n} (${pctEq.toFixed(1)}%) [A${inPhase(eq, 'A')}/B${inPhase(eq, 'B')}] · raw>16.7: ${raw.length} (${((raw.length / n) * 100).toFixed(1)}%) [A${inPhase(raw, 'A')}/B${inPhase(raw, 'B')}] · mean ${mean.toFixed(1)} · base ${base.toFixed(1)} ms`;
        setHudText(txt);
        console.info('[tl-hud]', txt);
      }
    };
    requestAnimationFrame(tick);
  } : null;

  const nameOf = useMemo(() => {
    const m = new Map();
    for (const x of project.media) m.set(x.id, (x.src || '').split('/').pop());
    return m;
  }, [project.media]);

  const hasClips = maxEnd > 0;
  const winA = Math.max(0, Math.floor((scrollX - WIN_PAD) / WIN_STEP) * WIN_STEP);
  const winB = Math.ceil((scrollX + (viewW || 0) + WIN_PAD) / WIN_STEP) * WIN_STEP;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', userSelect: 'none' }}>
          Timeline
        </div>
        <button
          style={{
            ...chip,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.08em',
            padding: '3px 10px',
            ...(bladeMode
              ? { color: accent || 'var(--accent)', borderColor: accent || 'var(--accent)', boxShadow: `0 0 0 1px ${accent || 'var(--accent)'}` }
              : { color: 'var(--text-muted)' }),
          }}
          onClick={onToggleBlade}
          title="Blade — click a clip to split it at the frame under the cursor"
        >
          ✂ BLADE
        </button>
        <div style={{ width: 210 }}>
          <Slider value={pps} min={PPS_MIN} max={PPS_MAX} unit="" onChange={zoomTo} accent={accent} />
        </div>
        {stress && <button style={chip} onClick={stress}>stress 200</button>}
        {clearClips && <button style={chip} onClick={clearClips}>clear clips</button>}
        {runHud && <button style={chip} onClick={runHud}>hud</button>}
        {hudText && (
          <div style={{ ...mono, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {hudText}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={scrollRef}
          data-tl-scroll
          data-ppf={ppf}
          onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
          style={{ position: 'absolute', inset: 0, overflowX: 'auto', overflowY: 'hidden' }}
        >
          <div style={{ position: 'relative', width: contentW, minWidth: '100%', height: '100%' }}>
            <div
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              onPointerCancel={onRulerUp}
              style={{ position: 'relative', height: 26, borderBottom: '1px solid var(--border)', cursor: 'pointer', touchAction: 'none' }}
            >
              <TimeRuler pps={pps} winA={winA} winB={winB} contentW={contentW} />
            </div>

            <div onPointerMove={onLanesPointerMove} onPointerLeave={onLanesPointerLeave}>
              <LaneArea
                tracks={project.tracks}
                ppf={ppf}
                nameOf={nameOf}
                accent={accent}
                winA={winA}
                winB={winB}
                selectedClipIds={selectedClipIds}
                bladeMode={bladeMode}
                resolveTarget={resolveTarget}
                onMoveClip={onMoveClip}
                onSelectClip={onSelectClip}
                onSplitClip={onSplitClip}
                resolveTrim={resolveTrim}
                onTrimClip={onTrimClip}
                onClipMenu={onClipMenu}
              />
            </div>

            {bladeMode && (
              <div
                ref={bladeLineRef}
                style={{
                  position: 'absolute',
                  top: 26,
                  bottom: 0,
                  left: 0,
                  width: 1,
                  background: accent || 'var(--accent)',
                  boxShadow: `0 0 6px ${accent || 'var(--accent)'}`,
                  zIndex: 6,
                  pointerEvents: 'none',
                  display: 'none',
                }}
              />
            )}

            <div
              ref={needleRef}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: 2,
                background: accent || 'var(--accent)',
                zIndex: 5,
                pointerEvents: 'none',
                transform: `translateX(${playheadRef.current * ppf}px)`,
              }}
            >
              <div style={{ position: 'absolute', top: 0, left: -4, width: 10, height: 7, borderRadius: 2, background: accent || 'var(--accent)' }} />
            </div>
          </div>
        </div>

        {!hasClips && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--text-muted)', fontSize: 12.5 }}>
            Drag clips from the Bin to start cutting.
          </div>
        )}
      </div>
    </div>
  );
}
