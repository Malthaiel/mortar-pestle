import React, { useCallback, useEffect, useRef, useState } from 'react';
import Toast from '@host/components/ui/Toast.jsx';
import { PrimaryBtn, OutlinedBtn, DangerOutlinedBtn } from '@host/components/ui/Button.jsx';
import { mediaHttpUrl } from '@host/api.js';
import useCaptureState from './useCaptureState.js';
import { sendToEditor } from './sendToEditor.js';
import { sendToStt } from './sendToStt.js';
import { openInFiles } from '@host/components/vault-tree/revealInFiles.js';
import { IconFolder } from '@host/components/icons.jsx';

// Game Capture review surface (Step 4 frontend). Mirrors EditorPage's shell:
// a header bar (title + status readout + actions), a body row (left clip list
// aside + center preview main), and a fixed-position toast. Engine down → a
// calm idle/empty state, never an error throw (gate 5b: get_capture_state
// returns null when the engine is down — that is NOT a failure).

const paneLabel = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  padding: '10px 12px',
  userSelect: 'none',
};
const mono = { fontFamily: '"DM Mono", monospace' };

const fmtSize = (b) => {
  if (!b && b !== 0) return '';
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
};

// One readout line driven by the live snapshot + engine status. Down/failed
// engine reads DOWN (error color); otherwise the recording/idle state.
function statusReadout({ snapshot, engine, error }) {
  if (engine && (engine.state === 'down' || engine.state === 'failed')) {
    return { text: engine.message || 'capture engine down', isError: true };
  }
  if (error) return { text: error.message || error.code || 'capture error', isError: true };
  if (!snapshot) return { text: 'engine idle', isError: false };
  const s = snapshot.state;
  if (s === 'armed') return { text: snapshot.recording ? `armed + recording${snapshot.game ? ` — ${snapshot.game}` : ''}` : 'armed — replay ready', isError: false };
  if (s === 'recording') return { text: snapshot.game ? `recording — ${snapshot.game}` : 'recording', isError: false };
  if (s === 'error') return { text: snapshot.last_error?.message || 'error', isError: true };
  return { text: s || 'idle', isError: false };
}

// Cap on buffering a preview proxy fully into memory as a blob: URL (see the
// load effect's rationale). ~350 MB ≈ 5 min at 1080p; longer clips stream the
// HTTP URL directly instead (and may stall — "Send to editor" is the path there).
const PREVIEW_BLOB_CAP = 350 * 1024 * 1024;

export default function CapturePage({ api, accent }) {
  const { snapshot, error, engine, clips, reloadClips } = useCaptureState(api);
  const [selectedPath, setSelectedPath] = useState(null);
  const [busy, setBusy] = useState(false);            // start/stop in flight
  const [armBusy, setArmBusy] = useState(false);      // arm/disarm in flight
  const [saveBusy, setSaveBusy] = useState(false);    // save-replay in flight
  const [sendToast, setSendToast] = useState(null);   // { name } | { name, error }
  const [deleteToast, setDeleteToast] = useState(null); // { name, binId } | { name, restored } | { name, error }
  const [deleteBusy, setDeleteBusy] = useState(false); // clip delete in flight
  const [previewUrl, setPreviewUrl] = useState(null); // playable editor-proxy URL
  const [previewBusy, setPreviewBusy] = useState(false);

  // mediaHttpUrl returns null until the media-server port primes; re-render
  // once it does (a one-shot CustomEvent on window — see api.js).
  const [, forceTick] = useState(0);
  useEffect(() => {
    const onReady = () => forceTick((n) => n + 1);
    window.addEventListener('agentic:media-server-ready', onReady);
    return () => window.removeEventListener('agentic:media-server-ready', onReady);
  }, []);

  // Keep a valid selection: default to the newest clip, drop a stale one.
  useEffect(() => {
    if (clips.length === 0) { if (selectedPath) setSelectedPath(null); return; }
    if (!selectedPath || !clips.some((c) => c.path === selectedPath)) {
      setSelectedPath(clips[0].path);
    }
  }, [clips, selectedPath]);

  const recording = !!snapshot?.recording || snapshot?.state === 'recording';
  const armed = !!snapshot?.armed || snapshot?.state === 'armed';
  const engineDown = !!engine && (engine.state === 'down' || engine.state === 'failed');
  const status = statusReadout({ snapshot, engine, error });

  // Route the preview through the Video Editor's proxy lane (vedit_remux_start):
  // it re-encodes a >1080p capture (the monitor is 3440×1440) down to a 1080p
  // WebKit-playable proxy — the raw stream exceeds the <video>/WebGL display path
  // (clamped ≤1080p) and stalls a few seconds in. ≤1080p clips are a fast copy
  // remux. Mirrors EditorPage's playback; warms the "Send to editor" cache too.
  // Preview load — two problems shaped this:
  //  1. React StrictMode double-invokes effects in dev; the old top-of-run
  //     setPreviewUrl(null) tore the playing <video> down + remounted it (two
  //     WebKit pipelines per clip in GST_DEBUG). A ref keyed to the loading path
  //     collapses that (and any stray re-render) to ONE stable load.
  //  2. WebKitGTK's HTTP <video> path progressively buffers a no-Range 200, and
  //     its buffering-pause corks PipeWire ~20s in — the audio-master clock
  //     freezes (GST_DEBUG: both sinks hold their next buffer, clock stuck at
  //     ~20s; only a seek PAST the buffered edge nudges it). A 206 isn't an
  //     option (souphttpsrc reads the chunk length as EOF at 8 MB) and <video>
  //     rejects iskariel-asset://. So fetch the proxy into a complete in-memory
  //     blob: URL — WebKit plays a whole blob with no progressive path, no
  //     buffering-pause, no cork. Capped so a long clip can't OOM the webview;
  //     above the cap we stream the HTTP URL (may stall — "Send to editor").
  const loadedPathRef = useRef(undefined);
  const blobUrlRef = useRef(null);
  const mountedRef = useRef(true);
  const revokeBlob = () => {
    if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; revokeBlob(); };
  }, []);
  useEffect(() => {
    if (!selectedPath) {
      loadedPathRef.current = undefined;
      revokeBlob();
      setPreviewUrl(null); setPreviewBusy(false);
      return;
    }
    if (loadedPathRef.current === selectedPath) return; // already loading/loaded this clip
    loadedPathRef.current = selectedPath;
    setPreviewBusy(true); setPreviewUrl(null);
    (async () => {
      const current = () => mountedRef.current && loadedPathRef.current === selectedPath;
      const fallback = () => mediaHttpUrl(selectedPath, { library: true });
      try {
        const r = await api.invoke('vedit_remux_start', { path: selectedPath, audioTrack: 0 });
        const httpUrl = r?.url || fallback();
        let playUrl = httpUrl;
        try {
          const resp = await fetch(httpUrl);
          const len = Number(resp.headers.get('content-length') || 0);
          if (resp.ok && len > 0 && len <= PREVIEW_BLOB_CAP) {
            const blob = await resp.blob();
            if (!current()) return;
            revokeBlob();
            playUrl = URL.createObjectURL(blob);
            blobUrlRef.current = playUrl;
          }
        } catch { /* fetch failed → stream the HTTP URL directly */ }
        if (current()) setPreviewUrl(playUrl);
      } catch {
        // Proxy failed — fall back to the raw file so something shows.
        if (current()) setPreviewUrl(fallback());
      } finally {
        if (current()) setPreviewBusy(false);
      }
    })();
  }, [selectedPath, api]);

  const toggleRecord = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const snap = await api.invoke(recording ? 'capture_stop' : 'capture_start');
      // The echoed snapshot may be null on a decode miss — the live
      // capture-state event reconciles, so nothing else to do here.
      void snap;
    } catch {
      // Swallow: a down engine surfaces via capture-engine-status, not a throw
      // we want to crash the page on.
    } finally {
      setBusy(false);
    }
  }, [api, busy, recording]);

  const toggleArm = useCallback(async () => {
    if (armBusy) return;
    setArmBusy(true);
    try { await api.invoke(armed ? 'capture_disarm' : 'capture_arm'); }
    catch { /* engine-down surfaces via capture-engine-status, not a throw */ }
    finally { setArmBusy(false); }
  }, [api, armBusy, armed]);

  const saveReplay = useCallback(async (windowSecs) => {
    if (saveBusy) return;
    setSaveBusy(true);
    try { await api.invoke('capture_save_replay', windowSecs ? { windowSecs } : {}); }
    catch { /* not-armed / engine errors surface via the capture-state event */ }
    finally { setSaveBusy(false); }
  }, [api, saveBusy]);

  const handleSend = useCallback(async (clip) => {
    setSendToast({ name: clip.name });
    try {
      await sendToEditor({ api, path: clip.path });
      setSendToast({ name: clip.name, done: true });
    } catch (e) {
      setSendToast({ name: clip.name, error: e?.message || String(e) });
    }
  }, [api]);

  // Hand the clip to the STT module to transcribe its audio (Voice
  // Transcription Phase 3) — emits on the event bus + navigates to /tools/stt,
  // where the progress + transcript appear.
  const handleTranscribe = useCallback((clip) => {
    sendToStt({ api, path: clip.path });
  }, [api]);

  // Reveal the clip's .mp4 in the OS file explorer (selects the file). The
  // captures dir is allowlisted by is_under_allowed_root, so reveal_in_files
  // resolves it. Folder-icon button on each clip card.
  const handleReveal = useCallback((clip) => {
    openInFiles(clip.path, { isFolder: false });
  }, []);

  // Soft-delete a clip into the global Recycle Bin (3-SF3). The bin id powers the
  // undo Toast's Restore; reloadClips() drops it from the list (the selection
  // effect re-points the preview). Engine-down/errors surface in the toast.
  const handleDelete = useCallback(async (clip) => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      const res = await api.invoke('capture_clip_delete', { path: clip.path });
      reloadClips();
      setDeleteToast({ name: clip.name, binId: res?.binId || null });
    } catch (e) {
      setDeleteToast({ name: clip.name, error: e?.message || String(e) });
    } finally {
      setDeleteBusy(false);
    }
  }, [api, deleteBusy, reloadClips]);

  const handleRestore = useCallback(async (binId, name) => {
    try {
      await api.invoke('recycle_bin_restore', { id: binId });
      reloadClips();
      setDeleteToast({ name, restored: true });
    } catch (e) {
      setDeleteToast({ name, error: e?.message || String(e) });
    }
  }, [api, reloadClips]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* HEADER BAR */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '8px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Capture</div>
        <div style={{ flex: 1 }} />
        <div style={{ ...mono, fontSize: 11.5, color: status.isError ? 'var(--error)' : 'var(--text-faint)' }}>
          {status.text}
        </div>
        <div className="candy-center-row" style={{ gap: 8 }}>
          {recording ? (
            <DangerOutlinedBtn small onClick={toggleRecord} disabled={busy}>
              {busy ? 'Stopping…' : 'Stop'}
            </DangerOutlinedBtn>
          ) : (
            <PrimaryBtn small accent={accent} onClick={toggleRecord} disabled={busy || engineDown}>
              {busy ? 'Starting…' : 'Start'}
            </PrimaryBtn>
          )}
          {armed ? (
            <DangerOutlinedBtn small onClick={toggleArm} disabled={armBusy}>
              {armBusy ? 'Disarming…' : 'Disarm'}
            </DangerOutlinedBtn>
          ) : (
            <OutlinedBtn small onClick={toggleArm} disabled={armBusy || engineDown}>
              {armBusy ? 'Arming…' : 'Arm replay'}
            </OutlinedBtn>
          )}
          {armed && (
            <>
              <PrimaryBtn small accent={accent} onClick={() => saveReplay(null)} disabled={saveBusy}>
                {saveBusy ? 'Saving…' : 'Save replay'}
              </PrimaryBtn>
              <OutlinedBtn small onClick={() => saveReplay(30)} disabled={saveBusy}>
                Last 30s
              </OutlinedBtn>
            </>
          )}
          {snapshot?.hotkeys?.can_configure && (
            <OutlinedBtn small onClick={() => api.invoke('capture_rebind_hotkeys').catch(() => {})}>
              Rebind
            </OutlinedBtn>
          )}
          <OutlinedBtn small onClick={() => api.invoke('capture_open_kde_settings').catch(() => {})}>
            Settings
          </OutlinedBtn>
        </div>
      </div>

      {/* BODY ROW: left clip list + center preview */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <aside style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
            <div style={{ ...paneLabel, padding: 0, flex: 1 }}>Clips</div>
            <OutlinedBtn chip onClick={reloadClips}>Refresh</OutlinedBtn>
          </div>
          {clips.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '4px 12px' }}>
              {engineDown
                ? 'Capture engine is down. Recorded clips appear here once it is running.'
                : 'No clips yet. Start a recording to capture one.'}
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {clips.map((c) => {
                const selected = c.path === selectedPath;
                return (
                  <div
                    key={c.path}
                    onClick={() => setSelectedPath(c.path)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setSelectedPath(c.path); }}
                    style={{
                      border: `1px solid ${selected ? (accent || 'var(--accent)') : 'var(--border)'}`,
                      boxShadow: selected ? `0 0 0 1px ${accent || 'var(--accent)'}` : 'none',
                      borderRadius: 10,
                      overflow: 'hidden',
                      background: 'var(--surface)',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', position: 'relative' }}>
                      {c.poster && (
                        <img
                          src={mediaHttpUrl(c.poster, { library: true })}
                          alt=""
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      )}
                      <span style={{ ...mono, position: 'absolute', left: 6, bottom: 6, fontSize: 10.5, color: '#fff', background: 'rgba(0,0,0,0.55)', padding: '2px 6px', borderRadius: 6, maxWidth: '82%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.name || '(unnamed)'}
                      </span>
                    </div>
                    <div style={{ padding: '7px 9px' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.path}>
                        {c.name || c.path}
                      </div>
                      <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2, display: 'flex', gap: 8 }}>
                        {c.sizeBytes ? <span>{fmtSize(c.sizeBytes)}</span> : null}
                        {c.mtime ? <span>{new Date(c.mtime).toLocaleString()}</span> : null}
                      </div>
                      <div style={{ marginTop: 7, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <OutlinedBtn chip onClick={(e) => { e.stopPropagation(); handleSend(c); }}>
                          Send to editor
                        </OutlinedBtn>
                        <OutlinedBtn chip onClick={(e) => { e.stopPropagation(); handleTranscribe(c); }}>
                          Transcribe
                        </OutlinedBtn>
                        <OutlinedBtn chip title="Reveal in Explorer" onClick={(e) => { e.stopPropagation(); handleReveal(c); }}>
                          <span style={{ display: 'inline-flex' }}><IconFolder size={13} /></span>
                        </OutlinedBtn>
                        <DangerOutlinedBtn chip disabled={deleteBusy} onClick={(e) => { e.stopPropagation(); handleDelete(c); }}>
                          Delete
                        </DangerOutlinedBtn>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {previewUrl ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', padding: 12 }}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                key={previewUrl}
                src={previewUrl}
                crossOrigin="anonymous"
                playsInline
                preload="auto"
                controls
                style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
              />
            </div>
          ) : (
            <div style={paneLabel}>
              {previewBusy ? 'Preparing preview…' : selectedPath ? 'Preview not ready yet.' : 'Preview'}
            </div>
          )}
        </main>
      </div>

      {/* Fixed-corner toasts (stacked; mirrors EditorPage's toasts) */}
      {(deleteToast || sendToast) && (
        <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 1100, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
          {deleteToast && (
            <Toast
              accent={accent}
              glyph={deleteToast.error ? '!' : deleteToast.restored ? '✓' : '×'}
              title={deleteToast.error ? 'Delete failed' : deleteToast.restored ? 'Clip restored' : 'Clip deleted'}
              message={deleteToast.error ? undefined : deleteToast.name}
              error={deleteToast.error}
              actions={(deleteToast.binId && !deleteToast.restored && !deleteToast.error) ? (
                <>
                  <OutlinedBtn small onClick={() => handleRestore(deleteToast.binId, deleteToast.name)}>Undo</OutlinedBtn>
                  <OutlinedBtn small onClick={() => setDeleteToast(null)}>Dismiss</OutlinedBtn>
                </>
              ) : (
                <OutlinedBtn small onClick={() => setDeleteToast(null)}>Dismiss</OutlinedBtn>
              )}
            />
          )}
          {sendToast && (
            <Toast
              accent={accent}
              glyph={sendToast.error ? '!' : sendToast.done ? '✓' : '…'}
              title={sendToast.error ? 'Send failed' : sendToast.done ? 'Ready in the editor' : 'Sending…'}
              message={sendToast.error ? undefined : sendToast.name}
              error={sendToast.error}
              actions={sendToast.done ? (
                <OutlinedBtn small onClick={() => { setSendToast(null); api.router.navigate('/tools/video-editor'); }}>
                  Open editor
                </OutlinedBtn>
              ) : (sendToast.error ? (
                <OutlinedBtn small onClick={() => setSendToast(null)}>Dismiss</OutlinedBtn>
              ) : null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
