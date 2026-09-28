// Module settings page rendered inside the Modules tab at address
// {tab:'modules', page:<moduleId>}: the module's registered settings-tab render
// (or a host-provided page); an uninstalled module gets a notice, and a module
// with no settings yet gets a blank page until it gets a real one
// (user-directed 2026-09-28). No header — the Settings tree shows where you are (the
// back chip + "Modules › Name" breadcrumb went with Settings Tree Navigation,
// 2026-09-28). Pages receive additive {initialSection, onNavigateSection}
// props; a page's sections are rows in the Settings tree, so a page hides its
// own strip whenever onNavigateSection is passed (it keeps it standalone).

import { areaForModule } from '../../hooks/useModuleAreas.js';
import AreaReleasesView from '../../pages/docs/AreaReleasesView.jsx';

export default function ModulePage({
  manifest, pageEntry, enabled,
  settings, setSetting, accent,
  section, onSectionChange,
}) {
  const name = manifest?.name || pageEntry?.label || 'Module';
  const PageRender = pageEntry?.render || null;

  let body;
  if (section === 'releases') {
    // Release history is not module settings — show it regardless of install
    // state (Releases is on every module row's right-click, installed or not).
    body = <AreaReleasesView area={areaForModule(manifest)} accent={accent} />;
  } else if (!enabled) {
    body = (
      <EmptyBox>
        {name} is not installed. Right-click it in the Settings list to install it.
      </EmptyBox>
    );
  } else if (PageRender) {
    body = (
      <PageRender
        settings={settings}
        setSetting={setSetting}
        accent={accent}
        initialSection={section}
        onNavigateSection={onSectionChange}
      />
    );
  } else {
    body = null;
  }

  return body;
}

function EmptyBox({ children }) {
  return (
    <div style={{
      padding: '14px 16px',
      background: 'var(--surface-2)',
      border: '1px dashed var(--border)',
      borderRadius: 'var(--radius-md)',
      fontSize: 12, lineHeight: 1.5,
      color: 'var(--text-muted)',
    }}>{children}</div>
  );
}
