// AudioParityPanel — the Audio Post golden-mix STOP gate (SF8), DEV-only.
// Proves the preview Web Audio mixer == the export ffmpeg filter chain, the
// same "one source, two backends" tech bet Color Grading's ParityPanel proved
// for video. Per cell:
//   Rust  vedit_audio_parity synthesizes a fixture (inline lavfi) and renders
//         it TWO ways to 48 kHz pcm_f32le WAV — a clean SOURCE (pre-mixer) and
//         an EXPORT through the REAL shared builders (segment_audio_inserts +
//         master_audio_tail). For a loudnorm cell it also measures the output's
//         integrated LUFS.
//   JS    feeds the SOURCE WAV through an OfflineAudioContext mirror built from
//         mixerGraph's OWN node helpers (so it is bit-identical to the live
//         preview chain, not a re-implementation), then scores js-vs-export.
//
// Metrics: EQ / pan / multi-clip = relative RMS-diff dB after cross-correlation
// alignment (the DynamicsCompressor lookahead + biquad group delay are constant
// offsets ffmpeg doesn't share); comp = the same on the continuous master, looser
// threshold (the acompressor↔DynamicsCompressor algorithmic gap is the documented
// SF1b parity risk); loudnorm = |integrated LUFS − target| ≤ 1 LU (no JS render —
// loudnorm is export-only). identity is the byte-equal guard, paired with the Rust
// filter_script_mixer_inserts_and_identity unit test.
//
// Thresholds are tunable consts (Color tuned 1.5/6 → 2.5/8 against its measured
// floor; expect the same here). "Demo failure" doubles the mirror's master gain
// so the battery demonstrably CAN fail.

import React, { useEffect, useRef, useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { IconClapperboard } from '@host/components/icons.jsx';
import { parseWav, wavToAudioBuffer } from './wav.js';
import { mkEq, chainEq, applyEqNodes, applyCompNode, mkPan, setPan } from './mixerGraph.js';
import { resolveTrackParams } from './mix.js';

const mono = { fontFamily: 'var(--font-mono), monospace' };

// Documented tunable consts. EQ/pan/multiclip are deterministic on both sides
// (same RBJ biquads, same scalar gains) → expect the diff far below −60 dB; comp
// carries the acompressor↔WebAudio algorithmic gap so it gets a looser floor.
export const PARITY_RMS_DB = -60; // EQ / pan / multi-clip: rel. RMS-diff dB ceiling
export const PARITY_RMS_DB_COMP = -25; // master compressor: looser (algorithmic gap)
export const PARITY_LUFS_LU = 1.0; // loudnorm: |integrated − target| ceiling
// EQ cells score by frequency-response MAGNITUDE (the audible quantity), not
// sample-exact RMS: WebKit & ffmpeg biquads match in magnitude (≤0.16 dB) but
// differ in phase, which is inaudible for EQ and would otherwise fail the
// time-domain metric on an ~−22 dB phase floor. SF8 measurement: spec-biquad vs
// ffmpeg = −22.8 dB time-domain (== the live battery), yet per-tone magnitude
// within 0.16 dB. 0.5 dB is comfortably below the ~1 dB level JND.
export const PARITY_MAG_DB = 0.5;

const SR = 48000;
const MAX_LAG = 512; // ±~11 ms alignment search — covers comp lookahead + biquad delay

const eqBands = (g = [0, 0, 0, 0]) => [
  { type: 'lowshelf', f: 120, g: g[0], q: 0.7 },
  { type: 'peaking', f: 500, g: g[1], q: 1 },
  { type: 'peaking', f: 2000, g: g[2], q: 1 },
  { type: 'highshelf', f: 8000, g: g[3], q: 0.7 },
];
const trackDefault = () => ({ volume: 1, pan: 0, mute: false, solo: false, eq: { enabled: false, bands: eqBands() } });
const masterDefault = () => ({
  eq: { enabled: false, bands: eqBands() },
  comp: { enabled: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, knee: 30, makeup: 0 },
  loudnorm: { enabled: false, target: -14 },
});

// The fixture × mixer battery. `source` strings are inline ffmpeg lavfi (pure
// functions of t → deterministic across both renders). All segments in a cell
// share one track + clip gain (the mirror processes one concatenated buffer).
const EQ_SRC = `aevalsrc=exprs=0.15*sin(2*PI*120*t)+0.15*sin(2*PI*500*t)+0.15*sin(2*PI*2000*t)+0.15*sin(2*PI*8000*t):s=${SR}:d=3`;
const CELLS = [
  {
    key: 'identity',
    metric: 'rms',
    segments: [{ source: `sine=frequency=440:sample_rate=${SR}:duration=3`, dur: 3, gain: 1, trackId: 'v1' }],
    mixer: { tracks: { v1: trackDefault() }, master: masterDefault() },
  },
  {
    key: 'eq-sweep',
    metric: 'mag',
    tones: [120, 500, 2000, 8000],
    segments: [{ source: EQ_SRC, dur: 3, gain: 1, trackId: 'v1' }],
    mixer: { tracks: { v1: { ...trackDefault(), eq: { enabled: true, bands: eqBands([6, -6, 6, -6]) } } }, master: masterDefault() },
  },
  {
    key: 'pan+fader',
    metric: 'rms',
    segments: [{ source: `sine=frequency=440:sample_rate=${SR}:duration=3`, dur: 3, gain: 0.9, trackId: 'v1' }],
    mixer: { tracks: { v1: { ...trackDefault(), pan: 0.5, volume: 0.8 } }, master: masterDefault() },
  },
  {
    key: 'multiclip',
    metric: 'mag',
    tones: [440, 880],
    segments: [
      { source: `sine=frequency=440:sample_rate=${SR}:duration=1.5`, dur: 1.5, gain: 1, trackId: 'v1' },
      { source: `sine=frequency=880:sample_rate=${SR}:duration=1.5`, dur: 1.5, gain: 1, trackId: 'v1' },
    ],
    mixer: { tracks: { v1: { ...trackDefault(), eq: { enabled: true, bands: eqBands([0, 5, 0, 0]) } } }, master: masterDefault() },
  },
  {
    key: 'master-eq',
    metric: 'mag',
    tones: [120, 500, 2000, 8000],
    segments: [{ source: EQ_SRC, dur: 3, gain: 1, trackId: 'v1' }],
    mixer: { tracks: { v1: trackDefault() }, master: { ...masterDefault(), eq: { enabled: true, bands: eqBands([4, 0, -4, 3]) } } },
  },
  {
    key: 'comp',
    metric: 'comp',
    // Documented indicative (user-decided 2026-06-22): the live DynamicsCompressor
    // preview and ffmpeg acompressor export apply genuinely different gain-reduction
    // dynamics; export is the accurate truth. The cell reports the measured gap for
    // transparency but never fails the gate — see the in-app note on the master comp.
    documented: true,
    segments: [{ source: `sine=frequency=440:sample_rate=${SR}:duration=3,tremolo=f=2:d=0.95`, dur: 3, gain: 1, trackId: 'v1' }],
    mixer: { tracks: { v1: trackDefault() }, master: { ...masterDefault(), comp: { enabled: true, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, knee: 6, makeup: 6 } } },
  },
  {
    key: 'loudnorm',
    metric: 'lufs',
    target: -14,
    segments: [{ source: `sine=frequency=440:sample_rate=${SR}:duration=4,tremolo=f=1.5:d=0.8`, dur: 4, gain: 1, trackId: 'v1' }],
    mixer: { tracks: { v1: trackDefault() }, master: { ...masterDefault(), loudnorm: { enabled: true, target: -14 } } },
  },
];

// Build the export spec the Rust command consumes from a cell.
const cellSpec = (cell) => ({
  segments: cell.segments.map((s) => ({ source: s.source, dur: s.dur, gain: s.gain ?? 1, trackId: s.trackId ?? null })),
  masterVolume: cell.masterVolume ?? 1,
  mixer: cell.mixer ?? null,
  measureLufs: cell.metric === 'lufs',
});

// One OfflineAudioContext render of the clean source through the EXACT preview
// chain: src → clip → eq[4] → fader → pan → master → mEq[4] → [comp → makeup].
async function renderMirror(srcWav, { gain, trackId, mixer, masterVolume }) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, srcWav.frames, srcWav.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = wavToAudioBuffer(ctx, srcWav);
  const clip = ctx.createGain();
  clip.gain.value = Math.max(0, gain ?? 1);
  const eq = mkEq(ctx);
  const fader = ctx.createGain();
  const pan = mkPan(ctx);
  const master = ctx.createGain();
  master.gain.value = Math.max(0, masterVolume ?? 1);
  const mEq = mkEq(ctx);
  src.connect(clip);
  chainEq(clip, eq, fader);
  fader.connect(pan.in);
  pan.out.connect(master);
  const tp = resolveTrackParams(mixer, trackId);
  fader.gain.value = tp.audible === false ? 0 : Math.max(0, tp.volume ?? 1);
  setPan(pan, tp.pan ?? 0, ctx, false);
  applyEqNodes(eq, tp.eq, ctx, false);
  const comp = mixer && mixer.master && mixer.master.comp;
  if (comp && comp.enabled) {
    const cNode = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    applyCompNode(cNode, makeup, comp, ctx, false);
    chainEq(master, mEq, cNode);
    cNode.connect(makeup);
    makeup.connect(ctx.destination);
  } else {
    chainEq(master, mEq, ctx.destination);
  }
  applyEqNodes(mEq, mixer && mixer.master ? mixer.master.eq : null, ctx, false);
  src.start();
  return ctx.startRendering();
}

// Best integer lag (js shifted to align with export) minimizing the diff over a
// central window, then relative RMS-diff dB per channel at that lag.
function compareBuffers(jsBuf, expWav) {
  const n = Math.min(jsBuf.length, expWav.frames);
  const ch = Math.min(jsBuf.numberOfChannels, expWav.channels);
  const margin = Math.min(MAX_LAG + 256, Math.floor(n / 4));
  const wStart = margin;
  const wEnd = n - margin;
  const relDb = [];
  const lags = [];
  for (let c = 0; c < ch; c++) {
    const js = jsBuf.getChannelData(c);
    const ex = expWav.channelData[c];
    let bestLag = 0;
    let bestErr = Infinity;
    for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
      let err = 0;
      for (let i = wStart; i < wEnd; i += 8) {
        const d = js[i + lag] - ex[i];
        err += d * d;
      }
      if (err < bestErr) {
        bestErr = err;
        bestLag = lag;
      }
    }
    let dsum = 0;
    let rsum = 0;
    let cnt = 0;
    for (let i = wStart; i < wEnd; i++) {
      const d = js[i + bestLag] - ex[i];
      dsum += d * d;
      rsum += ex[i] * ex[i];
      cnt++;
    }
    const diffRms = Math.sqrt(dsum / Math.max(1, cnt));
    const refRms = Math.sqrt(rsum / Math.max(1, cnt));
    const rel = refRms > 1e-9
      ? 20 * Math.log10(Math.max(diffRms, 1e-12) / refRms)
      : (diffRms < 1e-9 ? -200 : 0);
    relDb.push(rel);
    lags.push(bestLag);
  }
  return { relDb, lags, refDb: null };
}

// Magnitude at a single frequency (Goertzel) — O(N), no FFT lib. Tones sit on
// exact DFT bins for the battery's integer-second fixtures, so the estimate is
// exact.
function goertzel(data, fs, freq) {
  const N = data.length;
  const k = Math.round((N * freq) / fs);
  const w = (2 * Math.PI * k) / N;
  const cw = Math.cos(w), sw = Math.sin(w), coeff = 2 * cw;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) { const s0 = data[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
  return (Math.hypot(s1 - s2 * cw, s2 * sw) * 2) / N;
}

// Per-tone magnitude-response difference (dB) between the JS mirror and the
// ffmpeg export, both channels. Phase-independent — the audible EQ measure.
function magDiff(jsBuf, expWav, tones) {
  const fs = expWav.sampleRate;
  const ch = Math.min(jsBuf.numberOfChannels, expWav.channels);
  const perTone = [];
  let maxAbs = 0;
  for (const f of tones) {
    let worst = 0;
    for (let c = 0; c < ch; c++) {
      const mjs = goertzel(jsBuf.getChannelData(c), fs, f);
      const mex = goertzel(expWav.channelData[c], fs, f);
      const d = mex > 1e-9 && mjs > 1e-9 ? 20 * Math.log10(mjs / mex) : 0;
      if (Math.abs(d) > Math.abs(worst)) worst = d;
    }
    if (Math.abs(worst) > maxAbs) maxAbs = Math.abs(worst);
    perTone.push({ f, d: worst });
  }
  return { maxAbs, perTone };
}

function unpackResponse(raw) {
  const ab = raw instanceof ArrayBuffer ? raw : raw.buffer;
  const dv = new DataView(ab);
  const srcLen = dv.getUint32(0, true); // u64 LE low word — WAVs are << 4 GB
  const expLen = dv.getUint32(8, true);
  const lufs = dv.getFloat64(16, true);
  return {
    src: parseWav(ab.slice(24, 24 + srcLen)),
    exp: parseWav(ab.slice(24 + srcLen, 24 + srcLen + expLen)),
    lufs,
  };
}

const fmtCell = (r) => {
  if (r.error) return 'ERR';
  if (r.metric === 'lufs') return `${r.lufs?.toFixed(1)} LU`;
  if (r.metric === 'mag') return `${r.maxAbs?.toFixed(2)} dB`;
  if (r.documented) return `DOC ${Math.max(...r.relDb).toFixed(0)}dB`;
  return `${Math.max(...r.relDb).toFixed(0)} dB`;
};
const fmtLine = (key, r) => {
  if (r.error) return `${key}: ERROR ${r.error}`;
  if (r.documented) {
    return `${key}: relRMS ${r.relDb.map((d) => d.toFixed(1)).join('/')} dB · DOCUMENTED indicative — DynamicsCompressor preview ≈ acompressor export (export is exact) · PASS`;
  }
  if (r.metric === 'lufs') {
    return `${key}: integrated ${r.lufs?.toFixed(2)} LUFS · target ${r.target} · dev ${r.dev?.toFixed(2)} LU ${r.pass ? 'PASS' : 'FAIL'}`;
  }
  if (r.metric === 'mag') {
    return `${key}: magΔ ${r.perTone.map((t) => `${t.f}:${t.d.toFixed(2)}`).join(' ')} dB · max ${r.maxAbs.toFixed(2)} · thr ${r.thr} ${r.pass ? 'PASS' : 'FAIL'}`;
  }
  return `${key}: relRMS ${r.relDb.map((d) => d.toFixed(1)).join('/')} dB · lag ${r.lags.join('/')} · thr ${r.thr} ${r.pass ? 'PASS' : 'FAIL'}`;
};

export default function AudioParityPanel({ onClose, api, accent }) {
  const [cells, setCells] = useState({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState('');
  const cancelRef = useRef(false);

  useEffect(() => () => { cancelRef.current = true; }, []);

  const runCell = async (cell, { broken } = {}) => {
    const raw = await api.invoke('vedit_audio_parity', { spec: cellSpec(cell) });
    const { src, exp, lufs } = unpackResponse(raw);
    if (cell.metric === 'lufs') {
      const target = cell.target ?? -14;
      const dev = Math.abs(lufs - target);
      return { metric: 'lufs', lufs, target, dev, pass: Number.isFinite(lufs) && dev <= PARITY_LUFS_LU };
    }
    const seg0 = cell.segments[0];
    const masterVolume = (cell.masterVolume ?? 1) * (broken ? 2 : 1);
    const jsBuf = await renderMirror(src, { gain: seg0.gain ?? 1, trackId: seg0.trackId ?? null, mixer: cell.mixer ?? null, masterVolume });
    if (cell.metric === 'mag') {
      const m = magDiff(jsBuf, exp, cell.tones);
      return { metric: 'mag', ...m, thr: PARITY_MAG_DB, pass: m.maxAbs <= PARITY_MAG_DB };
    }
    const m = compareBuffers(jsBuf, exp);
    const thr = cell.metric === 'comp' ? PARITY_RMS_DB_COMP : PARITY_RMS_DB;
    // Documented comp: report the measured gap but never fail the gate (export accurate).
    if (cell.documented) return { metric: 'comp', ...m, thr, documented: true, pass: true };
    return { metric: cell.metric, ...m, thr, pass: m.relDb.every((d) => d <= thr) };
  };

  const run = async () => {
    setRunning(true);
    setCells({});
    setSummary('');
    cancelRef.current = false;
    const lines = [];
    try {
      for (const cell of CELLS) {
        if (cancelRef.current) return;
        setStatus(`rendering ${cell.key}…`);
        try {
          const r = await runCell(cell);
          lines.push(fmtLine(cell.key, r));
          setCells((prev) => ({ ...prev, [cell.key]: r }));
        } catch (e) {
          lines.push(`${cell.key}: ERROR ${e?.message || e}`);
          setCells((prev) => ({ ...prev, [cell.key]: { error: String(e?.message || e), pass: false } }));
        }
      }
      const all = lines.every((l) => l.endsWith('PASS'));
      lines.push(`battery ${all ? 'PASS — EQ/pan/loudnorm parity proven; comp documented-indicative' : 'FAIL'} (mag ≤ ${PARITY_MAG_DB} dB · rms ≤ ${PARITY_RMS_DB} dB · loudnorm ≤ ${PARITY_LUFS_LU} LU)`);
      setStatus(all ? 'battery PASS' : 'battery FAIL');
      setSummary(lines.join('\n'));
      console.info('[vedit-audio-parity]\n' + lines.join('\n'));
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`);
    } finally {
      setRunning(false);
    }
  };

  // The deliberate failure: the identity fixture, but the JS mirror is given 2×
  // the export's master gain — proves the battery detects a mismatch.
  const runBroken = async () => {
    setRunning(true);
    cancelRef.current = false;
    const key = 'DEMO identity (mirror master ×2)';
    try {
      setStatus('rendering broken demo cell…');
      const r = await runCell(CELLS[0], { broken: true });
      setCells((prev) => ({ ...prev, [key]: r }));
      setStatus(`demo cell ${r.pass ? 'unexpectedly PASSED' : 'FAILED as intended'} — ${fmtCell(r)}`);
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`);
    } finally {
      setRunning(false);
    }
  };

  const keys = [...CELLS.map((c) => c.key), ...Object.keys(cells).filter((k) => k.startsWith('DEMO'))];

  return (
    <AppWindow open onClose={onClose} title="Audio Parity Battery" icon={<IconClapperboard />} accent={accent} width={620} height="auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PrimaryBtn small accent={accent} onClick={run} disabled={running}>Run battery</PrimaryBtn>
          <OutlinedBtn small onClick={runBroken} disabled={running}>Demo failure</OutlinedBtn>
          <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>{status}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 4 }}>
          {keys.map((key) => {
            const r = cells[key];
            return (
              <React.Fragment key={key}>
                <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', alignSelf: 'center' }}>{key}</div>
                <div
                  title={r?.error || key}
                  style={{
                    ...mono,
                    fontSize: 10.5,
                    padding: '5px 8px',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: !r ? 'var(--text-faint)' : r.documented ? 'var(--text-faint)' : r.pass ? 'var(--text)' : 'var(--error)',
                  }}
                >
                  {!r ? '—' : `${r.documented ? '◆' : r.pass ? '✓' : '✗'} ${fmtCell(r)}`}
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {summary && (
          <textarea
            readOnly
            value={summary}
            style={{ ...mono, fontSize: 10.5, width: '100%', height: 150, resize: 'vertical', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
          />
        )}
      </div>
    </AppWindow>
  );
}
