// Overlay settings page (Settings → Modules › Overlay). Three sections on the
// shared host Topbar: Capture (encoder/hotkeys/replay — CaptureSettingsTab), Voice
// (STT model/backend/VAD — SttSettingsTab), and Agents (over-game Concierge
// behavior). Controlled by the drawer address via {initialSection, onNavigateSection}
// (PAGE_SECTIONS.overlay); falls back to local state standalone. The module
// registers ONE settings tab rendering this — the drawer keeps only the FIRST
// registerSettingsTab per module (SettingsDrawer pagesByModuleId), so the surfaces
// are combined here rather than registered as siblings (which would be silently
// dropped).

import { useState } from 'react';
import { Topbar } from '@host/components/ui';
import { SectionBand, Row } from '@host/components/settings/section-primitives.jsx';
import EnableToggle from '@host/components/ui/EnableToggle.jsx';
import CaptureSettingsTab from './CaptureSettingsTab.jsx';
import SttSettingsTab from './SttSettingsTab.jsx';

const SECTIONS = [
  { id: 'capture', label: 'Capture' },
  { id: 'voice', label: 'Voice' },
  { id: 'agents', label: 'Agents' },
];

// Agents section — the over-game Concierge surface (mounted in the Overlay Host by
// OverlayHostView + AgentsOverlayLauncher). One toggle: whether the launcher reopens
// Concierge to its last open/closed state on each overlay show. Persists to
// settings.agents.overlayRemember (AGENTS_DEFAULT), read by the host launcher.
function AgentsOverlaySettingsTab({ settings, setSetting, accent }) {
  const remember = settings?.agents?.overlayRemember !== false;
  return (
    <SectionBand title="Over-game Concierge" anchor="set-overlay-agents">
      <Row label="Remember open state">
        <EnableToggle
          enabled={remember}
          accent={accent || 'var(--accent)'}
          onChange={(v) => setSetting('agents', { overlayRemember: !!v })}
          title="Remember open state"
        />
      </Row>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5, paddingTop: 2 }}>
        On reopens the Concierge chat to whatever open/closed state it was in the last
        time you showed the overlay (Shift+C). Off always starts it closed — summon it
        from the launcher chip in the overlay.
      </div>
    </SectionBand>
  );
}

export default function OverlaySettingsTab({ settings, setSetting, accent, initialSection, onNavigateSection }) {
  const [localSection, setLocalSection] = useState('capture');
  const section = initialSection || localSection;
  const select = (id) => { if (onNavigateSection) onNavigateSection(id); else setLocalSection(id); };

  return (
    <div>
      <Topbar
        tiles={SECTIONS.map(s => ({ id: s.id, label: s.label }))}
        activeId={section}
        accent={accent}
        onSelect={select}
        style={{ padding: '0 0 12px', background: 'transparent', marginBottom: 16 }}
      />
      {section === 'capture' && <CaptureSettingsTab settings={settings} setSetting={setSetting} accent={accent} />}
      {section === 'voice' && <SttSettingsTab settings={settings} setSetting={setSetting} accent={accent} />}
      {section === 'agents' && <AgentsOverlaySettingsTab settings={settings} setSetting={setSetting} accent={accent} />}
    </div>
  );
}
