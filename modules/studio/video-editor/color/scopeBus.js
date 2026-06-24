// scopeBus — single-consumer frame tap between the GL render loop and
// ScopeView (Color Grading SF9). Same module-singleton pattern as the grade
// draft slot: there is exactly one preview pipeline and at most one scope
// panel, so a shared slot beats threading a callback through five layers.
//
// The GL loop checks `sink` per draw and skips the FBO pass + readPixels
// entirely when no one listens — unmounting ScopeView (leaving Color mode)
// provably stops sampling.

export const scopeBus = { sink: null };

export function setScopeSink(fn) {
  scopeBus.sink = fn || null;
  if (import.meta.env.DEV) console.info('[vedit-scope]', fn ? 'tap on' : 'tap off');
}
