// Sidebar module-swap state machine. Drives the layered slide between the
// outgoing module's renderSecondary and the incoming module's. Reads
// settings.dock.modules.slideDuration; exposes a two-slot
// model where each slot keeps its module component mounted across the role
// transition (static → exiting → unmount), avoiding remount jank during
// the swap.
//
// Two physical slots ('A' and 'B') with stable React keys, alternating
// roles. Each module only unmounts after its exit animation completes —
// no double-mount during staggered overlap, no flicker on quick switches.
//
// Slot roles:
//   - 'static'   — at rest, full opacity, no animation.
//   - 'entering' — running the swap-in keyframe (with optional delay during
//                  staggered timing).
//   - 'exiting'  — running the swap-out keyframe; unmounted after totalMs.
//
// Quick-switch guard: if two switches land within 120ms, the second snaps
// straight to a clean static slot without animation. Prevents queueing /
// visual chop during spam-clicks.
//
// Duration model:
//   - Fixed numeric (220, 260, 320): both layers animate together for that
//     duration. overlapMs == outMs == inMs.
//   - 'staggered': out 280ms, in 360ms, 100ms overlap → in starts at
//     (outMs - overlapMs) = 180ms, total = 540ms.

import { useEffect, useRef, useState } from 'react';

const QUICK_SWITCH_MS = 120;

export function resolveSwapDurations(slideDuration) {
  if (slideDuration === 'staggered') {
    return { outMs: 280, inMs: 360, overlapMs: 100, totalMs: 540 };
  }
  const ms = Number(slideDuration);
  const fallback = Number.isFinite(ms) && ms >= 80 && ms <= 800 ? ms : 260;
  return { outMs: fallback, inMs: fallback, overlapMs: fallback, totalMs: fallback };
}

const EMPTY_SLOTS = { A: null, B: null };

function initialSlots(moduleId) {
  if (!moduleId) return EMPTY_SLOTS;
  return { A: { moduleId, role: 'static' }, B: null };
}

export function useSidebarSwap({ activeModuleId, slideDuration = 260 }) {
  const [slots, setSlots] = useState(() => initialSlots(activeModuleId));
  const previousActive = useRef(activeModuleId);
  const lastSwitchRef  = useRef(0);
  const timerRef       = useRef(null);
  const tokenRef       = useRef(0);

  useEffect(() => {
    if (activeModuleId === previousActive.current) return;
    const prev = previousActive.current;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const delta = now - lastSwitchRef.current;
    previousActive.current = activeModuleId;
    lastSwitchRef.current = now;

    // Quick-switch guard — snap straight to clean static slot.
    if (delta < QUICK_SWITCH_MS) {
      clearTimeout(timerRef.current);
      setSlots(initialSlots(activeModuleId));
      tokenRef.current += 1;
      return;
    }

    setSlots(prevSlots => {
      const activeSlotKey =
        prevSlots.A?.moduleId === prev ? 'A' :
        prevSlots.B?.moduleId === prev ? 'B' : null;
      const newActiveKey = activeSlotKey === 'A' ? 'B' : 'A';
      const next = { ...prevSlots };
      if (activeSlotKey && prevSlots[activeSlotKey]) {
        next[activeSlotKey] = { ...prevSlots[activeSlotKey], role: 'exiting' };
      }
      next[newActiveKey] = activeModuleId
        ? { moduleId: activeModuleId, role: 'entering' }
        : null;
      return next;
    });

    const token = ++tokenRef.current;
    const { totalMs } = resolveSwapDurations(slideDuration);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (tokenRef.current !== token) return;
      setSlots(prev => {
        const next = { ...prev };
        for (const k of ['A', 'B']) {
          if (next[k]?.role === 'exiting') next[k] = null;
          else if (next[k]?.role === 'entering') next[k] = { ...next[k], role: 'static' };
        }
        return next;
      });
    }, totalMs);
  }, [activeModuleId, slideDuration]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const timings = resolveSwapDurations(slideDuration);
  return { slots, ...timings };
}
