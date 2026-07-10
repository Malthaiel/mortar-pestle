// Tauri IPC primitive, extracted from api.js (plan 026 Half A). Lives in its own
// leaf module so media.js can import `invoke` without a cycle back through api.js
// (a cycle would TDZ-crash media.js's module-load prime against api.js's still-
// uninitialized `__tauriInvoke` const). api.js re-exports `invoke` so the 27
// modules importing it from `@host/api.js` are unaffected.

const __tauriInvoke = () =>
  typeof window !== 'undefined' && window.__TAURI_INTERNALS__
    ? window.__TAURI_INTERNALS__.invoke
    : null;

export async function invoke(cmd, args) {
  const fn = __tauriInvoke();
  if (!fn) throw new Error(`Tauri IPC not available (cmd: ${cmd}) — running outside Tauri shell?`);
  return fn(cmd, args);
}
