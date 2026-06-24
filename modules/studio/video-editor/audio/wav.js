// audio/wav.js (Audio Post SF8) — a tiny RIFF/WAVE reader for the parity
// battery. The Rust vedit_audio_parity command emits pcm_f32le WAVs; we parse
// them by hand into Float32 channel data rather than decodeAudioData, which on
// this WebKitGTK port is unproven for arbitrary byte buffers (the GPU & Codec
// Spike found its compressed-decode path unreliable). Uncompressed PCM is
// trivial and deterministic, so a hand reader is the robust choice. Handles the
// plain IEEE-float (fmt=3) and int16 (fmt=1) tags plus the EXTENSIBLE wrapper
// (fmt=0xFFFE) ffmpeg sometimes writes, where the true format is the first u16
// of the SubFormat GUID.

function fourcc(dv, off) {
  return (
    String.fromCharCode(dv.getUint8(off)) +
    String.fromCharCode(dv.getUint8(off + 1)) +
    String.fromCharCode(dv.getUint8(off + 2)) +
    String.fromCharCode(dv.getUint8(off + 3))
  );
}

// arrayBuffer → { sampleRate, channels, frames, channelData: [Float32Array,…] }
export function parseWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (fourcc(dv, 0) !== 'RIFF' || fourcc(dv, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE buffer');
  }
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = fourcc(dv, off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let audioFormat = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bitsPerSample = dv.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the SubFormat GUID's first u16.
      if (audioFormat === 0xfffe && size >= 26) audioFormat = dv.getUint16(body + 24, true);
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = size;
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt/data chunk');

  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample >> 3;
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
  const isFloat = audioFormat === 3 && bitsPerSample === 32;
  const isI16 = audioFormat === 1 && bitsPerSample === 16;
  if (!isFloat && !isI16) {
    throw new Error(`unsupported WAV format ${audioFormat}/${bitsPerSample}-bit`);
  }
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytesPerSample;
      channelData[c][i] = isFloat ? dv.getFloat32(p, true) : dv.getInt16(p, true) / 32768;
    }
  }
  return { sampleRate, channels, frames, channelData };
}

// Build an AudioBuffer in `ctx` from a parsed WAV (sample rates must match —
// the battery renders and contexts both at 48000).
export function wavToAudioBuffer(ctx, wav) {
  const buf = ctx.createBuffer(wav.channels, wav.frames, wav.sampleRate);
  for (let c = 0; c < wav.channels; c++) buf.copyToChannel(wav.channelData[c], c);
  return buf;
}
