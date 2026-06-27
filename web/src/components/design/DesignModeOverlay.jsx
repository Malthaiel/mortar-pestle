// SF5 of Design Mode plan — orchestrates the 4-beat ceremonial mode entry
// + exit, and mounts the Atelier chat surface once entry resolves. Phases:
//
//   t=0     tools pre-fade  (body[data-design-mode="entering"])
//   t=80ms  desaturate(0.7) (filter applied via body[data-design-mode] rule)
//   t=120ms accent sheen sweeps top→bottom over ~160ms
//   t=280ms in-viewport components "wake" with a 60ms staggered glow
//   t=400ms chat window slides in
//
// Exit plays the same phases in reverse over the same total duration.
// Total: ~600ms in, ~600ms out.

import { useEffect, useState, useMemo } from 'react';
import AtelierChatWindow from './AtelierChatWindow.jsx';

const PHASE_DELAYS_IN  = [0, 80, 120, 280, 400];   // body, desaturate, sheen, wake, chat
const PHASE_DELAYS_OUT = [0, 200, 360, 480, 600];  // chat-out, wake-off, sheen-up, desaturate-off, body-clear

const WAKE_CAP = 12; // limit to N most-in-viewport elements so the glow doesn't smear
const WAKE_STAGGER_MS = 60;

export default function DesignModeOverlay({ settings, setSetting, accent }) {
  const modeOn = !!settings?.agents?.mode;
  const animEnabled = settings?.animations?.['drawer-modal'] !== false;
  const [phase, setPhase] = useState('idle'); // idle | in1..in4 | on | out1..out4

  // Drive the phase machine off the user-facing toggle.
  useEffect(() => {
    if (!animEnabled) {
      // Collapse to instant on/off when motion is disabled.
      setPhase(modeOn ? 'on' : 'idle');
      return;
    }
    if (modeOn && phase === 'idle') {
      const ts = PHASE_DELAYS_IN.map((d, i) => setTimeout(() => {
        setPhase(['in1', 'in2', 'in3', 'in4', 'on'][i]);
      }, d));
      return () => ts.forEach(clearTimeout);
    }
    if (!modeOn && phase !== 'idle' && phase !== 'out1' && phase !== 'out2' && phase !== 'out3' && phase !== 'out4') {
      const ts = PHASE_DELAYS_OUT.map((d, i) => setTimeout(() => {
        if (i === PHASE_DELAYS_OUT.length - 1) setPhase('idle');
        else setPhase(['out1', 'out2', 'out3', 'out4'][i]);
      }, d));
      return () => ts.forEach(clearTimeout);
    }
  }, [modeOn, animEnabled]);  // intentionally not depending on `phase`

  // Reflect phase to the body so CSS can gate the desaturate filter.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    const active = phase !== 'idle' && phase !== 'out4';
    if (active) body.setAttribute('data-design-mode', phase);
    else body.removeAttribute('data-design-mode');
    return () => body.removeAttribute('data-design-mode');
  }, [phase]);

  // Apply the "wake" stagger to in-viewport annotated components.
  useEffect(() => {
    if (phase !== 'in4' && phase !== 'on') return;
    if (!animEnabled) return;
    const all = document.querySelectorAll('[data-aos-component]');
    const inView = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth) {
        inView.push(el);
        if (inView.length >= WAKE_CAP) break;
      }
    }
    inView.forEach((el, i) => {
      el.style.setProperty('--aos-wake-delay', `${i * WAKE_STAGGER_MS}ms`);
      el.classList.add('aos-wake');
    });
    const cleanup = setTimeout(() => {
      inView.forEach((el) => {
        el.classList.remove('aos-wake');
        el.style.removeProperty('--aos-wake-delay');
      });
    }, WAKE_CAP * WAKE_STAGGER_MS + 360);
    return () => {
      clearTimeout(cleanup);
      inView.forEach((el) => {
        el.classList.remove('aos-wake');
        el.style.removeProperty('--aos-wake-delay');
      });
    };
  }, [phase, animEnabled]);

  // Esc toggles Design mode off — restraint per DESIGN.md "Escape closes every modal and drawer."
  // SF8: if a pointer mode is active (markup/edit), the DesignPointer hook's
  // capture-phase Esc handler clears the pointer first and stops propagation,
  // so this bubble-phase handler only runs when pointer mode is already off.
  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !isEditableTarget(e.target)) {
        if (document.body.getAttribute('data-design-pointer')) return;
        e.preventDefault();
        setSetting('agents', { mode: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, setSetting]);

  const showChat = phase === 'in4' || phase === 'on' || phase === 'out1';
  const showSheen = phase === 'in2' || phase === 'in3' || phase === 'out3';

  if (phase === 'idle') return null;

  return (
    <>
      {showSheen && <DesignAccentSweep accent={accent}/>}
      {showChat && (
        <AtelierChatWindow
          settings={settings}
          setSetting={setSetting}
          accent={accent}
          exiting={phase === 'out1'}
        />
      )}
    </>
  );
}

function DesignAccentSweep({ accent }) {
  return (
    <div
      aria-hidden
      data-aos-no-mark
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 1,
        background: accent || 'var(--accent, var(--text))',
        pointerEvents: 'none',
        zIndex: 1200,
      }}
    />
  );
}

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
