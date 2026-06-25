// Delivery & Presets (SF5) — export preset registry + capability helpers +
// user-saved-preset persistence. Pure data/logic (no React).
//
// A preset describes HOW to encode. `encode: null` (Source match) sends no
// `spec.encode`, so Rust takes the byte-identical Phase-1 path (libx264 crf18 /
// AAC 192k / mp4). Otherwise `encode` becomes `spec.encode` and Rust resolves
// the codec to a working encoder via the probe caps. `scale` (target height)
// downscales by overriding spec.width/height — the Rust filtergraph composites
// at those dims, so there's no encode width/height field.
//
// The unified 0–100 quality maps to each encoder's native control IN RUST
// (`quality_to_native`); JS only carries the 0–100 number, never a CRF/CQ — one
// source of truth, no drift.

export const BUILTIN_PRESETS = [
  { id: 'source-mp4', name: 'Source match · H.264 MP4', container: 'mp4', encode: null },
  { id: 'h264-1080-mp4', name: '1080p · H.264 MP4', container: 'mp4', scale: 1080,
    encode: { container: 'mp4', codec: 'h264', quality: 65 } },
  { id: 'h264-720-mp4', name: '720p · H.264 MP4', container: 'mp4', scale: 720,
    encode: { container: 'mp4', codec: 'h264', quality: 65 } },
  { id: 'hevc-mp4', name: 'HEVC · H.265 MP4', container: 'mp4',
    encode: { container: 'mp4', codec: 'hevc', quality: 65 } },
  { id: 'av1-mp4', name: 'AV1 · MP4', container: 'mp4',
    encode: { container: 'mp4', codec: 'av1', quality: 65 } },
  { id: 'vp9-webm', name: 'VP9 · WebM (H.264-free)', container: 'webm',
    encode: { container: 'webm', codec: 'vp9', quality: 65 } },
];

// The H.264-free fallback the remediation banner auto-selects (SF8).
export const FALLBACK_PRESET_ID = 'vp9-webm';

// Auto-fallback order per codec family — mirrors `encoder_chain` in Rust. Used
// for availability checks and the Custom encoder dropdown (NOT for resolution:
// Rust resolves authoritatively).
export const ENCODER_CHAINS = {
  h264: ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libopenh264'],
  hevc: ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
  vp9: ['libvpx-vp9'],
  av1: ['libsvtav1', 'av1_nvenc', 'av1_qsv', 'av1_amf'],
};

// Custom-UI codec list + which containers each is valid in.
export const CODECS = [
  { value: 'h264', label: 'H.264', containers: ['mp4'] },
  { value: 'hevc', label: 'H.265 (HEVC)', containers: ['mp4'] },
  { value: 'av1', label: 'AV1', containers: ['mp4', 'webm'] },
  { value: 'vp9', label: 'VP9', containers: ['webm'] },
];

export const CONTAINER_LABELS = { mp4: 'MP4', webm: 'WebM' };

// Friendly labels for explicit encoders in the Custom dropdown.
export const ENCODER_LABELS = {
  libx264: 'libx264 (software)', h264_nvenc: 'NVENC (NVIDIA)', h264_qsv: 'QSV (Intel)',
  h264_amf: 'AMF (AMD)', libopenh264: 'OpenH264 (software)',
  libx265: 'libx265 (software)', hevc_nvenc: 'NVENC (NVIDIA)', hevc_qsv: 'QSV (Intel)',
  hevc_amf: 'AMF (AMD)',
  'libvpx-vp9': 'libvpx (software)',
  libsvtav1: 'SVT-AV1 (software)', av1_nvenc: 'NVENC (NVIDIA)', av1_qsv: 'QSV (Intel)',
  av1_amf: 'AMF (AMD)',
};

// A codec family is usable when ≥1 encoder in its chain test-encoded OK.
export function codecAvailable(codec, caps) {
  return (ENCODER_CHAINS[codec] || []).some((e) => caps?.encoders?.[e]);
}

// Source match has no encode → it's the h264 family.
export function presetAvailable(preset, caps) {
  return codecAvailable(preset.encode?.codec || 'h264', caps);
}

// Available explicit encoders for a codec (for the Custom dropdown).
export function availableEncodersFor(codec, caps) {
  return (ENCODER_CHAINS[codec] || []).filter((e) => caps?.encoders?.[e]);
}

// Output dims for a preset's `scale` (target height), keeping the sequence
// aspect ratio with even dimensions. null scale → source dims.
export function presetDims(preset, seqW, seqH) {
  if (!preset.scale || !seqH) return { width: seqW, height: seqH };
  const h = preset.scale % 2 ? preset.scale + 1 : preset.scale;
  const w = Math.round((seqW / seqH) * h / 2) * 2;
  return { width: w, height: h };
}

// File extension for a preset's container.
export function presetExt(preset) {
  return preset.container === 'webm' ? 'webm' : 'mp4';
}

// ── User-saved presets (SF7) — module-scoped localStorage via api.settings ────

export function loadUserPresets(api) {
  const list = api?.settings?.get('userPresets', []);
  return Array.isArray(list) ? list : [];
}

export function saveUserPreset(api, preset) {
  const list = loadUserPresets(api).filter((p) => p.id !== preset.id);
  list.push(preset);
  api.settings.set('userPresets', list);
  return list;
}

export function deleteUserPreset(api, id) {
  const list = loadUserPresets(api).filter((p) => p.id !== id);
  api.settings.set('userPresets', list);
  return list;
}
