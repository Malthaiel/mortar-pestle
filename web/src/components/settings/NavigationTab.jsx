// Navigation settings tab — four sections, picked from the Settings tree (SettingsNav): Dock (the
// dock band rows), Left Sidebar (group collapse, vault file tree, rearrange),
// Right Sidebar (Mini Rails), and General (navigation motion toggles).
// Extracted from SettingsDrawer.jsx; row internals unchanged.

import { Seg } from '../ui/index.js';
import EnableToggle from '../ui/EnableToggle.jsx';
import { SectionBand, StackedRow } from './section-primitives.jsx';
import { TAB_SECTIONS } from './settings-registry.js';
import { AnimationField } from './AnimationRows.jsx';
import DockTab from './DockTab.jsx';
import RailsTab from './RailsTab.jsx';

const TREE_REVEAL_OPTIONS = [
  { value: 'off',    label: 'Off'    },
  { value: 'fast',   label: 'Fast'   },
  { value: 'normal', label: 'Normal' },
  { value: 'slow',   label: 'Slow'   },
];

export default function NavigationTab({ settings, setSetting, accent, section }) {
  const active = section || TAB_SECTIONS.navigation.default;
  return (
    <div>
      {active === 'dock' && (
        <SectionBand title="Dock">
          <DockTab settings={settings} setSetting={setSetting} accent={accent}/>
        </SectionBand>
      )}
      {active === 'left' && <LeftSidebarPanel settings={settings} setSetting={setSetting} accent={accent}/>}
      {active === 'right' && (
        <SectionBand title="Mini Rails">
          <RailsTab accent={accent}/>
        </SectionBand>
      )}
      {active === 'general' && (
        <SectionBand title="Motion">
          <AnimationField
            keys={['flyout', 'section-accordion', 'page-transitions', 'pulse-indicators', 'drag-tile-follow']}
            settings={settings} setSetting={setSetting} accent={accent}
          />
        </SectionBand>
      )}
    </div>
  );
}

// ── Left sidebar ─────────────────────────────────────────────────────────────

function LeftSidebarPanel({ settings, setSetting, accent }) {
  return (
    <>
      <SectionBand title="Group collapse">
        <StackedRow label="Mode" anchor="set-sidebarGroupMode" hint="Controls how secondary-sidebar sections behave inside Knowledge / Pulse / Infrastructure.">
          <Seg
            value={settings.sidebarGroupMode || 'accordion'}
            options={[
              { value: 'expanded',    label: 'All Open' },
              { value: 'accordion',   label: 'One Open' },
              { value: 'independent', label: 'Manual' },
            ]}
            onChange={v => setSetting('sidebarGroupMode', v)}
            accent={accent}
          />
        </StackedRow>
      </SectionBand>
      <SectionBand title="File tree">
        <StackedRow label="Folder reveal" anchor="set-vaultTreeReveal" hint="How the vault file-tree folders expand and collapse — children cascade in one-by-one, and reverse on collapse. Off = instant; Fast / Normal / Slow set the cascade speed.">
          <Seg value={settings.vaultTreeReveal || 'normal'} options={TREE_REVEAL_OPTIONS} onChange={v => setSetting('vaultTreeReveal', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Show name suffixes" anchor="set-vaultTreeSuffix" hint='Append a trailing "/" after folder names and ".md" after note names in the vault file tree (e.g. KNOWLEDGE/ and a note shown as Title.md).'>
          <EnableToggle enabled={!!settings.vaultTreeSuffix} accent={accent} onChange={v => setSetting('vaultTreeSuffix', v)} title="Show name suffixes"/>
        </StackedRow>
      </SectionBand>
      <SectionBand title="Rearrange">
        <div style={{
          fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.55,
          padding: '4px 2px',
        }}>
          Long-press any sidebar pill for ~380ms — it lifts off the rail and follows your cursor. Release on a new slot to commit.
          <span style={{ display: 'block', marginTop: 6, color: 'var(--text-faint)', fontSize: 10.5 }}>
            Works on both the left rail (Knowledge, Infrastructure, Pulse, …) and the right rail (Planner, Music). Press Esc mid-drag to cancel.
          </span>
        </div>
      </SectionBand>
    </>
  );
}
