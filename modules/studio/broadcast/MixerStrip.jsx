// MixerStrip — Broadcast's audio mixer (SP6 SF2): one vertical channel strip
// per mixer row, in a collapsible rail that sits between the preview area and
// the composer bar.
//
// Rows come from the engine snapshot (`audio.sources`): the assigned global
// channels first, then the current scene's audio sources — OBS parity, so the
// middle of the strip swaps on a scene change while the globals stay put.
//
// METERS NEVER TOUCH REACT STATE. The engine pushes one batched `meters` frame
// at 30 Hz carrying every row; a rAF loop writes bar heights straight to the
// DOM (the MixSuite pattern). Routing that through setState would re-render the
// whole module 30x/sec. Subscription is scoped to the expanded strip: collapsed
// or unmounted means `subscribe_meters {on:false}` and zero pipe traffic.
//
// OCCLUSION LAW: this is a flex SIBLING of the preview area, never an overlay.
// Expanding it shrinks the preview, which re-syncs the native display bounds.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { LevelMeter, VFader, dbToFill } from '@host/components/ui';
import { verb } from './broadcastStore.js';

const MONITOR_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'monitor_only', label: 'Monitor' },
  { value: 'monitor_and_output', label: 'Both' },
];

const fmtDb = (db) => (!Number.isFinite(db) || db <= -60 ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

// Peak decays toward the live value instead of snapping, so a transient stays
// readable for a moment. 0.85 ≈ a ~200 ms tail at 30 Hz.
const PEAK_DECAY = 0.85;

function ChannelStrip({
  row, accent, soloed, anySolo, onDraft, onCommit, onMute, onSolo, onMonitor, registerMeter,
}) {
  // Draft while dragging so the fader tracks the finger; the engine snapshot
  // takes over again on release.
  const [draft, setDraft] = useState(null);
  const value = draft ?? row.deflection;
  const dimmed = anySolo && !soloed;
  const bars = Math.max(1, Math.min(row.channels || 2, 2));

  return (
    <div className="bcast-strip" style={{ opacity: dimmed ? 0.45 : 1 }}>
      <div className="bcast-strip-name" title={row.name}>
        {row.is_global ? <span className="bcast-strip-pin" title="Global — stays across scenes">•</span> : null}
        {row.name}
      </div>
      <div className="bcast-strip-body">
        <div className="bcast-strip-meters">
          {Array.from({ length: bars }, (_, ch) => (
            <LevelMeter
              key={ch}
              peakRef={registerMeter(row.name, ch, 'peak')}
              rmsRef={registerMeter(row.name, ch, 'rms')}
            />
          ))}
        </div>
        <VFader
          value={value}
          accent={accent}
          onDraft={(v) => { setDraft(v); onDraft(row.name, v); }}
          onCommit={(v) => { setDraft(null); onCommit(row.name, v); }}
        />
      </div>
      <div className="bcast-strip-db">{fmtDb(row.volume_db)}</div>
      <div className="bcast-strip-btns">
        <button
          type="button"
          className={`bcast-strip-btn${row.muted ? ' is-on' : ''}`}
          onClick={() => onMute(row.name, !row.muted)}
          title={row.muted ? 'Unmute' : 'Mute'}
        >
          M
        </button>
        <button
          type="button"
          className={`bcast-strip-btn${soloed ? ' is-solo' : ''}`}
          onClick={() => onSolo(row.name)}
          title="Solo — affects what you hear only, never the stream or recording"
        >
          S
        </button>
      </div>
      <CandySelect
        value={row.monitoring}
        options={MONITOR_OPTIONS}
        onChange={(v) => onMonitor(row.name, v)}
        title="Monitor routing"
      />
    </div>
  );
}

export default function MixerStrip({ api, snapshot, accent, expanded, onToggle }) {
  const rows = useMemo(() => snapshot?.audio?.sources ?? [], [snapshot]);
  const [solo, setSolo] = useState(() => new Set());

  // name -> { [`${ch}:peak`]: el, [`${ch}:rms`]: el }
  const elsRef = useRef(new Map());
  // Latest engine frame, replaced wholesale each tick; read by the rAF loop.
  const frameRef = useRef(null);
  // Decaying peak per bar, keyed the same way as elsRef.
  const peakHoldRef = useRef(new Map());
  // Monitoring values from before solo engaged, restored when solo clears.
  const priorMonitorRef = useRef(new Map());

  const registerMeter = useCallback((name, ch, kind) => (el) => {
    const m = elsRef.current;
    if (!m.has(name)) m.set(name, {});
    m.get(name)[`${ch}:${kind}`] = el;
  }, []);

  // Subscribe only while the strip is open — the whole point of the gate.
  useEffect(() => {
    if (!expanded) return undefined;
    let alive = true;
    verb(api, 'subscribe_meters', { on: true }).catch(() => {});
    const un = listen('broadcast-meters', (e) => {
      if (alive && e.payload?.sources) frameRef.current = e.payload.sources;
    });
    return () => {
      alive = false;
      frameRef.current = null;
      un.then((f) => f()).catch(() => {});
      verb(api, 'subscribe_meters', { on: false }).catch(() => {});
    };
  }, [expanded, api]);

  // Paint loop: DOM writes only, no React.
  useEffect(() => {
    if (!expanded) return undefined;
    let raf = 0;
    const paint = () => {
      const frame = frameRef.current;
      if (frame) {
        for (const [name, els] of elsRef.current) {
          const f = frame[name];
          for (const key of Object.keys(els)) {
            const el = els[key];
            if (!el) continue;
            const [chStr, kind] = key.split(':');
            const ch = Number(chStr);
            // A row with no frame this tick reads silent rather than freezing
            // at its last value — a dead source must LOOK dead.
            const live = f ? (kind === 'rms' ? f.mag?.[ch] : f.peak?.[ch]) : -Infinity;
            if (kind === 'rms') {
              el.style.height = `${dbToFill(live ?? -Infinity) * 100}%`;
            } else {
              const prev = peakHoldRef.current.get(`${name}|${key}`) ?? 0;
              const next = Math.max(dbToFill(live ?? -Infinity), prev * PEAK_DECAY);
              peakHoldRef.current.set(`${name}|${key}`, next);
              el.style.bottom = `${next * 100}%`;
            }
          }
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [expanded]);

  // Drop meter bookkeeping for rows that no longer exist (scene switch), so a
  // long session cannot accumulate entries for every source ever seen.
  useEffect(() => {
    const names = new Set(rows.map((r) => r.name));
    for (const key of [...elsRef.current.keys()]) {
      if (!names.has(key)) elsRef.current.delete(key);
    }
  }, [rows]);

  const call = useCallback((op, args) => verb(api, op, args).catch(() => {}), [api]);

  // Solo is SESSION state and monitor-only by construction: it rewrites
  // monitoring (what YOU hear) and never touches mute or track routing (what
  // the stream and recording carry). A forgotten solo cannot silence a
  // broadcast. ponytail: deliberately not persisted and not on the wire.
  const onSolo = useCallback((name) => {
    setSolo((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);

      const current = new Map(rows.map((r) => [r.name, r.monitoring]));
      if (next.size === 0) {
        for (const [n, prior] of priorMonitorRef.current) {
          if (current.get(n) !== undefined && current.get(n) !== prior) {
            verb(api, 'set_monitoring', { source: n, type: prior }).catch(() => {});
          }
        }
        priorMonitorRef.current.clear();
        return next;
      }
      if (prev.size === 0) priorMonitorRef.current = new Map(current);
      for (const r of rows) {
        const want = next.has(r.name)
          ? (priorMonitorRef.current.get(r.name) === 'none' ? 'monitor_only' : priorMonitorRef.current.get(r.name) ?? 'monitor_only')
          : 'none';
        if (r.monitoring !== want) {
          verb(api, 'set_monitoring', { source: r.name, type: want }).catch(() => {});
        }
      }
      return next;
    });
  }, [rows, api]);

  return (
    <div className={`bcast-mixer${expanded ? ' is-open' : ''}`}>
      <button type="button" className="bcast-mixer-tab" onClick={onToggle}>
        <span>Mixer</span>
        <span className="bcast-mixer-count">{rows.length}</span>
        <span className="bcast-mixer-caret">{expanded ? '▾' : '▴'}</span>
      </button>
      {expanded ? (
        <div className="bcast-mixer-rail">
          {rows.length === 0 ? (
            <div className="bcast-mixer-empty">No audio sources on this scene.</div>
          ) : (
            rows.map((row) => (
              <ChannelStrip
                key={row.name}
                row={row}
                accent={accent}
                soloed={solo.has(row.name)}
                anySolo={solo.size > 0}
                registerMeter={registerMeter}
                // Dragging previews locally; only the release hits the engine,
                // so a drag does not fire an op per pointer-move.
                onDraft={() => {}}
                onCommit={(name, v) => call('set_volume', { source: name, deflection: v })}
                onMute={(name, muted) => call('set_mute', { source: name, muted })}
                onSolo={onSolo}
                onMonitor={(name, type) => call('set_monitoring', { source: name, type })}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
