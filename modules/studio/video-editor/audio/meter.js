// Level + loudness readers (Audio Post SF4). Peak/RMS from an AnalyserNode's
// time-domain data; a momentary-ish LUFS from a K-weighted analyser (BS.1770
// approximation — the high-shelf + high-pass pre-filter is applied upstream in
// the graph, and the analyser window is ~340 ms). Main thread, display-rate.
// This is a PREVIEW meter — the export uses ffmpeg loudnorm/ebur128 for the
// real, certifiable number.

export function readLevel(analyser, buf) {
  if (!analyser || !buf) return { peak: 0, rms: 0 };
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i];
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sum += s * s;
  }
  return { peak, rms: Math.sqrt(sum / buf.length) };
}

// Momentary loudness of the (already K-weighted) signal: LUFS = -0.691 +
// 10·log10(mean-square). Mono-downmix approximation of BS.1770.
export function readLufs(analyser, buf) {
  if (!analyser || !buf) return -Infinity;
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const ms = sum / buf.length;
  if (ms <= 1e-12) return -Infinity;
  return -0.691 + 10 * Math.log10(ms);
}
