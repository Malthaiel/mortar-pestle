// Overlay settings page (Settings → Modules › Overlay). Three sections on the
// shared host Topbar: Capture (encoder/hotkeys/replay — CaptureSettingsTab), Voice
// (STT model/backend/VAD — SttSettingsTab), and Agents (over-game Concierge
// behavior). Controlled by the drawer address via {initialSection, onNavigateSection}
// (PAGE_SECTIONS.overlay); falls back to local state standalone. The module
// registers ONE settings tab rendering this — the drawer keeps only the FIRST
// registerSettingsTab per module (SettingsDrawer pagesByModuleId), so the surfaces
// are combined here rather than registered as siblings (which would be silently
// dropped).

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Topbar } from '@host/components/ui';
import { SectionBand, Row } from '@host/components/settings/section-primitives.jsx';
import EnableToggle from '@host/components/ui/EnableToggle.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import CaptureSettingsTab from './CaptureSettingsTab.jsx';
import SttSettingsTab from './SttSettingsTab.jsx';

const SECTIONS = [
  { id: 'capture', label: 'Capture' },
  { id: 'voice', label: 'Voice' },
  { id: 'agents', label: 'Agents' },
  { id: 'monitor', label: 'Monitor' },
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

// Monitor section — which monitor the in-game overlay (Shift+C) renders on. The
// choice lives in Rust (overlay_monitor.json in app-data; cross-webview so the
// overlay-host chip and this Settings row share one source of truth), NOT in the
// main webview's settings blob — so this row reads/writes it via the
// overlay_list_monitors / overlay_set_monitor commands instead of setSetting.
function MonitorSettingsSection() {
  const [monitors, setMonitors] = useState([]);
  const [selected, setSelected] = useState(undefined);
  useEffect(() => {
    invoke('overlay_list_monitors')
      .then((list) => {
        setMonitors(list || []);
        const cur = (list || []).find((m) => m.isSelected);
        setSelected(cur ? cur.name : undefined);
      })
      .catch(() => setMonitors([]));
  }, []);
  const options = monitors.map((m) => ({ value: m.name, label: `${m.label} — ${m.width}×${m.height}` }));
  return (
    <SectionBand title="Monitor" anchor="set-overlay-monitor">
      <Row label="Display the overlay on">
        <CandySelect
          value={selected}
          options={options}
          onChange={(name) => {
            setSelected(name);
            invoke('overlay_set_monitor', { name }).catch(() => {});
          }}
          title="Display the overlay on"
          placeholder="Automatic (current monitor)"
        />
      </Row>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5, paddingTop: 2 }}>
        Which monitor the in-game overlay renders on. Set here or from the monitor chip on
        the overlay itself; remembered across restarts. If the chosen monitor is
        disconnected, the overlay falls back to the primary.
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
      {section === 'monitor' && <MonitorSettingsSection />}
    </div>
  );
}
