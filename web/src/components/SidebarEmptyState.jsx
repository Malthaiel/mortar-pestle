// Sidebar empty state — shown inside the SwapContainer when the active module
// has no renderSecondary, or when the sidebar is in shift-peek with no active
// module selected. A short identification card (module icon + name) plus a
// one-line hint, accent-tinted to the current page. No CTA — picking a
// different module happens in the dock.

import * as hostIcons from './icons.jsx';

export default function SidebarEmptyState({ activeModule, accent }) {
  const accentColor = accent || 'var(--text)';
  const Icon = activeModule?.iconKey && hostIcons[activeModule.iconKey]
    ? hostIcons[activeModule.iconKey]
    : null;
  const name = activeModule?.name || 'No module selected';
  const hint = activeModule
    ? 'No sidebar nav for this section.'
    : 'Pick a module from the dock to fill this space.';

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px 32px',
      gap: 10,
      textAlign: 'center',
      animation: 'fadeIn 0.2s ease',
    }}>
      {Icon && (
        <div style={{
          width: 40, height: 40,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in oklch, ${accentColor} 12%, transparent)`,
          color: accentColor,
          borderRadius: 'var(--radius-md)',
          border: `1px solid color-mix(in oklch, ${accentColor} 22%, transparent)`,
        }}>
          <Icon size={20}/>
        </div>
      )}
      <div style={{
        fontSize: 13, fontWeight: 600, color: 'var(--text)',
        letterSpacing: '-0.005em',
      }}>{name}</div>
      <div style={{
        fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)',
        maxWidth: 220,
      }}>{hint}</div>
    </div>
  );
}
