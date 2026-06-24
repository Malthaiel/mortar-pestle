// Import pipeline (Cuts NLE SF4): native picker → probe gate → sequential
// editor-lane remux, ONE in flight. Serialization alone doesn't protect
// multi-clip editing — the editor lane's no-LRU/no-kill design is the other
// half; both are required. The picker is the consent boundary: vedit_probe /
// vedit_remux_start deliberately skip the media-root gate Rust-side.

import { open } from '@tauri-apps/plugin-dialog';

// Import codec gate: pass only what WebKit can decode AND MP4 can carry.
// ≤1080p sources remux `-c:v copy`; >1080p sources re-encode into a 1080p
// short-GOP preview proxy (Color Grading SF2 — the WebGL display path is
// clamped ≤1080p), but the GATE is unchanged: re-encoding unsupported codecs
// (ProRes/DNxHD/…) stays a later phase (Delivery & Presets).
const PLAYABLE = new Set(['h264', 'hevc', 'vp9', 'av1']);

const newId = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function pickAndImport({ api, existingHashes, onProgress }) {
  const picked = await open({
    multiple: true,
    title: 'Import clips',
    filters: [{
      name: 'Video',
      extensions: ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'ts', 'm2ts', 'avi', 'mpg', 'mpeg', 'ogv'],
    }],
  });
  if (!picked) return { added: [], rejected: [] };
  const paths = Array.isArray(picked) ? picked : [picked];

  const added = [];
  const rejected = [];
  for (const path of paths) {
    const name = path.split(/[/\\]/).pop(); // Windows picker returns backslash paths
    try {
      onProgress?.({ name, state: 'probing' });
      const probe = await api.invoke('vedit_probe', { path });
      const v = probe.video?.[0];
      if (!v) {
        rejected.push({ path, name, reason: 'no video stream' });
        continue;
      }
      if (!PLAYABLE.has(v.codec)) {
        rejected.push({ path, name, reason: `codec "${v.codec}" can't be imported yet (proxy re-encode is a later phase)` });
        continue;
      }
      const needsProxy = (v.height || 0) > 1080 || (v.width || 0) > 1920;
      onProgress?.({ name, state: needsProxy ? 'building 1080p preview proxy for' : 'remuxing' });
      const r = await api.invoke('vedit_remux_start', { path, audioTrack: 0 });
      if (existingHashes?.has(r.hash)) {
        rejected.push({ path, name, reason: 'already in the bin' });
        continue;
      }
      added.push({
        entry: {
          id: newId(),
          src: path,
          proxyHash: r.hash,
          duration: probe.duration ?? null,
          fps: v.fps ?? null,
          width: v.width ?? null,
          height: v.height ?? null,
          codec: v.codec ?? null,
          hasAudio: (probe.audio?.length || 0) > 0,
          startTimeOffset: r.startTimeOffset || 0,
          // Source colorimetry tags (null when untagged) — the color phase
          // resolves these (color/colorimetry.js) to pin export matrices.
          colorSpace: v.color_space ?? null,
          colorPrimaries: v.color_primaries ?? null,
          colorTransfer: v.color_transfer ?? null,
          colorRange: v.color_range ?? null,
        },
        url: r.url,
        overBudget: !!r.overBudget,
      });
      onProgress?.({ name, state: 'done' });
    } catch (e) {
      rejected.push({ path, name, reason: e?.message || String(e) });
    }
  }
  return { added, rejected };
}
