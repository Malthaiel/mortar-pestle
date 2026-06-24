// audio/probe.js (Audio Post SF1b) — node-viability probe. SF1a proved
// createMediaElementSource + GainNode + AnalyserNode run in this WebKitGTK
// webview; this confirms the remaining nodes the mixer needs —
// StereoPannerNode, DynamicsCompressorNode, BiquadFilter — construct and
// render inside an OfflineAudioContext. One offline render of
// Oscillator → Biquad(peak) → Compressor → StereoPanner(+0.5) → out; asserts
// finite, non-silent output and equal-power channel asymmetry (right > left at
// pan +0.5). The acompressor-vs-DynamicsCompressor PARITY-gap measurement is
// owned by the SF8 golden-mix harness (it needs the ffmpeg render path).

export async function probeAudioNodes() {
  const OAC = typeof window !== 'undefined'
    ? (window.OfflineAudioContext || window.webkitOfflineAudioContext)
    : null;
  if (!OAC) return { ok: false, error: 'no OfflineAudioContext' };
  try {
    const sr = 48000;
    const ctx = new OAC(2, Math.round(sr * 0.1), sr);
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const biquad = ctx.createBiquadFilter();
    biquad.type = 'peaking';
    biquad.frequency.value = 1000;
    biquad.Q.value = 1;
    biquad.gain.value = 6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -30;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0.5;
    osc.connect(biquad);
    biquad.connect(comp);
    comp.connect(pan);
    pan.connect(ctx.destination);
    osc.start();
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    let peakL = 0;
    let peakR = 0;
    let nan = false;
    for (let i = 0; i < L.length; i++) {
      const a = Math.abs(L[i]);
      const b = Math.abs(R[i]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) nan = true;
      if (a > peakL) peakL = a;
      if (b > peakR) peakR = b;
    }
    // equal-power pan +0.5 → right channel louder than left.
    const ok = !nan && peakR > 0 && peakR > peakL;
    return {
      ok,
      offline: true,
      biquad: true,
      compressor: true,
      stereoPanner: true,
      nan,
      peakL: +peakL.toFixed(4),
      peakR: +peakR.toFixed(4),
      panRightLouder: peakR > peakL,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
