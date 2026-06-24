// Module settings page rendered inside the Modules tab at address
// {tab:'modules', page:<moduleId>}. Header = back chip + "Modules › Name"
// breadcrumb; body = the module's registered settings-tab render (or a
// host-provided page), with content empty states for settings-less and
// uninstalled modules. Pages receive additive {initialSection,
// onNavigateSection} props so a page with its own sub-tab strip stays
// controlled by the drawer address (deep links + search land exactly).

import { IconChevronLeft } from '../icons.jsx';
import { areaForModule } from '../../hooks/useModuleAreas.js';
import AreaReleasesView from '../../pages/docs/AreaReleasesView.jsx';

export default function ModulePage({
  manifest, pageEntry, enabled,
  settings, setSetting, accent,
  section, onSectionChange, onBack,
}) {
  const name = manifest?.name || pageEntry?.label || 'Module';
  const PageRender = pageEntry?.render || null;

  let body;
  if (section === 'releases') {
    // Release history is not module settings — show it regardless of install
    // state (the tag button is on every card, installed or not).
    body = <AreaReleasesView area={areaForModule(manifest)} accent={accent} />;
  } else if (!enabled) {
    body = (
      <EmptyBox>
        {name} is not installed. Install it from the Modules list to configure it.
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
    body = (
      <EmptyBox>
        {name} has no settings yet — its behavior is configured inside the module itself.
      </EmptyBox>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <button
          type="button"
          onClick={onBack}
          data-own-press
          title="Back to Modules"
          aria-label="Back to Modules"
          className="candy-btn"
          data-shape="row"
          style={{ '--accent': accent, width: 'auto', flexShrink: 0 }}
        >
          <span className="candy-face" style={{ justifyContent: 'center', padding: '6px 8px' }}>
            <IconChevronLeft/>
          </span>
        </button>
        <span style={{
          fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-faint)',
        }}>
          Modules <span style={{ opacity: 0.6 }}>›</span>{' '}
          <span style={{ color: 'var(--text-muted)' }}>{name}</span>
        </span>
      </div>
      {body}
    </div>
  );
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
