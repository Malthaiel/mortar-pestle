// GPU & Codec Spike panel — dev-only (lives in the DEV-gated DevTab chunk).
// Measures the plan-A display path for the Video Editor's GPU-dependent phases:
// per-rAF video texture upload + 33³ 3D-LUT shader on an onscreen WebGL2 canvas,
// judged against the locked "60fps UI standard" (rAF p95 ≤ 16.7 ms AND <5%
// frames over 17.5 ms across a 30 s run, at 1080p30 AND 4K24). Plus WebCodecs
// decode microbench + env/dual-GPU probe. "Full battery" runs every cell and
// persists markdown to Infrastructure/.cache/gpu_spike_results.md (content
// vault) so results survive the session and are readable from outside the app.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Seg, PrimaryBtn, OutlinedBtn } from '../ui/index.js';
import { awaitMediaBaseUrl, mediaHttpUrl, invoke } from '../../api.js';
import {
  probeGL, looksSoftware, summarize, fmt,
  createBenchPipeline, createFenceTracker,
  webCodecsSupport, webCodecsDecodeBench, MAX_LAYERS,
} from './gpuSpikeLib.js';

const FIXTURES = {
  '1080p30': {
    id: '1080p30', label: '1080p30',
    rel: 'Studio/Spike Fixtures/spike-1080p30.mp4',
    es: 'Studio/Spike Fixtures/spike-1080p30.h264',
    codec: 'avc1.640028', width: 1920, height: 1080, fps: 30,
  },
  '4k24': {
    id: '4k24', label: '4K24',
    rel: 'Studio/Spike Fixtures/spike-4k24.mp4',
    es: 'Studio/Spike Fixtures/spike-4k24.h264',
    codec: 'avc1.640033', width: 3840, height: 2160, fps: 24,
  },
};
const BUDGET_MS = 17.5;   // rAF delta counts as over-budget above this
const PASS_P95 = 16.7;    // locked verdict thresholds (60fps UI standard)
const PASS_OVER_PCT = 5;
const RESULTS_VAULT_PATH = 'Infrastructure/.cache/gpu_spike_results.md';
const MODES = ['baseline', 'draw-only', 'upload', 'upload+LUT'];
const mono = { fontFamily: 'var(--font-mono)', fontSize: 11 };
// Compositor spike (Compositing & Titles SF1). Sibling results file so the
// historical single-layer GPU & Codec Spike record is never overwritten.
const COMPOSITE_BUDGET_MS = 33.3;   // 30 fps preview gate
const COMPOSITE_OPACITY = 0.85;     // straight alpha → real SRC_ALPHA blend
const COMPOSITE_RESULTS_PATH = 'Infrastructure/.cache/gpu_composite_spike_results.md';

function SectionLabel({ children, style }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
      textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
      margin: '20px 0 10px', ...style,
    }}>{children}</div>
  );
}

function Chip({ ok, children }) {
  return (
    <span style={{
      ...mono, fontWeight: 700, padding: '1px 7px', borderRadius: 99,
      background: ok ? 'rgba(80,200,120,0.18)' : 'rgba(230,80,80,0.18)',
      color: ok ? '#4fc878' : '#e66',
    }}>{children}</span>
  );
}

export default function GpuSpikePanel({ accent }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const pipelineRef = useRef(null);
  const stopRef = useRef(false);
  const rafIdRef = useRef(0);
  const progressRef = useRef(null);
  const wcBitmapRef = useRef(null);
  const resultsRef = useRef([]);
  const wcRef = useRef({ support: [], rows: [] });

  const [ready, setReady] = useState(false);
  const [env, setEnv] = useState(null);
  const [fixStatus, setFixStatus] = useState({});
  const [fxKey, setFxKey] = useState('1080p30');
  const [mode, setMode] = useState('upload+LUT');
  const [cadence, setCadence] = useState('raf');
  const [durSec, setDurSec] = useState(30);
  const [capMode, setCapMode] = useState('native');
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState([]);
  const [wcSupport, setWcSupport] = useState([]);
  const [wcRows, setWcRows] = useState([]);
  const [persistNote, setPersistNote] = useState('');
  const [layers, setLayers] = useState(3);
  const [compRows, setCompRows] = useState([]);
  const compResultsRef = useRef([]);
  const envRef = useRef(null);
  useEffect(() => { envRef.current = env; }, [env]);

  // ---- environment basics + media-server priming + fixture HEAD checks ----
  // GL probes are NOT auto-run: first-ever WebGL context creation is a crash
  // candidate on this NVIDIA/EGL stack (see main.rs comments), so they run
  // behind explicit buttons (bisectable) or lazily on the first bench run.
  useEffect(() => {
    setEnv({
      webgpu: 'gpu' in navigator,
      videoDecoder: 'VideoDecoder' in window,
      dpr: window.devicePixelRatio,
      ua: navigator.userAgent,
    });
    let alive = true;
    (async () => {
      await awaitMediaBaseUrl();
      if (!alive) return;
      setReady(true);
      const st = {};
      for (const k of Object.keys(FIXTURES)) {
        for (const which of ['rel', 'es']) {
          const url = mediaHttpUrl(FIXTURES[k][which], { library: true });
          try {
            const r = await fetch(url, { method: 'HEAD' });
            st[`${k}.${which}`] = r.status;
          } catch (e) {
            st[`${k}.${which}`] = 'ERR:' + String(e?.message || e).slice(0, 50);
          }
        }
      }
      if (alive) setFixStatus(st);
    })();
    return () => {
      alive = false;
      // Do NOT cancel the rAF here: an in-flight run resolves its promise from
      // the next tick — cancelling it deadlocks the battery (learned at Gate 1).
      // stopRef makes that next tick resolve immediately; dispose after a beat.
      stopRef.current = true;
      setTimeout(() => { pipelineRef.current?.dispose(); pipelineRef.current = null; }, 200);
    };
  }, []);

  const probe = useCallback((pp) => {
    console.info('[gpu-spike] probing GL', pp);
    setEnv((prev) => ({ ...prev, [pp === 'high-performance' ? 'hi' : 'lo']: probeGL(pp) }));
  }, []);

  const ensureProbed = useCallback(() => {
    setEnv((prev) => ({
      ...prev,
      hi: prev?.hi ?? probeGL('high-performance'),
      lo: prev?.lo ?? probeGL('low-power'),
    }));
  }, []);

  const ensurePipeline = useCallback(() => {
    if (!pipelineRef.current && canvasRef.current) {
      pipelineRef.current = createBenchPipeline(canvasRef.current);
    }
    return pipelineRef.current;
  }, []);

  const loadFixture = useCallback(async (key) => {
    const v = videoRef.current;
    const fx = FIXTURES[key];
    if (v.dataset.fx !== key) {
      v.dataset.fx = key;
      // Direct cross-origin loopback src — the proven editor/Library pattern
      // (PreviewPlayer.jsx, VideoPlayerProvider.jsx). crossOrigin="anonymous"
      // (on the element) + the media server's ACAO:* keep texImage2D untainted
      // for the GL upload. The earlier fetch→blob workaround dodged the \\?\ 404
      // (since fixed server-side) yet still failed MediaError code=4; H.264
      // decodes fine in this WebView2, as the editor preview proves.
      const url = mediaHttpUrl(fx.rel, { library: true });
      if (!url) { v.dataset.fx = ''; throw new Error('media base URL not ready'); }
      v.src = url;
      await new Promise((res, rej) => {
        const t = setTimeout(() => { v.dataset.fx = ''; rej(new Error('canplay timeout')); }, 15000);
        v.addEventListener('canplay', () => { clearTimeout(t); res(); }, { once: true });
        v.addEventListener('error', () => { clearTimeout(t); v.dataset.fx = ''; rej(new Error('video error code=' + (v.error && v.error.code))); }, { once: true });
      });
    }
    v.currentTime = 0;
    // play() rejects with AbortError when the (struggling) 4K pipeline
    // interrupts itself — one settle-and-retry before declaring the cell dead.
    try { await v.play(); }
    catch { await new Promise((r) => setTimeout(r, 800)); await v.play(); }
    await new Promise((r) => setTimeout(r, 300));
    return fx;
  }, []);

  // ---- one measured run; rAF loop touches no React state (DOM ref only) ----
  const runOnce = useCallback(async (key, runMode, runCadence, seconds, cap = 'native', nLayers = 0) => {
    const fx = await loadFixture(key);
    const pl = ensurePipeline();
    if (!pl) throw new Error('WebGL2 context unavailable');
    // cap1080 = the editor's real preview workload: full-res source decode +
    // upload, pane-sized (≤1920-wide) render target + composite.
    const scale = cap === 'cap1080' ? Math.min(1, 1920 / fx.width) : 1;
    pl.setSize(Math.round(fx.width * scale), Math.round(fx.height * scale));
    const v = videoRef.current;
    if (nLayers > 0) {
      pl.beginComposite();
      for (let k = 0; k < nLayers; k++) pl.uploadLayer(k, v);
      for (let k = 0; k < nLayers; k++) pl.drawLayer(k, COMPOSITE_OPACITY);
    } else if (runMode !== 'baseline') { pl.upload(v); pl.draw(runMode === 'upload+LUT' ? 'lut' : 'pass'); }

    const fence = runMode === 'baseline' ? null : createFenceTracker(pl.gl);
    const rafDeltas = [], uploadMs = [], drawMs = [], fenceMs = [];
    let last = 0, lastVT = -1, earlyChecked = false, earlyFail = false;
    stopRef.current = false;

    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        if (last) rafDeltas.push(now - last);
        last = now;
        // Early-fail: a catastrophic cell (p95 > 3× budget at the 10 s mark)
        // ends now — 10 s of evidence is decision-grade and spares the UI
        // minutes of molasses (the first 4K battery made the app unusable).
        if (!earlyChecked && now - t0 >= 10000) {
          earlyChecked = true;
          if (summarize(rafDeltas, BUDGET_MS).p95 > 50) {
            earlyFail = true;
            fence?.dispose();
            resolve();
            return;
          }
        }
        if (nLayers > 0) {
          // N uploads (one texture/layer) then N alpha-blended LUT quad draws —
          // the renderComposite per-frame workload, upload vs draw timed apart.
          pl.beginComposite();
          const u0 = performance.now();
          for (let k = 0; k < nLayers; k++) pl.uploadLayer(k, v);
          uploadMs.push(performance.now() - u0);
          const d0 = performance.now();
          for (let k = 0; k < nLayers; k++) pl.drawLayer(k, COMPOSITE_OPACITY);
          drawMs.push(performance.now() - d0);
          fence.insert(performance.now());
        } else {
          if (runMode === 'upload' || runMode === 'upload+LUT') {
            if (runCadence === 'raf' || v.currentTime !== lastVT) {
              const u0 = performance.now();
              pl.upload(v);
              uploadMs.push(performance.now() - u0);
              lastVT = v.currentTime;
            }
          }
          if (runMode !== 'baseline') {
            const d0 = performance.now();
            pl.draw(runMode === 'upload+LUT' ? 'lut' : 'pass');
            drawMs.push(performance.now() - d0);
            fence.insert(performance.now());
          }
        }
        fence?.poll(performance.now(), fenceMs);
        const elapsed = (now - t0) / 1000;
        if (progressRef.current && (rafDeltas.length & 31) === 0) {
          progressRef.current.textContent =
            `running ${fx.label} · ${runMode} · ${elapsed.toFixed(0)}/${seconds}s`;
        }
        if (elapsed >= seconds || stopRef.current) { fence?.dispose(); resolve(); return; }
        rafIdRef.current = requestAnimationFrame(tick);
      };
      rafIdRef.current = requestAnimationFrame(tick);
    });

    const raf = summarize(rafDeltas, BUDGET_MS);
    const actualSec = Math.round((performance.now() - t0) / 1000);
    const row = {
      fixture: fx.label, mode: runMode, cadence: runCadence, layers: nLayers,
      tgt: cap === 'cap1080' ? '1080p' : 'native',
      durSec: actualSec, earlyFail,
      raf,
      upload: summarize(uploadMs),
      draw: summarize(drawMs),
      fence: summarize(fenceMs),
      aborted: stopRef.current && !earlyFail,
      verdict: nLayers > 0
        ? (stopRef.current ? '' : earlyFail ? 'FAIL'
          : seconds >= 30 ? (raf.p95 <= COMPOSITE_BUDGET_MS ? 'PASS' : 'FAIL') : '')
        : runMode === 'upload+LUT' && !stopRef.current
          ? (earlyFail ? 'FAIL'
            : seconds >= 30 ? (raf.p95 <= PASS_P95 && raf.overPct < PASS_OVER_PCT ? 'PASS' : 'FAIL') : '')
          : '',
    };
    console.info('[gpu-spike]', `${fx.label} ${runMode}/${runCadence}/${row.tgt} ${actualSec}s${earlyFail ? ' EARLY-FAIL' : ''} — rAF p50 ${fmt(raf.p50)} p95 ${fmt(raf.p95)} worst ${fmt(raf.worst)} over ${fmt(raf.overPct)}% n=${raf.n}${row.verdict ? ' → ' + row.verdict : ''}`);
    return row;
  }, [ensurePipeline, loadFixture]);

  const pushRow = useCallback((row) => {
    resultsRef.current = [...resultsRef.current, row];
    setRows(resultsRef.current);
  }, []);

  const handleRun = useCallback(async () => {
    if (running) return;
    ensureProbed();
    setRunning(true);
    try {
      pushRow(await runOnce(fxKey, mode, cadence, durSec, capMode));
      try { await invoke('vault_write_file', { path: RESULTS_VAULT_PATH, content: buildMarkdown() }); }
      catch (e) { setPersistNote('persist FAILED: ' + String(e)); }
    }
    catch (e) { pushRow({ fixture: fxKey, mode, error: String(e) }); }
    if (progressRef.current) progressRef.current.textContent = '';
    setRunning(false);
  }, [running, fxKey, mode, cadence, durSec, runOnce, pushRow]);

  // ---- WebCodecs ----
  const sampleFrame = useCallback((frame) => {
    const pl = ensurePipeline();
    if (!pl) return { error: 'no GL' };
    const out = {};
    const t0 = performance.now();
    const err = pl.uploadFrame(frame);
    out.direct = err === 0
      ? { ok: true, ms: +(performance.now() - t0).toFixed(2) }
      : { ok: false, glError: err };
    try {
      const clone = frame.clone();
      createImageBitmap(clone).then((bmp) => {
        const t1 = performance.now();
        const e2 = pl.uploadFrame(bmp);
        const r = { ok: e2 === 0, ms: +(performance.now() - t1).toFixed(2), glError: e2 || undefined };
        bmp.close?.();
        clone.close();
        wcBitmapRef.current = r;
      }).catch((e) => { clone.close(); wcBitmapRef.current = { ok: false, error: String(e) }; });
    } catch (e) {
      wcBitmapRef.current = { ok: false, error: String(e) };
    }
    return out;
  }, [ensurePipeline]);

  const runWebCodecs = useCallback(async () => {
    const support = [];
    for (const k of Object.keys(FIXTURES)) {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        support.push({ k, hw, ...(await webCodecsSupport(FIXTURES[k], hw)) });
      }
    }
    wcRef.current.support = support;
    setWcSupport(support);
    const out = [];
    for (const k of Object.keys(FIXTURES)) {
      const fx = FIXTURES[k];
      const url = mediaHttpUrl(fx.es, { library: true });
      for (const hw of ['prefer-hardware', 'no-preference']) {
        if (progressRef.current) progressRef.current.textContent = `WebCodecs ${fx.label} · ${hw}…`;
        const r = await webCodecsDecodeBench({
          url, fx, hardwareAcceleration: hw, maxAUs: 300,
          onFrameSample: hw === 'no-preference' ? sampleFrame : undefined,
        });
        const row = { k: fx.label, hw, ...r };
        out.push(row);
        console.info('[gpu-spike]', `webcodecs ${fx.label} ${hw} — ${r.ok ? `decodeFps ${fmt(r.decodeFps)} firstFrame ${fmt(r.firstFrameMs)}ms outputs ${r.outputs}/${r.fed}` : 'FAILED: ' + r.reason}`);
      }
    }
    await new Promise((r) => setTimeout(r, 400)); // let the bitmap path resolve
    wcRef.current.rows = out;
    setWcRows(out);
    try { await invoke('vault_write_file', { path: RESULTS_VAULT_PATH, content: buildMarkdown() }); }
    catch (e) { setPersistNote('persist FAILED: ' + String(e)); }
    if (progressRef.current) progressRef.current.textContent = '';
    return out;
  }, [sampleFrame]);

  // ---- markdown + persistence ----
  const buildMarkdown = useCallback(() => {
    const e = envRef.current || {};
    const lines = [];
    lines.push('## GPU & Codec Spike — display-half results');
    lines.push('');
    lines.push(`Captured ${new Date().toISOString()} · dev window`);
    lines.push('');
    lines.push('### Environment');
    lines.push('```');
    lines.push(`webgl2(high-performance): ${e.hi?.ok ? `${e.hi.vendor} · ${e.hi.renderer}` : 'UNAVAILABLE'}`);
    lines.push(`webgl2(low-power):        ${e.lo?.ok ? `${e.lo.vendor} · ${e.lo.renderer}` : 'UNAVAILABLE'}`);
    lines.push(`version: ${e.hi?.version || '—'} · glsl: ${e.hi?.glsl || '—'}`);
    lines.push(`maxTex: ${e.hi?.maxTex} · max3D: ${e.hi?.max3d} · EXT_disjoint_timer_query_webgl2: ${e.hi?.timerQuery}`);
    lines.push(`navigator.gpu (WebGPU): ${e.webgpu} · VideoDecoder (WebCodecs): ${e.videoDecoder} · dpr: ${e.dpr}`);
    lines.push(`ua: ${e.ua}`);
    lines.push('main.rs forces GDK_BACKEND=x11 + WEBKIT_DISABLE_DMABUF_RENDERER=1 + WEBKIT_DISABLE_COMPOSITING_MODE=1 (only-if-unset) — software-composited webview per Decision 2026-05-30.');
    lines.push('```');
    lines.push('');
    lines.push('### WebGL2 display bench');
    lines.push('');
    lines.push(`Budget: over-budget = rAF delta > ${BUDGET_MS} ms; verdict (upload+LUT, ≥30 s): p95 ≤ ${PASS_P95} ms AND over% < ${PASS_OVER_PCT}.`);
    lines.push('');
    lines.push('| fixture | mode | cadence | target | dur s | rAF p50 | rAF p95 | worst | over % | n | upload p50/p95 | draw p50/p95 | fence p50/p95 (est) | verdict |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of resultsRef.current) {
      if (r.error) { lines.push(`| ${r.fixture} | ${r.mode} | — | — | — | ERROR: ${r.error} ||||||||||`); continue; }
      lines.push(`| ${r.fixture} | ${r.mode} | ${r.cadence} | ${r.tgt || 'native'} | ${r.durSec}${r.earlyFail ? ' (early-fail)' : ''} | ${fmt(r.raf.p50)} | ${fmt(r.raf.p95)} | ${fmt(r.raf.worst)} | ${fmt(r.raf.overPct)} | ${r.raf.n} | ${fmt(r.upload.p50)}/${fmt(r.upload.p95)} | ${fmt(r.draw.p50)}/${fmt(r.draw.p95)} | ${fmt(r.fence.p50)}/${fmt(r.fence.p95)} | ${r.verdict || (r.aborted ? 'aborted' : '')} |`);
    }
    lines.push('');
    lines.push('### WebCodecs');
    lines.push('');
    for (const s of wcRef.current.support) {
      lines.push(`- isConfigSupported ${s.k} · ${s.hw}: ${s.available === false ? 'VideoDecoder absent' : String(s.supported)}`);
    }
    lines.push('');
    if (wcRef.current.rows.length) {
      lines.push('| fixture | hwAccel | outputs/fed | decode fps | first frame ms | texImage2D(VideoFrame) |');
      lines.push('|---|---|---|---|---|---|');
      for (const r of wcRef.current.rows) {
        lines.push(r.ok
          ? `| ${r.k} | ${r.hw} | ${r.outputs}/${r.fed} | ${fmt(r.decodeFps)} | ${fmt(r.firstFrameMs)} | ${r.sample ? (r.sample.direct?.ok ? `direct OK ${r.sample.direct.ms}ms` : `direct FAIL (${r.sample.direct?.glError ?? r.sample.error})`) : '—'} |`
          : `| ${r.k} | ${r.hw} | FAILED: ${r.reason} ||||`);
      }
      const bmp = wcBitmapRef.current;
      lines.push('');
      lines.push(`createImageBitmap(VideoFrame.clone()) → texImage2D: ${bmp ? (bmp.ok ? `OK ${bmp.ms}ms` : `FAIL ${bmp.error ?? bmp.glError}`) : 'not sampled'}`);
    }
    lines.push('');
    return lines.join('\n');
  }, [env]);

  const persistResults = useCallback(async (md) => {
    try {
      await invoke('vault_write_file', { path: RESULTS_VAULT_PATH, content: md });
      setPersistNote(`saved → ${RESULTS_VAULT_PATH}`);
    } catch (e) {
      setPersistNote('persist FAILED: ' + String(e));
    }
    try { await navigator.clipboard.writeText(md); } catch { /* best-effort */ }
  }, [buildMarkdown]);

  const handleCopy = useCallback(async () => {
    const md = buildMarkdown();
    try { await navigator.clipboard.writeText(md); setPersistNote('copied to clipboard'); }
    catch { setPersistNote('clipboard unavailable'); }
  }, [buildMarkdown]);

  // ---- the autonomous battery: every cell, then WebCodecs, then persist ----
  const handleBattery = useCallback(async () => {
    if (running) return;
    ensureProbed();
    setRunning(true);
    resultsRef.current = [];
    setRows([]);
    const cells = [];
    for (const k of Object.keys(FIXTURES)) {
      cells.push([k, 'baseline', 1], [k, 'draw-only', 1], [k, 'upload', 1], [k, 'upload+LUT', 2]);
    }
    try {
      for (const [k, m, reps] of cells) {
        for (let rep = 0; rep < reps; rep++) {
          if (stopRef.current && resultsRef.current.length) break;
          pushRow(await runOnce(k, m, 'raf', 30));
          // Persist after EVERY cell — a hang/restart must never lose data
          // again (first battery died with everything still in memory).
          try { await invoke('vault_write_file', { path: RESULTS_VAULT_PATH, content: buildMarkdown() }); } catch { /* final persist reports */ }
        }
      }
      await runWebCodecs();
      await persistResults(buildMarkdown() + '\n_battery complete_\n');
    } catch (e) {
      pushRow({ fixture: '—', mode: 'battery', error: String(e) });
      await persistResults(buildMarkdown() + '\n_battery aborted_\n');
    }
    if (progressRef.current) progressRef.current.textContent = 'battery complete';
    setRunning(false);
  }, [running, runOnce, runWebCodecs, persistResults, buildMarkdown, pushRow]);

  const handleStop = useCallback(() => { stopRef.current = true; }, []);

  // ---- compositor layer sweep (SF1) — its own results file + markdown ----
  const buildCompositeMarkdown = useCallback(() => {
    const e = envRef.current || {};
    const lines = [];
    lines.push('## Compositor layer sweep — SF1 (Video Editor · Compositing & Titles)');
    lines.push('');
    lines.push(`Captured ${new Date().toISOString()} · dev window`);
    lines.push('');
    lines.push(`GL: ${e.hi?.ok ? `${e.hi.vendor} · ${e.hi.renderer}` : 'not probed (run a bench cell first)'}`);
    lines.push('');
    lines.push('Workload/frame: N video uploads (texImage2D, one texture per layer) + N full-frame alpha-blended quad draws, every layer LUT-sampled, opacity 0.85. Single playing 1080p fixture — isolates the GPU compositor budget, apples-to-apples with the prior single-layer ~13 ms. Decoder contention (N simultaneous decodes) is SF5\'s gate, NOT measured here.');
    lines.push('');
    lines.push(`Gate: rAF p95 ≤ ${COMPOSITE_BUDGET_MS} ms (30 fps). 3-layer PASS → keep the 3-layer realtime preview; FAIL → 2-layer guarantee (degrade beyond). Export is unaffected.`);
    lines.push('');
    lines.push('| layers | rAF p50 | rAF p95 | worst | n | upload p50/p95 | draw p50/p95 | fence p50/p95 (est) | verdict |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of compResultsRef.current) {
      if (r.error) { lines.push(`| ${r.layers ?? '—'} | ERROR: ${r.error} ||||||||`); continue; }
      lines.push(`| ${r.layers} | ${fmt(r.raf.p50)} | ${fmt(r.raf.p95)} | ${fmt(r.raf.worst)} | ${r.raf.n} | ${fmt(r.upload.p50)}/${fmt(r.upload.p95)} | ${fmt(r.draw.p50)}/${fmt(r.draw.p95)} | ${fmt(r.fence.p50)}/${fmt(r.fence.p95)} | ${r.verdict || (r.aborted ? 'aborted' : '')} |`);
    }
    lines.push('');
    return lines.join('\n');
  }, []);

  const pushComp = useCallback((row) => {
    compResultsRef.current = [...compResultsRef.current, row];
    setCompRows(compResultsRef.current);
  }, []);

  const handleCompositeRun = useCallback(async () => {
    if (running) return;
    ensureProbed();
    setRunning(true);
    try {
      pushComp(await runOnce(fxKey, 'composite', 'raf', durSec, 'native', layers));
      try { await invoke('vault_write_file', { path: COMPOSITE_RESULTS_PATH, content: buildCompositeMarkdown() }); }
      catch (e) { setPersistNote('composite persist FAILED: ' + String(e)); }
    } catch (e) { pushComp({ layers, error: String(e) }); }
    if (progressRef.current) progressRef.current.textContent = '';
    setRunning(false);
  }, [running, fxKey, durSec, layers, runOnce, ensureProbed, pushComp, buildCompositeMarkdown]);

  const handleSweep = useCallback(async () => {
    if (running) return;
    ensureProbed();
    setRunning(true);
    compResultsRef.current = [];
    setCompRows([]);
    try {
      for (let n = 1; n <= MAX_LAYERS; n++) {
        if (stopRef.current && compResultsRef.current.length) break;
        pushComp(await runOnce(fxKey, 'composite', 'raf', 30, 'native', n));
        try { await invoke('vault_write_file', { path: COMPOSITE_RESULTS_PATH, content: buildCompositeMarkdown() }); } catch { /* final persist reports */ }
      }
      await invoke('vault_write_file', { path: COMPOSITE_RESULTS_PATH, content: buildCompositeMarkdown() + '\n_sweep complete_\n' });
    } catch (e) {
      pushComp({ layers: 0, error: String(e) });
      try { await invoke('vault_write_file', { path: COMPOSITE_RESULTS_PATH, content: buildCompositeMarkdown() + '\n_sweep aborted_\n' }); } catch { /* reported above */ }
    }
    if (progressRef.current) progressRef.current.textContent = 'sweep complete';
    setRunning(false);
  }, [running, fxKey, runOnce, ensureProbed, pushComp, buildCompositeMarkdown]);

  // ------------------------------------------------------------- render ----
  const e = env || {};
  const swWarn = e.hi?.ok && looksSoftware(e.hi.renderer);
  const fixturesOk = Object.keys(FIXTURES).every(
    (k) => fixStatus[`${k}.rel`] === 200 && fixStatus[`${k}.es`] === 200,
  );

  return (
    <div style={{ maxWidth: 680 }}>
      <SectionLabel>Environment</SectionLabel>
      <div style={{ ...mono, lineHeight: 1.7, color: 'var(--text-muted)' }}>
        <div>webgl2 hi-perf: {e.hi ? (e.hi.ok ? `${e.hi.vendor} · ${e.hi.renderer}` : 'UNAVAILABLE') : 'not probed'}</div>
        <div>webgl2 low-power: {e.lo ? (e.lo.ok ? `${e.lo.vendor} · ${e.lo.renderer}` : 'UNAVAILABLE') : 'not probed'}</div>
        {e.hi?.ok && <div>{e.hi.version} · GLSL {e.hi.glsl}</div>}
        {e.hi?.ok && <div>maxTex {e.hi.maxTex} · max3D {e.hi.max3d} · timerQuery {String(e.hi.timerQuery)}</div>}
        <div>WebGPU {String(e.webgpu)} · WebCodecs {String(e.videoDecoder)} · dpr {e.dpr}</div>
        {swWarn && <div style={{ color: '#e66', fontWeight: 700 }}>⚠ SOFTWARE RENDERER — plan A measures CPU rasterization on this box</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <OutlinedBtn small onClick={() => probe('high-performance')} disabled={running}>Probe GL hi-perf</OutlinedBtn>
          <OutlinedBtn small onClick={() => probe('low-power')} disabled={running}>Probe GL low-power</OutlinedBtn>
        </div>
      </div>

      <SectionLabel>Fixtures (Library vault · Studio/Spike Fixtures)</SectionLabel>
      <div style={{ ...mono, lineHeight: 1.7, color: 'var(--text-muted)' }}>
        {Object.keys(FIXTURES).map((k) => (
          <div key={k}>
            {FIXTURES[k].label}: mp4 <Chip ok={fixStatus[`${k}.rel`] === 200}>{String(fixStatus[`${k}.rel`] ?? '…')}</Chip>{' '}
            h264 <Chip ok={fixStatus[`${k}.es`] === 200}>{String(fixStatus[`${k}.es`] ?? '…')}</Chip>
          </div>
        ))}
        {!fixturesOk && <div style={{ marginTop: 6 }}>missing → run: <b>scripts/spike/make-fixtures.sh</b></div>}
      </div>

      <SectionLabel>WebGL2 display bench</SectionLabel>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
        <video ref={videoRef} crossOrigin="anonymous" muted loop playsInline preload="auto"
          style={{ width: 180, borderRadius: 6, background: '#000', flexShrink: 0 }} />
        <canvas ref={canvasRef} style={{ width: '100%', maxWidth: 460, borderRadius: 6, background: '#000' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        <Seg accent={accent} disabled={running} value={fxKey} onChange={setFxKey}
          options={Object.keys(FIXTURES).map((k) => ({ value: k, label: FIXTURES[k].label }))} />
        <Seg accent={accent} disabled={running} value={mode} onChange={setMode}
          options={MODES.map((m) => ({ value: m, label: m }))} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Seg accent={accent} disabled={running} value={cadence} onChange={setCadence}
            options={[{ value: 'raf', label: 'per-rAF' }, { value: 'frame', label: 'on-new-frame' }]} />
          <Seg accent={accent} disabled={running} value={durSec} onChange={setDurSec}
            options={[{ value: 10, label: '10 s' }, { value: 30, label: '30 s' }]} />
          <Seg accent={accent} disabled={running} value={capMode} onChange={setCapMode}
            options={[{ value: 'native', label: 'canvas native' }, { value: 'cap1080', label: 'canvas ≤1080p' }]} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <PrimaryBtn small accent={accent} onClick={handleRun} disabled={!ready || running}>Run</PrimaryBtn>
        <PrimaryBtn small accent={accent} onClick={handleBattery} disabled={!ready || running}>
          Full battery (~6 min)
        </PrimaryBtn>
        <OutlinedBtn small onClick={handleStop} disabled={!running}>Stop</OutlinedBtn>
        <OutlinedBtn small onClick={handleCopy} disabled={running || !rows.length}>Copy results</OutlinedBtn>
        <span ref={progressRef} style={{ ...mono, color: 'var(--text-faint)' }} />
      </div>
      {persistNote && <div style={{ ...mono, color: 'var(--text-faint)', marginTop: 6 }}>{persistNote}</div>}

      {rows.length > 0 && (
        <div style={{ ...mono, marginTop: 12, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ color: 'var(--text-faint)', textAlign: 'left' }}>
                {['fixture', 'mode', 'cad', 's', 'p50', 'p95', 'worst', 'over%', 'n', 'upl p95', 'draw p95', 'fence p95', ''].map((h) => (
                  <th key={h} style={{ padding: '2px 8px 2px 0', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => r.error ? (
                <tr key={i}><td colSpan={13} style={{ color: '#e66', padding: '2px 0' }}>{r.fixture} {r.mode}: {r.error}</td></tr>
              ) : (
                <tr key={i} style={{ color: 'var(--text-muted)' }}>
                  <td style={{ padding: '2px 8px 2px 0' }}>{r.fixture}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{r.mode}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{r.cadence}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{r.durSec}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.raf.p50)}</td>
                  <td style={{ padding: '2px 8px 2px 0', fontWeight: 700 }}>{fmt(r.raf.p95)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.raf.worst)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.raf.overPct)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{r.raf.n}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.upload.p95)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.draw.p95)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.fence.p95)}</td>
                  <td style={{ padding: '2px 0' }}>{r.verdict && <Chip ok={r.verdict === 'PASS'}>{r.verdict}</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionLabel>Compositor layer sweep — SF1</SectionLabel>
      <div style={{ ...mono, lineHeight: 1.6, color: 'var(--text-muted)', marginBottom: 10 }}>
        N video uploads + N alpha-blended LUT quad draws/frame from one 1080p fixture — isolates the GPU compositor budget.{' '}
        Gate: rAF p95 ≤ {COMPOSITE_BUDGET_MS} ms (30 fps) at 3 layers → keep 3-layer realtime preview; else 2-layer guarantee.{' '}
        Decoder contention is SF5's gate, not measured here. → <b>{COMPOSITE_RESULTS_PATH}</b>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <Seg accent={accent} disabled={running} value={layers} onChange={setLayers}
          options={Array.from({ length: MAX_LAYERS }, (_, i) => ({ value: i + 1, label: `${i + 1}L` }))} />
        <PrimaryBtn small accent={accent} onClick={handleCompositeRun} disabled={!ready || running}>
          Run composite ({layers}L · {durSec}s)
        </PrimaryBtn>
        <PrimaryBtn small accent={accent} onClick={handleSweep} disabled={!ready || running}>
          Run sweep 1→{MAX_LAYERS} (~2 min)
        </PrimaryBtn>
        <OutlinedBtn small onClick={handleStop} disabled={!running}>Stop</OutlinedBtn>
      </div>
      {compRows.length > 0 && (
        <div style={{ ...mono, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ color: 'var(--text-faint)', textAlign: 'left' }}>
                {['layers', 'p50', 'p95', 'worst', 'n', 'upl p95', 'draw p95', 'fence p95', ''].map((h) => (
                  <th key={h} style={{ padding: '2px 8px 2px 0', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compRows.map((r, i) => r.error ? (
                <tr key={i}><td colSpan={9} style={{ color: '#e66', padding: '2px 0' }}>{r.layers}L: {r.error}</td></tr>
              ) : (
                <tr key={i} style={{ color: 'var(--text-muted)' }}>
                  <td style={{ padding: '2px 8px 2px 0', fontWeight: 700 }}>{r.layers}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.raf.p50)}</td>
                  <td style={{ padding: '2px 8px 2px 0', fontWeight: 700 }}>{fmt(r.raf.p95)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.raf.worst)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{r.raf.n}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.upload.p95)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.draw.p95)}</td>
                  <td style={{ padding: '2px 8px 2px 0' }}>{fmt(r.fence.p95)}</td>
                  <td style={{ padding: '2px 0' }}>{r.verdict && <Chip ok={r.verdict === 'PASS'}>{r.verdict}</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionLabel>WebCodecs (decode microbench)</SectionLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <OutlinedBtn small onClick={runWebCodecs} disabled={!ready || running}>Run WebCodecs bench</OutlinedBtn>
      </div>
      {wcSupport.length > 0 && (
        <div style={{ ...mono, lineHeight: 1.7, color: 'var(--text-muted)', marginTop: 8 }}>
          {wcSupport.map((s, i) => (
            <div key={i}>isConfigSupported {s.k} · {s.hw}: <Chip ok={!!s.supported}>{s.available === false ? 'absent' : String(s.supported)}</Chip></div>
          ))}
          {wcRows.map((r, i) => (
            <div key={`r${i}`}>
              {r.k} · {r.hw}: {r.ok
                ? <>decode <b>{fmt(r.decodeFps)} fps</b> · first {fmt(r.firstFrameMs)} ms · {r.outputs}/{r.fed}
                    {r.sample && <> · direct tex: <Chip ok={!!r.sample.direct?.ok}>{r.sample.direct?.ok ? `${r.sample.direct.ms}ms` : 'FAIL'}</Chip></>}</>
                : <span style={{ color: '#e66' }}>FAILED: {r.reason}</span>}
            </div>
          ))}
          {wcBitmapRef.current && (
            <div>bitmap path: <Chip ok={!!wcBitmapRef.current.ok}>{wcBitmapRef.current.ok ? `${wcBitmapRef.current.ms}ms` : 'FAIL'}</Chip></div>
          )}
        </div>
      )}
    </div>
  );
}
