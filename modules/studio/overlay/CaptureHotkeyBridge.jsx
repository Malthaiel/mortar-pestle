import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useSettings } from '@host/hooks/useSettings.js';
import { KEYBINDS_DEFAULT } from '@host/keybinds/registry.js';
import { vkFromBindingKey } from './SttProvider.jsx';

// Pushes the user's overlay chord (Settings ▸ Keybinds ▸ Capture) down to the capture
// engine's system-wide keyboard hook. Renders nothing — it is the capture twin of the
// STT scrim-key effect in SttProvider: the engine holds the chord in MEMORY only, so
// this re-sends on every engine (re)start as well as on rebind, otherwise a supervisor
// restart silently reverts to the built-in Shift+C.
//
// Modifier mask matches winhook.rs: ctrl=1, alt=2, shift=4. 'meta' in the keybind
// registry is platform-primary (Ctrl on Windows), so it maps to the ctrl bit.
const MOD_CTRL = 1;
const MOD_ALT = 2;
const MOD_SHIFT = 4;
const OVERLAY_BIND_ID = 'capture.overlay';

export function modsFromBinding(binding) {
  const mods = binding?.modifiers || [];
  return (mods.includes('meta') || mods.includes('ctrl') ? MOD_CTRL : 0)
    | (mods.includes('alt') ? MOD_ALT : 0)
    | (mods.includes('shift') ? MOD_SHIFT : 0);
}

// A bare letter would be swallowed by the hook for as long as it is held, eating every
// C (or whatever) typed into a game or chat — so a plain key is only allowed when it is
// a function key. Anything else falls back to the shipped default.
function isFunctionKey(key) {
  return typeof key === 'string' && /^f([1-9]|1\d|2[0-4])$/i.test(key.trim());
}

export function resolveChord(binding) {
  const vk = vkFromBindingKey(binding?.key);
  const mods = modsFromBinding(binding);
  if (!vk || (!mods && !isFunctionKey(binding?.key))) return { vk: 0, mods: 0 };
  return { vk, mods };
}

export default function CaptureHotkeyBridge({ api }) {
  const { settings } = useSettings();
  const binding = settings?.keybinds?.[OVERLAY_BIND_ID] ?? KEYBINDS_DEFAULT[OVERLAY_BIND_ID];
  const resolved = resolveChord(binding);
  const fallback = resolveChord(KEYBINDS_DEFAULT[OVERLAY_BIND_ID]);
  const { vk, mods } = resolved.vk ? resolved : fallback;

  // Warn once per bad binding rather than silently ignoring the user's choice.
  useEffect(() => {
    if (resolved.vk) return;
    window.dispatchEvent(new CustomEvent('agentic:notify', {
      detail: {
        type: 'info',
        title: 'Overlay shortcut needs a modifier',
        message: 'Pick Shift, Ctrl or Alt plus a key (or a function key). Using the default for now.',
        accent: 'var(--accent)',
        iconKey: 'bell',
        duration: 4000,
        dismissOnClick: true,
      },
    }));
  }, [resolved.vk, binding?.key]);

  // Push on mount + on every engine (re)start. A failed push is fine — the engine is
  // down, and the next `capture-engine-status` running event re-sends.
  useEffect(() => {
    const push = () => api.invoke('capture_set_overlay_key', { vk, mods }).catch(() => {});
    push();
    const sub = listen('capture-engine-status', (e) => {
      if (e.payload?.state === 'running') push();
    });
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, [vk, mods, api]);

  return null;
}
