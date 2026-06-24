// Block-timer view pieces for the Planner dock: the block click popover, the
// pull-selection confirm bar, and the next-block completion toast. All three
// reuse shared chrome (Popover / Toast / candy buttons) — no new CSS. Entrance
// animations stay INLINE so the Settings anim gates ([style*="name"]) match.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Popover, Toast, OutlinedBtn } from '@host/components/ui/index.js';
import { toHM } from './blockPull.js';

function fmtT(mins, t24) {
  if (mins >= 1440) return t24 ? '24:00' : '12:00 AM';
  if (t24) return toHM(mins);
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

function fmtDur(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function fmtMMSS(secs) {
  const s = Math.max(0, secs);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function nowMinsOf(d = new Date()) { return d.getHours() * 60 + d.getMinutes(); }

function CandyAction({ primary, onClick, children }) {
  return (
    <button
      type="button"
      className={`candy-btn${primary ? ' is-primary' : ''}`}
      data-shape={primary ? 'block' : 'chip'}
      data-own-press
      onClick={onClick}
      style={primary ? { '--cbtn-depth': '5px', height: 24, width: '100%' } : { width: '100%' }}
    >
      <span className="candy-face" style={{ padding: '0 12px', fontSize: 11, width: '100%', justifyContent: 'center' }}>
        {children}
      </span>
    </button>
  );
}

// The click popover. Contextual single surface for every block state:
//   upcoming   → Start now (now→end) · Pull & start… (selection mode)
//   in-window  → Start (remaining only)
//   past       → Pull to now & start (single-block)
//   this block running → Stop
// When another timer is running, a banner shows it and actions run through
// the provider's switch flow (labels gain a "Switch & " prefix via `switchMode`).
export function BlockPopover({
  desc, anchorRect, accent, timeFormat24h,
  switchMode, runningLabel, runningSecsLeft, isRunningBlock,
  onClose, onStart, onPullStart, onEnterPullMode, onStopRun,
}) {
  // Live clock — the span text stays honest while the popover sits open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  if (!desc) return null;
  const nowM = nowMinsOf(now);
  const t24 = timeFormat24h;
  const dur = desc.endMins - desc.startMins;
  const state = isRunningBlock ? 'running'
    : nowM >= desc.endMins ? 'past'
      : nowM >= desc.startMins ? 'inWindow' : 'upcoming';

  const W = 248;
  const left = Math.max(8, (anchorRect?.left ?? 120) - W - 10);
  const top = Math.max(8, Math.min(anchorRect?.top ?? 120, window.innerHeight - 240));

  const kindHint = desc.ref.kind === 'frame' ? 'frame block' : desc.ref.kind === 'plan' ? 'plan block' : 'session';
  const sw = switchMode && state !== 'running';

  let spanLine, actions;
  if (state === 'running') {
    spanLine = `Running — ${fmtMMSS(runningSecsLeft)} left`;
    actions = <CandyAction primary onClick={() => { onClose(); onStopRun(); }}>STOP BLOCK TIMER</CandyAction>;
  } else if (state === 'upcoming') {
    const lead = desc.startMins - nowM;
    spanLine = `Starts in ${fmtDur(lead)} — timer now → ${fmtT(desc.endMins, t24)} (${fmtDur(desc.endMins - nowM)})`;
    actions = (
      <>
        <CandyAction primary onClick={() => { onClose(); onStart(desc); }}>
          {sw ? 'SWITCH & START NOW' : 'START NOW'}
        </CandyAction>
        {!desc.wrapSegment && (
          <CandyAction onClick={() => { onClose(); onEnterPullMode(desc); }}>
            {sw ? 'Switch & pull to now…' : 'Pull to now…'}
          </CandyAction>
        )}
      </>
    );
  } else if (state === 'inWindow') {
    spanLine = `In progress — ${fmtDur(desc.endMins - nowM)} left (until ${fmtT(desc.endMins, t24)})`;
    actions = (
      <CandyAction primary onClick={() => { onClose(); onStart(desc); }}>
        {sw ? 'SWITCH & START' : 'START'}
      </CandyAction>
    );
  } else {
    spanLine = `Ended at ${fmtT(desc.endMins, t24)}`;
    actions = desc.wrapSegment
      ? <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Midnight-crossing blocks can’t be pulled.</div>
      : (
        <CandyAction primary onClick={() => { onClose(); onPullStart(desc); }}>
          {sw ? 'SWITCH & PULL TO NOW' : 'PULL TO NOW & START'}
        </CandyAction>
      );
  }

  return (
    <Popover
      open
      onClose={onClose}
      title={desc.label}
      accent={accent}
      ariaLabel={`Block timer: ${desc.label}`}
      style={{
        position: 'fixed', left, top, width: W, zIndex: 95,
        animation: 'notifPanelIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
      bodyStyle={{ padding: '10px 14px 12px' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', letterSpacing: '0.03em' }}>
          {fmtT(desc.startMins, t24)}–{fmtT(desc.endMins, t24)} · {fmtDur(dur)} · {kindHint}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.4 }}>{spanLine}</div>
        {sw && (
          <div style={{
            fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4,
            padding: '5px 8px', borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in oklch, var(--accent) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--accent) 25%, var(--border))',
          }}>
            Running: {runningLabel} · {fmtMMSS(runningSecsLeft)} left
          </div>
        )}
        <div className="candy-stack" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
          {actions}
        </div>
      </div>
    </Popover>
  );
}

// Sticky confirm strip for pull-selection mode — rendered as the last child of
// the dock calendar's scroll body so it pins to the visible bottom edge.
export function PullConfirmBar({ count, onConfirm, onCancel }) {
  return (
    <div
      data-no-drag
      style={{
        position: 'sticky', bottom: 0, zIndex: 45,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        padding: '8px 10px calc(var(--candy-depth-small, 5px) + 8px)',
        background: 'color-mix(in oklch, var(--surface) 90%, transparent)',
        backdropFilter: 'blur(4px)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <button type="button" className="candy-btn is-primary" data-shape="block" data-own-press
        onClick={onConfirm} style={{ '--cbtn-depth': '5px', height: 24 }}>
        <span className="candy-face" style={{ padding: '0 12px', fontSize: 11 }}>
          PULL {count} TO NOW
        </span>
      </button>
      <button type="button" className="candy-btn" data-shape="chip" data-own-press onClick={onCancel}>
        <span className="candy-face">Cancel</span>
      </button>
    </div>
  );
}

// Completion prompt — provider-rendered so it survives dock collapse. Sits
// just under TransientToastLayer's stack (zIndex 99 vs 100); collisions are
// rare and acceptable. The shared Toast's inline spring-in keeps the
// Settings animation gate working.
export function NextBlockToast({ accent, prompt, onAction, onDismiss }) {
  useEffect(() => {
    if (!prompt) return undefined;
    const t = setTimeout(() => onDismiss?.(), 12_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

  if (!prompt) return null;
  return createPortal(
    <div style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 99, pointerEvents: 'none' }}>
      <Toast
        accent={accent}
        glyph="▶"
        title="Block complete"
        message={`Up next: ${prompt.label}`}
        actions={(
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
            <OutlinedBtn small onClick={onAction}>Start</OutlinedBtn>
            <OutlinedBtn small onClick={onDismiss}>Later</OutlinedBtn>
          </div>
        )}
      />
    </div>,
    document.body,
  );
}
