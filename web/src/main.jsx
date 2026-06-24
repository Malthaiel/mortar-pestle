import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { loadAll } from './module-loader.js';
import { initSmoothWheel } from './util/smoothWheel.js';
import './pages/docs/register.jsx';   // side effect: registerPageSidebar('docs', …)
import './styles.css';

loadAll().then(() => {
  initSmoothWheel();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
  // DEV-only vertical-centering verifier — tree-shaken from prod via the guard +
  // dynamic import. Audits candy buttons in centered rows and logs any miss.
  // See util/candyCenterAudit.js.
  if (import.meta.env.DEV) {
    import('./util/candyCenterAudit.js').then((m) => m.startCandyCenterAudit());
  }
});
