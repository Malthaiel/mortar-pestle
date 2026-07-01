import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { loadAll } from './module-loader.js';
import { initSmoothWheel } from './util/smoothWheel.js';
import './pages/docs/register.jsx';   // side effect: registerPageSidebar('docs', …)
import './fonts.css';
import './styles.css';

loadAll().then(() => {
  initSmoothWheel();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
  // DEV-only layout verifiers — tree-shaken from prod via the guard + dynamic
  // import. candyCenterAudit: optical centering of candy buttons vs text.
  // spacingAudit: vertical rhythm — row heights + shadow bands + gaps, no skips.
  if (import.meta.env.DEV) {
    import('./util/candyCenterAudit.js').then((m) => m.startCandyCenterAudit());
    import('./util/spacingAudit.js').then((m) => m.startSpacingAudit());
  }
});
