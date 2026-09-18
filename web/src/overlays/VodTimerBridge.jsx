import { useEffect } from 'react';
import { invoke } from '../api.js';
import { useSettings } from '../hooks/useSettings.js';
import { KEYBINDS_DEFAULT } from '../keybinds/registry.js';
import { toAccelerator } from '../keybinds/format.js';

// Pushes the two Personal-VOD recording binds (Settings ▸ Keybinds ▸ Coaching)
// down to Rust's global_shortcut plugin. Renders nothing.
//
// It is the third instance of the same pattern as CaptureHotkeyBridge and
// SttProvider's scrim-key effect, and for the same reason: the registration
// lives in PROCESS MEMORY only, so a re-push on mount is what survives an app
// restart. Mounted in the overlay host, which is created at boot and never
// destroyed, so this runs once per app launch plus once per Shift+C dev reload.
//
// These binds cannot be DOM chords: a keydown listener only ever sees the
// FOCUSED webview, and the entire point of the timer keys is that Deadlock has
// focus when they are pressed.
const IDS = [
  ['start', 'vod.timer-start'],
  ['end', 'vod.timer-end'],
];

export default function VodTimerBridge() {
  const { settings } = useSettings();
  const kb = settings?.keybinds;

  // Serialised so the effect re-runs on a rebind but not on every settings
  // write (accent, animation toggles, …) — this ends in an OS-level
  // unregister/register pair, which is not free.
  const accels = IDS
    .map(([action, id]) => `${action}:${toAccelerator(kb?.[id] ?? KEYBINDS_DEFAULT[id])}`)
    .join('|');

  useEffect(() => {
    const keys = accels.split('|').map((row) => {
      const i = row.indexOf(':');
      return { action: row.slice(0, i), accelerator: row.slice(i + 1) };
    });
    invoke('vod_set_timer_keys', { keys })
      .then((ok) => {
        // Rust returns only what Windows actually granted. A key another app
        // already owns is REFUSED, not stolen, and the failure is otherwise
        // completely silent — so name the missing ones rather than leaving him
        // pressing a dead key mid-match.
        const asked = keys.filter((k) => k.accelerator).map((k) => k.accelerator);
        const missing = asked.filter((a) => !(ok || []).includes(a));
        if (!missing.length) return;
        window.dispatchEvent(new CustomEvent('agentic:notify', {
          detail: {
            type: 'info',
            title: 'Match timer key already taken',
            message: `${missing.join(', ')} — another program owns it. Pick a different key in Settings ▸ Keybinds ▸ Coaching.`,
            accent: 'var(--accent)',
            iconKey: 'bell',
            duration: 6000,
            dismissOnClick: true,
          },
        }));
      })
      .catch(() => {});
  }, [accels]);

  return null;
}
