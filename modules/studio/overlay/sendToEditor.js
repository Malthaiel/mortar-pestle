// "Send to editor" for a captured clip (Game Capture Step 4 frontend).
//
// The capture module can't push into the video-editor's in-memory project
// state across the route boundary, so the minimal faithful path mirrors
// importQueue.js for a SINGLE known absolute path: vedit_probe gates the clip
// (must have a WebKit-playable video stream) and vedit_remux_start warms the
// editor's remux cache so the clip is import-ready the moment the editor opens
// it. Returns the probe/remux result or throws with a human-readable reason.

const PLAYABLE = new Set(['h264', 'hevc', 'vp9', 'av1']);

export async function sendToEditor({ api, path }) {
  const probe = await api.invoke('vedit_probe', { path });
  const v = probe.video?.[0];
  if (!v) throw new Error('no video stream');
  if (!PLAYABLE.has(v.codec)) {
    throw new Error(`codec "${v.codec}" can't be imported yet`);
  }
  const r = await api.invoke('vedit_remux_start', { path, audioTrack: 0 });
  return { hash: r.hash, url: r.url, overBudget: !!r.overBudget };
}
