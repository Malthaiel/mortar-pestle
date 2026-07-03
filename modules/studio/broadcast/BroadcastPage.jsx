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
import { KEYBIND_ENTRIES } from './index.jsx';
import './broadcast.css';

// Module-local by host convention (video-editor keybinds.js carries the same).
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function BroadcastPage({ api, accent }) {
  const { snapshot, error, engine, alive } = useBroadcastState(api);
  const [busy, setBusy] = useState(false);
  const recording = alive && !!snapshot?.recording?.active;

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

  // Page-scoped keydown → record toggle (event-time resolution so a rebind in
  // Settings applies instantly; video-editor makeEditorKeydown idiom).
  const toggleRef = useRef(toggleRecord);
  toggleRef.current = toggleRecord;
  useEffect(() => {
    const def = KEYBIND_ENTRIES[0];
    const onKeydown = (e) => {
      if (isEditableTarget(e.target)) return;
      const kb = getLiveKeybinds();
      if (matchChord(e, kb[def.id] ?? def.default)) {
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, []);

  const failed = engine?.state === 'failed';
  const starting = engine?.state === 'spawning' || engine?.state === 'up' || engine?.state === 'adopting';

  return (
    <div className="bcast-page">
      <div className="bcast-preview-area">
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
          <EngineDisplay api={api} alive={alive} />
        )}
      </div>
      <ComposerBar
        alive={alive}
        recording={recording}
        elapsedNs={snapshot?.recording?.elapsed_ns || 0}
        busy={busy}
        onToggleRecord={toggleRecord}
        lastError={error || snapshot?.last_error || null}
        accent={accent}
      />
    </div>
  );
}
