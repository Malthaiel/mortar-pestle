// Clip prep (editor-lane remux) as a Processes-panel row — Processes Panel
// Phase 3.
//
// `vedit_remux_start` is a blocking await with no Rust job cell and no global
// event, so it registers itself through the panel's lane-B bridge. The
// CustomEvent is dispatched INLINE rather than importing web/src's
// beginProcess/endProcess, so this module stays import-free for the editor's
// node selftests (the same reason analystBrain.js does it inline).
//
// ≤1080p sources are a stream copy and the row blinks past; the row earns its
// keep on a >1080p source, where ffmpeg re-encodes for minutes.

const emit = (detail) =>
  window.dispatchEvent(new CustomEvent('agentic:process', { detail }));

const baseName = (p) => String(p).split(/[\\/]/).pop() || p;

// Awaits the remux with a live panel row around it. Same return value as the
// bare invoke, same throw on failure — every call site is a drop-in swap.
export async function remuxWithProcess(api, { path, audioTrack = 0, statusLine = 'Preparing clip' }) {
  const id = `remux:${path}`;
  emit({
    op: 'begin', id, kind: 'render',
    title: 'Clip prep', subtitle: baseName(path),
    statusLine, startedMs: Date.now(), canCancel: true, progress: null,
  });
  // The pid can only be ASKED for: vedit_remux_start returns when the job is
  // already over, so the row would carry no pid — and no CPU/memory column —
  // for its whole life. One delayed poll is enough; ffmpeg is spawned before
  // the await begins, and a cache hit answers with nothing.
  let live = true;
  setTimeout(() => {
    if (!live) return;
    api.invoke('vedit_proxy_status')
      .then((pids) => { if (live && pids && pids.length) emit({ op: 'update', id, pids }); })
      .catch(() => {});
  }, 400);
  try {
    const r = await api.invoke('vedit_remux_start', { path, audioTrack });
    live = false;
    emit({ op: 'end', id, statusLine: 'Ready' });
    return r;
  } catch (e) {
    live = false;
    const msg = String(e?.message || e);
    emit({ op: 'end', id, statusLine: 'Stopped', error: msg });
    throw e;
  }
}
