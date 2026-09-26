import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { LazyErrorBoundary, FatalCard } from './components/LazyErrorBoundary.jsx';
import { loadAll } from './module-loader.js';
import { initSmoothWheel } from './util/smoothWheel.js';
import { installScrollMemory } from './util/scrollMemory.js';
import { installTooltips } from './util/tooltips.js';
import { installLiquidHover } from './util/liquidHover.js';
import './pages/docs/register.jsx';   // side effect: registerPageSidebar('docs', …)
import './fonts.css';
import './styles.css';

// DEV: a boot failure that beats the error boundary leaves a WHITE WINDOW and
// nothing on disk — no console to read from a terminal-driven session, no audit
// payload, because the bridge that writes them never started. Trap it at the
// window level and post it through the same sink every audit uses, so the real
// error string is readable instead of guessable.
if (import.meta.env.DEV) {
  const post = (kind, err) => {
    try {
      fetch('/__audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'boot',
          // The sink overwrites these top-level fields from every POST, so a
          // trap that omitted them would blank the page identity the other
          // audits depend on.
          nonce: 'boot-' + performance.now().toFixed(0),
          ts: Date.now(),
          label: location.hash.includes('overlay') ? 'overlay-host' : 'main',
          route: location.hash,
          data: { kind, ts: Date.now(), err: String((err && err.stack) || err).slice(0, 2000) },
        }),
      });
    } catch { /* the sink is dev-only and best-effort */ }
  };
  window.addEventListener('error', (e) => post('error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => post('rejection', e.reason));
}

loadAll().then(() => {
  initSmoothWheel();
  // Every scroll box in the app remembers where it was left. Delegated, so no
  // surface has to opt in — see util/scrollMemory.js.
  installScrollMemory();
  // Every title="…" shows the app tooltip, in every window — see util/tooltips.js.
  installTooltips();
  // Every candy button lights like liquid on hover, in every window — see util/liquidHover.js.
  installLiquidHover();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <LazyErrorBoundary full tag="[root]" label="Mortar & Pestle">
        <App />
      </LazyErrorBoundary>
    </StrictMode>
  );
  // DEV-only layout verifiers — tree-shaken from prod via the guard + dynamic
  // import. candyCenterAudit: optical centering of candy buttons vs text.
  // spacingAudit: vertical rhythm — row heights + shadow bands + gaps, no skips.
  // dragAudit: drives one synthetic reorder on a DraggableSidebarList and
  // measures the drop invariants (settle position, accent bridge, press-
  // release ease) numerically.
  // The player's controls layer is a bare see-through strip over the video, not
  // an app surface, so the LAYOUT verifiers below stay off there — they would
  // report on a control bar nobody asked about.
  //
  // The remote bridge is the exception and runs there too (see below): it writes
  // to its own `player-controls.json`, so it no longer fights the main window
  // for one result slot, which is the whole reason this window used to be shut
  // out entirely. Without it that window could only be driven by moving the
  // user's real mouse pointer — which is what Phase 5 had to do.
  const isPlayerControls = window.location.hash.startsWith('#/player/controls');
  if (import.meta.env.DEV && isPlayerControls) {
    import('./util/remote.js').then((m) => m.startRemote());
  }
  if (import.meta.env.DEV && !isPlayerControls) {
    import('./util/candyCenterAudit.js').then((m) => m.startCandyCenterAudit());
    import('./util/spacingAudit.js').then((m) => m.startSpacingAudit());
    import('./util/dragAudit.js').then((m) => m.startDragAudit());
    // cssVarAudit: unresolved no-fallback var(--x) in inline styles (CSS drops
    // the whole declaration silently — the DeadlockRail toolbar-padding class).
    import('./util/cssVarAudit.js').then((m) => m.startCssVarAudit());
    // rowAudit: the SIDE-BY-SIDE checker — heights, painted bottoms, gaps and
    // round-shape aspect WITHIN one visual row. The other two look past the
    // inside of a row, which is where every "these buttons don't match" fault
    // lives. Self-tests itself on startup (rowselftest in the payload).
    import('./util/rowAudit.js').then((m) => m.startRowAudit());
    // remote: runs an instruction written to web/.audit/cmd.txt and reports the
    // result back through the same bridge — lets a modal be OPENED and MEASURED
    // without the user driving the mouse. Without it the audits above only ever
    // see whatever surface happened to be on screen.
    import('./util/remote.js').then((m) => m.startRemote());
  }
}).catch((err) => {
  // module-loader throws on manifest validation / dep cycles / missing entries.
  // Without this the render above never runs and the window stays silently blank.
  console.error('[root] module load failed — app never rendered', err);
  createRoot(document.getElementById('root')).render(<FatalCard err={err} />);
});
