// Planner module Settings tab. Registered via api.slots.registerSettingsTab
// and rendered by the host SettingsDrawer, which passes the host global
// settings bag (settings, setSetting, accent) plus the module-scoped settings
// via useModuleSettings.
//
// Two scopes:
//   - Module-scoped (settings.modules.planner.*): focus / break duration.
//     Persisted via api.settings.set under the module namespace.
//   - Host-scoped (settings.appAccent): Planner/timer accent color. Lives
//     at the top of focus_settings because the music dock also reads from
//     the same key. Edited from here because the Planner is its primary
//     consumer — the Vault tab no longer owns this picker.

import { useModuleSettings } from '@host/hooks/useSettings.js';
import { AccentGrid, HexInput } from '@host/components/ui/AccentPicker.jsx';
import { AnimationField } from '@host/components/settings/AnimationRows.jsx';

const inputStyle = {
  width: 64, padding: '4px 8px', fontSize: 12,
  background: 'var(--surface)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-mono)',
};

function SettingRow({ label, hint, children, stacked, anchor }) {
  if (stacked) {
    return (
      <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>{label}</div>
          {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0',
    }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

function SectionBand({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 8,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {children}
      </div>
    </div>
  );
}

export default function SettingsTab({ settings: hostSettings, setSetting: setHostSetting, accent }) {
  const { settings, setSetting } = useModuleSettings('planner');
  const focusMins = settings.focusMinutes ?? 30;
  const breakMins = settings.breakMinutes ?? 5;
  const appAccent = hostSettings?.appAccent || '';

  return (
    <div>
      <SectionBand title="Durations">
        <SettingRow anchor="set-planner-focusMinutes" label="Focus duration (minutes)">
          <input type="number" min="1" max="120" value={focusMins}
            onChange={e => setSetting('focusMinutes', Math.max(1, parseInt(e.target.value, 10) || 30))}
            style={inputStyle}/>
        </SettingRow>
        <SettingRow anchor="set-planner-breakMinutes" label="Break duration (minutes)">
          <input type="number" min="1" max="60" value={breakMins}
            onChange={e => setSetting('breakMinutes', Math.max(1, parseInt(e.target.value, 10) || 5))}
            style={inputStyle}/>
        </SettingRow>
      </SectionBand>

      <SectionBand title="Sessions">
        <SettingRow stacked anchor="set-planner-autoCaps" label="Auto caps"
          hint={'Smart title case for session names on create and rename — "take out the trash" becomes "Take Out the Trash".'}>
          <ToggleButton on={settings.autoCaps === true} accent={accent}
            onToggle={() => setSetting('autoCaps', settings.autoCaps !== true)}/>
        </SettingRow>
      </SectionBand>

      <SectionBand title="Accent">
        <SettingRow stacked anchor="set-planner-accent" label="Color" hint="Used by the controls, tab pills, and the music player dock. The dial itself is phase-colored (orange in focus, green in break).">
          <AccentGrid value={appAccent} onChange={c => setHostSetting?.('appAccent', c)}/>
        </SettingRow>
        <SettingRow label="Custom">
          <HexInput value={appAccent} onChange={c => setHostSetting?.('appAccent', c)} accent={accent}/>
        </SettingRow>
      </SectionBand>

      <SectionBand title="Motion">
        <AnimationField keys={['clock-ambient', 'planner-day-slide', 'counter-tick', 'task-celebration', 'copy-day-pop', 'frame-reset-restore']} settings={hostSettings} setSetting={setHostSetting} accent={accent}/>
      </SectionBand>
    </div>
  );
}

function ToggleButton({ on, accent, onToggle }) {
  const accentColor = accent || 'var(--text)';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      style={{
        width: 44, height: 24,
        borderRadius: 999,
        background: on ? accentColor : 'var(--border-2)',
        border: 'none',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 160ms ease',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute',
        top: 2, left: on ? 22 : 2,
        width: 20, height: 20,
        borderRadius: '50%',
        background: 'white',
        boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
        transition: 'left 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}/>
    </button>
  );
}
