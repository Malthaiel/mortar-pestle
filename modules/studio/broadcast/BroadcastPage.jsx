// Broadcast page (SP2) — centered aspect-fit preview above the fixed composer
// bar; no placeholder panes (scene/source trees land in SP3).
//
// Status branches (neutral wording + colors per DESIGN — no red/green, accent
// on actions only): engine crash-loop → EmptyState + Restart CTA; engine
// down/starting → calm EmptyState (down auto-heals via the supervisor);
// alive → EngineDisplay. The composer bar always renders and self-disables.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@host/components/ui';
import { matchChord } from '@host/keybinds/match.js';
import { getLiveKeybinds } from '@host/keybinds/registry.js';
import useBroadcastState from './useBroadcastState.js';
import EngineDisplay from './EngineDisplay.jsx';
import ComposerBar from './ComposerBar.jsx';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import Inspector from './Inspector.jsx';
import MixerStrip from './MixerStrip.jsx';
import AudioPropsWindow from './AudioPropsWindow.jsx';
import PreviewInteract from './PreviewInteract.jsx';
import { KEYBIND_ENTRIES } from './index.jsx';
import { pushUndo, runRedo, runUndo } from './broadcastUndo.js';
import { updateBroadcastUi, useBroadcastUi, verb } from './broadcastStore.js';
import { toCanvas } from './canvasMath.js';
import { playCelebrationChime } from '@host/hooks/useTactileSound.js';
import { toast } from './mutations.js';
import './broadcast.css';

// Delight (b): OS file drop onto the preview → matching source at the drop
// point. Window-level Tauri event (occlusion-free — no DOM involved); the
// native child may dead-zone OLE drops over the region (spike; WM_DROPFILES
// forward on the host child is the documented fallback if it does).
const DROP_TYPES = {
  png: 'image_source', jpg: 'image_source', jpeg: 'image_source', gif: 'image_source',
  webp: 'image_source', bmp: 'image_source',
  mp4: 'ffmpeg_source', mkv: 'ffmpeg_source', mov: 'ffmpeg_source', webm: 'ffmpeg_source',
  mp3: 'ffmpeg_source', wav: 'ffmpeg_source', flac: 'ffmpeg_source', ogg: 'ffmpeg_source',
};

// Module-local by host convention (video-editor keybinds.js carries the same).
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function BroadcastPage({ api, accent }) {
  const { snapshot, error, engine, alive } = useBroadcastState(api);
  const ui = useBroadcastUi();
  const [busy, setBusy] = useState(false);
  // SP6 mixer rail. Collapsed by default: expanded is what turns the 30 Hz
  // meter stream on, so the quiet state is also the cheap one.
  const [mixerOpen, setMixerOpen] = useState(false);
  const [audioProps, setAudioProps] = useState(false);
  const recording = alive && !!snapshot?.recording?.active;
  const paused = recording && !!snapshot?.recording?.paused;
  const armed = alive && !!snapshot?.replay?.armed;

  // Manual-split gate: RecSplitFileType isn't in the snapshot, so read it from
  // the profile on the recording edge (a pre-record choice; a mid-session change
  // reflects on the next record start). Split shows only in Manual mode.
  const [splitType, setSplitType] = useState('Time');
  useEffect(() => {
    if (!recording) return undefined;
    verb(api, 'get_output_settings')
      .then((s) => setSplitType(s?.profile?.AdvOut?.RecSplitFileType || 'Time'))
      .catch(() => {});
    return undefined;
  }, [api, recording]);
  const canSplit = recording && splitType === 'Manual';

  const busyRef = useRef(false);
  const toggleRecord = useCallback(async () => {
    if (!alive || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.invoke(recording ? 'broadcast_stop_record' : 'broadcast_start_record');
    } catch {
      // Errors surface via broadcast-error / snapshot.last_error — no throw here.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [api, alive, recording]);

  // Record/replay verbs ride the broadcast_request passthrough — NOT undoable
  // (no pushUndo); failures surface as a toast (+ broadcast-error/last_error).
  const runVerb = useCallback((op, args) => {
    verb(api, op, args ?? null).catch((e) => toast('Broadcast', (e && e.message) || `${op} failed`));
  }, [api]);
  const onPause = useCallback(() => runVerb('pause_record', { paused: !paused }), [runVerb, paused]);
  const onSplit = useCallback(() => runVerb('split_record'), [runVerb]);
  const onReplayArm = useCallback(() => runVerb(armed ? 'stop_replay' : 'start_replay'), [runVerb, armed]);
  const onReplaySave = useCallback(() => runVerb('save_replay'), [runVerb]);

  // Go live (SP5 SF2). Both directions confirm — starting broadcasts to the
  // public, stopping cuts off everyone watching. The service name is fetched
  // at click time rather than polled: it changes only in Settings, and one
  // read on a deliberate click is cheaper than holding it in state.
  const streamStatus = (alive && snapshot?.stream?.status) || 'idle';
  const streamLive = streamStatus === 'live' || streamStatus === 'reconnecting';
  const streaming = streamLive || streamStatus === 'connecting';
  const [confirmStream, setConfirmStream] = useState(null); // { stopping, service } | null
  const onGoLive = useCallback(async () => {
    if (streaming) { setConfirmStream({ stopping: true }); return; }
    let svc = null;
    try {
      svc = await verb(api, 'get_stream_service');
    } catch {
      // Fall through — start_stream will surface the real error as a toast.
    }
    if (!svc) {
      toast('Not set up yet', 'Choose a streaming service in Settings ▸ Broadcast ▸ Stream first.');
      return;
    }
    const s = svc.settings || {};
    // A catalog service with no ingest picked would connect-fail 3 seconds in.
    // Say so up front instead (the picker leaves it empty on purpose — see
    // BroadcastSettingsTab's pickService).
    if (svc.type === 'rtmp_common' && !s.server) {
      toast('Pick a server', 'Choose an ingest server in Settings ▸ Broadcast ▸ Stream — the one closest to you.');
      return;
    }
    // Same courtesy for SRT/RIST, whose whole destination is the address.
    if (svc.type === 'url' && !s.url) {
      toast('No address', 'Enter an SRT or RIST address in Settings ▸ Broadcast ▸ Stream first.');
      return;
    }
    setConfirmStream({ stopping: false, service: s.service || s.server || s.base || 'your streaming service' });
  }, [api, streaming]);

  // Telemetry (SP5 SF3): the engine reports raw counters, we do the rate math.
  // A poll, not an event stream — no engine timer, no new event type. A failed
  // poll skips one beat instead of killing the interval; the interval exists
  // only while there is something to measure.
  const [streamStats, setStreamStats] = useState(null);
  useEffect(() => {
    if (!streamLive) { setStreamStats(null); return undefined; }
    let dead = false;
    let prev = null;
    const tick = () => {
      verb(api, 'get_stream_stats').then((s) => {
        if (dead || !s?.active) return;
        const at = Date.now();
        // bytes*8 / ms = kbit/s. Needs two samples, so the first read has none.
        const kbps = prev && at > prev.at
          ? Math.max(0, Math.round(((s.total_bytes - prev.bytes) * 8) / (at - prev.at)))
          : null;
        prev = { bytes: s.total_bytes, at };
        setStreamStats({ ...s, kbps });
      }).catch(() => {});
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { dead = true; clearInterval(t); };
  }, [api, streamLive]);

  // Page-scoped keydown → record/replay/pause/split (event-time chord resolution
  // so a Settings rebind applies instantly; video-editor makeEditorKeydown idiom).
  // Handlers ride a ref so the once-registered listener calls the latest closure;
  // pause/split are gated to their valid states (an out-of-state chord no-ops
  // instead of firing an engine error).
  const handlersRef = useRef({});
  handlersRef.current = {
    'broadcast.record-toggle': toggleRecord,
    'broadcast.replay-save': onReplaySave,
    'broadcast.pause': recording ? onPause : null,
    'broadcast.split': canSplit ? onSplit : null,
  };
  useEffect(() => {
    const onKeydown = (e) => {
      if (isEditableTarget(e.target)) return;
      const kb = getLiveKeybinds();
      for (const def of KEYBIND_ENTRIES) {
        if (!matchChord(e, kb[def.id] ?? def.default)) continue;
        const h = handlersRef.current[def.id];
        if (h) { e.preventDefault(); h(); }
        return;
      }
      // SP3 scene-graph undo/redo — page-scoped, hardcoded chords (video-editor
      // precedent; hotkey registry work stays SP10).
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) runRedo(api);
        else runUndo(api);
      }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [api]);

  // OS file drop → source at drop position (delight b).
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  useEffect(() => {
    const handleDrop = (paths, position) => {
      const snap = snapRef.current;
      const sceneName = snap?.current_scene;
      if (!sceneName) return;
      const el = document.querySelector('.bcast-preview-region');
      if (!el) return;
      const dpr = window.devicePixelRatio || 1;
      const cx = position.x / dpr;
      const cy = position.y / dpr;
      const rect = el.getBoundingClientRect();
      if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) return;
      const canvas = snap.canvas || { width: 1920, height: 1080 };
      const [px, py] = toCanvas(cx, cy, rect, canvas);
      for (const path of paths) {
        const ext = path.split('.').pop()?.toLowerCase();
        const typeId = DROP_TYPES[ext];
        if (!typeId) continue;
        const stem = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
        const settings = typeId === 'image_source'
          ? { file: path }
          : { local_file: path, is_local_file: true };
        verb(api, 'create_source', {
          scene: sceneName, id: typeId, name: stem, settings,
          transform: { pos_x: Math.round(px), pos_y: Math.round(py) },
        }).then((r) => {
          pushUndo({
            label: `Drop ${r.name}`,
            undo: [{ op: 'remove_item', args: { scene: sceneName, item: r.item } }],
            redo: [{ op: 'create_source', args: { scene: sceneName, id: typeId, name: r.name, settings, transform: { pos_x: Math.round(px), pos_y: Math.round(py) } }, remap: r.item }],
          });
          updateBroadcastUi({ selection: { scene: sceneName, itemId: r.item } });
          verb(api, 'select_item', { scene: sceneName, item: r.item }).catch(() => {});
        }).catch((e) => console.warn('[broadcast] drop create_source', e));
      }
    };
    // dead-flag: unlisten resolves async, so an unmount that beats it (StrictMode
    // remount, page nav) must unhook on arrival or the listener leaks → double drops.
    let dead = false;
    let un = null;
    let unHost = null;
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      handleDrop(event.payload.paths || [], event.payload.position);
    }).then((u) => { if (dead) u(); else un = u; });
    // OLE drops dead-zone over the native region (drop targets resolve by
    // hit-test, which never crosses to the WebView2 process) — the host child
    // carries its own IDropTarget and relays drops as this event, same
    // physical-px main-window coordinates as onDragDropEvent.
    listen('broadcast://host-drop', (e) => handleDrop(e.payload.paths || [], e.payload.position))
      .then((u) => { if (dead) u(); else unHost = u; });
    return () => { dead = true; if (un) un(); if (unHost) unHost(); };
  }, [api]);

  // Replay saved (SP4) — the money moment: chime + toast. App-focused only
  // until SP10 engine hotkeys; recordings land silently via capture-saved.
  useEffect(() => {
    let dead = false;
    let un = null;
    listen('broadcast-replay-saved', () => {
      playCelebrationChime();
      toast('Replay saved', 'The last few seconds are in your Captures.');
    }).then((u) => { if (dead) u(); else un = u; });
    return () => { dead = true; if (un) un(); };
  }, []);

  const failed = engine?.state === 'failed';
  const starting = engine?.state === 'spawning' || engine?.state === 'up' || engine?.state === 'adopting';

  return (
    <div className="bcast-page">
      {/* SP3: preview + in-layout inspector (flex siblings — no DOM overlay
          may cover the native region; the preview shrinks via bounds sync). */}
      <div className="bcast-main">
        <div
          className="bcast-preview-area"
          onPointerDown={(e) => {
            // Letterbox click = deselect. The region is an exact-fit aspect
            // box, so clicks outside every source but inside the canvas hit
            // PreviewInteract — clicks on the letterbox around it land HERE
            // and previously did nothing.
            if (e.target !== e.currentTarget) return;
            const sceneName = snapRef.current?.current_scene;
            if (!sceneName) return;
            updateBroadcastUi({ selection: null });
            verb(api, 'select_item', { scene: sceneName, item: null }).catch(() => {});
          }}
        >
          {failed ? (
            <EmptyState
              message="Broadcast engine crash-looped."
              ctaLabel="Restart engine"
              ctaOnClick={() => api.invoke('broadcast_restart_engine').catch(() => {})}
              accent={accent}
            />
          ) : !alive ? (
            <EmptyState message={starting ? 'Broadcast engine is starting…' : 'Broadcast engine is down.'} />
          ) : (
            /* The preview is a real child HWND, so it paints ON TOP of the
               whole webview — no web-drawn panel can ever cover it, and
               z-index is not in the conversation. Dropping `alive` tears the
               native window down (and rebuilds it on close), which is the only
               way to put an AppWindow in front of it. Deliberately NOT extended
               to the stream confirm modal: blanking the preview mid-stream to
               ask a question would be worse than the overlap.
               NB: plain block comment, not {(slash-star)} — this is a ternary
               arm, a JS expression position where a JSX comment parses as an
               object literal and is a syntax error. */
            <EngineDisplay api={api} alive={alive && !audioProps}>
              <PreviewInteract api={api} snapshot={snapshot} />
            </EngineDisplay>
          )}
        </div>
        {alive && ui.inspectorOpen && (
          <Inspector api={api} snapshot={snapshot} selection={ui.selection} accent={accent} />
        )}
      </div>
      {/* SP6: the mixer is a flex SIBLING of .bcast-main, so opening it shrinks
          the preview (which re-syncs the native bounds) instead of covering it. */}
      {alive && (
        <MixerStrip
          api={api}
          snapshot={snapshot}
          accent={accent}
          expanded={mixerOpen}
          onToggle={() => setMixerOpen((v) => !v)}
          onOpenProps={() => setAudioProps(true)}
        />
      )}
      {/* SF3: advanced audio lives in its own AppWindow — the strip stays a
          fast-access surface and does not grow a settings panel. */}
      {audioProps && (
        <AudioPropsWindow
          api={api}
          snapshot={snapshot}
          accent={accent}
          onClose={() => setAudioProps(false)}
        />
      )}
      <ComposerBar
        alive={alive}
        recording={recording}
        paused={paused}
        elapsedNs={snapshot?.recording?.elapsed_ns || 0}
        busy={busy}
        onToggleRecord={toggleRecord}
        armed={armed}
        canSplit={canSplit}
        onPause={onPause}
        onSplit={onSplit}
        onReplayArm={onReplayArm}
        onReplaySave={onReplaySave}
        streamStatus={streamStatus}
        streamElapsedNs={snapshot?.stream?.elapsed_ns || 0}
        streamError={snapshot?.stream?.error || null}
        streamStats={streamStats}
        onGoLive={onGoLive}
        confirmStream={confirmStream}
        onConfirmStream={() => {
          const stopping = confirmStream?.stopping;
          setConfirmStream(null);
          runVerb(stopping ? 'stop_stream' : 'start_stream');
        }}
        onCancelStream={() => setConfirmStream(null)}
        lastError={error || snapshot?.last_error || null}
        accent={accent}
      />
    </div>
  );
}
