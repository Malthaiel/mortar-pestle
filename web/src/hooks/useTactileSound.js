// Tactile thock — size-aware synthesized click sound for button presses.
// Uses WebAudio API to generate a short filtered-noise burst.
// Pitch scales inversely with button size: larger buttons = lower pitch.
//
// Each play function self-gates against settings.sounds[key]. Pass
// { force: true } to bypass the gate — used by the Sounds tab's ▶ audition
// buttons so users can preview a sound that's currently muted.

import { useEffect } from 'react';

let audioCtx = null;

function soundEnabled(key) {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    return (raw.sounds || {})[key] === true;
  } catch {
    return false;
  }
}

function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function sizeToFreq(size) {
  // 24px → ~820Hz, 200px → ~280Hz
  return Math.max(220, Math.min(900, 880 - size * 3));
}

export function playTactileThock(el, opts = {}) {
  if (!opts.force && !soundEnabled('tactile-button-thock')) return;
  try {
    const ctx = getCtx();
    const r = el?.getBoundingClientRect?.() || { width: 40, height: 32 };
    const size = Math.max(r.width, r.height);
    const freq = sizeToFreq(size);

    // Duration: 50-65ms based on size (larger = slightly longer)
    const dur = 0.045 + (size / 2000);

    // Buffer of white noise
    const sampleRate = ctx.sampleRate;
    const bufferSize = Math.floor(sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // Lowpass filter tuned to size frequency
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq;
    filter.Q.value = 0.7;

    // Gain envelope: quick attack, exponential decay
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    noise.start(now);
    noise.stop(now + dur + 0.01);
  } catch {
    // Silently fail if WebAudio is unavailable
  }
}

// Lifts a pill off the rail. Lower, rounder thock — picking up a polished pebble.
export function playReorderPickup(opts = {}) {
  if (!opts.force && !soundEnabled('reorder-pickup-thock')) return;
  playFilteredBurst({ freq: 280, q: 1.2, peakGain: 0.14, dur: 0.085 });
}

// Sets a pill into its new slot. Crisper, slightly higher tap.
export function playReorderDrop(opts = {}) {
  if (!opts.force && !soundEnabled('reorder-drop-thock')) return;
  playFilteredBurst({ freq: 520, q: 0.9, peakGain: 0.11, dur: 0.06 });
}

function playFilteredBurst({ freq, q, peakGain, dur }) {
  try {
    const ctx = getCtx();
    const sampleRate = ctx.sampleRate;
    const bufferSize = Math.floor(sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq;
    filter.Q.value = q;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    noise.start(now);
    noise.stop(now + dur + 0.01);
  } catch {}
}

// Two-note celebration chime — today's last open task checked off in the
// Planner (paired with the app:confetti burst). Rides the tactile key rather
// than its own Sounds row: a once-a-day flourish doesn't earn surface.
export function playCelebrationChime(opts = {}) {
  if (!opts.force && !soundEnabled('tactile-button-thock')) return;
  try {
    const ctx = getCtx();
    const now = ctx.currentTime;
    [[659.25, 0], [880, 0.11]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const t = now + at;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.09, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  } catch {
    // Silently fail if WebAudio is unavailable
  }
}

// Back-compat shim — some callers still ask. Maps to the new tactile key.
export function uiSoundsEnabled() {
  return soundEnabled('tactile-button-thock');
}

export function useGlobalTactileSound() {
  useEffect(() => {
    const onPointerDown = (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      if (target.disabled || target.hasAttribute('data-no-tactile')) return;
      // playTactileThock self-gates against settings.sounds['tactile-button-thock'].
      playTactileThock(target);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);
}

// Candy button full-press on click — sibling to useGlobalTactileSound.
// The .candy-face 150ms ease-out transition (styles.css) means :active alone
// releases at mouseup before the press reaches full depth — a quick click only
// partial-presses, you have to hold to see the full press. Setting
// data-candy-pressed past mouseup holds the computed transform at
// translateY(--cbtn-depth) through the release, so the in-flight 150ms ease-down
// completes to full depth; the attribute drops at 150ms to ease back up. The
// press is attribute-driven, NOT hover-driven, so the full down+up animation
// plays to completion even if the user moves the pointer off the button
// mid-animation (it releases only on pointerup / the 150ms timer / pointercancel
// — never on hover-leave). CSS matches :is(:active, .is-pressed, [data-candy-pressed])
// (styles.css). The signal is a data ATTRIBUTE, not a class: React rewrites
// className from JSX on every re-render of a candy-btn that toggles is-active
// (tree rows, dock, tabs, sidebar nav, etc.), stripping an imperatively-added
// class mid-press — but React leaves a data attribute alone because no candy
// component authors it. This hook only manages the attribute timing and mirrors
// the seg-option / music-tile / anim-off / self-managed suppressions so
// non-pressing shapes still don't press.
let active = null;
const MIN_HOLD_MS = 150;   // match .candy-face transition (styles.css)

function releasePressHold() {
  if (!active) return;
  const { el, timer } = active;
  clearTimeout(timer);
  el.removeAttribute('data-candy-pressed');
  window.removeEventListener('pointerup', onHoldUp, true);
  window.removeEventListener('pointercancel', onHoldCancel, true);
  active = null;
}
function onHoldUp() {
  if (!active) return;
  active.stillDown = false;
  if (!active.timer) releasePressHold(); // held ≥150ms → ease up now
  // else fast click → the timer releases at 150ms; the full down+up animation
  // plays to completion regardless of where the pointer then goes.
}
function onHoldCancel() { releasePressHold(); }
function onHoldTimer() {
  if (!active) return;
  active.timer = null;
  if (!active.stillDown) releasePressHold(); // pointer already up → release (face at full depth)
  // else still held → wait for pointerup
}

function onCandyPressDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;             // primary click only
  const candy = e.target.closest('.candy-btn');
  if (!candy || candy.disabled) return;
  if (candy.matches('[data-shape="seg-option"]')) return;             // never presses (would slip out of the tray clip)
  if (e.target.closest('.planner-ring-button, .aos-chat-window')) return; // these self-manage is-pressed
  if (candy.matches('.music-tile')) {                                 // mirror the :has(...) gate (styles.css)
    const nested = e.target.closest('button, .music-tile-cover, .music-tile-scrub, .planner-ring-button, [data-no-drag]');
    if (nested && nested !== candy) return;                           // a nested control owns its own press
  }
  releasePressHold();                                                 // cancel any overlapping press (rapid clicks)
  candy.setAttribute('data-candy-pressed', '');
  active = { el: candy, timer: setTimeout(onHoldTimer, MIN_HOLD_MS), stillDown: true };
  window.addEventListener('pointerup', onHoldUp, true);
  window.addEventListener('pointercancel', onHoldCancel, true);
}

export function useGlobalCandyPressHold() {
  useEffect(() => {
    window.addEventListener('pointerdown', onCandyPressDown, true);
    return () => {
      window.removeEventListener('pointerdown', onCandyPressDown, true);
      releasePressHold();
    };
  }, []);
}
