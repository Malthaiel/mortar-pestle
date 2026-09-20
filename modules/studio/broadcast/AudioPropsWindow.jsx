// AudioPropsWindow — Broadcast's advanced audio properties (SP6 SF3).
//
// One AppWindow, two sections:
//   1. Global monitoring output device (obs_get/set_audio_monitoring_device).
//   2. libobs's six global audio channels, each with an input-kind + device
//      picker, wiring obs_set_output_source(1..6). Before SF3 only channels 1
//      and 2 were reachable and they were hardcoded at boot.
//   3. Per-source advanced grid: numeric dB, mono downmix, balance, sync
//      offset, monitor routing, and the six-track mixer matrix.
//
// Everything here is a low-rate control surface — unlike the mixer strip it
// carries no meters, so ordinary React state is fine and there is no rAF loop.
//
// Slot assignment PERSISTS through the engine profile, so clearing a channel
// stays cleared across restarts (the engine's restore_global_slots).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppWindow, Slider } from '@host/components/ui';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { IconMic, IconSpeaker } from '@host/components/icons.jsx';
import EnableToggle from '@host/components/ui/EnableToggle.jsx';
import BalanceSlider, { CENTRE } from './BalanceSlider.jsx';
import { verb } from './broadcastStore.js';

const MONITOR_OPTIONS = [
  { value: 'none', label: 'Monitor off' },
  { value: 'monitor_only', label: 'Monitor only' },
  { value: 'monitor_and_output', label: 'Monitor and output' },
];

// libobs input types behind a global slot. Anything else is a source the user
// added to a scene and is edited from the source inspector, not here.
const SLOT_KINDS = [
  { value: '', label: 'Empty' },
  { value: 'wasapi_output_capture', label: 'Desktop audio' },
  { value: 'wasapi_input_capture', label: 'Microphone / Aux' },
];

// Which device list feeds a slot depends on its input type.
const kindOf = (inputId) => (inputId === 'wasapi_input_capture' ? 'input' : 'output');

const TRACKS = [1, 2, 3, 4, 5, 6];

function Row({ label, children, hint }) {
  return (
    <div className="bcast-audio-row">
      <div className="bcast-audio-row-label">
        {label}
        {hint ? <span className="bcast-audio-row-hint">{hint}</span> : null}
      </div>
      <div className="bcast-audio-row-control">{children}</div>
    </div>
  );
}

function GlobalSlotRow({ slot, devices, accent, onAssign }) {
  const inputId = slot.input_id || '';
  const list = devices[kindOf(inputId)] || [];
  const deviceOpts = useMemo(
    () => [{ value: '', label: 'Default device' }, ...list.map((d) => ({ value: d.id, label: d.name }))],
    [list],
  );

  return (
    <div className="bcast-slot-row">
      <div className="bcast-slot-ch">{slot.channel}</div>
      <CandySelect icon={IconMic}
        value={inputId}
        options={SLOT_KINDS}
        onChange={(v) => onAssign(slot.channel, v, '')}
        title={`Channel ${slot.channel} input type`}
      />
      <CandySelect icon={IconMic}
        value={slot.device_id || ''}
        options={deviceOpts}
        onChange={(v) => onAssign(slot.channel, inputId, v)}
        title={inputId ? `Channel ${slot.channel} device` : 'Pick an input type first'}
        disabled={!inputId}
      />
      <div className="bcast-slot-name">{slot.source || <span className="bcast-slot-empty">not assigned</span>}</div>
    </div>
  );
}

function SourceCard({ row, accent, call }) {
  const tracks = row.tracks ?? 0;

  return (
    <div className="bcast-audio-card">
      <div className="bcast-audio-card-head">
        {row.name}
        {row.is_global ? <span className="bcast-audio-card-tag">global</span> : null}
      </div>

      <Row label="Volume">
        <Slider
          value={Math.round((row.volume_db ?? 0) * 10) / 10}
          min={-60}
          max={26}
          step={0.1}
          unit=" dB"
          accent={accent}
          onChange={(db) => call('set_volume', { source: row.name, db })}
        />
      </Row>

      <Row label="Downmix to mono">
        <EnableToggle
          enabled={!!row.mono}
          accent={accent}
          onChange={(on) => call('set_mono', { source: row.name, mono: on })}
          title="Collapse this source to a single channel"
        />
      </Row>

      <Row label="Balance">
        <BalanceSlider
          value={row.balance ?? CENTRE}
          accent={accent}
          onChange={(v) => call('set_balance', { source: row.name, balance: v })}
        />
      </Row>

      <Row label="Sync offset" hint="milliseconds">
        <Slider
          value={row.sync_offset_ms ?? 0}
          min={-950}
          max={20000}
          step={5}
          unit=" ms"
          accent={accent}
          onChange={(ms) => call('set_sync_offset', { source: row.name, ms })}
        />
      </Row>

      <Row label="Monitoring">
        <CandySelect icon={IconSpeaker}
          value={row.monitoring || 'none'}
          options={MONITOR_OPTIONS}
          onChange={(v) => call('set_monitoring', { source: row.name, type: v })}
          title="Where this source is heard"
        />
      </Row>

      <Row label="Tracks" hint="which recording tracks carry this source">
        <div className="bcast-track-matrix">
          {TRACKS.map((t) => {
            const bit = 1 << (t - 1);
            const on = (tracks & bit) !== 0;
            return (
              <button
                key={t}
                type="button"
                className={`bcast-track-btn${on ? ' is-on' : ''}`}
                // Toggling the last remaining track would route the source
                // nowhere; libobs allows it, and it is a legitimate way to keep
                // a source audible in monitoring only, so it is not blocked.
                onClick={() => call('set_tracks', { source: row.name, mask: tracks ^ bit })}
                title={`Track ${t}`}
              >
                {t}
              </button>
            );
          })}
        </div>
      </Row>
    </div>
  );
}

export default function AudioPropsWindow({ api, snapshot, accent, onClose }) {
  const audio = snapshot?.audio;
  const rows = useMemo(() => audio?.sources ?? [], [audio]);
  const globals = useMemo(() => audio?.globals ?? [], [audio]);

  // { output: [...], input: [...], monitoring: [...] } — fetched once on open.
  // Device lists change only when hardware is plugged or unplugged, which is
  // rare enough that a Refresh button beats polling.
  const [devices, setDevices] = useState({});
  const [error, setError] = useState('');

  const loadDevices = useCallback(() => {
    let cancelled = false;
    Promise.all(
      ['output', 'input', 'monitoring'].map((kind) =>
        verb(api, 'list_audio_devices', { kind })
          .then((r) => [kind, r?.devices ?? []])
          .catch(() => [kind, []]),
      ),
    ).then((pairs) => {
      if (!cancelled) setDevices(Object.fromEntries(pairs));
    });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => loadDevices(), [loadDevices]);

  const call = useCallback(
    (op, args) => verb(api, op, args).then(() => setError('')).catch((e) => setError((e && e.message) || String(e))),
    [api],
  );

  // Each global slot carries its own device id so the picker can show what is
  // actually wired; the snapshot only names the source, so pair it with the
  // device the engine reported for that channel.
  const slotRows = useMemo(
    () => globals.map((g) => ({ ...g, device_id: g.device_id || '' })),
    [globals],
  );

  // libobs's enumerator never emits the default device, but obs_get_audio_
  // monitoring_device REPORTS the id as "default" — so the placeholder has to
  // carry that same id or the select matches no option and renders blank.
  const monitorOpts = useMemo(
    () => [
      { value: 'default', label: 'Default' },
      ...(devices.monitoring || []).map((d) => ({ value: d.id, label: d.name })),
    ],
    [devices.monitoring],
  );

  const monitoringValue = audio?.monitoring_device?.id || 'default';

  return (
    <AppWindow open title="Advanced audio properties" accent={accent} onClose={onClose} width={720}>
      <div className="bcast-audio-props">
        {error ? <div className="bcast-audio-error">{error}</div> : null}

        <section>
          <h4 className="bcast-audio-h">Monitoring output</h4>
          <Row label="Device" hint="where monitored audio is played back">
            <CandySelect icon={IconSpeaker}
              value={monitoringValue}
              options={monitorOpts}
              onChange={(id) => {
                const found = (devices.monitoring || []).find((d) => d.id === id);
                call('set_monitoring_device', { id, name: found?.name ?? 'Default' });
              }}
              title="Monitoring output device"
            />
          </Row>
        </section>

        <section>
          <h4 className="bcast-audio-h">
            Global channels
            <button type="button" className="bcast-audio-refresh" onClick={loadDevices} title="Re-scan audio devices">
              Refresh devices
            </button>
          </h4>
          <div className="bcast-audio-note">
            These six stay in the mixer no matter which scene is live. Clearing one keeps it clear after a restart.
          </div>
          <div className="bcast-slot-table">
            <div className="bcast-slot-head">
              <div>Ch</div><div>Input</div><div>Device</div><div>Source</div>
            </div>
            {slotRows.map((slot) => (
              <GlobalSlotRow
                key={slot.channel}
                slot={slot}
                devices={devices}
                accent={accent}
                onAssign={(channel, input_id, device_id) =>
                  call('set_global_slot', { channel, input_id, device_id })}
              />
            ))}
          </div>
        </section>

        <section>
          <h4 className="bcast-audio-h">Per-source</h4>
          {rows.length === 0 ? (
            <div className="bcast-audio-note">No audio sources on this scene.</div>
          ) : (
            rows.map((row) => <SourceCard key={row.name} row={row} accent={accent} call={call} />)
          )}
        </section>
      </div>
    </AppWindow>
  );
}
