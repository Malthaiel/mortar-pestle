// Overlay settings page (Settings → Modules › Overlay). Two sections on the
// shared host Topbar: Capture (encoder/hotkeys/replay — CaptureSettingsTab) and
// Voice (STT model/backend/VAD — SttSettingsTab). Controlled by the drawer
// address via {initialSection, onNavigateSection} (PAGE_SECTIONS.overlay); falls
// back to local state standalone. The module registers ONE settings tab rendering
// this — the drawer keeps only the FIRST registerSettingsTab per module
// (SettingsDrawer pagesByModuleId), so the two surfaces are combined here rather
// than registered as siblings (which would be silently dropped).

import { useState } from 'react';
import { Topbar } from '@host/components/ui';
import CaptureSettingsTab from './CaptureSettingsTab.jsx';
import SttSettingsTab from './SttSettingsTab.jsx';

const SECTIONS = [
  { id: 'capture', label: 'Capture' },
  { id: 'voice', label: 'Voice' },
];

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
    </div>
  );
}
