import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { LazyErrorBoundary, FatalCard } from './components/LazyErrorBoundary.jsx';
import { loadAll } from './module-loader.js';
import { initSmoothWheel } from './util/smoothWheel.js';
import { installScrollMemory } from './util/scrollMemory.js';
import './pages/docs/register.jsx';   // side effect: registerPageSidebar('docs', …)
import './fonts.css';
import './styles.css';

loadAll().then(() => {
  initSmoothWheel();
  // Every scroll box in the app remembers where it was left. Delegated, so no
  // surface has to opt in — see util/scrollMemory.js.
  installScrollMemory();
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
  if (import.meta.env.DEV) {
    import('./util/candyCenterAudit.js').then((m) => m.startCandyCenterAudit());
    import('./util/spacingAudit.js').then((m) => m.startSpacingAudit());
    import('./util/dragAudit.js').then((m) => m.startDragAudit());
    // cssVarAudit: unresolved no-fallback var(--x) in inline styles (CSS drops
    // the whole declaration silently — the GameWikiRail toolbar-padding class).
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
